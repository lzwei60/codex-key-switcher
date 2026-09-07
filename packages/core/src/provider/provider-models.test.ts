import { describe, expect, it } from 'vitest';
import type { Provider } from '@codex-key-switcher/shared';
import { directSessionTargetForProvider, providerModelForCatalogModel, providerSelectedCatalogModel } from './provider-models';

describe('directSessionTargetForProvider', () => {
  it('keeps providers distinct when upstream model names are identical', () => {
    const first = providerFixture({
      id: 'provider-1',
      name: 'Provider One',
      baseURL: 'https://provider-one.example/v1',
    });
    const second = providerFixture({
      id: 'provider-2',
      name: 'Provider Two',
      baseURL: 'https://provider-two.example/v1',
    });

    const firstTarget = directSessionTargetForProvider(first, 100);
    const secondTarget = directSessionTargetForProvider(second, 100);

    expect(firstTarget.modelName).toBe('same-model');
    expect(secondTarget.modelName).toBe('same-model');
    expect(firstTarget.id).toBe('provider-1:same-model');
    expect(secondTarget.id).toBe('provider-2:same-model');
    expect(firstTarget.baseURL).toBe('https://provider-one.example/v1');
    expect(secondTarget.baseURL).toBe('https://provider-two.example/v1');
  });
});

describe('provider catalog model mapping', () => {
  it('maps catalog slugs and aliases back to the upstream model', () => {
    const provider = providerFixture({ id: 'provider-12345678', name: 'Provider', baseURL: 'https://provider.example/v1' });
    provider.models = [
      { customName: 'Fast Model', model: 'upstream-fast' },
      { customName: 'Reasoning Model', model: 'upstream-reasoning' },
    ];
    provider.selectedModel = 'Fast Model';

    expect(providerSelectedCatalogModel(provider)).toBe('ks-provider-fast-model');
    expect(providerModelForCatalogModel(provider, 'ks-provider-reasoning-model')?.model).toBe('upstream-reasoning');
    expect(providerModelForCatalogModel(provider, 'Reasoning Model')?.model).toBe('upstream-reasoning');
  });

  it('does not produce duplicate catalog slugs for similar display names', () => {
    const provider = providerFixture({ id: 'provider-12345678', name: 'Provider', baseURL: 'https://provider.example/v1' });
    provider.models = [
      { customName: 'Fast Model', model: 'fast-a' },
      { customName: 'Fast-Model', model: 'fast-b' },
    ];

    expect(providerSelectedCatalogModel(provider)).not.toBe('ks-provider-fast-model');
  });
});

function providerFixture(input: Pick<Provider, 'id' | 'name' | 'baseURL'>): Provider {
  return {
    ...input,
    apiFormat: 'responses',
    models: [{ customName: 'Same Model', model: 'same-model' }],
    selectedModel: 'Same Model',
    updatedAt: 1,
  };
}
