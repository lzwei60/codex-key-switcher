import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Electron's main-process and preload boundaries cannot be exercised by a
// browser-only preview. Point this script at a local playwright-core install.
const { _electron: electron } = await import(pathToFileURL(process.env.PLAYWRIGHT_CORE_PATH).href);
const executablePath = process.env.TEST_APP_EXECUTABLE ?? '/Applications/Codex Key Switcher.app/Contents/MacOS/Codex Key Switcher';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cksw-installed-qa-'));
const profile = path.join(root, 'profile');
const codex = path.join(root, 'codex');
const artifacts = path.resolve('output/playwright/installed-mac');
await Promise.all([fs.mkdir(profile), fs.mkdir(codex), fs.mkdir(artifacts, { recursive: true })]);
const checks = [];
const errors = [];
const requests = [];
let scenario = 'normal';
let application;
let page;
const record = (name) => { checks.push(name); console.log(`PASS ${name}`); };
const sendEvent = (response, payload) => response.write(`data: ${JSON.stringify(payload)}\r\n\r\n`);
const textItem = (text) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const server = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push({ url: request.url, body, authorization: request.headers.authorization, apiKey: request.headers['x-api-key'] });
      const chat = request.url.endsWith('/chat/completions');
      const anthropic = request.url.endsWith('/messages');
      const text = `${body.model}: synthetic answer`;
      if (!body.stream) {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(chat ? { choices: [{ message: { content: text } }] }
          : anthropic ? { content: [{ type: 'text', text }] }
            : { id: 'resp-mock', status: 'completed', output: [textItem(text)] }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (chat) sendEvent(response, { choices: [{ delta: { content: text } }] });
      else if (anthropic) sendEvent(response, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
      else sendEvent(response, { type: 'response.output_text.delta', item_id: 'msg-mock', output_index: 0, delta: text });
      if (scenario === 'truncated') { response.end(); return; }
      if (scenario === 'disconnected') { setTimeout(() => response.destroy(), 30); return; }
      if (chat) sendEvent(response, { choices: [{ delta: {}, finish_reason: 'stop' }] });
      else if (anthropic) sendEvent(response, { type: 'message_stop' });
      else {
        const tool = { id: 'fc-mock', type: 'function_call', call_id: 'call-mock', name: 'read_file', arguments: '{"path":"README.md"}', status: 'completed' };
        sendEvent(response, { type: 'response.output_item.added', output_index: 1, item: { ...tool, arguments: '', status: 'in_progress' } });
        sendEvent(response, { type: 'response.function_call_arguments.delta', item_id: tool.id, output_index: 1, delta: tool.arguments });
        sendEvent(response, { type: 'response.output_item.done', output_index: 1, item: tool });
        sendEvent(response, { type: 'response.completed', response: { id: 'resp-mock', status: 'completed', output: [tool], usage: { input_tokens: 12, output_tokens: 3 } } });
      }
      response.end('data: [DONE]\n\n');
    } catch (error) { errors.push(String(error)); response.destroy(); }
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const portProbe = http.createServer();
await new Promise((resolve) => portProbe.listen(0, '127.0.0.1', resolve));
const gatewayPort = portProbe.address().port;
await new Promise((resolve) => portProbe.close(resolve));
const provider = {
  id: 'qa-provider', name: 'Isolated QA', baseURL: `http://127.0.0.1:${port}/v1`, apiFormat: 'responses',
  selectedModel: 'GPT QA', updatedAt: 1,
  models: [
    { customName: 'GPT QA', model: 'gpt-qa' },
    { customName: 'Qwen QA', model: 'qwen-qa', apiFormat: 'chat_completions', supportsReasoning: false, supportsImages: false },
    { customName: 'Claude QA', model: 'claude-qa', apiFormat: 'anthropic_messages' },
  ],
};
await fs.writeFile(path.join(profile, 'settings.json'), JSON.stringify({ codexConfigDir: codex, routeEnabled: false, routeAutoStart: false, routeListenPort: gatewayPort, routeListenAddress: '127.0.0.1', routeConnectionMode: 'local_gateway' }));
await fs.writeFile(path.join(profile, 'providers.json'), JSON.stringify({ providers: [provider], currentId: provider.id }));
await fs.writeFile(path.join(profile, 'api-keys.json'), JSON.stringify({ [provider.id]: 'synthetic-qa-key' }), { mode: 0o600 });
await fs.writeFile(path.join(codex, 'config.toml'), '# isolated QA baseline\n');
await fs.writeFile(path.join(codex, 'auth.json'), '{}\n', { mode: 0o600 });

async function launch() {
  application = await electron.launch({ executablePath, args: [`--user-data-dir=${profile}`], timeout: 30000 });
  application.process().stderr.on('data', (chunk) => { console.error(String(chunk)); if (/uncaught|unhandled|failed to load/i.test(String(chunk))) errors.push(String(chunk)); });
  const info = await application.evaluate(({ app }) => ({ profile: app.getPath('userData'), executable: app.getPath('exe'), packaged: app.isPackaged }));
  assert.equal(info.profile, profile, 'Must never use the real user profile');
  assert.equal(info.executable, executablePath);
  assert.equal(info.packaged, true);
  page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.waitForFunction(() => Boolean(window.desktopAPI));
  await page.getByRole('heading', { name: '配置列表' }).waitFor();
}

async function stop() {
  if (!application) return;
  await application.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  await application.close().catch(() => undefined);
  application = undefined;
}

try {
  await launch();
  record('Installed ARM64 app launches with real preload and isolated profile');
  await page.getByRole('button', { name: '编辑', exact: false }).click();
  await page.getByRole('dialog').waitFor();
  assert.equal(await page.getByRole('combobox', { name: '模型 API 格式', exact: true }).count(), 3);
  const label = page.locator('#models_1_apiFormat').locator('xpath=ancestor::*[contains(@class,"ant-select")][1]');
  assert.match(await label.innerText(), /Chat Completions/);
  await page.screenshot({ path: path.join(artifacts, 'model-options.png') });
  await page.getByRole('button', { name: '保 存' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden', timeout: 20000 });
  const saved = await page.evaluate(() => window.desktopAPI.providers.list());
  assert.deepEqual(saved[0].models, provider.models);
  assert.deepEqual(requests.slice(0, 3).map((entry) => entry.url), ['/v1/responses', '/v1/chat/completions', '/v1/messages']);
  record('Desktop form save validates each model with its own protocol and preserves boolean options');
  await stop();
  await launch();
  assert.deepEqual((await page.evaluate(() => window.desktopAPI.providers.list()))[0].models, provider.models);
  record('Saved protocol and capability settings survive an app restart');
  const status = await page.evaluate(() => window.desktopAPI.gateway.start());
  assert.equal(status.running, true);
  assert.match(status.endpoint, new RegExp(`:${gatewayPort}/v1$`));
  const auth = JSON.parse(await fs.readFile(path.join(codex, 'auth.json'), 'utf8'));
  assert.equal(typeof auth.OPENAI_API_KEY, 'string');
  const invoke = async (body, token = auth.OPENAI_API_KEY) => fetch(`${status.endpoint}/responses`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  assert.equal((await invoke({ input: 'test' }, 'invalid-key')).status, 401);
  record('Packaged gateway rejects unauthorized requests');
  requests.length = 0;
  const history = [{ role: 'user', content: 'Synthetic history marker QA-714' }];
  for (const model of ['GPT QA', 'Qwen QA', 'Claude QA', 'GPT QA']) {
    const response = await invoke({ model, instructions: 'Only process synthetic test data', input: history, stream: true });
    assert.equal(response.status, 200);
    const output = await response.text();
    const events = output.split(/\r?\n/).filter((line) => line.startsWith('data:') && !line.includes('[DONE]')).map((line) => JSON.parse(line.slice(5)));
    assert(!events.some((event) => event.type === 'response.failed'));
    const completed = events.find((event) => event.type === 'response.completed');
    assert(completed, `${model} must finish`);
    history.push(...completed.response.output);
    for (const item of completed.response.output) {
      if (item.type === 'function_call') history.push({ type: 'function_call_output', call_id: item.call_id, output: 'Synthetic README result' });
    }
    history.push({ role: 'user', content: 'Continue using previous results' });
  }
  assert.deepEqual(requests.map((entry) => entry.url), ['/v1/responses', '/v1/chat/completions', '/v1/messages', '/v1/responses']);
  for (const entry of requests.slice(1)) {
    assert.match(JSON.stringify(entry.body), /QA-714/);
    assert.match(JSON.stringify(entry.body), /Synthetic README result/);
  }
  assert.equal(requests[2].authorization, undefined);
  assert.equal(requests[2].apiKey, 'synthetic-qa-key');
  record('Four streaming turns switch GPT -> Qwen -> Claude -> GPT with visible history, tool results and correct authentication');
  for (const mode of ['truncated', 'disconnected']) {
    scenario = mode;
    for (const model of ['GPT QA', 'Qwen QA', 'Claude QA']) {
      const response = await invoke({ model, input: 'Synthetic failure check', stream: true });
      const text = await response.text();
      assert.match(text, /response.failed/);
      assert(!text.includes('response.completed'));
    }
    record(`All three protocols report ${mode} streams as failures`);
  }
  scenario = 'normal';
  assert.equal((await invoke({ model: 'Qwen QA', previous_response_id: 'opaque-old-response', input: 'continue' })).status, 400);
  assert.equal((await invoke({ model: 'Qwen QA', input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,TEST' }] }] })).status, 400);
  record('Unsupported opaque history and attachments return explicit 400 errors');
  await page.evaluate(() => window.desktopAPI.gateway.stop());
  assert.equal(await fs.readFile(path.join(codex, 'config.toml'), 'utf8'), '# isolated QA baseline\n');
  record('Stopping the packaged gateway restores the isolated Codex configuration');
  assert.deepEqual(errors, []);
  record('No renderer exceptions or fatal startup errors');
} finally {
  await stop();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ executablePath, temporaryProfile: profile, checks, errors }, null, 2));
  console.log(`Report: ${path.join(artifacts, 'report.json')}`);
}
