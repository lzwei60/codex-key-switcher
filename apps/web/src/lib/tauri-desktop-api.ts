import type { DesktopApi, DesktopCommandError } from '@codex-key-switcher/shared';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';

export class TauriCommandError extends Error implements DesktopCommandError {
  constructor(readonly code: string, message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'TauriCommandError';
  }
}

function commandError(error: unknown): TauriCommandError {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error
    && typeof error.code === 'string' && typeof error.message === 'string') {
    return new TauriCommandError(error.code, error.message, 'retryable' in error && error.retryable === true);
  }
  return new TauriCommandError('COMMAND_FAILED', '桌面命令执行失败。', false);
}

async function call<Result>(name: string, payload?: Record<string, unknown>): Promise<Result> {
  try {
    return await (payload ? invoke<Result>(name, payload) : invoke<Result>(name));
  } catch (error) {
    throw commandError(error);
  }
}

function unavailable(): Promise<never> {
  return Promise.reject(new TauriCommandError(
    'NOT_MIGRATED',
    '该操作尚未迁移至 Tauri，预览版不会修改真实 Codex 配置或凭据。',
    false,
  ));
}

async function exportProviderMetadata(): Promise<boolean> {
  const path = await save({
    defaultPath: 'codex-key-switcher-providers.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (!path || Array.isArray(path)) return false;
  await call('providers_export_metadata_file', { path });
  return true;
}

async function importProviderMetadata(): Promise<number> {
  const path = await open({
    directory: false,
    multiple: false,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (!path || Array.isArray(path)) return 0;
  const result = await call<{ importedCount: number }>('providers_import_metadata_file', { path });
  return result.importedCount;
}

async function exportCredentialMigration(passphrase: string) {
  const path = await save({
    defaultPath: 'codex-key-switcher-credential-migration.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (!path || Array.isArray(path)) {
    return { providerCount: 0, credentialCount: 0, missingCredentialCount: 0 };
  }
  return call<{ providerCount: number; credentialCount: number; missingCredentialCount: number }>(
    'app_export_credential_migration',
    { path, passphrase },
  );
}

// Only explicitly registered Rust commands may be called from the preview.
export function createTauriDesktopApi(): DesktopApi {
  return {
    app: {
      startupSettings: () => call('app_startup_settings'),
      saveStartupSettings: (input) => call('app_save_startup_settings', { input }),
      preferences: () => call('app_preferences'),
      savePreferences: (input) => call('app_save_preferences', { input }),
      codexConfigDirectory: () => call('app_codex_config_directory'),
      saveCodexConfigDirectory: (directory) => call('app_save_codex_config_directory', { directory }),
      chooseCodexConfigDirectory: () => call('app_prepare_codex_sandbox'),
      checkForUpdates: () => call('app_check_for_updates'),
      openUpdateDownload: (downloadUrl) => call('app_open_update_download', { url: downloadUrl }),
      exportCredentialMigration,
      importCredentialMigration: (input, passphrase) => call('app_import_credential_migration', { input, passphrase }),
    },
    providers: {
      list: () => call('providers_list'),
      save: (input) => call('providers_save', { input }),
      delete: (id) => call('providers_delete', { id }),
      setCurrent: (id) => call('providers_set_current', { id }),
      setSelectedModel: (providerId, model) => call('providers_set_selected_model', { providerId, model }),
      validateModel: (input) => call('providers_validate_model', { input }),
      listUpstreamModels: (input) => call('providers_list_upstream_models', { input }),
      exportToFile: (includeAPIKeys) => includeAPIKeys ? unavailable() : exportProviderMetadata(),
      importFromFile: () => importProviderMetadata(),
    },
    gateway: {
      status: () => call('gateway_status'),
      start: () => call('gateway_start'),
      stop: () => call('gateway_stop'),
      settings: () => call('gateway_settings'),
      saveSettings: (input) => call('gateway_save_settings', { input }),
      checkPort: (input) => call('gateway_check_port', { input }),
    },
    diagnostics: {
      read: () => call('diagnostics_read'),
      resyncCodexConfig: () => call('diagnostics_resync_codex_config'),
      stopGatewayAndRestoreCodex: () => call('diagnostics_stop_and_restore_codex'),
      prepareUninstall: () => call('diagnostics_prepare_uninstall'),
      openRestoreScriptDirectory: () => call('diagnostics_open_restore_directory'),
      copyReport: () => call('diagnostics_copy_report'),
    },
    usage: {
      stats: (input) => call('usage_stats', { input }),
      clearLogs: () => call('usage_clear_logs'),
      settings: () => call('usage_settings'),
      saveSettings: (input) => call('usage_save_settings', { input }),
    },
  };
}
