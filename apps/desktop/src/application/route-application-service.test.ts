import { describe, expect, it, vi } from 'vitest';
import type { GatewayStatus, RouteSettings } from '@codex-key-switcher/shared';
import { RouteApplicationService, type RouteApplicationPorts } from './route-application-service';

const base: RouteSettings = {
  mode: 'local_gateway', enabled: true, autoStart: true, disabledExplicitly: false,
  listenAddress: '127.0.0.1', listenPort: 3456, allowLANListen: false,
  failoverEnabled: false, failoverMaxAttempts: 3, failoverTotalTimeoutMs: 180_000,
  failoverFailureThreshold: 3, failoverCooldownMs: 60_000, failoverHalfOpenMaxRequests: 1,
};

function fixture() {
  let saved = { ...base };
  let status: GatewayStatus = { running: true, endpoint: 'http://127.0.0.1:3456/v1', mode: 'local_gateway' };
  const ports: RouteApplicationPorts = {
    settings: vi.fn(async () => saved),
    normalize: vi.fn((input: RouteSettings) => input),
    confirmSwitch: vi.fn(async () => true),
    persist: vi.fn(async (next: RouteSettings) => { saved = next; }),
    status: () => status,
    setStatus: (next) => { status = next; },
    connectionStatus: vi.fn(async (next: RouteSettings) => ({ ...status, mode: next.mode })),
    updateTray: vi.fn(),
    stopConnection: vi.fn(async () => undefined),
    clearDirectTarget: vi.fn(async () => undefined),
    assertDirectProvider: vi.fn(async () => undefined),
    syncDirect: vi.fn(async () => undefined),
    startLocal: vi.fn(async (next: RouteSettings) => ({ running: true, endpoint: `http://127.0.0.1:${next.listenPort}/v1`, mode: next.mode })),
    syncLocal: vi.fn(async () => undefined),
    runtimeStatus: vi.fn(async () => status),
    stopRuntime: vi.fn(async () => undefined),
    restoreBackup: vi.fn(async () => undefined),
    reportRollbackFailure: vi.fn(),
  };
  return { service: new RouteApplicationService(ports), ports, saved: () => saved, status: () => status };
}

describe('RouteApplicationService', () => {
  it('persists non-runtime changes without restarting the gateway', async () => {
    const { service, ports } = fixture();
    await expect(service.save({ ...base, autoStart: false })).resolves.toMatchObject({ changed: true, cancelled: false });
    expect(ports.startLocal).not.toHaveBeenCalled();
    expect(ports.syncLocal).not.toHaveBeenCalled();
    expect(ports.persist).toHaveBeenCalledOnce();
  });

  it('rolls back settings and listener when Codex sync fails after port change', async () => {
    const { service, ports, saved, status } = fixture();
    vi.mocked(ports.syncLocal).mockRejectedValueOnce(new Error('config write failed'));
    await expect(service.save({ ...base, listenPort: 4567 })).rejects.toThrow('config write failed');
    expect(saved()).toEqual(base);
    expect(status().endpoint).toBe('http://127.0.0.1:3456/v1');
    expect(ports.startLocal).toHaveBeenCalledTimes(2);
    expect(ports.syncLocal).toHaveBeenCalledTimes(2);
    expect(ports.stopRuntime).toHaveBeenCalledOnce();
  });

  it('does not persist or stop the gateway when a mode change is cancelled', async () => {
    const { service, ports } = fixture();
    vi.mocked(ports.confirmSwitch).mockResolvedValue(false);
    await expect(service.save({ ...base, mode: 'direct_provider' })).resolves.toEqual({
      settings: base, changed: false, cancelled: true,
    });
    expect(ports.persist).not.toHaveBeenCalled();
    expect(ports.stopConnection).not.toHaveBeenCalled();
  });

  it('stops the previous connection before persisting direct mode', async () => {
    const { service, ports, saved } = fixture();
    await expect(service.save({ ...base, mode: 'direct_provider' })).resolves.toMatchObject({ changed: true, cancelled: false });
    expect(ports.stopConnection).toHaveBeenCalledWith('local_gateway', {
      strictRestore: true, restoreManagedBackup: true,
    });
    expect(ports.assertDirectProvider).toHaveBeenCalledOnce();
    expect(ports.syncDirect).toHaveBeenCalledOnce();
    expect(saved().mode).toBe('direct_provider');
  });

  it('restores the previous gateway after direct-mode sync fails', async () => {
    const { service, ports, saved } = fixture();
    vi.mocked(ports.syncDirect).mockRejectedValueOnce(new Error('direct write failed'));
    await expect(service.save({ ...base, mode: 'direct_provider' })).rejects.toThrow('direct write failed');
    expect(saved()).toEqual(base);
    expect(ports.stopRuntime).toHaveBeenCalledOnce();
    expect(ports.startLocal).toHaveBeenCalledWith(base);
    expect(ports.syncLocal).toHaveBeenCalledOnce();
  });
});
