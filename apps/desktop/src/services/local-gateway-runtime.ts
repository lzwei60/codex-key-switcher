import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import {
  providerSelectedCatalogModel,
  providerSelectedDisplayModel,
  type CodexConfigService,
  type ProviderService,
  type UsageService,
} from '@codex-key-switcher/core';
import type { GatewayStatus, Provider, RouteSettings } from '@codex-key-switcher/shared';
import {
  adaptUpstreamResponseToResponses,
  type ParsedUsage,
  requestBodyWantsStream,
  ResponsesSSEAdapter,
  StreamingUsageParser,
  upstreamBaseURLForProvider,
  upstreamPathForGatewayPath,
  upstreamRequestBodyFromGenericBody,
  upstreamRequestBodyFromResponsesBody,
  usageFromResponseBody,
} from './gateway-protocol-adapter';

const maxGatewayRequestBytes = 64 * 1024 * 1024;
const upstreamRequestTimeoutMs = 600_000;

interface ForwardAttempt {
  provider: Provider;
  status: number;
  upstreamModel: string;
  durationMs: number;
  retryable: boolean;
  streamed: boolean;
  usage: ParsedUsage;
  body?: Buffer;
  contentType?: string;
  errorPayload?: Record<string, unknown>;
}

interface GatewayRequestContext {
  authorized: boolean;
  provider: Provider | null;
  providerApiKey: string | null;
}

class GatewayRequestError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = 'GatewayRequestError';
  }
}

export class LocalGatewayRuntime {
  private server: http.Server | null = null;
  private readonly sockets = new Set<Socket>();
  private endpoint = 'http://127.0.0.1:3456/v1';
  private routeSettings = defaultRuntimeRouteSettings();

  constructor(
    private readonly providerService: ProviderService,
    private readonly codexConfig: CodexConfigService,
    private readonly usage: UsageService,
  ) {}

  async start(settings: RouteSettings): Promise<GatewayStatus> {
    this.routeSettings = normalizeRuntimeRouteSettings(settings);
    if (this.server) return this.status();

    const listenPort = this.routeSettings.listenPort;
    const listenAddress = this.routeSettings.listenAddress;
    this.endpoint = endpointForAddress(listenAddress, listenPort);

    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });

    try {
      await new Promise<void>((resolve, reject) => {
        this.server?.once('error', reject);
        this.server?.listen(listenPort, listenAddress, () => {
          this.server?.off('error', reject);
          const address = this.server?.address() as AddressInfo | null;
          if (address) this.endpoint = endpointForAddress(listenAddress, address.port);
          resolve();
        });
      });
    } catch (error) {
      this.server = null;
      throw error;
    }

    return this.status();
  }

  async stop(): Promise<GatewayStatus> {
    const server = this.server;
    this.server = null;
    if (server) {
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
    return this.status();
  }

  async status(): Promise<GatewayStatus> {
    const provider = await this.providerService.current();
    const status: GatewayStatus = {
      running: Boolean(this.server),
      endpoint: this.endpoint,
    };
    if (provider) {
      status.currentProviderId = provider.id;
      status.currentProviderName = provider.name;
      status.currentModel = providerSelectedDisplayModel(provider);
    }
    return status;
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      setCorsHeaders(response);
      if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return;
      }

      const url = new URL(request.url || '/', this.endpoint);
      if (url.pathname === '/__status' || url.pathname === '/v1/__status') {
        const context = await this.createRequestContext(request);
        await this.writeStatus(response, context.authorized);
        return;
      }

      const context = await this.createRequestContext(request);
      if (!context.authorized) {
        writeJson(response, 401, { error: 'Unauthorized local gateway request' });
        return;
      }

      const body = await readRequestBody(request);
      await this.forwardRequest(request, response, url, body, context);
    } catch (error) {
      if (response.headersSent || response.destroyed) {
        if (!response.writableEnded) response.end();
        return;
      }
      writeJson(response, error instanceof GatewayRequestError ? error.statusCode : 500, {
        error: error instanceof Error ? error.message : 'Local gateway request failed',
      });
    }
  }

  private async writeStatus(response: http.ServerResponse, includeDetails: boolean): Promise<void> {
    const provider = await this.providerService.current();
    if (!provider) {
      writeJson(response, 200, {
        gateway: 'running',
        endpoint: this.endpoint,
        current: null,
      });
      return;
    }

    writeJson(response, 200, {
      gateway: 'running',
      endpoint: this.endpoint,
      current: {
        id: provider.id,
        name: provider.name,
        baseURL: includeDetails ? provider.baseURL : '<redacted>',
        apiFormat: provider.apiFormat,
        models: includeDetails ? provider.models : [],
        model: providerSelectedDisplayModel(provider),
        tag: provider.tag ?? '',
      },
    });
  }

  private async createRequestContext(request: http.IncomingMessage): Promise<GatewayRequestContext> {
    const token = authorizationToken(request.headers.authorization);
    if (!token) return { authorized: false, provider: null, providerApiKey: null };

    const localGatewayAPIKey = await this.codexConfig.localGatewayAPIKey();
    if (token === localGatewayAPIKey) {
      const current = await this.providerService.currentRoutingProviderWithApiKey();
      return {
        authorized: true,
        provider: current?.provider ?? null,
        providerApiKey: current?.apiKey ?? null,
      };
    }

    const current = await this.providerService.currentRoutingProviderWithApiKey();
    const provider = current?.provider ?? null;
    const providerApiKey = current?.apiKey ?? null;
    return {
      authorized: Boolean(providerApiKey && providerApiKey === token),
      provider,
      providerApiKey,
    };
  }

  private async forwardRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL,
    body: Buffer,
    context: GatewayRequestContext,
  ): Promise<void> {
    const provider = context.provider;
    if (!provider) {
      writeJson(response, 503, { error: 'No active provider' });
      return;
    }

    const candidates = await this.candidateProviders(provider);
    let lastAttempt: ForwardAttempt | null = null;

    for (const candidate of candidates) {
      if (clientDisconnected(request, response)) return;
      const candidateApiKey = candidate.id === provider.id
        ? context.providerApiKey
        : await this.providerService.currentApiKey(candidate);
      const attempt = await this.forwardWithProvider(request, response, url, body, candidate, candidateApiKey);
      lastAttempt = attempt;
      if (attempt.streamed) {
        void this.recordUsage(attempt.provider, attempt.upstreamModel, attempt.status, attempt.durationMs, attempt.usage);
        return;
      }
      if (clientDisconnected(request, response) || response.headersSent) return;
      if (!attempt.retryable) break;
    }

    if (!lastAttempt) {
      writeJson(response, 503, { error: 'No active provider' });
      return;
    }

    if (lastAttempt.errorPayload) {
      void this.recordUsage(lastAttempt.provider, lastAttempt.upstreamModel, lastAttempt.status, lastAttempt.durationMs, lastAttempt.usage);
      writeJson(response, lastAttempt.status, lastAttempt.errorPayload);
      return;
    }

    const data = lastAttempt.body ?? Buffer.alloc(0);
    response.writeHead(lastAttempt.status, {
      'Content-Type': lastAttempt.contentType ?? 'application/json',
      'Content-Length': data.length,
      'Access-Control-Allow-Origin': 'http://127.0.0.1',
      ...gatewayMetadataHeaders(
        lastAttempt.provider,
        lastAttempt.upstreamModel,
        lastAttempt.durationMs,
        lastAttempt.provider.id !== provider.id,
      ),
    });
    response.end(data);
    void this.recordUsage(lastAttempt.provider, lastAttempt.upstreamModel, lastAttempt.status, lastAttempt.durationMs, lastAttempt.usage);
  }

  private async forwardWithProvider(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL,
    body: Buffer,
    provider: Provider,
    apiKey: string | null,
  ): Promise<ForwardAttempt> {
    const originalPath = normalizedGatewayPath(url.pathname);
    const method = request.method ?? 'GET';
    const clientWantsStream = originalPath === '/responses' && requestBodyWantsStream(body);
    const upstreamBody = method === 'GET' || method === 'HEAD'
      ? null
      : originalPath === '/responses'
        ? upstreamRequestBodyFromResponsesBody(body, provider, clientWantsStream)
        : upstreamRequestBodyFromGenericBody(body, provider);
    const bodyData = upstreamBody?.body;
    const upstreamModel = upstreamBody?.upstreamModel ?? providerSelectedCatalogModel(provider);
    const startedAt = performance.now();

    if (!apiKey) {
      return {
        provider,
        status: 503,
        upstreamModel,
        durationMs: Math.round(performance.now() - startedAt),
        retryable: true,
        streamed: false,
        usage: {},
        errorPayload: {
          error: 'Provider API Key is unavailable',
          provider: provider.name,
          baseURL: provider.baseURL,
          model: upstreamModel,
        },
      };
    }

    let upstreamURL: URL;
    try {
      const upstreamPath = upstreamPathForGatewayPath(originalPath, provider);
      upstreamURL = new URL(`${upstreamBaseURLForProvider(provider)}${upstreamPath}${url.search}`);
    } catch {
      return {
        provider,
        status: 500,
        upstreamModel,
        durationMs: Math.round(performance.now() - startedAt),
        retryable: true,
        streamed: false,
        usage: {},
        errorPayload: {
          error: 'Invalid provider baseURL',
          provider: provider.name,
          baseURL: provider.baseURL,
          model: upstreamModel,
        },
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), upstreamRequestTimeoutMs);
    const abortOnClientClose = () => controller.abort();
    request.once('aborted', abortOnClientClose);
    response.once('close', abortOnClientClose);

    try {
      const upstreamRequest: RequestInit = {
        method,
        headers: upstreamHeaders(request, provider, apiKey),
        signal: controller.signal,
      };
      if (bodyData) {
        upstreamRequest.body = bodyData.toString('utf8');
      }

      const upstreamResponse = await fetch(upstreamURL, upstreamRequest);
      if (upstreamResponse.status >= 200 && upstreamResponse.status < 300 && upstreamBody?.clientWantsStream) {
        const usage = await this.writeStreamingResponse(response, upstreamResponse, provider, upstreamModel, startedAt);
        const durationMs = Math.round(performance.now() - startedAt);
        return {
          provider,
          status: upstreamResponse.status,
          upstreamModel,
          durationMs,
          retryable: false,
          streamed: true,
          usage,
        };
      }

      const upstreamData = Buffer.from(await upstreamResponse.arrayBuffer());
      const usage = usageFromResponseBody(upstreamData);
      const durationMs = Math.round(performance.now() - startedAt);
      const adapted = upstreamResponse.status >= 200 && upstreamResponse.status < 300
        ? adaptUpstreamResponseToResponses(upstreamData, provider, originalPath, upstreamModel)
        : {
            body: upstreamData,
            contentType: upstreamResponse.headers.get('content-type') ?? 'application/json',
          };
      return {
        provider,
        status: upstreamResponse.status,
        upstreamModel,
        durationMs,
        retryable: upstreamResponse.status >= 500,
        streamed: false,
        usage,
        body: adapted.body,
        contentType: adapted.contentType,
      };
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      const status = aborted ? 504 : 502;
      const durationMs = Math.round(performance.now() - startedAt);
      return {
        provider,
        status,
        upstreamModel,
        durationMs,
        retryable: true,
        streamed: false,
        usage: {},
        errorPayload: {
          error: aborted ? 'Upstream request timed out before completion' : error instanceof Error ? error.message : 'Upstream request failed',
          provider: provider.name,
          baseURL: provider.baseURL,
          model: upstreamModel,
        },
      };
    } finally {
      clearTimeout(timeout);
      request.off('aborted', abortOnClientClose);
      response.off('close', abortOnClientClose);
    }
  }

  private async candidateProviders(primaryProvider: Provider): Promise<Provider[]> {
    if (!this.routeSettings.failoverEnabled) return [primaryProvider];
    const providers = await this.providerService.routingProviders();
    return [
      primaryProvider,
      ...providers.filter((provider) => provider.id !== primaryProvider.id),
    ];
  }

  private async writeStreamingResponse(
    response: http.ServerResponse,
    upstreamResponse: Response,
    provider: Provider,
    upstreamModel: string,
    startedAt: number,
  ): Promise<ParsedUsage> {
    const durationMs = Math.round(performance.now() - startedAt);
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': 'http://127.0.0.1',
      ...gatewayMetadataHeaders(provider, upstreamModel, durationMs),
    });

    if (!upstreamResponse.body) {
      response.end();
      return {};
    }

    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder();
    const usageParser = new StreamingUsageParser();

    if (provider.apiFormat === 'responses') {
      return pipeNativeResponsesStream(reader, response, usageParser);
    }

    const adapter = new ResponsesSSEAdapter(provider.apiFormat, upstreamModel);
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        if (response.destroyed || response.writableEnded) return usageParser.finish();
        const text = decoder.decode(result.value, { stream: true });
        usageParser.processTextChunk(text);
        for (const event of adapter.processTextChunk(text)) {
          if (response.destroyed || response.writableEnded) return usageParser.finish();
          if (!response.write(event)) await waitForDrain(response);
        }
      }
      const finalText = decoder.decode();
      usageParser.processTextChunk(finalText);
      for (const event of adapter.processTextChunk(finalText)) {
        if (response.destroyed || response.writableEnded) return usageParser.finish();
        if (!response.write(event)) await waitForDrain(response);
      }
      for (const event of adapter.finish()) {
        if (response.destroyed || response.writableEnded) return usageParser.finish();
        if (!response.write(event)) await waitForDrain(response);
      }
      return usageParser.finish();
    } finally {
      if (!response.destroyed && !response.writableEnded) response.end();
    }
  }

  private async recordUsage(
    provider: Provider,
    model: string,
    status: number,
    durationMs: number,
    parsedUsage: ParsedUsage,
  ): Promise<void> {
    await this.usage.record({
      provider: provider.name,
      model,
      status,
      durationMs,
      source: provider.apiFormat,
      ...parsedUsage,
    }).catch((error) => {
      console.error('Failed to record usage:', error);
    });
  }

}

function safePort(port: number): number {
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 3456;
}

function defaultRuntimeRouteSettings(): RouteSettings {
  return {
    mode: 'local_gateway',
    enabled: true,
    autoStart: true,
    disabledExplicitly: false,
    listenAddress: '127.0.0.1',
    listenPort: 3456,
    allowLANListen: false,
    failoverEnabled: false,
  };
}

function normalizeRuntimeRouteSettings(settings: RouteSettings): RouteSettings {
  const defaults = defaultRuntimeRouteSettings();
  const listenAddress = settings.listenAddress.trim() || defaults.listenAddress;
  const allowLANListen = Boolean(settings.allowLANListen);
  return {
    mode: 'local_gateway',
    enabled: Boolean(settings.enabled),
    autoStart: Boolean(settings.autoStart),
    disabledExplicitly: Boolean(settings.disabledExplicitly),
    listenAddress: normalizeRuntimeListenAddress(listenAddress, allowLANListen),
    listenPort: safePort(settings.listenPort),
    allowLANListen,
    failoverEnabled: Boolean(settings.failoverEnabled),
  };
}

function normalizeRuntimeListenAddress(address: string, allowLANListen: boolean): string {
  if (address === '127.0.0.1' || address === 'localhost' || address.startsWith('127.')) return address;
  return allowLANListen ? '0.0.0.0' : '127.0.0.1';
}

function endpointForAddress(address: string, port: number): string {
  const clientHost = address === '0.0.0.0' ? '127.0.0.1' : address;
  return `http://${clientHost}:${port}/v1`;
}

function setCorsHeaders(response: http.ServerResponse): void {
  response.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1');
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function writeJson(response: http.ServerResponse, status: number, payload: unknown): void {
  const data = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': data.length,
    'Access-Control-Allow-Origin': 'http://127.0.0.1',
  });
  response.end(data);
}

function gatewayMetadataHeaders(
  provider: Provider,
  upstreamModel: string,
  durationMs: number,
  failover?: boolean,
): Record<string, string> {
  return {
    'X-AI-Key-Switcher-Provider': safeHeaderValue(provider.name),
    'X-AI-Key-Switcher-Provider-Id': safeHeaderValue(provider.id),
    'X-AI-Key-Switcher-Base-URL': safeHeaderValue(provider.baseURL),
    'X-AI-Key-Switcher-API-Format': safeHeaderValue(provider.apiFormat),
    'X-AI-Key-Switcher-Model': safeHeaderValue(upstreamModel),
    ...(typeof failover === 'boolean' ? { 'X-AI-Key-Switcher-Failover': String(failover) } : {}),
    'X-AI-Key-Switcher-Duration-Ms': String(durationMs),
  };
}

function safeHeaderValue(value: string): string {
  try {
    return encodeURIComponent(value);
  } catch {
    return Buffer.from(value, 'utf8').toString('base64url');
  }
}

async function pipeNativeResponsesStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  response: http.ServerResponse,
  usageParser: StreamingUsageParser,
): Promise<ParsedUsage> {
  const decoder = new TextDecoder();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (response.destroyed || response.writableEnded) return usageParser.finish();
      const chunk = Buffer.from(result.value);
      usageParser.processTextChunk(decoder.decode(result.value, { stream: true }));
      if (!response.write(chunk)) await waitForDrain(response);
    }
    usageParser.processTextChunk(decoder.decode());
    return usageParser.finish();
  } finally {
    if (!response.destroyed && !response.writableEnded) response.end();
  }
}

function waitForDrain(response: http.ServerResponse): Promise<void> {
  if (response.destroyed || response.writableEnded) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      response.off('drain', done);
      response.off('close', done);
      response.off('error', done);
      resolve();
    };
    response.once('drain', done);
    response.once('close', done);
    response.once('error', done);
  });
}

function clientDisconnected(request: http.IncomingMessage, response: http.ServerResponse): boolean {
  return request.aborted || request.destroyed || response.destroyed || response.writableEnded;
}

async function readRequestBody(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxGatewayRequestBytes) {
    throw new GatewayRequestError('HTTP request is too large', 413);
  }
  let size = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > maxGatewayRequestBytes) {
      throw new GatewayRequestError('HTTP request is too large', 413);
    }
    chunks.push(data);
  }
  return Buffer.concat(chunks);
}

function authorizationToken(authorization: string | string[] | undefined): string {
  const value = Array.isArray(authorization) ? authorization[0] ?? '' : authorization ?? '';
  const trimmed = value.trim();
  return trimmed.toLowerCase().startsWith('bearer ') ? trimmed.slice(7).trim() : trimmed;
}

function normalizedGatewayPath(pathname: string): string {
  if (pathname.startsWith('/v1/')) return pathname.slice(3);
  if (pathname === '/v1') return '';
  return pathname;
}

function upstreamHeaders(request: http.IncomingMessage, provider: Provider, apiKey: string): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    const lower = key.toLowerCase();
    if (['host', 'content-length', 'connection', 'authorization'].includes(lower)) continue;
    if (Array.isArray(value)) headers.set(key, value.join(', '));
    else if (value !== undefined) headers.set(key, value);
  }

  if (provider.apiFormat === 'anthropic_messages') {
    headers.set('x-api-key', apiKey);
    headers.set('anthropic-version', '2023-06-01');
  } else {
    headers.set('Authorization', `Bearer ${apiKey}`);
  }
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return headers;
}
