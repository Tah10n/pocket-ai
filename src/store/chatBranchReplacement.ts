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

export interface ChatBranchBaseIdentity {
  durablePersistedAt: number;
  commitRevision?: number;
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
  if (!content && (target.attachments?.length ?? 0) === 0) {
    return null;
  }

  const activeModelId = getThreadActiveModelId(thread);
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
    replacementUserMessage: createReplacementUserMessage(target, content, activeModelId),
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
