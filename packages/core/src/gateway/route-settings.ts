import type { RouteSettings } from '@codex-key-switcher/shared';

export interface RouteSettingsChangePlan {
  changed: boolean;
  connectionModeChanged: boolean;
  enabledChanged: boolean;
  localGatewayRuntimeChanged: boolean;
  codexConfigChanged: boolean;
}

export function planRouteSettingsChange(previous: RouteSettings, next: RouteSettings): RouteSettingsChangePlan {
  const connectionModeChanged = previous.mode !== next.mode;
  const enabledChanged = previous.enabled !== next.enabled;
  const localGatewayRuntimeChanged = next.mode === 'local_gateway'
    && next.enabled
    && (
      connectionModeChanged
      || enabledChanged
      || previous.listenAddress !== next.listenAddress
      || previous.listenPort !== next.listenPort
      || previous.allowLANListen !== next.allowLANListen
      || previous.failoverEnabled !== next.failoverEnabled
    );
  const codexConfigChanged = connectionModeChanged
    || enabledChanged
    || (
      next.enabled
      && next.mode === 'local_gateway'
      && (
        previous.listenAddress !== next.listenAddress
        || previous.listenPort !== next.listenPort
        || previous.allowLANListen !== next.allowLANListen
      )
    );

  return {
    changed: !routeSettingsEqual(previous, next),
    connectionModeChanged,
    enabledChanged,
    localGatewayRuntimeChanged,
    codexConfigChanged,
  };
}

export function routeSettingsEqual(left: RouteSettings, right: RouteSettings): boolean {
  return left.mode === right.mode
    && left.enabled === right.enabled
    && left.autoStart === right.autoStart
    && left.disabledExplicitly === right.disabledExplicitly
    && left.listenAddress === right.listenAddress
    && left.listenPort === right.listenPort
    && left.allowLANListen === right.allowLANListen
    && left.failoverEnabled === right.failoverEnabled;
}
