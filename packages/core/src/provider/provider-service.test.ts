import { describe, expect, it } from 'vitest';
import type { Provider } from '@codex-key-switcher/shared';
import { ProviderService, type CredentialStore, type ProviderRepository } from './provider-service';

describe('ProviderService', () => {
  it('switches providers after migrating a legacy selected key credential', async () => {
    const repository = new MemoryProviderRepository([
      providerFixture({
        id: 'provider-1',
        keys: [{ id: 'secondary', keyPreview: 'sk...old', enabled: true }],
        selectedKeyId: 'secondary',
      }),
    ]);
    const credentials = new MemoryCredentialStore([
      ['provider-1:secondary', 'sk-legacy-selected'],
    ]);
    const service = new ProviderService(repository, credentials);

    await expect(service.setCurrent('provider-1')).resolves.toBeUndefined();

    await expect(credentials.get('provider-1')).resolves.toBe('sk-legacy-selected');
    await expect(repository.getCurrentId()).resolves.toBe('provider-1');
  });

  it('switches providers after migrating an embedded legacy apiKeys entry', async () => {
    const repository = new MemoryProviderRepository([
      providerFixture({
        id: 'provider-2',
        apiKeys: [
          { id: 'disabled', apiKey: 'sk-disabled', enabled: false },
          { id: 'enabled', apiKey: 'sk-enabled', enabled: true },
        ],
        selectedKeyId: 'enabled',
      }),
    ]);
    const credentials = new MemoryCredentialStore();
    const service = new ProviderService(repository, credentials);

    await expect(service.setCurrent('provider-2')).resolves.toBeUndefined();

    await expect(credentials.get('provider-2')).resolves.toBe('sk-enabled');
    await expect(repository.getCurrentId()).resolves.toBe('provider-2');
  });

  it('normalizes the legacy model field when selectedModel is missing', async () => {
    const repository = new MemoryProviderRepository([
      providerFixture({
        id: 'provider-3',
        selectedModel: undefined,
        model: 'gpt-4.1-mini',
      }),
    ]);
    const service = new ProviderService(repository, new MemoryCredentialStore([
      ['provider-3', 'sk-current'],
    ]));

    await expect(service.list()).resolves.toMatchObject([
      { id: 'provider-3', selectedModel: 'Mini' },
    ]);
  });

  it('does not read local credentials while listing provider metadata', async () => {
    const repository = new MemoryProviderRepository([
      providerFixture({
        id: 'provider-4',
        keyPreview: '本地已保存',
      }),
    ]);
    const credentials = new MemoryCredentialStore([
      ['provider-4', 'sk-current'],
    ]);
    const service = new ProviderService(repository, credentials);

    await expect(service.list()).resolves.toMatchObject([
      { id: 'provider-4', keyPreview: '本地已保存' },
    ]);
    await expect(service.current()).resolves.toMatchObject({ id: 'provider-4' });
    await expect(service.routingProviders()).resolves.toMatchObject([{ id: 'provider-4' }]);

    expect(credentials.reads).toBe(0);
  });

  it('rolls back a newly written credential when provider persistence fails', async () => {
    const repository = new FailingProviderRepository([]);
    const credentials = new MemoryCredentialStore();
    const service = new ProviderService(repository, credentials);

    await expect(service.upsert({
      id: 'provider-new',
      name: 'New Provider',
      apiKey: 'sk-new',
      baseURL: 'https://api.example.com/v1',
      apiFormat: 'responses',
      models: [{ customName: 'GPT 4.1', model: 'gpt-4.1' }],
    })).rejects.toThrow('provider persistence failed');

    await expect(credentials.get('provider-new')).resolves.toBeNull();
    await expect(repository.list()).resolves.toEqual([]);
  });

  it('restores the previous credential when editing fails to persist', async () => {
    const repository = new FailingOnceProviderRepository([providerFixture({ id: 'provider-existing' })]);
    const credentials = new MemoryCredentialStore([
      ['provider-existing', 'sk-old'],
    ]);
    const service = new ProviderService(repository, credentials);

    await expect(service.upsert({
      id: 'provider-existing',
      name: 'Updated Provider',
      apiKey: 'sk-new',
      baseURL: 'https://api.example.com/v1',
      apiFormat: 'responses',
      models: [{ customName: 'GPT 4.1', model: 'gpt-4.1' }],
    })).rejects.toThrow('provider persistence failed');

    await expect(credentials.get('provider-existing')).resolves.toBe('sk-old');
    await expect(repository.list()).resolves.toMatchObject([
      { id: 'provider-existing', name: 'Provider' },
    ]);
  });
});

class MemoryProviderRepository implements ProviderRepository {
  private providers: Provider[];
  private currentId: string | null;

  constructor(providers: Provider[]) {
    this.providers = providers;
    this.currentId = providers[0]?.id ?? null;
  }

  async list(): Promise<Provider[]> {
    return this.providers.map((provider) => ({ ...provider }));
  }

  async save(provider: Provider): Promise<void> {
    const index = this.providers.findIndex((item) => item.id === provider.id);
    if (index >= 0) this.providers[index] = provider;
    else this.providers.push(provider);
  }

  async delete(id: string): Promise<void> {
    this.providers = this.providers.filter((provider) => provider.id !== id);
    if (this.currentId === id) this.currentId = this.providers[0]?.id ?? null;
  }

  async getCurrentId(): Promise<string | null> {
    return this.currentId;
  }

  async setCurrentId(id: string): Promise<void> {
    this.currentId = id;
  }
}

class FailingProviderRepository extends MemoryProviderRepository {
  override async save(_provider: Provider): Promise<void> {
    throw new Error('provider persistence failed');
  }
}

class FailingOnceProviderRepository extends MemoryProviderRepository {
  private failed = false;

  override async save(provider: Provider): Promise<void> {
    if (!this.failed) {
      this.failed = true;
      throw new Error('provider persistence failed');
    }
    await super.save(provider);
  }
}

class MemoryCredentialStore implements CredentialStore {
  private readonly values: Map<string, string>;
  reads = 0;

  constructor(entries: Array<[string, string]> = []) {
    this.values = new Map(entries);
  }

  async get(providerId: string): Promise<string | null> {
    this.reads += 1;
    return this.values.get(providerId) ?? null;
  }

  async set(providerId: string, apiKey: string): Promise<void> {
    this.values.set(providerId, apiKey);
  }

  async delete(providerId: string): Promise<void> {
    this.values.delete(providerId);
  }
}

type ProviderFixtureInput = Omit<Partial<Provider>, 'id' | 'selectedModel'> & {
  id: string;
  apiKey?: string;
  apiKeys?: Array<{ id?: string; apiKey?: string; keyPreview?: string; enabled?: boolean }>;
  keys?: Array<{ id?: string; apiKey?: string; keyPreview?: string; enabled?: boolean }>;
  model?: string;
  selectedKeyId?: string;
  selectedModel?: string | undefined;
};

function providerFixture(input: ProviderFixtureInput): Provider {
  const { id, ...overrides } = input;
  return {
    id,
    name: 'Provider',
    baseURL: 'https://api.example.com/v1',
    apiFormat: 'responses',
    models: [
      { customName: 'GPT 4.1', model: 'gpt-4.1' },
      { customName: 'Mini', model: 'gpt-4.1-mini' },
    ],
    selectedModel: 'GPT 4.1',
    updatedAt: 1,
    ...overrides,
  } as Provider;
}
