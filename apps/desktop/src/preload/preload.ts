import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi } from '@codex-key-switcher/shared';

const desktopAPI: DesktopApi = {
  app: {
    startupSettings: () => ipcRenderer.invoke('app:startup-settings'),
    saveStartupSettings: (input) => ipcRenderer.invoke('app:save-startup-settings', input),
    preferences: () => ipcRenderer.invoke('app:preferences'),
    savePreferences: (input) => ipcRenderer.invoke('app:save-preferences', input),
    codexConfigDirectory: () => ipcRenderer.invoke('app:codex-config-directory'),
    saveCodexConfigDirectory: (directory) => ipcRenderer.invoke('app:save-codex-config-directory', directory),
    chooseCodexConfigDirectory: () => ipcRenderer.invoke('app:choose-codex-config-directory'),
    checkForUpdates: () => ipcRenderer.invoke('app:check-for-updates'),
    openUpdateDownload: (downloadUrl) => ipcRenderer.invoke('app:open-update-download', downloadUrl),
  },
  providers: {
    list: () => ipcRenderer.invoke('providers:list'),
    save: (input) => ipcRenderer.invoke('providers:save', input),
    delete: (id) => ipcRenderer.invoke('providers:delete', id),
    setCurrent: (id) => ipcRenderer.invoke('providers:set-current', id),
    setSelectedModel: (providerId, model) => ipcRenderer.invoke('providers:set-selected-model', providerId, model),
    validateModel: (input) => ipcRenderer.invoke('providers:validate-model', input),
    listUpstreamModels: (input) => ipcRenderer.invoke('providers:list-upstream-models', input),
    exportToFile: (includeAPIKeys) => ipcRenderer.invoke('providers:export-to-file', includeAPIKeys),
    importFromFile: () => ipcRenderer.invoke('providers:import-from-file'),
  },
  gateway: {
    status: () => ipcRenderer.invoke('gateway:status'),
    start: () => ipcRenderer.invoke('gateway:start'),
    stop: () => ipcRenderer.invoke('gateway:stop'),
    settings: () => ipcRenderer.invoke('gateway:settings'),
    saveSettings: (input) => ipcRenderer.invoke('gateway:save-settings', input),
    checkPort: (input) => ipcRenderer.invoke('gateway:check-port', input),
  },
  diagnostics: {
    read: () => ipcRenderer.invoke('diagnostics:read'),
    resyncCodexConfig: () => ipcRenderer.invoke('diagnostics:resync-codex-config'),
    stopGatewayAndRestoreCodex: () => ipcRenderer.invoke('diagnostics:stop-gateway-and-restore-codex'),
    prepareUninstall: () => ipcRenderer.invoke('diagnostics:prepare-uninstall'),
    openRestoreScriptDirectory: () => ipcRenderer.invoke('diagnostics:open-restore-script-directory'),
    copyReport: () => ipcRenderer.invoke('diagnostics:copy-report'),
  },
  usage: {
    stats: (input) => ipcRenderer.invoke('usage:stats', input),
    clearLogs: () => ipcRenderer.invoke('usage:clear-logs'),
    settings: () => ipcRenderer.invoke('usage:settings'),
    saveSettings: (input) => ipcRenderer.invoke('usage:save-settings', input),
  },
};

contextBridge.exposeInMainWorld('desktopAPI', desktopAPI);
