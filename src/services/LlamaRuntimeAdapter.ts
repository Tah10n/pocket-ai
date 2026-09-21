import type {
  CompletionParams,
  ContextParams,
  LlamaContext,
  NativeBackendDeviceInfo,
  NativeCompletionResult,
  NativeCompletionTokenProb,
  JinjaFormattedChatResult,
  ToolCall,
  NativeTokenizeResult,
  RNLlamaMessagePart,
  RNLlamaOAICompatibleMessage,
  TokenData,
} from 'llama.rn';
import type { LlmChatMessage } from '../types/chat';
import { hasEquivalentLlmTextContentPart } from '../utils/llmMessageText';
import { requireLlamaModule, type LlamaModule } from './llamaRnModule';
import { applyPromptStateCacheSafetyGate } from './PromptStateCachePolicy';

export type LlamaChatFormatOptions = NonNullable<Parameters<LlamaContext['getFormattedChat']>[2]>;
export type LlamaContextInitParams = ContextParams;
export type NativeLogListenerHandle = { remove: () => void };
export type LlamaMultimodalSupport = { vision: boolean; audio: boolean };
// JSICompletion.h emits null for an unnamed tool-call ID, despite the declaration.
export type LlamaToolCall = Omit<ToolCall, 'id'> & { id?: string | null };
export type LlamaTokenData = Omit<TokenData, 'tool_calls'> & { tool_calls?: LlamaToolCall[] };
export type LlamaCompletionResult = Partial<Omit<
  NativeCompletionResult,
  'content' | 'reasoning_content' | 'text' | 'tool_calls' | 'stopped_word' | 'stopped_limit' | 'timings'
>> & {
  content?: string | null;
  reasoning_content?: string | null;
  text?: string;
  accumulated_text?: string;
  tool_calls?: LlamaToolCall[];
  // The selected native bridge emits booleans; retain declared values too.
  stopped_word?: NativeCompletionResult['stopped_word'] | boolean;
  stopped_limit?: NativeCompletionResult['stopped_limit'] | boolean;
  requestId?: number;
  timings?: Partial<NativeCompletionResult['timings']>;
};
export type LlamaMultimodalInitOptions = {
  context: LlamaContext;
  path: string;
  useGpu?: boolean;
  imageMinTokens?: number;
  imageMaxTokens?: number;
};

export type LlamaFormattedChatResult = Omit<JinjaFormattedChatResult, 'type' | 'additional_stops'> & {
  type: string | null;
  prompt: string;
  has_media: boolean;
  additional_stops: string[];
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
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertFeature(value: unknown, feature: string): void {
  if (typeof value !== 'function') throw new LlamaRuntimeFeatureUnavailableError(feature);
}

function readContractArray<T>(value: unknown, guard: (entry: unknown) => entry is T, label: string): T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every(guard)) {
    throw new Error(`[LLMEngine] Invalid llama.rn ${label}: unexpected array value`);
  }
  // Preserve empty arrays and retain large native outputs without copying them.
  return value;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isToolCall(value: unknown): value is LlamaToolCall {
  return isRecord(value) && value.type === 'function'
    && (value.id === undefined || value.id === null || isString(value.id))
    && isRecord(value.function) && isString(value.function.name)
    && isString(value.function.arguments);
}

function isTokenProbability(value: unknown): value is NativeCompletionTokenProb {
  return isRecord(value) && isString(value.content) && Array.isArray(value.probs)
    && value.probs.every((prob: unknown) => isRecord(prob)
      && isString(prob.tok_str) && isFiniteNumber(prob.prob));
}

function readRequestId(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!isFiniteNumber(value) || !Number.isSafeInteger(value)) {
    throw new Error('[LLMEngine] Invalid llama.rn requestId: expected a safe integer');
  }
  return value;
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
  return Array.isArray(messages) && messages.every((message) => {
    if (
      !isRecord(message)
      || typeof message.role !== 'string'
      || typeof message.content !== 'string'
    ) {
      return false;
    }

    return message.contentParts === undefined || Array.isArray(message.contentParts);
  });
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

  return triggers;
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`[LLMEngine] Invalid llama.rn ${label}: expected object`);
  }

  return value;
}

function normalizeLlmContentParts(value: unknown, messageIndex: number): RNLlamaMessagePart[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`[LLMEngine] Invalid chat message at index ${messageIndex}: contentParts must be an array`);
  }

  return value.map((entry, partIndex) => {
    if (!isRecord(entry)) {
      throw new Error(`[LLMEngine] Invalid chat message at index ${messageIndex}: contentParts[${partIndex}] must be an object`);
    }

    const type = readTrimmedString(entry.type);
    if (type === 'text') {
      const text = readString(entry.text);
      if (text === undefined) {
        throw new Error(`[LLMEngine] Invalid chat message at index ${messageIndex}: contentParts[${partIndex}].text must be a string`);
      }

      return { type, text };
    }

    if (type === 'image_url') {
      const imageUrl = assertRecord(entry.image_url, `chat message ${messageIndex} contentParts[${partIndex}].image_url`);
      const url = readTrimmedString(imageUrl.url);
      if (!url) {
        throw new Error(`[LLMEngine] Invalid chat message at index ${messageIndex}: contentParts[${partIndex}].image_url.url must be a non-empty string`);
      }

      return { type, image_url: { url } };
    }

    if (type === 'input_audio') {
      const inputAudio = assertRecord(entry.input_audio, `chat message ${messageIndex} contentParts[${partIndex}].input_audio`);
      const format = readTrimmedString(inputAudio.format);
      if (format !== 'wav' && format !== 'mp3') {
        throw new Error(`[LLMEngine] Invalid chat message at index ${messageIndex}: contentParts[${partIndex}].input_audio.format must be wav or mp3`);
      }

      const url = readTrimmedString(inputAudio.url);
      const data = readTrimmedString(inputAudio.data);
      if ((url ? 1 : 0) + (data ? 1 : 0) !== 1) {
        throw new Error(`[LLMEngine] Invalid chat message at index ${messageIndex}: contentParts[${partIndex}].input_audio must include exactly one of url or data`);
      }

      return {
        type,
        input_audio: {
          format,
          ...(url ? { url } : null),
          ...(data ? { data } : null),
        },
      };
    }

    throw new Error(`[LLMEngine] Invalid chat message at index ${messageIndex}: unsupported contentParts[${partIndex}] type`);
  });
}

function hasNonTextContentParts(parts: readonly RNLlamaMessagePart[]): boolean {
  return parts.some((part) => part.type !== 'text');
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

    const contentParts = normalizeLlmContentParts((message as { contentParts?: unknown }).contentParts, index);
    if (role !== 'user' && hasNonTextContentParts(contentParts)) {
      throw new Error(`[LLMEngine] Invalid chat message at index ${index}: media contentParts are only supported for user messages`);
    }

    const mediaPaths = role === 'user'
      ? readStringArray((message as { mediaPaths?: unknown }).mediaPaths)
      : undefined;

    if (contentParts.length > 0 || (mediaPaths && mediaPaths.length > 0)) {
      const shouldUseContentFallback = content.trim().length > 0
        && !hasEquivalentLlmTextContentPart(contentParts, content);
      const nativeContentParts: RNLlamaMessagePart[] = [
        ...(shouldUseContentFallback ? [{ type: 'text', text: content }] : []),
        ...contentParts,
        ...(mediaPaths ?? []).map((url) => ({
          type: 'image_url',
          image_url: { url },
        })),
      ];

      return { role, content: nativeContentParts };
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
  const mediaPaths = readContractArray(record.media_paths, isString, 'media_paths');
  const additionalStops = readContractArray(record.additional_stops, isString, 'additional_stops') ?? [];
  const chatFormat = readFiniteNumber(record.chat_format);
  const grammar = readString(record.grammar);
  const grammarLazy = readBoolean(record.grammar_lazy);
  const grammarTriggers = readGrammarTriggers(record.grammar_triggers);
  const generationPrompt = readString(record.generation_prompt);
  const thinkingForcedOpen = readBoolean(record.thinking_forced_open);
  const thinkingStartTag = readString(record.thinking_start_tag);
  const thinkingEndTag = readString(record.thinking_end_tag);
  const preservedTokens = readContractArray(record.preserved_tokens, isString, 'preserved_tokens');
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

export function normalizeTokenData(value: unknown): LlamaTokenData {
  const record = assertRecord(value, 'token data');
  const token = readOptionalStringField(record, 'token', 'token data') ?? '';
  const content = readOptionalStringField(record, 'content', 'token data');
  const reasoningContent = readOptionalStringField(record, 'reasoning_content', 'token data');
  const accumulatedText = readOptionalStringField(record, 'accumulated_text', 'token data');
  const requestId = readRequestId(record.requestId);
  const toolCalls = readContractArray(record.tool_calls, isToolCall, 'token tool_calls');
  const probabilities = readContractArray(record.completion_probabilities, isTokenProbability, 'token probabilities');

  return {
    token,
    ...(content !== undefined ? { content } : null),
    ...(reasoningContent !== undefined ? { reasoning_content: reasoningContent } : null),
    ...(accumulatedText !== undefined ? { accumulated_text: accumulatedText } : null),
    ...(requestId !== undefined ? { requestId } : null),
    ...(toolCalls !== undefined ? { tool_calls: toolCalls } : null),
    ...(probabilities !== undefined ? { completion_probabilities: probabilities } : null),
  };
}

export function normalizeCompletionResult(value: unknown): LlamaCompletionResult {
  const record = assertRecord(value, 'completion result');
  const text = record.text;
  if (text !== undefined && typeof text !== 'string') {
    throw new Error('[LLMEngine] Invalid llama.rn completion result: text must be a string');
  }

  const content = record.content;
  if (content !== undefined && content !== null && typeof content !== 'string') {
    throw new Error('[LLMEngine] Invalid llama.rn completion result: content must be a string or null');
  }

  const reasoningContent = record.reasoning_content;
  if (
    reasoningContent !== undefined
    && reasoningContent !== null
    && typeof reasoningContent !== 'string'
  ) {
    throw new Error(
      '[LLMEngine] Invalid llama.rn completion result: reasoning_content must be a string or null',
    );
  }

  const accumulatedText = record.accumulated_text;
  if (accumulatedText !== undefined && typeof accumulatedText !== 'string') {
    throw new Error(
      '[LLMEngine] Invalid llama.rn completion result: accumulated_text must be a string',
    );
  }

  const hasExplicitContent = content !== undefined;
  const hasExplicitReasoningContent = reasoningContent !== undefined;
  const hasParsedOutputEvidence = (typeof content === 'string' && content.length > 0)
    || (typeof reasoningContent === 'string' && reasoningContent.length > 0)
    || (typeof accumulatedText === 'string' && accumulatedText.length > 0)
    || (Array.isArray(record.tool_calls) && record.tool_calls.length > 0);

  // llama.rn 0.13.0-rc.3 exports raw `text`, but its JSI bridge omits parsed
  // content/reasoning fields when their native strings are empty. Once another
  // parsed field proves parsing succeeded, restore that omission as an explicit
  // clear. With only raw text, absence stays undefined so callers can parse/fallback.
  const normalized: LlamaCompletionResult = { ...record };
  if (text === undefined) {
    delete normalized.text;
  }
  if (hasExplicitContent) {
    normalized.content = content;
  } else if (hasParsedOutputEvidence) {
    normalized.content = null;
  } else {
    delete normalized.content;
  }
  if (hasExplicitReasoningContent) {
    normalized.reasoning_content = reasoningContent;
  } else if (hasParsedOutputEvidence) {
    normalized.reasoning_content = null;
  } else {
    delete normalized.reasoning_content;
  }

  // Validate known optional fields without manufacturing omitted values. Keep
  // extension telemetry in the shallow copy; large arrays are checked only once
  // on the final result, never copied into text-token events or chat history.
  for (const key of ['chat_format', 'tokens_predicted', 'tokens_evaluated', 'draft_tokens',
    'draft_tokens_accepted', 'tokens_cached', 'embedding_dim'] as const) {
    if (record[key] !== undefined) {
      const number = readFiniteNumber(record[key]);
      if (number === undefined) throw new Error(`[LLMEngine] Invalid llama.rn completion result: ${key} must be finite`);
      normalized[key] = number;
    }
  }
  for (const key of ['truncated', 'stopped_eos', 'context_full', 'interrupted'] as const) {
    if (record[key] !== undefined) {
      const flag = readBoolean(record[key]);
      if (flag === undefined) throw new Error(`[LLMEngine] Invalid llama.rn completion result: ${key} must be boolean`);
      normalized[key] = flag;
    }
  }
  if (record.stopped_word !== undefined && typeof record.stopped_word !== 'boolean' && typeof record.stopped_word !== 'string') {
    throw new Error('[LLMEngine] Invalid llama.rn completion result: stopped_word');
  }
  if (record.stopped_limit !== undefined && typeof record.stopped_limit !== 'boolean' && !isFiniteNumber(record.stopped_limit)) {
    throw new Error('[LLMEngine] Invalid llama.rn completion result: stopped_limit');
  }
  if (record.stopping_word !== undefined) normalized.stopping_word = readOptionalStringField(record, 'stopping_word', 'completion result');
  if (record.accumulated_text !== undefined) normalized.accumulated_text = accumulatedText;
  if (record.requestId !== undefined) normalized.requestId = readRequestId(record.requestId);
  if (record.tool_calls !== undefined) normalized.tool_calls = readContractArray(record.tool_calls, isToolCall, 'completion tool_calls');
  if (record.completion_probabilities !== undefined) normalized.completion_probabilities = readContractArray(record.completion_probabilities, isTokenProbability, 'completion probabilities');
  if (record.audio_tokens !== undefined) normalized.audio_tokens = readContractArray(record.audio_tokens, isFiniteNumber, 'audio_tokens');
  if (record.embeddings !== undefined) normalized.embeddings = readContractArray(record.embeddings, isFiniteNumber, 'embeddings');
  if (record.timings !== undefined) {
    const timings = assertRecord(record.timings, 'timings');
    // Some interrupted/legacy results contain only a subset of timing counters.
    // Validate present counters while retaining their original names and values.
    for (const value of Object.values(timings)) {
      if (!isFiniteNumber(value)) throw new Error('[LLMEngine] Invalid llama.rn timings: counters must be finite');
    }
  }
  return normalized;
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
  assertFeature(context.getFormattedChat, 'getFormattedChat');
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
  context: Pick<LlamaContext, 'completion' | 'stopCompletion'>;
  params: CompletionParams;
  onToken?: (data: LlamaTokenData) => void;
}): Promise<LlamaCompletionResult> {
  assertFeature(context.completion, 'completion');
  const rawMessages = (params as { messages?: unknown }).messages;
  const normalizedParams = shouldNormalizeCompletionMessages(rawMessages)
    ? {
        ...params,
        messages: normalizeLlamaMessages(rawMessages),
      }
    : params;
  let acceptTokens = true;
  let callbackFailed = false;
  let callbackError: unknown;
  let stopPromise: Promise<void> | undefined;
  try {
    const result = await context.completion(normalizedParams, onToken
      ? (data) => {
          if (!acceptTokens || callbackFailed) return;
          try {
            onToken(normalizeTokenData(data));
          } catch (error) {
            // Never throw across JSI. Stop this captured context, suppress later
            // callbacks and drain native completion before surfacing the error.
            callbackFailed = true;
            callbackError = error;
            if (typeof context.stopCompletion === 'function') {
              stopPromise = Promise.resolve().then(() => context.stopCompletion()).catch(() => undefined);
            }
          }
        }
      : undefined);
    if (callbackFailed) throw callbackError;
    return normalizeCompletionResult(result);
  } catch (error) {
    throw callbackFailed ? callbackError : error;
  } finally {
    acceptTokens = false;
    await stopPromise;
  }
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

  const initOptions: {
    path: string;
    use_gpu?: boolean;
    image_min_tokens?: number;
    image_max_tokens?: number;
  } = {
    path,
    use_gpu: useGpu,
  };
  if (typeof imageMinTokens === 'number' && Number.isFinite(imageMinTokens)) {
    initOptions.image_min_tokens = imageMinTokens;
  }
  if (typeof imageMaxTokens === 'number' && Number.isFinite(imageMaxTokens)) {
    initOptions.image_max_tokens = imageMaxTokens;
  }

  return maybeContext.initMultimodal(initOptions);
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
  assertFeature(context.tokenize, 'tokenize');
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
  const llama = getLlamaModule();
  assertFeature(llama.loadLlamaModelInfo, 'loadLlamaModelInfo');
  const result = await llama.loadLlamaModelInfo(modelPath);
  return assertRecord(result, 'model info');
}

export async function initLlamaContext(
  params: LlamaContextInitParams,
  onProgress?: (progress: number) => void,
): Promise<LlamaContext> {
  const llama = getLlamaModule();
  assertFeature(llama.initLlama, 'initLlama');
  return llama.initLlama(
    { ...applyPromptStateCacheSafetyGate(params), n_parallel: 1 },
    onProgress,
  );
}

export function addNativeLlamaLogListener(
  listener: (level: string, text: string) => void,
): NativeLogListenerHandle {
  const llama = getLlamaModule();
  assertFeature(llama.addNativeLogListener, 'addNativeLogListener');
  return llama.addNativeLogListener(listener);
}

export async function toggleNativeLlamaLogs(enabled: boolean): Promise<void> {
  const llama = getLlamaModule();
  assertFeature(llama.toggleNativeLog, 'toggleNativeLog');
  await llama.toggleNativeLog(enabled);
}

export async function releaseAllLlamaContexts(): Promise<void> {
  const llama = getLlamaModule();
  assertFeature(llama.releaseAllLlama, 'releaseAllLlama');
  await llama.releaseAllLlama();
}

export async function releaseLlamaContext(context: LlamaContext): Promise<void> {
  const release = (context as LlamaContext & { release?: unknown }).release;
  if (typeof release === 'function') {
    await release.call(context);
    return;
  }

  // Defensive compatibility for a context created by an older native runtime.
  // Callers must await this global fallback before initializing another context.
  await releaseAllLlamaContexts();
}
