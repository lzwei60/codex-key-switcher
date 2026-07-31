import fs from 'node:fs/promises';
import path from 'node:path';
import type { CodexConfigAdapter } from '@codex-key-switcher/core';
import type { AppSettingsStore } from './app-settings-store';
import { ensurePrivateDirectory } from './json-file';

const managedBackupSuffix = '.codex-key-switcher.bak';
const legacyBackupSuffix = '.bak';
const defaultProviderName = 'openai';
const managedProxyAppliedKey = 'managedProxyApplied';
const managedProxyEndpointKey = 'managedProxyEndpoint';
const managedConnectionModeKey = 'managedConnectionMode';
const managedCodexProviderNameKey = 'managedCodexProviderName';
const localGatewayAPIKeyKey = 'localGatewayAPIKey';

export class CodexFileConfigAdapter implements CodexConfigAdapter {
  constructor(
    private readonly settings: AppSettingsStore,
    private readonly homeDirectory: string,
    private readonly appDataDirectory: string,
  ) {}

  async getCodexDirectory(): Promise<string> {
    return await this.settings.getString('codexConfigDir') ?? path.join(this.homeDirectory, '.codex');
  }

  async applyLocalGateway(input: { endpoint: string; localApiKey: string; model: string }): Promise<void> {
    const configPath = await this.configPath();
    const authPath = await this.authPath();

    const originalConfig = await fs.readFile(configPath, 'utf8');
    const originalAuth = await fs.readFile(authPath, 'utf8');
    const updatedConfig = await this.updatedConfigText(originalConfig, input.endpoint, input.model, 'responses');
    const updatedAuth = updatedAuthText(originalAuth, input.localApiKey);

    if (updatedConfig === originalConfig && updatedAuth === originalAuth) {
      await this.writeRestoreScript();
      await this.markManagedProxyApplied(input.endpoint);
      return;
    }

    await this.backupFileIfNeeded(configPath);
    await this.backupFileIfNeeded(authPath);
    await this.writeRestoreScript();

    await fs.writeFile(configPath, updatedConfig, 'utf8');
    try {
      await fs.writeFile(authPath, updatedAuth, 'utf8');
    } catch (error) {
      await fs.writeFile(configPath, originalConfig, 'utf8').catch(() => undefined);
      await fs.writeFile(authPath, originalAuth, 'utf8').catch(() => undefined);
      throw error;
    }

    await this.markManagedProxyApplied(input.endpoint);
  }

  async applyDirectProvider(input: { baseURL: string; apiKey: string; model: string }): Promise<void> {
    const configPath = await this.configPath();
    const authPath = await this.authPath();

    const originalConfig = await fs.readFile(configPath, 'utf8');
    const originalAuth = await fs.readFile(authPath, 'utf8');
    const updatedConfig = await this.updatedConfigText(originalConfig, input.baseURL, input.model, 'responses');
    const updatedAuth = updatedAuthText(originalAuth, input.apiKey);

    if (updatedConfig === originalConfig && updatedAuth === originalAuth) {
      await this.writeRestoreScript();
      await this.markManagedDirectProviderApplied(input.baseURL);
      return;
    }

    await this.backupFileIfNeeded(configPath);
    await this.backupFileIfNeeded(authPath);
    await this.writeRestoreScript();

    await fs.writeFile(configPath, updatedConfig, 'utf8');
    try {
      await fs.writeFile(authPath, updatedAuth, 'utf8');
    } catch (error) {
      await fs.writeFile(configPath, originalConfig, 'utf8').catch(() => undefined);
      await fs.writeFile(authPath, originalAuth, 'utf8').catch(() => undefined);
      throw error;
    }

    await this.markManagedDirectProviderApplied(input.baseURL);
  }

  async restoreManagedBackup(): Promise<void> {
    await this.restoreManagedBackupForDirectory(await this.getCodexDirectory());
  }

  async restoreManagedBackupForDirectory(directory: string): Promise<void> {
    const configPath = this.configPathForDirectory(directory);
    const authPath = this.authPathForDirectory(directory);
    const configBackupPath = await this.existingBackupPath(configPath);
    const authBackupPath = await this.existingBackupPath(authPath);

    const managedApplied = await this.settings.getBoolean(managedProxyAppliedKey);
    if (!configBackupPath && !authBackupPath && !managedApplied) {
      await this.clearManagedProxyApplied();
      return;
    }

    if (!configBackupPath || !authBackupPath) {
      throw new Error('未找到完整的 Codex 配置备份，无法自动恢复。');
    }

    const backupConfig = await fs.readFile(configBackupPath);
    const backupAuth = await fs.readFile(authBackupPath);

    const currentConfig = await readOptionalFile(configPath);
    const currentAuth = await readOptionalFile(authPath);

    await fs.writeFile(configPath, backupConfig);
    try {
      await fs.writeFile(authPath, backupAuth);
    } catch (error) {
      await restoreSnapshot(configPath, currentConfig);
      await restoreSnapshot(authPath, currentAuth);
      throw error;
    }

    await Promise.all([
      fs.rm(configBackupPath, { force: true }),
      fs.rm(authBackupPath, { force: true }),
    ]);
    await this.clearManagedProxyApplied();
  }

  async configUsesLocalGateway(): Promise<boolean> {
    const applied = await this.settings.getBoolean(managedProxyAppliedKey);
    if (!applied) return false;
    const managedConnectionMode = await this.settings.getString(managedConnectionModeKey);
    if (managedConnectionMode === 'direct_provider') return false;

    const config = await fs.readFile(await this.configPath(), 'utf8').catch(() => '');
    if (!config) return false;
    const endpoint = await this.settings.getString(managedProxyEndpointKey);
    return !endpoint || config.includes(endpoint) || config.includes('codex-key-switcher');
  }

  async configuredModel(): Promise<string | null> {
    const config = await fs.readFile(await this.configPath(), 'utf8').catch(() => '');
    if (!config) return null;

    let insideAnySection = false;
    for (const line of splitLines(config)) {
      const trimmed = line.trim();
      const isSection = trimmed.startsWith('[') && trimmed.endsWith(']');
      if (isSection) {
        insideAnySection = true;
        continue;
      }
      if (!insideAnySection && tomlLineHasKey(trimmed, 'model')) {
        return tomlValueForLine(trimmed);
      }
    }
    return null;
  }

  async localGatewayAPIKey(): Promise<string> {
    const stored = await this.settings.getString(localGatewayAPIKeyKey);
    if (stored) return stored;

    const value = `cksw-${crypto.randomUUID()}`;
    await this.settings.setString(localGatewayAPIKeyKey, value);
    return value;
  }

  async summary(endpoint: string): Promise<string> {
    return `本地路由代理：${endpoint}，Codex 固定连接此地址。`;
  }

  // Codex still talks to the configured provider through its Responses wire API.
  // Chat/Anthropic upstreams are normalized by the local gateway before this file is involved.
  private async updatedConfigText(configText: string, endpoint: string, model: string, wireAPI: 'responses'): Promise<string> {
    const modelProviderName = await this.managedProviderNameForConfigText(configText);
    const lines = splitLines(configText).map(redactSensitiveComment);
    const modelLine = `model = ${tomlString(model || 'gpt-4.1')}`;
    const providerLine = `model_provider = ${tomlString(modelProviderName)}`;
    const reasoningEffortLine = 'model_reasoning_effort = "high"';
    const baseURLLine = `base_url = ${tomlString(endpoint)}`;
    const wireAPILine = `wire_api = ${tomlString(wireAPI)}`;

    let updatedTopLevelModel = false;
    let updatedTopLevelReasoningEffort = false;
    let hasModelProviderLine = false;
    let insideAnySection = false;
    let insideTargetSection = false;
    let foundTargetSection = false;
    let updatedBaseURL = false;
    let updatedWireAPI = false;
    let targetSectionInsertIndex = -1;
    const duplicateTopLevelIndexes: number[] = [];

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? '';
      const trimmed = line.trim();
      const isSection = trimmed.startsWith('[') && trimmed.endsWith(']');

      if (isSection) {
        insideAnySection = true;
        if (insideTargetSection && (!updatedBaseURL || !updatedWireAPI)) {
          targetSectionInsertIndex = index;
        }
        insideTargetSection = sectionHeaderMatchesProviderName(line, modelProviderName);
        if (insideTargetSection) foundTargetSection = true;
      }

      if (!insideAnySection && !isSection && tomlLineHasKey(trimmed, 'model_provider')) {
        lines[index] = providerLine;
        hasModelProviderLine = true;
        continue;
      }

      if (!insideAnySection && !isSection && tomlLineHasKey(trimmed, 'model')) {
        if (!updatedTopLevelModel) {
          lines[index] = modelLine;
          updatedTopLevelModel = true;
        } else {
          duplicateTopLevelIndexes.push(index);
        }
        continue;
      }

      if (!insideAnySection && !isSection && tomlLineHasKey(trimmed, 'model_reasoning_effort')) {
        lines[index] = reasoningEffortLine;
        updatedTopLevelReasoningEffort = true;
        continue;
      }

      if (insideTargetSection && !isSection && tomlLineHasKey(trimmed, 'base_url')) {
        lines[index] = baseURLLine;
        updatedBaseURL = true;
      }

      if (insideTargetSection && !isSection && tomlLineHasKey(trimmed, 'wire_api')) {
        lines[index] = wireAPILine;
        updatedWireAPI = true;
      }
    }

    for (const index of duplicateTopLevelIndexes.reverse()) {
      lines.splice(index, 1);
    }

    if (!hasModelProviderLine) lines.unshift(providerLine);
    if (!updatedTopLevelModel) lines.splice(hasModelProviderLine ? 1 : 0, 0, modelLine);
    if (!updatedTopLevelReasoningEffort) {
      const insertIndex = lines.findIndex((line) => tomlLineHasKey(line.trim(), 'model')) + 1;
      lines.splice(insertIndex > 0 ? insertIndex : 1, 0, reasoningEffortLine);
    }

    if (foundTargetSection && !updatedBaseURL) {
      if (targetSectionInsertIndex < 0) lines.push(baseURLLine);
      else lines.splice(targetSectionInsertIndex++, 0, baseURLLine);
    }
    if (foundTargetSection && !updatedWireAPI) {
      if (targetSectionInsertIndex < 0) lines.push(wireAPILine);
      else lines.splice(targetSectionInsertIndex, 0, wireAPILine);
    }

    if (!foundTargetSection) {
      lines.push('', `[model_providers.${modelProviderName}]`, `name = ${tomlString(modelProviderName)}`, baseURLLine, wireAPILine);
    }

    return lines.join('\n');
  }

  private async managedProviderNameForConfigText(configText: string): Promise<string> {
    const currentProviderName = activeModelProviderNameInConfig(configText);
    if (currentProviderName && !isLegacyLocalGatewayProviderName(currentProviderName)) {
      await this.settings.setString(managedCodexProviderNameKey, currentProviderName);
      return currentProviderName;
    }

    const storedProviderName = await this.settings.getString(managedCodexProviderNameKey);
    if (storedProviderName && !isLegacyLocalGatewayProviderName(storedProviderName)) return storedProviderName;

    const backupProviderName = await this.providerNameFromBackupConfig();
    if (backupProviderName) {
      await this.settings.setString(managedCodexProviderNameKey, backupProviderName);
      return backupProviderName;
    }

    return defaultProviderName;
  }

  private async providerNameFromBackupConfig(): Promise<string | null> {
    const backupPath = await this.existingBackupPath(await this.configPath());
    if (!backupPath) return null;

    const backupText = await fs.readFile(backupPath, 'utf8').catch(() => '');
    const providerName = activeModelProviderNameInConfig(backupText);
    if (!providerName || isLegacyLocalGatewayProviderName(providerName)) return null;
    return providerName;
  }

  private async writeRestoreScript(): Promise<void> {
    const configPath = await this.configPath();
    const authPath = await this.authPath();
    const isWindows = process.platform === 'win32';
    const scriptPath = path.join(this.appDataDirectory, `restore-codex-config.${isWindows ? 'cmd' : 'command'}`);
    const script = isWindows
      ? windowsRestoreScript(configPath, authPath)
      : shellRestoreScript(configPath, authPath);
    await ensurePrivateDirectory(this.appDataDirectory);
    await fs.writeFile(scriptPath, script, { encoding: 'utf8', mode: 0o700 });
    if (!isWindows) await fs.chmod(scriptPath, 0o700).catch(() => undefined);
  }

  private async backupFileIfNeeded(filePath: string): Promise<void> {
    const exists = await pathExists(filePath);
    if (!exists) return;

    const backupPath = `${filePath}${managedBackupSuffix}`;
    await fs.rm(backupPath, { force: true });
    await fs.copyFile(filePath, backupPath);
  }

  private async existingBackupPath(filePath: string): Promise<string | null> {
    const managed = `${filePath}${managedBackupSuffix}`;
    if (await pathExists(managed)) return managed;

    const legacy = `${filePath}${legacyBackupSuffix}`;
    if (await pathExists(legacy)) return legacy;
    return null;
  }

  private async configPath(): Promise<string> {
    return this.configPathForDirectory(await this.getCodexDirectory());
  }

  private async authPath(): Promise<string> {
    return this.authPathForDirectory(await this.getCodexDirectory());
  }

  private configPathForDirectory(directory: string): string {
    return path.join(directory, 'config.toml');
  }

  private authPathForDirectory(directory: string): string {
    return path.join(directory, 'auth.json');
  }

  private async markManagedProxyApplied(endpoint: string): Promise<void> {
    await this.settings.setBoolean(managedProxyAppliedKey, true);
    await this.settings.setString(managedProxyEndpointKey, endpoint);
    await this.settings.setString(managedConnectionModeKey, 'local_gateway');
  }

  private async markManagedDirectProviderApplied(baseURL: string): Promise<void> {
    await this.settings.setBoolean(managedProxyAppliedKey, true);
    await this.settings.setString(managedProxyEndpointKey, baseURL);
    await this.settings.setString(managedConnectionModeKey, 'direct_provider');
  }

  private async clearManagedProxyApplied(): Promise<void> {
    await this.settings.setBoolean(managedProxyAppliedKey, false);
    await this.settings.setString(managedConnectionModeKey, '');
  }
}

function shellRestoreScript(configPath: string, authPath: string): string {
  return [
    '#!/bin/zsh',
    'set -euo pipefail',
    '',
    `CONFIG=${shellSingleQuotedString(configPath)}`,
    `AUTH=${shellSingleQuotedString(authPath)}`,
    `CONFIG_BAK="${'${CONFIG}'}${managedBackupSuffix}"`,
    `AUTH_BAK="${'${AUTH}'}${managedBackupSuffix}"`,
    'STAMP=$(date +%Y%m%d%H%M%S)',
    '',
    'if [[ ! -f "$CONFIG_BAK" || ! -f "$AUTH_BAK" ]]; then',
    '  echo "Missing Codex Key Switcher backup files."',
    '  exit 1',
    'fi',
    '',
    '[[ -f "$CONFIG" ]] && cp "$CONFIG" "${CONFIG}.before-restore.${STAMP}"',
    '[[ -f "$AUTH" ]] && cp "$AUTH" "${AUTH}.before-restore.${STAMP}"',
    'cp "$CONFIG_BAK" "$CONFIG"',
    'cp "$AUTH_BAK" "$AUTH"',
    'rm -f "$CONFIG_BAK" "$AUTH_BAK"',
    'echo "Codex config restored. Restart Codex to apply it."',
    '',
  ].join('\n');
}

function windowsRestoreScript(configPath: string, authPath: string): string {
  const config = windowsBatchQuotedString(configPath);
  const auth = windowsBatchQuotedString(authPath);
  return [
    '@echo off',
    'setlocal enabledelayedexpansion',
    `set "CONFIG=${config}"`,
    `set "AUTH=${auth}"`,
    `set "CONFIG_BAK=${config}${managedBackupSuffix}"`,
    `set "AUTH_BAK=${auth}${managedBackupSuffix}"`,
    'if not exist "%CONFIG_BAK%" (',
    '  echo Missing Codex Key Switcher config backup file.',
    '  exit /b 1',
    ')',
    'if not exist "%AUTH_BAK%" (',
    '  echo Missing Codex Key Switcher auth backup file.',
    '  exit /b 1',
    ')',
    'if exist "%CONFIG%" copy /Y "%CONFIG%" "%CONFIG%.before-restore" >nul',
    'if exist "%AUTH%" copy /Y "%AUTH%" "%AUTH%.before-restore" >nul',
    'copy /Y "%CONFIG_BAK%" "%CONFIG%" >nul',
    'copy /Y "%AUTH_BAK%" "%AUTH%" >nul',
    'del /F /Q "%CONFIG_BAK%" >nul 2>nul',
    'del /F /Q "%AUTH_BAK%" >nul 2>nul',
    'echo Codex config restored. Restart Codex to apply it.',
    'endlocal',
    '',
  ].join('\r\n');
}

function updatedAuthText(authText: string, apiKey: string): string {
  const payload = JSON.parse(authText) as Record<string, unknown>;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('auth.json 不是合法 JSON 对象。');
  }

  payload.auth_mode = 'apikey';
  payload.OPENAI_API_KEY = apiKey;
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

function tomlString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function redactSensitiveComment(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith('#')) return line;
  const lower = trimmed.toLowerCase();
  const mentionsAPIKey = lower.includes('openai_api_key') || lower.includes('api_key') || lower.includes('api-key');
  if (!mentionsAPIKey) return line;

  const equalIndex = line.indexOf('=');
  if (equalIndex < 0) return '# API key redacted by Codex Key Switcher';
  return `${line.slice(0, equalIndex + 1)} "<redacted>"`;
}

function tomlLineHasKey(line: string, key: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return false;
  const equalIndex = trimmed.indexOf('=');
  if (equalIndex < 0) return false;
  return trimmed.slice(0, equalIndex).trim() === key;
}

function tomlValueForLine(line: string): string | null {
  const equalIndex = line.indexOf('=');
  if (equalIndex < 0) return null;
  const raw = line.slice(equalIndex + 1).trim();
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) return raw.slice(1, -1);
  return raw || null;
}

function activeModelProviderNameInConfig(configText: string): string | null {
  for (const line of splitLines(configText)) {
    if (!tomlLineHasKey(line, 'model_provider')) continue;
    return tomlValueForLine(line);
  }
  return null;
}

function isLegacyLocalGatewayProviderName(providerName: string): boolean {
  return providerName === 'codex-key-switcher';
}

function sectionHeaderMatchesProviderName(line: string, providerName: string): boolean {
  return line.trim() === `[model_providers.${providerName}]`;
}

function shellSingleQuotedString(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function windowsBatchQuotedString(value: string): string {
  return value.replaceAll('%', '%%').replaceAll('"', '');
}

async function pathExists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true).catch(() => false);
}

async function readOptionalFile(filePath: string): Promise<Buffer | null> {
  return fs.readFile(filePath).catch(() => null);
}

async function restoreSnapshot(filePath: string, data: Buffer | null): Promise<void> {
  if (data) {
    await fs.writeFile(filePath, data);
  } else if (await pathExists(filePath)) {
    await fs.unlink(filePath);
  }
}
