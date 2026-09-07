import fs from 'node:fs/promises';
import path from 'node:path';
import { providerCatalogSlug, modelCustomName } from '@codex-key-switcher/core';
import type { ConnectionMode, Provider, ProviderModel } from '@codex-key-switcher/shared';
import type { AppSettingsStore } from './app-settings-store';
import { writeJsonFile } from './json-file';

interface ModelCatalogPayload {
  fetched_at: string;
  client_version: string;
  models: Record<string, unknown>[];
  etag?: string;
}

interface CachedModelsPayload {
  client_version?: unknown;
  etag?: unknown;
  models?: unknown;
}

const catalogDirectoryName = 'model-catalogs';
const currentCatalogFileName = 'current.json';

/**
 * Builds the catalog consumed by Codex at app-server startup.
 * The file lives in the switcher's private data directory and is referenced
 * by a stable absolute path from config.toml.
 */
export class ModelCatalogService {
  constructor(
    private readonly settings: AppSettingsStore,
    private readonly homeDirectory: string,
    private readonly appDataDirectory: string,
  ) {}

  async writeForProvider(provider: Provider, mode: ConnectionMode): Promise<string> {
    const catalogPath = path.join(this.appDataDirectory, catalogDirectoryName, currentCatalogFileName);
    const cached = await this.readCachedModels(provider);
    const models = provider.models.map((model, index) => this.catalogModel(provider, model, mode, index, cached));

    if (!models.length) throw new Error('当前供应商没有可写入 Codex 的模型。');

    const catalog: ModelCatalogPayload = {
      fetched_at: new Date().toISOString(),
      client_version: cached.clientVersion,
      models,
    };
    if (cached.etag) catalog.etag = cached.etag;

    await writeJsonFile(catalogPath, catalog);
    return catalogPath;
  }

  private async readCachedModels(provider: Provider): Promise<{
    clientVersion: string;
    etag?: string;
    templateModels: Record<string, unknown>[];
  }> {
    const codexDirectory = await this.codexDirectory();
    const cachePath = path.join(codexDirectory, 'models_cache.json');
    const payload = await fs.readFile(cachePath, 'utf8')
      .then((text) => JSON.parse(text) as CachedModelsPayload)
      .catch(() => ({} as CachedModelsPayload));
    const templateModels = Array.isArray(payload.models)
      ? payload.models.filter(isRecord)
      : [];
    const firstTemplate = templateModels[0];

    return {
      clientVersion: typeof payload.client_version === 'string'
        ? payload.client_version
        : 'codex-key-switcher',
      ...(typeof payload.etag === 'string' ? { etag: payload.etag } : {}),
      templateModels: firstTemplate ? templateModels : [fallbackModelTemplate(provider)],
    };
  }

  private catalogModel(
    provider: Provider,
    model: ProviderModel,
    mode: ConnectionMode,
    index: number,
    cached: { templateModels: Record<string, unknown>[] },
  ): Record<string, unknown> {
    const upstreamModel = model.model.trim();
    const displayName = modelCustomName(model);
    const template = cached.templateModels[index % cached.templateModels.length] ?? fallbackModelTemplate(provider);
    const slug = mode === 'direct_provider' ? upstreamModel : providerCatalogSlug(provider, model);

    return {
      ...template,
      slug,
      display_name: displayName,
      description: `${provider.name} / ${displayName}`,
      visibility: 'list',
      supported_in_api: true,
      priority: Math.max(1, 100 - index),
    };
  }

  private async codexDirectory(): Promise<string> {
    return await this.settings.getString('codexConfigDir') ?? path.join(this.homeDirectory, '.codex');
  }
}

function fallbackModelTemplate(provider: Provider): Record<string, unknown> {
  return {
    slug: provider.models[0]?.model.trim() || 'gpt-4.1',
    display_name: provider.models[0] ? modelCustomName(provider.models[0]) : 'Codex model',
    description: provider.name,
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Fast responses with lighter reasoning' },
      { effort: 'medium', description: 'Balances speed and reasoning depth' },
      { effort: 'high', description: 'Greater reasoning depth for complex tasks' },
    ],
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority: 1,
    additional_speed_tiers: [],
    service_tiers: [],
    upgrade: null,
    supports_reasoning_summaries: true,
    default_reasoning_summary: 'none',
    support_verbosity: true,
    default_verbosity: 'low',
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text_and_image',
    supports_parallel_tool_calls: true,
    input_modalities: ['text'],
    supports_search_tool: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
