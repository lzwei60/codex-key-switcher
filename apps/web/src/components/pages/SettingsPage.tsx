'use client';

import { CloudDownloadOutlined, FolderOpenOutlined, ReloadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';
import { Alert, App, Button, Card, Descriptions, Form, Input, InputNumber, Segmented, Space, Switch, Tabs, Tag, Typography } from 'antd';
import type { AppPreferences, AppStartupSettings, AppUpdateInfo, CodexConfigDirectorySettings, ConnectionMode, RouteSettings as RouteSettingsValue, UsageSettings as UsageSettingsValue } from '@codex-key-switcher/shared';
import { PageHeader } from '../layout/AppShell';
import type { SettingsTabKey } from '../../types/navigation';
import { useAppPreferences } from '../../lib/app-preferences';
import { getDesktopApi } from '../../lib/desktop-api';

const { Text } = Typography;

type GeneralFormValue = Pick<AppStartupSettings, 'openAtLogin' | 'openAsHidden'> & AppPreferences & {
  codexConfigDirectory: string;
};

export function SettingsPage({
  activeTab,
  onTabChange,
}: Readonly<{
  activeTab: SettingsTabKey;
  onTabChange(tab: SettingsTabKey): void;
}>) {
  const { text } = useAppPreferences();
  return (
    <>
      <PageHeader
        description={text('管理 Codex 配置目录、本地路由、启动项和界面偏好。', 'Manage Codex config path, local gateway, startup, and UI preferences.')}
        title={text('设置', 'Settings')}
      />
      <Tabs
        activeKey={activeTab}
        items={[
          { key: 'general', label: text('通用', 'General'), children: <GeneralSettings /> },
          { key: 'route', label: text('路由', 'Gateway'), children: <RouteSettings /> },
          { key: 'usage', label: text('统计与隐私', 'Usage & Privacy'), children: <UsageSettings /> },
          { key: 'updates', label: text('更新', 'Updates'), children: <UpdateSettings /> },
        ]}
        onChange={(key) => onTabChange(key as SettingsTabKey)}
      />
    </>
  );
}

function UsageSettings() {
  const [form] = Form.useForm<UsageSettingsValue>();
  const { message } = App.useApp();
  const { text } = useAppPreferences();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const enabled = Form.useWatch('enabled', form) ?? true;

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    getDesktopApi().usage.settings()
      .then((settings) => {
        if (mounted) form.setFieldsValue(settings);
      })
      .catch((error) => {
        if (mounted) message.error(error instanceof Error ? error.message : text('读取统计设置失败', 'Failed to read usage settings'));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [form, message, text]);

  async function saveSettings(values: UsageSettingsValue) {
    setSaving(true);
    try {
      const settings = await getDesktopApi().usage.saveSettings(values);
      form.setFieldsValue(settings);
      message.success(text('统计与隐私设置已保存', 'Usage and privacy settings saved'));
    } catch (error) {
      message.error(error instanceof Error ? error.message : text('保存失败', 'Save failed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <Alert
        className="section-alert"
        showIcon
        title={text(
          '统计仅用于本地排障与用量感知，不会记录请求正文、响应正文或 API Key。',
          'Usage data is only for local diagnostics and awareness. Request bodies, response bodies, and API keys are never recorded.',
        )}
        type="info"
      />
      <Form
        form={form}
        initialValues={{ enabled: true, retentionDays: 30, maxRecords: 10_000 }}
        layout="vertical"
        onFinish={(values) => void saveSettings(values as UsageSettingsValue)}
      >
        <Form.Item
          extra={text('关闭后不会写入新的本地用量记录，已有记录可在用量统计页手动清除。', 'When disabled, new local usage records are not written. Existing records can be cleared from the Usage page.')}
          label={text('记录本地用量', 'Record Local Usage')}
          name="enabled"
          valuePropName="checked"
        >
          <Switch loading={loading} />
        </Form.Item>
        <Space className="route-row" size={16} wrap>
          <Form.Item
            label={text('保留天数', 'Retention Days')}
            name="retentionDays"
            rules={[{ required: true, message: text('请输入保留天数', 'Enter retention days') }]}
          >
            <InputNumber disabled={loading || !enabled} max={365} min={1} suffix={text('天', 'days')} />
          </Form.Item>
          <Form.Item
            label={text('最大记录数', 'Maximum Records')}
            name="maxRecords"
            rules={[{ required: true, message: text('请输入最大记录数', 'Enter maximum records') }]}
          >
            <InputNumber disabled={loading || !enabled} max={100_000} min={100} step={100} />
          </Form.Item>
        </Space>
        <Text type="secondary">
          {text('超过任一上限时，应用会自动删除最早的本地记录。', 'When either limit is exceeded, the oldest local records are removed automatically.')}
        </Text>
        <Space className="settings-actions">
          <Button htmlType="submit" loading={saving} type="primary">
            {text('保存统计设置', 'Save Usage Settings')}
          </Button>
        </Space>
      </Form>
    </Card>
  );
}

function UpdateSettings() {
  const { message } = App.useApp();
  const { text } = useAppPreferences();
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [openingDownload, setOpeningDownload] = useState(false);
  const [openingReleaseNotes, setOpeningReleaseNotes] = useState(false);

  const checkUpdates = useCallback(async () => {
    setChecking(true);
    try {
      const result = await getDesktopApi().app.checkForUpdates();
      setUpdateInfo(result);
      if (result.status === 'available') {
        message.success(text('发现新版本', 'Update available'));
      } else if (result.status === 'not-available') {
        message.success(text('当前已是最新版本', 'You are up to date'));
      } else if (result.errorMessage) {
        message.warning(result.errorMessage);
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : text('检查更新失败', 'Failed to check for updates'));
    } finally {
      setChecking(false);
    }
  }, [message, text]);

  useEffect(() => {
    void checkUpdates();
  }, [checkUpdates]);

  async function openReleaseUrl(url: string, setOpening: (value: boolean) => void) {
    setOpening(true);
    try {
      await getDesktopApi().app.openUpdateDownload(url);
      message.success(text('已打开链接', 'Link opened'));
    } catch (error) {
      message.error(error instanceof Error ? error.message : text('打开链接失败', 'Failed to open link'));
    } finally {
      setOpening(false);
    }
  }

  async function openDownload() {
    if (!updateInfo?.downloadUrl) return;
    setOpeningDownload(true);
    try {
      await getDesktopApi().app.openUpdateDownload(updateInfo.downloadUrl);
      message.success(text('已打开下载链接', 'Download link opened'));
    } catch (error) {
      message.error(error instanceof Error ? error.message : text('打开下载链接失败', 'Failed to open download link'));
    } finally {
      setOpeningDownload(false);
    }
  }

  const status = updateInfo?.status ?? 'not-configured';
  const statusTag = updateStatusTag(status, text);
  const platformLabel = updatePlatformLabel(updateInfo?.platform, text);

  return (
    <Card>
      <Descriptions
        bordered
        column={1}
        items={[
          {
            key: 'status',
            label: text('更新状态', 'Update Status'),
            children: statusTag,
          },
          {
            key: 'currentVersion',
            label: text('当前版本', 'Current Version'),
            children: updateInfo?.currentVersion ?? '-',
          },
          {
            key: 'latestVersion',
            label: text('最新版本', 'Latest Version'),
            children: updateInfo?.latestVersion ?? '-',
          },
          {
            key: 'platform',
            label: text('当前平台', 'Current Platform'),
            children: platformLabel,
          },
          {
            key: 'assetName',
            label: text('匹配安装包', 'Matched Installer'),
            children: updateInfo?.assetName ?? text('暂无', 'None'),
          },
          {
            key: 'publishedAt',
            label: text('发布时间', 'Published At'),
            children: updateInfo?.publishedAt ? new Date(updateInfo.publishedAt).toLocaleString() : '-',
          },
          {
            key: 'message',
            label: text('说明', 'Message'),
            children: updateInfo?.errorMessage ?? text('通过 GitHub Releases 获取最新版本。', 'Latest version is checked from GitHub Releases.'),
          },
        ]}
      />
      <Space className="settings-actions" wrap>
        <Button icon={<ReloadOutlined />} loading={checking} onClick={() => void checkUpdates()}>
          {text('检查更新', 'Check for Updates')}
        </Button>
        <Button
          disabled={!updateInfo?.downloadUrl}
          icon={<CloudDownloadOutlined />}
          loading={openingDownload}
          onClick={() => void openDownload()}
          type={updateInfo?.status === 'available' ? 'primary' : 'default'}
        >
          {text('下载当前平台安装包', 'Download Installer')}
        </Button>
        {updateInfo?.releaseNotesUrl ? (
          <Button loading={openingReleaseNotes} onClick={() => void openReleaseUrl(updateInfo.releaseNotesUrl ?? '', setOpeningReleaseNotes)}>
            {text('查看发布说明', 'Release Notes')}
          </Button>
        ) : null}
      </Space>
    </Card>
  );
}

function GeneralSettings() {
  const [form] = Form.useForm<GeneralFormValue>();
  const { message } = App.useApp();
  const { preferences, setPreferences, text } = useAppPreferences();
  const [settings, setSettings] = useState<AppStartupSettings | null>(null);
  const [codexDirectorySettings, setCodexDirectorySettings] = useState<CodexConfigDirectorySettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [choosingDirectory, setChoosingDirectory] = useState(false);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    Promise.all([
      getDesktopApi().app.startupSettings(),
      getDesktopApi().app.codexConfigDirectory(),
    ])
      .then(([startupSettings, codexConfigDirectory]) => {
        if (!mounted) return;
        setSettings(startupSettings);
        setCodexDirectorySettings(codexConfigDirectory);
        form.setFieldsValue({
          codexConfigDirectory: codexConfigDirectory.directory,
          openAtLogin: startupSettings.openAtLogin,
          openAsHidden: startupSettings.openAsHidden,
          language: preferences.language,
          theme: preferences.theme,
        });
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [form, preferences.language, preferences.theme]);

  async function saveSettings(values: GeneralFormValue) {
    setSaving(true);
    try {
      const startupSettings = await getDesktopApi().app.saveStartupSettings({
        openAtLogin: Boolean(values.openAtLogin),
        openAsHidden: Boolean(values.openAsHidden),
      });
      const savedPreferences = await setPreferences({
        language: values.language,
        theme: values.theme,
      });
      const savedDirectory = await getDesktopApi().app.saveCodexConfigDirectory(values.codexConfigDirectory);
      setSettings(startupSettings);
      setCodexDirectorySettings(savedDirectory);
      form.setFieldsValue({
        codexConfigDirectory: savedDirectory.directory,
        openAtLogin: startupSettings.openAtLogin,
        openAsHidden: startupSettings.openAsHidden,
        language: savedPreferences.language,
        theme: savedPreferences.theme,
      });
      message.success(text('通用设置已保存', 'General settings saved'));
    } catch (error) {
      message.error(error instanceof Error ? error.message : text('保存失败', 'Save failed'));
    } finally {
      setSaving(false);
    }
  }

  async function chooseDirectory() {
    setChoosingDirectory(true);
    try {
      const selected = await getDesktopApi().app.chooseCodexConfigDirectory();
      if (!selected) return;
      setCodexDirectorySettings(selected);
      form.setFieldsValue({ codexConfigDirectory: selected.directory });
      message.success(text('Codex 配置目录已更新', 'Codex config directory updated'));
    } catch (error) {
      message.error(error instanceof Error ? error.message : text('选择目录失败', 'Failed to choose directory'));
    } finally {
      setChoosingDirectory(false);
    }
  }

  return (
    <Card>
      {settings && !settings.supported ? (
        <Alert
          className="section-alert"
          showIcon
          title={settings.status === 'web-preview'
            ? text('当前是浏览器预览模式，开机自启需要在桌面应用窗口中设置。', 'This is browser preview mode. Startup settings must be configured in the desktop app window.')
            : text('当前平台暂不支持通过应用内设置开机自启。', 'This platform does not support startup-at-login from inside the app.')}
          type="warning"
        />
      ) : null}
      <Form
        form={form}
        initialValues={{
          openAtLogin: false,
          openAsHidden: false,
          codexConfigDirectory: codexDirectorySettings?.directory ?? '~/.codex',
          language: preferences.language,
          theme: preferences.theme,
        }}
        layout="vertical"
        onFinish={(values) => void saveSettings(values as GeneralFormValue)}
        onValuesChange={(changedValues, values) => {
          if ('language' in changedValues || 'theme' in changedValues) {
            void setPreferences({
              language: values.language,
              theme: values.theme,
            });
          }
        }}
      >
        <Form.Item
          extra={codexDirectorySettings?.isDefault
            ? text('当前使用默认 Codex 配置目录。', 'Currently using the default Codex config directory.')
            : text('自定义目录会用于写入 config.toml 和 auth.json。', 'The custom directory is used for config.toml and auth.json.')}
          label={text('Codex 配置目录', 'Codex Config Directory')}
          name="codexConfigDirectory"
          rules={[{ required: true, message: text('请选择 Codex 配置目录', 'Choose a Codex config directory') }]}
        >
          <Input
            disabled={loading}
            placeholder="~/.codex"
            suffix={(
              <Button
                icon={<FolderOpenOutlined />}
                loading={choosingDirectory}
                onClick={() => void chooseDirectory()}
                size="small"
                type="text"
              >
                {text('选择', 'Choose')}
              </Button>
            )}
          />
        </Form.Item>
        <Form.Item label={text('开机自启', 'Open at Login')} name="openAtLogin" valuePropName="checked">
          <Switch disabled={settings?.supported === false} loading={loading} />
        </Form.Item>
        <Form.Item label={text('启动时隐藏窗口', 'Open Hidden')} name="openAsHidden" valuePropName="checked">
          <Switch disabled={settings?.platform !== 'darwin'} loading={loading} />
        </Form.Item>
        <Form.Item label={text('语言', 'Language')} name="language">
          <Segmented options={[{ label: '中文', value: 'zh-Hans' }, { label: 'English', value: 'en' }]} />
        </Form.Item>
        <Form.Item label={text('外观主题', 'Appearance')} name="theme">
          <Segmented options={[
            { label: text('跟随系统', 'System'), value: 'system' },
            { label: text('浅色', 'Light'), value: 'light' },
            { label: text('深色', 'Dark'), value: 'dark' },
          ]} />
        </Form.Item>
        <Space>
          <Button htmlType="submit" loading={saving} type="primary">
            {text('保存通用设置', 'Save General Settings')}
          </Button>
          {settings ? <Text type="secondary">{text('状态', 'Status')}：{settings.status}</Text> : null}
        </Space>
      </Form>
    </Card>
  );
}

function RouteSettings() {
  const [form] = Form.useForm<RouteSettingsValue>();
  const { message } = App.useApp();
  const { text } = useAppPreferences();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [mode, setMode] = useState<ConnectionMode>('local_gateway');

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    getDesktopApi().gateway.settings()
      .then((settings) => {
        if (!mounted) return;
        form.setFieldsValue(settings);
        setMode(settings.mode);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [form]);

  async function saveSettings(values: RouteSettingsValue) {
    setSaving(true);
    try {
      const result = await getDesktopApi().gateway.saveSettings({ ...values, mode });
      const { settings } = result;
      form.setFieldsValue(settings);
      setMode(settings.mode);
      if (result.cancelled) {
        message.info(text('已取消连接模式切换，配置未更改。', 'Connection mode change was cancelled. Settings were not changed.'));
        return;
      }
      if (!result.changed) {
        message.info(text('连接设置未变化。', 'Connection settings were not changed.'));
        return;
      }
      const modeName = settings.mode === 'direct_provider'
        ? text('直连供应商', 'Direct Provider')
        : text('本地路由', 'Local Gateway');
      const statusText = settings.enabled ? text('已重新启用', 'has been re-enabled') : text('已停用', 'has been disabled');
      message.success(text(
        `${modeName}${statusText}，并已写入Codex配置。请重启Codex。`,
        `${modeName} ${statusText}, and has been written to Codex config. Please restart Codex.`,
      ));
    } catch (error) {
      message.error(error instanceof Error ? error.message : text('保存失败', 'Save failed'));
    } finally {
      setSaving(false);
    }
  }

  async function checkPort() {
    setChecking(true);
    try {
      const values = form.getFieldsValue();
      const result = await getDesktopApi().gateway.checkPort({
        listenAddress: values.listenAddress || '127.0.0.1',
        listenPort: Number(values.listenPort),
        allowLANListen: Boolean(values.allowLANListen),
      });
      if (result.available) message.success(result.message);
      else message.warning(result.message);
    } catch (error) {
      message.error(error instanceof Error ? error.message : text('端口检测失败', 'Port check failed'));
    } finally {
      setChecking(false);
    }
  }

  return (
    <Card>
      <Alert
        className="section-alert"
        showIcon
        title={mode === 'direct_provider'
          ? text('直连供应商模式不会启动本地监听，也不会记录本地请求日志和 Token 统计；仅支持 Responses 格式供应商。', 'Direct provider mode does not start a local listener and cannot record request logs or token stats. The first version only supports Responses providers.')
          : text('故障转移只会在上游 5xx、超时或网络错误时尝试下一个供应商；4xx 配置错误会直接返回。', 'Failover only tries the next provider for upstream 5xx, timeout, or network errors. 4xx configuration errors return directly.')}
        type="info"
      />
      <Form
        form={form}
        initialValues={{
          mode: 'local_gateway',
          enabled: true,
          autoStart: true,
          disabledExplicitly: false,
          listenAddress: '127.0.0.1',
          listenPort: 3456,
          allowLANListen: false,
          failoverEnabled: false,
        }}
        layout="vertical"
        onFinish={(values) => void saveSettings(values as RouteSettingsValue)}
      >
        <Form.Item label={text('连接模式', 'Connection Mode')} name="mode">
          <Segmented
            onChange={(value) => setMode(value as ConnectionMode)}
            options={[
              { label: text('本地路由', 'Local Gateway'), value: 'local_gateway' },
              { label: text('直连供应商', 'Direct Provider'), value: 'direct_provider' },
            ]}
            value={mode}
          />
        </Form.Item>
        <Form.Item
          label={mode === 'direct_provider' ? text('启用直连配置', 'Enable Direct Config') : text('启用本地路由', 'Enable Local Gateway')}
          name="enabled"
          valuePropName="checked"
        >
          <Switch loading={loading} />
        </Form.Item>
        <Form.Item label={mode === 'direct_provider' ? text('自动应用直连配置', 'Auto-apply Direct Config') : text('自动启动本地路由', 'Auto-start Local Gateway')} name="autoStart" valuePropName="checked">
          <Switch loading={loading} />
        </Form.Item>
        {mode === 'local_gateway' ? (
          <>
            <Space className="route-row" size={16}>
              <Form.Item label={text('监听地址', 'Listen Address')} name="listenAddress">
                <Input disabled={loading} />
              </Form.Item>
              <Form.Item label={text('监听端口', 'Listen Port')} name="listenPort">
                <InputNumber disabled={loading} max={65535} min={1024} />
              </Form.Item>
            </Space>
            <Form.Item label={text('允许局域网监听', 'Allow LAN Listen')} name="allowLANListen" valuePropName="checked">
              <Switch loading={loading} />
            </Form.Item>
            <Form.Item label={text('故障转移', 'Failover')} name="failoverEnabled" valuePropName="checked">
              <Switch loading={loading} />
            </Form.Item>
          </>
        ) : null}
        <Space>
          {mode === 'local_gateway' ? <Button loading={checking} onClick={() => void checkPort()}>{text('检测端口', 'Check Port')}</Button> : null}
          <Button htmlType="submit" loading={saving} type="primary">{text('保存连接设置', 'Save Connection Settings')}</Button>
        </Space>
      </Form>
    </Card>
  );
}

function updateStatusTag(status: AppUpdateInfo['status'], text: (zh: string, en: string) => string) {
  if (status === 'available') return <Tag color="green">{text('可更新', 'Available')}</Tag>;
  if (status === 'not-available') return <Tag color="blue">{text('已是最新', 'Up to date')}</Tag>;
  if (status === 'unsupported-platform') return <Tag color="orange">{text('平台暂不支持', 'Unsupported')}</Tag>;
  if (status === 'error') return <Tag color="red">{text('检查失败', 'Error')}</Tag>;
  return <Tag>{text('未配置发布', 'Not configured')}</Tag>;
}

function updatePlatformLabel(platform: AppUpdateInfo['platform'] | undefined, text: (zh: string, en: string) => string): string {
  if (platform === 'darwin-arm64') return text('Mac M 芯片', 'Mac Apple Silicon');
  if (platform === 'darwin-x64') return text('Mac Intel', 'Mac Intel');
  if (platform === 'win32-x64') return text('Windows x64', 'Windows x64');
  if (platform === 'linux-x64') return text('Linux x64', 'Linux x64');
  return text('暂不支持', 'Unsupported');
}
