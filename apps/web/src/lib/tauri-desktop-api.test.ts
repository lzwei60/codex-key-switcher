import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { createTauriDesktopApi } from './tauri-desktop-api';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));

describe('Tauri DesktopApi bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(open).mockResolvedValue(null);
    vi.mocked(save).mockResolvedValue(null);
  });

  it('routes read commands and preference input to Rust with typed payloads', async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    const api = createTauriDesktopApi();
    await api.providers.list();
    expect(invoke).toHaveBeenCalledWith('providers_list');
    await api.usage.stats({ logPage: 2, logPageSize: 20 });
    expect(invoke).toHaveBeenCalledWith('usage_stats', { input: { logPage: 2, logPageSize: 20 } });
    await api.app.savePreferences({ language: 'en', theme: 'dark' });
    expect(invoke).toHaveBeenCalledWith('app_save_preferences', { input: { language: 'en', theme: 'dark' } });
    await api.usage.saveSettings({ enabled: true, retentionDays: 7, maxRecords: 500 });
    expect(invoke).toHaveBeenCalledWith('usage_save_settings', {
      input: { enabled: true, retentionDays: 7, maxRecords: 500 },
    });
    await api.usage.clearLogs();
    expect(invoke).toHaveBeenCalledWith('usage_clear_logs');
    const routeSettings = {
      mode: 'local_gateway', enabled: false, autoStart: false, disabledExplicitly: true,
      listenAddress: '127.0.0.1', listenPort: 3456, allowLANListen: false,
      failoverEnabled: false, failoverMaxAttempts: 3, failoverTotalTimeoutMs: 180_000,
      failoverFailureThreshold: 3, failoverCooldownMs: 60_000, failoverHalfOpenMaxRequests: 1,
    } as const;
    await api.gateway.saveSettings(routeSettings);
    expect(invoke).toHaveBeenCalledWith('gateway_save_settings', { input: routeSettings });
    await api.gateway.checkPort({ listenAddress: '127.0.0.1', listenPort: 3456, allowLANListen: false });
    expect(invoke).toHaveBeenCalledWith('gateway_check_port', {
      input: { listenAddress: '127.0.0.1', listenPort: 3456, allowLANListen: false },
    });
  });

  it('rejects unsupported writes without silently switching to web preview', async () => {
    const api = createTauriDesktopApi();
    await api.gateway.start();
    expect(invoke).toHaveBeenCalledWith('gateway_start');
    await api.gateway.stop();
    expect(invoke).toHaveBeenCalledWith('gateway_stop');
    await api.providers.save({
      name: 'Test', baseURL: 'https://example.com/v1', apiFormat: 'responses',
      models: [{ customName: 'test', model: 'test' }], apiKey: 'test-key',
    });
    expect(invoke).toHaveBeenCalledWith('providers_save', expect.objectContaining({
      input: expect.objectContaining({ name: 'Test', apiKey: 'test-key' }),
    }));
    await api.providers.validateModel({
      baseURL: 'https://example.com/v1',
      apiFormat: 'responses',
      apiKey: 'test-key',
      model: { customName: 'test', model: 'test' },
    });
    expect(invoke).toHaveBeenCalledWith('providers_validate_model', expect.objectContaining({
      input: expect.objectContaining({ apiKey: 'test-key', apiFormat: 'responses' }),
    }));
    await api.providers.listUpstreamModels({
      baseURL: 'https://example.com/v1',
      apiFormat: 'responses',
      apiKey: 'test-key',
    });
    expect(invoke).toHaveBeenCalledWith('providers_list_upstream_models', expect.objectContaining({
      input: expect.objectContaining({ apiKey: 'test-key', apiFormat: 'responses' }),
    }));
  });

  it('uses native JSON dialogs for metadata import and export', async () => {
    vi.mocked(save).mockResolvedValue('/tmp/providers.json');
    vi.mocked(open).mockResolvedValue('/tmp/providers.json');
    vi.mocked(invoke).mockResolvedValueOnce({ path: '/tmp/providers.json', providerCount: 1 });
    vi.mocked(invoke).mockResolvedValueOnce({ importedCount: 1 });
    const api = createTauriDesktopApi();
    await expect(api.providers.exportToFile(false)).resolves.toBe(true);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: 'codex-key-switcher-providers.json' }));
    expect(invoke).toHaveBeenCalledWith('providers_export_metadata_file', { path: '/tmp/providers.json' });
    await expect(api.providers.importFromFile()).resolves.toBe(1);
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ multiple: false, directory: false }));
    expect(invoke).toHaveBeenCalledWith('providers_import_metadata_file', { path: '/tmp/providers.json' });
  });

  it('turns Rust rejections into errors the UI can display', async () => {
    vi.mocked(invoke).mockRejectedValueOnce({ code: 'INVALID_PREFERENCES', message: '无效的界面偏好。', retryable: false });
    await expect(createTauriDesktopApi().app.preferences()).rejects.toMatchObject({
      name: 'TauriCommandError', code: 'INVALID_PREFERENCES', message: '无效的界面偏好。',
    });
    vi.mocked(invoke).mockRejectedValueOnce('sensitive raw Rust error');
    await expect(createTauriDesktopApi().gateway.status()).rejects.toMatchObject({
      code: 'COMMAND_FAILED', message: '桌面命令执行失败。',
    });
    vi.mocked(invoke).mockRejectedValueOnce({ code: 'NOT_MIGRATED', message: '网关转发尚未迁移。', retryable: false });
    await expect(createTauriDesktopApi().gateway.start()).rejects.toMatchObject({ code: 'NOT_MIGRATED' });
  });

  it('imports an explicitly selected credential migration package through Rust', async () => {
    vi.mocked(invoke).mockResolvedValue({
      importedProviderCount: 1,
      importedCredentialCount: 1,
      completedAt: 123,
      sourceCleanupRequired: true,
    });
    const input = {
      format: 'codex-key-switcher-encrypted-migration' as const,
      schemaVersion: 2 as const,
      algorithm: 'aes-256-gcm' as const, kdf: 'pbkdf2-sha256' as const,
      iterations: 600000 as const, salt: '', nonce: '', ciphertext: '',
    };
    await createTauriDesktopApi().app.importCredentialMigration(input, 'synthetic-passphrase');
    expect(invoke).toHaveBeenCalledWith('app_import_credential_migration', { input, passphrase: 'synthetic-passphrase' });
  });

  it('exports an encrypted credential migration package through the native save dialog', async () => {
    vi.mocked(save).mockResolvedValue('/tmp/credential-migration.json');
    vi.mocked(invoke).mockResolvedValue({ providerCount: 1, credentialCount: 1, missingCredentialCount: 0 });
    await createTauriDesktopApi().app.exportCredentialMigration('synthetic-passphrase');
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: 'codex-key-switcher-credential-migration.json' }));
    expect(invoke).toHaveBeenCalledWith('app_export_credential_migration', {
      path: '/tmp/credential-migration.json',
      passphrase: 'synthetic-passphrase',
    });
  });

  it('routes isolated Codex synchronization and restore to registered commands', async () => {
    vi.mocked(invoke).mockResolvedValue({ directory: '/preview/codex-sandbox', isDefault: false });
    const api = createTauriDesktopApi();
    await api.app.chooseCodexConfigDirectory();
    expect(invoke).toHaveBeenCalledWith('app_prepare_codex_sandbox');
    await api.diagnostics.resyncCodexConfig();
    expect(invoke).toHaveBeenCalledWith('diagnostics_resync_codex_config');
    await api.diagnostics.stopGatewayAndRestoreCodex();
    expect(invoke).toHaveBeenCalledWith('diagnostics_stop_and_restore_codex');
    await api.diagnostics.copyReport();
    expect(invoke).toHaveBeenCalledWith('diagnostics_copy_report');
    await api.diagnostics.prepareUninstall();
    expect(invoke).toHaveBeenCalledWith('diagnostics_prepare_uninstall');
    await api.diagnostics.openRestoreScriptDirectory();
    expect(invoke).toHaveBeenCalledWith('diagnostics_open_restore_directory');
    await api.app.openUpdateDownload('https://github.com/lzwei60/codex-key-switcher/releases/tag/v1.0.5');
    expect(invoke).toHaveBeenCalledWith('app_open_update_download', {
      url: 'https://github.com/lzwei60/codex-key-switcher/releases/tag/v1.0.5',
    });
  });
});
