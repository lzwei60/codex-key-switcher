import path from 'node:path';
import type { Provider } from '@codex-key-switcher/shared';
import type { ProviderRepository } from '@codex-key-switcher/core';
import { readJsonFile, writeJsonFile } from './json-file';

interface ProviderFilePayload {
  providers?: Provider[];
  currentId?: string;
}

export class ProviderFileRepository implements ProviderRepository {
  private providers: Provider[] = [];
  private currentId: string | null = null;
  private loaded = false;
  private loading: Promise<void> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly filePath: string;

  constructor(private readonly dataDirectory: string) {
    this.filePath = path.join(dataDirectory, 'providers.json');
  }

  async list(): Promise<Provider[]> {
    await this.load();
    return [...this.providers];
  }

  async save(provider: Provider): Promise<void> {
    await this.load();
    const index = this.providers.findIndex((item) => item.id === provider.id);
    if (index >= 0) this.providers[index] = provider;
    else this.providers.push(provider);

    this.sortProviders();
    if (!this.currentId) this.currentId = provider.id;
    await this.persist();
  }

  async delete(id: string): Promise<void> {
    await this.load();
    this.providers = this.providers.filter((provider) => provider.id !== id);
    if (this.currentId === id) {
      this.currentId = this.providers[0]?.id ?? null;
    }
    await this.persist();
  }

  async getCurrentId(): Promise<string | null> {
    await this.load();
    return this.currentId;
  }

  async setCurrentId(id: string): Promise<void> {
    await this.load();
    const exists = this.providers.some((provider) => provider.id === id);
    if (!exists) throw new Error('配置不存在。');

    this.currentId = id;
    await this.persist();
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loading ??= readJsonFile<ProviderFilePayload>(this.filePath, {}).then((payload) => {
      this.providers = Array.isArray(payload.providers) ? payload.providers.filter(isProviderLike) : [];
      this.currentId = typeof payload.currentId === 'string' && payload.currentId.trim()
        ? payload.currentId.trim()
        : null;
      this.repairCurrentProviderSelection();
      this.sortProviders();
      this.loaded = true;
    });
    await this.loading;
  }

  private repairCurrentProviderSelection(): void {
    if (!this.providers.length) {
      this.currentId = null;
      return;
    }
    if (this.currentId && this.providers.some((provider) => provider.id === this.currentId)) return;
    this.currentId = this.providers[0]?.id ?? null;
  }

  private sortProviders(): void {
    this.providers.sort((left, right) => left.updatedAt - right.updatedAt);
  }

  private async persist(): Promise<void> {
    const payload = {
      providers: this.providers,
      currentId: this.currentId ?? '',
    };
    const nextWrite = this.writeQueue
      .catch(() => undefined)
      .then(() => writeJsonFile(this.filePath, payload));
    this.writeQueue = nextWrite;
    await nextWrite;
  }
}

function isProviderLike(value: unknown): value is Provider {
  if (!value || typeof value !== 'object') return false;
  const provider = value as Partial<Provider>;
  return typeof provider.id === 'string'
    && typeof provider.name === 'string'
    && typeof provider.baseURL === 'string'
    && Array.isArray(provider.models);
}
