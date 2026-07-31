import type {
  Provider,
  ProviderExportItem,
  ProviderExportPayload,
  ProviderInput,
  ProviderModel,
} from '@codex-key-switcher/shared';

export interface ProviderRepository {
  list(): Promise<Provider[]>;
  save(provider: Provider): Promise<void>;
  delete(id: string): Promise<void>;
  getCurrentId(): Promise<string | null>;
  setCurrentId(id: string): Promise<void>;
}

export interface CredentialStore {
  get(providerId: string): Promise<string | null>;
  set(providerId: string, apiKey: string): Promise<void>;
  delete(providerId: string): Promise<void>;
}

interface LegacyProviderKey {
  id?: string;
  name?: string;
  keyPreview?: string;
  enabled?: boolean;
}

type LegacyProvider = Provider & {
  keys?: LegacyProviderKey[];
  selectedKeyId?: string;
};

type LegacyProviderExportItem = ProviderExportItem & {
  apiKeys?: Array<{ id?: string; apiKey?: string; keyPreview?: string; enabled?: boolean }>;
  selectedKeyId?: string;
};

const defaultKeyId = 'default';

export class ProviderService {
  constructor(
    private readonly repository: ProviderRepository,
    private readonly credentials: CredentialStore,
  ) {}

  async list(): Promise<Provider[]> {
    const providers = await this.repository.list();
    const normalized: Provider[] = [];
    for (const provider of providers) {
      await this.migrateLegacySelectedKey(provider as LegacyProvider);
      const item = normalizeStoredProvider(provider as LegacyProvider);
      await this.hydrateKeyPreview(item);
      normalized.push(item);
    }
    return normalized.sort((a, b) => a.updatedAt - b.updatedAt);
  }

  async current(): Promise<Provider | null> {
    const currentId = await this.repository.getCurrentId();
    if (!currentId) return null;
    return (await this.list()).find((provider) => provider.id === currentId) ?? null;
  }

  async upsert(input: ProviderInput): Promise<Provider> {
    const existing = input.id ? (await this.list()).find((item) => item.id === input.id) : null;
    const provider = this.normalize(input, existing ?? null);

    const apiKey = input.apiKey?.trim();
    if (apiKey) {
      await this.credentials.set(provider.id, apiKey);
      provider.keyPreview = maskApiKey(apiKey);
    } else if (!existing) {
      throw new Error('新增配置必须填写 API Key。');
    }

    await this.hydrateKeyPreview(provider);
    if (!await this.credentials.get(provider.id)) {
      throw new Error('该配置缺少本地 API Key。');
    }

    await this.repository.save(provider);

    const currentId = await this.repository.getCurrentId();
    if (!currentId) {
      await this.repository.setCurrentId(provider.id);
    }

    return provider;
  }

  async setCurrent(providerId: string): Promise<void> {
    const provider = (await this.list()).find((item) => item.id === providerId);
    if (!provider) throw new Error('配置不存在。');

    const apiKey = await this.currentApiKey(provider);
    if (!apiKey) throw new Error('该配置缺少本地 API Key。');

    await this.repository.setCurrentId(providerId);
  }

  async delete(providerId: string): Promise<void> {
    const rawProvider = (await this.repository.list()).find((item) => item.id === providerId) as LegacyProvider | undefined;
    await this.repository.delete(providerId);
    await this.credentials.delete(providerId);
    for (const key of rawProvider?.keys ?? []) {
      const keyId = key.id?.trim();
      if (keyId && keyId !== defaultKeyId) {
        await this.credentials.delete(legacyCredentialId(providerId, keyId));
      }
    }
  }

  async setSelectedModel(providerId: string, model: string): Promise<void> {
    const targetProviderId = providerId.trim();
    const targetModel = model.trim();
    if (!targetProviderId || !targetModel) {
      throw new Error('供应商或模型为空，无法切换模型。');
    }

    const provider = (await this.list()).find((item) => item.id === targetProviderId);
    if (!provider) throw new Error('配置不存在。');

    const selectedModel = selectedModelName(provider.models, targetModel);
    if (!selectedModel) throw new Error('模型不存在，无法切换。');

    await this.repository.save({
      ...provider,
      selectedModel,
      updatedAt: Date.now(),
    });
  }

  async currentApiKey(provider: Provider): Promise<string | null> {
    return this.credentials.get(provider.id);
  }

  async exportPayload(includeAPIKeys: boolean): Promise<ProviderExportPayload> {
    const providers: ProviderExportItem[] = [];
    for (const provider of await this.list()) {
      const exported: ProviderExportItem = { ...provider };
      if (includeAPIKeys) {
        const apiKey = await this.credentials.get(provider.id);
        if (apiKey) exported.apiKey = apiKey;
      }
      providers.push(exported);
    }

    return {
      codexKeySwitcherExportVersion: 1,
      exportedAt: Date.now(),
      includesAPIKeys: includeAPIKeys,
      providers,
    };
  }

  async importPayload(payload: unknown): Promise<number> {
    if (!isProviderExportPayloadLike(payload)) {
      throw new Error('导入文件格式无效：缺少 providers 列表。');
    }

    const existingProviders = await this.list();
    let importedCount = 0;

    for (const incoming of payload.providers as LegacyProviderExportItem[]) {
      const normalized = normalizeImportedProvider(incoming);
      if (!normalized) continue;

      const existing = findExistingProvider(existingProviders, normalized);
      const providerId = existing?.id ?? normalized.id ?? crypto.randomUUID();
      const provider: Provider = {
        ...normalized,
        id: providerId,
        keyPreview: existing?.keyPreview ?? normalized.keyPreview ?? '需要重新填写 Key',
        updatedAt: existing?.updatedAt ?? normalized.updatedAt ?? Date.now(),
      };

      const importedApiKey = importedApiKeyForProvider(incoming);
      if (importedApiKey) {
        await this.credentials.set(providerId, importedApiKey);
        provider.keyPreview = maskApiKey(importedApiKey);
      }

      await this.hydrateKeyPreview(provider);
      await this.repository.save(provider);
      importedCount++;
    }

    const currentId = await this.repository.getCurrentId();
    const providers = await this.repository.list();
    if (!currentId && providers[0]) {
      await this.repository.setCurrentId(providers[0].id);
    }

    return importedCount;
  }

  private normalize(input: ProviderInput, existing: Provider | null): Provider {
    const name = input.name.trim();
    const baseURL = trimTrailingSlashes(input.baseURL);
    const models = normalizeModels(input.models);

    if (!name || !baseURL || models.length === 0) {
      throw new Error('名称、Base URL、至少一个模型都必须填写。');
    }

    const url = new URL(baseURL);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Base URL 必须是 http 或 https 地址。');
    }

    const duplicatedModel = findDuplicate(models.map((model) => model.customName));
    if (duplicatedModel) throw new Error(`模型自定义名称重复：${duplicatedModel}`);

    const selectedModel = selectedModelName(models, input.selectedModel?.trim() || '') || models[0]?.customName || models[0]?.model;
    if (!selectedModel) throw new Error('请选择模型。');

    const provider: Provider = {
      id: input.id?.trim() || existing?.id || crypto.randomUUID(),
      name,
      baseURL,
      apiFormat: input.apiFormat,
      models,
      selectedModel,
      keyPreview: existing?.keyPreview ?? '需要重新填写 Key',
      updatedAt: Date.now(),
    };
    const tag = input.tag?.trim();
    if (tag) provider.tag = tag;
    return provider;
  }

  private async hydrateKeyPreview(provider: Provider): Promise<void> {
    const apiKey = await this.credentials.get(provider.id);
    provider.keyPreview = apiKey ? maskApiKey(apiKey) : provider.keyPreview ?? '需要重新填写 Key';
  }

  private async migrateLegacySelectedKey(provider: LegacyProvider): Promise<void> {
    if (await this.credentials.get(provider.id)) return;

    const selectedKey = selectedLegacyProviderKey(provider);
    const selectedKeyId = selectedKey?.id?.trim();
    if (!selectedKeyId) return;

    const legacyApiKey = await this.credentials.get(legacyCredentialId(provider.id, selectedKeyId));
    if (legacyApiKey) {
      await this.credentials.set(provider.id, legacyApiKey);
    }
  }
}

function legacyCredentialId(providerId: string, keyId: string): string {
  const normalizedKeyId = keyId.trim() || defaultKeyId;
  return normalizedKeyId === defaultKeyId ? providerId.trim() : `${providerId.trim()}:${normalizedKeyId}`;
}

function trimTrailingSlashes(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function findDuplicate(values: string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}

function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 8) return '****';
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

function selectedModelName(models: ProviderModel[], targetModel: string): string | null {
  const target = targetModel.trim();
  if (!target) return null;

  for (const model of models) {
    if (target === model.customName || target === model.model) {
      return model.customName || model.model;
    }
  }
  return null;
}

function findExistingProvider(providers: Provider[], incoming: Provider): Provider | null {
  const id = incoming.id.trim();
  if (id) {
    const provider = providers.find((item) => item.id === id);
    if (provider) return provider;
  }

  return providers.find((provider) => (
    provider.name.trim() === incoming.name.trim()
    && trimTrailingSlashes(provider.baseURL) === trimTrailingSlashes(incoming.baseURL)
  )) ?? null;
}

function normalizeImportedProvider(incoming: LegacyProviderExportItem): Provider | null {
  const input: ProviderInput = {
    id: incoming.id,
    name: incoming.name,
    baseURL: incoming.baseURL,
    apiFormat: incoming.apiFormat,
    models: incoming.models,
    selectedModel: incoming.selectedModel,
  };
  if (incoming.tag) input.tag = incoming.tag;
  if (incoming.apiKey) input.apiKey = incoming.apiKey;

  try {
    return normalizeProviderInput(input);
  } catch {
    return null;
  }
}

function normalizeProviderInput(input: ProviderInput): Provider {
  const name = input.name.trim();
  const baseURL = trimTrailingSlashes(input.baseURL);
  const models = normalizeModels(input.models);

  if (!name || !baseURL || models.length === 0) {
    throw new Error('名称、Base URL、至少一个模型都必须填写。');
  }

  const url = new URL(baseURL);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Base URL 必须是 http 或 https 地址。');
  }

  const duplicated = findDuplicate(models.map((model) => model.customName));
  if (duplicated) throw new Error(`模型自定义名称重复：${duplicated}`);

  const selectedModel = selectedModelName(models, input.selectedModel?.trim() || '') || models[0]?.customName || models[0]?.model;
  if (!selectedModel) throw new Error('请选择模型。');

  const provider: Provider = {
    id: input.id?.trim() || crypto.randomUUID(),
    name,
    baseURL,
    apiFormat: input.apiFormat,
    models,
    selectedModel,
    keyPreview: '需要重新填写 Key',
    updatedAt: Date.now(),
  };
  const tag = input.tag?.trim();
  if (tag) provider.tag = tag;
  return provider;
}

function normalizeModels(models: ProviderModel[]): ProviderModel[] {
  return models
    .map((model) => ({
      customName: model.customName.trim(),
      model: model.model.trim(),
    }))
    .filter((model) => model.customName && model.model);
}

function normalizeStoredProvider(provider: LegacyProvider): Provider {
  const selectedKey = selectedLegacyProviderKey(provider);
  const normalized: Provider = {
    id: provider.id,
    name: provider.name,
    baseURL: provider.baseURL,
    apiFormat: provider.apiFormat,
    models: normalizeModels(provider.models),
    selectedModel: selectedModelName(provider.models, provider.selectedModel) ?? provider.selectedModel,
    keyPreview: selectedKey?.keyPreview ?? provider.keyPreview ?? '需要重新填写 Key',
    updatedAt: Number(provider.updatedAt) || Date.now(),
  };
  if (provider.tag) normalized.tag = provider.tag;
  return normalized;
}

function selectedLegacyProviderKey(provider: LegacyProvider): LegacyProviderKey | null {
  const keys = Array.isArray(provider.keys) ? provider.keys : [];
  if (!keys.length) return null;
  const selectedKeyId = provider.selectedKeyId?.trim();
  return keys.find((key) => key.id?.trim() === selectedKeyId)
    ?? keys.find((key) => key.enabled !== false)
    ?? keys[0]
    ?? null;
}

function importedApiKeyForProvider(incoming: LegacyProviderExportItem): string {
  const directApiKey = incoming.apiKey?.trim();
  if (directApiKey) return directApiKey;

  const apiKeys = Array.isArray(incoming.apiKeys) ? incoming.apiKeys : [];
  const selectedKeyId = incoming.selectedKeyId?.trim();
  const selectedKey = apiKeys.find((key) => key.id?.trim() === selectedKeyId)
    ?? apiKeys.find((key) => key.enabled !== false)
    ?? apiKeys[0];
  return selectedKey?.apiKey?.trim() ?? '';
}

function isProviderExportPayloadLike(payload: unknown): payload is ProviderExportPayload {
  if (!payload || typeof payload !== 'object') return false;
  const candidate = payload as Partial<ProviderExportPayload>;
  return Array.isArray(candidate.providers);
}
