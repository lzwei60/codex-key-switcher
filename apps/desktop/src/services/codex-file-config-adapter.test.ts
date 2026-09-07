import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppSettingsStore } from './app-settings-store';
import { CodexFileConfigAdapter } from './codex-file-config-adapter';

const temporaryRoots: string[] = [];

describe('CodexFileConfigAdapter', () => {
  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it('restores and removes managed backups so a later user config is not overwritten by stale state', async () => {
    const root = await temporaryRoot();
    const codexDirectory = path.join(root, '.codex');
    const appDataDirectory = path.join(root, 'app-data');
    await fs.mkdir(codexDirectory, { recursive: true });
    await fs.writeFile(path.join(codexDirectory, 'config.toml'), 'model = "original"\n', 'utf8');
    await fs.writeFile(path.join(codexDirectory, 'auth.json'), '{}\n', 'utf8');

    const settings = new AppSettingsStore(appDataDirectory);
    const adapter = new CodexFileConfigAdapter(settings, root, appDataDirectory);
    await adapter.applyLocalGateway({
      endpoint: 'http://127.0.0.1:3456/v1',
      localApiKey: 'local-key',
      model: 'gpt-4.1',
    });
    await adapter.restoreManagedBackup();

    await expect(pathExists(path.join(codexDirectory, 'config.toml.codex-key-switcher.bak'))).resolves.toBe(false);
    await fs.writeFile(path.join(codexDirectory, 'config.toml'), 'model = "user-updated"\n', 'utf8');
    await adapter.applyLocalGateway({
      endpoint: 'http://127.0.0.1:3456/v1',
      localApiKey: 'local-key',
      model: 'gpt-4.1',
    });
    await adapter.restoreManagedBackup();

    await expect(fs.readFile(path.join(codexDirectory, 'config.toml'), 'utf8')).resolves.toBe('model = "user-updated"\n');
  });

  it('can restore a previously managed custom directory explicitly', async () => {
    const root = await temporaryRoot();
    const firstDirectory = path.join(root, 'first-codex');
    const appDataDirectory = path.join(root, 'app-data');
    await fs.mkdir(firstDirectory, { recursive: true });
    await fs.writeFile(path.join(firstDirectory, 'config.toml'), 'model = "before-directory-change"\n', 'utf8');
    await fs.writeFile(path.join(firstDirectory, 'auth.json'), '{}\n', 'utf8');

    const settings = new AppSettingsStore(appDataDirectory);
    await settings.setString('codexConfigDir', firstDirectory);
    const adapter = new CodexFileConfigAdapter(settings, root, appDataDirectory);
    await adapter.applyDirectProvider({
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4.1',
    });

    await settings.setString('codexConfigDir', path.join(root, 'second-codex'));
    await adapter.restoreManagedBackupForDirectory(firstDirectory);

    await expect(fs.readFile(path.join(firstDirectory, 'config.toml'), 'utf8')).resolves.toBe('model = "before-directory-change"\n');
  });

  it('writes model catalog configuration only at the TOML top level', async () => {
    const root = await temporaryRoot();
    const codexDirectory = path.join(root, '.codex');
    const appDataDirectory = path.join(root, 'app-data');
    await fs.mkdir(codexDirectory, { recursive: true });
    await fs.writeFile(path.join(codexDirectory, 'config.toml'), [
      'model_provider = "openai"',
      '',
      '[model_providers.openai]',
      'model = "section-model"',
      'base_url = "https://old.example/v1"',
      '',
    ].join('\n'), 'utf8');
    await fs.writeFile(path.join(codexDirectory, 'auth.json'), '{}\n', 'utf8');

    const settings = new AppSettingsStore(appDataDirectory);
    const adapter = new CodexFileConfigAdapter(settings, root, appDataDirectory);
    await adapter.applyDirectProvider({
      baseURL: 'https://new.example/v1',
      apiKey: 'sk-test',
      model: 'upstream-model',
      modelCatalogJSON: path.join(appDataDirectory, 'model-catalogs', 'current.json'),
    });

    const config = await fs.readFile(path.join(codexDirectory, 'config.toml'), 'utf8');
    expect(config.match(/^model_catalog_json\s*=/gm)).toHaveLength(1);
    expect(config.indexOf('model_catalog_json =')).toBeLessThan(config.indexOf('[model_providers.openai]'));
  });

  it('updates an existing top-level model catalog path without duplicating it', async () => {
    const root = await temporaryRoot();
    const codexDirectory = path.join(root, '.codex');
    const appDataDirectory = path.join(root, 'app-data');
    await fs.mkdir(codexDirectory, { recursive: true });
    await fs.writeFile(path.join(codexDirectory, 'config.toml'), [
      'model = "old-model"',
      'model_catalog_json = "/old/catalog.json"',
      'model_provider = "openai"',
      '',
    ].join('\n'), 'utf8');
    await fs.writeFile(path.join(codexDirectory, 'auth.json'), '{}\n', 'utf8');

    const settings = new AppSettingsStore(appDataDirectory);
    const adapter = new CodexFileConfigAdapter(settings, root, appDataDirectory);
    await adapter.applyLocalGateway({
      endpoint: 'http://127.0.0.1:3456/v1',
      localApiKey: 'local-key',
      model: 'new-model',
      modelCatalogJSON: '/new/catalog.json',
    });

    const config = await fs.readFile(path.join(codexDirectory, 'config.toml'), 'utf8');
    expect(config.match(/^model_catalog_json\s*=/gm)).toHaveLength(1);
    expect(config).toContain('model_catalog_json = "/new/catalog.json"');
    expect(config).not.toContain('/old/catalog.json');
  });

  it('keeps the original backup across repeated managed switches', async () => {
    const root = await temporaryRoot();
    const codexDirectory = path.join(root, '.codex');
    const appDataDirectory = path.join(root, 'app-data');
    await fs.mkdir(codexDirectory, { recursive: true });
    await fs.writeFile(path.join(codexDirectory, 'config.toml'), 'model = "original"\n', 'utf8');
    await fs.writeFile(path.join(codexDirectory, 'auth.json'), '{}\n', 'utf8');

    const settings = new AppSettingsStore(appDataDirectory);
    const adapter = new CodexFileConfigAdapter(settings, root, appDataDirectory);
    await adapter.applyLocalGateway({ endpoint: 'http://127.0.0.1:3456/v1', localApiKey: 'local-key', model: 'first' });
    await adapter.applyLocalGateway({ endpoint: 'http://127.0.0.1:3456/v1', localApiKey: 'local-key', model: 'second' });
    await adapter.restoreManagedBackup();

    await expect(fs.readFile(path.join(codexDirectory, 'config.toml'), 'utf8')).resolves.toBe('model = "original"\n');
  });

  it('generates a POSIX restore script usable on macOS and Linux', async () => {
    const root = await temporaryRoot();
    const codexDirectory = path.join(root, '.codex');
    const appDataDirectory = path.join(root, 'app-data');
    await fs.mkdir(codexDirectory, { recursive: true });
    await fs.writeFile(path.join(codexDirectory, 'config.toml'), 'model = "original"\n', 'utf8');
    await fs.writeFile(path.join(codexDirectory, 'auth.json'), '{}\n', 'utf8');

    const settings = new AppSettingsStore(appDataDirectory);
    const adapter = new CodexFileConfigAdapter(settings, root, appDataDirectory);
    await adapter.applyLocalGateway({ endpoint: 'http://127.0.0.1:3456/v1', localApiKey: 'local-key', model: 'gpt-4.1' });

    const script = await fs.readFile(path.join(appDataDirectory, 'restore-codex-config.command'), 'utf8');
    expect(script).toContain('#!/bin/sh');
    expect(script).toContain('set -eu');
    expect(script).not.toContain('pipefail');
    expect(script).not.toContain('[[ ');
  });

  it('restricts managed Codex files to the current user on POSIX systems', async () => {
    if (process.platform === 'win32') return;

    const root = await temporaryRoot();
    const codexDirectory = path.join(root, '.codex');
    const appDataDirectory = path.join(root, 'app-data');
    await fs.mkdir(codexDirectory, { recursive: true });
    await fs.writeFile(path.join(codexDirectory, 'config.toml'), 'model = "original"\n', { encoding: 'utf8', mode: 0o644 });
    await fs.writeFile(path.join(codexDirectory, 'auth.json'), '{}\n', { encoding: 'utf8', mode: 0o644 });

    const settings = new AppSettingsStore(appDataDirectory);
    const adapter = new CodexFileConfigAdapter(settings, root, appDataDirectory);
    await adapter.applyLocalGateway({ endpoint: 'http://127.0.0.1:3456/v1', localApiKey: 'local-key', model: 'gpt-4.1' });

    await expect(fileMode(path.join(codexDirectory, 'config.toml'))).resolves.toBe(0o600);
    await expect(fileMode(path.join(codexDirectory, 'auth.json'))).resolves.toBe(0o600);
    await expect(fileMode(path.join(codexDirectory, 'config.toml.codex-key-switcher.bak'))).resolves.toBe(0o600);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cksw-test-'));
  temporaryRoots.push(root);
  return root;
}

async function pathExists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true).catch(() => false);
}

async function fileMode(filePath: string): Promise<number> {
  return (await fs.stat(filePath)).mode & 0o777;
}
