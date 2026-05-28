import type {
  CompletionParams,
  ContextParams,
  LlamaContext,
  NativeBackendDeviceInfo,
  NativeCompletionResult,
  NativeTokenizeResult,
  RNLlamaMessagePart,
  RNLlamaOAICompatibleMessage,
  TokenData,
} from 'llama.rn';
import type { LlmChatMessage } from '../types/chat';
import { requireLlamaModule, type LlamaModule } from './llamaRnModule';

export type LlamaChatFormatOptions = NonNullable<Parameters<LlamaContext['getFormattedChat']>[2]>;
export type LlamaContextInitParams = ContextParams;
export type NativeLogListenerHandle = { remove: () => void };
export type LlamaMultimodalSupport = { vision: boolean; audio: boolean };
export type LlamaMultimodalInitOptions = {
  context: LlamaContext;
  path: string;
  useGpu?: boolean;
  imageMinTokens?: number;
  imageMaxTokens?: number;
};

export type LlamaFormattedChatResult = {
  type: string | null;
  prompt: string;
  has_media: boolean;
  media_paths?: string[];
  additional_stops: string[];
  chat_format?: number;
  grammar?: string;
  grammar_lazy?: boolean;
  grammar_triggers?: { type: number; value: string; token: number }[];
  generation_prompt?: string;
  thinking_forced_open?: boolean;
  thinking_start_tag?: string;
  thinking_end_tag?: string;
  preserved_tokens?: string[];
  chat_parser?: string;
};

export class LlamaRuntimeFeatureUnavailableError extends Error {
  constructor(public readonly feature: string) {
    super(`[LLMEngine] llama.rn feature is unavailable: ${feature}`);
    this.name = 'LlamaRuntimeFeatureUnavailableError';
  }
}

function getLlamaModule(): LlamaModule {
  return requireLlamaModule();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readTrimmedString(value: unknown): string | undefined {
  const raw = readString(value);
  if (raw === undefined) {
    return undefined;
  }

  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readOptionalStringField(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error(`[LLMEngine] Invalid llama.rn ${label}: ${key} must be a string`);
  }

  return value;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const strings = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return strings.length > 0 ? strings : undefined;
}

function shouldNormalizeCompletionMessages(messages: unknown): messages is LlmChatMessage[] {
  return Array.isArray(messages) && messages.every((message) => (
    isRecord(message)
    && typeof message.role === 'string'
    && typeof message.content === 'string'
  ));
}

function readGrammarTriggers(value: unknown): { type: number; value: string; token: number }[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const triggers = value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const type = readFiniteNumber(entry.type);
    const triggerValue = readString(entry.value);
    const token = readFiniteNumber(entry.token);
    if (type === undefined || triggerValue === undefined || token === undefined) {
      return [];
    }

    return [{
      type: Math.round(type),
      value: triggerValue,
      token: Math.round(token),
    }];
  });

  return triggers.length > 0 ? triggers : undefined;
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`[LLMEngine] Invalid llama.rn ${label}: expected object`);
  }

  return value;
}

export function normalizeLlamaMessages(messages: LlmChatMessage[]): RNLlamaOAICompatibleMessage[] {
  if (!Array.isArray(messages)) {
    throw new Error('[LLMEngine] Invalid chat messages: expected array');
  }

  return messages.map((message, index) => {
    if (!isRecord(message)) {
      throw new Error(`[LLMEngine] Invalid chat message at index ${index}: expected object`);
    }

    const role = readString(message.role);
    const content = readString(message.content);
    if (!role || content === undefined) {
      throw new Error(`[LLMEngine] Invalid chat message at index ${index}: role and content must be strings`);
    }

    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      throw new Error(`[LLMEngine] Invalid chat message at index ${index}: unsupported role`);
    }

    const mediaPaths = role === 'user'
      ? readStringArray((message as { mediaPaths?: unknown }).mediaPaths)
      : undefined;

    if (mediaPaths && mediaPaths.length > 0) {
      const contentParts: RNLlamaMessagePart[] = [
        ...(content.trim().length > 0 ? [{ type: 'text', text: content }] : []),
        ...mediaPaths.map((url) => ({
          type: 'image_url',
          image_url: { url },
        })),
      ];

      return { role, content: contentParts };
    }

    return { role, content };
  });
}

export function normalizeFormattedChatResult(value: unknown): LlamaFormattedChatResult {
  const record = assertRecord(value, 'formatted chat result');
  const prompt = readString(record.prompt);
  if (prompt === undefined) {
    throw new Error('[LLMEngine] Invalid llama.rn formatted chat result: prompt must be a string');
  }

  const type = readTrimmedString(record.type) ?? null;
  const mediaPaths = readStringArray(record.media_paths);
  const additionalStops = readStringArray(record.additional_stops) ?? [];
  const chatFormat = readFiniteNumber(record.chat_format);
  const grammar = readString(record.grammar);
  const grammarLazy = readBoolean(record.grammar_lazy);
  const grammarTriggers = readGrammarTriggers(record.grammar_triggers);
  const generationPrompt = readString(record.generation_prompt);
  const thinkingForcedOpen = readBoolean(record.thinking_forced_open);
  const thinkingStartTag = readString(record.thinking_start_tag);
  const thinkingEndTag = readString(record.thinking_end_tag);
  const preservedTokens = readStringArray(record.preserved_tokens);
  const chatParser = readString(record.chat_parser);

  return {
    type,
    prompt,
    has_media: readBoolean(record.has_media) ?? Boolean(mediaPaths?.length),
    ...(mediaPaths ? { media_paths: mediaPaths } : null),
    additional_stops: additionalStops,
    ...(chatFormat !== undefined ? { chat_format: Math.round(chatFormat) } : null),
    ...(grammar !== undefined ? { grammar } : null),
    ...(grammarLazy !== undefined ? { grammar_lazy: grammarLazy } : null),
    ...(grammarTriggers ? { grammar_triggers: grammarTriggers } : null),
    ...(generationPrompt !== undefined ? { generation_prompt: generationPrompt } : null),
    ...(thinkingForcedOpen !== undefined ? { thinking_forced_open: thinkingForcedOpen } : null),
    ...(thinkingStartTag !== undefined ? { thinking_start_tag: thinkingStartTag } : null),
    ...(thinkingEndTag !== undefined ? { thinking_end_tag: thinkingEndTag } : null),
    ...(preservedTokens ? { preserved_tokens: preservedTokens } : null),
    ...(chatParser !== undefined ? { chat_parser: chatParser } : null),
  };
}

export function normalizeTokenData(value: unknown): TokenData {
  const record = assertRecord(value, 'token data');
  const token = readOptionalStringField(record, 'token', 'token data') ?? '';
  const content = readOptionalStringField(record, 'content', 'token data');
  const reasoningContent = readOptionalStringField(record, 'reasoning_content', 'token data');
  const accumulatedText = readOptionalStringField(record, 'accumulated_text', 'token data');
  const requestId = readFiniteNumber(record.requestId);

  return {
    token,
    ...(content !== undefined ? { content } : null),
    ...(reasoningContent !== undefined ? { reasoning_content: reasoningContent } : null),
    ...(accumulatedText !== undefined ? { accumulated_text: accumulatedText } : null),
    ...(requestId !== undefined ? { requestId: Math.round(requestId) } : null),
    ...(Array.isArray(record.completion_probabilities)
      ? { completion_probabilities: record.completion_probabilities as TokenData['completion_probabilities'] }
      : null),
  };
}

export function normalizeCompletionResult(value: unknown): NativeCompletionResult {
  const record = assertRecord(value, 'completion result');
  const text = record.text;
  if (text !== undefined && typeof text !== 'string') {
    throw new Error('[LLMEngine] Invalid llama.rn completion result: text must be a string');
  }

  const content = record.content;
  if (content !== undefined && typeof content !== 'string') {
    throw new Error('[LLMEngine] Invalid llama.rn completion result: content must be a string');
  }

  const reasoningContent = record.reasoning_content;
  if (reasoningContent !== undefined && typeof reasoningContent !== 'string') {
    throw new Error('[LLMEngine] Invalid llama.rn completion result: reasoning_content must be a string');
  }

  return record as NativeCompletionResult;
}

function normalizeBackendDeviceInfo(value: unknown): NativeBackendDeviceInfo | null {
  if (!isRecord(value)) {
    return null;
  }

  const backend = readTrimmedString(value.backend);
  const type = readTrimmedString(value.type);
  const deviceName = readTrimmedString(value.deviceName);
  const maxMemorySize = readFiniteNumber(value.maxMemorySize) ?? 0;

  if (!backend || !type || !deviceName) {
    return null;
  }

  return {
    backend,
    type,
    deviceName,
    maxMemorySize,
    ...(isRecord(value.metadata) ? { metadata: value.metadata } : null),
  };
}

export function normalizeBackendDeviceInfoList(value: unknown): NativeBackendDeviceInfo[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    const normalized = normalizeBackendDeviceInfo(entry);
    return normalized ? [normalized] : [];
  });
}

export async function getFormattedChatFromContext({
  context,
  messages,
  template = null,
  options,
}: {
  context: LlamaContext;
  messages: LlmChatMessage[];
  template?: string | null;
  options?: LlamaChatFormatOptions;
}): Promise<LlamaFormattedChatResult> {
  const formatted = await context.getFormattedChat(
    normalizeLlamaMessages(messages),
    template,
    options,
  );
  return normalizeFormattedChatResult(formatted);
}

export async function runCompletionOnContext({
  context,
  params,
  onToken,
}: {
  context: LlamaContext;
  params: CompletionParams;
  onToken?: (data: TokenData) => void;
}): Promise<NativeCompletionResult> {
  const rawMessages = (params as { messages?: unknown }).messages;
  const normalizedParams = shouldNormalizeCompletionMessages(rawMessages)
    ? {
        ...params,
        messages: normalizeLlamaMessages(rawMessages),
      }
    : params;
  const result = await context.completion(normalizedParams, onToken
    ? (data) => onToken(normalizeTokenData(data))
    : undefined);
  return normalizeCompletionResult(result);
}

function readMultimodalSupport(value: unknown): LlamaMultimodalSupport {
  const record = assertRecord(value, 'multimodal support');
  return {
    vision: readBoolean(record.vision) ?? false,
    audio: readBoolean(record.audio) ?? false,
  };
}

export async function initMultimodalOnContext({
  context,
  path,
  useGpu,
  imageMinTokens,
  imageMaxTokens,
}: LlamaMultimodalInitOptions): Promise<boolean> {
  const maybeContext = context as LlamaContext & {
    initMultimodal?: unknown;
  };
  if (typeof maybeContext.initMultimodal !== 'function') {
    throw new LlamaRuntimeFeatureUnavailableError('initMultimodal');
  }

  return maybeContext.initMultimodal({
    path,
    use_gpu: useGpu,
    image_min_tokens: imageMinTokens,
    image_max_tokens: imageMaxTokens,
  });
}

export async function getMultimodalSupportFromContext(
  context: LlamaContext,
): Promise<LlamaMultimodalSupport> {
  const maybeContext = context as LlamaContext & {
    getMultimodalSupport?: unknown;
  };
  if (typeof maybeContext.getMultimodalSupport !== 'function') {
    throw new LlamaRuntimeFeatureUnavailableError('getMultimodalSupport');
  }

  return readMultimodalSupport(await maybeContext.getMultimodalSupport());
}

export async function releaseMultimodalFromContext(context: LlamaContext): Promise<void> {
  const maybeContext = context as LlamaContext & {
    releaseMultimodal?: unknown;
  };
  if (typeof maybeContext.releaseMultimodal !== 'function') {
    throw new LlamaRuntimeFeatureUnavailableError('releaseMultimodal');
  }

  await maybeContext.releaseMultimodal();
}

export async function tokenizeFormattedPrompt({
  context,
  prompt,
  mediaPaths,
}: {
  context: LlamaContext;
  prompt: string;
  mediaPaths?: string[];
}): Promise<NativeTokenizeResult> {
  const tokenized = await context.tokenize(
    prompt,
    mediaPaths && mediaPaths.length > 0 ? { media_paths: mediaPaths } : undefined,
  );
  const record = assertRecord(tokenized, 'tokenize result');
  if (!Array.isArray(record.tokens)) {
    throw new Error('[LLMEngine] Invalid llama.rn tokenize result: tokens must be an array');
  }

  return tokenized;
}

export async function getLlamaBackendDevicesInfo(): Promise<NativeBackendDeviceInfo[]> {
  const llama = getLlamaModule() as LlamaModule & { getBackendDevicesInfo?: unknown };
  if (typeof llama.getBackendDevicesInfo !== 'function') {
    throw new LlamaRuntimeFeatureUnavailableError('getBackendDevicesInfo');
  }

  const devices = await Promise.resolve().then(() => llama.getBackendDevicesInfo!());
  return normalizeBackendDeviceInfoList(devices);
}

export function getLlamaBuildInfo(): LlamaModule['BuildInfo'] {
  return getLlamaModule().BuildInfo;
}

export async function loadLlamaModelInfo(modelPath: string): Promise<Record<string, unknown>> {
  const result = await getLlamaModule().loadLlamaModelInfo(modelPath);
  return assertRecord(result, 'model info');
}

export async function initLlamaContext(
  params: LlamaContextInitParams,
  onProgress?: (progress: number) => void,
): Promise<LlamaContext> {
  return getLlamaModule().initLlama(params, onProgress);
}

export function addNativeLlamaLogListener(
  listener: (level: string, text: string) => void,
): NativeLogListenerHandle {
  return getLlamaModule().addNativeLogListener(listener);
}

export async function toggleNativeLlamaLogs(enabled: boolean): Promise<void> {
  await getLlamaModule().toggleNativeLog(enabled);
}

export async function releaseAllLlamaContexts(): Promise<void> {
  await getLlamaModule().releaseAllLlama();
}
