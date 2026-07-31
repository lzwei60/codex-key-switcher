import { providerSelectedCatalogModel, providerSelectedModel } from '@codex-key-switcher/core';
import type { Provider } from '@codex-key-switcher/shared';

export interface UpstreamRequestBody {
  body: Buffer;
  upstreamModel: string;
  clientWantsStream: boolean;
}

export interface AdaptedUpstreamResponse {
  body: Buffer;
  contentType: string;
}

export interface ParsedUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
}

export class ResponsesSSEAdapter {
  private readonly responseId = `resp_${crypto.randomUUID()}`;
  private readonly textItemId = `msg_${crypto.randomUUID()}`;
  private lineBuffer = '';
  private responseStarted = false;
  private textStarted = false;
  private nextOutputIndex = 0;
  private textOutputIndex = 0;
  private fullText = '';
  private readonly toolStates = new Map<number, ToolStreamState>();
  private readonly completedItems: unknown[] = [];

  constructor(
    private readonly apiFormat: Provider['apiFormat'],
    private readonly model: string,
  ) {}

  processTextChunk(chunk: string): string[] {
    this.lineBuffer += chunk;
    const lines = this.lineBuffer.split(/\r?\n/);
    this.lineBuffer = lines.pop() ?? '';
    return lines.flatMap((line) => this.processSSELine(line));
  }

  finish(): string[] {
    const events: string[] = [];
    if (this.lineBuffer.trim()) events.push(...this.processSSELine(this.lineBuffer));
    this.lineBuffer = '';
    events.push(...this.finishTextIfNeeded());
    events.push(...this.finishToolStates());
    events.push(...this.emitResponseStart());
    events.push(responsesSSEEvent('response.completed', {
      response: responseObjectWithId(this.responseId, this.model, 'completed', this.completedItems),
    }));
    return events;
  }

  private processSSELine(rawLine: string): string[] {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) return [];
    const jsonText = line.slice(5).trim();
    if (!jsonText || jsonText === '[DONE]') return [];

    const payload = jsonObjectFromString(jsonText);
    if (!payload) return [];
    if (this.apiFormat === 'chat_completions') return this.processChatPayload(payload);
    if (this.apiFormat === 'anthropic_messages') return this.processAnthropicPayload(payload);
    return [];
  }

  private processChatPayload(payload: Record<string, unknown>): string[] {
    const firstChoice = Array.isArray(payload.choices) && isRecord(payload.choices[0]) ? payload.choices[0] : null;
    const delta = firstChoice && isRecord(firstChoice.delta) ? firstChoice.delta : null;
    if (!delta) return [];

    const events: string[] = [];
    const content = typeof delta.content === 'string' ? delta.content : '';
    if (content) events.push(...this.emitTextDelta(content));

    if (Array.isArray(delta.tool_calls)) {
      for (const toolCall of delta.tool_calls) {
        if (!isRecord(toolCall)) continue;
        const upstreamIndex = typeof toolCall.index === 'number' ? toolCall.index : 0;
        const fn = isRecord(toolCall.function) ? toolCall.function : {};
        const callId = stringValue(toolCall.id);
        const name = stringValue(fn.name);
        const argumentsDelta = typeof fn.arguments === 'string' ? fn.arguments : '';
        events.push(...this.emitToolArgumentsDelta(upstreamIndex, callId, name, argumentsDelta));
      }
    }
    return events;
  }

  private processAnthropicPayload(payload: Record<string, unknown>): string[] {
    const type = stringValue(payload.type);
    const index = typeof payload.index === 'number' ? payload.index : 0;
    const events: string[] = [];

    if (type === 'content_block_start') {
      const block = isRecord(payload.content_block) ? payload.content_block : {};
      const blockType = stringValue(block.type);
      if (blockType === 'text') {
        events.push(...this.emitTextDelta(typeof block.text === 'string' ? block.text : ''));
      } else if (blockType === 'tool_use') {
        const state = this.ensureToolState(index, stringValue(block.id), stringValue(block.name));
        if (isRecord(block.input) && Object.keys(block.input).length > 0) {
          events.push(...this.emitToolArgumentsDelta(index, state.callId, state.name, JSON.stringify(block.input)));
        }
      }
      return events;
    }

    if (type === 'content_block_delta') {
      const delta = isRecord(payload.delta) ? payload.delta : {};
      const deltaType = stringValue(delta.type);
      if (deltaType === 'text_delta') {
        events.push(...this.emitTextDelta(typeof delta.text === 'string' ? delta.text : ''));
      } else if (deltaType === 'input_json_delta') {
        const state = this.ensureToolState(index, null, null);
        events.push(...this.emitToolArgumentsDelta(index, state.callId, state.name, typeof delta.partial_json === 'string' ? delta.partial_json : ''));
      }
    }

    return events;
  }

  private emitResponseStart(): string[] {
    if (this.responseStarted) return [];
    this.responseStarted = true;
    const response = responseObjectWithId(this.responseId, this.model, 'in_progress', []);
    return [
      responsesSSEEvent('response.created', { response }),
      responsesSSEEvent('response.in_progress', { response }),
    ];
  }

  private ensureTextStarted(): string[] {
    const events = this.emitResponseStart();
    if (this.textStarted) return events;
    this.textStarted = true;
    this.textOutputIndex = this.nextOutputIndex++;
    return [
      ...events,
      responsesSSEEvent('response.output_item.added', {
        output_index: this.textOutputIndex,
        item: {
          id: this.textItemId,
          type: 'message',
          status: 'in_progress',
          role: 'assistant',
          content: [],
        },
      }),
      responsesSSEEvent('response.content_part.added', {
        item_id: this.textItemId,
        output_index: this.textOutputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      }),
    ];
  }

  private emitTextDelta(delta: string): string[] {
    if (!delta) return [];
    this.fullText += delta;
    return [
      ...this.ensureTextStarted(),
      responsesSSEEvent('response.output_text.delta', {
        item_id: this.textItemId,
        output_index: this.textOutputIndex,
        content_index: 0,
        delta,
      }),
    ];
  }

  private finishTextIfNeeded(): string[] {
    if (!this.textStarted) return [];
    const doneItem = messageOutputItemWithId(this.textItemId, this.fullText);
    this.completedItems.push(doneItem);
    this.textStarted = false;
    return [
      responsesSSEEvent('response.output_text.done', {
        item_id: this.textItemId,
        output_index: this.textOutputIndex,
        content_index: 0,
        text: this.fullText,
      }),
      responsesSSEEvent('response.content_part.done', {
        item_id: this.textItemId,
        output_index: this.textOutputIndex,
        content_index: 0,
        part: { type: 'output_text', text: this.fullText, annotations: [] },
      }),
      responsesSSEEvent('response.output_item.done', {
        output_index: this.textOutputIndex,
        item: doneItem,
      }),
    ];
  }

  private ensureToolState(upstreamIndex: number, callId: string | null, name: string | null): ToolStreamState {
    const existing = this.toolStates.get(upstreamIndex);
    if (existing) {
      if (callId) existing.callId = callId;
      if (name) existing.name = name;
      return existing;
    }

    const state: ToolStreamState = {
      itemId: `fc_${crypto.randomUUID()}`,
      outputIndex: this.nextOutputIndex++,
      callId: callId?.trim() || `call_${crypto.randomUUID()}`,
      name: name?.trim() || '',
      argumentsText: '',
      added: false,
    };
    this.toolStates.set(upstreamIndex, state);
    return state;
  }

  private emitToolArgumentsDelta(upstreamIndex: number, callId: string | null, name: string | null, delta: string): string[] {
    const events = this.emitResponseStart();
    const state = this.ensureToolState(upstreamIndex, callId, name);
    const output: string[] = [...events];
    output.push(...this.emitToolStartIfNeeded(state));
    if (delta) {
      state.argumentsText += delta;
      output.push(responsesSSEEvent('response.function_call_arguments.delta', {
        item_id: state.itemId,
        output_index: state.outputIndex,
        delta,
      }));
    }
    return output;
  }

  private finishToolStates(): string[] {
    const events: string[] = [];
    const states = [...this.toolStates.values()].sort((a, b) => a.outputIndex - b.outputIndex);
    for (const state of states) {
      events.push(...this.emitResponseStart());
      events.push(...this.emitToolStartIfNeeded(state));
      const argumentsText = state.argumentsText.trim() || '{}';
      const doneItem = {
        id: state.itemId,
        type: 'function_call',
        status: 'completed',
        call_id: state.callId,
        name: state.name,
        arguments: argumentsText,
      };
      events.push(
        responsesSSEEvent('response.function_call_arguments.done', {
          item_id: state.itemId,
          name: state.name,
          output_index: state.outputIndex,
          arguments: argumentsText,
        }),
        responsesSSEEvent('response.output_item.done', {
          output_index: state.outputIndex,
          item: doneItem,
        }),
      );
      this.completedItems.push(doneItem);
    }
    this.toolStates.clear();
    return events;
  }

  private emitToolStartIfNeeded(state: ToolStreamState): string[] {
    if (state.added) return [];
    state.added = true;
    return [responsesSSEEvent('response.output_item.added', {
      output_index: state.outputIndex,
      item: {
        id: state.itemId,
        type: 'function_call',
        status: 'in_progress',
        call_id: state.callId,
        name: state.name,
        arguments: '',
      },
    })];
  }
}

interface ToolStreamState {
  itemId: string;
  outputIndex: number;
  callId: string;
  name: string;
  argumentsText: string;
  added: boolean;
}

export function upstreamPathForGatewayPath(pathname: string, provider: Provider): string {
  if (pathname !== '/responses') return pathname;

  if (provider.apiFormat === 'chat_completions') {
    return openAICompatibleEndpointPath('/chat/completions', provider);
  }
  if (provider.apiFormat === 'anthropic_messages') {
    return versionedEndpointPath('/messages', provider);
  }
  return versionedEndpointPath('/responses', provider);
}

export function upstreamBaseURLForProvider(provider: Provider): string {
  const trimmed = provider.baseURL.trim().replace(/\/+$/, '');
  if (!isDeepSeekOpenAICompatibleProvider(provider)) return trimmed;

  try {
    const url = new URL(trimmed);
    if (url.pathname.replace(/\/+$/, '') === '/v1') {
      url.pathname = '';
      return url.toString().replace(/\/+$/, '');
    }
  } catch {
    return trimmed;
  }

  return trimmed;
}

export function upstreamRequestBodyFromResponsesBody(body: Buffer, provider: Provider, forceStream: boolean): UpstreamRequestBody {
  const responsesBody = requestBodyByApplyingActiveModel(body, provider, forceStream);
  const upstreamModel = requestedModelFromBody(responsesBody) ?? providerSelectedCatalogModel(provider);
  const clientWantsStream = requestBodyWantsStream(body);

  if (provider.apiFormat === 'chat_completions') {
    return {
      body: chatCompletionsBodyFromResponsesBody(responsesBody, provider, forceStream),
      upstreamModel,
      clientWantsStream,
    };
  }
  if (provider.apiFormat === 'anthropic_messages') {
    return {
      body: anthropicMessagesBodyFromResponsesBody(responsesBody, forceStream),
      upstreamModel,
      clientWantsStream,
    };
  }

  return {
    body: responsesBody,
    upstreamModel,
    clientWantsStream,
  };
}

export function adaptUpstreamResponseToResponses(data: Buffer, provider: Provider, originalPath: string, model: string): AdaptedUpstreamResponse {
  if (originalPath !== '/responses') return { body: data, contentType: 'application/json' };

  if (provider.apiFormat === 'chat_completions') {
    return {
      body: jsonBuffer(responseObjectWithOutputItems(outputItemsFromChatCompletionsData(data), model)),
      contentType: 'application/json',
    };
  }

  if (provider.apiFormat === 'anthropic_messages') {
    return {
      body: jsonBuffer(responseObjectWithOutputItems(outputItemsFromAnthropicMessagesData(data), model)),
      contentType: 'application/json',
    };
  }

  return { body: data, contentType: 'application/json' };
}

export function requestedModelFromBody(body: Buffer | Uint8Array | undefined): string | null {
  const payload = jsonObjectFromBody(body);
  return stringValue(payload?.model);
}

export function requestBodyWantsStream(body: Buffer | Uint8Array | undefined): boolean {
  const payload = jsonObjectFromBody(body);
  return payload?.stream === true;
}

export function usageFromResponseBody(body: Buffer): ParsedUsage {
  if (!body.length) return {};

  const json = jsonObjectFromBody(body);
  const usage = usageObjectFromPayload(json);
  if (usage) return usageFromObject(usage);

  const text = body.toString('utf8');
  const lines = text.split(/\r?\n/).reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const jsonText = trimmed.slice(5).trim();
    if (!jsonText || jsonText === '[DONE]') continue;
    const payload = jsonObjectFromString(jsonText);
    const eventUsage = usageObjectFromPayload(payload);
    if (eventUsage) return usageFromObject(eventUsage);
  }

  return {};
}

function requestBodyByApplyingActiveModel(body: Buffer, provider: Provider, forceStream: boolean): Buffer {
  const payload = jsonObjectFromBody(body);
  if (!payload) return body;

  const selectedModel = providerSelectedModel(provider);
  const upstreamModel = selectedModel?.model.trim() || stringValue(payload.model);
  if (upstreamModel) payload.model = upstreamModel;
  if (forceStream || payload.stream === true) payload.stream = forceStream;
  removeUnsupportedCodexMetadata(payload);
  normalizeResponsesInputForUpstream(payload);
  return jsonBuffer(payload);
}

function chatCompletionsBodyFromResponsesBody(body: Buffer, provider: Provider, stream: boolean): Buffer {
  const payload = jsonObjectFromBody(body);
  if (!payload) return body;

  const converted: Record<string, unknown> = {
    model: stringValue(payload.model) ?? '',
    messages: chatMessagesFromResponsesPayload(payload),
    stream,
  };
  const maxTokens = payload.max_output_tokens ?? payload.max_tokens;
  if (maxTokens !== undefined) converted.max_tokens = maxTokens;
  if (payload.temperature !== undefined) converted.temperature = payload.temperature;
  if (payload.top_p !== undefined) converted.top_p = payload.top_p;

  const tools = chatToolsFromResponsesTools(payload.tools);
  if (tools.length > 0) converted.tools = tools;
  if (payload.tool_choice !== undefined) converted.tool_choice = payload.tool_choice;
  if (isDeepSeekOpenAICompatibleProvider(provider)) converted.thinking = { type: 'disabled' };
  return jsonBuffer(converted);
}

function anthropicMessagesBodyFromResponsesBody(body: Buffer, stream: boolean): Buffer {
  const payload = jsonObjectFromBody(body);
  if (!payload) return body;

  const systemParts: string[] = [];
  const instructions = stringValue(payload.instructions);
  if (instructions) systemParts.push(instructions);

  const converted: Record<string, unknown> = {
    model: stringValue(payload.model) ?? '',
    messages: anthropicMessagesFromResponsesPayload(payload, systemParts),
    max_tokens: payload.max_output_tokens ?? payload.max_tokens ?? 4096,
  };
  if (systemParts.length > 0) converted.system = systemParts.join('\n\n');
  if (payload.temperature !== undefined) converted.temperature = payload.temperature;
  if (payload.top_p !== undefined) converted.top_p = payload.top_p;
  if (stream) converted.stream = true;

  const tools = anthropicToolsFromResponsesTools(payload.tools);
  if (tools.length > 0) converted.tools = tools;
  return jsonBuffer(converted);
}

function chatToolsFromResponsesTools(tools: unknown): unknown[] {
  if (!Array.isArray(tools)) return [];
  const converted: unknown[] = [];

  for (const tool of tools) {
    if (!isRecord(tool)) continue;
    const fn = isRecord(tool.function) ? tool.function : {};
    const name = stringValue(fn.name) ?? stringValue(tool.name);
    if (!name) continue;
    converted.push({
      type: 'function',
      function: {
        name,
        description: stringValue(fn.description) ?? stringValue(tool.description) ?? '',
        parameters: fn.parameters ?? tool.parameters ?? tool.input_schema ?? { type: 'object', properties: {} },
      },
    });
  }
  return converted;
}

function anthropicToolsFromResponsesTools(tools: unknown): unknown[] {
  if (!Array.isArray(tools)) return [];
  const converted: unknown[] = [];

  for (const tool of tools) {
    if (!isRecord(tool)) continue;
    const fn = isRecord(tool.function) ? tool.function : {};
    const name = stringValue(fn.name) ?? stringValue(tool.name);
    if (!name) continue;
    converted.push({
      name,
      description: stringValue(fn.description) ?? stringValue(tool.description) ?? '',
      input_schema: fn.parameters ?? tool.parameters ?? tool.input_schema ?? { type: 'object', properties: {} },
    });
  }
  return converted;
}

function chatMessagesFromResponsesPayload(payload: Record<string, unknown>): unknown[] {
  const input = payload.input;
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input)) return [{ role: 'user', content: 'ping' }];

  const toolOutputByCallId = new Map<string, Record<string, unknown>>();
  for (const item of input) {
    if (!isRecord(item) || stringValue(item.type) !== 'function_call_output') continue;
    const callId = stringValue(item.call_id) ?? stringValue(item.tool_call_id) ?? stringValue(item.id);
    if (callId) toolOutputByCallId.set(callId, item);
  }

  const messages: unknown[] = [];
  for (const item of input) {
    if (!isRecord(item)) continue;
    const type = stringValue(item.type) ?? '';
    const role = chatRoleFromResponsesRole(stringValue(item.role) ?? 'user');

    if (type === 'function_call_output') continue;

    if (type === 'function_call') {
      const callId = stringValue(item.call_id) ?? stringValue(item.id) ?? `call_${crypto.randomUUID()}`;
      const name = stringValue(item.name);
      const toolOutput = toolOutputByCallId.get(callId);
      if (!name || !toolOutput) continue;
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: callId,
          type: 'function',
          function: {
            name,
            arguments: stringValue(item.arguments) ?? '',
          },
        }],
      });
      messages.push({
        role: 'tool',
        content: textFromResponsesContent(toolOutput.output ?? toolOutput.content),
        tool_call_id: callId,
      });
      continue;
    }

    let content = textFromResponsesContent(item.content ?? item.text);
    if (!content && type === 'message') content = textFromResponsesContent(item.output_text);
    if (!content) continue;
    messages.push({ role, content });
  }

  return messages.length > 0 ? messages : [{ role: 'user', content: 'ping' }];
}

function anthropicMessagesFromResponsesPayload(payload: Record<string, unknown>, systemParts: string[]): unknown[] {
  const input = payload.input;
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input)) return [{ role: 'user', content: 'ping' }];

  const messages: unknown[] = [];
  for (const item of input) {
    if (!isRecord(item)) continue;
    const type = stringValue(item.type) ?? '';
    const role = stringValue(item.role) ?? 'user';

    if (role === 'system' || role === 'developer') {
      const systemText = textFromResponsesContent(item.content ?? item.text);
      if (systemText) systemParts.push(systemText);
      continue;
    }

    if (type === 'function_call_output' || role === 'tool') {
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: stringValue(item.call_id) ?? stringValue(item.tool_call_id) ?? stringValue(item.id) ?? 'call_unknown',
          content: textFromResponsesContent(item.output ?? item.content),
        }],
      });
      continue;
    }

    if (type === 'function_call') {
      const name = stringValue(item.name);
      if (!name) continue;
      messages.push({
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: stringValue(item.call_id) ?? stringValue(item.id) ?? `call_${crypto.randomUUID()}`,
          name,
          input: jsonObjectFromString(stringValue(item.arguments) ?? '') ?? {},
        }],
      });
      continue;
    }

    const content = textFromResponsesContent(item.content ?? item.text);
    if (!content) continue;
    messages.push({ role: role === 'assistant' ? 'assistant' : 'user', content });
  }

  return messages.length > 0 ? messages : [{ role: 'user', content: 'ping' }];
}

function outputItemsFromChatCompletionsData(data: Buffer): unknown[] {
  const payload = jsonObjectFromBody(data);
  if (!payload) return [messageOutputItem(data.toString('utf8'))];

  const firstChoice = Array.isArray(payload.choices) && isRecord(payload.choices[0]) ? payload.choices[0] : null;
  const message = firstChoice && isRecord(firstChoice.message) ? firstChoice.message : {};
  const items: unknown[] = [];
  const text = textFromResponsesContent(message.content)
    || textFromResponsesContent(message.text ?? message.output_text)
    || textFromResponsesContent(payload.output_text ?? payload.text);
  if (text) items.push(messageOutputItem(text));

  if (Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      if (!isRecord(toolCall)) continue;
      const fn = isRecord(toolCall.function) ? toolCall.function : {};
      const name = stringValue(fn.name);
      if (!name) continue;
      items.push(functionCallOutputItem({
        callId: stringValue(toolCall.id),
        name,
        argumentsText: stringValue(fn.arguments),
      }));
    }
  }

  const legacyFunctionCall = isRecord(message.function_call) ? message.function_call : null;
  const legacyName = legacyFunctionCall ? stringValue(legacyFunctionCall.name) : null;
  if (legacyFunctionCall && legacyName) {
    items.push(functionCallOutputItem({
      name: legacyName,
      argumentsText: stringValue(legacyFunctionCall.arguments),
    }));
  }

  return items;
}

function outputItemsFromAnthropicMessagesData(data: Buffer): unknown[] {
  const payload = jsonObjectFromBody(data);
  if (!payload) return [messageOutputItem(data.toString('utf8'))];

  const items: unknown[] = [];
  const textParts: string[] = [];
  const content = Array.isArray(payload.content) ? payload.content : [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    const type = stringValue(part.type);
    if (type === 'text') {
      const text = stringValue(part.text);
      if (text) textParts.push(text);
      continue;
    }
    if (type === 'tool_use') {
      const name = stringValue(part.name);
      if (!name) continue;
      items.push(functionCallOutputItem({
        callId: stringValue(part.id),
        name,
        argumentsText: typeof part.input === 'string' ? part.input : JSON.stringify(part.input ?? {}),
      }));
    }
  }

  const text = textParts.join('');
  if (text) items.unshift(messageOutputItem(text));
  return items;
}

function responseObjectWithOutputItems(outputItems: unknown[], model: string): Record<string, unknown> {
  return responseObjectWithId(`resp_${crypto.randomUUID()}`, model, 'completed', outputItems);
}

function responseObjectWithId(responseId: string, model: string, status: 'in_progress' | 'completed', outputItems: unknown[]): Record<string, unknown> {
  return {
    id: responseId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output: outputItems,
  };
}

function messageOutputItem(text: string): Record<string, unknown> {
  return messageOutputItemWithId(`msg_${crypto.randomUUID()}`, text);
}

function messageOutputItemWithId(itemId: string, text: string): Record<string, unknown> {
  return {
    id: itemId,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
}

function functionCallOutputItem(input: {
  callId?: string | null;
  name: string;
  argumentsText?: string | null;
}): Record<string, unknown> {
  return {
    id: `fc_${crypto.randomUUID()}`,
    type: 'function_call',
    status: 'completed',
    call_id: input.callId?.trim() || `call_${crypto.randomUUID()}`,
    name: input.name,
    arguments: input.argumentsText?.trim() || '{}',
  };
}

function responsesSSEEvent(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

function chatRoleFromResponsesRole(role: string): 'system' | 'assistant' | 'tool' | 'user' {
  const normalized = role.trim().toLowerCase();
  if (normalized === 'developer' || normalized === 'system') return 'system';
  if (normalized === 'assistant') return 'assistant';
  if (normalized === 'tool') return 'tool';
  return 'user';
}

function textFromResponsesContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (!isRecord(part)) return '';
      return textFromResponsesContent(part.text ?? part.content ?? part.input_text ?? part.output_text);
    }).join('');
  }
  if (isRecord(content)) {
    return textFromResponsesContent(content.text ?? content.content ?? content.input_text ?? content.output_text);
  }
  return '';
}

function usageObjectFromPayload(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!payload) return null;
  if (isRecord(payload.usage)) return payload.usage;
  if (isRecord(payload.response)) return usageObjectFromPayload(payload.response);
  return null;
}

function usageFromObject(usage: Record<string, unknown>): ParsedUsage {
  const parsed: ParsedUsage = {};
  const inputTokens = numberValue(usage.input_tokens) ?? numberValue(usage.prompt_tokens);
  if (inputTokens !== undefined) parsed.inputTokens = inputTokens;

  const outputTokens = numberValue(usage.output_tokens) ?? numberValue(usage.completion_tokens);
  if (outputTokens !== undefined) parsed.outputTokens = outputTokens;

  const inputDetails = isRecord(usage.input_tokens_details)
    ? usage.input_tokens_details
    : isRecord(usage.prompt_tokens_details)
      ? usage.prompt_tokens_details
      : null;
  const cachedTokens = numberValue(inputDetails?.cached_tokens)
    ?? numberValue(usage.cache_read_input_tokens)
    ?? numberValue(usage.cached_tokens);
  if (cachedTokens !== undefined) parsed.cachedTokens = cachedTokens;
  return parsed;
}

function normalizeResponsesInputForUpstream(payload: Record<string, unknown>): void {
  if (!Array.isArray(payload.input)) return;

  payload.input = payload.input.flatMap((rawItem) => {
    if (!isRecord(rawItem)) return [rawItem];
    const item = { ...rawItem };
    const type = stringValue(item.type) ?? '';
    const role = stringValue(item.role) ?? '';
    delete item.namespace;
    delete item.encrypted_content;

    if (type === 'reasoning') return [];
    if (type === 'function_call_output') {
      if (!stringValue(item.output)) {
        const output = textFromResponsesContent(item.content);
        if (output) item.output = output;
      }
      delete item.content;
      return [item];
    }

    if (type && type !== 'message') {
      if (Array.isArray(item.content) && item.content.length > 0) item.content = [];
      return [item];
    }

    const content = item.content;
    if (!Array.isArray(content)) return [item];
    const normalizedContent = content.filter((part) => {
      if (typeof part === 'string') return part.length > 0;
      if (!isRecord(part)) return false;
      const partType = stringValue(part.type) ?? '';
      const partText = stringValue(part.text) ?? stringValue(part.input_text) ?? stringValue(part.output_text);
      const hasStructuredPayload = part.image_url !== undefined || part.file_id !== undefined || part.file_data !== undefined;
      const isKnownTextPart = partType === 'input_text' || partType === 'output_text' || partType === 'refusal' || partType.length === 0;
      const isKnownMediaPart = partType === 'input_image' || partType === 'input_file';
      return (isKnownTextPart && Boolean(partText)) || (isKnownMediaPart && hasStructuredPayload);
    });
    item.content = normalizedContent;
    if (type === 'message' && normalizedContent.length === 0 && role !== 'assistant') return [];
    return [item];
  });
}

function removeUnsupportedCodexMetadata(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(removeUnsupportedCodexMetadata);
    return;
  }
  if (!isRecord(value)) return;

  delete value.namespace;
  for (const child of Object.values(value)) {
    removeUnsupportedCodexMetadata(child);
  }
}

function versionedEndpointPath(endpoint: string, provider: Provider): string {
  return baseURLHasPathPrefix(provider.baseURL) ? endpoint : `/v1${endpoint}`;
}

function openAICompatibleEndpointPath(endpoint: string, provider: Provider): string {
  if (isDeepSeekOpenAICompatibleProvider(provider)) return endpoint;
  return baseURLHasPathPrefix(provider.baseURL) ? endpoint : `/v1${endpoint}`;
}

function isDeepSeekOpenAICompatibleProvider(provider: Provider): boolean {
  try {
    return new URL(provider.baseURL).hostname === 'api.deepseek.com';
  } catch {
    return false;
  }
}

function baseURLHasPathPrefix(baseURL: string): boolean {
  try {
    return new URL(baseURL).pathname.replaceAll('/', '').length > 0;
  } catch {
    return false;
  }
}

function jsonObjectFromBody(body: Buffer | Uint8Array | undefined): Record<string, unknown> | null {
  if (!body?.length) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body).toString('utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function jsonObjectFromString(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function jsonBuffer(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
