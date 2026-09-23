import { describe, expect, it } from 'vitest';
import type { RouteSettings } from '@codex-key-switcher/shared';
import { planRouteSettingsChange } from './route-settings';

const baseSettings: RouteSettings = {
  mode: 'local_gateway',
  enabled: true,
  autoStart: true,
  disabledExplicitly: false,
  listenAddress: '127.0.0.1',
  listenPort: 3456,
  allowLANListen: false,
  failoverEnabled: false,
  failoverMaxAttempts: 3,
  failoverTotalTimeoutMs: 180_000,
  failoverFailureThreshold: 3,
  failoverCooldownMs: 60_000,
  failoverHalfOpenMaxRequests: 1,
};

describe('planRouteSettingsChange', () => {
  it('treats auto-start changes as persisted settings only', () => {
    expect(planRouteSettingsChange(baseSettings, { ...baseSettings, autoStart: false })).toMatchObject({
      changed: true,
      localGatewayRuntimeChanged: false,
      codexConfigChanged: false,
    });
  });

  it('updates local gateway runtime but not Codex config when failover changes', () => {
    expect(planRouteSettingsChange(baseSettings, { ...baseSettings, failoverEnabled: true })).toMatchObject({
      changed: true,
      localGatewayRuntimeChanged: true,
      codexConfigChanged: false,
    });
  });

  it('requires local gateway restart and Codex sync when the listen port changes', () => {
    expect(planRouteSettingsChange(baseSettings, { ...baseSettings, listenPort: 4567 })).toMatchObject({
      changed: true,
      localGatewayRuntimeChanged: true,
      codexConfigChanged: true,
    });
  });

  it('requires Codex sync when the connection is disabled', () => {
    expect(planRouteSettingsChange(baseSettings, { ...baseSettings, enabled: false, disabledExplicitly: true })).toMatchObject({
      changed: true,
      enabledChanged: true,
      localGatewayRuntimeChanged: false,
      codexConfigChanged: true,
    });
  });
});
