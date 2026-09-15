import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const catalog = path.resolve(process.argv[2]);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cksw-catalog-qa-'));
const parsed = JSON.parse(await fs.readFile(catalog, 'utf8'));
assert(parsed.models.length > 0);
const child = spawn(process.env.CODEX_BINARY ?? 'codex', [
  'app-server', '--listen', 'stdio://',
  '-c', `model_catalog_json=${JSON.stringify(catalog)}`,
  '-c', 'model_provider="qa"',
  '-c', 'model_providers.qa={name="QA",base_url="http://127.0.0.1:1/v1",wire_api="responses"}',
], { cwd: root, env: { ...process.env, CODEX_HOME: root }, stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
let id = 0;
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk; });
createInterface({ input: child.stdout }).on('line', (line) => {
  let payload;
  try { payload = JSON.parse(line); } catch { return; }
  const entry = pending.get(payload.id);
  if (!entry) return;
  pending.delete(payload.id);
  if (payload.error) entry.reject(new Error(JSON.stringify(payload.error)));
  else entry.resolve(payload.result);
});
child.on('exit', () => { for (const entry of pending.values()) entry.reject(new Error(stderr || 'Codex exited')); });
function rpc(method, params) {
  const requestId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
  });
}
const timeout = setTimeout(() => child.kill('SIGKILL'), 30000);
try {
  await rpc('initialize', { clientInfo: { name: 'catalog_qa', version: '1.0.0' } });
  child.stdin.write('{"method":"initialized"}\n');
  const models = await rpc('model/list', { includeHidden: true });
  for (const model of parsed.models) {
    assert(models.data.some((item) => item.model === model.slug || item.id === model.slug), `Missing model ${model.slug}`);
    const result = await rpc('thread/start', { model: model.slug, cwd: root, ephemeral: true, approvalPolicy: 'never' });
    assert(result.thread.id);
    console.log(`PASS catalog parse and thread/start: ${model.slug}`);
  }
  console.log(`PASS ${parsed.models.length} models; no turn/start or paid generation requested`);
} finally {
  clearTimeout(timeout);
  child.kill('SIGTERM');
}
