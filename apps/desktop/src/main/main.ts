import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog, Notification, clipboard, shell, type MessageBoxOptions, type OpenDialogOptions, type SaveDialogOptions } from 'electron';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultUsageSettings,
  type ApiFormat,
  type AppPreferences,
  type AppStartupSettings,
  type AppUpdateInfo,
  type AppUpdatePlatformKey,
  type ConnectionMode,
  type CodexConfigDirectorySettings,
  type DirectSessionTarget,
  type GatewayStatus,
  type PortCheckResult,
  type Provider,
  type ProviderInput,
  type ProviderModel,
  type ProviderModelsListInput,
  type ProviderModelsListResult,
  type ProviderModelValidationInput,
  type ProviderModelValidationResult,
  type DiagnosticsReport,
  type RouteSettings,
  type RouteSettingsSaveResult,
  type UsageSettings,
} from '@codex-key-switcher/shared';
import {
  CodexConfigService,
  ProviderService,
  UsageService,
  directSessionTargetForProvider,
  planRouteSettingsChange,
  providerSelectedDisplayModel,
  providerSelectedModel,
} from '@codex-key-switcher/core';
import { AppSettingsStore } from '../services/app-settings-store';
import { CodexFileConfigAdapter } from '../services/codex-file-config-adapter';
import { CredentialFileStore } from '../services/credential-file-store';
import { LocalGatewayRuntime } from '../services/local-gateway-runtime';
import { ProviderFileRepository } from '../services/provider-file-repository';
import { UsageFileRepository } from '../services/usage-file-repository';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const releaseApiUrl = 'https://api.github.com/repos/lzwei60/codex-key-switcher/releases/latest';
const releaseLatestPageUrl = 'https://github.com/lzwei60/codex-key-switcher/releases/latest';
const releaseBaseUrl = 'https://github.com/lzwei60/codex-key-switcher';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let appSettingsStore: AppSettingsStore | null = null;
let credentialStore: CredentialFileStore | null = null;
let providerService: ProviderService | null = null;
let codexConfigService: CodexConfigService | null = null;
let usageService: UsageService | null = null;
let localGatewayRuntime: LocalGatewayRuntime | null = null;
let isQuitting = false;
let quitFlowStarted = false;
let gatewayStatusCache: GatewayStatus = {
  running: false,
  mode: defaultRouteSettings().mode,
  endpoint: defaultRouteSettings().listenAddress === '127.0.0.1'
    ? `http://127.0.0.1:${defaultRouteSettings().listenPort}/v1`
    : 'http://127.0.0.1:3456/v1',
};

const directSessionTargetKey = 'directSessionTarget';

async function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 920,
    minHeight: 620,
    title: 'Codex Key Switcher',
    webPreferences: {
      preload: path.join(dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow?.hide();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (isDev) {
    await mainWindow.loadURL('http://localhost:3340');
  } else {
    await mainWindow.loadFile(await rendererIndexPath());
  }
}

async function rendererIndexPath(): Promise<string> {
  const candidates = [
    path.join(dirname, '../../../web/out/index.html'),
    path.join(dirname, '../../../../../../web/out/index.html'),
    path.join(process.resourcesPath, 'web/out/index.html'),
  ];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }

  throw new Error(`Renderer output was not found. Checked: ${candidates.join(', ')}`);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function createTray() {
  if (!tray) {
    tray = new Tray(createTrayIcon());
    tray.setToolTip('Codex Key Switcher');
    if (process.platform === 'darwin') tray.setIgnoreDoubleClickEvents(true);
  }
  void updateTrayMenu();
}

function createTrayIcon() {
  if (process.platform === 'darwin') return nativeImage.createEmpty();

  const candidates = [
    path.join(dirname, '../../build/icon.png'),
    path.join(process.resourcesPath, 'app.asar/build/icon.png'),
    path.join(process.resourcesPath, 'build/icon.png'),
    path.join(process.resourcesPath, 'icon.png'),
  ];

  for (const candidate of candidates) {
    const image = nativeImage.createFromPath(candidate);
    if (!image.isEmpty()) {
      return image.resize({ width: 18, height: 18 });
    }
  }

  return nativeImage.createEmpty();
}

async function updateTrayMenu(): Promise<void> {
  if (!tray) return;

  const [providers, currentProvider, routeSettings] = await Promise.all([
    getProviderService().list().catch(() => [] as Provider[]),
    getProviderService().current().catch(() => null),
    getRouteSettings().catch(() => defaultRouteSettings()),
  ]);
  const currentModel = currentProvider ? providerSelectedDisplayModel(currentProvider) : gatewayStatusCache.currentModel;
  const providerLabel = currentProvider?.name
    ? `CK: ${currentProvider.name} / ${currentModel || '未选择模型'}`
    : 'CK: 未选择供应商';
  const isDirectMode = routeSettings.mode === 'direct_provider';

  tray.setToolTip(providerLabel);
  if (process.platform === 'darwin') {
    tray.setTitle(providerLabel);
  }

  const providerSubmenu = providers.length
    ? providers.map((provider) => ({
        checked: provider.id === currentProvider?.id,
        click: () => void switchTrayProvider(provider.id),
        label: `${provider.name} (${formatApiFormat(provider.apiFormat)})`,
        type: 'radio' as const,
      }))
    : [{ enabled: false, label: '暂无供应商' }];

  const modelSubmenu = currentProvider?.models.length
    ? currentProvider.models.map((model) => {
        const label = model.customName || model.model;
        return {
          checked: label === currentProvider.selectedModel || model.model === currentProvider.selectedModel,
          click: () => void switchTrayModel(currentProvider.id, label),
          label: model.customName === model.model ? model.model : `${model.customName} -> ${model.model}`,
          type: 'radio' as const,
        };
      })
    : [{ enabled: false, label: '暂无模型' }];

  tray.setContextMenu(Menu.buildFromTemplate([
    { enabled: false, label: `连接模式：${connectionModeLabel(routeSettings.mode)}` },
    { enabled: false, label: `${isDirectMode ? '上游地址' : '路由地址'}：${gatewayStatusCache.endpoint}` },
    { enabled: false, label: `运行状态：${gatewayStatusCache.running ? '运行中' : routeSettings.enabled ? isDirectMode ? '直连已配置' : '已启用未运行' : '已停止'}` },
    { enabled: false, label: `当前供应商：${currentProvider?.name ?? '未选择'}` },
    { enabled: false, label: `当前模型：${currentModel ?? '未选择'}` },
    { type: 'separator' },
    { label: '供应商', submenu: providerSubmenu },
    { label: '模型', submenu: modelSubmenu },
    { type: 'separator' },
    { label: '打开主界面', click: () => void createWindow() },
    { label: isDirectMode ? routeSettings.enabled ? '停用直连配置' : '启用直连配置' : gatewayStatusCache.running ? '停止本地路由' : '启动本地路由', click: () => void toggleGateway() },
    { type: 'separator' },
    { label: '退出', click: () => void quitApplication() },
  ]));
}

async function switchTrayProvider(providerId: string): Promise<void> {
  const [routeSettings, targetProvider] = await Promise.all([
    getRouteSettings().catch(() => defaultRouteSettings()),
    getProviderService().list()
      .then((providers) => providers.find((provider) => provider.id === providerId))
      .catch(() => undefined),
  ]);
  if (routeSettings.mode === 'direct_provider' && targetProvider?.apiFormat === 'chat_completions') {
    await notifyTrayProviderSwitchFailure(providerId, new Error('直连供应商模式不支持 Chat Completions 格式供应商。'));
    await updateTrayMenu();
    return;
  }

  try {
    await switchCurrentProviderTransactionally(providerId);
  } catch (error) {
    await notifyTrayProviderSwitchFailure(providerId, error);
    await updateTrayMenu();
  }
}

async function switchTrayModel(providerId: string, model: string): Promise<void> {
  await switchSelectedModelTransactionally(providerId, model);
}

async function notifyConversationSwitch(input: {
  previousProvider?: Provider | null;
  nextProvider?: Provider | null;
  switchedTarget: 'provider' | 'model';
}): Promise<void> {
  const routeSettings = await getRouteSettings();
  const isDirectMode = routeSettings.mode === 'direct_provider';
  const providerChanged = Boolean(
    input.previousProvider
    && input.nextProvider
    && input.previousProvider.id !== input.nextProvider.id,
  );
  const switchedTarget = input.switchedTarget === 'provider' ? '供应商' : '模型';
  const title = '建议打开新会话';
  const message = `${switchedTarget}已切换`;
  const detail = directSwitchDetail({
    isDirectMode,
    providerChanged,
    nextProvider: input.nextProvider,
  });
  if (Notification.isSupported()) {
    new Notification({
      title,
      body: `${message}\n${detail}`,
      silent: false,
    }).show();
    return;
  }

  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const options: MessageBoxOptions = {
    type: 'info',
    title,
    message,
    buttons: ['知道了'],
    defaultId: 0,
    noLink: true,
  };
  if (detail) options.detail = detail;
  const result = window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
  result.catch(() => undefined);
}

function directSwitchDetail(input: {
  isDirectMode: boolean;
  providerChanged: boolean;
  nextProvider: Provider | null | undefined;
}): string {
  if (!input.isDirectMode) {
    return '已有 Codex 会话可能继续使用旧上下文。建议打开一个新会话以确保新配置立即生效。';
  }

  const target = input.nextProvider
    ? `${input.nextProvider.name} / ${providerSelectedDisplayModel(input.nextProvider)}`
    : '新供应商配置';

  if (input.providerChanged) {
    return `直连模式已写入「${target}」。请在 Codex 新开会话；如果新会话仍未生效，再重启 Codex。`;
  }

  return `直连模式已写入「${target}」。请在 Codex 新开会话以使用新模型，当前已运行会话可能仍使用旧模型。`;
}

async function notifyTrayProviderSwitchFailure(providerId: string, error: unknown): Promise<void> {
  const provider = (await getProviderService().list().catch(() => [] as Provider[]))
    .find((item) => item.id === providerId);
  const reason = error instanceof Error ? error.message : '供应商切换失败。';
  const isChatProvider = provider?.apiFormat === 'chat_completions';
  const message = provider
    ? `供应商「${provider.name}」未切换。`
    : '供应商未切换。';
  const detail = isChatProvider
    ? '当前处于直连供应商模式，Chat Completions 格式必须通过本地路由完成协议转换。请切换到本地路由模式，或选择 Responses 格式供应商。'
    : reason;

  showProviderSwitchFailureMessage({ message, detail });
}

function showProviderSwitchFailureMessage(input: { message: string; detail: string }): void {
  const title = '无法切换供应商';
  if (Notification.isSupported()) {
    new Notification({
      title,
      body: `${input.message}\n${input.detail}`,
      silent: false,
    }).show();
    return;
  }

  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const options: MessageBoxOptions = {
    type: 'warning',
    title,
    message: input.message,
    detail: input.detail,
    buttons: ['知道了'],
    defaultId: 0,
    noLink: true,
  };
  const result = window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
  result.catch(() => undefined);
}

async function switchCurrentProviderTransactionally(providerId: string): Promise<void> {
  const providerService = getProviderService();
  const previousProvider = await providerService.current();
  const routeSettings = await getRouteSettings();
  const nextProvider = (await providerService.list()).find((provider) => provider.id === providerId);
  if (!nextProvider) throw new Error('配置不存在。');
  if (routeSettings.enabled && routeSettings.mode === 'direct_provider') {
    await assertProviderSupportsDirectMode(nextProvider);
  }

  await providerService.setCurrent(providerId);
  try {
    await syncCodexForCurrentMode();
    await refreshGatewayStatus();
    await notifyConversationSwitch({
      previousProvider,
      nextProvider,
      switchedTarget: 'provider',
    });
  } catch (error) {
    if (previousProvider) await providerService.setCurrent(previousProvider.id).catch(() => undefined);
    await syncCodexForCurrentMode().catch(() => undefined);
    await refreshGatewayStatus().catch(() => undefined);
    throw error;
  }
}

async function switchSelectedModelTransactionally(providerId: string, model: string): Promise<void> {
  const providerService = getProviderService();
  const previousProvider = (await providerService.list()).find((provider) => provider.id === providerId);
  if (!previousProvider) throw new Error('配置不存在。');
  const routeSettings = await getRouteSettings();

  await providerService.setSelectedModel(providerId, model);
  const nextProvider = (await providerService.list()).find((provider) => provider.id === providerId);
  if (!nextProvider) throw new Error('配置不存在。');
  if (routeSettings.enabled && routeSettings.mode === 'direct_provider') {
    await assertProviderSupportsDirectMode(nextProvider);
  }

  try {
    await syncCodexForCurrentMode();
    await refreshGatewayStatus();
    await notifyConversationSwitch({
      previousProvider,
      nextProvider,
      switchedTarget: 'model',
    });
  } catch (error) {
    await providerService.setSelectedModel(providerId, previousProvider.selectedModel).catch(() => undefined);
    await syncCodexForCurrentMode().catch(() => undefined);
    await refreshGatewayStatus().catch(() => undefined);
    throw error;
  }
}

async function notifyFirstProviderRouteAppliedIfNeeded(hadProviders: boolean): Promise<void> {
  if (hadProviders) return;

  const [routeSettings, providers] = await Promise.all([
    getRouteSettings(),
    getProviderService().list(),
  ]);
  if (!routeSettings.enabled || !providers.length) return;
  if (routeSettings.mode === 'direct_provider') {
    showRouteAppliedRestartMessage({
      message: '首次配置已添加，直连供应商配置已写入 Codex。',
      detail: 'Codex 可能缓存配置。通常新开会话即可生效；如仍未生效，请重启 Codex。',
    });
    return;
  }

  showRouteAppliedRestartMessage({
    message: '首次配置已添加，本地路由已写入 Codex 配置。',
    detail: '因为 Codex 在启动时读取配置，首次从无配置切换到本地路由后，需要重启 Codex，或关闭当前会话后打开新会话，才能使用新的供应商和模型。',
  });
}

function showRouteAppliedRestartMessage(input?: { message?: string; detail?: string }): void {
  const title = '需要重启 Codex';
  const message = input?.message ?? '本地路由已重新启用，并已写入 Codex 配置。';
  const detail = input?.detail ?? '因为 Codex 在启动时读取配置，重新启用本地路由后，需要重启 Codex，或关闭当前会话后打开新会话，才能使用新的路由配置。';

  if (Notification.isSupported()) {
    new Notification({
      title,
      body: detail ? `${message}\n${detail}` : message,
      silent: false,
    }).show();
    return;
  }

  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const options: MessageBoxOptions = {
    type: 'info',
    title,
    message,
    buttons: ['知道了'],
    defaultId: 0,
    noLink: true,
  };
  if (detail) options.detail = detail;
  const result = window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
  result.catch(() => undefined);
}

function notifyConnectionToggle(mode: ConnectionMode, enabled: boolean): void {
  const modeName = connectionModeLabel(mode);
  showRouteAppliedRestartMessage({
    message: `${modeName}${enabled ? '已重新启用' : '已停用'}，并已写入Codex配置。请重启Codex。`,
    detail: '',
  });
}

function formatApiFormat(value: ApiFormat): string {
  if (value === 'chat_completions') return 'Chat';
  if (value === 'anthropic_messages') return 'Anthropic';
  return 'Responses';
}

function connectionModeLabel(mode: ConnectionMode): string {
  return mode === 'direct_provider' ? '直连供应商' : '本地路由';
}

async function confirmConnectionModeSwitch(previousMode: ConnectionMode, nextMode: ConnectionMode): Promise<boolean> {
  if (previousMode === nextMode) return true;
  return confirmCodexRestartRequired({
    message: '切换连接模式后需要重启 Codex。',
    detail: `将从「${connectionModeLabel(previousMode)}」切换到「${connectionModeLabel(nextMode)}」。应用会重新写入 Codex 配置，Codex 可能继续使用旧缓存。请确认你会在切换后重启 Codex。`,
  });
}

async function confirmCodexRestartRequired(input: { message: string; detail: string }): Promise<boolean> {
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const options: MessageBoxOptions = {
    type: 'warning',
    title: '需要重启 Codex',
    message: input.message,
    detail: input.detail,
    buttons: ['确认并继续', '取消'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const result = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
  return result.response === 0;
}

function registerIpcHandlers() {
  ipcMain.handle('app:startup-settings', () => getStartupSettings());
  ipcMain.handle('app:save-startup-settings', (_event, input: Pick<AppStartupSettings, 'openAtLogin' | 'openAsHidden'>) => saveStartupSettings(input));
  ipcMain.handle('app:preferences', () => getAppPreferences());
  ipcMain.handle('app:save-preferences', (_event, input: AppPreferences) => saveAppPreferences(input));
  ipcMain.handle('app:codex-config-directory', () => getCodexConfigDirectorySettings());
  ipcMain.handle('app:save-codex-config-directory', (_event, directory: string) => saveCodexConfigDirectory(directory));
  ipcMain.handle('app:choose-codex-config-directory', () => chooseCodexConfigDirectory());
  ipcMain.handle('app:check-for-updates', () => checkForAppUpdates());
  ipcMain.handle('app:open-update-download', (_event, downloadUrl: string) => openUpdateDownload(downloadUrl));
  ipcMain.handle('providers:list', () => getProviderService().list());
  ipcMain.handle('providers:save', async (_event, input: ProviderInput) => {
    await validateProviderInputModels(input);
    const providerService = getProviderService();
    const providers = await providerService.list();
    await assertProviderSaveSupportsCurrentMode(input, providers);
    const hadProviders = providers.length > 0;
    const provider = await getProviderService().upsert(input);
    await syncCodexForCurrentMode();
    await notifyFirstProviderRouteAppliedIfNeeded(hadProviders);
    return provider;
  });
  ipcMain.handle('providers:delete', async (_event, id: string) => {
    await getProviderService().delete(id);
    const remainingProviders = await getProviderService().list();
    if (!remainingProviders.length) {
      await stopGateway({ strictRestore: true, restoreManagedBackup: true });
    } else {
      await syncCodexForCurrentMode();
    }
  });
  ipcMain.handle('providers:set-current', async (_event, id: string) => {
    await switchCurrentProviderTransactionally(id);
  });
  ipcMain.handle('providers:set-selected-model', async (_event, providerId: string, model: string) => {
    await switchSelectedModelTransactionally(providerId, model);
  });
  ipcMain.handle('providers:validate-model', (_event, input: ProviderModelValidationInput) => validateProviderModel(input));
  ipcMain.handle('providers:list-upstream-models', (_event, input: ProviderModelsListInput) => listUpstreamModels(input));
  ipcMain.handle('providers:export-to-file', (_event, includeAPIKeys: boolean) => exportProvidersToFile(includeAPIKeys));
  ipcMain.handle('providers:import-from-file', () => importProvidersFromFile());
  ipcMain.handle('gateway:status', () => refreshGatewayStatus());
  ipcMain.handle('gateway:start', () => startGateway());
  ipcMain.handle('gateway:stop', () => stopGateway());
  ipcMain.handle('gateway:settings', () => getRouteSettings());
  ipcMain.handle('gateway:save-settings', (_event, input: RouteSettings) => saveRouteSettings(input));
  ipcMain.handle('gateway:check-port', (_event, input: Pick<RouteSettings, 'listenAddress' | 'listenPort' | 'allowLANListen'>) => checkRoutePort(input));
  ipcMain.handle('diagnostics:read', () => readDiagnosticsReport());
  ipcMain.handle('diagnostics:resync-codex-config', () => resyncCodexConfig());
  ipcMain.handle('diagnostics:stop-gateway-and-restore-codex', () => stopGatewayAndRestoreCodex());
  ipcMain.handle('diagnostics:prepare-uninstall', () => prepareDiagnosticsUninstall());
  ipcMain.handle('diagnostics:open-restore-script-directory', () => openRestoreScriptDirectory());
  ipcMain.handle('diagnostics:copy-report', () => copyDiagnosticsReport());
  ipcMain.handle('usage:stats', (_event, input) => getUsageService().stats(input));
  ipcMain.handle('usage:clear-logs', () => getUsageService().clearLogs());
  ipcMain.handle('usage:settings', () => getUsageSettings());
  ipcMain.handle('usage:save-settings', async (_event, input: UsageSettings) => {
    const settings = await saveUsageSettings(input);
    await getUsageService().configure(settings);
    return settings;
  });
}

async function readDiagnosticsReport(): Promise<DiagnosticsReport> {
  const codex = getCodexConfigService();
  const routeSettings = await getRouteSettings();
  const gatewayStatus = await refreshGatewayStatus();
  const codexDirectory = await codex.getCodexDirectory();
  const codexUsesGateway = routeSettings.mode === 'local_gateway'
    ? await codex.configUsesLocalGateway()
    : false;
  const restoreScriptPath = restoreScriptFilePath();
  const restoreAvailable = await fileExists(restoreScriptPath);
  const healthStatus = healthStatusText(routeSettings, gatewayStatus, codexUsesGateway, restoreAvailable);
  const report: DiagnosticsReport = {
    appVersion: app.getVersion(),
    connectionMode: routeSettings.mode,
    routeEnabled: routeSettings.enabled,
    codexUsesGateway,
    gatewayRunning: gatewayStatus.running,
    codexDirectory,
    endpoint: gatewayStatus.endpoint,
    restoreAvailable,
    restoreScriptPath,
    healthStatus,
    issues: [
      ...(routeSettings.mode === 'local_gateway' && !codexUsesGateway ? ['Codex 当前未指向本地代理。'] : []),
      ...(routeSettings.mode === 'direct_provider' ? ['当前为直连供应商模式，不会记录本地请求日志和 Token 统计。'] : []),
      ...(routeSettings.mode === 'local_gateway' && !routeSettings.failoverEnabled ? ['故障转移当前未启用。'] : []),
      ...(!restoreAvailable ? ['未找到恢复脚本。'] : []),
    ],
  };
  if (gatewayStatus.currentProviderId) report.currentProviderId = gatewayStatus.currentProviderId;
  if (gatewayStatus.currentProviderName) report.currentProviderName = gatewayStatus.currentProviderName;
  if (gatewayStatus.currentModel) report.currentModel = gatewayStatus.currentModel;
  if (gatewayStatus.directSessionTarget) report.directSessionTarget = gatewayStatus.directSessionTarget;
  return report;
}

function healthStatusText(
  routeSettings: RouteSettings,
  gatewayStatus: GatewayStatus,
  codexUsesGateway: boolean,
  restoreAvailable: boolean,
): string {
  if (routeSettings.mode === 'direct_provider' && routeSettings.enabled && restoreAvailable) return '正常 · 直连供应商';
  if (routeSettings.enabled && gatewayStatus.running && codexUsesGateway && restoreAvailable) return '正常 · 运行正常';
  if (routeSettings.enabled && !gatewayStatus.running) return '警告 · 代理未运行';
  if (!routeSettings.enabled && restoreAvailable) return '正常 · 配置可恢复';
  return '警告 · 需要检查配置';
}

async function resyncCodexConfig(): Promise<DiagnosticsReport> {
  await syncCodexForCurrentMode();
  return readDiagnosticsReport();
}

async function stopGatewayAndRestoreCodex(): Promise<DiagnosticsReport> {
  await stopGateway({ restoreManagedBackup: true });
  return readDiagnosticsReport();
}

async function prepareDiagnosticsUninstall(): Promise<DiagnosticsReport> {
  await stopGatewayAndRestoreCodex();
  await getAppSettingsStore().setBoolean('routeEnabled', false);
  await getAppSettingsStore().setBoolean('routeAutoStart', false);
  await getAppSettingsStore().setBoolean('routeDisabledExplicitly', true);
  return readDiagnosticsReport();
}

async function openRestoreScriptDirectory(): Promise<void> {
  shell.showItemInFolder(restoreScriptFilePath());
}

async function copyDiagnosticsReport(): Promise<void> {
  const report = await readDiagnosticsReport();
  clipboard.writeText(diagnosticsReportText(report));
}

function diagnosticsReportText(report: DiagnosticsReport): string {
  return [
    'Codex Key Switcher 诊断信息',
    `应用版本：${report.appVersion}`,
    `健康状态：${report.healthStatus}`,
    `连接模式：${connectionModeLabel(report.connectionMode)}`,
    `本地路由：${report.routeEnabled ? '已启用' : '已停用'}`,
    `代理服务：${report.gatewayRunning ? '运行中' : '未运行'}`,
    `代理地址：${report.endpoint}`,
    `Codex 指向代理：${report.codexUsesGateway ? '是' : '否'}`,
    `恢复备份：${report.restoreAvailable ? '可用' : '不可用'}`,
    `当前供应商：${report.currentProviderName ?? '未选择'}`,
    `当前模型：${report.currentModel ?? '未选择'}`,
    `直连Session：${report.directSessionTarget ? directSessionSummary(report.directSessionTarget) : '未应用'}`,
    `Codex 目录：${report.codexDirectory}`,
    `恢复脚本：${report.restoreScriptPath}`,
    `问题：${report.issues.length ? report.issues.join('；') : '无'}`,
  ].join('\n');
}

function directSessionSummary(target: DirectSessionTarget): string {
  return `${target.providerName} / ${target.displayModel} (${target.modelName}) @ ${target.baseURL}`;
}

async function getStartupSettings(): Promise<AppStartupSettings> {
  const settings = app.getLoginItemSettings();
  const appSettings = getAppSettingsStore();
  const storedOpenAsHidden = await appSettings.getBoolean('startupOpenAsHidden');
  const openAsHidden = process.platform === 'darwin'
    ? (storedOpenAsHidden ?? Boolean(settings.openAsHidden))
    : false;

  return {
    supported: process.platform === 'darwin' || process.platform === 'win32',
    openAtLogin: settings.openAtLogin,
    openAsHidden,
    wasOpenedAtLogin: settings.wasOpenedAtLogin,
    status: settings.status || (settings.executableWillLaunchAtLogin ? 'enabled' : 'not-registered'),
    platform: startupPlatform(),
  };
}

async function saveStartupSettings(input: Pick<AppStartupSettings, 'openAtLogin' | 'openAsHidden'>): Promise<AppStartupSettings> {
  const openAtLogin = Boolean(input.openAtLogin);
  const openAsHidden = process.platform === 'darwin' ? Boolean(input.openAsHidden) : false;

  if (process.platform === 'darwin' || process.platform === 'win32') {
    app.setLoginItemSettings({
      openAtLogin,
      openAsHidden,
      path: process.execPath,
    });
  }

  const appSettings = getAppSettingsStore();
  await appSettings.setBoolean('startupOpenAsHidden', openAsHidden);
  return getStartupSettings();
}

function startupPlatform(): AppStartupSettings['platform'] {
  if (process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux') {
    return process.platform;
  }
  return 'other';
}

async function checkForAppUpdates(): Promise<AppUpdateInfo> {
  const currentVersion = app.getVersion();
  const platform = updatePlatformKey();

  if (platform === 'unsupported') {
    return {
      currentVersion,
      platform,
      status: 'unsupported-platform',
      errorMessage: `当前平台暂未提供安装包：${process.platform}-${process.arch}`,
    };
  }

  try {
    const release = await fetchLatestReleaseInfo(currentVersion);
    if (!release || !release.version) {
      return {
        currentVersion,
        platform,
        status: 'not-configured',
        errorMessage: '最新 Release 缺少有效版本号。',
      };
    }

    return updateInfoFromRelease(release, currentVersion, platform);
  } catch (error) {
    return {
      currentVersion,
      platform,
      status: 'error',
      errorMessage: error instanceof Error ? error.message : '检查更新失败。',
    };
  }
}

async function fetchLatestReleaseInfo(currentVersion: string): Promise<GitHubReleaseInfo | null> {
  const apiResponse = await fetch(releaseApiUrl, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': `Codex-Key-Switcher/${currentVersion}`,
    },
  });

  if (apiResponse.ok) return normalizeGitHubRelease(await apiResponse.json());
  if (apiResponse.status === 404) return null;

  const apiError = await githubErrorMessage(apiResponse);
  const fallback = await fetchLatestReleaseFromPage(currentVersion).catch(() => null);
  if (fallback) return fallback;
  throw new Error(apiError || `检查更新失败：GitHub 返回 ${apiResponse.status}`);
}

async function fetchLatestReleaseFromPage(currentVersion: string): Promise<GitHubReleaseInfo | null> {
  const response = await fetch(releaseLatestPageUrl, {
    headers: {
      Accept: 'text/html',
      'User-Agent': `Codex-Key-Switcher/${currentVersion}`,
    },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub Releases 页面返回 ${response.status}`);

  const html = await response.text();
  const responseUrl = response.url || releaseLatestPageUrl;
  const tagName = releaseTagFromUrl(responseUrl) || releaseTagFromHtml(html);
  if (!tagName) return null;
  const assets = releaseAssetsFromHtml(html);
  return {
    tagName,
    name: tagName,
    version: normalizeReleaseVersion(tagName),
    htmlUrl: tagName ? `${releaseBaseUrl}/releases/tag/${encodeURIComponent(tagName)}` : releaseLatestPageUrl,
    assets,
  };
}

function updateInfoFromRelease(release: GitHubReleaseInfo, currentVersion: string, platform: AppUpdatePlatformKey): AppUpdateInfo {
  const asset = selectUpdateAsset(release.assets, platform);
  const result: AppUpdateInfo = {
    currentVersion,
    platform,
    latestVersion: release.version,
    releaseName: release.name || release.tagName,
    status: compareVersions(release.version, currentVersion) > 0 ? 'available' : 'not-available',
  };
  if (release.htmlUrl) result.releaseNotesUrl = release.htmlUrl;
  if (release.publishedAt) result.publishedAt = release.publishedAt;

  if (asset) {
    result.assetName = asset.name;
    result.downloadUrl = asset.browserDownloadUrl;
  } else if (result.status === 'available') {
    result.status = 'not-configured';
    result.errorMessage = `最新版本没有匹配当前平台的安装包：${platform}`;
  }

  return result;
}

async function openUpdateDownload(downloadUrl: string): Promise<void> {
  if (!isAllowedReleaseUrl(downloadUrl)) {
    throw new Error('地址不属于当前项目的 GitHub Releases。');
  }
  await shell.openExternal(downloadUrl);
}

function updatePlatformKey(): AppUpdatePlatformKey {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-arm64';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'darwin-x64';
  if (process.platform === 'win32' && process.arch === 'x64') return 'win32-x64';
  return 'unsupported';
}

interface GitHubReleaseAsset {
  name: string;
  browserDownloadUrl: string;
}

interface GitHubReleaseInfo {
  tagName: string;
  name: string;
  version: string;
  htmlUrl?: string;
  publishedAt?: string;
  assets: GitHubReleaseAsset[];
}

function normalizeGitHubRelease(value: unknown): GitHubReleaseInfo | null {
  if (!isRecord(value)) return null;
  const tagName = stringValue(value.tag_name);
  const name = stringValue(value.name);
  const version = normalizeReleaseVersion(tagName || name);
  const assets = Array.isArray(value.assets)
    ? value.assets
      .filter(isRecord)
      .map((asset) => ({
        name: stringValue(asset.name),
        browserDownloadUrl: stringValue(asset.browser_download_url),
      }))
      .filter((asset) => asset.name && asset.browserDownloadUrl)
    : [];

  const release: GitHubReleaseInfo = {
    tagName,
    name,
    version,
    assets,
  };
  const htmlUrl = stringValue(value.html_url);
  const publishedAt = stringValue(value.published_at);
  if (htmlUrl) release.htmlUrl = htmlUrl;
  if (publishedAt) release.publishedAt = publishedAt;
  return release;
}

async function githubErrorMessage(response: Response): Promise<string> {
  const fallback = `检查更新失败：GitHub 返回 ${response.status}`;
  try {
    const payload = await response.json() as unknown;
    if (!isRecord(payload)) return fallback;
    const message = stringValue(payload.message);
    return message ? `${fallback}：${message}` : fallback;
  } catch {
    return fallback;
  }
}

function releaseTagFromUrl(value: string): string {
  try {
    const parsed = new URL(value);
    const match = parsed.pathname.match(/\/releases\/tag\/([^/?#]+)/);
    return match?.[1] ? decodeURIComponent(match[1]) : '';
  } catch {
    return '';
  }
}

function releaseTagFromHtml(html: string): string {
  const match = html.match(/\/lzwei60\/codex-key-switcher\/releases\/tag\/([^"?#]+)/);
  return match?.[1] ? decodeHtmlText(decodeURIComponent(match[1])) : '';
}

function releaseAssetsFromHtml(html: string): GitHubReleaseAsset[] {
  const assets = new Map<string, GitHubReleaseAsset>();
  const linkPattern = /href="([^"]*\/lzwei60\/codex-key-switcher\/releases\/download\/[^"]+)"/g;
  for (const match of html.matchAll(linkPattern)) {
    const href = decodeHtmlText(match[1] ?? '');
    const url = absoluteGitHubUrl(href);
    if (!url) continue;
    const name = releaseAssetNameFromUrl(url);
    if (name) assets.set(url, { name, browserDownloadUrl: url });
  }
  return [...assets.values()];
}

function absoluteGitHubUrl(href: string): string {
  try {
    return new URL(href, releaseBaseUrl).toString();
  } catch {
    return '';
  }
}

function releaseAssetNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/');
    return decodeURIComponent(parts.at(-1) ?? '').trim();
  } catch {
    return '';
  }
}

function decodeHtmlText(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function selectUpdateAsset(assets: GitHubReleaseAsset[], platform: AppUpdatePlatformKey): GitHubReleaseAsset | null {
  if (platform === 'unsupported') return null;
  const candidates = assets.filter((asset) => {
    const name = asset.name.toLowerCase();
    if (platform === 'darwin-arm64') return name.endsWith('.dmg') && (name.includes('arm64') || name.includes('aarch64'));
    if (platform === 'darwin-x64') return name.endsWith('.dmg') && (name.includes('x64') || name.includes('intel') || name.includes('x86_64'));
    if (platform === 'win32-x64') return name.endsWith('.exe') && (name.includes('x64') || name.includes('x86_64'));
    return false;
  });

  return candidates[0] ?? null;
}

function compareVersions(left: string, right: string): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  const maxLength = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < maxLength; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function versionParts(version: string): number[] {
  return normalizeReleaseVersion(version)
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((part) => Number.isFinite(part) ? part : 0);
}

function normalizeReleaseVersion(value: string): string {
  return value.trim().replace(/^v/i, '').split(/[+-]/)[0] || '0.0.0';
}

function isAllowedReleaseUrl(downloadUrl: string): boolean {
  try {
    const parsed = new URL(downloadUrl);
    return parsed.protocol === 'https:'
      && parsed.hostname === 'github.com'
      && (
        parsed.pathname === '/lzwei60/codex-key-switcher/releases'
        || parsed.pathname.startsWith('/lzwei60/codex-key-switcher/releases/')
      );
  } catch {
    return false;
  }
}

async function getAppPreferences(): Promise<AppPreferences> {
  const settings = getAppSettingsStore();
  return {
    language: normalizeAppLanguage(await settings.getString('appLanguage')),
    theme: normalizeAppTheme(await settings.getString('appTheme')),
  };
}

async function saveAppPreferences(input: AppPreferences): Promise<AppPreferences> {
  const preferences: AppPreferences = {
    language: normalizeAppLanguage(input.language),
    theme: normalizeAppTheme(input.theme),
  };
  const settings = getAppSettingsStore();
  await settings.setString('appLanguage', preferences.language);
  await settings.setString('appTheme', preferences.theme);
  return preferences;
}

async function getUsageSettings(): Promise<UsageSettings> {
  const raw = await getAppSettingsStore().getString('usageSettings');
  if (!raw) return { ...defaultUsageSettings };
  try {
    return normalizeUsageSettings(JSON.parse(raw));
  } catch {
    return { ...defaultUsageSettings };
  }
}

async function saveUsageSettings(input: UsageSettings): Promise<UsageSettings> {
  const settings = normalizeUsageSettings(input);
  await getAppSettingsStore().setString('usageSettings', JSON.stringify(settings));
  return settings;
}

function normalizeUsageSettings(value: unknown): UsageSettings {
  const settings = value && typeof value === 'object' ? value as Partial<UsageSettings> : {};
  return {
    enabled: typeof settings.enabled === 'boolean' ? settings.enabled : defaultUsageSettings.enabled,
    retentionDays: normalizeUsageSettingInteger(settings.retentionDays, 1, 365, defaultUsageSettings.retentionDays),
    maxRecords: normalizeUsageSettingInteger(settings.maxRecords, 100, 100_000, defaultUsageSettings.maxRecords),
  };
}

function normalizeUsageSettingInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function normalizeAppLanguage(value: string | null | undefined): AppPreferences['language'] {
  return value === 'en' ? 'en' : 'zh-Hans';
}

function normalizeAppTheme(value: string | null | undefined): AppPreferences['theme'] {
  if (value === 'light' || value === 'dark' || value === 'system') return value;
  return 'system';
}

async function getCodexConfigDirectorySettings(): Promise<CodexConfigDirectorySettings> {
  const defaultDirectory = defaultCodexConfigDirectory();
  const storedDirectory = await getAppSettingsStore().getString('codexConfigDir');
  const directory = storedDirectory || defaultDirectory;
  return {
    directory,
    isDefault: directory === defaultDirectory,
  };
}

async function saveCodexConfigDirectory(directory: string): Promise<CodexConfigDirectorySettings> {
  const previous = await getCodexConfigDirectorySettings();
  const normalized = normalizeCodexConfigDirectory(directory);
  if (normalized === previous.directory) {
    await ensureCodexConfigFiles(normalized);
    return getCodexConfigDirectorySettings();
  }

  const routeSettings = await getRouteSettings();
  if (routeSettings.enabled) {
    await getCodexConfigService().restoreManagedBackupForDirectory(previous.directory);
  }

  await getAppSettingsStore().setString('codexConfigDir', normalized);
  try {
    await ensureCodexConfigFiles(normalized);
    if (routeSettings.enabled) {
      await syncCodexForCurrentMode();
    }
  } catch (error) {
    await getAppSettingsStore().setString('codexConfigDir', previous.directory);
    if (routeSettings.enabled) {
      await syncCodexForCurrentMode().catch(() => undefined);
    }
    throw error;
  }

  return getCodexConfigDirectorySettings();
}

function restoreScriptFilePath(): string {
  const extension = process.platform === 'win32' ? 'cmd' : 'command';
  return path.join(app.getPath('userData'), `restore-codex-config.${extension}`);
}

async function chooseCodexConfigDirectory(): Promise<CodexConfigDirectorySettings | null> {
  const window = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined;
  const current = await getCodexConfigDirectorySettings();
  const result = window
    ? await dialog.showOpenDialog(window, {
        title: '选择 Codex 配置目录',
        defaultPath: current.directory,
        properties: ['openDirectory', 'createDirectory'],
      })
    : await dialog.showOpenDialog({
        title: '选择 Codex 配置目录',
        defaultPath: current.directory,
        properties: ['openDirectory', 'createDirectory'],
      });

  if (result.canceled || !result.filePaths[0]) return null;
  return saveCodexConfigDirectory(result.filePaths[0]);
}

function normalizeCodexConfigDirectory(directory: string): string {
  const trimmed = directory.trim();
  if (!trimmed) return defaultCodexConfigDirectory();
  if (trimmed === '~/.codex') return defaultCodexConfigDirectory();
  if (trimmed.startsWith('~/')) return path.join(app.getPath('home'), trimmed.slice(2));
  return path.resolve(trimmed);
}

function defaultCodexConfigDirectory(): string {
  return path.join(app.getPath('home'), '.codex');
}

async function ensureCodexConfigFiles(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const configPath = path.join(directory, 'config.toml');
  const authPath = path.join(directory, 'auth.json');
  if (!await fileExists(configPath)) await fs.writeFile(configPath, '', 'utf8');
  if (!await fileExists(authPath)) await fs.writeFile(authPath, '{}\n', 'utf8');
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.hide();
  getProviderService();
  getCodexConfigService();
  getUsageService();
  await getUsageService().configure(await getUsageSettings());
  getLocalGatewayRuntime();
  registerIpcHandlers();
  const routeSettings = await getRouteSettings();
  if (routeSettings.enabled && routeSettings.autoStart) {
    await applyEnabledConnectionMode(routeSettings).catch((error) => {
      console.error('Failed to auto-apply connection mode:', error);
      return refreshGatewayStatus();
    });
  } else {
    await refreshGatewayStatus();
  }
  createTray();
  const startupSettings = await getStartupSettings();
  if (!(startupSettings.wasOpenedAtLogin && startupSettings.openAsHidden)) {
    await createWindow();
  }
});

app.on('window-all-closed', () => {
  // The app is tray-first: closing the window hides it, explicit quit exits.
});

app.on('before-quit', (event) => {
  if (isQuitting) return;
  event.preventDefault();
  void quitApplication();
});

async function quitApplication(): Promise<void> {
  if (quitFlowStarted) return;
  quitFlowStarted = true;

  const result = await stopGatewayForQuit();
  await getUsageService().flush().catch((error) => {
    console.error('Failed to flush usage records before quit:', error);
  });
  await showQuitRestoreMessage(result);

  isQuitting = true;
  app.quit();
}

async function stopGatewayForQuit(): Promise<{ mode: ConnectionMode; restored: boolean; error: string | null }> {
  try {
    const routeSettings = await getRouteSettings();
    if (!routeSettings.enabled) {
      await getLocalGatewayRuntime().stop().catch(() => undefined);
      if (routeSettings.mode === 'direct_provider') await clearDirectSessionTarget();
      gatewayStatusCache = await currentConnectionStatus(routeSettings);
      return { mode: routeSettings.mode, restored: false, error: null };
    }

    const restoreManagedBackup = true;
    await stopGateway({ strictRestore: restoreManagedBackup, restoreManagedBackup, persistDisabled: false });
    return { mode: routeSettings.mode, restored: restoreManagedBackup, error: null };
  } catch (error) {
    await getLocalGatewayRuntime().stop().catch(() => undefined);
    return {
      mode: 'local_gateway',
      restored: false,
      error: error instanceof Error ? error.message : '恢复 Codex 配置失败。',
    };
  }
}

async function showQuitRestoreMessage(result: { mode: ConnectionMode; restored: boolean; error: string | null }): Promise<void> {
  const options: MessageBoxOptions = result.error
    ? {
        type: 'warning',
        title: '退出 Codex Key Switcher',
        message: '连接服务已停止，但 Codex 配置恢复失败。',
        detail: `${result.error}\n\n请到“诊断”页面执行恢复，或手动运行恢复脚本。恢复完成后需要重启 Codex 或打开新会话。`,
        buttons: ['知道了'],
        defaultId: 0,
        noLink: true,
      }
    : {
        type: 'info',
        title: '退出 Codex Key Switcher',
        message: result.restored ? '连接服务已停止，Codex 配置已恢复。' : '连接服务已停止，Codex 配置无需恢复。',
        detail: '为了让 Codex 重新读取恢复后的配置，请重启 Codex。',
        buttons: ['知道了'],
        defaultId: 0,
        noLink: true,
      };

  await dialog.showMessageBox(options).catch(() => undefined);
}

function defaultRouteSettings(): RouteSettings {
  return {
    mode: 'local_gateway',
    enabled: true,
    autoStart: true,
    disabledExplicitly: false,
    listenAddress: '127.0.0.1',
    listenPort: 3456,
    allowLANListen: false,
    failoverEnabled: false,
  };
}

async function getRouteSettings(): Promise<RouteSettings> {
  const settings = getAppSettingsStore();
  const defaults = defaultRouteSettings();
  return {
    mode: normalizeConnectionMode(await settings.getString('routeConnectionMode')),
    enabled: await settings.getBoolean('routeEnabled') ?? defaults.enabled,
    autoStart: await settings.getBoolean('routeAutoStart') ?? defaults.autoStart,
    disabledExplicitly: await settings.getBoolean('routeDisabledExplicitly') ?? defaults.disabledExplicitly,
    listenAddress: await settings.getString('routeListenAddress') ?? defaults.listenAddress,
    listenPort: safeRoutePort(await settings.getNumber('routeListenPort') ?? defaults.listenPort),
    allowLANListen: await settings.getBoolean('routeAllowLANListen') ?? defaults.allowLANListen,
    failoverEnabled: await settings.getBoolean('routeFailoverEnabled') ?? defaults.failoverEnabled,
  };
}

async function saveRouteSettings(input: RouteSettings): Promise<RouteSettingsSaveResult> {
  const previousSettings = await getRouteSettings();
  const normalized = normalizeRouteSettings(input);
  const changePlan = planRouteSettingsChange(previousSettings, normalized);
  if (!await confirmConnectionModeSwitch(previousSettings.mode, normalized.mode)) {
    return {
      settings: previousSettings,
      changed: false,
      cancelled: true,
    };
  }

  if (!changePlan.enabledChanged && !changePlan.connectionModeChanged && !changePlan.localGatewayRuntimeChanged && !changePlan.codexConfigChanged) {
    await persistRouteSettings(normalized);
    gatewayStatusCache = await currentConnectionStatus(normalized);
    createTray();
  } else if (!normalized.enabled) {
    await stopConnectionForMode(previousSettings.mode, { strictRestore: true, restoreManagedBackup: true });
    if (previousSettings.mode === 'direct_provider') await clearDirectSessionTarget();
    await persistRouteSettings(normalized);
    gatewayStatusCache = await currentConnectionStatus(normalized);
    createTray();
  } else if (normalized.mode === 'direct_provider') {
    await assertCurrentProviderSupportsDirectMode();
    await stopConnectionForMode(previousSettings.mode, {
      strictRestore: previousSettings.mode === 'local_gateway',
      restoreManagedBackup: previousSettings.mode === 'local_gateway',
    });
    await persistRouteSettings(normalized);
    if (changePlan.codexConfigChanged) await syncCodexDirectProviderConfig();
    gatewayStatusCache = await currentConnectionStatus(normalized);
    createTray();
  } else if (previousSettings.mode === 'direct_provider') {
    await persistRouteSettings(normalized);
    if (changePlan.localGatewayRuntimeChanged || !gatewayStatusCache.running) await startLocalGatewayWithSettings(normalized);
    if (changePlan.codexConfigChanged) await syncCodexLocalGatewayConfig(gatewayStatusCache);
  } else if (changePlan.localGatewayRuntimeChanged || !gatewayStatusCache.running) {
    await startLocalGatewayWithSettings(normalized);
    await persistRouteSettings(normalized);
    if (changePlan.codexConfigChanged) await syncCodexLocalGatewayConfig(gatewayStatusCache);
  } else {
    await persistRouteSettings(normalized);
    if (gatewayStatusCache.running) gatewayStatusCache = await getLocalGatewayRuntime().status();
    gatewayStatusCache = {
      ...gatewayStatusCache,
      mode: normalized.mode,
    };
    createTray();
  }

  return {
    settings: normalized,
    changed: changePlan.changed,
    cancelled: false,
  };
}

async function persistRouteSettings(settingsValue: RouteSettings): Promise<void> {
  const settings = getAppSettingsStore();
  await settings.setString('routeConnectionMode', settingsValue.mode);
  await settings.setBoolean('routeEnabled', settingsValue.enabled);
  await settings.setBoolean('routeAutoStart', settingsValue.autoStart);
  await settings.setBoolean('routeDisabledExplicitly', settingsValue.disabledExplicitly);
  await settings.setString('routeListenAddress', settingsValue.listenAddress);
  await settings.setNumber('routeListenPort', settingsValue.listenPort);
  await settings.setBoolean('routeAllowLANListen', settingsValue.allowLANListen);
  await settings.setBoolean('routeFailoverEnabled', settingsValue.failoverEnabled);
}

function normalizeRouteSettings(input: RouteSettings): RouteSettings {
  const defaults = defaultRouteSettings();
  const listenAddress = input.listenAddress?.trim() || defaults.listenAddress;
  const allowLANListen = Boolean(input.allowLANListen);
  return {
    mode: normalizeConnectionMode(input.mode),
    enabled: Boolean(input.enabled),
    autoStart: Boolean(input.autoStart),
    disabledExplicitly: Boolean(input.disabledExplicitly),
    listenAddress: allowLANListen || listenAddress.startsWith('127.') ? listenAddress : defaults.listenAddress,
    listenPort: safeRoutePort(input.listenPort),
    allowLANListen,
    failoverEnabled: Boolean(input.failoverEnabled),
  };
}

function normalizeConnectionMode(mode: string | null | undefined): ConnectionMode {
  return mode === 'direct_provider' ? 'direct_provider' : 'local_gateway';
}

async function assertProviderSaveSupportsCurrentMode(input: ProviderInput, providers: Provider[]): Promise<void> {
  const routeSettings = await getRouteSettings();
  if (!routeSettings.enabled || routeSettings.mode !== 'direct_provider' || input.apiFormat === 'responses') return;

  const currentProvider = await getProviderService().current();
  const inputId = input.id?.trim();
  const editsCurrentProvider = Boolean(inputId && currentProvider?.id === inputId);
  const becomesFirstCurrentProvider = !providers.length && !inputId;
  if (!editsCurrentProvider && !becomesFirstCurrentProvider) return;

  throw new Error('直连供应商模式仅支持 Responses 格式供应商；当前配置请先切换到本地路由模式，或保持 Responses 格式。');
}

async function assertCurrentProviderSupportsDirectMode(): Promise<void> {
  const currentProvider = await getProviderService().current();
  if (!currentProvider) throw new Error('请先添加并选择一个供应商，再启用直连供应商模式。');
  await assertProviderSupportsDirectMode(currentProvider);
}

async function assertProviderSupportsDirectMode(provider: Provider): Promise<void> {
  if (provider.apiFormat !== 'responses') {
    throw new Error('直连供应商模式仅支持 Responses 格式供应商；Chat Completions 和 Anthropic 请使用本地路由模式。');
  }
  const apiKey = await getProviderService().currentApiKey(provider);
  if (!apiKey) throw new Error('当前供应商缺少本地 API Key，无法启用直连供应商模式。');
}

function safeRoutePort(port: number): number {
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : defaultRouteSettings().listenPort;
}

async function checkRoutePort(input: Pick<RouteSettings, 'listenAddress' | 'listenPort' | 'allowLANListen'>): Promise<PortCheckResult> {
  const normalized = normalizeRouteSettings({
    ...defaultRouteSettings(),
    listenAddress: input.listenAddress,
    listenPort: input.listenPort,
    allowLANListen: input.allowLANListen,
  });

  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;

    function finish(result: PortCheckResult): void {
      if (settled) return;
      settled = true;
      if (server.listening) {
        server.close(() => resolve(result));
      } else {
        resolve(result);
      }
    }

    server.once('error', (error: NodeJS.ErrnoException) => {
      const unavailable = error.code === 'EADDRINUSE'
        ? `端口 ${normalized.listenPort} 已被占用。`
        : error.message || '端口检测失败。';
      finish({
        available: false,
        listenAddress: normalized.listenAddress,
        listenPort: normalized.listenPort,
        message: unavailable,
      });
    });

    server.listen(normalized.listenPort, normalized.listenAddress, () => {
      finish({
        available: true,
        listenAddress: normalized.listenAddress,
        listenPort: normalized.listenPort,
        message: `端口 ${normalized.listenPort} 可用。`,
      });
    });
  });
}

function getAppSettingsStore(): AppSettingsStore {
  if (!appSettingsStore) appSettingsStore = new AppSettingsStore(app.getPath('userData'));
  return appSettingsStore;
}

function getCredentialStore(): CredentialFileStore {
  if (!credentialStore) credentialStore = new CredentialFileStore(app.getPath('userData'));
  return credentialStore;
}

function createProviderService(): ProviderService {
  const dataDirectory = app.getPath('userData');
  return new ProviderService(
    new ProviderFileRepository(dataDirectory),
    getCredentialStore(),
  );
}

function getProviderService(): ProviderService {
  if (!providerService) providerService = createProviderService();
  return providerService;
}

function createCodexConfigService(): CodexConfigService {
  const dataDirectory = app.getPath('userData');
  return new CodexConfigService(
    new CodexFileConfigAdapter(getAppSettingsStore(), app.getPath('home'), dataDirectory),
  );
}

function getCodexConfigService(): CodexConfigService {
  if (!codexConfigService) codexConfigService = createCodexConfigService();
  return codexConfigService;
}

function createUsageService(): UsageService {
  return new UsageService(new UsageFileRepository(app.getPath('userData')));
}

function getUsageService(): UsageService {
  if (!usageService) usageService = createUsageService();
  return usageService;
}

function getLocalGatewayRuntime(): LocalGatewayRuntime {
  if (!localGatewayRuntime) {
    localGatewayRuntime = new LocalGatewayRuntime(
      getProviderService(),
      getCodexConfigService(),
      getUsageService(),
    );
  }
  return localGatewayRuntime;
}

async function refreshGatewayStatus(): Promise<GatewayStatus> {
  gatewayStatusCache = await currentConnectionStatus(await getRouteSettings());
  createTray();
  return gatewayStatusCache;
}

async function startGateway(): Promise<GatewayStatus> {
  const requestedSettings = await getRouteSettings();
  if (requestedSettings.mode === 'direct_provider') {
    const enabledSettings = requestedSettings.enabled
      ? requestedSettings
      : (await saveRouteSettings({
          ...requestedSettings,
          enabled: true,
          disabledExplicitly: false,
        })).settings;
    await getLocalGatewayRuntime().stop().catch(() => undefined);
    await syncCodexDirectProviderConfig();
    gatewayStatusCache = await currentConnectionStatus(enabledSettings);
    createTray();
    return gatewayStatusCache;
  }

  const routeSettings = await getRouteSettings();
  if (!routeSettings.enabled) {
    await saveRouteSettings({
      ...routeSettings,
      enabled: true,
      disabledExplicitly: false,
    });
  }
  return startLocalGatewayWithCurrentSettings();
}

async function applyEnabledConnectionMode(routeSettings: RouteSettings): Promise<GatewayStatus> {
  if (!routeSettings.enabled) return refreshGatewayStatus();
  if (routeSettings.mode === 'direct_provider') {
    await getLocalGatewayRuntime().stop().catch(() => undefined);
    await syncCodexDirectProviderConfig();
    gatewayStatusCache = await currentConnectionStatus(routeSettings);
    createTray();
    return gatewayStatusCache;
  }
  return startGateway();
}

async function stopGateway(options: { strictRestore?: boolean; restoreManagedBackup?: boolean; persistDisabled?: boolean } = {}): Promise<GatewayStatus> {
  const previousSettings = await getRouteSettings();
  const shouldRestoreBackup = options.restoreManagedBackup ?? true;
  const shouldPersistDisabled = options.persistDisabled ?? true;
  const stopOptions: { strictRestore?: boolean; restoreManagedBackup?: boolean } = {
    restoreManagedBackup: shouldRestoreBackup,
  };
  if (options.strictRestore !== undefined) stopOptions.strictRestore = options.strictRestore;
  else stopOptions.strictRestore = shouldRestoreBackup;
  await stopConnectionForMode(previousSettings.mode, stopOptions);
  const stoppedSettings = shouldPersistDisabled
    ? {
        ...previousSettings,
        enabled: false,
        disabledExplicitly: true,
      }
    : previousSettings;
  if (shouldPersistDisabled) await persistRouteSettings(stoppedSettings);
  if (previousSettings.mode === 'direct_provider') await clearDirectSessionTarget();
  gatewayStatusCache = await currentConnectionStatus(stoppedSettings);
  createTray();
  return gatewayStatusCache;
}

async function stopConnectionForMode(
  mode: ConnectionMode,
  options: { strictRestore?: boolean; restoreManagedBackup?: boolean } = {},
): Promise<void> {
  await getLocalGatewayRuntime().stop().catch((error) => {
    console.warn('Failed to stop local gateway runtime:', error);
  });
  const shouldRestoreBackup = options.restoreManagedBackup ?? true;
  if (shouldRestoreBackup) {
    try {
      await getCodexConfigService().restoreManagedBackup();
    } catch (error) {
      console.warn('Failed to restore Codex config backup:', error);
      if (options.strictRestore) throw error;
    }
  }
}

async function startLocalGatewayWithCurrentSettings(): Promise<GatewayStatus> {
  const routeSettings = await getRouteSettings();
  await startLocalGatewayWithSettings(routeSettings);
  await syncCodexLocalGatewayConfig(gatewayStatusCache);
  createTray();
  return gatewayStatusCache;
}

async function startLocalGatewayWithSettings(routeSettings: RouteSettings): Promise<GatewayStatus> {
  gatewayStatusCache = await getLocalGatewayRuntime().start(routeSettings);
  createTray();
  return gatewayStatusCache;
}

async function syncCodexForCurrentMode(): Promise<void> {
  const routeSettings = await getRouteSettings();
  if (!routeSettings.enabled) return;
  if (routeSettings.mode === 'direct_provider') {
    await getLocalGatewayRuntime().stop().catch(() => undefined);
    await syncCodexDirectProviderConfig();
    gatewayStatusCache = await currentConnectionStatus(routeSettings);
    createTray();
    return;
  }

  if (gatewayStatusCache.running) {
    gatewayStatusCache = await getLocalGatewayRuntime().status();
    await syncCodexLocalGatewayConfig(gatewayStatusCache);
    createTray();
    return;
  }

  const currentProvider = await getProviderService().current();
  if (!currentProvider) return;

  const codex = getCodexConfigService();
  const model = providerSelectedUpstreamModel(currentProvider);
  await codex.applyLocalGateway({
    endpoint: endpointForRouteSettings(routeSettings),
    localApiKey: await codex.localGatewayAPIKey(),
    model,
  });
}

async function syncCodexDirectProviderConfig(): Promise<void> {
  const currentProvider = await getProviderService().current();
  if (!currentProvider) return;
  // Direct mode bypasses the gateway, so Codex can only use providers that natively accept Responses requests.
  if (currentProvider.apiFormat !== 'responses') {
    throw new Error('直连供应商模式第一版仅支持 Responses 格式供应商；Chat Completions 和 Anthropic 请继续使用本地路由模式。');
  }

  const apiKey = await getProviderService().currentApiKey(currentProvider);
  if (!apiKey) throw new Error('当前供应商缺少本地 API Key，无法写入直连配置。');

  const codex = getCodexConfigService();
  const selectedModel = providerSelectedModel(currentProvider);
  const upstreamModel = selectedModel?.model.trim() || currentProvider.selectedModel;
  await codex.applyDirectProvider({
    baseURL: currentProvider.baseURL,
    apiKey,
    model: upstreamModel,
  });
  await saveDirectSessionTarget(directSessionTargetForProvider(currentProvider));
}

async function syncCodexLocalGatewayConfig(status: GatewayStatus): Promise<void> {
  const currentProvider = await getProviderService().current();
  if (!currentProvider) return;

  const codex = getCodexConfigService();
  const model = providerSelectedUpstreamModel(currentProvider);
  const localApiKey = await codex.localGatewayAPIKey();
  await codex.applyLocalGateway({
    endpoint: status.endpoint,
    localApiKey,
    model,
  });
}

async function currentConnectionStatus(routeSettings: RouteSettings): Promise<GatewayStatus> {
  const provider = await getProviderService().current();
  if (routeSettings.mode === 'direct_provider') {
    const directSessionTarget = await getDirectSessionTarget();
    const status: GatewayStatus = {
      running: false,
      mode: routeSettings.mode,
      endpoint: directSessionTarget?.baseURL ?? provider?.baseURL ?? '未选择供应商',
    };
    if (directSessionTarget) {
      status.currentProviderId = directSessionTarget.providerId;
      status.currentProviderName = directSessionTarget.providerName;
      status.currentModel = directSessionTarget.displayModel;
      status.directSessionTarget = directSessionTarget;
    } else if (provider) {
      status.currentProviderId = provider.id;
      status.currentProviderName = provider.name;
      status.currentModel = providerSelectedDisplayModel(provider);
    }
    return status;
  }

  const status = await getLocalGatewayRuntime().status();
  return {
    ...status,
    mode: routeSettings.mode,
  };
}

async function getDirectSessionTarget(): Promise<DirectSessionTarget | null> {
  const raw = await getAppSettingsStore().getString(directSessionTargetKey);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DirectSessionTarget>;
    if (
      typeof parsed.id !== 'string'
      || typeof parsed.providerId !== 'string'
      || typeof parsed.providerName !== 'string'
      || typeof parsed.baseURL !== 'string'
      || typeof parsed.modelName !== 'string'
      || typeof parsed.displayModel !== 'string'
      || typeof parsed.appliedAt !== 'number'
    ) {
      return null;
    }
    return {
      id: parsed.id,
      providerId: parsed.providerId,
      providerName: parsed.providerName,
      baseURL: parsed.baseURL,
      modelName: parsed.modelName,
      displayModel: parsed.displayModel,
      appliedAt: parsed.appliedAt,
    };
  } catch {
    return null;
  }
}

async function saveDirectSessionTarget(target: DirectSessionTarget): Promise<void> {
  await getAppSettingsStore().setString(directSessionTargetKey, JSON.stringify(target));
}

async function clearDirectSessionTarget(): Promise<void> {
  await getAppSettingsStore().setString(directSessionTargetKey, '');
}

function endpointForRouteSettings(settings: RouteSettings): string {
  const clientHost = settings.listenAddress === '0.0.0.0' ? '127.0.0.1' : settings.listenAddress;
  return `http://${clientHost}:${settings.listenPort}/v1`;
}

function providerSelectedUpstreamModel(provider: Provider): string {
  const selectedModel = providerSelectedModel(provider);
  return selectedModel?.model.trim() || provider.selectedModel || 'gpt-4.1';
}

async function getProviderApiKey(providerId: string): Promise<string> {
  const provider = (await getProviderService().list()).find((item) => item.id === providerId);
  if (!provider) return '';
  return await getProviderService().currentApiKey(provider) ?? '';
}

async function toggleGateway(): Promise<void> {
  const routeSettings = await getRouteSettings();
  if (routeSettings.enabled) {
    await stopGateway();
    notifyConnectionToggle(routeSettings.mode, false);
  } else {
    await startGateway();
    notifyConnectionToggle(routeSettings.mode, true);
  }
}

async function validateProviderInputModels(input: ProviderInput): Promise<void> {
  const baseURL = normalizedValidationBaseURL(input.baseURL, input.apiFormat);
  const models = input.models
    .map((model) => ({
      customName: model.customName.trim(),
      model: model.model.trim(),
    }))
    .filter((model) => model.customName && model.model);

  if (!models.length) throw new Error('至少添加一个模型。');

  for (const model of models) {
    const result = await validateProviderModel({
      baseURL,
      apiFormat: input.apiFormat,
      model,
      ...(input.id?.trim() ? { providerId: input.id.trim() } : {}),
      ...(input.name?.trim() ? { name: input.name.trim() } : {}),
      ...(input.apiKey?.trim() ? { apiKey: input.apiKey.trim() } : {}),
    });
    if (!result.ok) {
      throw new Error(`模型 ${model.model} 检测失败：${result.message}`);
    }
  }
}

async function validateProviderModel(input: ProviderModelValidationInput): Promise<ProviderModelValidationResult> {
  const startedAt = performance.now();
  const upstreamModel = input.model.model.trim();
  const baseURL = normalizedValidationBaseURL(input.baseURL, input.apiFormat);
  const endpoint = validationEndpoint(baseURL, input.apiFormat);

  if (!upstreamModel) {
    return validationFailure(startedAt, endpoint, upstreamModel, '上游模型不能为空。');
  }

  let apiKey = input.apiKey?.trim() ?? '';
  if (!apiKey && input.providerId?.trim()) {
    apiKey = await getProviderApiKey(input.providerId.trim());
  }
  if (!apiKey) {
    return validationFailure(startedAt, endpoint, upstreamModel, '请先填写 API Key，编辑已有配置时也需要本地已保存 Key。');
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return validationFailure(startedAt, endpoint, upstreamModel, 'Base URL 不是有效地址。');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return validationFailure(startedAt, endpoint, upstreamModel, 'Base URL 只支持 http/https 地址。');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: validationHeaders(input.apiFormat, apiKey),
      body: JSON.stringify(validationBody(input.apiFormat, upstreamModel)),
      signal: controller.signal,
    });
    const text = await response.text();
    const responsePreview = compactResponsePreview(text);
    const durationMs = Math.round(performance.now() - startedAt);
    if (response.ok) {
      return {
        ok: true,
        status: response.status,
        durationMs,
        endpoint,
        model: upstreamModel,
        message: `模型 ${upstreamModel} 连通性检测通过。`,
        responsePreview,
      };
    }
    return {
      ok: false,
      status: response.status,
      durationMs,
      endpoint,
      model: upstreamModel,
      message: `上游返回 ${response.status}：${upstreamErrorMessage(text)}`,
      responsePreview,
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return validationFailure(
      startedAt,
      endpoint,
      upstreamModel,
      aborted ? '检测超时，上游 20 秒内未响应。' : error instanceof Error ? error.message : '模型检测请求失败。',
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function listUpstreamModels(input: ProviderModelsListInput): Promise<ProviderModelsListResult> {
  const startedAt = performance.now();
  const baseURL = normalizedValidationBaseURL(input.baseURL, input.apiFormat);
  const endpoint = modelsListEndpoint(baseURL, input.apiFormat);

  let apiKey = input.apiKey?.trim() ?? '';
  if (!apiKey && input.providerId?.trim()) {
    apiKey = await getProviderApiKey(input.providerId.trim());
  }
  if (!apiKey) {
    return modelsListFailure(startedAt, endpoint, '请先填写 API Key，编辑已有配置时也需要本地已保存 Key。');
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return modelsListFailure(startedAt, endpoint, 'Base URL 不是有效地址。');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return modelsListFailure(startedAt, endpoint, 'Base URL 只支持 http/https 地址。');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: modelListHeaders(input.apiFormat, apiKey),
      signal: controller.signal,
    });
    const text = await response.text();
    const responsePreview = compactResponsePreview(text);
    const durationMs = Math.round(performance.now() - startedAt);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        durationMs,
        endpoint,
        models: [],
        message: `上游返回 ${response.status}：${upstreamErrorMessage(text)}`,
        responsePreview,
      };
    }

    const models = modelsFromListResponse(text);
    if (!models.length) {
      return {
        ok: false,
        status: response.status,
        durationMs,
        endpoint,
        models: [],
        message: '上游没有返回可识别的模型列表。',
        responsePreview,
      };
    }

    return {
      ok: true,
      status: response.status,
      durationMs,
      endpoint,
      models,
      message: `已拉取 ${models.length} 个上游模型。`,
      responsePreview,
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return modelsListFailure(
      startedAt,
      endpoint,
      aborted ? '拉取超时，上游 20 秒内未响应。' : error instanceof Error ? error.message : '拉取上游模型列表失败。',
    );
  } finally {
    clearTimeout(timeout);
  }
}

function validationFailure(startedAt: number, endpoint: string, model: string, message: string): ProviderModelValidationResult {
  return {
    ok: false,
    durationMs: Math.round(performance.now() - startedAt),
    endpoint,
    model,
    message,
  };
}

function modelsListFailure(startedAt: number, endpoint: string, message: string): ProviderModelsListResult {
  return {
    ok: false,
    durationMs: Math.round(performance.now() - startedAt),
    endpoint,
    models: [],
    message,
  };
}

function validationEndpoint(baseURL: string, apiFormat: ApiFormat): string {
  const pathByFormat: Record<ApiFormat, string> = {
    responses: '/responses',
    chat_completions: '/chat/completions',
    anthropic_messages: '/messages',
  };
  return `${baseURL}${pathByFormat[apiFormat]}`;
}

function modelsListEndpoint(baseURL: string, apiFormat: ApiFormat): string {
  if (apiFormat === 'anthropic_messages') return `${baseURL}/models`;
  return `${baseURL}/models`;
}

function normalizedValidationBaseURL(baseURL: string, apiFormat: ApiFormat): string {
  const trimmed = baseURL.trim().replace(/\/+$/, '');
  try {
    const url = new URL(trimmed);
    const isDeepSeekOpenAI = apiFormat === 'chat_completions' && url.hostname === 'api.deepseek.com';
    if (isDeepSeekOpenAI && url.pathname.replace(/\/+$/, '') === '/v1') {
      url.pathname = '';
      return url.toString().replace(/\/+$/, '');
    }
  } catch {
    return trimmed;
  }
  return trimmed;
}

function validationHeaders(apiFormat: ApiFormat, apiKey: string): Headers {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (apiFormat === 'anthropic_messages') {
    headers.set('x-api-key', apiKey);
    headers.set('anthropic-version', '2023-06-01');
  } else {
    headers.set('Authorization', `Bearer ${apiKey}`);
  }
  return headers;
}

function modelListHeaders(apiFormat: ApiFormat, apiKey: string): Headers {
  const headers = validationHeaders(apiFormat, apiKey);
  headers.delete('Content-Type');
  return headers;
}

function validationBody(apiFormat: ApiFormat, model: string): Record<string, unknown> {
  if (apiFormat === 'chat_completions') {
    return {
      model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 8,
      stream: false,
    };
  }
  if (apiFormat === 'anthropic_messages') {
    return {
      model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 8,
      stream: false,
    };
  }
  return {
    model,
    input: 'ping',
    max_output_tokens: 8,
    stream: false,
  };
}

function modelsFromListResponse(text: string): ProviderModel[] {
  try {
    const payload = JSON.parse(text) as unknown;
    const candidates = modelIdCandidates(payload);
    return [...new Set(candidates.map((model) => model.trim()).filter(Boolean))]
      .sort((left, right) => left.localeCompare(right))
      .map((model) => ({ customName: model, model }));
  } catch {
    return [];
  }
}

function modelIdCandidates(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(modelIdCandidates);
  if (!value || typeof value !== 'object') return typeof value === 'string' ? [value] : [];

  const record = value as Record<string, unknown>;
  const direct = [record.id, record.name, record.model]
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  const nested = [record.data, record.models]
    .filter((item) => Array.isArray(item))
    .flatMap(modelIdCandidates);
  return [...direct, ...nested];
}

function upstreamErrorMessage(text: string): string {
  const preview = compactResponsePreview(text);
  if (!preview) return '上游没有返回错误内容。';
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    const error = payload.error;
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object') {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string' && message.trim()) return message.trim();
    }
    const message = payload.message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  } catch {
    return preview;
  }
  return preview;
}

function compactResponsePreview(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 500);
}

async function exportProvidersToFile(includeAPIKeys: boolean): Promise<boolean> {
  const window = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined;
  const options: SaveDialogOptions = {
    title: includeAPIKeys ? '导出供应商配置和 API Key' : '导出供应商配置',
    defaultPath: includeAPIKeys ? 'codex-key-switcher-with-keys.json' : 'codex-key-switcher-providers.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  };
  const result = window
    ? await dialog.showSaveDialog(window, options)
    : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return false;

  const payload = await getProviderService().exportPayload(includeAPIKeys);
  await fs.writeFile(result.filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return true;
}

async function importProvidersFromFile(): Promise<number> {
  const window = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined;
  const options: OpenDialogOptions = {
    title: '导入供应商配置',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  };
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) return 0;

  const text = await fs.readFile(result.filePaths[0], 'utf8');
  return getProviderService().importPayload(JSON.parse(text));
}
