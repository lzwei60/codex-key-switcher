import path from 'node:path';
import { safeStorage } from 'electron';
import type { CredentialStore } from '@codex-key-switcher/core';
import { readJsonFile, writeJsonFile } from './json-file';

interface StoredCredential {
  value: string;
  encrypted: boolean;
  updatedAt: number;
}

type CredentialPayload = Record<string, StoredCredential | string>;

export class CredentialFileStore implements CredentialStore {
  private loaded = false;
  private values = new Map<string, StoredCredential>();
  private readonly filePath: string;

  constructor(private readonly dataDirectory: string) {
    this.filePath = path.join(dataDirectory, 'api-keys.json');
  }

  async get(providerId: string): Promise<string | null> {
    await this.load();
    const id = normalizeProviderId(providerId);
    if (!id) return null;

    const credential = this.values.get(id);
    if (!credential) return null;
    if (!credential.encrypted) return credential.value;

    try {
      return safeStorage.decryptString(Buffer.from(credential.value, 'base64'));
    } catch {
      return null;
    }
  }

  async set(providerId: string, apiKey: string): Promise<void> {
    await this.load();
    const id = normalizeProviderId(providerId);
    if (!id) throw new Error('配置 ID 为空，无法保存 API Key。');
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('当前系统加密能力不可用，无法安全保存 API Key。');
    }

    this.values.set(id, {
      value: encodeApiKey(apiKey),
      encrypted: true,
      updatedAt: Date.now(),
    });
    await this.persist();
  }

  async delete(providerId: string): Promise<void> {
    await this.load();
    const id = normalizeProviderId(providerId);
    if (!id) return;

    this.values.delete(id);
    await this.persist();
  }

  private async load(): Promise<void> {
    if (this.loaded) return;

    const payload = await readJsonFile<CredentialPayload>(this.filePath, {});
    this.values = new Map();
    for (const [providerId, stored] of Object.entries(payload)) {
      const normalizedId = normalizeProviderId(providerId);
      if (!normalizedId) continue;

      if (typeof stored === 'string') {
        this.values.set(normalizedId, {
          value: stored,
          encrypted: false,
          updatedAt: 0,
        });
      } else if (stored && typeof stored.value === 'string') {
        this.values.set(normalizedId, {
          value: stored.value,
          encrypted: Boolean(stored.encrypted),
          updatedAt: Number(stored.updatedAt) || 0,
        });
      }
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const payload: Record<string, StoredCredential> = {};
    for (const [providerId, credential] of this.values.entries()) {
      payload[providerId] = credential;
    }
    await writeJsonFile(this.filePath, payload);
  }
}

function normalizeProviderId(providerId: string): string {
  return providerId.trim();
}

function encodeApiKey(apiKey: string): string {
  return safeStorage.encryptString(apiKey).toString('base64');
}
