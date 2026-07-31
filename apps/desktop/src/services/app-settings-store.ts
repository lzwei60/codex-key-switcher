import path from 'node:path';
import { readJsonFile, writeJsonFile } from './json-file';

type SettingsPayload = Record<string, string | number | boolean>;

export class AppSettingsStore {
  private loaded = false;
  private values: SettingsPayload = {};
  private readonly filePath: string;

  constructor(dataDirectory: string) {
    this.filePath = path.join(dataDirectory, 'settings.json');
  }

  async getString(key: string): Promise<string | null> {
    await this.load();
    const value = this.values[key];
    return typeof value === 'string' && value.trim() ? value : null;
  }

  async setString(key: string, value: string): Promise<void> {
    await this.load();
    this.values[key] = value;
    await this.persist();
  }

  async getBoolean(key: string): Promise<boolean | null> {
    await this.load();
    const value = this.values[key];
    return typeof value === 'boolean' ? value : null;
  }

  async setBoolean(key: string, value: boolean): Promise<void> {
    await this.load();
    this.values[key] = value;
    await this.persist();
  }

  async getNumber(key: string): Promise<number | null> {
    await this.load();
    const value = this.values[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  async setNumber(key: string, value: number): Promise<void> {
    await this.load();
    this.values[key] = value;
    await this.persist();
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.values = await readJsonFile<SettingsPayload>(this.filePath, {});
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await writeJsonFile(this.filePath, this.values);
  }
}
