import type { DirectSessionTarget, Provider, ProviderModel } from '@codex-key-switcher/shared';

export function modelCustomName(model: ProviderModel): string {
  const customName = model.customName.trim();
  const upstreamModel = model.model.trim();
  return customName || upstreamModel;
}

export function providerCatalogSlug(provider: Provider, model: ProviderModel): string {
  const customName = modelCustomName(model);
  const providerId = provider.id.trim();
  if (!customName) return '';
  if (!providerId) return customName;

  const shortId = providerId.slice(0, 8).toLowerCase();
  const safeName = [...customName]
    .map((character) => /[a-zA-Z0-9._-]/.test(character) ? character : '-')
    .join('')
    .toLowerCase();
  const sameSlugCount = provider.models.filter((candidate) => {
    const candidateName = [...modelCustomName(candidate)]
      .map((character) => /[a-zA-Z0-9._-]/.test(character) ? character : '-')
      .join('')
      .toLowerCase();
    return candidateName === safeName;
  }).length;
  const collisionSuffix = sameSlugCount > 1 ? `-${stableModelHash(model.model)}` : '';
  return `ks-${shortId}-${safeName}${collisionSuffix}`;
}

function stableModelHash(value: string): string {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash.toString(36).slice(0, 6).padStart(6, '0');
}

export function providerSelectedModel(provider: Provider): ProviderModel | null {
  const selected = provider.selectedModel.trim();
  if (selected) {
    for (const model of provider.models) {
      const customName = modelCustomName(model);
      const upstreamModel = model.model.trim();
      const catalogSlug = providerCatalogSlug(provider, model);
      if (selected === catalogSlug || selected === customName || selected === upstreamModel) {
        return model;
      }
    }
  }

  return provider.models[0] ?? null;
}

export function providerModelForCatalogModel(provider: Provider, catalogModel: string): ProviderModel | null {
  const requested = catalogModel.trim();
  if (!requested) return null;

  return provider.models.find((model) => {
    const customName = modelCustomName(model);
    return requested === providerCatalogSlug(provider, model)
      || requested === customName
      || requested === model.model.trim();
  }) ?? null;
}

export function providerSelectedCatalogModel(provider: Provider): string {
  const model = providerSelectedModel(provider);
  return model ? providerCatalogSlug(provider, model) : 'gpt-4.1';
}

export function providerSelectedDisplayModel(provider: Provider): string {
  const model = providerSelectedModel(provider);
  return model ? modelCustomName(model) : 'gpt-4.1';
}

export function directSessionTargetForProvider(provider: Provider, appliedAt = Date.now()): DirectSessionTarget {
  const selectedModel = providerSelectedModel(provider);
  const modelName = selectedModel?.model.trim() || provider.selectedModel.trim();
  const displayModel = providerSelectedDisplayModel(provider);
  return {
    id: `${provider.id}:${modelName}`,
    providerId: provider.id,
    providerName: provider.name,
    baseURL: provider.baseURL,
    modelName,
    displayModel,
    appliedAt,
  };
}
