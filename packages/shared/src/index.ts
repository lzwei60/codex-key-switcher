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
  currentProviderName?: string;
  currentModel?: string;
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

export interface UsageStatsSnapshot {
  summary: UsageSummary;
  trendRows: UsageTrendRow[];
  providerRows: UsageAggregateRow[];
  modelRows: UsageAggregateRow[];
  logs: UsageLogPage;
}

export interface DiagnosticsReport {
  connectionMode: ConnectionMode;
  routeEnabled: boolean;
  codexUsesGateway: boolean;
  gatewayRunning: boolean;
  codexDirectory: string;
  endpoint: string;
  issues: string[];
  currentProviderName?: string;
  currentModel?: string;
  restoreAvailable: boolean;
  restoreScriptPath: string;
  healthStatus: string;
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
    saveSettings(input: RouteSettings): Promise<RouteSettings>;
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
    snapshot(): Promise<UsageRecord[]>;
    stats(input: UsageStatsInput): Promise<UsageStatsSnapshot>;
    clearLogs(): Promise<UsageStatsSnapshot>;
  };
}
