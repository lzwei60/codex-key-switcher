import { describe, expect, it, vi } from 'vitest';
import type { ProviderService } from '@codex-key-switcher/core';
import type { Provider, ProviderInput, RouteSettings } from '@codex-key-switcher/shared';
import { ProviderApplicationService, type ProviderApplicationPorts } from './provider-application-service';

const first: Provider = {
  id: 'first', name: 'First', baseURL: 'https://first.example/v1', apiFormat: 'responses',
  models: [{ customName: 'One', model: 'one' }, { customName: 'Two', model: 'two' }],
  selectedModel: 'One', updatedAt: 1,
};
const second: Provider = { ...first, id: 'second', name: 'Second', updatedAt: 2 };
const settings: RouteSettings = {
  mode: 'local_gateway', enabled: true, autoStart: true, disabledExplicitly: false,
  listenAddress: '127.0.0.1', listenPort: 3456, allowLANListen: false,
  failoverEnabled: false, failoverMaxAttempts: 3, failoverTotalTimeoutMs: 180_000,
  failoverFailureThreshold: 3, failoverCooldownMs: 60_000, failoverHalfOpenMaxRequests: 1,
};

function fixture(initial: Provider[] = [first]) {
  let records = initial.map((item) => ({ ...item }));
  let currentId = records[0]?.id;
  const providers = {
    list: vi.fn(async () => records.map((item) => ({ ...item }))),
    current: vi.fn(async () => records.find((item) => item.id === currentId) ?? null),
    currentApiKey: vi.fn(async () => 'old-key'),
    upsert: vi.fn(async (input: ProviderInput) => {
      const result = { ...first, ...input, id: input.id ?? 'new' } as Provider;
      records = [...records.filter((item) => item.id !== result.id), result];
      return result;
    }),
    restore: vi.fn(async (provider: Provider) => {
      records = [...records.filter((item) => item.id !== provider.id), provider];
    }),
    delete: vi.fn(async (id: string) => { records = records.filter((item) => item.id !== id); }),
    setCurrent: vi.fn(async (id: string) => { currentId = id; }),
    setSelectedModel: vi.fn(async (id: string, model: string) => {
      records = records.map((item) => item.id === id ? { ...item, selectedModel: model } : item);
    }),
  };
  const ports: ProviderApplicationPorts = {
    providers: providers as unknown as ProviderService,
    routeSettings: vi.fn(async () => settings),
    syncCodex: vi.fn(async () => undefined),
    refreshStatus: vi.fn(async () => undefined),
    stopGateway: vi.fn(async () => undefined),
    validateInput: vi.fn(),
    assertSaveSupportsMode: vi.fn(async () => undefined),
    assertDirectProvider: vi.fn(async () => undefined),
    notifyFirstProvider: vi.fn(async () => undefined),
    notifySwitch: vi.fn(async () => undefined),
  };
  return { service: new ProviderApplicationService(ports), ports, providers };
}

describe('ProviderApplicationService', () => {
  it('restores the previous provider and key if Codex sync fails on edit', async () => {
    const { service, ports, providers } = fixture();
    vi.mocked(ports.syncCodex).mockRejectedValueOnce(new Error('write failed'));
    await expect(service.save({ ...first, name: 'Edited', apiKey: 'new-key' })).rejects.toThrow('write failed');
    expect(providers.restore).toHaveBeenCalledWith(first, 'old-key');
    expect(ports.syncCodex).toHaveBeenCalledTimes(2);
  });

  it('rolls back a new provider if first sync fails', async () => {
    const { service, ports, providers } = fixture([]);
    vi.mocked(ports.syncCodex).mockRejectedValueOnce(new Error('write failed'));
    await expect(service.save({
      name: first.name, baseURL: first.baseURL, apiFormat: first.apiFormat,
      models: first.models, apiKey: 'new-key',
    })).rejects.toThrow('write failed');
    expect(providers.delete).toHaveBeenCalledWith('new');
  });

  it('restores selection and resyncs when a provider switch fails', async () => {
    const { service, ports, providers } = fixture([first, second]);
    vi.mocked(ports.syncCodex).mockRejectedValueOnce(new Error('write failed'));
    await expect(service.switchProvider(second.id)).rejects.toThrow('write failed');
    expect(await providers.current()).toMatchObject({ id: first.id });
    expect(ports.refreshStatus).toHaveBeenCalledTimes(1);
  });

  it('restores model if direct-mode validation fails after the model changes', async () => {
    const { service, ports, providers } = fixture();
    vi.mocked(ports.routeSettings).mockResolvedValue({ ...settings, mode: 'direct_provider' });
    vi.mocked(ports.assertDirectProvider).mockRejectedValueOnce(new Error('unsupported'));
    await expect(service.switchModel(first.id, 'Two')).rejects.toThrow('unsupported');
    expect((await providers.list())[0]?.selectedModel).toBe('One');
  });

  it('stops gateway after deleting the final provider', async () => {
    const { service, ports } = fixture();
    await service.delete(first.id);
    expect(ports.stopGateway).toHaveBeenCalledOnce();
  });
});
