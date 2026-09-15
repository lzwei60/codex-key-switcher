'use client';

import { App, Button, Card, Empty, Space } from 'antd';
import type { DiagnosticsReport } from '@codex-key-switcher/shared';
import { useDiagnostics } from '../../hooks/useDiagnostics';
import { getDesktopApi } from '../../lib/desktop-api';
import { useAppPreferences } from '../../lib/app-preferences';
import { localizeHealthStatus, localizeRuntimeMessage } from '../../lib/localize';

export function DiagnosticsPage() {
  const { message } = App.useApp();
  const { report, loading, refresh, setReport } = useDiagnostics();
  const { text } = useAppPreferences();

  async function runAction(action: () => Promise<DiagnosticsReport | void>, successText: string) {
    try {
      const result = await action();
      if (result) setReport(result);
      message.success(successText);
    } catch (error) {
      message.error(error instanceof Error ? localizeRuntimeMessage(error.message, text) : text('操作失败', 'Operation failed'));
    }
  }

  if (!report) {
    return (
      <Card loading={loading}>
        <Empty description={text('暂无诊断信息', 'No diagnostic information')} />
      </Card>
    );
  }

  const rows = [
    [text('健康状态', 'Health'), localizeHealthStatus(report.healthStatus, text)],
    [text('连接模式', 'Connection mode'), report.connectionMode === 'direct_provider' ? text('直连供应商', 'Direct provider') : text('本地路由', 'Local gateway')],
    [report.connectionMode === 'direct_provider' ? text('直连配置', 'Direct configuration') : text('本地路由', 'Local gateway'), report.routeEnabled ? text('已启用', 'Enabled') : text('已停用', 'Disabled')],
    [text('代理服务', 'Gateway service'), report.connectionMode === 'direct_provider' ? text('不使用本地监听', 'No local listener') : report.gatewayRunning ? text('运行中', 'Running') : text('未运行', 'Not running')],
    [report.connectionMode === 'direct_provider' ? text('上游地址', 'Upstream URL') : text('代理地址', 'Gateway URL'), report.endpoint === '未选择供应商' ? text('未选择供应商', 'No provider selected') : report.endpoint],
    [text('Codex 指向代理', 'Codex uses gateway'), report.connectionMode === 'direct_provider' ? text('否', 'No') : report.codexUsesGateway ? text('是', 'Yes') : text('否', 'No')],
    [text('恢复备份', 'Restore backup'), report.restoreAvailable ? text('可用', 'Available') : text('不可用', 'Unavailable')],
    [text('当前供应商', 'Current provider'), report.currentProviderName ?? text('未选择', 'Not selected')],
    [text('当前模型', 'Current model'), report.currentModel ?? text('未选择', 'Not selected')],
    ...(report.connectionMode === 'direct_provider'
      ? [
          [text('直连 Session', 'Direct session'), report.directSessionTarget ? `${report.directSessionTarget.providerName} / ${report.directSessionTarget.displayModel}` : text('未应用', 'Not applied')],
          [text('直连模型名', 'Direct model name'), report.directSessionTarget?.modelName ?? text('未应用', 'Not applied')],
        ] as const
      : []),
    [text('Codex 目录', 'Codex directory'), report.codexDirectory],
    [text('恢复脚本', 'Restore script'), report.restoreScriptPath === 'Web preview mode does not expose a restore script.'
      ? text('浏览器预览模式不提供恢复脚本。', 'Web preview mode does not expose a restore script.')
      : report.restoreScriptPath],
  ] as const;

  return (
    <Card className="plain-panel" loading={loading}>
      <section className="diagnostics-compact">
        <h2>{text('诊断与恢复', 'Diagnostics and recovery')}</h2>
        <p>{text('本地路由、Codex 配置和恢复备份状态正常。', 'Review local gateway, Codex configuration, and restore backup status.')}</p>
        <div className="diagnostics-grid">
          {rows.map(([label, value]) => (
            <div className="diagnostics-row" key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
        <Space className="diagnostics-actions" wrap>
          <Button
            loading={loading}
            onClick={() => void runAction(() => getDesktopApi().diagnostics.resyncCodexConfig(), text('Codex 配置已重新同步', 'Codex configuration resynchronized'))}
            type="primary"
          >
            {text('重新同步 Codex 配置', 'Resynchronize Codex configuration')}
          </Button>
          <Button onClick={() => void runAction(() => getDesktopApi().diagnostics.stopGatewayAndRestoreCodex(), text('已停止路由并恢复 Codex 原配置', 'Gateway stopped and original Codex configuration restored'))}>
            {text('停用路由并恢复 Codex 原配置', 'Stop gateway and restore original Codex configuration')}
          </Button>
          <Button onClick={() => void runAction(() => getDesktopApi().diagnostics.prepareUninstall(), text('已准备卸载', 'Uninstall preparation completed'))}>
            {text('准备卸载', 'Prepare uninstall')}
          </Button>
          <Button onClick={() => void runAction(() => getDesktopApi().diagnostics.openRestoreScriptDirectory(), text('已打开恢复脚本目录', 'Restore script directory opened'))}>
            {text('打开恢复脚本目录', 'Open restore script directory')}
          </Button>
          <Button onClick={() => void runAction(() => getDesktopApi().diagnostics.copyReport(), text('诊断信息已复制', 'Diagnostic report copied'))}>
            {text('复制诊断信息', 'Copy diagnostic report')}
          </Button>
          <Button onClick={() => void refresh()}>
            {text('刷新', 'Refresh')}
          </Button>
        </Space>
      </section>
    </Card>
  );
}
