import { describe, expect, it } from 'vitest';
import type { Provider } from '@codex-key-switcher/shared';
import {
  NativeResponsesSSEAdapter,
  ResponsesSSEAdapter,
  upstreamPathForGatewayPath,
  upstreamRequestBodyFromGenericBody,
  upstreamRequestBodyFromResponsesBody,
} from './gateway-protocol-adapter';

describe('gateway protocol adapter', () => {
  it('removes hosted Responses tools for non-OpenAI upstreams while keeping function tools', () => {
    const adapted = upstreamRequestBodyFromResponsesBody(jsonBuffer({
      model: 'gpt-5',
      input: 'hello',
      tools: [
        { type: 'web_search' },
        {
          type: 'function',
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object', properties: {} },
        },
      ],
      tool_choice: { type: 'web_search' },
    }), providerFixture({
      baseURL: 'https://api.xiaomimimo.com/v1',
      apiFormat: 'responses',
    }), false);

    const payload = JSON.parse(adapted.body.toString('utf8')) as Record<string, unknown>;

    expect(payload.tools).toEqual([
      {
        type: 'function',
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: {} },
      },
    ]);
    expect(payload.tool_choice).toBeUndefined();
  });

  it('keeps hosted Responses tools for the OpenAI Responses API', () => {
    const adapted = upstreamRequestBodyFromResponsesBody(jsonBuffer({
      model: 'gpt-5',
      input: 'hello',
      tools: [{ type: 'web_search' }],
    }), providerFixture({
      baseURL: 'https://api.openai.com/v1',
      apiFormat: 'responses',
    }), false);

    const payload = JSON.parse(adapted.body.toString('utf8')) as Record<string, unknown>;

    expect(payload.tools).toEqual([{ type: 'web_search' }]);
  });

  it('converts DeepSeek Responses requests to OpenAI-compatible chat completions', () => {
    const provider = providerFixture({
      baseURL: 'https://api.deepseek.com/v1',
      apiFormat: 'responses',
      models: [{ customName: 'DeepSeek Pro', model: 'deepseek-v4-pro' }],
      selectedModel: 'DeepSeek Pro',
    });
    const adapted = upstreamRequestBodyFromResponsesBody(jsonBuffer({
      model: 'ks-provider-deepseek-pro',
      input: [
        { type: 'reasoning', reasoning_text: 'previous hidden thinking' },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      ],
      reasoning: { effort: 'high' },
      stream: true,
    }), provider, true);
    const payload = JSON.parse(adapted.body.toString('utf8')) as Record<string, unknown>;

    expect(upstreamPathForGatewayPath('/responses', provider)).toBe('/chat/completions');
    expect(payload.model).toBe('deepseek-v4-pro');
    expect(payload.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(payload.reasoning).toBeUndefined();
    expect(payload.thinking).toEqual({ type: 'disabled' });
  });

  it('maps a local catalog slug to the configured upstream model', () => {
    const provider = providerFixture({
      id: 'provider-12345678',
      models: [
        { customName: 'Fast Model', model: 'upstream-fast' },
        { customName: 'Reasoning Model', model: 'upstream-reasoning' },
      ],
      selectedModel: 'Fast Model',
    });
    const adapted = upstreamRequestBodyFromResponsesBody(jsonBuffer({
      model: 'ks-provider-reasoning-model',
      input: 'hello',
    }), provider, false);
    const payload = JSON.parse(adapted.body.toString('utf8')) as Record<string, unknown>;

    expect(payload.model).toBe('upstream-reasoning');
    expect(adapted.upstreamModel).toBe('upstream-reasoning');
  });

  it('raises small output token limits for non-OpenAI Responses-compatible upstreams', () => {
    const adapted = upstreamRequestBodyFromResponsesBody(jsonBuffer({
      model: 'gpt-5',
      input: 'hello',
      max_output_tokens: 8,
    }), providerFixture({
      baseURL: 'https://litellm.example.com/v1',
      apiFormat: 'responses',
    }), false);
    const payload = JSON.parse(adapted.body.toString('utf8')) as Record<string, unknown>;

    expect(payload.max_output_tokens).toBe(16);
  });

  it('preserves small output token limits for the OpenAI Responses API', () => {
    const adapted = upstreamRequestBodyFromResponsesBody(jsonBuffer({
      model: 'gpt-5',
      input: 'hello',
      max_output_tokens: 8,
    }), providerFixture({
      baseURL: 'https://api.openai.com/v1',
      apiFormat: 'responses',
    }), false);
    const payload = JSON.parse(adapted.body.toString('utf8')) as Record<string, unknown>;

    expect(payload.max_output_tokens).toBe(8);
  });

  it('raises small output token limits for generic OpenAI-compatible upstream requests', () => {
    const adapted = upstreamRequestBodyFromGenericBody(jsonBuffer({
      model: 'qwen3.6-flash',
      messages: [{ role: 'user', content: 'hello' }],
      max_output_tokens: 8,
    }), providerFixture({
      baseURL: 'https://litellm.example.com/v1',
      apiFormat: 'chat_completions',
      models: [{ customName: 'Qwen Flash', model: 'qwen3.6-flash' }],
      selectedModel: 'Qwen Flash',
    }));
    const payload = JSON.parse(adapted.body.toString('utf8')) as Record<string, unknown>;

    expect(payload.max_output_tokens).toBe(16);
    expect(adapted.upstreamModel).toBe('qwen3.6-flash');
  });

  it('maps catalog slugs for generic upstream requests', () => {
    const provider = providerFixture({
      id: 'provider-12345678',
      apiFormat: 'chat_completions',
      models: [
        { customName: 'Fast Model', model: 'upstream-fast' },
        { customName: 'Reasoning Model', model: 'upstream-reasoning' },
      ],
      selectedModel: 'Fast Model',
    });
    const adapted = upstreamRequestBodyFromGenericBody(jsonBuffer({
      model: 'ks-provider-reasoning-model',
      messages: [{ role: 'user', content: 'hello' }],
    }), provider);
    const payload = JSON.parse(adapted.body.toString('utf8')) as Record<string, unknown>;

    expect(payload.model).toBe('upstream-reasoning');
    expect(adapted.upstreamModel).toBe('upstream-reasoning');
  });

  it('repairs Responses text streams that start directly with output text deltas', () => {
    const adapter = new NativeResponsesSSEAdapter('MiniMax-M3');
    const output = [
      ...adapter.processTextChunk('data: {"type":"response.output_text.delta","item_id":"upstream-item","output_index":0,"content_index":0,"delta":"O"}\n\n'),
      ...adapter.processTextChunk('data: {"type":"response.output_text.delta","item_id":"upstream-item","output_index":0,"content_index":0,"delta":"K"}\n\n'),
      ...adapter.processTextChunk('data: {"type":"response.completed","response":{"id":"upstream-response","status":"completed","usage":{"input_tokens":10,"output_tokens":2}}}\n\n'),
      ...adapter.processTextChunk('data: [DONE]\n\n'),
      ...adapter.finish(),
    ].join('');

    expect(sseEventTypes(output)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(output).toContain('"text":"OK"');
    expect(output).toContain('"input_tokens":10');
  });

  it('passes complete native Responses streams through unchanged', () => {
    const adapter = new NativeResponsesSSEAdapter('gpt-5');
    const input = [
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp-1","status":"in_progress"}}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp-1","status":"completed"}}',
      '',
      '',
    ].join('\n');

    const output = [
      ...adapter.processTextChunk(input),
      ...adapter.finish(),
    ].join('');

    expect(output).toBe(input);
  });

  it('waits through SSE heartbeats before deciding whether a text stream needs repair', () => {
    const adapter = new NativeResponsesSSEAdapter('MiniMax-M3');
    const output = [
      ...adapter.processTextChunk(': keep-alive\n\n'),
      ...adapter.processTextChunk('data: {"type":"response.completed","response":{"status":"completed","output_text":"OK"}}\n\n'),
      ...adapter.finish(),
    ].join('');

    expect(output).toContain(': keep-alive\n\n');
    expect(sseEventTypes(output)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(output).toContain('"text":"OK"');
  });

  it('reports failure with the original ID when a native stream closes early', () => {
    const adapter = new NativeResponsesSSEAdapter('gpt-5.5');
    const output = [
      ...adapter.processTextChunk('event: response.created\n'),
      ...adapter.processTextChunk('data: {"type":"response.created","response":{"id":"resp-1","status":"in_progress"}}\n\n'),
      ...adapter.finishAfterUpstreamClose(),
    ].join('');

    expect(sseEventTypes(output)).toEqual([
      'response.created',
      'response.failed',
    ]);
    expect(output).toContain('"id":"resp-1","object":"response"');
    expect(adapter.failed).toBe(true);
  });

  it('parses CRLF streams at every possible chunk boundary', () => {
    const input = [
      { type: 'response.output_text.delta', item_id: 'msg-1', delta: 'A' },
      { type: 'response.output_text.delta', item_id: 'msg-1', delta: 'B' },
      { type: 'response.completed', response: { usage: { input_tokens: 10 } } },
    ].map((payload) => `data: ${JSON.stringify(payload)}\r\n\r\n`).join('');
    for (let index = 0; index <= input.length; index++) {
      const adapter = new NativeResponsesSSEAdapter('test');
      const output = [...adapter.processTextChunk(input.slice(0, index)), ...adapter.processTextChunk(input.slice(index)), ...adapter.finish()].join('');
      expect(output).toContain('"text":"AB"');
      expect(output).toContain('"input_tokens":10');
      expect(adapter.failed).toBe(false);
    }
    const adapter = new NativeResponsesSSEAdapter('test');
    expect([...input].flatMap((character) => adapter.processTextChunk(character)).join('')).toContain('"text":"AB"');
  });

  it('preserves tool events and final output after a repaired text delta', () => {
    const adapter = new NativeResponsesSSEAdapter('test');
    const tool = { id: 'fc-1', type: 'function_call', call_id: 'call-1', name: 'shell', arguments: '{}' };
    const payloads = [
      { type: 'response.output_text.delta', item_id: 'msg-1', output_index: 0, delta: 'Checking' },
      { type: 'response.output_item.added', output_index: 1, item: { ...tool, arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc-1', delta: '{}' },
      { type: 'response.output_item.done', output_index: 1, item: tool },
      { type: 'response.completed', response: { output: [tool] } },
    ];
    const output = payloads.flatMap((payload) => adapter.processTextChunk(`data: ${JSON.stringify(payload)}\n\n`)).join('');
    expect(sseEventTypes(output)).toContain('response.function_call_arguments.delta');
    const completed = ssePayloads(output).find((payload) => payload.type === 'response.completed');
    expect(completed?.response).toMatchObject({ output: [expect.objectContaining({ type: 'message' }), tool] });
    expect(adapter.finish()).toEqual([]);
  });

  it.each(['response.failed', 'response.incomplete', 'error'])('does not replace %s with success', (type) => {
    const adapter = new NativeResponsesSSEAdapter('test');
    const output = [
      ...adapter.processTextChunk('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'),
      ...adapter.processTextChunk(`data: ${JSON.stringify({ type, response: { status: 'failed' } })}\n\n`),
      ...adapter.finish(),
    ].join('');
    expect(sseEventTypes(output)).toContain(type);
    expect(sseEventTypes(output)).not.toContain('response.completed');
    expect(adapter.failed).toBe(true);
  });

  it.each(['chat_completions', 'anthropic_messages'] as const)('does not complete truncated %s tool arguments', (format) => {
    const adapter = new ResponsesSSEAdapter(format, 'test');
    const payload = format === 'chat_completions'
      ? { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'shell', arguments: '{' } }] } }] }
      : { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{' } };
    const output = [...adapter.processTextChunk(`data: ${JSON.stringify(payload)}\n\n`), ...adapter.finish()].join('');
    expect(sseEventTypes(output)).toContain('response.failed');
    expect(sseEventTypes(output)).not.toContain('response.function_call_arguments.done');
    expect(sseEventTypes(output)).not.toContain('response.completed');
    expect(adapter.finish()).toEqual([]);
  });

  it('uses per-model protocol and preserves instructions and tool history', () => {
    const provider = providerFixture({
      models: [
        { customName: 'GPT', model: 'gpt-test' },
        { customName: 'Qwen', model: 'qwen-test', apiFormat: 'chat_completions', supportsReasoning: false },
      ],
      selectedModel: 'GPT',
    });
    const input = [
      { role: 'user', content: 'inspect project' },
      { type: 'function_call', call_id: 'call-1', name: 'shell', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call-1', output: 'README.md' },
      { role: 'user', content: 'continue' },
    ];
    const converted = upstreamRequestBodyFromResponsesBody(jsonBuffer({ model: 'Qwen', instructions: 'Keep secrets private', input, reasoning: { effort: 'high' } }), provider, false);
    expect(JSON.parse(converted.body.toString())).toMatchObject({
      model: 'qwen-test',
      messages: [
        { role: 'system', content: 'Keep secrets private' },
        { role: 'user', content: 'inspect project' },
        { role: 'assistant', tool_calls: [{ id: 'call-1', function: { name: 'shell', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call-1', content: 'README.md' },
        { role: 'user', content: 'continue' },
      ],
    });
    expect(provider.apiFormat).toBe('responses');
    expect(provider.selectedModel).toBe('GPT');
  });

  it('rejects opaque history and unsupported attachments instead of silently losing context', () => {
    const provider = providerFixture({ apiFormat: 'chat_completions' });
    expect(() => upstreamRequestBodyFromResponsesBody(jsonBuffer({ previous_response_id: 'resp-old', input: 'continue' }), provider, false)).toThrow('full conversation history');
    expect(() => upstreamRequestBodyFromResponsesBody(jsonBuffer({ input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,test' }] }] }), provider, false)).toThrow('image/file history');
  });

  it('allows image input when image support inherits from a Responses provider', () => {
    const provider = providerFixture({ models: [{ customName: 'GPT 5.6 Sol', model: 'gpt-5.6-sol' }], selectedModel: 'GPT 5.6 Sol' });
    expect(() => upstreamRequestBodyFromResponsesBody(jsonBuffer({
      input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,test' }] }],
    }), provider, false)).not.toThrow();
  });

  it('groups parallel Anthropic tool calls and outputs into adjacent message blocks', () => {
    const provider = providerFixture({ apiFormat: 'anthropic_messages' });
    const input = [
      { role: 'user', content: 'read files' },
      { type: 'function_call', call_id: 'a', name: 'read', arguments: '{}' },
      { type: 'function_call', call_id: 'b', name: 'read', arguments: '{}' },
      { type: 'function_call_output', call_id: 'a', output: 'one' },
      { type: 'function_call_output', call_id: 'b', output: 'two' },
    ];
    const converted = upstreamRequestBodyFromResponsesBody(jsonBuffer({ input }), provider, false);
    const payload = JSON.parse(converted.body.toString()) as { messages: Array<{ role: string; content: unknown[] }> };
    expect(payload.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(payload.messages[1]?.content).toHaveLength(2);
    expect(payload.messages[2]?.content).toHaveLength(2);
  });

  it('removes reasoning parameters only for models explicitly configured without them', () => {
    const provider = providerFixture({ models: [{ customName: 'Plain', model: 'plain', supportsReasoning: false }], selectedModel: 'Plain' });
    const converted = upstreamRequestBodyFromResponsesBody(jsonBuffer({ input: 'hi', reasoning: { effort: 'high' } }), provider, false);
    expect(JSON.parse(converted.body.toString()).reasoning).toBeUndefined();
  });
});

function providerFixture(overrides: Partial<Provider>): Provider {
  return {
    id: 'provider-1',
    name: 'Provider',
    baseURL: 'https://api.example.com/v1',
    apiFormat: 'responses',
    models: [{ customName: 'GPT 5', model: 'gpt-5' }],
    selectedModel: 'GPT 5',
    updatedAt: 1,
    ...overrides,
  };
}

function jsonBuffer(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

function sseEventTypes(stream: string): string[] {
  return stream
    .split(/\r?\n/)
    .filter((line) => line.startsWith('event:'))
    .map((line) => line.slice(6).trim());
}

function ssePayloads(stream: string): Array<Record<string, unknown>> {
  return stream.split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5)) as Record<string, unknown>);
}
