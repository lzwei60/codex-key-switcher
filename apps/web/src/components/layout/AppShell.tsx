'use client';

import {
  ApiOutlined,
  BarChartOutlined,
  CheckCircleFilled,
  InfoCircleOutlined,
  SettingOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import { Layout, Menu, Space, Tag, Typography } from 'antd';
import type { GatewayStatus } from '@codex-key-switcher/shared';
import type { PageKey } from '../../types/navigation';
import { useAppPreferences } from '../../lib/app-preferences';

const { Content, Sider } = Layout;
const { Text, Title } = Typography;

export function AppShell({
  activePage,
  gateway,
  children,
  onNavigate,
}: Readonly<{
  activePage: PageKey;
  gateway: GatewayStatus | null;
  children: React.ReactNode;
  onNavigate(page: PageKey): void;
}>) {
  const { text } = useAppPreferences();
  const menuItems = [
    { key: 'providers', icon: <ApiOutlined />, label: text('配置列表', 'Providers') },
    { key: 'settings', icon: <SettingOutlined />, label: text('设置', 'Settings') },
    { key: 'stats', icon: <BarChartOutlined />, label: text('统计', 'Stats') },
    { key: 'diagnostics', icon: <ToolOutlined />, label: text('诊断', 'Diagnostics') },
    { key: 'about', icon: <InfoCircleOutlined />, label: text('关于', 'About') },
  ];

  return (
    <Layout className="app-shell">
      <Sider width={264} className="app-sider">
        <div className="brand">
          <div className="brand-mark">
            <img alt="Codex Key Switcher" src="./icon.png" />
          </div>
          <div>
            <Text className="brand-title">Codex Key Switcher</Text>
            <Text className="brand-subtitle">{text('Key 管理', 'Key Manager')}</Text>
          </div>
        </div>
        <Menu
          className="app-menu"
          mode="inline"
          selectedKeys={[activePage]}
          items={menuItems}
          onClick={(item) => onNavigate(item.key as PageKey)}
        />
        <div className="sider-status">
          <Space orientation="vertical" size={8}>
            <Tag color={gateway?.running ? 'success' : 'default'} icon={gateway?.running ? <CheckCircleFilled /> : undefined}>
              {gateway?.running ? text('代理运行中', 'Gateway Running') : text('代理已停用', 'Gateway Stopped')}
            </Tag>
            <Text className="endpoint" copyable={Boolean(gateway?.endpoint)}>
              {gateway?.endpoint ?? text('未连接', 'Disconnected')}
            </Text>
          </Space>
        </div>
      </Sider>
      <Layout>
        <Content className="app-content">
          {children}
        </Content>
      </Layout>
    </Layout>
  );
}

export function PageHeader({
  title,
  description,
  extra,
}: Readonly<{
  title: string;
  description: string;
  extra?: React.ReactNode;
}>) {
  return (
    <div className="page-header">
      <div>
        <Title level={2}>{title}</Title>
        <Text type="secondary">{description}</Text>
      </div>
      {extra ? <div>{extra}</div> : null}
    </div>
  );
}
