'use client';

import { Card, Empty } from 'antd';
import { useDiagnostics } from '../../hooks/useDiagnostics';
import { useAppPreferences } from '../../lib/app-preferences';

export function AboutPage() {
  const { report, loading } = useDiagnostics();
  const { text } = useAppPreferences();

  if (!report) {
    return (
      <Card loading={loading}>
        <Empty description={text('暂无应用信息', 'No application information')} />
      </Card>
    );
  }

  return (
    <Card className="plain-panel about-compact" loading={loading}>
      <h2>Codex Key Switcher</h2>
      <p>{text('用于管理 Codex API Key、Base URL、模型别名与本地 Responses 路由。', 'Manage Codex API keys, base URLs, model aliases, and the local Responses gateway.')}</p>
      <dl>
        <div>
          <dt>{text('版本', 'Version')}:</dt>
          <dd>{report.appVersion}</dd>
        </div>
        <div>
          <dt>{text('本地代理', 'Local gateway')}:</dt>
          <dd>{report.endpoint}</dd>
        </div>
        <div>
          <dt>{text('配置目录', 'Config directory')}:</dt>
          <dd>{report.codexDirectory}</dd>
        </div>
      </dl>
    </Card>
  );
}
