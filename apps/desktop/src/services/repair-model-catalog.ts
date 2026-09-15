import fs from 'node:fs/promises';
import path from 'node:path';
import { completeModelCatalogEntry } from './model-catalog-service';
import { writeJsonFile } from './json-file';

const file = process.argv[2];
if (!file) throw new Error('Usage: repair-model-catalog.ts <catalog-path> [output-path]');
const output = process.argv[3] ?? file;
const payload: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
if (!payload || typeof payload !== 'object' || !('models' in payload) || !Array.isArray(payload.models)) {
  throw new Error('Invalid model catalog');
}
const models = payload.models.map((model: unknown) => {
  if (!model || typeof model !== 'object' || Array.isArray(model)) throw new Error('Invalid catalog entry');
  return completeModelCatalogEntry(model as Record<string, unknown>);
});
if (path.resolve(file) === path.resolve(output)) {
  const backup = `${file}.backup-${Date.now()}`;
  await fs.copyFile(file, backup, fs.constants.COPYFILE_EXCL);
  process.stdout.write(`Backup: ${backup}\n`);
}
await writeJsonFile(output, { ...payload, models });
process.stdout.write(`Completed required fields for ${models.length} models: ${output}\n`);
