'use client';

import { CheckCircleOutlined, CloseCircleOutlined, MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { App, Button, Drawer, Form, Input, Select, Space, Tag } from 'antd';
import type { ApiFormat, Provider, ProviderInput, ProviderModel, ProviderModelValidationResult } from '@codex-key-switcher/shared';
import { useEffect, useState, type Key } from 'react';
import { getDesktopApi } from '../../lib/desktop-api';
import { useAppPreferences } from '../../lib/app-preferences';
import { localizeRuntimeMessage } from '../../lib/localize';

interface ProviderFormValues {
  name: string;
  apiKey?: string;
  baseURL: string;
  apiFormat: ApiFormat;
  tag?: string;
  models: ModelFormValue[];
}

type ModelFormValue = Omit<ProviderModel, 'apiFormat' | 'supportsReasoning' | 'supportsImages'> & {
  apiFormat?: ApiFormat | 'inherit';
  supportsReasoning?: boolean | 'inherit';
  supportsImages?: boolean | 'inherit';
};

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
  const { text } = useAppPreferences();
  const [form] = Form.useForm<ProviderFormValues>();
  const [checkingModelKey, setCheckingModelKey] = useState<Key | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelCheckResults, setModelCheckResults] = useState<Record<string, ProviderModelValidationResult>>({});
  const [checkedModelSignatures, setCheckedModelSignatures] = useState<Set<string>>(() => new Set());

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
    setCheckedModelSignatures(new Set());
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
      message.error(text('请先填写 Base URL', 'Enter the base URL first'));
      return;
    }
    if (!values.apiFormat) {
      message.error(text('请先选择 API 格式', 'Select the API format first'));
      return;
    }
    if (!upstreamModel) {
      message.error(text('请先填写上游模型', 'Enter the upstream model first'));
      return;
    }
    if (!provider?.id && !values.apiKey?.trim()) {
      message.error(text('新增配置必须先填写 API Key 才能检测模型', 'Enter an API key before checking a model in a new provider'));
      return;
    }

    setCheckingModelKey(fieldKey);
    try {
      const providerId = provider?.id?.trim();
      const providerName = values.name?.trim();
      const apiKey = values.apiKey?.trim();
      const result = await getDesktopApi().providers.validateModel({
        baseURL: values.baseURL.trim(),
        apiFormat: model?.apiFormat && model.apiFormat !== 'inherit' ? model.apiFormat : values.apiFormat,
        model: {
          customName: model?.customName?.trim() || upstreamModel,
          model: upstreamModel,
          ...(model?.apiFormat && model.apiFormat !== 'inherit' ? { apiFormat: model.apiFormat } : {}),
          ...(typeof model?.supportsReasoning === 'boolean' ? { supportsReasoning: model.supportsReasoning } : {}),
          ...(typeof model?.supportsImages === 'boolean' ? { supportsImages: model.supportsImages } : {}),
        },
        ...(providerId ? { providerId } : {}),
        ...(providerName ? { name: providerName } : {}),
        ...(apiKey ? { apiKey } : {}),
      });
      setModelCheckResults((current) => ({ ...current, [String(fieldKey)]: result }));
      if (model) setCheckedModelSignatures((current) => new Set(current).add(modelSignature(model)));
      if (result.ok) {
        message.success(localizeRuntimeMessage(result.message, text));
      } else {
        message.error(localizeRuntimeMessage(result.message, text));
      }
    } catch (error) {
      const result: ProviderModelValidationResult = {
        ok: false,
        durationMs: 0,
        endpoint: values.baseURL.trim(),
        model: upstreamModel,
        message: error instanceof Error ? error.message : text('模型检测失败', 'Model check failed'),
      };
      setModelCheckResults((current) => ({ ...current, [String(fieldKey)]: result }));
      message.error(localizeRuntimeMessage(result.message, text));
    } finally {
      setCheckingModelKey(null);
    }
  }

  async function fetchUpstreamModels() {
    const values = form.getFieldsValue(true) as ProviderFormValues;
    if (!values.baseURL?.trim()) {
      message.error(text('请先填写 Base URL', 'Enter the base URL first'));
      return;
    }
    if (!values.apiFormat) {
      message.error(text('请先选择 API 格式', 'Select the API format first'));
      return;
    }
    if (!provider?.id && !values.apiKey?.trim()) {
      message.error(text('新增配置必须先填写 API Key 才能拉取模型列表', 'Enter an API key before fetching models for a new provider'));
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
        message.error(localizeRuntimeMessage(result.message, text));
        return;
      }
      form.setFieldsValue({ models: result.models.map(modelToFormValue) });
      setModelCheckResults({});
      setCheckedModelSignatures(new Set());
      message.success(localizeRuntimeMessage(result.message, text));
    } catch (error) {
      message.error(error instanceof Error ? localizeRuntimeMessage(error.message, text) : text('拉取上游模型列表失败', 'Failed to fetch upstream models'));
    } finally {
      setFetchingModels(false);
    }
  }

  async function confirmReplaceModels(count: number): Promise<boolean> {
    return new Promise((resolve) => {
      modal.confirm({
        title: text('替换当前模型列表？', 'Replace the current model list?'),
        content: text(`当前已有 ${count} 个模型。拉取上游模型列表会覆盖当前模型列表。`, `There are currently ${count} models. Fetching upstream models will replace the current list.`),
        okText: text('继续拉取', 'Continue fetching'),
        cancelText: text('取消', 'Cancel'),
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
          <Button onClick={onClose}>{text('取消', 'Cancel')}</Button>
          <Button loading={saving} onClick={() => form.submit()} type="primary">{text('保存', 'Save')}</Button>
        </Space>
      }
      onClose={onClose}
      open={open}
      title={provider ? text('编辑供应商', 'Edit provider') : text('新增供应商', 'Add provider')}
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
        onFinish={async (values) => {
          const models: ProviderModel[] = (values.models ?? [])
            .map((model) => ({
              customName: model.customName?.trim() ?? '',
              model: model.model?.trim() ?? '',
              ...(model.apiFormat && model.apiFormat !== 'inherit' ? { apiFormat: model.apiFormat } : {}),
              ...(typeof model.supportsReasoning === 'boolean' ? { supportsReasoning: model.supportsReasoning } : {}),
              ...(typeof model.supportsImages === 'boolean' ? { supportsImages: model.supportsImages } : {}),
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
          const unverifiedCount = (values.models ?? []).filter((model) => {
            const hasModel = model.customName?.trim() && model.model?.trim();
            return hasModel && !checkedModelSignatures.has(modelSignature(model));
          }).length;
          if (unverifiedCount > 0 && !await confirmSaveWithoutModelChecks(unverifiedCount, text)) return;
          void onSave(input);
        }}
      >
        <Form.Item label={text('名称', 'Name')} name="name" rules={[{ required: true, message: text('请输入供应商名称', 'Enter a provider name') }]}>
          <Input placeholder={text('例如 OpenAI', 'e.g. OpenAI')} />
        </Form.Item>
        <Form.Item
          extra={provider ? text('编辑已有配置时可以留空，系统会继续使用本地已保存 Key。', 'Leave blank when editing to keep using the locally saved key.') : undefined}
          label="API Key"
          name="apiKey"
          rules={provider ? [] : [{ required: true, message: text('新增配置必须填写 API Key', 'An API key is required for a new provider') }]}
        >
          <Input.Password autoComplete="off" placeholder={provider ? text('留空则使用本地已保存 Key', 'Leave blank to use the locally saved key') : 'sk-...'} />
        </Form.Item>
        <Form.Item
          label="Base URL"
          name="baseURL"
          rules={[
            { required: true, message: text('请输入 Base URL', 'Enter the base URL') },
            { type: 'url', warningOnly: false, message: text('请输入有效的 http/https 地址', 'Enter a valid http/https URL') },
          ]}
        >
          <Input placeholder="https://api.openai.com/v1" />
        </Form.Item>
        <Form.Item label={text('标签', 'Tag')} name="tag">
          <Input placeholder={text('默认、备用、内网等', 'Default, backup, internal, etc.')} />
        </Form.Item>
        <Form.Item
          label={text('API 格式', 'API format')}
          name="apiFormat"
          rules={[{ required: true }]}
        >
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
          if (!value.length) throw new Error(text('至少添加一个模型', 'Add at least one model'));
        } }]}>
          {(fields, { add, remove }, { errors }) => (
            <Space className="model-list" orientation="vertical" size={12}>
              {fields.map((field, index) => (
                <div className="model-config-card" key={field.key}>
                <div className="model-config-card__header">
                  <span className="model-config-card__index">{text('模型', 'Model')} {index + 1}</span>
                  <ModelCheckStatus result={modelCheckResults[String(field.key)]} text={text} />
                  <Button className="model-inline-delete" danger icon={<MinusCircleOutlined />} onClick={() => remove(field.name)} />
                </div>
                <div className="model-inline-row model-inline-row--primary">
                  <div className="model-inline-control">
                    <span className="model-inline-label"><span className="required-mark">*</span> {text('模型别名', 'Model alias')}</span>
                    <Form.Item
                      name={[field.name, 'customName']}
                      noStyle
                      rules={[{ required: true, message: text('请输入模型别名', 'Enter a model alias') }]}
                    >
                      <Input placeholder="gpt-4.1" />
                    </Form.Item>
                  </div>
                  <div className="model-inline-control">
                    <span className="model-inline-label"><span className="required-mark">*</span> {text('上游模型', 'Upstream model')}</span>
                    <Form.Item
                      name={[field.name, 'model']}
                      noStyle
                      rules={[{ required: true, message: text('请输入上游模型', 'Enter an upstream model') }]}
                    >
                      <Input placeholder="gpt-4.1" />
                    </Form.Item>
                  </div>
                  <Button
                    loading={checkingModelKey === field.key}
                    onClick={() => void checkModel(field.name, field.key)}
                  >
                    {text('检测', 'Check')}
                  </Button>
                </div>
                <div className="model-config-card__advanced">
                  <Form.Item label={text('模型 API 格式', 'Model API format')} name={[field.name, 'apiFormat']}>
                    <Select options={apiFormatOptions.map((option) => ({ ...option, label: option.value === 'inherit' ? text('继承供应商', 'Inherit provider') : option.label }))} />
                  </Form.Item>
                  <Form.Item label={text('推理参数', 'Reasoning')} name={[field.name, 'supportsReasoning']}>
                    <Select options={capabilityOptions.map((option) => ({ ...option, label: option.value === 'inherit' ? text('继承供应商', 'Inherit provider') : option.value ? text('支持', 'Supported') : text('不支持', 'Not supported') }))} />
                  </Form.Item>
                  <Form.Item label={text('图片输入', 'Image input')} name={[field.name, 'supportsImages']}>
                    <Select options={capabilityOptions.map((option) => ({ ...option, label: option.value === 'inherit' ? text('继承供应商', 'Inherit provider') : option.value ? text('支持', 'Supported') : text('不支持', 'Not supported') }))} />
                  </Form.Item>
                </div>
                </div>
              ))}
              <Space wrap>
                <Button icon={<PlusOutlined />} onClick={() => add({ customName: '', model: '', apiFormat: 'inherit', supportsReasoning: 'inherit', supportsImages: 'inherit' })}>
                  {text('添加模型', 'Add model')}
                </Button>
                <Button loading={fetchingModels} onClick={() => void fetchUpstreamModels()} type="primary">
                  {text('拉取模型列表', 'Fetch models')}
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

function ModelCheckStatus({ result, text }: Readonly<{
  result: ProviderModelValidationResult | undefined;
  text: (zh: string, en: string) => string;
}>) {
  if (!result) return null;
  if (result.ok) {
    return (
      <Tag className="model-check-status" color="success" icon={<CheckCircleOutlined />} title={localizeRuntimeMessage(result.message, text)}>
        {text('检测通过', 'Check passed')}
      </Tag>
    );
  }
  return (
    <Tag className="model-check-status" color="error" icon={<CloseCircleOutlined />} title={localizeRuntimeMessage(result.message, text)}>
      {text('检测失败', 'Check failed')}
    </Tag>
  );
}

function modelSignature(model: Pick<ProviderModel, 'customName' | 'model'>): string {
  return `${model.customName.trim()}\u0000${model.model.trim()}`;
}

async function confirmSaveWithoutModelChecks(count: number, text: (zh: string, en: string) => string): Promise<boolean> {
  return new Promise((resolve) => {
    // The form owns the App context, so use the native confirmation only for
    // this optional warning and keep the save path independent of the network.
    resolve(window.confirm(text(`${count} 个模型尚未检测，仍要保存吗？\n\n保存后可以随时在模型行点击“检测”。`, `${count} model(s) have not been checked. Save anyway?\n\nYou can click “Check” on any model row later.`)));
  });
}

function formModelsForProvider(provider: Provider | null): ModelFormValue[] {
  const models = provider?.models.length ? provider.models : defaultModels;
  return models.map(modelToFormValue);
}

function modelToFormValue(model: ProviderModel): ModelFormValue {
  return {
    customName: model.customName,
    model: model.model,
    apiFormat: model.apiFormat ?? 'inherit',
    supportsReasoning: model.supportsReasoning ?? 'inherit',
    supportsImages: model.supportsImages ?? 'inherit',
  };
}

const apiFormatOptions: Array<{ label: string; value: ApiFormat | 'inherit' }> = [
  { label: 'Inherit provider', value: 'inherit' },
  { label: 'Responses', value: 'responses' },
  { label: 'Chat Completions', value: 'chat_completions' },
  { label: 'Anthropic Messages', value: 'anthropic_messages' },
];

const capabilityOptions: Array<{ label: string; value: boolean | 'inherit' }> = [
  { label: 'Inherit provider', value: 'inherit' },
  { label: 'Supported', value: true },
  { label: 'Not supported', value: false },
];
