export interface CodexConfigAdapter {
  getCodexDirectory(): Promise<string>;
  applyLocalGateway(input: {
    endpoint: string;
    localApiKey: string;
    model: string;
    modelCatalogJSON?: string;
  }): Promise<void>;
  applyDirectProvider(input: {
    baseURL: string;
    apiKey: string;
    model: string;
    modelCatalogJSON?: string;
  }): Promise<void>;
  restoreManagedBackup(): Promise<void>;
  restoreManagedBackupForDirectory(directory: string): Promise<void>;
  configUsesLocalGateway(): Promise<boolean>;
  configuredModel(): Promise<string | null>;
  localGatewayAPIKey(): Promise<string>;
}

/**
 * CodexConfigService类，负责处理Codex配置相关服务
 * 该类通过CodexConfigAdapter适配器与底层配置交互
 */
export class CodexConfigService {
  // 构造函数，注入CodexConfigAdapter适配器
  constructor(private readonly adapter: CodexConfigAdapter) {}

  // 应用本地网关配置
  // @param input 包含endpoint、localApiKey和model的对象
  // @returns 返回一个Promise，在配置应用完成后解析
  applyLocalGateway(input: { endpoint: string; localApiKey: string; model: string; modelCatalogJSON?: string }): Promise<void> {
    return this.adapter.applyLocalGateway(input);
  }

  applyDirectProvider(input: { baseURL: string; apiKey: string; model: string; modelCatalogJSON?: string }): Promise<void> {
    return this.adapter.applyDirectProvider(input);
  }

  // 恢复受管理的备份
  // @returns 返回一个Promise，在备份恢复完成后解析
  restoreManagedBackup(): Promise<void> {
    return this.adapter.restoreManagedBackup();
  }

  restoreManagedBackupForDirectory(directory: string): Promise<void> {
    return this.adapter.restoreManagedBackupForDirectory(directory);
  }

/**
 * 检查配置是否使用本地网关
 * @returns {Promise<boolean>} 返回一个Promise，解析为布尔值，表示是否使用本地网关
 */
  configUsesLocalGateway(): Promise<boolean> {
    return this.adapter.configUsesLocalGateway();
  }

/**
 * 获取已配置的模型名称
 * @returns {Promise<string | null>} 返回一个Promise，解析为已配置的模型名称字符串，如果没有配置则返回null
 */
  configuredModel(): Promise<string | null> {
    return this.adapter.configuredModel();
  }

  // 获取本地网关的API密钥
  // @returns 返回一个Promise，解析为API密钥字符串
  localGatewayAPIKey(): Promise<string> {
    return this.adapter.localGatewayAPIKey();
  }

  // 获取Codex目录路径
  // @returns 返回一个Promise，解析为Codex目录的路径字符串
  getCodexDirectory(): Promise<string> {
    return this.adapter.getCodexDirectory();
  }
}
