import http from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodexConfigService, ProviderService, UsageService } from '@codex-key-switcher/core';
import type { Provider, RouteSettings } from '@codex-key-switcher/shared';
import { LocalGatewayRuntime } from './local-gateway-runtime';

const servers: Array<{ server: http.Server; sockets: Set<Socket> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(({ server, sockets }) => closeServer(server, sockets)));
});

describe('LocalGatewayRuntime', () => {
  it('routes consecutive turns to per-model protocols without changing the provider or losing tool history', async () => {
    const requests: Array<{ url: string; authorization: string | undefined; apiKey: string | undefined; body: Record<string, unknown> }> = [];
    const upstream = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
        requests.push({ url: request.url ?? '', authorization: request.headers.authorization, apiKey: request.headers['x-api-key'] as string | undefined, body });
        response.setHeader('Content-Type', 'application/json');
        if (request.url?.endsWith('/chat/completions')) response.end(JSON.stringify({ choices: [{ message: { content: 'chat answer' } }] }));
        else if (request.url?.endsWith('/messages')) response.end(JSON.stringify({ content: [{ type: 'text', text: 'anthropic answer' }] }));
        else response.end(JSON.stringify({ id: 'resp-test', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'native answer' }] }] }));
      });
    });
    const port = await listen(upstream);
    const provider = providerFixture(`http://127.0.0.1:${port}/v1`);
    provider.models = [
      { customName: 'GPT', model: 'gpt-test' },
      { customName: 'Qwen', model: 'qwen-test', apiFormat: 'chat_completions', supportsReasoning: false },
      { customName: 'Claude', model: 'claude-test', apiFormat: 'anthropic_messages' },
    ];
    provider.selectedModel = 'GPT';
    const runtime = new LocalGatewayRuntime(providerServiceFixture(provider), codexConfigFixture(), usageServiceFixture());
    const status = await runtime.start(routeSettingsFixture(await availablePort()));
    const history: unknown[] = [{ role: 'user', content: 'inspect project' }];
    try {
      for (const model of ['GPT', 'Qwen', 'Claude', 'GPT']) {
        const response = await fetch(`${status.endpoint}/responses`, {
          method: 'POST',
          headers: { Authorization: 'Bearer local-gateway-key', 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, instructions: 'Do not disclose secrets', input: history, stream: false }),
        });
        expect(response.status).toBe(200);
        const payload = await response.json() as { output: unknown[] };
        history.push(...payload.output, { role: 'user', content: 'continue' });
        if (model === 'Qwen') history.push(
          { type: 'function_call', call_id: 'call-1', name: 'shell', arguments: '{}' },
          { type: 'function_call_output', call_id: 'call-1', output: 'README.md' },
        );
      }
      expect(requests.map((request) => request.url)).toEqual(['/v1/responses', '/v1/chat/completions', '/v1/messages', '/v1/responses']);
      expect(requests.map((request) => request.body.model)).toEqual(['gpt-test', 'qwen-test', 'claude-test', 'gpt-test']);
      expect(requests[1]?.body.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'assistant', content: 'native answer' })]));
      expect(requests[2]?.body.system).toBe('Do not disclose secrets');
      expect(JSON.stringify(requests[2]?.body.messages)).toContain('README.md');
      expect(JSON.stringify(requests[3]?.body.input)).toContain('call-1');
      expect(requests[2]?.apiKey).toBe('upstream-key');
      expect(requests[2]?.authorization).toBeUndefined();
      expect(requests[3]?.authorization).toBe('Bearer upstream-key');
      expect(provider.selectedModel).toBe('GPT');
      expect(provider.apiFormat).toBe('responses');
    } finally {
      await runtime.stop();
    }
  });

  it.each(['responses', 'chat_completions'] as const)('reports idle %s streams as failed and records 504', async (apiFormat) => {
    const upstream = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(apiFormat === 'responses'
        ? 'data: {"type":"response.created","response":{"id":"resp-original","status":"in_progress"}}\n\n'
        : 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    });
    const provider = providerFixture(`http://127.0.0.1:${await listen(upstream)}/v1`);
    provider.apiFormat = apiFormat;
    const record = vi.fn(async () => undefined);
    const runtime = new LocalGatewayRuntime(providerServiceFixture(provider), codexConfigFixture(), { record } as unknown as UsageService, {
      requestBodyMs: 1000, upstreamResponseHeadersMs: 1000, upstreamRequestMs: 1000, upstreamStreamIdleMs: 50,
    });
    const status = await runtime.start(routeSettingsFixture(await availablePort()));
    try {
      const response = await fetch(`${status.endpoint}/responses`, {
        method: 'POST', headers: { Authorization: 'Bearer local-gateway-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5', input: 'hello', stream: true }),
      });
      const output = await response.text();
      expect(sseEventTypes(output)).toContain('response.failed');
      expect(sseEventTypes(output)).not.toContain('response.completed');
      if (apiFormat === 'responses') expect(output).toContain('"id":"resp-original","object":"response"');
      await vi.waitFor(() => expect(record).toHaveBeenCalledWith(expect.objectContaining({ status: 504 })));
    } finally {
      await runtime.stop();
    }
  });

  it('fails over from a retryable 5xx to the next provider and records every attempt', async () => {
    const firstHits = vi.fn();
    const first = http.createServer((_request, response) => {
      firstHits();
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'unavailable' }));
    });
    const secondHits = vi.fn();
    const second = http.createServer((_request, response) => {
      secondHits();
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: 'resp-backup', status: 'completed', output: [] }));
    });
    const primary = providerFixture(`http://127.0.0.1:${await listen(first)}/v1`);
    const backup = { ...providerFixture(`http://127.0.0.1:${await listen(second)}/v1`), id: 'provider-2', name: 'Backup', updatedAt: 2 };
    const record = vi.fn(async (_record: unknown) => undefined);
    const runtime = new LocalGatewayRuntime(providerServiceFixtures(primary, [primary, backup]), codexConfigFixture(), { record } as unknown as UsageService);
    const settings = { ...routeSettingsFixture(await availablePort()), failoverEnabled: true };
    const status = await runtime.start(settings);
    try {
      const response = await fetch(`${status.endpoint}/responses`, {
        method: 'POST', headers: { Authorization: 'Bearer local-gateway-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5', input: 'hello', stream: false }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('x-ai-key-switcher-failover')).toBe('true');
      expect(firstHits).toHaveBeenCalledTimes(1);
      expect(secondHits).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(2));
      expect(record.mock.calls[0]?.[0]).toMatchObject({ attempt: 1, failover: false, finalAttempt: false, status: 503 });
      expect(record.mock.calls[1]?.[0]).toMatchObject({ attempt: 2, failover: true, finalAttempt: true, status: 200 });
    } finally {
      await runtime.stop();
    }
  });

  it('does not fail over on an upstream 4xx', async () => {
    const first = http.createServer((_request, response) => {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'unauthorized' }));
    });
    const secondHits = vi.fn();
    const second = http.createServer(secondHits);
    const primary = providerFixture(`http://127.0.0.1:${await listen(first)}/v1`);
    const backup = { ...providerFixture(`http://127.0.0.1:${await listen(second)}/v1`), id: 'provider-2', updatedAt: 2 };
    const runtime = new LocalGatewayRuntime(providerServiceFixtures(primary, [primary, backup]), codexConfigFixture(), usageServiceFixture());
    const status = await runtime.start({ ...routeSettingsFixture(await availablePort()), failoverEnabled: true });
    try {
      const response = await fetch(`${status.endpoint}/responses`, {
        method: 'POST', headers: { Authorization: 'Bearer local-gateway-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5', input: 'hello', stream: false }),
      });
      expect(response.status).toBe(401);
      expect(secondHits).not.toHaveBeenCalled();
    } finally {
      await runtime.stop();
    }
  });

  it('opens the primary circuit after repeated retryable failures', async () => {
    const primaryHits = vi.fn();
    const first = http.createServer((_request, response) => {
      primaryHits();
      response.writeHead(503).end();
    });
    const second = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: 'resp-backup', status: 'completed', output: [] }));
    });
    const primary = providerFixture(`http://127.0.0.1:${await listen(first)}/v1`);
    const backup = { ...providerFixture(`http://127.0.0.1:${await listen(second)}/v1`), id: 'provider-2', updatedAt: 2 };
    const runtime = new LocalGatewayRuntime(providerServiceFixtures(primary, [primary, backup]), codexConfigFixture(), usageServiceFixture());
    const status = await runtime.start({
      ...routeSettingsFixture(await availablePort()), failoverEnabled: true, failoverFailureThreshold: 2, failoverCooldownMs: 60_000,
    });
    try {
      for (let index = 0; index < 3; index++) {
        const response = await fetch(`${status.endpoint}/responses`, {
          method: 'POST', headers: { Authorization: 'Bearer local-gateway-key', 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5', input: 'hello', stream: false }),
        });
        expect(response.status).toBe(200);
      }
      expect(primaryHits).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.stop();
    }
  });

  it('rebinds the gateway when the listen port changes', async () => {
    const upstream = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: 'resp-status', status: 'completed', output: [] }));
    });
    const upstreamPort = await listen(upstream);
    const provider = providerFixture(`http://127.0.0.1:${upstreamPort}/v1`);
    const runtime = new LocalGatewayRuntime(providerServiceFixture(provider), codexConfigFixture(), usageServiceFixture());
    const firstPort = await availablePort();
    const secondPort = await availablePort();

    const firstStatus = await runtime.start(routeSettingsFixture(firstPort));
    try {
      const secondStatus = await runtime.start({ ...routeSettingsFixture(secondPort), failoverEnabled: true });

      expect(secondStatus.endpoint).toContain(`:${secondPort}/v1`);
      await expect(fetch(`${firstStatus.endpoint}/__status`, {
        headers: { Authorization: 'Bearer local-gateway-key' },
      })).rejects.toThrow();
      await expect(fetch(`${secondStatus.endpoint}/__status`, {
        headers: { Authorization: 'Bearer local-gateway-key' },
      })).resolves.toMatchObject({ status: 200 });
    } finally {
      await runtime.stop();
    }
  });

  it('ignores stale circuit state after failover is disabled', async () => {
    const primaryHits = vi.fn();
    const primaryServer = http.createServer((_request, response) => {
      primaryHits();
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'unavailable' }));
    });
    const backupServer = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: 'resp-backup', status: 'completed', output: [] }));
    });
    const primary = providerFixture(`http://127.0.0.1:${await listen(primaryServer)}/v1`);
    const backup = { ...providerFixture(`http://127.0.0.1:${await listen(backupServer)}/v1`), id: 'provider-2', name: 'Backup' };
    const runtime = new LocalGatewayRuntime(providerServiceFixtures(primary, [primary, backup]), codexConfigFixture(), usageServiceFixture());
    const port = await availablePort();
    const enabledSettings = {
      ...routeSettingsFixture(port),
      failoverEnabled: true,
      failoverFailureThreshold: 1,
    };

    await runtime.start(enabledSettings);
    try {
      const firstResponse = await fetch(`http://127.0.0.1:${port}/v1/responses`, requestOptions());
      expect(firstResponse.status).toBe(200);
      expect(primaryHits).toHaveBeenCalledTimes(1);

      await runtime.start({ ...enabledSettings, failoverEnabled: false });
      const secondResponse = await fetch(`http://127.0.0.1:${port}/v1/responses`, requestOptions());
      expect(secondResponse.status).toBe(503);
      expect(primaryHits).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.stop();
    }
  });

  it('continues to the next provider when a backup credential read fails', async () => {
    const primaryServer = http.createServer((_request, response) => {
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'unavailable' }));
    });
    const backupServer = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: 'resp-unexpected', status: 'completed', output: [] }));
    });
    const healthyServer = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: 'resp-healthy', status: 'completed', output: [] }));
    });
    const primary = providerFixture(`http://127.0.0.1:${await listen(primaryServer)}/v1`);
    const backup = { ...providerFixture(`http://127.0.0.1:${await listen(backupServer)}/v1`), id: 'provider-2', name: 'Broken credentials' };
    const healthy = { ...providerFixture(`http://127.0.0.1:${await listen(healthyServer)}/v1`), id: 'provider-3', name: 'Healthy' };
    const record = vi.fn(async (_record: unknown) => undefined);
    const providerService = {
      current: async () => primary,
      currentRoutingProviderWithApiKey: async () => ({ provider: primary, apiKey: 'upstream-key' }),
      routingProviders: async () => [primary, backup, healthy],
      currentApiKey: async (provider: Provider) => {
        if (provider.id === backup.id) throw new Error('credential backend unavailable');
        return 'upstream-key';
      },
    } as unknown as ProviderService;
    const runtime = new LocalGatewayRuntime(providerService, codexConfigFixture(), { record } as unknown as UsageService);
    const status = await runtime.start({ ...routeSettingsFixture(await availablePort()), failoverEnabled: true, failoverMaxAttempts: 3 });

    try {
      const response = await fetch(`${status.endpoint}/responses`, requestOptions());
      expect(response.status).toBe(200);
      await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(3));
      expect(record.mock.calls.map(([attempt]) => attempt)).toEqual([
        expect.objectContaining({ attempt: 1, finalAttempt: false }),
        expect.objectContaining({ attempt: 2, errorCategory: 'credential_error', finalAttempt: false }),
        expect.objectContaining({ attempt: 3, finalAttempt: true }),
      ]);
    } finally {
      await runtime.stop();
    }
  });

  it('returns a clear 400 before contacting an incompatible history target', async () => {
    const contacted = vi.fn();
    const upstream = http.createServer(contacted);
    const provider = providerFixture(`http://127.0.0.1:${await listen(upstream)}/v1`);
    provider.apiFormat = 'chat_completions';
    const runtime = new LocalGatewayRuntime(providerServiceFixture(provider), codexConfigFixture(), usageServiceFixture());
    const status = await runtime.start(routeSettingsFixture(await availablePort()));
    try {
      const response = await fetch(`${status.endpoint}/responses`, {
        method: 'POST', headers: { Authorization: 'Bearer local-gateway-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5', previous_response_id: 'resp-old', input: 'continue' }),
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain('full conversation history');
      expect(contacted).not.toHaveBeenCalled();
    } finally {
      await runtime.stop();
    }
  });
  it('returns 504 when the upstream never sends response headers', async () => {
    const upstream = http.createServer(() => undefined);
    const upstreamPort = await listen(upstream);
    const provider = providerFixture(`http://127.0.0.1:${upstreamPort}/v1`);
    const runtime = new LocalGatewayRuntime(
      providerServiceFixture(provider),
      codexConfigFixture(),
      usageServiceFixture(),
      {
        requestBodyMs: 1_000,
        upstreamResponseHeadersMs: 50,
        upstreamRequestMs: 1_000,
        upstreamStreamIdleMs: 1_000,
      },
    );
    const gatewayPort = await availablePort();

    const status = await runtime.start(routeSettingsFixture(gatewayPort));
    try {
      const response = await fetch(`${status.endpoint}/responses`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer local-gateway-key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-5',
          input: 'hello',
          stream: false,
        }),
      });
      const payload = await response.json() as { error?: string };

      expect(response.status).toBe(504);
      expect(payload.error).toContain('response headers');
    } finally {
      await runtime.stop();
    }
  });

  it('repairs incomplete native Responses text streams before returning them to Codex', async () => {
    const upstream = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: {"type":"response.output_text.delta","item_id":"upstream-item","output_index":0,"content_index":0,"delta":"OK"}\n\n');
      response.write('data: {"type":"response.completed","response":{"id":"upstream-response","status":"completed","usage":{"input_tokens":10,"output_tokens":2}}}\n\n');
      response.end('data: [DONE]\n\n');
    });
    const upstreamPort = await listen(upstream);
    const provider = providerFixture(`http://127.0.0.1:${upstreamPort}/v1`);
    const runtime = new LocalGatewayRuntime(
      providerServiceFixture(provider),
      codexConfigFixture(),
      usageServiceFixture(),
    );
    const gatewayPort = await availablePort();

    const status = await runtime.start(routeSettingsFixture(gatewayPort));
    try {
      const response = await fetch(`${status.endpoint}/responses`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer local-gateway-key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-5',
          input: 'hello',
          stream: true,
        }),
      });
      const stream = await response.text();

      expect(response.status).toBe(200);
      expect(sseEventTypes(stream)).toEqual([
        'response.created',
        'response.in_progress',
        'response.output_item.added',
        'response.content_part.added',
        'response.output_text.delta',
        'response.output_text.done',
        'response.content_part.done',
        'response.output_item.done',
        'response.completed',
      ]);
      expect(stream).toContain('"text":"OK"');
    } finally {
      await runtime.stop();
    }
  });
});

function providerFixture(baseURL: string): Provider {
  return {
    id: 'provider-1',
    name: 'Provider',
    baseURL,
    apiFormat: 'responses',
    models: [{ customName: 'GPT 5', model: 'gpt-5' }],
    selectedModel: 'GPT 5',
    updatedAt: 1,
  };
}

function routeSettingsFixture(listenPort: number): RouteSettings {
  return {
    mode: 'local_gateway',
    enabled: true,
    autoStart: true,
    disabledExplicitly: false,
    listenAddress: '127.0.0.1',
    listenPort,
    allowLANListen: false,
    failoverEnabled: false,
  failoverMaxAttempts: 3,
  failoverTotalTimeoutMs: 180_000,
  failoverFailureThreshold: 3,
  failoverCooldownMs: 60_000,
  failoverHalfOpenMaxRequests: 1,
  };
}

function providerServiceFixtures(current: Provider, providers: Provider[]): ProviderService {
  return {
    current: async () => current,
    currentRoutingProviderWithApiKey: async () => ({ provider: current, apiKey: 'upstream-key' }),
    routingProviders: async () => providers,
    currentApiKey: async () => 'upstream-key',
  } as unknown as ProviderService;
}

function providerServiceFixture(provider: Provider): ProviderService {
  return {
    current: async () => provider,
    currentRoutingProviderWithApiKey: async () => ({ provider, apiKey: 'upstream-key' }),
    routingProviders: async () => [provider],
    currentApiKey: async () => 'upstream-key',
  } as unknown as ProviderService;
}

function codexConfigFixture(): CodexConfigService {
  return {
    localGatewayAPIKey: async () => 'local-gateway-key',
  } as unknown as CodexConfigService;
}

function usageServiceFixture(): UsageService {
  return {
    record: async () => undefined,
  } as unknown as UsageService;
}

async function availablePort(): Promise<number> {
  const server = http.createServer();
  const port = await listen(server);
  const entry = servers.pop();
  if (entry) await closeServer(entry.server, entry.sockets);
  return port;
}

function listen(server: http.Server): Promise<number> {
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to allocate test port'));
        return;
      }
      servers.push({ server, sockets });
      resolve(address.port);
    });
  });
}

function closeServer(server: http.Server, sockets: Set<Socket>): Promise<void> {
  server.closeAllConnections();
  for (const socket of sockets) socket.destroy();
  return new Promise((resolve, reject) => {
    server.close((error: NodeJS.ErrnoException | undefined) => {
      if (error?.code === 'ERR_SERVER_NOT_RUNNING') {
        resolve();
        return;
      }
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function sseEventTypes(stream: string): string[] {
  return stream
    .split(/\r?\n/)
    .filter((line) => line.startsWith('event:'))
    .map((line) => line.slice(6).trim());
}

function requestOptions(): RequestInit {
  return {
    method: 'POST',
    headers: { Authorization: 'Bearer local-gateway-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5', input: 'hello', stream: false }),
  };
}
