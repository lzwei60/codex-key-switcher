import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const catalog = path.resolve(process.argv[2]);
const gatewayURL = process.argv[3];
const gatewayKey = process.argv[4];
const scenario = process.env.CODEX_TURN_SCENARIO ?? 'success';
assert.equal(Boolean(gatewayURL), Boolean(gatewayKey), 'Gateway URL and key must be supplied together');
assert(['success', 'failed', 'tool_call', 'parallel_tool_calls', 'multi_turn', 'image_input', 'image_history', 'multi_image_history'].includes(scenario), `Unsupported turn scenario: ${scenario}`);
const model = JSON.parse(await fs.readFile(catalog, 'utf8')).models[0].slug;
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cksw-turn-qa-'));
const imagePath = path.join(root, 'pixel.png');
const secondImagePath = path.join(root, 'blue.png');
const imageFixture = new URL('../apps/web/public/icon.png', import.meta.url);
const imageBytes = await fs.readFile(imageFixture);
const secondImageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAL0lEQVR4nO3OIQEAAAgDMDIQnnR0gRg3E/Ornr2kEhAQEBAQEBAQEBAQEBAQSAcedREMl6dDV/oAAAAASUVORK5CYII=', 'base64');
const requests = [];
const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');
  requests.push({ path: request.url, authorization: request.headers.authorization, body });
  const reply = scenario === 'multi_turn'
    ? (requests.length === 1 ? 'ORBIT-42' : 'RECALLED ORBIT-42')
    : scenario === 'image_history'
      ? (requests.length === 1 ? 'IMAGE-SEEN' : 'IMAGE-RECALLED')
      : scenario === 'multi_image_history'
        ? (requests.length === 1 ? 'TWO-IMAGES-SEEN' : 'TWO-IMAGES-RECALLED')
      : 'OK';
  const multipleTurns = scenario === 'multi_turn' || scenario === 'image_history' || scenario === 'multi_image_history';
  const responseId = multipleTurns ? `resp-cksw-qa-${requests.length}` : 'resp-cksw-qa';
  const messageId = multipleTurns ? `msg-cksw-qa-${requests.length}` : 'msg-cksw-qa';
  const payload = {
    id: responseId, object: 'response', status: 'completed', model,
    output: [{ id: messageId, type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: reply, annotations: [] }] }],
    usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
  };
  const event = (type, value) => `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  response.write(event('response.created', { response: { ...payload, status: 'in_progress', output: [] } }));
  if (scenario === 'failed') {
    response.write(event('response.failed', { response: { ...payload, status: 'failed', output: [],
      error: { code: 'synthetic_failure', message: 'Synthetic upstream failure' } } }));
    response.end('data: [DONE]\n\n');
    return;
  }
  if ((scenario === 'tool_call' || scenario === 'parallel_tool_calls') && requests.length === 1) {
    const commands = scenario === 'tool_call'
      ? [{ id: 'cksw-qa', cmd: 'pwd' }]
      : [{ id: 'cksw-par-a', cmd: 'pwd' }, { id: 'cksw-par-b', cmd: 'printf parallel-ok' }];
    const calls = commands.map(({ id, cmd }) => ({
      id: `fc-${id}`, type: 'function_call', status: 'completed',
      call_id: `call-${id}`, name: 'exec_command',
      arguments: JSON.stringify({ cmd, workdir: root, login: false }),
    }));
    calls.forEach((call, output_index) => {
      response.write(event('response.output_item.added', { output_index,
        item: { ...call, status: 'in_progress', arguments: '' } }));
      response.write(event('response.function_call_arguments.delta', {
        item_id: call.id, output_index, delta: call.arguments,
      }));
      response.write(event('response.function_call_arguments.done', {
        item_id: call.id, output_index, arguments: call.arguments,
      }));
      response.write(event('response.output_item.done', { output_index, item: call }));
    });
    response.write(event('response.completed', { response: { ...payload, output: calls } }));
    response.end('data: [DONE]\n\n');
    return;
  }
  response.write(event('response.output_item.added', { output_index: 0, item: { ...payload.output[0], status: 'in_progress', content: [] } }));
  response.write(event('response.content_part.added', { item_id: messageId, output_index: 0, content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] } }));
  response.write(event('response.output_text.delta', { item_id: messageId, output_index: 0, content_index: 0, delta: reply }));
  response.write(event('response.output_text.done', { item_id: messageId, output_index: 0, content_index: 0, text: reply }));
  response.write(event('response.content_part.done', { item_id: messageId, output_index: 0, content_index: 0,
    part: payload.output[0].content[0] }));
  response.write(event('response.output_item.done', { output_index: 0, item: payload.output[0] }));
  response.write(event('response.completed', { response: payload }));
  response.end('data: [DONE]\n\n');
});

let child;
let exited;
const pending = new Map();
const notifications = [];
let nextId = 0;
let stderr = '';
const timeout = setTimeout(() => child?.kill('SIGKILL'), 20000);
try {
  if (!gatewayURL) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  }
  const baseURL = gatewayURL ?? `http://127.0.0.1:${server.address().port}/v1`;
  child = spawn(process.env.CODEX_BINARY ?? 'codex', [
    'app-server', '--listen', 'stdio://', '--disable', 'plugins', '--disable', 'apps',
    '-c', `model_catalog_json=${JSON.stringify(catalog)}`,
    '-c', 'model_provider="qa"',
    '-c', `model_providers.qa={name="QA",base_url="${baseURL}",wire_api="responses",env_key="CKSW_QA_KEY"}`,
  ], { cwd: root, env: {
    PATH: process.env.PATH, HOME: root, CODEX_HOME: root, TMPDIR: os.tmpdir(),
    USERPROFILE: root, APPDATA: path.join(root, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(root, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(root, '.config'), XDG_DATA_HOME: path.join(root, '.local', 'share'),
    LANG: process.env.LANG ?? 'en_US.UTF-8', CKSW_QA_KEY: gatewayKey ?? 'synthetic-qa-key',
  }, stdio: ['pipe', 'pipe', 'pipe'] });
  exited = new Promise((resolve) => child.once('exit', resolve));
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  createInterface({ input: child.stdout }).on('line', (line) => {
    let payload;
    try { payload = JSON.parse(line); } catch { return; }
    if (payload.id != null) {
      const entry = pending.get(payload.id);
      if (!entry) return;
      pending.delete(payload.id);
      if (payload.error) entry.reject(new Error(JSON.stringify(payload.error)));
      else entry.resolve(payload.result);
    } else if (payload.method) {
      notifications.push(payload);
    }
  });
  child.on('exit', () => {
    for (const entry of pending.values()) entry.reject(new Error(stderr || 'Codex exited'));
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  await rpc('initialize', { clientInfo: { name: 'turn_qa', version: '1.0.0' } });
  child.stdin.write('{"method":"initialized"}\n');
  const started = await rpc('thread/start', { model, cwd: root, ephemeral: true, approvalPolicy: 'never' });
  const threadId = started.thread.id;
  const runTurn = async (input, expectedReply) => {
    const { turn } = await rpc('turn/start', { threadId, input });
    while (!notifications.some((entry) => entry.method === 'turn/completed' &&
      entry.params.threadId === threadId && entry.params.turn.id === turn.id)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(stderr || 'Codex exited before turn completion');
      }
    }
    const completed = notifications.find((entry) => entry.method === 'turn/completed' &&
      entry.params.threadId === threadId && entry.params.turn.id === turn.id);
    if (expectedReply) {
      assert.equal(completed.params.turn.status, 'completed', JSON.stringify(completed.params.turn.error));
      assert(notifications.some((entry) => entry.method === 'item/completed' &&
        entry.params.turnId === turn.id && entry.params.item.type === 'agentMessage' &&
        entry.params.item.text === expectedReply), `Expected completed reply for turn ${turn.id}`);
    }
    return completed;
  };
  const hasImage = scenario === 'image_input' || scenario === 'image_history' || scenario === 'multi_image_history';
  if (hasImage) await fs.copyFile(imageFixture, imagePath);
  if (scenario === 'multi_image_history') await fs.writeFile(secondImagePath, secondImageBytes);
  const firstInput = hasImage
    ? [{ type: 'text', text: 'Inspect these test images.' }, { type: 'localImage', path: imagePath },
      ...(scenario === 'multi_image_history' ? [{ type: 'localImage', path: secondImagePath }] : [])]
    : [{ type: 'text', text: scenario === 'multi_turn'
      ? 'Remember the code ORBIT-42. Reply with the code only.' : 'Reply OK only.' }];
  const completed = await runTurn(
    firstInput,
    scenario === 'multi_turn' ? 'ORBIT-42' : scenario === 'image_history' ? 'IMAGE-SEEN'
      : scenario === 'multi_image_history' ? 'TWO-IMAGES-SEEN' : scenario === 'failed' ? null : 'OK',
  );
  if (scenario === 'multi_turn') {
    const second = await runTurn([{ type: 'text', text: 'Recall the code from my previous message.' }], 'RECALLED ORBIT-42');
    assert.notEqual(second.params.turn.id, completed.params.turn.id);
  }
  if (scenario === 'image_history') {
    const second = await runTurn([{ type: 'text', text: 'Recall the image from my previous message.' }], 'IMAGE-RECALLED');
    assert.notEqual(second.params.turn.id, completed.params.turn.id);
  }
  if (scenario === 'multi_image_history') {
    const second = await runTurn([{ type: 'text', text: 'Recall both images in their original order.' }], 'TWO-IMAGES-RECALLED');
    assert.notEqual(second.params.turn.id, completed.params.turn.id);
  }
  assert.equal(completed.params.threadId, threadId);
  if (scenario === 'failed') {
    assert.equal(completed.params.turn.status, 'failed', JSON.stringify(completed.params.turn));
    assert(!notifications.some((entry) => entry.method === 'item/completed' &&
      entry.params.item.type === 'agentMessage' && entry.params.item.text === 'OK'));
  } else {
    assert.equal(completed.params.turn.status, 'completed', JSON.stringify(completed.params.turn.error));
    const usage = notifications.find((entry) => entry.method === 'thread/tokenUsage/updated');
    assert.equal(usage?.params.tokenUsage.last.inputTokens, 5);
    assert.equal(usage?.params.tokenUsage.last.outputTokens, 1);
    if (scenario === 'tool_call' || scenario === 'parallel_tool_calls') {
      const completedCommands = notifications.filter((entry) => entry.method === 'item/completed' &&
        entry.params.item.type === 'commandExecution');
      assert.equal(completedCommands.length, scenario === 'parallel_tool_calls' ? 2 : 1,
        'Expected command execution items were not completed');
    }
  }
  if (!gatewayURL) {
    assert(requests.length >= 1, 'Expected at least one upstream request');
    assert.equal(requests[0].path, '/v1/responses');
    assert.equal(requests[0].authorization, 'Bearer synthetic-qa-key');
    const upstreamRequest = JSON.parse(requests[0].body);
    assert.equal(upstreamRequest.model, model);
    assert.equal(upstreamRequest.stream, true);
    if (hasImage) {
      const hasHistory = scenario === 'image_history' || scenario === 'multi_image_history';
      assert.equal(requests.length, hasHistory ? 2 : 1,
        `Expected image request count for ${scenario}`);
      const expectedImages = scenario === 'multi_image_history' ? [imageBytes, secondImageBytes] : [imageBytes];
      const assertImages = (body) => {
        const images = body.input.filter((item) => item.role === 'user').flatMap((item) => item.content ?? [])
          .filter((part) => part.type === 'input_image');
        assert.equal(images.length, expectedImages.length, 'Image count changed before reaching the upstream');
        images.forEach((image, index) => {
          assert(image.image_url?.startsWith('data:image/png;base64,'), 'PNG image was not sent upstream');
          assert(Buffer.from(image.image_url.split(',')[1], 'base64').equals(expectedImages[index]),
            `Image ${index + 1} bytes or order changed before reaching the upstream`);
        });
      };
      assertImages(upstreamRequest);
      if (hasHistory) {
        const followup = JSON.parse(requests[1].body);
        assertImages(followup);
        assert(followup.input.some((item) => item.role === 'user' &&
          JSON.stringify(item).includes('Inspect these test images.')), 'First image message was not retained');
        assert(followup.input.some((item) => item.role === 'assistant' &&
          JSON.stringify(item).includes(scenario === 'multi_image_history' ? 'TWO-IMAGES-SEEN' : 'IMAGE-SEEN')),
        'First assistant reply was not retained');
        assert(followup.input.some((item) => item.role === 'user' &&
          JSON.stringify(item).includes(scenario === 'multi_image_history'
            ? 'Recall both images in their original order.' : 'Recall the image from my previous message.')),
        'Second user message was not sent');
      }
    }
    if (scenario === 'tool_call' || scenario === 'parallel_tool_calls') {
      assert.equal(requests.length, 2, `Expected tool result follow-up, received ${requests.length} upstream requests`);
      const followup = JSON.parse(requests[1].body);
      const expected = scenario === 'parallel_tool_calls'
        ? [{ id: 'cksw-par-a', output: root }, { id: 'cksw-par-b', output: 'parallel-ok' }]
        : [{ id: 'cksw-qa', output: root }];
      for (const { id, output } of expected) {
        const toolResult = followup.input.find((item) => item.type === 'function_call_output' &&
          item.call_id === `call-${id}`);
        assert(toolResult, `Tool result ${id} was not sent upstream`);
        assert(toolResult.output.includes(output), `Tool result ${id} did not contain expected output`);
      }
    }
    if (scenario === 'multi_turn') {
      assert.equal(requests.length, 2, `Expected two upstream requests, received ${requests.length}`);
      const followup = JSON.parse(requests[1].body);
      assert(followup.input.some((item) => item.role === 'user' &&
        JSON.stringify(item).includes('Remember the code ORBIT-42')), 'First user message was not retained');
      assert(followup.input.some((item) => item.role === 'assistant' &&
        JSON.stringify(item).includes('ORBIT-42')), 'First assistant reply was not retained');
      assert(followup.input.some((item) => item.role === 'user' &&
        JSON.stringify(item).includes('Recall the code from my previous message')), 'Second user message was not sent');
    }
  }
  console.log(`PASS app-server ${scenario} turn/start -> ${gatewayURL ? 'Tauri gateway' : 'mock Responses SSE'}: ${model}`);
} finally {
  clearTimeout(timeout);
  if (child) {
    child.kill('SIGTERM');
    const forceKill = setTimeout(() => child.kill('SIGKILL'), 2000);
    await exited;
    clearTimeout(forceKill);
  }
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
