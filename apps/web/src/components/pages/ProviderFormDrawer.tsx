'use client';

import { CheckCircleOutlined, CloseCircleOutlined, MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { App, Button, Drawer, Form, Input, Select, Space, Tag } from 'antd';
import type { ApiFormat, Provider, ProviderInput, ProviderModel, ProviderModelValidationResult } from '@codex-key-switcher/shared';
import { useEffect, useState, type Key } from 'react';
import { getDesktopApi } from '../../lib/desktop-api';

interface ProviderFormValues {
  name: string;
  apiKey?: string;
  baseURL: string;
  apiFormat: ApiFormat;
  tag?: string;
  models: ProviderModel[];
}

const defaultModels: ProviderModel[] = [{ customName: 'gpt-4.1', model: 'gpt-4.1' }];

export function ProviderFormDrawer({
  open,
  provider,
  saving,
  onClose,
  onSave,
}: Readonly<{
  open: boolean;
  provider: Provider | null;
  saving: boolean;
  onClose(): void;
  onSave(input: ProviderInput): Promise<void>;
}>) {
  const { message, modal } = App.useApp();
  const [form] = Form.useForm<ProviderFormValues>();
  const [checkingModelKey, setCheckingModelKey] = useState<Key | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelCheckResults, setModelCheckResults] = useState<Record<string, ProviderModelValidationResult>>({});

  const initialValues: ProviderFormValues = {
    name: provider?.name ?? '',
    apiKey: '',
    baseURL: provider?.baseURL ?? '',
    apiFormat: provider?.apiFormat ?? 'responses',
    tag: provider?.tag ?? '',
    models: formModelsForProvider(provider),
  };

  useEffect(() => {
    if (!open) return;
    setCheckingModelKey(null);
    setModelCheckResults({});
    form.setFieldsValue({
      name: provider?.name ?? '',
      apiKey: '',
      baseURL: provider?.baseURL ?? '',
      apiFormat: provider?.apiFormat ?? 'responses',
      tag: provider?.tag ?? '',
      models: formModelsForProvider(provider),
    });
  }, [form, open, provider]);

  async function checkModel(fieldName: number, fieldKey: Key) {
    const values = form.getFieldsValue(true) as ProviderFormValues;
    const model = values.models?.[fieldName];
    const upstreamModel = model?.model?.trim() ?? '';

    if (!values.baseURL?.trim()) {
      message.error('请先填写 Base URL');
      return;
    }
    if (!values.apiFormat) {
      message.error('请先选择 API 格式');
      return;
    }
    if (!upstreamModel) {
      message.error('请先填写上游模型');
      return;
    }
    if (!provider?.id && !values.apiKey?.trim()) {
      message.error('新增配置必须先填写 API Key 才能检测模型');
      return;
    }

    setCheckingModelKey(fieldKey);
    try {
      const providerId = provider?.id?.trim();
      const providerName = values.name?.trim();
      const apiKey = values.apiKey?.trim();
      const result = await getDesktopApi().providers.validateModel({
        baseURL: values.baseURL.trim(),
        apiFormat: values.apiFormat,
        model: {
          customName: model?.customName?.trim() || upstreamModel,
          model: upstreamModel,
        },
        ...(providerId ? { providerId } : {}),
        ...(providerName ? { name: providerName } : {}),
        ...(apiKey ? { apiKey } : {}),
      });
      setModelCheckResults((current) => ({ ...current, [String(fieldKey)]: result }));
      if (result.ok) {
        message.success(result.message);
      } else {
        message.error(result.message);
      }
    } catch (error) {
      const result: ProviderModelValidationResult = {
        ok: false,
        durationMs: 0,
        endpoint: values.baseURL.trim(),
        model: upstreamModel,
        message: error instanceof Error ? error.message : '模型检测失败',
      };
      setModelCheckResults((current) => ({ ...current, [String(fieldKey)]: result }));
      message.error(result.message);
    } finally {
      setCheckingModelKey(null);
    }
  }

  async function fetchUpstreamModels() {
    const values = form.getFieldsValue(true) as ProviderFormValues;
    if (!values.baseURL?.trim()) {
      message.error('请先填写 Base URL');
      return;
    }
    if (!values.apiFormat) {
      message.error('请先选择 API 格式');
      return;
    }
    if (!provider?.id && !values.apiKey?.trim()) {
      message.error('新增配置必须先填写 API Key 才能拉取模型列表');
      return;
    }

    const currentModels = (values.models ?? []).filter((model) => model.customName?.trim() || model.model?.trim());
    const confirmed = !currentModels.length || await confirmReplaceModels(currentModels.length);
    if (!confirmed) return;

    setFetchingModels(true);
    try {
      const providerId = provider?.id?.trim();
      const apiKey = values.apiKey?.trim();
      const result = await getDesktopApi().providers.listUpstreamModels({
        baseURL: values.baseURL.trim(),
        apiFormat: values.apiFormat,
        ...(providerId ? { providerId } : {}),
        ...(apiKey ? { apiKey } : {}),
      });
      if (!result.ok) {
        message.error(result.message);
        return;
      }
      form.setFieldsValue({ models: result.models });
      setModelCheckResults({});
      message.success(result.message);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '拉取上游模型列表失败');
    } finally {
      setFetchingModels(false);
    }
  }

  async function confirmReplaceModels(count: number): Promise<boolean> {
    return new Promise((resolve) => {
      modal.confirm({
        title: '替换当前模型列表？',
        content: `当前已有 ${count} 个模型。拉取上游模型列表会覆盖当前模型列表。`,
        okText: '继续拉取',
        cancelText: '取消',
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
  }

  return (
    <Drawer
      destroyOnClose
      extra={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button loading={saving} onClick={() => form.submit()} type="primary">保存</Button>
        </Space>
      }
      onClose={onClose}
      open={open}
      title={provider ? '编辑供应商' : '新增供应商'}
      size={680}
    >
      <Form
        form={form}
        initialValues={initialValues}
        layout="vertical"
        onValuesChange={(changedValues) => {
          if (
            'apiKey' in changedValues
            || 'apiFormat' in changedValues
            || 'baseURL' in changedValues
            || 'models' in changedValues
          ) {
            setModelCheckResults({});
          }
        }}
        onFinish={(values) => {
          const models = (values.models ?? [])
            .map((model) => ({
              customName: model.customName?.trim() ?? '',
              model: model.model?.trim() ?? '',
            }))
            .filter((model) => model.customName && model.model);
          const input: ProviderInput = {
            name: values.name.trim(),
            baseURL: values.baseURL.trim(),
            apiFormat: values.apiFormat,
            models,
          };
          if (provider?.id) input.id = provider.id;
          if (values.apiKey?.trim()) input.apiKey = values.apiKey.trim();
          if (values.tag?.trim()) input.tag = values.tag.trim();
          const selectedModel = provider?.selectedModel && models.some((model) => (
            provider.selectedModel === model.customName || provider.selectedModel === model.model
          ))
            ? provider.selectedModel
            : models[0]?.customName || models[0]?.model;
          if (selectedModel) input.selectedModel = selectedModel;
          void onSave(input);
        }}
      >
        <Form.Item label="名称" name="name" rules={[{ required: true, message: '请输入供应商名称' }]}>
          <Input placeholder="例如 OpenAI" />
        </Form.Item>
        <Form.Item
          extra={provider ? '编辑已有配置时可以留空，系统会继续使用本地已保存 Key。' : undefined}
          label="API Key"
          name="apiKey"
          rules={provider ? [] : [{ required: true, message: '新增配置必须填写 API Key' }]}
        >
          <Input.Password autoComplete="off" placeholder={provider ? '留空则使用本地已保存 Key' : 'sk-...'} />
        </Form.Item>
        <Form.Item
          label="Base URL"
          name="baseURL"
          rules={[
            { required: true, message: '请输入 Base URL' },
            { type: 'url', warningOnly: false, message: '请输入有效的 http/https 地址' },
          ]}
        >
          <Input placeholder="https://api.openai.com/v1" />
        </Form.Item>
        <Form.Item label="标签" name="tag">
          <Input placeholder="默认、备用、内网等" />
        </Form.Item>
        <Form.Item label="API 格式" name="apiFormat" rules={[{ required: true }]}>
          <Select
            options={[
              { label: 'Responses', value: 'responses' },
              { label: 'Chat Completions', value: 'chat_completions' },
              { label: 'Anthropic Messages', value: 'anthropic_messages' },
            ]}
            placeholder="Responses"
          />
        </Form.Item>
        <Form.List name="models" rules={[{ validator: async (_, value: ProviderModel[] = []) => {
          if (!value.length) throw new Error('至少添加一个模型');
        } }]}>
          {(fields, { add, remove }, { errors }) => (
            <Space className="model-list" orientation="vertical" size={12}>
              {fields.map((field) => (
                <div className="model-inline-row" key={field.key}>
                  <div className="model-inline-control">
                    <span className="model-inline-label"><span className="required-mark">*</span> 模型别名</span>
                    <Form.Item
                      name={[field.name, 'customName']}
                      noStyle
                      rules={[{ required: true, message: '请输入模型别名' }]}
                    >
                      <Input placeholder="gpt-4.1" />
                    </Form.Item>
                  </div>
                  <div className="model-inline-control">
                    <span className="model-inline-label"><span className="required-mark">*</span> 上游模型</span>
                    <Form.Item
                      name={[field.name, 'model']}
                      noStyle
                      rules={[{ required: true, message: '请输入上游模型' }]}
                    >
                      <Input placeholder="gpt-4.1" />
                    </Form.Item>
                  </div>
                  <Button
                    loading={checkingModelKey === field.key}
                    onClick={() => void checkModel(field.name, field.key)}
                  >
                    检测
                  </Button>
                  <ModelCheckStatus result={modelCheckResults[String(field.key)]} />
                  <Button
                    className="model-inline-delete"
                    danger
                    icon={<MinusCircleOutlined />}
                    onClick={() => remove(field.name)}
                  />
                </div>
              ))}
              <Space wrap>
                <Button icon={<PlusOutlined />} onClick={() => add({ customName: '', model: '' })}>
                  添加模型
                </Button>
                <Button loading={fetchingModels} onClick={() => void fetchUpstreamModels()} type="primary">
                  拉取模型列表
                </Button>
              </Space>
              <Form.ErrorList errors={errors} />
            </Space>
          )}
        </Form.List>
      </Form>
    </Drawer>
  );
}

function ModelCheckStatus({ result }: Readonly<{ result: ProviderModelValidationResult | undefined }>) {
  if (!result) return null;
  if (result.ok) {
    return (
      <Tag className="model-check-status" color="success" icon={<CheckCircleOutlined />} title={result.message}>
        检测通过
      </Tag>
    );
  }
  return (
    <Tag className="model-check-status" color="error" icon={<CloseCircleOutlined />} title={result.message}>
      检测失败
    </Tag>
  );
}

function formModelsForProvider(provider: Provider | null): ProviderModel[] {
  const models = provider?.models.length ? provider.models : defaultModels;
  return models.map((model) => ({
    customName: model.customName,
    model: model.model,
  }));
}
