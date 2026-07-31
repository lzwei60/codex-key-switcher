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
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cksw-test-'));
  temporaryRoots.push(root);
  return root;
}

async function pathExists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true).catch(() => false);
}
