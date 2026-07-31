'use client';

import { Card, Empty } from 'antd';
import { useDiagnostics } from '../../hooks/useDiagnostics';

export function AboutPage() {
  const { report, loading } = useDiagnostics();

  if (!report) {
    return (
      <Card loading={loading}>
        <Empty description="暂无应用信息" />
      </Card>
    );
  }

  return (
    <Card className="plain-panel about-compact" loading={loading}>
      <h2>Codex Key Switcher</h2>
      <p>用于管理 Codex API Key、Base URL、模型别名与本地 Responses 路由。</p>
      <dl>
        <div>
          <dt>版本：</dt>
          <dd>1.1.0</dd>
        </div>
        <div>
          <dt>本地代理：</dt>
          <dd>{report.endpoint}</dd>
        </div>
        <div>
          <dt>配置目录：</dt>
          <dd>{report.codexDirectory}</dd>
        </div>
      </dl>
    </Card>
  );
}
