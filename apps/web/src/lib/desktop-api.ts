import { defaultUsageSettings, type AppPreferences, type AppStartupSettings, type AppUpdateInfo, type CodexConfigDirectorySettings, type DesktopApi, type DiagnosticsReport, type GatewayStatus, type PortCheckResult, type Provider, type RouteSettings, type UsageSettings, type UsageStatsSnapshot } from '@codex-key-switcher/shared';

declare global {
  interface Window {
    desktopAPI?: DesktopApi;
  }
}

const fallbackProviders: Provider[] = [
  {
    id: 'demo-openai',
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    apiFormat: 'responses',
    models: [{ customName: 'gpt-4.1', model: 'gpt-4.1' }],
    selectedModel: 'gpt-4.1',
    tag: 'Default',
    keyPreview: '需要重新填写 Key',
    updatedAt: 1,
  },
];

const fallbackAppVersion = process.env.NEXT_PUBLIC_APP_VERSION || '1.0.2';

const fallbackRouteSettings: RouteSettings = {
  mode: 'local_gateway',
  enabled: true,
  autoStart: true,
  disabledExplicitly: false,
  listenAddress: '127.0.0.1',
  listenPort: 3456,
  allowLANListen: false,
  failoverEnabled: false,
};

let fallbackGatewayRunning = false;
let fallbackCurrentProviderId = fallbackProviders[0]?.id ?? '';
let fallbackRouteSettingsState: RouteSettings = { ...fallbackRouteSettings };
let fallbackDirectSessionTarget: GatewayStatus['directSessionTarget'];

const fallbackStartupSettings: AppStartupSettings = {
  supported: false,
  openAtLogin: false,
  openAsHidden: false,
  wasOpenedAtLogin: false,
  status: 'web-preview',
  platform: 'other',
};

let fallbackPreferences: AppPreferences = {
  language: 'zh-Hans',
  theme: 'system',
};

let fallbackUsageSettings: UsageSettings = { ...defaultUsageSettings };
let fallbackCodexConfigDirectory: CodexConfigDirectorySettings = {
  directory: '~/.codex',
  isDefault: true,
};

function fallbackDiagnosticsReport(): DiagnosticsReport {
  const status = fallbackGatewayStatus();
  const report: DiagnosticsReport = {
    appVersion: fallbackAppVersion,
    routeEnabled: fallbackRouteSettingsState.enabled,
    connectionMode: fallbackRouteSettingsState.mode,
    codexUsesGateway: false,
    gatewayRunning: fallbackGatewayRunning,
    codexDirectory: fallbackCodexConfigDirectory.directory,
    endpoint: status.endpoint,
    restoreAvailable: false,
    restoreScriptPath: 'Web preview mode does not expose a restore script.',
    healthStatus: '警告 · 浏览器预览模式',
    issues: ['桌面 API 未连接，当前为 Web 预览模式。'],
  };
  if (status.currentProviderName) report.currentProviderName = status.currentProviderName;
  if (status.currentModel) report.currentModel = status.currentModel;
  return report;
}

export function getDesktopApi(): DesktopApi {
  if (typeof window !== 'undefined' && window.desktopAPI) return window.desktopAPI;

  return {
    app: {
      startupSettings: async (): Promise<AppStartupSettings> => fallbackStartupSettings,
      saveStartupSettings: async (input): Promise<AppStartupSettings> => ({
        ...fallbackStartupSettings,
        openAtLogin: input.openAtLogin,
        openAsHidden: input.openAsHidden,
      }),
      preferences: async (): Promise<AppPreferences> => fallbackPreferences,
      savePreferences: async (input): Promise<AppPreferences> => {
        fallbackPreferences = input;
        return fallbackPreferences;
      },
      codexConfigDirectory: async (): Promise<CodexConfigDirectorySettings> => fallbackCodexConfigDirectory,
      saveCodexConfigDirectory: async (directory): Promise<CodexConfigDirectorySettings> => {
        fallbackCodexConfigDirectory = {
          directory: directory.trim() || '~/.codex',
          isDefault: !directory.trim() || directory.trim() === '~/.codex',
        };
        return fallbackCodexConfigDirectory;
      },
      chooseCodexConfigDirectory: async (): Promise<CodexConfigDirectorySettings | null> => null,
      checkForUpdates: async (): Promise<AppUpdateInfo> => ({
        currentVersion: fallbackAppVersion,
        platform: 'unsupported',
        status: 'not-configured',
        errorMessage: '桌面 API 未连接，当前 Web 预览模式不能检查更新。',
      }),
      openUpdateDownload: async (): Promise<void> => undefined,
    },
    providers: {
      list: async () => [...fallbackProviders],
      save: async (input) => {
        const provider: Provider = {
          id: input.id ?? crypto.randomUUID(),
          name: input.name,
          baseURL: input.baseURL,
          apiFormat: input.apiFormat,
          models: input.models,
          selectedModel: input.selectedModel ?? input.models[0]?.customName ?? '',
          keyPreview: input.apiKey ? '****' : '需要重新填写 Key',
          updatedAt: Date.now(),
        };
        if (input.tag) provider.tag = input.tag;
        const index = fallbackProviders.findIndex((item) => item.id === provider.id);
        if (index >= 0) fallbackProviders[index] = provider;
        else fallbackProviders.push(provider);
        if (!fallbackCurrentProviderId) fallbackCurrentProviderId = provider.id;
        return provider;
      },
      delete: async (id) => {
        const index = fallbackProviders.findIndex((provider) => provider.id === id);
        if (index >= 0) fallbackProviders.splice(index, 1);
        if (fallbackCurrentProviderId === id) fallbackCurrentProviderId = fallbackProviders[0]?.id ?? '';
      },
      setCurrent: async (id) => {
        if (!fallbackProviders.some((provider) => provider.id === id)) throw new Error('配置不存在。');
        fallbackCurrentProviderId = id;
        if (fallbackRouteSettingsState.mode === 'direct_provider' && fallbackRouteSettingsState.enabled) {
          fallbackDirectSessionTarget = fallbackDirectTargetForProvider(fallbackCurrentProvider());
        }
      },
      setSelectedModel: async (providerId, model) => {
        const provider = fallbackProviders.find((item) => item.id === providerId);
        if (!provider) throw new Error('配置不存在。');
        const selected = provider.models.find((item) => item.customName === model || item.model === model);
        if (!selected) throw new Error('模型不存在，无法切换。');
        provider.selectedModel = selected.customName || selected.model;
        provider.updatedAt = Date.now();
        if (fallbackRouteSettingsState.mode === 'direct_provider' && fallbackRouteSettingsState.enabled) {
          fallbackDirectSessionTarget = fallbackDirectTargetForProvider(provider);
        }
      },
      validateModel: async (input) => ({
        ok: false,
        durationMs: 0,
        endpoint: input.baseURL,
        model: input.model.model,
        message: '桌面 API 未连接，当前 Web 预览模式不能检测模型连通性。',
      }),
      listUpstreamModels: async (input) => ({
        ok: false,
        durationMs: 0,
        endpoint: input.baseURL,
        models: [],
        message: '桌面 API 未连接，当前 Web 预览模式不能拉取上游模型列表。',
      }),
      exportToFile: async () => true,
      importFromFile: async () => 0,
    },
    gateway: {
      status: async (): Promise<GatewayStatus> => fallbackGatewayStatus(),
      start: async (): Promise<GatewayStatus> => {
        fallbackRouteSettingsState = { ...fallbackRouteSettingsState, enabled: true, disabledExplicitly: false };
        fallbackGatewayRunning = true;
        if (fallbackRouteSettingsState.mode === 'direct_provider') {
          fallbackGatewayRunning = false;
          fallbackDirectSessionTarget = fallbackDirectTargetForProvider(fallbackCurrentProvider());
        }
        return fallbackGatewayStatus();
      },
      stop: async (): Promise<GatewayStatus> => {
        fallbackGatewayRunning = false;
        fallbackRouteSettingsState = { ...fallbackRouteSettingsState, enabled: false, disabledExplicitly: true };
        if (fallbackRouteSettingsState.mode === 'direct_provider') fallbackDirectSessionTarget = undefined;
        return fallbackGatewayStatus();
      },
      settings: async (): Promise<RouteSettings> => fallbackRouteSettingsState,
      saveSettings: async (input) => {
        const changed = JSON.stringify(fallbackRouteSettingsState) !== JSON.stringify(input);
        fallbackRouteSettingsState = input;
        if (!input.enabled) {
          fallbackGatewayRunning = false;
          fallbackDirectSessionTarget = undefined;
        }
        if (input.mode === 'direct_provider' && input.enabled) fallbackDirectSessionTarget = fallbackDirectTargetForProvider(fallbackCurrentProvider());
        return {
          settings: fallbackRouteSettingsState,
          changed,
          cancelled: false,
        };
      },
      checkPort: async (input): Promise<PortCheckResult> => ({
        available: input.listenPort >= 1024 && input.listenPort <= 65535,
        listenAddress: input.listenAddress,
        listenPort: input.listenPort,
        message: input.listenPort >= 1024 && input.listenPort <= 65535 ? `端口 ${input.listenPort} 可用。` : '端口范围必须在 1024 到 65535 之间。',
      }),
    },
    diagnostics: {
      read: async (): Promise<DiagnosticsReport> => fallbackDiagnosticsReport(),
      resyncCodexConfig: async (): Promise<DiagnosticsReport> => fallbackDiagnosticsReport(),
      stopGatewayAndRestoreCodex: async (): Promise<DiagnosticsReport> => {
        fallbackGatewayRunning = false;
        fallbackRouteSettingsState = { ...fallbackRouteSettingsState, enabled: false, disabledExplicitly: true };
        fallbackDirectSessionTarget = undefined;
        return fallbackDiagnosticsReport();
      },
      prepareUninstall: async (): Promise<DiagnosticsReport> => {
        fallbackGatewayRunning = false;
        fallbackDirectSessionTarget = undefined;
        fallbackRouteSettingsState = { ...fallbackRouteSettingsState, enabled: false, autoStart: false, disabledExplicitly: true };
        return fallbackDiagnosticsReport();
      },
      openRestoreScriptDirectory: async (): Promise<void> => undefined,
      copyReport: async (): Promise<void> => undefined,
    },
    usage: {
      stats: async (input): Promise<UsageStatsSnapshot> => fallbackUsageStats(input.logPage, input.logPageSize),
      clearLogs: async (): Promise<UsageStatsSnapshot> => {
        return fallbackUsageStats(1, 10);
      },
      settings: async (): Promise<UsageSettings> => ({ ...fallbackUsageSettings }),
      saveSettings: async (input): Promise<UsageSettings> => {
        fallbackUsageSettings = {
          enabled: Boolean(input.enabled),
          retentionDays: clampUsageSetting(input.retentionDays, 1, 365, defaultUsageSettings.retentionDays),
          maxRecords: clampUsageSetting(input.maxRecords, 100, 100_000, defaultUsageSettings.maxRecords),
        };
        return { ...fallbackUsageSettings };
      },
    },
  };
}

function clampUsageSetting(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function fallbackDirectTargetForProvider(provider: Provider | null): GatewayStatus['directSessionTarget'] {
  if (!provider) return undefined;
  const selectedModel = provider.models.find((model) => model.customName === provider.selectedModel || model.model === provider.selectedModel);
  const modelName = selectedModel?.model || provider.selectedModel;
  const displayModel = selectedModel?.customName || selectedModel?.model || provider.selectedModel;
  return {
    id: `${provider.id}:${modelName}`,
    providerId: provider.id,
    providerName: provider.name,
    baseURL: provider.baseURL,
    modelName,
    displayModel,
    appliedAt: Date.now(),
  };
}

function fallbackCurrentProvider(): Provider | null {
  return fallbackProviders.find((provider) => provider.id === fallbackCurrentProviderId) ?? null;
}

function fallbackUsageStats(page: number, pageSize: number): UsageStatsSnapshot {
  return {
    summary: {
      totalRequests: 0,
      successfulRequests: 0,
      successRate: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      averageDuration: 0,
    },
    trendRows: [],
    providerRows: [],
    modelRows: [],
    logs: {
      records: [],
      total: 0,
      page,
      pageSize,
    },
  };
}

function fallbackGatewayStatus(): GatewayStatus {
  const currentProvider = fallbackCurrentProvider();
  if (fallbackRouteSettingsState.mode === 'direct_provider' && fallbackRouteSettingsState.enabled && !fallbackDirectSessionTarget) {
    fallbackDirectSessionTarget = fallbackDirectTargetForProvider(currentProvider);
  }
  const status: GatewayStatus = {
    running: fallbackRouteSettingsState.mode === 'local_gateway' && fallbackGatewayRunning,
    mode: fallbackRouteSettingsState.mode,
    endpoint: fallbackRouteSettingsState.mode === 'direct_provider'
      ? fallbackDirectSessionTarget?.baseURL ?? currentProvider?.baseURL ?? '未选择供应商'
      : 'http://127.0.0.1:14567/v1',
  };
  if (fallbackDirectSessionTarget) {
    status.currentProviderId = fallbackDirectSessionTarget.providerId;
    status.currentProviderName = fallbackDirectSessionTarget.providerName;
    status.currentModel = fallbackDirectSessionTarget.displayModel;
    status.directSessionTarget = fallbackDirectSessionTarget;
  } else if (currentProvider) {
    status.currentProviderId = currentProvider.id;
    status.currentProviderName = currentProvider.name;
    status.currentModel = currentProvider.selectedModel;
  }
  return status;
}
