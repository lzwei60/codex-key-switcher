'use client';

import { App, Button, Card, Empty, Space } from 'antd';
import type { DiagnosticsReport } from '@codex-key-switcher/shared';
import { useDiagnostics } from '../../hooks/useDiagnostics';
import { getDesktopApi } from '../../lib/desktop-api';

export function DiagnosticsPage() {
  const { message } = App.useApp();
  const { report, loading, refresh, setReport } = useDiagnostics();

  async function runAction(action: () => Promise<DiagnosticsReport | void>, successText: string) {
    try {
      const result = await action();
      if (result) setReport(result);
      message.success(successText);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '操作失败');
    }
  }

  if (!report) {
    return (
      <Card loading={loading}>
        <Empty description="暂无诊断信息" />
      </Card>
    );
  }

  const rows = [
    ['健康状态', report.healthStatus],
    ['连接模式', report.connectionMode === 'direct_provider' ? '直连供应商' : '本地路由'],
    [report.connectionMode === 'direct_provider' ? '直连配置' : '本地路由', report.routeEnabled ? '已启用' : '已停用'],
    ['代理服务', report.connectionMode === 'direct_provider' ? '不使用本地监听' : report.gatewayRunning ? '运行中' : '未运行'],
    [report.connectionMode === 'direct_provider' ? '上游地址' : '代理地址', report.endpoint],
    ['Codex 指向代理', report.connectionMode === 'direct_provider' ? '否' : report.codexUsesGateway ? '是' : '否'],
    ['恢复备份', report.restoreAvailable ? '可用' : '不可用'],
    ['当前供应商', report.currentProviderName ?? '未选择'],
    ['当前模型', report.currentModel ?? '未选择'],
    ...(report.connectionMode === 'direct_provider'
      ? [
          ['直连 Session', report.directSessionTarget ? `${report.directSessionTarget.providerName} / ${report.directSessionTarget.displayModel}` : '未应用'],
          ['直连模型名', report.directSessionTarget?.modelName ?? '未应用'],
        ] as const
      : []),
    ['Codex 目录', report.codexDirectory],
    ['恢复脚本', report.restoreScriptPath],
  ] as const;

  return (
    <Card className="plain-panel" loading={loading}>
      <section className="diagnostics-compact">
        <h2>诊断与恢复</h2>
        <p>本地路由、Codex 配置和恢复备份状态正常。</p>
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
            onClick={() => void runAction(() => getDesktopApi().diagnostics.resyncCodexConfig(), 'Codex 配置已重新同步')}
            type="primary"
          >
            重新同步 Codex 配置
          </Button>
          <Button onClick={() => void runAction(() => getDesktopApi().diagnostics.stopGatewayAndRestoreCodex(), '已停止路由并恢复 Codex 原配置')}>
            停用路由并恢复 Codex 原配置
          </Button>
          <Button onClick={() => void runAction(() => getDesktopApi().diagnostics.prepareUninstall(), '已准备卸载')}>
            准备卸载
          </Button>
          <Button onClick={() => void runAction(() => getDesktopApi().diagnostics.openRestoreScriptDirectory(), '已打开恢复脚本目录')}>
            打开恢复脚本目录
          </Button>
          <Button onClick={() => void runAction(() => getDesktopApi().diagnostics.copyReport(), '诊断信息已复制')}>
            复制诊断信息
          </Button>
          <Button onClick={() => void refresh()}>
            刷新
          </Button>
        </Space>
      </section>
    </Card>
  );
}
