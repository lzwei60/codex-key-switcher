import { describe, expect, it } from 'vitest';
import type { Provider } from '@codex-key-switcher/shared';
import {
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
