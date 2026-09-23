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
import { useAppPreferences } from '../../lib/app-preferences';
import { localizeRuntimeMessage } from '../../lib/localize';
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
  const { text } = useAppPreferences();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [saving, setSaving] = useState(false);
  const [routeSettings, setRouteSettings] = useState<RouteSettings | null>(null);
  const [routeSaving, setRouteSaving] = useState(false);

  const currentProviderId = gateway?.currentProviderId ?? '';
  const providerCountText = useMemo(() => text(`${providers.length} 个配置`, `${providers.length} configurations`), [providers.length, text]);
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
      message.success(text('供应商配置已保存', 'Provider configuration saved'));
    } catch (error) {
      message.error(error instanceof Error ? localizeRuntimeMessage(error.message, text) : text('保存失败', 'Save failed'));
    } finally {
      setSaving(false);
    }
  }

  async function runDelete(provider: Provider) {
    try {
      await onDelete(provider.id);
      await onRefreshGateway();
      await refreshRouteSettings();
      message.success(text(`已删除 ${provider.name}`, `${provider.name} deleted`));
    } catch (error) {
      message.error(error instanceof Error ? localizeRuntimeMessage(error.message, text) : text('删除失败', 'Delete failed'));
    }
  }

  async function runSetCurrent(providerId: string) {
    try {
      const nextProvider = providers.find((provider) => provider.id === providerId);
      await onSetCurrent(providerId);
      await onRefreshGateway();
      await refreshRouteSettings();
      if (isDirectMode) {
        message.success(text(
          `已写入 ${nextProvider?.name ?? '新供应商'} 的直连配置和模型列表，请重启 Codex 使其生效。`,
          `Direct configuration and model list for ${nextProvider?.name ?? 'the new provider'} were written. Restart Codex to apply them.`,
        ));
      } else {
        message.success(text('当前供应商和模型列表已更新，请重启 Codex 刷新模型 UI', 'The current provider and model list were updated. Restart Codex to refresh the model UI.'));
      }
    } catch (error) {
      message.error(error instanceof Error ? localizeRuntimeMessage(error.message, text) : text('切换失败', 'Switch failed'));
    }
  }

  async function runExport(includeAPIKeys: boolean) {
    if (includeAPIKeys) {
      modal.confirm({
        title: text('导出完整 API Key？', 'Export full API keys?'),
        content: text('导出文件会包含完整 API Key。请只保存在可信位置，不要上传到代码仓库或聊天记录。', 'The export contains full API keys. Store it only in a trusted location and never upload it to a repository or chat.'),
        okText: text('继续导出', 'Continue export'),
        cancelText: text('取消', 'Cancel'),
        onOk: async () => {
          const exported = await onExport(true);
          if (exported) message.success(text('供应商配置和 API Key 已导出', 'Provider configuration and API keys exported'));
        },
      });
      return;
    }

    const exported = await onExport(false);
    if (exported) message.success(text('供应商配置已导出', 'Provider configuration exported'));
  }

  async function runImport() {
    try {
      const importedCount = await onImport();
      if (importedCount > 0) message.success(text(`已导入 ${importedCount} 个供应商配置`, `${importedCount} provider configurations imported`));
    } catch (error) {
      message.error(error instanceof Error ? localizeRuntimeMessage(error.message, text) : text('导入失败', 'Import failed'));
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
      const modeName = currentSettings.mode === 'direct_provider' ? text('直连供应商', 'Direct provider') : text('本地路由', 'Local gateway');
      message.success(text(
        `${modeName}${checked ? '已重新启用' : '已停用'}，并已写入Codex配置。请重启Codex。`,
        `${modeName} ${checked ? 'has been enabled again' : 'has been disabled'} and written to the Codex configuration. Restart Codex.`,
      ));
    } catch (error) {
      message.error(error instanceof Error ? localizeRuntimeMessage(error.message, text) : text('连接模式切换失败', 'Connection mode switch failed'));
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
      message.success(checked ? text('故障转移已启用', 'Failover enabled') : text('故障转移已停用', 'Failover disabled'));
    } catch (error) {
      message.error(error instanceof Error ? localizeRuntimeMessage(error.message, text) : text('故障转移设置失败', 'Failed to update failover'));
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
        description={text('管理 Codex 使用的 API Key、Base URL 与模型别名。', 'Manage the API keys, base URLs, and model aliases used by Codex.')}
        extra={
          <Space wrap>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void onRefresh()}>{text('刷新', 'Refresh')}</Button>
            <Button icon={<UploadOutlined />} onClick={() => void runImport()}>{text('导入', 'Import')}</Button>
            <Dropdown
              menu={{
                items: [
                  { key: 'safe', label: text('导出配置，不含 API Key', 'Export configuration without API keys') },
                  { key: 'keys', danger: true, label: text('导出配置，包含 API Key', 'Export configuration with API keys') },
                ],
                onClick: ({ key }) => void runExport(key === 'keys'),
              }}
            >
              <Button icon={<DownloadOutlined />}>{text('导出', 'Export')}</Button>
            </Dropdown>
            <Button icon={<SettingOutlined />} onClick={onOpenSettings}>{text('设置', 'Settings')}</Button>
            <Button icon={<PlusOutlined />} onClick={openAdd} type="primary">{text('添加配置', 'Add provider')}</Button>
          </Space>
        }
        title={text('配置列表', 'Providers')}
      />

      <Card className="route-summary-card">
        <div className="route-summary">
          <Space size={18} wrap>
            <Space>
              <Text strong>{isDirectMode ? text('直连供应商', 'Direct provider') : text('本地路由', 'Local gateway')}</Text>
              <Switch
                checked={routeEnabled}
                loading={gatewayLoading || routeSaving}
                onChange={(checked) => void toggleRoute(checked)}
              />
            </Space>
            <Space>
              <Text strong>{text('故障转移', 'Failover')}</Text>
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
              ? routeEnabled
                ? text(`直连 Session ${gateway?.currentProviderName ?? '未选择供应商'} / ${gateway?.currentModel ?? '未选择模型'} · ${gateway?.endpoint ?? ''}`, `Direct session ${gateway?.currentProviderName ?? 'No provider selected'} / ${gateway?.currentModel ?? 'No model selected'} · ${gateway?.endpoint ?? ''}`)
                : text('直连配置已停用', 'Direct configuration is disabled')
              : gateway?.running ? text(`当前端点 ${gateway.endpoint}`, `Current endpoint ${gateway.endpoint}`) : text('路由总开关已停止', 'Gateway is stopped')}
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
                {isCurrent ? text('使用中', 'In use') : text('设为当前', 'Use this provider')}
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
                        {formatApiFormat(provider.apiFormat)} · {text(`${provider.models.length} 个模型`, `${provider.models.length} models`)} · {text(`优先级 ${provider.failover?.priority ?? 100}`, `Priority ${provider.failover?.priority ?? 100}`)}
                      </Text>
                    </div>
                  </Space>
                  <Tag className="provider-card-tag" color={isCurrent ? 'success' : 'blue'}>
                    {isCurrent ? text('当前', 'Current') : provider.failover?.enabled === false ? text('不参与转移', 'Failover off') : provider.tag || text('备用', 'Backup')}
                  </Tag>
                </div>

                <div className="provider-card-body">
                  <ProviderField
                    label={text('当前模型', 'Current model')}
                    value={<ProviderSelectedModelSummary emptyText={text('未选择', 'Not selected')} provider={provider} />}
                  />
                  <ProviderField label={text('模型', 'Models')} value={<ProviderModelsSummary emptyText={text('暂无模型', 'No models')} provider={provider} />} />
                  <ProviderField label="Base URL" value={provider.baseURL} />
                  <ProviderField
                    label="API Key"
                    value={provider.keyPreview === '需要重新填写 Key' ? text('需要重新填写 Key', 'Key needs to be entered again') : provider.keyPreview ?? text('本地已保存', 'Saved locally')}
                  />
                </div>

                <div className="provider-card-actions">
                  {directModeUnsupported && !isCurrent ? (
                    <Tooltip title={text('直连供应商模式仅支持 Responses 格式；Chat Completions 和 Anthropic 请使用本地路由。', 'Direct provider mode supports Responses only. Use the local gateway for Chat Completions and Anthropic.') }>
                      <span>{currentButton}</span>
                    </Tooltip>
                  ) : currentButton}
                  <Button icon={<EditOutlined />} onClick={() => openEdit(provider)}>{text('编辑', 'Edit')}</Button>
                  <Popconfirm
                    description={text('删除后本地保存的 API Key 也会一并删除。', 'The locally stored API key will also be deleted.')}
                    okButtonProps={{ danger: true }}
                    okText={text('删除', 'Delete')}
                    onConfirm={() => void runDelete(provider)}
                    title={text(`删除 ${provider.name}？`, `Delete ${provider.name}?`)}
                  >
                    <Button danger icon={<DeleteOutlined />}>{text('删除', 'Delete')}</Button>
                  </Popconfirm>
                </div>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card>
          <Empty description={text('暂无供应商配置', 'No provider configuration')}>
            <Button icon={<PlusOutlined />} onClick={openAdd} type="primary">{text('添加配置', 'Add provider')}</Button>
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

function ProviderModelsSummary({ provider, emptyText }: Readonly<{ provider: Provider; emptyText: string }>) {
  const models = provider.models.map((model) => model.model).filter(Boolean);
  const summary = models.join(', ');
  return (
    <Tooltip
      overlayClassName="provider-models-tooltip"
      placement="topLeft"
      title={summary || emptyText}
    >
      <span className="provider-models-summary">{summary || emptyText}</span>
    </Tooltip>
  );
}

function ProviderSelectedModelSummary({ provider, emptyText }: Readonly<{ provider: Provider; emptyText: string }>) {
  const selectedModel = provider.selectedModel || emptyText;
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
