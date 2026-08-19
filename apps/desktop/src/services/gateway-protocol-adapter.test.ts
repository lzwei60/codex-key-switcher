import { describe, expect, it } from 'vitest';
import type { Provider } from '@codex-key-switcher/shared';
import { upstreamRequestBodyFromResponsesBody } from './gateway-protocol-adapter';

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
