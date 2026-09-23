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
  GatewayCompatibilityError,
  NativeResponsesSSEAdapter,
  providerForRequest,
  type ParsedUsage,
  requestBodyWantsStream,
  ResponsesSSEAdapter,
  StreamingUsageParser,
  upstreamAPIFormatForProvider,
  upstreamBaseURLForProvider,
  upstreamPathForGatewayPath,
  upstreamRequestBodyFromGenericBody,
  upstreamRequestBodyFromResponsesBody,
  usageFromResponseBody,
} from './gateway-protocol-adapter';

const maxGatewayRequestBytes = 64 * 1024 * 1024;
const defaultGatewayTimeoutSettings = {
  requestBodyMs: 30_000,
  upstreamResponseHeadersMs: 120_000,
  upstreamRequestMs: 600_000,
  upstreamStreamIdleMs: 120_000,
};

type GatewayTimeoutSettings = typeof defaultGatewayTimeoutSettings;

type AttemptErrorCategory = 'missing_api_key' | 'credential_error' | 'invalid_base_url' | 'upstream_5xx' | 'timeout' | 'network' | 'stream';

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
  errorCategory?: AttemptErrorCategory;
}

interface StreamResult {
  usage: ParsedUsage;
  failed: boolean;
}

interface ProviderCircuitState {
  consecutiveFailures: number;
  openedAt: number | null;
  halfOpenInFlight: number;
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
  private readonly circuitStates = new Map<string, ProviderCircuitState>();

  constructor(
    private readonly providerService: ProviderService,
    private readonly codexConfig: CodexConfigService,
    private readonly usage: UsageService,
    private readonly timeoutSettings: GatewayTimeoutSettings = defaultGatewayTimeoutSettings,
  ) {}

  async start(settings: RouteSettings): Promise<GatewayStatus> {
    const nextSettings = normalizeRuntimeRouteSettings(settings);
    const bindingChanged = Boolean(this.server)
      && (this.routeSettings.listenAddress !== nextSettings.listenAddress || this.routeSettings.listenPort !== nextSettings.listenPort);
    if (this.routeSettings.failoverEnabled && !nextSettings.failoverEnabled) {
      this.circuitStates.clear();
    }
    if (bindingChanged) await this.stop();
    this.routeSettings = nextSettings;
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

      const body = await readRequestBody(request, this.timeoutSettings.requestBodyMs);
      await this.forwardRequest(request, response, url, body, context);
    } catch (error) {
      if (response.headersSent || response.destroyed) {
        if (!response.writableEnded) response.end();
        return;
      }
      writeJson(response, error instanceof GatewayRequestError || error instanceof GatewayCompatibilityError ? error.statusCode : 500, {
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
    const primaryProvider = context.provider;
    if (!primaryProvider) {
      writeJson(response, 503, { error: 'No active provider' });
      return;
    }

    const requestId = crypto.randomUUID();
    const requestedModel = requestedModelFromRequestBody(body);
    const candidates = await this.candidateProviders(primaryProvider);
    const maxAttempts = this.routeSettings.failoverEnabled ? this.routeSettings.failoverMaxAttempts : 1;
    const deadlineAt = performance.now() + this.routeSettings.failoverTotalTimeoutMs;
    let lastAttempt: ForwardAttempt | null = null;
    let attemptNumber = 0;

    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
      if (attemptNumber >= maxAttempts) break;
      const candidate = candidates[candidateIndex];
      if (!candidate) continue;
      if (clientDisconnected(request, response)) return;
      const remainingMs = Math.round(deadlineAt - performance.now());
      if (remainingMs <= 0) {
        lastAttempt = totalDeadlineAttempt(candidate, requestedModel, this.routeSettings.failoverTotalTimeoutMs);
        void this.recordUsageAttempt(requestId, attemptNumber + 1, candidate.id !== primaryProvider.id, true, lastAttempt);
        break;
      }
      const circuitPermit = this.acquireCircuitPermit(candidate.id);
      if (!circuitPermit.allowed) continue;

      attemptNumber++;
      const failover = candidate.id !== primaryProvider.id;
      let attempt: ForwardAttempt;
      try {
        attempt = await this.forwardCandidate(
          request,
          response,
          url,
          body,
          candidate,
          primaryProvider.id === candidate.id ? context.providerApiKey : undefined,
          remainingMs,
          failover,
        );
      } finally {
        this.releaseHalfOpenPermit(candidate.id, circuitPermit.halfOpen);
      }
      lastAttempt = attempt;
      const willRetry = attempt.retryable
        && !attempt.streamed
        && attemptNumber < maxAttempts
        && candidates.slice(candidateIndex + 1).some((next) => this.circuitAvailable(next.id))
        && performance.now() < deadlineAt;
      this.updateCircuitState(candidate.id, attempt);
      void this.recordUsageAttempt(requestId, attemptNumber, failover, !willRetry, attempt);

      if (attempt.streamed) return;
      if (clientDisconnected(request, response) || response.headersSent) return;
      if (!willRetry) break;
    }

    if (!lastAttempt) {
      writeJson(response, 503, { error: 'No available provider; all configured circuits are open' });
      return;
    }

    if (lastAttempt.errorPayload) {
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
        lastAttempt.provider.id !== primaryProvider.id,
      ),
    });
    response.end(data);
  }

  private async forwardCandidate(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL,
    body: Buffer,
    candidate: Provider,
    primaryApiKey: string | null | undefined,
    remainingRequestMs: number,
    failover: boolean,
  ): Promise<ForwardAttempt> {
    let apiKey: string | null;
    try {
      apiKey = primaryApiKey !== undefined
        ? primaryApiKey
        : await this.providerService.currentApiKey(candidate);
    } catch {
      const provider = providerForAttempt(candidate, body, failover);
      return {
        provider,
        status: 503,
        upstreamModel: providerSelectedCatalogModel(provider),
        durationMs: 0,
        retryable: true,
        streamed: false,
        usage: {},
        errorCategory: 'credential_error',
        errorPayload: {
          error: 'Provider API Key is unavailable',
          provider: provider.name,
          baseURL: provider.baseURL,
          model: providerSelectedCatalogModel(provider),
        },
      };
    }

    return this.forwardWithProvider(request, response, url, body, candidate, apiKey, remainingRequestMs, failover);
  }

  private async forwardWithProvider(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL,
    body: Buffer,
    provider: Provider,
    apiKey: string | null,
    remainingRequestMs: number,
    failover: boolean,
  ): Promise<ForwardAttempt> {
    provider = providerForAttempt(provider, body, failover);
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
        provider, status: 503, upstreamModel, durationMs: 0, retryable: true, streamed: false, usage: {},
        errorCategory: 'missing_api_key',
        errorPayload: { error: 'Provider API Key is unavailable', provider: provider.name, baseURL: provider.baseURL, model: upstreamModel },
      };
    }

    let upstreamURL: URL;
    try {
      const upstreamPath = upstreamPathForGatewayPath(originalPath, provider);
      upstreamURL = new URL(`${upstreamBaseURLForProvider(provider)}${upstreamPath}${url.search}`);
    } catch {
      return {
        provider, status: 500, upstreamModel, durationMs: 0, retryable: true, streamed: false, usage: {},
        errorCategory: 'invalid_base_url',
        errorPayload: { error: 'Invalid provider baseURL', provider: provider.name, baseURL: provider.baseURL, model: upstreamModel },
      };
    }

    const controller = new AbortController();
    let timeout = abortAfter(
      controller,
      Math.min(this.timeoutSettings.upstreamResponseHeadersMs, remainingRequestMs),
      `Upstream did not return response headers before the request deadline`,
    );
    const abortOnClientClose = () => controller.abort();
    request.once('aborted', abortOnClientClose);
    response.once('close', abortOnClientClose);

    try {
      const upstreamRequest: RequestInit = { method, headers: upstreamHeaders(request, provider, apiKey), signal: controller.signal };
      if (bodyData) upstreamRequest.body = bodyData.toString('utf8');
      const upstreamResponse = await fetch(upstreamURL, upstreamRequest);
      clearTimeout(timeout);
      const requestRemainingMs = Math.max(1, Math.round(remainingRequestMs - (performance.now() - startedAt)));
      timeout = abortAfter(
        controller,
        Math.min(this.timeoutSettings.upstreamRequestMs, requestRemainingMs),
        'Upstream request did not complete before the request deadline',
      );

      if (upstreamResponse.status >= 200 && upstreamResponse.status < 300 && upstreamBody?.clientWantsStream) {
        clearTimeout(timeout);
        const totalStreamTimeout = abortAfter(
          controller,
          requestRemainingMs,
          'Upstream stream exceeded the total request deadline',
        );
        timeout = abortAfter(
          controller,
          Math.min(this.timeoutSettings.upstreamStreamIdleMs, requestRemainingMs),
          'Upstream stream was idle before the request deadline',
        );
        try {
          const stream = await this.writeStreamingResponse(response, upstreamResponse, provider, upstreamModel, startedAt, () => timeout.refresh(), failover);
          return {
            provider,
            status: stream.failed ? controller.signal.aborted ? 504 : 502 : upstreamResponse.status,
            upstreamModel,
            durationMs: Math.round(performance.now() - startedAt),
            retryable: false,
            streamed: true,
            usage: stream.usage,
            ...(stream.failed ? { errorCategory: 'stream' as const } : {}),
          };
        } finally {
          clearTimeout(totalStreamTimeout);
        }
      }

      const upstreamData = Buffer.from(await upstreamResponse.arrayBuffer());
      const usage = usageFromResponseBody(upstreamData);
      const adapted = upstreamResponse.status >= 200 && upstreamResponse.status < 300
        ? adaptUpstreamResponseToResponses(upstreamData, provider, originalPath, upstreamModel)
        : { body: upstreamData, contentType: upstreamResponse.headers.get('content-type') ?? 'application/json' };
      return {
        provider, status: upstreamResponse.status, upstreamModel,
        durationMs: Math.round(performance.now() - startedAt),
        retryable: upstreamResponse.status >= 500, streamed: false, usage, body: adapted.body, contentType: adapted.contentType,
        ...(upstreamResponse.status >= 500 ? { errorCategory: 'upstream_5xx' as const } : {}),
      };
    } catch (error) {
      const aborted = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
      return {
        provider, status: aborted ? 504 : 502, upstreamModel, durationMs: Math.round(performance.now() - startedAt),
        retryable: true, streamed: false, usage: {}, errorCategory: aborted ? 'timeout' : 'network',
        errorPayload: {
          error: aborted ? abortReasonMessage(controller.signal) : error instanceof Error ? error.message : 'Upstream request failed',
          provider: provider.name, baseURL: provider.baseURL, model: upstreamModel,
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
    return [primaryProvider, ...providers.filter((provider) => provider.id !== primaryProvider.id)];
  }

  private circuitAvailable(providerId: string): boolean {
    if (!this.routeSettings.failoverEnabled) return true;
    const state = this.circuitStates.get(providerId);
    if (!state?.openedAt) return true;
    return Date.now() - state.openedAt >= this.routeSettings.failoverCooldownMs
      && state.halfOpenInFlight < this.routeSettings.failoverHalfOpenMaxRequests;
  }

  private acquireCircuitPermit(providerId: string): { allowed: boolean; halfOpen: boolean } {
    if (!this.routeSettings.failoverEnabled) return { allowed: true, halfOpen: false };
    const state = this.circuitStates.get(providerId);
    if (!state?.openedAt) return { allowed: true, halfOpen: false };
    if (Date.now() - state.openedAt < this.routeSettings.failoverCooldownMs) return { allowed: false, halfOpen: false };
    if (state.halfOpenInFlight >= this.routeSettings.failoverHalfOpenMaxRequests) return { allowed: false, halfOpen: false };
    state.halfOpenInFlight++;
    return { allowed: true, halfOpen: true };
  }

  private releaseHalfOpenPermit(providerId: string, halfOpen: boolean): void {
    if (!halfOpen) return;
    const state = this.circuitStates.get(providerId);
    if (state) state.halfOpenInFlight = Math.max(0, state.halfOpenInFlight - 1);
  }

  private updateCircuitState(providerId: string, attempt: ForwardAttempt): void {
    if (!this.routeSettings.failoverEnabled) return;
    const state = this.circuitStates.get(providerId) ?? { consecutiveFailures: 0, openedAt: null, halfOpenInFlight: 0 };
    const failed = attempt.retryable || attempt.errorCategory === 'stream';
    if (!failed) {
      state.consecutiveFailures = 0;
      state.openedAt = null;
    } else {
      state.consecutiveFailures++;
      if (state.consecutiveFailures >= this.routeSettings.failoverFailureThreshold) state.openedAt = Date.now();
    }
    this.circuitStates.set(providerId, state);
  }

  private recordUsageAttempt(
    requestId: string, attemptNumber: number, failover: boolean, finalAttempt: boolean, attempt: ForwardAttempt,
  ): Promise<void> {
    return this.usage.record({
      provider: attempt.provider.name, model: attempt.upstreamModel, status: attempt.status, durationMs: attempt.durationMs,
      source: attempt.provider.apiFormat, ...attempt.usage, requestId, attempt: attemptNumber, failover, finalAttempt,
      ...(attempt.errorCategory ? { errorCategory: attempt.errorCategory } : {}),
    }).catch((error) => console.error('Failed to record usage:', error));
  }

  private async writeStreamingResponse(
    response: http.ServerResponse,
    upstreamResponse: Response,
    provider: Provider,
    upstreamModel: string,
    startedAt: number,
    onStreamChunk: () => void,
    failover: boolean,
  ): Promise<StreamResult> {
    const durationMs = Math.round(performance.now() - startedAt);
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': 'http://127.0.0.1',
      ...gatewayMetadataHeaders(provider, upstreamModel, durationMs, failover),
    });

    if (!upstreamResponse.body) {
      response.end();
      return { usage: {}, failed: true };
    }

    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder();
    const usageParser = new StreamingUsageParser();

    const upstreamAPIFormat = upstreamAPIFormatForProvider(provider);
    if (upstreamAPIFormat === 'responses') {
      return pipeNativeResponsesStream(reader, response, usageParser, upstreamModel, onStreamChunk);
    }

    const adapter = new ResponsesSSEAdapter(upstreamAPIFormat, upstreamModel);
    const result = (): StreamResult => ({ usage: usageParser.finish(), failed: adapter.failed });
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        if (response.destroyed || response.writableEnded) return { usage: usageParser.finish(), failed: true };
        onStreamChunk();
        const text = decoder.decode(result.value, { stream: true });
        usageParser.processTextChunk(text);
        for (const event of adapter.processTextChunk(text)) {
          if (response.destroyed || response.writableEnded) return { usage: usageParser.finish(), failed: true };
          if (!response.write(event)) await waitForDrain(response);
        }
      }
      const finalText = decoder.decode();
      usageParser.processTextChunk(finalText);
      for (const event of adapter.processTextChunk(finalText)) {
        if (response.destroyed || response.writableEnded) return { usage: usageParser.finish(), failed: true };
        if (!response.write(event)) await waitForDrain(response);
      }
      for (const event of adapter.finish()) {
        if (response.destroyed || response.writableEnded) return { usage: usageParser.finish(), failed: true };
        if (!response.write(event)) await waitForDrain(response);
      }
      return result();
    } catch (error) {
      const events = adapter.fail(error instanceof Error ? error.message : 'Upstream stream interrupted');
      if (!response.destroyed && !response.writableEnded) {
        for (const event of events) {
          if (response.destroyed || response.writableEnded) break;
          if (!response.write(event)) await waitForDrain(response);
        }
        if (!response.writableEnded) response.end();
      }
      return result();
    } finally {
      if (!response.destroyed && !response.writableEnded) response.end();
    }
  }


}

function clampInteger(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function requestedModelFromRequestBody(body: Buffer): string {
  try {
    const payload = JSON.parse(body.toString('utf8')) as { model?: unknown };
    return typeof payload.model === 'string' ? payload.model.trim() : '';
  } catch {
    return '';
  }
}

function providerForAttempt(provider: Provider, body: Buffer, failover: boolean): Provider {
  const mappedModel = failover ? validMappedModel(provider, requestedModelFromRequestBody(body)) : '';
  const selected = mappedModel ? { ...provider, selectedModel: mappedModel } : providerForRequest(provider, body);
  return { ...selected, apiFormat: upstreamAPIFormatForProvider(selected) };
}

function validMappedModel(provider: Provider, requestedModel: string): string {
  const target = provider.failover?.modelMappings?.[requestedModel]?.trim();
  if (!target) return '';
  const model = provider.models.find((candidate) => candidate.customName === target || candidate.model === target);
  return model?.customName || model?.model || '';
}

function totalDeadlineAttempt(provider: Provider, requestedModel: string, timeoutMs: number): ForwardAttempt {
  return {
    provider, status: 504, upstreamModel: requestedModel || providerSelectedCatalogModel(provider), durationMs: timeoutMs,
    retryable: false, streamed: false, usage: {}, errorCategory: 'timeout',
    errorPayload: { error: `Failover request exceeded total timeout of ${timeoutMs}ms`, provider: provider.name },
  };
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
    failoverMaxAttempts: 3,
    failoverTotalTimeoutMs: 180_000,
    failoverFailureThreshold: 3,
    failoverCooldownMs: 60_000,
    failoverHalfOpenMaxRequests: 1,
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
    failoverMaxAttempts: clampInteger(settings.failoverMaxAttempts, 1, 20, defaults.failoverMaxAttempts),
    failoverTotalTimeoutMs: clampInteger(settings.failoverTotalTimeoutMs, 1_000, 1_800_000, defaults.failoverTotalTimeoutMs),
    failoverFailureThreshold: clampInteger(settings.failoverFailureThreshold, 1, 100, defaults.failoverFailureThreshold),
    failoverCooldownMs: clampInteger(settings.failoverCooldownMs, 1_000, 3_600_000, defaults.failoverCooldownMs),
    failoverHalfOpenMaxRequests: clampInteger(settings.failoverHalfOpenMaxRequests, 1, 20, defaults.failoverHalfOpenMaxRequests),
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
  upstreamModel: string,
  onStreamChunk: () => void,
): Promise<StreamResult> {
  const decoder = new TextDecoder();
  const adapter = new NativeResponsesSSEAdapter(upstreamModel);
  const result = (): StreamResult => ({ usage: usageParser.finish(), failed: adapter.failed });
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (response.destroyed || response.writableEnded) return { usage: usageParser.finish(), failed: true };
      onStreamChunk();
      const text = decoder.decode(result.value, { stream: true });
      usageParser.processTextChunk(text);
      for (const event of adapter.processTextChunk(text)) {
        if (response.destroyed || response.writableEnded) return { usage: usageParser.finish(), failed: true };
        if (!response.write(event)) await waitForDrain(response);
      }
    }
    const finalText = decoder.decode();
    usageParser.processTextChunk(finalText);
    for (const event of adapter.processTextChunk(finalText)) {
      if (response.destroyed || response.writableEnded) return { usage: usageParser.finish(), failed: true };
      if (!response.write(event)) await waitForDrain(response);
    }
    for (const event of adapter.finish()) {
      if (response.destroyed || response.writableEnded) return { usage: usageParser.finish(), failed: true };
      if (!response.write(event)) await waitForDrain(response);
    }
    return result();
  } catch (error) {
    const events = adapter.fail(error instanceof Error ? error.message : 'Upstream stream interrupted');
    if (!response.destroyed && !response.writableEnded) {
      for (const event of events) {
        if (response.destroyed || response.writableEnded) break;
        if (!response.write(event)) await waitForDrain(response);
      }
      if (!response.writableEnded) response.end();
    }
    return result();
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
  // IncomingMessage.destroyed can be true after the request body is read normally.
  // Treating it as a disconnect makes the gateway skip upstream forwarding and
  // leave the client response open.
  return request.aborted || response.destroyed || response.writableEnded;
}

async function readRequestBody(request: http.IncomingMessage, timeoutMs: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxGatewayRequestBytes) {
    throw new GatewayRequestError('HTTP request is too large', 413);
  }
  let size = 0;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    request.destroy(new GatewayRequestError('HTTP request body timed out', 408));
  }, timeoutMs);

  try {
    for await (const chunk of request) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += data.length;
      if (size > maxGatewayRequestBytes) {
        throw new GatewayRequestError('HTTP request is too large', 413);
      }
      chunks.push(data);
    }
  } catch (error) {
    if (timedOut) throw new GatewayRequestError('HTTP request body timed out', 408);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  return Buffer.concat(chunks);
}

function abortAfter(controller: AbortController, timeoutMs: number, message: string): NodeJS.Timeout {
  return setTimeout(() => {
    if (!controller.signal.aborted) controller.abort(new Error(message));
  }, timeoutMs);
}

function abortReasonMessage(signal: AbortSignal): string {
  const reason = signal.reason;
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === 'string' && reason.trim()) return reason;
  return 'Upstream request timed out before completion';
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
