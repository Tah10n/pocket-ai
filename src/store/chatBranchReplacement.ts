import {
  deriveThreadActiveModelIdFromMessages,
  deriveThreadTitle,
  getThreadActiveModelId,
  normalizeConversationTitle,
  type ChatMessage,
  type ChatThread,
  type ChatThreadStatus,
  type GenerationParamsSnapshot,
} from '../types/chat';

export const MAX_CHAT_BRANCH_REPLACEMENT_CONTENT_LENGTH = 200_000;
export const MAX_CHAT_BRANCH_REPLACEMENT_CONTENT_PARTS = 8;
export const MAX_CHAT_BRANCH_REPLACEMENT_CONTENT_PART_TOTAL_CHARS = 200_000;
export const MAX_CHAT_BRANCH_REPLACEMENT_ATTACHMENTS = 24;
export const MAX_CHAT_BRANCH_REPLACEMENT_ATTACHMENT_METADATA_BYTES = 64 * 1024;
export const MAX_CHAT_BRANCH_BASE_SEMANTIC_IDENTITY_LENGTH = 64;

type ChatBranchSemanticHashState = {
  hashes: [number, number, number, number];
  codeUnits: number;
};

function appendChatBranchSemanticHashSegment(
  state: ChatBranchSemanticHashState,
  kind: string,
  value: string,
): void {
  const framedValue = `${kind.length}:${kind}:${value.length}:${value};`;
  state.codeUnits += framedValue.length;

  for (let index = 0; index < framedValue.length; index += 1) {
    const codeUnit = framedValue.charCodeAt(index);
    for (let hashIndex = 0; hashIndex < state.hashes.length; hashIndex += 1) {
      state.hashes[hashIndex] ^= codeUnit;
      state.hashes[hashIndex] = Math.imul(state.hashes[hashIndex], 0x01000193) >>> 0;
    }
  }
}

function appendStableChatBranchSemanticValue(
  state: ChatBranchSemanticHashState,
  value: unknown,
): void {
  if (value === null) {
    appendChatBranchSemanticHashSegment(state, 'null', '');
    return;
  }

  if (typeof value === 'string') {
    appendChatBranchSemanticHashSegment(state, 'string', value);
    return;
  }

  if (typeof value === 'number') {
    appendChatBranchSemanticHashSegment(
      state,
      'number',
      String(value === 0 ? 0 : value),
    );
    return;
  }

  if (typeof value === 'boolean') {
    appendChatBranchSemanticHashSegment(state, 'boolean', value ? '1' : '0');
    return;
  }

  if (value === undefined) {
    appendChatBranchSemanticHashSegment(state, 'undefined', '');
    return;
  }

  if (Array.isArray(value)) {
    appendChatBranchSemanticHashSegment(state, 'array', String(value.length));
    value.forEach((entry) => {
      appendStableChatBranchSemanticValue(state, entry === undefined ? null : entry);
    });
    return;
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    appendChatBranchSemanticHashSegment(state, 'object', String(keys.length));
    keys.forEach((key) => {
      appendChatBranchSemanticHashSegment(state, 'key', key);
      appendStableChatBranchSemanticValue(state, record[key]);
    });
    return;
  }

  appendChatBranchSemanticHashSegment(state, typeof value, '');
}

/**
 * Builds a fixed-size identity for every durable field except rename metadata.
 * Raw prompt, attachment, and summary values are consumed only by the in-memory
 * hash and are never retained in the progress envelope.
 */
export function createChatBranchBaseSemanticIdentity(thread: ChatThread): string {
  const state: ChatBranchSemanticHashState = {
    hashes: [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35],
    codeUnits: 0,
  };
  appendStableChatBranchSemanticValue(state, {
    id: thread.id,
    modelId: thread.modelId,
    activeModelId: thread.activeModelId,
    presetId: thread.presetId,
    presetSnapshot: thread.presetSnapshot,
    paramsSnapshot: thread.paramsSnapshot,
    messages: thread.messages,
    createdAt: thread.createdAt,
    lastGeneratedAt: thread.lastGeneratedAt,
    summary: thread.summary,
    status: thread.status,
  });

  return [
    'v1',
    state.codeUnits,
    ...state.hashes.map((hash) => hash.toString(16).padStart(8, '0')),
  ].join(':');
}

export function isChatBranchBaseSemanticIdentity(value: unknown): value is string {
  if (
    typeof value !== 'string'
    || value.length > MAX_CHAT_BRANCH_BASE_SEMANTIC_IDENTITY_LENGTH
  ) {
    return false;
  }

  const match = /^v1:(\d+):([0-9a-f]{8}:){3}[0-9a-f]{8}$/.exec(value);
  if (!match) {
    return false;
  }

  const codeUnits = Number(match[1]);
  return Number.isSafeInteger(codeUnits) && codeUnits >= 0;
}

function getUtf8ByteLength(value: string, stopAfter = Number.POSITIVE_INFINITY): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 0x80) {
      bytes += 1;
    } else if (codeUnit < 0x800) {
      bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
    if (bytes > stopAfter) {
      return bytes;
    }
  }
  return bytes;
}

function serializeWithinUtf8Limit(value: unknown, maximumBytes: number): string | null {
  let minimumBytes = 0;
  try {
    const serialized = JSON.stringify(value, (key, entry: unknown) => {
      if (key.length > 0) {
        minimumBytes += getUtf8ByteLength(key, maximumBytes - minimumBytes);
      }
      if (typeof entry === 'string') {
        minimumBytes += getUtf8ByteLength(entry, maximumBytes - minimumBytes);
      }
      if (minimumBytes > maximumBytes) {
        throw new RangeError('JSON value exceeds its persistence byte limit');
      }
      return entry;
    });
    return typeof serialized === 'string'
      && getUtf8ByteLength(serialized, maximumBytes) <= maximumBytes
      ? serialized
      : null;
  } catch {
    return null;
  }
}

export function isChatBranchReplacementUserMessageWithinProgressBounds(
  message: Pick<ChatMessage, 'attachments' | 'contentParts'>,
): boolean {
  if (message.attachments != null && !Array.isArray(message.attachments)) {
    return false;
  }
  const attachments = message.attachments ?? [];
  if (attachments.length > MAX_CHAT_BRANCH_REPLACEMENT_ATTACHMENTS) {
    return false;
  }

  const serializedAttachments = serializeWithinUtf8Limit(
    attachments,
    MAX_CHAT_BRANCH_REPLACEMENT_ATTACHMENT_METADATA_BYTES,
  );
  if (!serializedAttachments) {
    return false;
  }

  if (message.contentParts != null && !Array.isArray(message.contentParts)) {
    return false;
  }
  const contentParts = message.contentParts ?? [];
  if (contentParts.length > MAX_CHAT_BRANCH_REPLACEMENT_CONTENT_PARTS) {
    return false;
  }

  let totalTextChars = 0;
  for (const part of contentParts) {
    if (
      !part
      || typeof part !== 'object'
      || Array.isArray(part)
      || part.type !== 'text'
      || typeof part.text !== 'string'
    ) {
      return false;
    }
    totalTextChars += part.text.length;
    if (totalTextChars > MAX_CHAT_BRANCH_REPLACEMENT_CONTENT_PART_TOTAL_CHARS) {
      return false;
    }
  }

  return true;
}

export interface ChatBranchBaseIdentity {
  durablePersistedAt: number;
  commitRevision?: number;
  baseSemanticIdentity?: string;
  targetUserMessageId: string;
  targetUserCreatedAt: number;
}

export interface ChatBranchReplacementPlan {
  targetUserMessageId: string;
  activeModelId: string;
  replacementUserMessage: ChatMessage;
  insertedModelSwitchMessage?: ChatMessage;
  paramsSnapshot: GenerationParamsSnapshot;
  clearSummary: true;
}

export interface ChatBranchReplacementProgress {
  targetUserMessageId: string;
  targetUserCreatedAt: number;
  baseDurablePersistedAt: number;
  baseCommitRevision?: number;
  baseSemanticIdentity?: string;
  replacementUserMessage: ChatMessage;
  insertedModelSwitchMessage?: ChatMessage;
  paramsSnapshot: GenerationParamsSnapshot;
}

function createReplacementUserMessage(
  target: ChatMessage,
  content: string,
  activeModelId: string,
): ChatMessage {
  return {
    id: target.id,
    role: 'user',
    kind: 'message',
    content,
    createdAt: target.createdAt,
    state: 'complete',
    modelId: activeModelId,
    attachments: target.attachments,
    contentParts: target.contentParts,
  };
}

function isCanonicalReplacementUserMessage(
  message: ChatMessage,
  target: ChatMessage,
  activeModelId: string,
): boolean {
  return (
    message.id === target.id
    && message.role === 'user'
    && message.kind === 'message'
    && message.state === 'complete'
    && message.createdAt === target.createdAt
    && message.modelId === activeModelId
  );
}

function isCanonicalInsertedModelSwitch(
  message: ChatMessage | undefined,
  fromModelId: string,
  toModelId: string,
  createdAt: number,
): boolean {
  return Boolean(
    message
    && message.id.trim().length > 0
    && message.role === 'system'
    && message.kind === 'model_switch'
    && message.content === ''
    && message.state === 'complete'
    && message.createdAt === createdAt
    && message.modelId === toModelId
    && message.switchFromModelId === fromModelId
    && message.switchToModelId === toModelId,
  );
}

export function buildChatBranchReplacementPlan({
  thread,
  targetUserMessageId,
  nextUserContent,
  paramsSnapshot = thread.paramsSnapshot,
  createMessageId,
}: {
  thread: ChatThread;
  targetUserMessageId: string;
  nextUserContent: string;
  paramsSnapshot?: GenerationParamsSnapshot;
  createMessageId: () => string;
}): ChatBranchReplacementPlan | null {
  const targetIndex = thread.messages.findIndex((message) => message.id === targetUserMessageId);
  const target = targetIndex >= 0 ? thread.messages[targetIndex] : undefined;
  if (!target || target.role !== 'user' || target.kind === 'model_switch') {
    return null;
  }

  const content = nextUserContent.trim();
  if (
    content.length > MAX_CHAT_BRANCH_REPLACEMENT_CONTENT_LENGTH
    || (!content && (target.attachments?.length ?? 0) === 0)
  ) {
    return null;
  }

  const activeModelId = getThreadActiveModelId(thread);
  const replacementUserMessage = createReplacementUserMessage(target, content, activeModelId);
  if (!isChatBranchReplacementUserMessageWithinProgressBounds(replacementUserMessage)) {
    return null;
  }

  const baseMessages = thread.messages.slice(0, targetIndex);
  const branchActiveModelId = deriveThreadActiveModelIdFromMessages({
    modelId: thread.modelId,
    messages: baseMessages,
  });
  const insertedModelSwitchMessage = baseMessages.length > 0 && branchActiveModelId !== activeModelId
    ? {
        id: createMessageId(),
        role: 'system' as const,
        kind: 'model_switch' as const,
        content: '',
        modelId: activeModelId,
        switchFromModelId: branchActiveModelId,
        switchToModelId: activeModelId,
        createdAt: target.createdAt,
        state: 'complete' as const,
      }
    : undefined;

  return {
    targetUserMessageId,
    activeModelId,
    replacementUserMessage,
    insertedModelSwitchMessage,
    paramsSnapshot: { ...paramsSnapshot },
    clearSummary: true,
  };
}

export function validateChatBranchReplacementPlan(
  thread: ChatThread,
  plan: ChatBranchReplacementPlan,
): { targetIndex: number; target: ChatMessage } | null {
  const targetIndex = thread.messages.findIndex(
    (message) => message.id === plan.targetUserMessageId,
  );
  const target = targetIndex >= 0 ? thread.messages[targetIndex] : undefined;
  if (
    !target
    || target.role !== 'user'
    || target.kind === 'model_switch'
    || !isCanonicalReplacementUserMessage(
      plan.replacementUserMessage,
      target,
      plan.activeModelId,
    )
    || getThreadActiveModelId(thread) !== plan.activeModelId
  ) {
    return null;
  }

  const prefix = thread.messages.slice(0, targetIndex);
  const branchActiveModelId = deriveThreadActiveModelIdFromMessages({
    modelId: thread.modelId,
    messages: prefix,
  });
  const needsModelSwitch = prefix.length > 0 && branchActiveModelId !== plan.activeModelId;
  if (
    needsModelSwitch
      ? !isCanonicalInsertedModelSwitch(
          plan.insertedModelSwitchMessage,
          branchActiveModelId,
          plan.activeModelId,
          target.createdAt,
        )
      : plan.insertedModelSwitchMessage !== undefined
  ) {
    return null;
  }

  return { targetIndex, target };
}

export function materializeChatBranchReplacementMessages(
  thread: ChatThread,
  plan: ChatBranchReplacementPlan,
  assistantMessage: ChatMessage,
): ChatMessage[] | null {
  const validated = validateChatBranchReplacementPlan(thread, plan);
  if (!validated) {
    return null;
  }

  return [
    ...thread.messages.slice(0, validated.targetIndex),
    ...(plan.insertedModelSwitchMessage ? [plan.insertedModelSwitchMessage] : []),
    plan.replacementUserMessage,
    assistantMessage,
  ];
}

export function materializeChatBranchReplacementThread({
  thread,
  plan,
  assistantMessage,
  status,
  updatedAt,
  lastGeneratedAt,
}: {
  thread: ChatThread;
  plan: ChatBranchReplacementPlan;
  assistantMessage: ChatMessage;
  status: ChatThreadStatus;
  updatedAt: number;
  lastGeneratedAt?: number;
}): ChatThread | null {
  const messages = materializeChatBranchReplacementMessages(thread, plan, assistantMessage);
  if (!messages) {
    return null;
  }

  const derivedTitle = deriveThreadTitle(messages);
  const title = thread.titleSource === 'manual'
    ? normalizeConversationTitle(thread.title) || derivedTitle
    : derivedTitle;

  return {
    ...thread,
    title,
    activeModelId: plan.activeModelId,
    paramsSnapshot: { ...plan.paramsSnapshot },
    messages,
    summary: undefined,
    status,
    updatedAt,
    ...(lastGeneratedAt == null ? null : { lastGeneratedAt }),
  };
}

export function createChatBranchReplacementProgress(
  baseIdentity: ChatBranchBaseIdentity,
  plan: ChatBranchReplacementPlan,
): ChatBranchReplacementProgress {
  return {
    targetUserMessageId: baseIdentity.targetUserMessageId,
    targetUserCreatedAt: baseIdentity.targetUserCreatedAt,
    baseDurablePersistedAt: baseIdentity.durablePersistedAt,
    baseCommitRevision: baseIdentity.commitRevision,
    baseSemanticIdentity: baseIdentity.baseSemanticIdentity,
    replacementUserMessage: plan.replacementUserMessage,
    insertedModelSwitchMessage: plan.insertedModelSwitchMessage,
    paramsSnapshot: { ...plan.paramsSnapshot },
  };
}

export function createChatBranchReplacementPlanFromProgress(
  progress: ChatBranchReplacementProgress,
  activeModelId: string,
): ChatBranchReplacementPlan {
  return {
    targetUserMessageId: progress.targetUserMessageId,
    activeModelId,
    replacementUserMessage: progress.replacementUserMessage,
    insertedModelSwitchMessage: progress.insertedModelSwitchMessage,
    paramsSnapshot: { ...progress.paramsSnapshot },
    clearSummary: true,
  };
}
