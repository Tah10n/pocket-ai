import { getVisibleMessageContent } from '../utils/chatPresentation';
import { normalizeReasoningEffort, type ReasoningEffort } from './reasoning';

export type ChatMessageRole = 'system' | 'user' | 'assistant';
export type ChatMessageState = 'complete' | 'streaming' | 'stopped' | 'error';
export type ChatMessageKind = 'message' | 'model_switch';
export type ChatThreadStatus = 'idle' | 'generating' | 'stopped' | 'error';

export interface GenerationParamsSnapshot {
  temperature: number;
  topP: number;
  topK?: number;
  minP?: number;
  repetitionPenalty?: number;
  maxTokens: number;
  reasoningEffort?: ReasoningEffort;
  seed: number | null;
}

export interface PresetSnapshot {
  id: string | null;
  name: string;
  systemPrompt: string;
}

export interface ChatSummary {
  content: string;
  createdAt: number;
  sourceMessageIds: string[];
  isPlaceholder?: boolean;
}

export interface ChatMessage {
  id: string;
  role: ChatMessageRole;
  content: string;
  thoughtContent?: string;
  createdAt: number;
  state: ChatMessageState;
  tokensPerSec?: number;
  errorCode?: string;
  errorMessage?: string;
  regeneratesMessageId?: string;
  kind?: ChatMessageKind;
  modelId?: string | null;
  switchFromModelId?: string | null;
  switchToModelId?: string | null;
}

export interface ChatThread {
  id: string;
  title: string;
  titleSource?: 'derived' | 'manual';
  modelId: string;
  activeModelId?: string;
  presetId: string | null;
  presetSnapshot: PresetSnapshot;
  paramsSnapshot: GenerationParamsSnapshot;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  lastGeneratedAt?: number;
  summary?: ChatSummary;
  status: ChatThreadStatus;
}

export interface ConversationIndexItem {
  id: string;
  title: string;
  updatedAt: number;
  modelId: string;
  presetId: string | null;
  messageCount: number;
  lastMessagePreview?: string;
}

export interface LlmChatMessage {
  role: ChatMessageRole;
  content: string;
}

export interface LlmChatCompletionOptions {
  messages: LlmChatMessage[];
  onToken?: (token: string | {
    token: string;
    content?: string;
    reasoningContent?: string;
    accumulatedText?: string;
  }) => void;
  params?: {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    min_p?: number;
    penalty_repeat?: number;
    n_predict?: number;
    seed?: number;
    enable_thinking?: boolean;
    thinking_budget_tokens?: number;
    reasoning_format?: 'none' | 'auto' | 'deepseek';
  };
}

export const DEFAULT_SYSTEM_PROMPT = 'You are a helpful AI assistant. Answer concisely and accurately.';
export const DEFAULT_PRESET_SNAPSHOT: PresetSnapshot = {
  id: null,
  name: 'Default',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
};

export function createChatId(prefix: 'thread' | 'message' = 'message') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function deriveThreadTitle(messages: Pick<ChatMessage, 'role' | 'content'>[]) {
  const firstUserMessage = messages.find(
    (message) => message.role === 'user' && message.content.trim().length > 0,
  );

  if (!firstUserMessage) {
    return 'New Conversation';
  }

  const normalized = firstUserMessage.content.replace(/\s+/g, ' ').trim();
  return normalized.length > 48 ? `${normalized.slice(0, 45)}...` : normalized;
}

export function normalizeConversationTitle(title: string) {
  return title.replace(/\s+/g, ' ').trim();
}

export function getThreadActiveModelId(
  thread: Pick<ChatThread, 'modelId' | 'activeModelId'>,
): string {
  return thread.activeModelId ?? thread.modelId;
}

export function isModelSwitchMessage(message: Pick<ChatMessage, 'kind'>): boolean {
  return message.kind === 'model_switch';
}

export function toConversationIndexItem(thread: ChatThread): ConversationIndexItem {
  let lastMessage: ChatMessage | undefined;

  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index];
    if (isModelSwitchMessage(message)) {
      continue;
    }
    if (getVisibleMessageContent(message.role, message.content).trim().length > 0) {
      lastMessage = message;
      break;
    }
  }

  const lastMessagePreview = lastMessage
    ? getVisibleMessageContent(lastMessage.role, lastMessage.content)
    : undefined;

  return {
    id: thread.id,
    title: thread.title,
    updatedAt: thread.updatedAt,
    modelId: getThreadActiveModelId(thread),
    presetId: thread.presetId,
    messageCount: thread.messages.reduce(
      (count, message) => (isModelSwitchMessage(message) ? count : count + 1),
      0,
    ),
    lastMessagePreview: lastMessagePreview?.slice(0, 80),
  };
}

export function buildConversationIndex(
  threads: Record<string, ChatThread>,
  options: { limit?: number } = {},
): ConversationIndexItem[] {
  const limit = options.limit;
  const normalizedLimit = typeof limit === 'number' && Number.isFinite(limit)
    ? Math.max(0, Math.round(limit))
    : null;

  if (normalizedLimit === 0) {
    return [];
  }

  if (normalizedLimit === 1) {
    let mostRecent: ChatThread | null = null;
    for (const thread of Object.values(threads)) {
      if (!mostRecent || thread.updatedAt > mostRecent.updatedAt) {
        mostRecent = thread;
      }
    }

    return mostRecent ? [toConversationIndexItem(mostRecent)] : [];
  }

  const items = Object.values(threads)
    .map(toConversationIndexItem)
    .sort((left, right) => right.updatedAt - left.updatedAt);

  if (typeof normalizedLimit === 'number') {
    return items.slice(0, normalizedLimit);
  }

  return items;
}

export function sanitizeHydratedThread(thread: ChatThread): ChatThread {
  const sanitizedMessages = thread.messages.filter(
    (message) => message.state !== 'streaming',
  );

  const hasModelSwitchMessages = sanitizedMessages.some(
    (message) => (message.kind ?? 'message') === 'model_switch',
  );
  let currentModelId = hasModelSwitchMessages
    ? thread.modelId
    : getThreadActiveModelId(thread);
  const migratedMessages = sanitizedMessages.map((message): ChatMessage => {
    const kind = message.kind ?? 'message';

    if (kind === 'model_switch') {
      const resolvedSwitchFromModelId = message.switchFromModelId ?? currentModelId;
      const resolvedSwitchToModelId = message.switchToModelId ?? message.modelId ?? currentModelId;
      currentModelId = resolvedSwitchToModelId;

      return {
        ...message,
        kind,
        modelId: resolvedSwitchToModelId,
        switchFromModelId: resolvedSwitchFromModelId,
        switchToModelId: resolvedSwitchToModelId,
      };
    }

    return {
      ...message,
      kind,
      modelId: message.modelId ?? currentModelId,
    };
  });

  const activeModelId = thread.activeModelId ?? currentModelId;

  const removedStreamingMessages = sanitizedMessages.length !== thread.messages.length;
  const legacyReasoningEnabled = (thread.paramsSnapshot as { reasoningEnabled?: unknown }).reasoningEnabled;

  return {
    ...thread,
    activeModelId,
    presetSnapshot: thread.presetSnapshot ?? {
      ...DEFAULT_PRESET_SNAPSHOT,
      id: thread.presetId ?? null,
    },
    paramsSnapshot: {
      temperature: thread.paramsSnapshot.temperature,
      topP: thread.paramsSnapshot.topP,
      topK: thread.paramsSnapshot.topK ?? 40,
      minP: thread.paramsSnapshot.minP ?? 0.05,
      repetitionPenalty: thread.paramsSnapshot.repetitionPenalty ?? 1,
      maxTokens: thread.paramsSnapshot.maxTokens,
      reasoningEffort: normalizeReasoningEffort(thread.paramsSnapshot.reasoningEffort, legacyReasoningEnabled),
      seed: thread.paramsSnapshot.seed ?? null,
    },
    titleSource: thread.titleSource === 'manual' ? 'manual' : 'derived',
    messages: migratedMessages,
    status: removedStreamingMessages && thread.status === 'generating' ? 'stopped' : thread.status,
    updatedAt: removedStreamingMessages ? Date.now() : thread.updatedAt,
  };
}
