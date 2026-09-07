'use client';

import {
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  SettingOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { App, Button, Card, Dropdown, Empty, Popconfirm, Space, Switch, Tag, Tooltip, Typography } from 'antd';
import type { GatewayStatus, Provider, ProviderInput, RouteSettings } from '@codex-key-switcher/shared';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { PageHeader } from '../layout/AppShell';
import { getDesktopApi } from '../../lib/desktop-api';
import { ProviderFormDrawer } from './ProviderFormDrawer';

const { Text } = Typography;

export function ProviderListPage({
  providers,
  loading,
  gateway,
  gatewayLoading,
  onRefresh,
  onRefreshGateway,
  onStartGateway,
  onStopGateway,
  onSave,
  onDelete,
  onSetCurrent,
  onExport,
  onImport,
  onOpenSettings,
}: Readonly<{
  providers: Provider[];
  loading: boolean;
  gateway: GatewayStatus | null;
  gatewayLoading: boolean;
  onRefresh(): Promise<void>;
  onRefreshGateway(): Promise<void>;
  onStartGateway(): Promise<GatewayStatus>;
  onStopGateway(): Promise<GatewayStatus>;
  onSave(input: ProviderInput): Promise<Provider>;
  onDelete(id: string): Promise<void>;
  onSetCurrent(id: string): Promise<void>;
  onExport(includeAPIKeys: boolean): Promise<boolean>;
  onImport(): Promise<number>;
  onOpenSettings(): void;
}>) {
  const { message, modal } = App.useApp();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [saving, setSaving] = useState(false);
  const [routeSettings, setRouteSettings] = useState<RouteSettings | null>(null);
  const [routeSaving, setRouteSaving] = useState(false);

  const currentProviderId = gateway?.currentProviderId ?? '';
  const providerCountText = useMemo(() => `${providers.length} 个配置`, [providers.length]);
  const routeEnabled = routeSettings?.enabled ?? Boolean(gateway?.running);
  const isDirectMode = routeSettings?.mode === 'direct_provider';

  useEffect(() => {
    let mounted = true;
    getDesktopApi().gateway.settings()
      .then((settings) => {
        if (mounted) setRouteSettings(settings);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  function openAdd() {
    setEditingProvider(null);
    setDrawerOpen(true);
  }

  function openEdit(provider: Provider) {
    setEditingProvider(provider);
    setDrawerOpen(true);
  }

  async function runSave(input: ProviderInput) {
    setSaving(true);
    try {
      await onSave(input);
      await onRefreshGateway();
      await refreshRouteSettings();
      setDrawerOpen(false);
      message.success('供应商配置已保存');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function runDelete(provider: Provider) {
    try {
      await onDelete(provider.id);
      await onRefreshGateway();
      await refreshRouteSettings();
      message.success(`已删除 ${provider.name}`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '删除失败');
    }
  }

  async function runSetCurrent(providerId: string) {
    try {
      const nextProvider = providers.find((provider) => provider.id === providerId);
      await onSetCurrent(providerId);
      await onRefreshGateway();
      await refreshRouteSettings();
      if (isDirectMode) {
        message.success(`已写入 ${nextProvider?.name ?? '新供应商'} 的直连配置和模型列表，请重启 Codex 使其生效。`);
      } else {
        message.success('当前供应商和模型列表已更新，请重启 Codex 刷新模型 UI');
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '切换失败');
    }
  }

  async function runExport(includeAPIKeys: boolean) {
    if (includeAPIKeys) {
      modal.confirm({
        title: '导出完整 API Key？',
        content: '导出文件会包含完整 API Key。请只保存在可信位置，不要上传到代码仓库或聊天记录。',
        okText: '继续导出',
        cancelText: '取消',
        onOk: async () => {
          const exported = await onExport(true);
          if (exported) message.success('供应商配置和 API Key 已导出');
        },
      });
      return;
    }

    const exported = await onExport(false);
    if (exported) message.success('供应商配置已导出');
  }

  async function runImport() {
    try {
      const importedCount = await onImport();
      if (importedCount > 0) message.success(`已导入 ${importedCount} 个供应商配置`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '导入失败');
    }
  }

  async function toggleRoute(checked: boolean) {
    setRouteSaving(true);
    try {
      const currentSettings = await getDesktopApi().gateway.settings();
      if (checked) await onStartGateway();
      else await onStopGateway();
      await onRefreshGateway();
      await refreshRouteSettings();
      const modeName = currentSettings.mode === 'direct_provider' ? '直连供应商' : '本地路由';
      message.success(`${modeName}${checked ? '已重新启用' : '已停用'}，并已写入Codex配置。请重启Codex。`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '连接模式切换失败');
    } finally {
      setRouteSaving(false);
    }
  }

  async function toggleFailover(checked: boolean) {
    setRouteSaving(true);
    try {
      const currentSettings = await getDesktopApi().gateway.settings();
      const result = await getDesktopApi().gateway.saveSettings({
        ...currentSettings,
        failoverEnabled: checked,
      });
      setRouteSettings(result.settings);
      await onRefreshGateway();
      message.success(checked ? '故障转移已启用' : '故障转移已停用');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '故障转移设置失败');
    } finally {
      setRouteSaving(false);
    }
  }

  async function refreshRouteSettings() {
    const nextSettings = await getDesktopApi().gateway.settings();
    setRouteSettings(nextSettings);
  }

  return (
    <>
      <PageHeader
        description="管理 Codex 使用的 API Key、Base URL 与模型别名。"
        extra={
          <Space wrap>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void onRefresh()}>刷新</Button>
            <Button icon={<UploadOutlined />} onClick={() => void runImport()}>导入</Button>
            <Dropdown
              menu={{
                items: [
                  { key: 'safe', label: '导出配置，不含 API Key' },
                  { key: 'keys', danger: true, label: '导出配置，包含 API Key' },
                ],
                onClick: ({ key }) => void runExport(key === 'keys'),
              }}
            >
              <Button icon={<DownloadOutlined />}>导出</Button>
            </Dropdown>
            <Button icon={<SettingOutlined />} onClick={onOpenSettings}>设置</Button>
            <Button icon={<PlusOutlined />} onClick={openAdd} type="primary">添加配置</Button>
          </Space>
        }
        title="配置列表"
      />

      <Card className="route-summary-card">
        <div className="route-summary">
          <Space size={18} wrap>
            <Space>
              <Text strong>{isDirectMode ? '直连供应商' : '本地路由'}</Text>
              <Switch
                checked={routeEnabled}
                loading={gatewayLoading || routeSaving}
                onChange={(checked) => void toggleRoute(checked)}
              />
            </Space>
            <Space>
              <Text strong>故障转移</Text>
              <Switch
                disabled={isDirectMode}
                checked={Boolean(routeSettings?.failoverEnabled)}
                loading={routeSaving}
                onChange={(checked) => void toggleFailover(checked)}
              />
            </Space>
            <Text type="secondary">{providerCountText}</Text>
          </Space>
          <Text type="secondary">
            {isDirectMode
              ? routeEnabled ? `直连 Session ${gateway?.currentProviderName ?? '未选择供应商'} / ${gateway?.currentModel ?? '未选择模型'} · ${gateway?.endpoint ?? ''}` : '直连配置已停用'
              : gateway?.running ? `当前端点 ${gateway.endpoint}` : '路由总开关已停止'}
          </Text>
        </div>
      </Card>

      {providers.length ? (
        <div className="provider-card-grid">
          {providers.map((provider) => {
            const directModeUnsupported = isDirectMode && provider.apiFormat !== 'responses';
            const isCurrent = provider.id === currentProviderId;
            const currentButtonDisabled = isCurrent || directModeUnsupported;
            const currentButton = (
              <Button disabled={currentButtonDisabled} onClick={() => void runSetCurrent(provider.id)}>
                {isCurrent ? '使用中' : '设为当前'}
              </Button>
            );
            return (
              <Card
                className={isCurrent ? 'provider-card provider-card-current' : 'provider-card'}
                key={provider.id}
              >
                <div className="provider-card-header">
                  <Space align="start" size={12}>
                    <ProviderAvatar name={provider.name} />
                    <div className="provider-title-block">
                      <Text className="provider-card-title" strong>{provider.name}</Text>
                      <Text type="secondary">
                        {formatApiFormat(provider.apiFormat)} · {provider.models.length} 个模型
                      </Text>
                    </div>
                  </Space>
                  <Tag className="provider-card-tag" color={isCurrent ? 'success' : 'blue'}>
                    {isCurrent ? '当前' : provider.tag || '备用'}
                  </Tag>
                </div>

                <div className="provider-card-body">
                  <ProviderField
                    label="当前模型"
                    value={<ProviderSelectedModelSummary provider={provider} />}
                  />
                  <ProviderField label="模型" value={<ProviderModelsSummary provider={provider} />} />
                  <ProviderField label="Base URL" value={provider.baseURL} />
                  <ProviderField label="API Key" value={provider.keyPreview ?? '本地已保存'} />
                </div>

                <div className="provider-card-actions">
                  {directModeUnsupported && !isCurrent ? (
                    <Tooltip title="直连供应商模式仅支持 Responses 格式；Chat Completions 和 Anthropic 请使用本地路由。">
                      <span>{currentButton}</span>
                    </Tooltip>
                  ) : currentButton}
                  <Button icon={<EditOutlined />} onClick={() => openEdit(provider)}>编辑</Button>
                  <Popconfirm
                    description="删除后本地保存的 API Key 也会一并删除。"
                    okButtonProps={{ danger: true }}
                    okText="删除"
                    onConfirm={() => void runDelete(provider)}
                    title={`删除 ${provider.name}？`}
                  >
                    <Button danger icon={<DeleteOutlined />}>删除</Button>
                  </Popconfirm>
                </div>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card>
          <Empty description="暂无供应商配置">
            <Button icon={<PlusOutlined />} onClick={openAdd} type="primary">添加配置</Button>
          </Empty>
        </Card>
      )}

      <ProviderFormDrawer
        onClose={() => setDrawerOpen(false)}
        onSave={runSave}
        open={drawerOpen}
        provider={editingProvider}
        saving={saving}
      />
    </>
  );
}

function ProviderAvatar({ name }: Readonly<{ name: string }>) {
  const initial = name.trim().slice(0, 1).toUpperCase() || 'K';
  return <div className="provider-avatar">{initial}</div>;
}

function ProviderModelsSummary({ provider }: Readonly<{ provider: Provider }>) {
  const models = provider.models.map((model) => model.model).filter(Boolean);
  const summary = models.join(', ');
  return (
    <Tooltip
      overlayClassName="provider-models-tooltip"
      placement="topLeft"
      title={summary || '暂无模型'}
    >
      <span className="provider-models-summary">{summary || '暂无模型'}</span>
    </Tooltip>
  );
}

function ProviderSelectedModelSummary({ provider }: Readonly<{ provider: Provider }>) {
  const selectedModel = provider.selectedModel || '未选择';
  return (
    <Tooltip
      overlayClassName="provider-models-tooltip"
      placement="topLeft"
      title={selectedModel}
    >
      <span className="provider-models-summary">{selectedModel}</span>
    </Tooltip>
  );
}

function ProviderField({
  label,
  value,
}: Readonly<{
  label: string;
  value: ReactNode;
}>) {
  return (
    <div className="provider-field">
      <Text type="secondary">{label}</Text>
      <div className="provider-field-value">{value}</div>
    </div>
  );
}

function formatApiFormat(value: Provider['apiFormat']) {
  if (value === 'chat_completions') return 'Chat Completions (/chat/completions)';
  if (value === 'anthropic_messages') return 'Anthropic Messages (/messages)';
  return 'Responses (/responses)';
}
