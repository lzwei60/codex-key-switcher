'use client';

import { FolderOpenOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import { Alert, App, Button, Card, Form, Input, InputNumber, Segmented, Space, Switch, Tabs, Typography } from 'antd';
import type { AppPreferences, AppStartupSettings, CodexConfigDirectorySettings, ConnectionMode, RouteSettings as RouteSettingsValue } from '@codex-key-switcher/shared';
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
        ]}
        onChange={(key) => onTabChange(key as SettingsTabKey)}
      />
    </>
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
      const settings = await getDesktopApi().gateway.saveSettings({ ...values, mode });
      form.setFieldsValue(settings);
      setMode(settings.mode);
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
          ? text('直连供应商模式不会启动本地监听，也不会记录本地请求日志和 Token 统计；第一版仅支持 Responses 格式供应商。', 'Direct provider mode does not start a local listener and cannot record request logs or token stats. The first version only supports Responses providers.')
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
