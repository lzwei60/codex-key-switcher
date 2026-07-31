import type { GatewayStatus, RouteSettings } from '@codex-key-switcher/shared';

export interface GatewayRuntime {
  start(settings: RouteSettings): Promise<GatewayStatus>;
  stop(): Promise<GatewayStatus>;
  status(): Promise<GatewayStatus>;
}

/**
 * 网关服务类，提供网关运行时的状态管理功能
 */
export class GatewayService {
  /**
   * 构造函数，注入网关运行时实例
   * @param runtime 网关运行时实例，用于执行实际的操作
   */
  constructor(private readonly runtime: GatewayRuntime) {}

  /**
   * 获取当前网关状态
   * @returns 返回一个Promise，解析为GatewayStatus对象，包含网关的当前状态信息
   */
  status(): Promise<GatewayStatus> {
    return this.runtime.status();
  }

  /**
   * 根据提供的配置启动或停止网关
   * @param settings 路由配置对象，包含enabled属性决定是否启动网关
   * @returns 返回一个Promise，解析为GatewayStatus对象，表示操作后的网关状态
   */
  start(settings: RouteSettings): Promise<GatewayStatus> {
    if (!settings.enabled) {
      return this.runtime.stop();
    }
    return this.runtime.start(settings);
  }

  /**
   * 停止网关服务
   * @returns 返回一个Promise，解析为GatewayStatus对象，表示停止后的网关状态
   */
  stop(): Promise<GatewayStatus> {
    return this.runtime.stop();
  }
}
