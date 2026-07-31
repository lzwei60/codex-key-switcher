import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await chmodIfSupported(directory, 0o700);
}

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    await fs.access(filePath, constants.R_OK);
    const data = await fs.readFile(filePath, 'utf8');
    if (!data.trim()) return fallback;
    return JSON.parse(data) as T;
  } catch (error) {
    if (isMissingFileError(error)) return fallback;
    throw error;
  }
}

export async function writeJsonFile(filePath: string, value: unknown, mode = 0o600): Promise<void> {
  const directory = path.dirname(filePath);
  await ensurePrivateDirectory(directory);

  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  const data = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(temporaryPath, data, { encoding: 'utf8', mode });
  await chmodIfSupported(temporaryPath, mode);
  try {
    await ensurePrivateDirectory(directory);
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    await ensurePrivateDirectory(directory);
    await fs.writeFile(filePath, data, { encoding: 'utf8', mode });
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  await chmodIfSupported(filePath, mode);
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

async function chmodIfSupported(filePath: string, mode: number): Promise<void> {
  if (process.platform === 'win32') return;
  await fs.chmod(filePath, mode).catch(() => undefined);
}
