import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Provider } from '@codex-key-switcher/shared';
import { AppSettingsStore } from './app-settings-store';
import { ModelCatalogService } from './model-catalog-service';

const temporaryRoots: string[] = [];

describe('ModelCatalogService', () => {
  let appDataDirectory: string;
  let codexDirectory: string;
  let settings: AppSettingsStore;
  let service: ModelCatalogService;

  beforeEach(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cksw-catalog-'));
    temporaryRoots.push(root);
    appDataDirectory = path.join(root, 'app-data');
    codexDirectory = path.join(root, '.codex');
    await fs.mkdir(appDataDirectory, { recursive: true });
    await fs.mkdir(codexDirectory, { recursive: true });
    settings = new AppSettingsStore(appDataDirectory);
    service = new ModelCatalogService(settings, root, appDataDirectory);
  });

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it('writes the catalog into the switcher private data directory', async () => {
    const catalogPath = await service.writeForProvider(providerFixture(), 'local_gateway');
    expect(catalogPath).toBe(path.join(appDataDirectory, 'model-catalogs', 'current.json'));
    const payload = JSON.parse(await fs.readFile(catalogPath, 'utf8')) as { models: Array<{ slug: string }> };
    expect(payload.models[0]?.slug).toBe('ks-provider-gpt-4.1');
  });

  it('uses the catalog slug for local gateway mode', async () => {
    const catalogPath = await service.writeForProvider(providerFixture(), 'local_gateway');
    const payload = JSON.parse(await fs.readFile(catalogPath, 'utf8')) as { models: Array<{ slug: string }> };
    expect(payload.models.map((model) => model.slug)).toEqual([
      'ks-provider-gpt-4.1',
      'ks-provider-gpt-5',
    ]);
  });

  it('uses the real upstream model name for direct provider mode', async () => {
    const catalogPath = await service.writeForProvider(providerFixture(), 'direct_provider');
    const payload = JSON.parse(await fs.readFile(catalogPath, 'utf8')) as { models: Array<{ slug: string }> };
    expect(payload.models.map((model) => model.slug)).toEqual(['gpt-4.1', 'gpt-5']);
  });

  it('reuses the cached Codex model template when available', async () => {
    await fs.writeFile(path.join(codexDirectory, 'models_cache.json'), JSON.stringify({
      client_version: '0.133.0',
      etag: 'cached-etag',
      models: [
        { slug: 'gpt-4.1', display_name: 'Cached', supported_reasoning_levels: [{ effort: 'high', description: 'High' }] },
        { slug: 'gpt-5', display_name: 'Second' },
      ],
    }), 'utf8');
    const catalogPath = await service.writeForProvider(providerFixture(), 'local_gateway');
    const payload = JSON.parse(await fs.readFile(catalogPath, 'utf8')) as {
      client_version: string;
      etag?: string;
      models: Array<{ slug: string; display_name: string; supported_reasoning_levels?: unknown[] }>;
    };
    expect(payload.client_version).toBe('0.133.0');
    expect(payload.etag).toBe('cached-etag');
    expect(payload.models[0]?.slug).toBe('ks-provider-gpt-4.1');
    expect(payload.models[0]?.display_name).toBe('GPT 4.1');
    expect(payload.models[0]?.supported_reasoning_levels).toEqual([{ effort: 'high', description: 'High' }]);
    expect(payload.models[1]?.slug).toBe('ks-provider-gpt-5');
    expect(payload.models[1]?.display_name).toBe('GPT 5');
    expect(payload.models[1]?.supported_reasoning_levels).toHaveLength(3);
  });

  it('falls back to a generated template when no Codex cache exists', async () => {
    const catalogPath = await service.writeForProvider(providerFixture(), 'local_gateway');
    const payload = JSON.parse(await fs.readFile(catalogPath, 'utf8')) as {
      client_version: string;
      models: Array<{ slug: string; default_reasoning_level: string }>;
    };
    expect(payload.client_version).toBe('codex-key-switcher');
    expect(payload.models[0]?.default_reasoning_level).toBe('medium');
    expect(payload.models[0]).toMatchObject({ truncation_policy: { mode: 'tokens', limit: 10000 } });
  });

  it('throws when the provider has no models', async () => {
    const provider = providerFixture();
    provider.models = [];
    await expect(service.writeForProvider(provider, 'local_gateway')).rejects.toThrow('当前供应商没有可写入 Codex 的模型。');
  });

  it('fills required fields even when an exact cache match is incomplete', async () => {
    await fs.writeFile(path.join(codexDirectory, 'models_cache.json'), JSON.stringify({
      models: [{ slug: 'gpt-4.1', display_name: 'Cached' }],
    }));
    const catalogPath = await service.writeForProvider(providerFixture(), 'local_gateway');
    const payload = JSON.parse(await fs.readFile(catalogPath, 'utf8')) as { models: Record<string, unknown>[] };
    for (const model of payload.models) {
      expect(model).toMatchObject({
        base_instructions: '', truncation_policy: { mode: 'tokens', limit: 10000 },
        experimental_supported_tools: [],
      });
    }
  });

  it.skipIf(!process.env.CODEX_BINARY)('loads generated fallback models in the real Codex app-server', async () => {
    const provider = providerFixture();
    provider.models[1] = { customName: 'Plain', model: 'plain', supportsReasoning: false };
    const catalogPath = await service.writeForProvider(provider, 'local_gateway');
    const result = await promisify(execFile)(process.execPath, [
      path.resolve('../../scripts/verify-codex-catalog.mjs'), catalogPath,
    ], { timeout: 35000, env: process.env });
    expect(result.stdout).toContain('PASS 2 models');
  }, 40000);

  it('does not inherit unrelated model capabilities and applies explicit overrides', async () => {
    await fs.writeFile(path.join(codexDirectory, 'models_cache.json'), JSON.stringify({
      models: [{ slug: 'unrelated', input_modalities: ['text', 'image'], context_window: 999999 }],
    }));
    const provider = providerFixture();
    provider.models = [{ customName: 'Qwen', model: 'qwen', apiFormat: 'chat_completions', supportsReasoning: false, supportsImages: false }];
    const catalogPath = await service.writeForProvider(provider, 'local_gateway');
    const payload = JSON.parse(await fs.readFile(catalogPath, 'utf8')) as { models: Record<string, unknown>[] };
    expect(payload.models[0]).toMatchObject({ input_modalities: ['text'], supports_reasoning_summaries: false });
    expect(payload.models[0]?.context_window).toBeUndefined();
    expect(payload.models[0]).toMatchObject({ truncation_policy: { mode: 'tokens', limit: 10000 } });
  });

  it('inherits image support for Responses models by default', async () => {
    const provider = providerFixture();
    provider.models = [{ customName: 'GPT 5.6 Sol', model: 'gpt-5.6-sol' }];
    const catalogPath = await service.writeForProvider(provider, 'local_gateway');
    const payload = JSON.parse(await fs.readFile(catalogPath, 'utf8')) as { models: Record<string, unknown>[] };
    expect(payload.models[0]?.input_modalities).toEqual(['text', 'image']);
  });

  it('keeps explicit image support disabled', async () => {
    const provider = providerFixture();
    provider.models = [{ customName: 'Text Only', model: 'text-only', supportsImages: false }];
    const catalogPath = await service.writeForProvider(provider, 'local_gateway');
    const payload = JSON.parse(await fs.readFile(catalogPath, 'utf8')) as { models: Record<string, unknown>[] };
    expect(payload.models[0]?.input_modalities).toEqual(['text']);
  });
});

function providerFixture(): Provider {
  return {
    id: 'provider-12345678',
    name: 'Provider',
    baseURL: 'https://api.example.com/v1',
    apiFormat: 'responses',
    models: [
      { customName: 'GPT 4.1', model: 'gpt-4.1' },
      { customName: 'GPT 5', model: 'gpt-5' },
    ],
    selectedModel: 'GPT 4.1',
    updatedAt: 1,
  };
}
