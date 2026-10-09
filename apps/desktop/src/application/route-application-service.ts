import { planRouteSettingsChange } from '@codex-key-switcher/core';
import type { ConnectionMode, GatewayStatus, RouteSettings, RouteSettingsSaveResult } from '@codex-key-switcher/shared';

export interface RouteApplicationPorts {
  settings(): Promise<RouteSettings>;
  normalize(input: RouteSettings): RouteSettings;
  confirmSwitch(previous: ConnectionMode, next: ConnectionMode): Promise<boolean>;
  persist(settings: RouteSettings): Promise<void>;
  status(): GatewayStatus;
  setStatus(status: GatewayStatus): void;
  connectionStatus(settings: RouteSettings): Promise<GatewayStatus>;
  updateTray(): void;
  stopConnection(mode: ConnectionMode, options: { strictRestore?: boolean; restoreManagedBackup?: boolean }): Promise<void>;
  clearDirectTarget(): Promise<void>;
  assertDirectProvider(): Promise<void>;
  syncDirect(): Promise<void>;
  startLocal(settings: RouteSettings): Promise<GatewayStatus>;
  syncLocal(status: GatewayStatus): Promise<void>;
  runtimeStatus(): Promise<GatewayStatus>;
  stopRuntime(): Promise<void>;
  restoreBackup(): Promise<void>;
  reportRollbackFailure(error: unknown): void;
}

export class RouteApplicationService {
  constructor(private readonly ports: RouteApplicationPorts) {}

  async save(input: RouteSettings): Promise<RouteSettingsSaveResult> {
    const ports = this.ports;
    const previous = await ports.settings();
    const next = ports.normalize(input);
    const change = planRouteSettingsChange(previous, next);
    if (!await ports.confirmSwitch(previous.mode, next.mode)) {
      return { settings: previous, changed: false, cancelled: true };
    }

    try {
      if (!change.enabledChanged && !change.connectionModeChanged && !change.localGatewayRuntimeChanged && !change.codexConfigChanged) {
        await ports.persist(next);
        ports.setStatus(await ports.connectionStatus(next));
        ports.updateTray();
      } else if (!next.enabled) {
        await ports.stopConnection(previous.mode, { strictRestore: true, restoreManagedBackup: true });
        if (previous.mode === 'direct_provider') await ports.clearDirectTarget();
        await ports.persist(next);
        ports.setStatus(await ports.connectionStatus(next));
        ports.updateTray();
      } else if (next.mode === 'direct_provider') {
        await ports.assertDirectProvider();
        await ports.stopConnection(previous.mode, {
          strictRestore: previous.mode === 'local_gateway',
          restoreManagedBackup: previous.mode === 'local_gateway',
        });
        await ports.persist(next);
        if (change.codexConfigChanged) await ports.syncDirect();
        ports.setStatus(await ports.connectionStatus(next));
        ports.updateTray();
      } else if (previous.mode === 'direct_provider') {
        await ports.persist(next);
        if (change.localGatewayRuntimeChanged || !ports.status().running) ports.setStatus(await ports.startLocal(next));
        if (change.codexConfigChanged) await ports.syncLocal(ports.status());
      } else if (change.localGatewayRuntimeChanged || !ports.status().running) {
        ports.setStatus(await ports.startLocal(next));
        await ports.persist(next);
        if (change.codexConfigChanged) await ports.syncLocal(ports.status());
      } else {
        await ports.persist(next);
        if (ports.status().running) ports.setStatus(await ports.runtimeStatus());
        ports.setStatus({ ...ports.status(), mode: next.mode });
        ports.updateTray();
      }
      return { settings: next, changed: change.changed, cancelled: false };
    } catch (error) {
      await this.rollback(previous).catch(ports.reportRollbackFailure);
      throw error;
    }
  }

  private async rollback(settings: RouteSettings): Promise<void> {
    const ports = this.ports;
    await ports.stopRuntime().catch(() => undefined);
    await ports.persist(settings);
    if (!settings.enabled) {
      if (settings.mode === 'direct_provider') await ports.clearDirectTarget();
      await ports.restoreBackup().catch(() => undefined);
      ports.setStatus(await ports.connectionStatus(settings));
      ports.updateTray();
      return;
    }

    if (settings.mode === 'direct_provider') await ports.syncDirect();
    else {
      ports.setStatus(await ports.startLocal(settings));
      await ports.syncLocal(ports.status());
    }
    ports.setStatus(await ports.connectionStatus(settings));
    ports.updateTray();
  }
}
