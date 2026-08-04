import { describe, expect, it } from 'vitest';
import type { Provider } from '@codex-key-switcher/shared';
import { directSessionTargetForProvider } from './provider-models';

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

function providerFixture(input: Pick<Provider, 'id' | 'name' | 'baseURL'>): Provider {
  return {
    ...input,
    apiFormat: 'responses',
    models: [{ customName: 'Same Model', model: 'same-model' }],
    selectedModel: 'Same Model',
    updatedAt: 1,
  };
}
