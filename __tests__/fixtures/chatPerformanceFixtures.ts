import type { ChatAttachment } from '../../src/types/attachments';
import type { ChatMessage, ChatThread } from '../../src/types/chat';

export type PerformanceHistorySize = 20 | 200 | 1000;
export type PerformanceAttachmentHistory = 'none' | 'image' | 'audio' | 'document' | 'mixed';
export type PerformanceOutputKind = 'short' | '8k-token-equivalent' | 'reasoning';
export type PerformanceStreamMode = 'delta' | 'snapshot' | 'mixed';

export type PerformanceStreamCallback =
  | { type: 'delta'; value: string }
  | {
      type: 'snapshot';
      value: {
        token: string;
        content?: string;
        reasoningContent?: string;
        accumulatedText?: string;
      };
    };

export type PerformanceOutputFixture = {
  finalText: string;
  callbacks: readonly PerformanceStreamCallback[];
  tokenEquivalentUnits: number | null;
};

export const PERFORMANCE_FIXTURE_BASE_TIME = 1_780_000_000_000;
export const PERFORMANCE_FIXTURE_THREAD_ID = 'thread-performance-fixture';
export const PERFORMANCE_FIXTURE_MODEL_ID = 'model-performance-a';
export const PERFORMANCE_FIXTURE_SECONDARY_MODEL_ID = 'model-performance-b';

const SHORT_ASSISTANT_OUTPUT = 'A short deterministic assistant response.';
const TOKEN_EQUIVALENT_UNIT = 'token ';
const TOKEN_EQUIVALENT_UNIT_COUNT = 8_192;
const REASONING_OUTPUT = '<think>Plan with Unicode: café, 東京, 🧪.</think>\nFinal answer.';

function buildReadyAttachment(
  kind: Exclude<PerformanceAttachmentHistory, 'none' | 'mixed'>,
  sequence: number,
  messageId: string,
): ChatAttachment {
  const base = {
    id: `attachment-${kind}-${sequence}`,
    kind,
    state: 'ready' as const,
    threadId: PERFORMANCE_FIXTURE_THREAD_ID,
    messageId,
    localUri: `test-chat-attachments/${kind}-${sequence}`,
    pathCategory: 'chat_attachment' as const,
    fileName: `${kind}-${sequence}`,
    sizeBytes: 1024 + sequence,
    source: 'document_picker' as const,
    createdAt: PERFORMANCE_FIXTURE_BASE_TIME + sequence,
  };

  if (kind === 'image') {
    return {
      ...base,
      kind,
      fileName: `${base.fileName}.jpg`,
      localUri: `${base.localUri}.jpg`,
      mimeType: 'image/jpeg',
      source: 'photo_library',
      image: { width: 1024, height: 768 },
    };
  }

  if (kind === 'audio') {
    return {
      ...base,
      kind,
      fileName: `${base.fileName}.wav`,
      localUri: `${base.localUri}.wav`,
      mimeType: 'audio/wav',
      audio: { format: 'wav', durationMs: 2_000 + sequence },
    };
  }

  return {
    ...base,
    kind,
    fileName: `${base.fileName}.txt`,
    localUri: `${base.localUri}.txt`,
    mimeType: 'text/plain',
    document: {
      processorId: 'fixture-text',
      processorVersion: 1,
      contentHash: `fixture-document-${sequence}`,
      extractedCharCount: 128 + sequence,
    },
  };
}

function getAttachmentKind(
  history: PerformanceAttachmentHistory,
  userMessageSequence: number,
): Exclude<PerformanceAttachmentHistory, 'none' | 'mixed'> | null {
  if (history === 'none') {
    return null;
  }

  if (history !== 'mixed') {
    return history;
  }

  return (['image', 'audio', 'document'] as const)[userMessageSequence % 3];
}

export function buildPerformanceThread(options: {
  historicalMessageCount: PerformanceHistorySize;
  attachments?: PerformanceAttachmentHistory;
  modelSwitchEvery?: number;
}): ChatThread {
  const attachments = options.attachments ?? 'none';
  const messages: ChatMessage[] = [];
  let activeModelId = PERFORMANCE_FIXTURE_MODEL_ID;

  for (let index = 0; index < options.historicalMessageCount; index += 1) {
    if (
      options.modelSwitchEvery
      && index > 0
      && index % options.modelSwitchEvery === 0
    ) {
      const nextModelId = activeModelId === PERFORMANCE_FIXTURE_MODEL_ID
        ? PERFORMANCE_FIXTURE_SECONDARY_MODEL_ID
        : PERFORMANCE_FIXTURE_MODEL_ID;
      messages.push({
        id: `message-switch-${index}`,
        role: 'system',
        content: '',
        createdAt: PERFORMANCE_FIXTURE_BASE_TIME + (index * 10) - 1,
        state: 'complete',
        kind: 'model_switch',
        modelId: nextModelId,
        switchFromModelId: activeModelId,
        switchToModelId: nextModelId,
      });
      activeModelId = nextModelId;
    }

    const role = index % 2 === 0 ? 'user' : 'assistant';
    const messageId = `message-history-${index}`;
    const attachmentKind = role === 'user'
      ? getAttachmentKind(attachments, Math.floor(index / 2))
      : null;

    messages.push({
      id: messageId,
      role,
      content: role === 'user'
        ? `Deterministic user message ${index}`
        : `Deterministic assistant message ${index}`,
      createdAt: PERFORMANCE_FIXTURE_BASE_TIME + (index * 10),
      state: 'complete',
      kind: 'message',
      modelId: activeModelId,
      attachments: attachmentKind
        ? [buildReadyAttachment(attachmentKind, index, messageId)]
        : undefined,
    });
  }

  return {
    id: PERFORMANCE_FIXTURE_THREAD_ID,
    title: 'Performance fixture conversation',
    titleSource: 'manual',
    modelId: PERFORMANCE_FIXTURE_MODEL_ID,
    activeModelId,
    presetId: null,
    presetSnapshot: {
      id: null,
      name: 'Performance fixture',
      systemPrompt: 'Deterministic performance fixture system prompt.',
    },
    paramsSnapshot: {
      temperature: 0.7,
      topP: 0.9,
      topK: 40,
      minP: 0.05,
      repetitionPenalty: 1.1,
      maxTokens: 512,
      reasoningEffort: 'medium',
      seed: 42,
    },
    messages,
    createdAt: PERFORMANCE_FIXTURE_BASE_TIME,
    updatedAt: PERFORMANCE_FIXTURE_BASE_TIME + options.historicalMessageCount * 10,
    status: 'idle',
  };
}

function splitIntoDeterministicChunks(text: string, callbackCount: number): string[] {
  const characters = Array.from(text);
  const normalizedCount = Math.max(1, Math.min(Math.trunc(callbackCount), Math.max(1, characters.length)));
  const chunks: string[] = [];
  let cursor = 0;

  for (let remainingChunks = normalizedCount; remainingChunks > 0; remainingChunks -= 1) {
    const remainingCharacters = characters.length - cursor;
    const nextLength = Math.ceil(remainingCharacters / remainingChunks);
    chunks.push(characters.slice(cursor, cursor + nextLength).join(''));
    cursor += nextLength;
  }

  return chunks;
}

export function buildPerformanceOutput(options: {
  kind: PerformanceOutputKind;
  callbackCount?: number;
  mode?: PerformanceStreamMode;
}): PerformanceOutputFixture {
  const finalText = options.kind === 'short'
      ? SHORT_ASSISTANT_OUTPUT
      : options.kind === 'reasoning'
        ? REASONING_OUTPUT
      : TOKEN_EQUIVALENT_UNIT.repeat(TOKEN_EQUIVALENT_UNIT_COUNT).trimEnd();
  const chunks = splitIntoDeterministicChunks(finalText, options.callbackCount ?? 100);
  const mode = options.mode ?? 'delta';
  const callbacks: PerformanceStreamCallback[] = [];
  let accumulatedText = '';

  chunks.forEach((chunk, index) => {
    accumulatedText += chunk;
    const shouldSnapshot = mode === 'snapshot' || (mode === 'mixed' && index % 3 === 2);

    if (!shouldSnapshot) {
      callbacks.push({ type: 'delta', value: chunk });
      return;
    }

    callbacks.push({
      type: 'snapshot',
      value: {
        token: chunk,
        content: accumulatedText,
        accumulatedText,
      },
    });
  });

  return {
    finalText,
    callbacks,
    // This is a deterministic workload unit count, not a claim about any
    // model-specific native tokenizer's exact output.
    tokenEquivalentUnits: options.kind === '8k-token-equivalent'
      ? TOKEN_EQUIVALENT_UNIT_COUNT
      : null,
  };
}
