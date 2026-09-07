export type ApiFormat = 'responses' | 'chat_completions' | 'anthropic_messages';

export interface ProviderModel {
  customName: string;
  model: string;
}

export interface Provider {
  id: string;
  name: string;
  baseURL: string;
  apiFormat: ApiFormat;
  models: ProviderModel[];
  selectedModel: string;
  tag?: string;
  keyPreview?: string;
  updatedAt: number;
}

export interface ProviderInput {
  id?: string;
  name: string;
  apiKey?: string;
  baseURL: string;
  apiFormat: ApiFormat;
  models: ProviderModel[];
  selectedModel?: string;
  tag?: string;
}

export interface ProviderModelValidationInput {
  providerId?: string;
  name?: string;
  apiKey?: string;
  baseURL: string;
  apiFormat: ApiFormat;
  model: ProviderModel;
}

export interface ProviderModelValidationResult {
  ok: boolean;
  status?: number;
  durationMs: number;
  endpoint: string;
  model: string;
  message: string;
  responsePreview?: string;
}

export interface ProviderModelsListInput {
  providerId?: string;
  apiKey?: string;
  baseURL: string;
  apiFormat: ApiFormat;
}

export interface ProviderModelsListResult {
  ok: boolean;
  status?: number;
  durationMs: number;
  endpoint: string;
  models: ProviderModel[];
  message: string;
  responsePreview?: string;
}

export interface ProviderExportItem extends Provider {
  apiKey?: string;
}

export interface ProviderExportPayload {
  codexKeySwitcherExportVersion: 1;
  exportedAt: number;
  includesAPIKeys: boolean;
  providers: ProviderExportItem[];
}

export type ConnectionMode = 'local_gateway' | 'direct_provider';

export interface RouteSettings {
  mode: ConnectionMode;
  enabled: boolean;
  autoStart: boolean;
  disabledExplicitly: boolean;
  listenAddress: string;
  listenPort: number;
  allowLANListen: boolean;
  failoverEnabled: boolean;
}

export interface AppStartupSettings {
  supported: boolean;
  openAtLogin: boolean;
  openAsHidden: boolean;
  wasOpenedAtLogin: boolean;
  status: string;
  platform: 'darwin' | 'win32' | 'linux' | 'other';
}

export type AppLanguage = 'zh-Hans' | 'en';

export type AppTheme = 'system' | 'light' | 'dark';

export interface AppPreferences {
  language: AppLanguage;
  theme: AppTheme;
}

export interface CodexConfigDirectorySettings {
  directory: string;
  isDefault: boolean;
}

export type AppUpdatePlatformKey = 'darwin-arm64' | 'darwin-x64' | 'win32-x64' | 'linux-x64' | 'unsupported';

export type AppUpdateStatus = 'available' | 'not-available' | 'not-configured' | 'unsupported-platform' | 'error';

export interface AppUpdateInfo {
  currentVersion: string;
  platform: AppUpdatePlatformKey;
  status: AppUpdateStatus;
  latestVersion?: string;
  releaseName?: string;
  releaseNotesUrl?: string;
  publishedAt?: string;
  downloadUrl?: string;
  assetName?: string;
  errorMessage?: string;
}

export interface PortCheckResult {
  available: boolean;
  listenAddress: string;
  listenPort: number;
  message: string;
}

export interface GatewayStatus {
  running: boolean;
  endpoint: string;
  mode?: ConnectionMode;
  currentProviderId?: string;
  currentProviderName?: string;
  currentModel?: string;
  directSessionTarget?: DirectSessionTarget;
}

export interface DirectSessionTarget {
  id: string;
  providerId: string;
  providerName: string;
  baseURL: string;
  modelName: string;
  displayModel: string;
  appliedAt: number;
}

export interface UsageRecord {
  id: string;
  provider: string;
  model: string;
  status: number;
  durationMs: number;
  source: 'responses' | 'chat_completions' | 'anthropic_messages' | 'gateway';
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  createdAt: number;
}

export interface UsageSummary {
  totalRequests: number;
  successfulRequests: number;
  successRate: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  averageDuration: number;
}

export interface UsageTrendRow {
  key: string;
  label: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export interface UsageAggregateRow {
  key: string;
  name: string;
  requests: number;
  successRate: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  averageDuration: number;
}

export interface UsageLogPage {
  records: UsageRecord[];
  total: number;
  page: number;
  pageSize: number;
}

export interface UsageStatsInput {
  logPage: number;
  logPageSize: number;
}

/**
 * Local-only observability controls. Request and response bodies are never
 * included in usage records.
 */
export interface UsageSettings {
  enabled: boolean;
  retentionDays: number;
  maxRecords: number;
}

export const defaultUsageSettings: UsageSettings = {
  enabled: true,
  retentionDays: 30,
  maxRecords: 10_000,
};

export interface UsageStatsSnapshot {
  summary: UsageSummary;
  trendRows: UsageTrendRow[];
  providerRows: UsageAggregateRow[];
  modelRows: UsageAggregateRow[];
  logs: UsageLogPage;
}

export interface DiagnosticsReport {
  appVersion: string;
  connectionMode: ConnectionMode;
  routeEnabled: boolean;
  codexUsesGateway: boolean;
  gatewayRunning: boolean;
  codexDirectory: string;
  endpoint: string;
  issues: string[];
  currentProviderId?: string;
  currentProviderName?: string;
  currentModel?: string;
  restoreAvailable: boolean;
  restoreScriptPath: string;
  healthStatus: string;
  directSessionTarget?: DirectSessionTarget;
}

export interface RouteSettingsSaveResult {
  settings: RouteSettings;
  changed: boolean;
  cancelled: boolean;
}

export interface DesktopApi {
  app: {
    startupSettings(): Promise<AppStartupSettings>;
    saveStartupSettings(input: Pick<AppStartupSettings, 'openAtLogin' | 'openAsHidden'>): Promise<AppStartupSettings>;
    preferences(): Promise<AppPreferences>;
    savePreferences(input: AppPreferences): Promise<AppPreferences>;
    codexConfigDirectory(): Promise<CodexConfigDirectorySettings>;
    saveCodexConfigDirectory(directory: string): Promise<CodexConfigDirectorySettings>;
    chooseCodexConfigDirectory(): Promise<CodexConfigDirectorySettings | null>;
    checkForUpdates(): Promise<AppUpdateInfo>;
    openUpdateDownload(downloadUrl: string): Promise<void>;
  };
  providers: {
    list(): Promise<Provider[]>;
    save(input: ProviderInput): Promise<Provider>;
    delete(id: string): Promise<void>;
    setCurrent(id: string): Promise<void>;
    setSelectedModel(providerId: string, model: string): Promise<void>;
    validateModel(input: ProviderModelValidationInput): Promise<ProviderModelValidationResult>;
    listUpstreamModels(input: ProviderModelsListInput): Promise<ProviderModelsListResult>;
    exportToFile(includeAPIKeys: boolean): Promise<boolean>;
    importFromFile(): Promise<number>;
  };
  gateway: {
    status(): Promise<GatewayStatus>;
    start(): Promise<GatewayStatus>;
    stop(): Promise<GatewayStatus>;
    settings(): Promise<RouteSettings>;
    saveSettings(input: RouteSettings): Promise<RouteSettingsSaveResult>;
    checkPort(input: Pick<RouteSettings, 'listenAddress' | 'listenPort' | 'allowLANListen'>): Promise<PortCheckResult>;
  };
  diagnostics: {
    read(): Promise<DiagnosticsReport>;
    resyncCodexConfig(): Promise<DiagnosticsReport>;
    stopGatewayAndRestoreCodex(): Promise<DiagnosticsReport>;
    prepareUninstall(): Promise<DiagnosticsReport>;
    openRestoreScriptDirectory(): Promise<void>;
    copyReport(): Promise<void>;
  };
  usage: {
    stats(input: UsageStatsInput): Promise<UsageStatsSnapshot>;
    clearLogs(): Promise<UsageStatsSnapshot>;
    settings(): Promise<UsageSettings>;
    saveSettings(input: UsageSettings): Promise<UsageSettings>;
  };
}
