import {
  DOCUMENT_ATTACHMENT_MESSAGE_PLACEHOLDER,
  type ChatMessage,
  type ChatThread,
  type LlmChatMessage,
  type LlmTextContentPart,
  type LlmInputAudioContentPart,
} from '../types/chat';
import { AppError } from '../services/AppError';
import { getVisibleMessageContent } from './chatPresentation';
import {
  getChatImageAttachmentMediaPaths,
  normalizeChatAttachmentLocalUri,
  toAttachmentMediaPath,
} from './chatImageAttachments';
import { getNativeLlmMessageTextCharacterCount } from './llmMessageText';

export interface ThreadInferenceWindow {
  messages: LlmChatMessage[];
  truncatedMessageIds: string[];
}

export interface ThreadInferenceWindowOptions {
  maxContextMessages: number;
  maxContextTokens?: number;
  responseReserveTokens?: number;
  promptSafetyMarginTokens?: number;
}

const CHARS_PER_ESTIMATED_TOKEN = 4;
const MESSAGE_TOKEN_OVERHEAD = 6;
const IMAGE_ATTACHMENT_ESTIMATED_TOKENS = 576;
export const MAX_EXACT_HISTORY_BACKFILL_MESSAGES = 16;
export const DEFAULT_INFERENCE_PROMPT_SAFETY_MARGIN_TOKENS = 64;
const RESPONSE_RESERVE_BALANCING_MIN_TOKENS = 256;
const MAX_RESPONSE_RESERVE_SHARE_OF_PROMPT_BUDGET = 0.5;

export function estimateLlmMessageTokens(message: LlmChatMessage) {
  const mediaPathCount = getLlmMessageMediaPaths(message).length + getLlmMessageAudioInputCount(message);
  return Math.max(1, Math.ceil((getNativeLlmMessageTextCharacterCount(message) + (message.tool_calls ? JSON.stringify(message.tool_calls).length : 0) + (message.tool_call_id?.length ?? 0)) / CHARS_PER_ESTIMATED_TOKEN))
    + MESSAGE_TOKEN_OVERHEAD
    + (mediaPathCount * IMAGE_ATTACHMENT_ESTIMATED_TOKENS);
}

export function estimateLlmMessagesTokens(messages: LlmChatMessage[]) {
  return messages.reduce((total, message) => total + estimateLlmMessageTokens(message), 0);
}

export function resolveBalancedResponseReserveTokens(
  requestedResponseTokens: number,
  totalPromptBudget: number,
) {
  const normalizedRequestedResponseTokens = Math.max(0, Math.round(requestedResponseTokens));

  if (normalizedRequestedResponseTokens <= RESPONSE_RESERVE_BALANCING_MIN_TOKENS) {
    return Math.min(normalizedRequestedResponseTokens, totalPromptBudget);
  }

  const balancedReserveCap = Math.max(
    RESPONSE_RESERVE_BALANCING_MIN_TOKENS,
    Math.floor(totalPromptBudget * MAX_RESPONSE_RESERVE_SHARE_OF_PROMPT_BUDGET),
  );

  return Math.min(normalizedRequestedResponseTokens, totalPromptBudget, balancedReserveCap);
}

function getMinimumRequiredHistoryTokens(historyMessages: LlmChatMessage[]) {
  if (historyMessages.length === 0) {
    return 0;
  }

  const lastMessage = historyMessages[historyMessages.length - 1];
  let total = estimateLlmMessageTokens(lastMessage);

  if (lastMessage.role === 'assistant') {
    const previousMessage = historyMessages[historyMessages.length - 2];
    if (previousMessage?.role === 'user') {
      total += estimateLlmMessageTokens(previousMessage);
    }
  }

  return total;
}

function resolveInferenceWindowOptions(
  optionsOrMaxContextMessages: number | ThreadInferenceWindowOptions,
): ThreadInferenceWindowOptions {
  if (typeof optionsOrMaxContextMessages === 'number') {
    return {
      maxContextMessages: optionsOrMaxContextMessages,
    };
  }

  return optionsOrMaxContextMessages;
}

function normalizeMediaPaths(paths: readonly string[] | undefined): string[] {
  if (!paths || paths.length === 0) {
    return [];
  }

  return Array.from(new Set(paths
    .map((path) => path.trim())
    .filter((path) => path.length > 0)));
}

function getLlmMessageMediaPaths(message: LlmChatMessage): string[] {
  return normalizeMediaPaths([
    ...(message.mediaPaths ?? []),
    ...(message.contentParts
      ?.filter((part) => part.type === 'image_url')
      .map((part) => part.image_url.url) ?? []),
    ...getChatImageAttachmentMediaPaths(message.attachments),
  ]);
}

function getLlmMessageAudioInputCount(message: LlmChatMessage): number {
  return message.contentParts?.filter((part) => {
    if (part.type !== 'input_audio') {
      return false;
    }

    const url = part.input_audio.url?.trim() ?? '';
    const data = part.input_audio.data?.trim() ?? '';
    return url.length > 0 || data.length > 0;
  }).length ?? 0;
}

function getAudioContentPartsFromAttachments(
  attachments: ChatMessage['attachments'],
): LlmInputAudioContentPart[] {
  if (!attachments?.length) {
    return [];
  }

  return attachments.flatMap((attachment) => {
    if (!('kind' in attachment) || attachment.kind !== 'audio' || attachment.state !== 'ready') {
      return [];
    }

    const localUri = normalizeChatAttachmentLocalUri(attachment.localUri);
    const mediaPath = localUri ? toAttachmentMediaPath(localUri) : null;
    if (!mediaPath) {
      return [];
    }

    return [{
      type: 'input_audio',
      input_audio: {
        format: attachment.audio.format,
        url: mediaPath,
      },
    } satisfies LlmInputAudioContentPart];
  });
}

function hasAudioAttachmentInput(attachments: ChatMessage['attachments']): boolean {
  return getAudioContentPartsFromAttachments(attachments).length > 0;
}

function hasFileBackedInferenceInput(message: ChatMessage): boolean {
  return (message.attachments?.length ?? 0) > 0
    || message.contentParts?.some((part) => part.type !== 'text') === true;
}

function toLlmChatMessage(message: ChatMessage): LlmChatMessage {
  const content = getVisibleMessageContent(message.role, message.content, message.structuredOutput?.mode);
  const mediaPaths = getChatImageAttachmentMediaPaths(message.attachments);
  const attachmentAudioContentParts = getAudioContentPartsFromAttachments(message.attachments);
  const storedContentParts = [
    ...(message.contentParts ?? []),
    ...attachmentAudioContentParts,
  ];
  const contentParts = storedContentParts.length
    ? [
        ...(content.trim().length > 0 && content !== DOCUMENT_ATTACHMENT_MESSAGE_PLACEHOLDER
          ? [{ type: 'text', text: content } satisfies LlmTextContentPart]
          : []),
        ...storedContentParts,
      ]
    : undefined;

  return {
    role: message.role,
    content: content === DOCUMENT_ATTACHMENT_MESSAGE_PLACEHOLDER && contentParts?.length ? '' : content,
    ...(message.attachments && message.attachments.length > 0 ? { attachments: message.attachments } : null),
    ...(mediaPaths.length > 0 ? { mediaPaths } : null),
    ...(contentParts && contentParts.length > 0 ? { contentParts } : null),
  };
}


/** Expand protocol only for inference. Durable/UI history keeps one assistant message. */
export function expandChatMessageForInference(message: ChatMessage): LlmChatMessage[] {
  if (message.role !== 'assistant' || !message.toolRun) return [toLlmChatMessage(message)];
  const messages: LlmChatMessage[] = [];
  for (const round of message.toolRun.rounds) {
    // Unanswered proposals are retained in history/UI but are never replayed as
    // executable work or as an orphan protocol message in a later prompt.
    if (!round.calls.length || round.calls.some(call => call.result === undefined
      || (call.status !== 'completed' && call.status !== 'error'))) continue;
    messages.push({ role: 'assistant', content: round.content, tool_calls: round.calls.map(call => ({
      id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments },
    })) });
    for (const call of round.calls) messages.push({ role: 'tool', tool_call_id: call.id, content: call.result! });
  }
  if (message.content.trim()) messages.push(toLlmChatMessage(message));
  return messages;
}

type ProtocolWindowGroup = { ids: string[]; messages: LlmChatMessage[] };
function protocolWindowGroups(thread: ChatThread, latestUserMessage?: ChatMessage): ProtocolWindowGroup[] {
  const eligible = getEligibleThreadMessages(thread);
  if (latestUserMessage && !thread.messages.some(message => message.id === latestUserMessage.id)) eligible.push(latestUserMessage);
  const groups: ProtocolWindowGroup[] = [];
  for (const message of eligible) {
    const expanded = expandChatMessageForInference(message);
    if (!expanded.length) continue;
    if (message.role === 'user' || groups.length === 0) groups.push({ ids: [], messages: [] });
    groups[groups.length - 1].ids.push(message.id);
    groups[groups.length - 1].messages.push(...expanded);
  }
  return groups;
}
function protocolSystemMessages(thread: ChatThread): LlmChatMessage[] {
  const content = [thread.presetSnapshot.systemPrompt.trim(),
    thread.summary && !thread.summary.isPlaceholder ? `Conversation summary:\n${thread.summary.content}` : '',
  ].filter(Boolean).join('\n\n');
  return content ? [{ role: 'system', content }] : [];
}
function selectProtocolGroups(thread: ChatThread, options: ThreadInferenceWindowOptions, latestUserMessage?: ChatMessage) {
  const system = protocolSystemMessages(thread);
  const groups = protocolWindowGroups(thread, latestUserMessage);
  let start = 0;
  // A required newest turn remains indivisible even when it exceeds the message cap.
  while (start < groups.length - 1 && system.length + groups.slice(start).reduce((n, g) => n + g.ids.length, 0) > options.maxContextMessages) start++;
  return { system, groups, start };
}
function getProtocolInferenceWindow(thread: ChatThread, options: ThreadInferenceWindowOptions, latestUserMessage?: ChatMessage): ThreadInferenceWindow {
  const selected = selectProtocolGroups(thread, options, latestUserMessage);
  const { system, groups } = selected;
  let { start } = selected;
  if (options.maxContextTokens && groups.length) {
    const total = Math.max(0, options.maxContextTokens - (options.promptSafetyMarginTokens ?? DEFAULT_INFERENCE_PROMPT_SAFETY_MARGIN_TOKENS));
    const required = estimateLlmMessagesTokens([...system, ...groups[groups.length - 1].messages]);
    const reserve = Math.min(resolveBalancedResponseReserveTokens(options.responseReserveTokens ?? thread.paramsSnapshot.maxTokens, total), Math.max(0, total - required));
    while (start < groups.length - 1 && estimateLlmMessagesTokens([...system, ...groups.slice(start).flatMap(g => g.messages)]) > total - reserve) start++;
  }
  return { messages: [...system, ...groups.slice(start).flatMap(g => g.messages)], truncatedMessageIds: groups.slice(0, start).flatMap(g => g.ids) };
}
async function getAccurateProtocolInferenceWindow(thread: ChatThread, options: ThreadInferenceWindowOptions,
  count: (messages: LlmChatMessage[]) => Promise<number>, control: { throwIfCancelled?: () => void }) {
  const { system, groups, start: boundedStart } = selectProtocolGroups(thread, options);
  const margin = Math.max(0, Math.round(options.promptSafetyMarginTokens ?? DEFAULT_INFERENCE_PROMPT_SAFETY_MARGIN_TOKENS));
  const total = options.maxContextTokens && options.maxContextTokens > 0 ? Math.max(0, options.maxContextTokens - margin) : Infinity;
  const measure = async (messages: LlmChatMessage[]) => { control.throwIfCancelled?.(); const result = await count(messages); control.throwIfCancelled?.(); return result; };
  const requiredMessages = [...system, ...(groups.at(-1)?.messages ?? [])];
  const requiredTokens = await measure(requiredMessages);
  if (requiredTokens > total) throw new AppError('message_too_long', 'The current tool-call/result group cannot fit in the context window.');
  const reserve = Number.isFinite(total) ? Math.min(resolveBalancedResponseReserveTokens(options.responseReserveTokens ?? thread.paramsSnapshot.maxTokens, total), total - requiredTokens) : 0;
  let start = boundedStart;
  // Avoid reopening arbitrarily old file-backed history during exact backfill.
  const heuristic = getProtocolInferenceWindow(thread, options);
  let heuristicStart = 0;
  let skipped = 0;
  while (heuristicStart < groups.length && skipped < heuristic.truncatedMessageIds.length) skipped += groups[heuristicStart++].ids.length;
  start = Math.max(start, heuristicStart);
  let messages = [...system, ...groups.slice(start).flatMap(g => g.messages)];
  let promptTokens = await measure(messages);
  while (start < groups.length - 1 && promptTokens > total - reserve) {
    start++;
    messages = [...system, ...groups.slice(start).flatMap(g => g.messages)];
    promptTokens = await measure(messages);
  }
  return { messages, promptTokens, promptSafetyMarginTokens: margin, truncatedMessageIds: groups.slice(0, start).flatMap(g => g.ids) };
}

export function getThreadInferenceWindow(
  thread: ChatThread,
  optionsOrMaxContextMessages: number | ThreadInferenceWindowOptions,
  latestUserMessage?: ChatMessage,
): ThreadInferenceWindow {
  const options = resolveInferenceWindowOptions(optionsOrMaxContextMessages);
  if (thread.messages.some(message => message.toolRun)) return getProtocolInferenceWindow(thread, options, latestUserMessage);
  const systemMessages: LlmChatMessage[] = [];

  const systemContentParts: string[] = [];
  const systemPrompt = thread.presetSnapshot.systemPrompt.trim();
  if (systemPrompt.length > 0) {
    systemContentParts.push(systemPrompt);
  }

  if (thread.summary && !thread.summary.isPlaceholder) {
    systemContentParts.push(`Conversation summary:\n${thread.summary.content}`);
  }

  const systemContent = systemContentParts.join('\n\n').trim();
  if (systemContent.length > 0) {
    systemMessages.push({
      role: 'system',
      content: systemContent,
    });
  }

  const eligibleMessages = thread.messages.filter(
    (message) =>
      (message.state !== 'error' || Boolean(message.toolRun))
      && (message.kind ?? 'message') !== 'model_switch'
      && (
        getVisibleMessageContent(message.role, message.content, message.structuredOutput?.mode).trim().length > 0
        || (message.contentParts?.length ?? 0) > 0
        || getChatImageAttachmentMediaPaths(message.attachments).length > 0
        || hasAudioAttachmentInput(message.attachments)
        || Boolean(message.toolRun)
      ),
  );
  const historyMessages = eligibleMessages.map<LlmChatMessage>(toLlmChatMessage);

  if (
    latestUserMessage &&
    !thread.messages.some((message) => message.id === latestUserMessage.id)
  ) {
    historyMessages.push(toLlmChatMessage(latestUserMessage));
  }

  const reservedSlots = Math.min(systemMessages.length, options.maxContextMessages);
  const maxHistoryMessages = Math.max(options.maxContextMessages - reservedSlots, 0);
  let effectiveHistoryStartIndex =
    historyMessages.length <= maxHistoryMessages
      ? 0
      : historyMessages.length - maxHistoryMessages;
  let normalizedHistoryMessages = historyMessages.slice(effectiveHistoryStartIndex);
  let promptTokenBudget: number | null = null;

  if (typeof options.maxContextTokens === 'number' && options.maxContextTokens > 0) {
    const targetReservedResponseTokens = Math.max(
      0,
      Math.round(options.responseReserveTokens ?? thread.paramsSnapshot.maxTokens),
    );
    const systemTokenCount = estimateLlmMessagesTokens(systemMessages);
    const promptSafetyMargin = Math.max(
      0,
      Math.round(options.promptSafetyMarginTokens ?? DEFAULT_INFERENCE_PROMPT_SAFETY_MARGIN_TOKENS),
    );
    const totalPromptBudget = Math.max(
      0,
      Math.round(options.maxContextTokens) - promptSafetyMargin - systemTokenCount,
    );
    const minimumRequiredHistoryTokens = getMinimumRequiredHistoryTokens(normalizedHistoryMessages);
    const canFitMinimumRequiredHistory =
      minimumRequiredHistoryTokens === 0 || minimumRequiredHistoryTokens <= totalPromptBudget;
    const balancedReservedResponseTokens = resolveBalancedResponseReserveTokens(
      targetReservedResponseTokens,
      totalPromptBudget,
    );
    const effectiveReservedResponseTokens = canFitMinimumRequiredHistory
      ? Math.min(
          balancedReservedResponseTokens,
          Math.max(totalPromptBudget - minimumRequiredHistoryTokens, 0),
        )
      : 0;

    promptTokenBudget = Math.max(
      0,
      totalPromptBudget - effectiveReservedResponseTokens,
    );

    let consumedPromptTokens = 0;
    let nextHistoryCount = 0;

    for (let index = normalizedHistoryMessages.length - 1; index >= 0; index -= 1) {
      const messageTokens = estimateLlmMessageTokens(normalizedHistoryMessages[index]);
      const canFitMore = consumedPromptTokens + messageTokens <= promptTokenBudget;

      if (!canFitMore) {
        break;
      }

      consumedPromptTokens += messageTokens;
      nextHistoryCount += 1;
    }

    if (
      nextHistoryCount === 0 &&
      normalizedHistoryMessages.length > 0 &&
      !canFitMinimumRequiredHistory
    ) {
      nextHistoryCount = 1;
    }

    effectiveHistoryStartIndex = historyMessages.length - nextHistoryCount;
    normalizedHistoryMessages = historyMessages.slice(effectiveHistoryStartIndex);
  }

  const shouldBackfillLeadingUserMessage =
    promptTokenBudget != null &&
    effectiveHistoryStartIndex > 0 &&
    normalizedHistoryMessages.length > 0 &&
    normalizedHistoryMessages[0]?.role === 'assistant' &&
    historyMessages[effectiveHistoryStartIndex - 1]?.role === 'user';

  if (shouldBackfillLeadingUserMessage && promptTokenBudget != null) {
    const resolvedPromptTokenBudget = promptTokenBudget;
    const leadingUserMessage = historyMessages[effectiveHistoryStartIndex - 1];
    const leadingUserTokens = estimateLlmMessageTokens(leadingUserMessage);
    const canBackfillLeadingUserMessage =
      estimateLlmMessagesTokens(normalizedHistoryMessages) + leadingUserTokens
        <= resolvedPromptTokenBudget;

    if (canBackfillLeadingUserMessage) {
      effectiveHistoryStartIndex -= 1;
      normalizedHistoryMessages = historyMessages.slice(effectiveHistoryStartIndex);
    } else if (
      normalizedHistoryMessages.length === 1 &&
      leadingUserTokens <= resolvedPromptTokenBudget
    ) {
      effectiveHistoryStartIndex -= 1;
      normalizedHistoryMessages = [leadingUserMessage];
    }
  }

  while (
    effectiveHistoryStartIndex > 0 &&
    normalizedHistoryMessages.length > 1 &&
    normalizedHistoryMessages[0]?.role === 'assistant'
  ) {
    effectiveHistoryStartIndex += 1;
    normalizedHistoryMessages = historyMessages.slice(effectiveHistoryStartIndex);
  }

  const truncatedMessageIds = eligibleMessages
    .slice(0, effectiveHistoryStartIndex)
    .map((message) => message.id);

  return {
    messages: [...systemMessages, ...normalizedHistoryMessages],
    truncatedMessageIds,
  };
}

export function buildThreadMessagesForInference(
  thread: ChatThread,
  latestUserMessage?: ChatMessage,
  optionsOrMaxContextMessages: number | ThreadInferenceWindowOptions = Number.MAX_SAFE_INTEGER,
) {
  return getThreadInferenceWindow(thread, optionsOrMaxContextMessages, latestUserMessage).messages;
}

export type InferenceBudgetOptions = {
  maxContextMessages?: number;
  maxContextTokens?: number;
  responseReserveTokens?: number;
  promptSafetyMarginTokens?: number;
};

const DEFAULT_RESPONSE_RESERVE_TOKENS = 256;

export function resolveThreadInferenceWindowOptions(
  thread: ChatThread,
  options?: InferenceBudgetOptions,
): ThreadInferenceWindowOptions {
  return {
    maxContextMessages: options?.maxContextMessages ?? Number.MAX_SAFE_INTEGER,
    maxContextTokens: options?.maxContextTokens,
    responseReserveTokens: options?.responseReserveTokens
      ?? Math.min(thread.paramsSnapshot.maxTokens, DEFAULT_RESPONSE_RESERVE_TOKENS),
    promptSafetyMarginTokens: options?.promptSafetyMarginTokens,
  };
}

export const SUMMARY_AFFORDANCE_MIN_TRUNCATED_MESSAGES = 1;

export function getEligibleThreadMessages(thread: ChatThread): ChatMessage[] {
  return thread.messages.filter(
    (message) =>
      (message.state !== 'error' || Boolean(message.toolRun))
      && (message.kind ?? 'message') !== 'model_switch'
      && (
        getVisibleMessageContent(message.role, message.content, message.structuredOutput?.mode).trim().length > 0
        || (message.contentParts?.length ?? 0) > 0
        || getChatImageAttachmentMediaPaths(message.attachments).length > 0
        || hasAudioAttachmentInput(message.attachments)
        || Boolean(message.toolRun)
      ),
  );
}

export function createTruncationState(truncatedMessageIds: string[]) {
  return {
    truncatedMessageIds,
    shouldOfferSummary:
      truncatedMessageIds.length >= SUMMARY_AFFORDANCE_MIN_TRUNCATED_MESSAGES,
  };
}

export async function buildInferenceWindowWithAccurateTokenCounts(
  thread: ChatThread,
  options: ThreadInferenceWindowOptions,
  countPromptTokens: (messages: LlmChatMessage[]) => Promise<number>,
  control: { throwIfCancelled?: () => void } = {},
): Promise<{
  messages: LlmChatMessage[];
  promptTokens: number;
  promptSafetyMarginTokens: number;
  truncatedMessageIds: string[];
}> {
  if (thread.messages.some(message => message.toolRun)) return getAccurateProtocolInferenceWindow(thread, options, countPromptTokens, control);
  const countPromptTokensWithCancellation = async (messages: LlmChatMessage[]) => {
    control.throwIfCancelled?.();
    const tokens = await countPromptTokens(messages);
    control.throwIfCancelled?.();
    return tokens;
  };

  const maxContextTokens =
    typeof options.maxContextTokens === 'number' && options.maxContextTokens > 0
      ? Math.round(options.maxContextTokens)
      : null;
  const promptSafetyMarginTokens = Math.max(
    0,
    Math.round(options.promptSafetyMarginTokens ?? DEFAULT_INFERENCE_PROMPT_SAFETY_MARGIN_TOKENS),
  );
  const requestedResponseReserveTokens = Math.max(
    0,
    Math.round(options.responseReserveTokens ?? thread.paramsSnapshot.maxTokens),
  );

  // Seed exact fitting from the conservative, filesystem-free heuristic window,
  // while allowing a small bounded backfill through attachment-free history. This
  // lets native tokenization recover from conservative estimates without reopening
  // filesystem-backed inputs that the heuristic window already excluded.
  const heuristicWindow = getThreadInferenceWindow(
    thread,
    options,
  );
  const eligibleMessages = getEligibleThreadMessages(thread);
  const messageBoundedWindow = getThreadInferenceWindow(thread, {
    maxContextMessages: options.maxContextMessages,
  });
  const messageBoundedSystemMessages: LlmChatMessage[] = [];
  let messageBoundedHistoryIndex = 0;
  while (
    messageBoundedHistoryIndex < messageBoundedWindow.messages.length
    && messageBoundedWindow.messages[messageBoundedHistoryIndex]?.role === 'system'
  ) {
    messageBoundedSystemMessages.push(messageBoundedWindow.messages[messageBoundedHistoryIndex]);
    messageBoundedHistoryIndex += 1;
  }
  const minimumHistoryStartIndex = messageBoundedWindow.truncatedMessageIds.length;
  const heuristicHistoryStartIndex = heuristicWindow.truncatedMessageIds.length;
  let candidateHistoryStartIndex = Math.max(minimumHistoryStartIndex, heuristicHistoryStartIndex);
  let backfilledMessageCount = 0;
  while (
    candidateHistoryStartIndex > minimumHistoryStartIndex
    && backfilledMessageCount < MAX_EXACT_HISTORY_BACKFILL_MESSAGES
  ) {
    const precedingIndex = candidateHistoryStartIndex - 1;
    const precedingMessage = eligibleMessages[precedingIndex];
    let groupStartIndex: number | null = null;

    if (precedingMessage?.role === 'user') {
      groupStartIndex = precedingIndex;
    } else if (
      precedingMessage?.role === 'assistant'
      && precedingIndex - 1 >= minimumHistoryStartIndex
      && eligibleMessages[precedingIndex - 1]?.role === 'user'
    ) {
      groupStartIndex = precedingIndex - 1;
    } else {
      break;
    }

    const groupMessages = eligibleMessages.slice(groupStartIndex, candidateHistoryStartIndex);
    if (
      backfilledMessageCount + groupMessages.length > MAX_EXACT_HISTORY_BACKFILL_MESSAGES
      || groupMessages.some(hasFileBackedInferenceInput)
    ) {
      break;
    }

    candidateHistoryStartIndex = groupStartIndex;
    backfilledMessageCount += groupMessages.length;
  }
  while (
    candidateHistoryStartIndex < eligibleMessages.length
    && eligibleMessages[candidateHistoryStartIndex]?.role !== 'user'
  ) {
    candidateHistoryStartIndex += 1;
  }
  const historyMessages = eligibleMessages
    .slice(candidateHistoryStartIndex)
    .map(toLlmChatMessage);
  const baseTruncatedMessageIds = eligibleMessages
    .slice(0, candidateHistoryStartIndex)
    .map((message) => message.id);
  const fullMessages = [
    ...messageBoundedSystemMessages,
    ...historyMessages,
  ];

  if (maxContextTokens === null) {
    return {
      messages: fullMessages,
      promptTokens: await countPromptTokensWithCancellation(fullMessages),
      promptSafetyMarginTokens,
      truncatedMessageIds: baseTruncatedMessageIds,
    };
  }

  const systemMessages = messageBoundedSystemMessages;
  const lastUserHistoryIndex = (() => {
    for (let i = historyMessages.length - 1; i >= 0; i -= 1) {
      if (historyMessages[i]?.role === 'user') {
        return i;
      }
    }
    return -1;
  })();
  const historyMessageIds = eligibleMessages
    .slice(candidateHistoryStartIndex, candidateHistoryStartIndex + historyMessages.length)
    .map((message) => message.id);
  if (historyMessages.length === 0) {
    return {
      messages: fullMessages,
      promptTokens: await countPromptTokensWithCancellation(fullMessages),
      promptSafetyMarginTokens,
      truncatedMessageIds: baseTruncatedMessageIds,
    };
  }

  const totalPromptBudget = Math.max(
    0,
    maxContextTokens - promptSafetyMarginTokens,
  );
  const balancedResponseReserveTokens = resolveBalancedResponseReserveTokens(
    requestedResponseReserveTokens,
    totalPromptBudget,
  );

  const tokenCountCache = new Map<number, number>();
  const countTokensForHistoryStart = async (historyStartIndex: number) => {
    if (tokenCountCache.has(historyStartIndex)) {
      return tokenCountCache.get(historyStartIndex)!;
    }

    const tryCount = async (startIndex: number) => {
      const tokens = await countPromptTokensWithCancellation([
        ...systemMessages,
        ...historyMessages.slice(startIndex),
      ]);
      tokenCountCache.set(startIndex, tokens);
      return tokens;
    };

    try {
      return await tryCount(historyStartIndex);
    } catch (error) {
      // Some Jinja chat templates (tool-enabled) require at least one user message in the window.
      // When the thread currently ends with an assistant/tool turn, token-count probes that start
      // after the last user message can throw and break truncation tracking. Retry by including
      // the most recent user message.
      const message = error instanceof Error ? error.message : String(error);
      const normalizedHistoryStartIndex = lastUserHistoryIndex >= 0 && historyStartIndex > lastUserHistoryIndex
        ? lastUserHistoryIndex
        : historyStartIndex;

      if (
        normalizedHistoryStartIndex !== historyStartIndex
        && message.includes('Jinja Exception')
        && message.includes('No user query found in messages')
      ) {
        const tokens = await tryCount(normalizedHistoryStartIndex);
        tokenCountCache.set(historyStartIndex, tokens);
        return tokens;
      }

      throw error;
    }
  };

  const lastHistoryIndex = historyMessages.length - 1;

  // Hard stop: if even the newest single message (plus system prompt) cannot fit inside the
  // context window (after safety margin), we cannot build a valid inference prompt.
  const lastMessageOnlyPromptTokens = await countTokensForHistoryStart(lastHistoryIndex);
  if (lastMessageOnlyPromptTokens > totalPromptBudget) {
    throw new AppError(
      'message_too_long',
      'This message is too long for the current context window. Shorten it or increase the context size in Model Controls.',
      {
        details: {
          maxContextTokens,
          promptSafetyMarginTokens,
          totalPromptBudget,
          lastMessageOnlyPromptTokens,
        },
      },
    );
  }

  // If the prompt is too large to fit the requested reserve, shrink the reserve
  // so we can at least include the minimum required tail messages.
  const minimumRequiredHistoryStartIndex =
    historyMessages[lastHistoryIndex]?.role === 'assistant'
    && lastHistoryIndex > 0
    && historyMessages[lastHistoryIndex - 1]?.role === 'user'
      ? lastHistoryIndex - 1
      : lastHistoryIndex;
  const minimumRequiredPromptTokens = await countTokensForHistoryStart(minimumRequiredHistoryStartIndex);
  const canFitMinimumRequiredPrompt = minimumRequiredPromptTokens <= totalPromptBudget;
  const responseReserveTokens = canFitMinimumRequiredPrompt
    ? Math.min(
        balancedResponseReserveTokens,
        Math.max(totalPromptBudget - minimumRequiredPromptTokens, 0),
      )
    : 0;
  const promptTokenBudget = Math.max(
    0,
    maxContextTokens - promptSafetyMarginTokens - responseReserveTokens,
  );

  const fitsBudget = async (historyStartIndex: number) =>
    (await countTokensForHistoryStart(historyStartIndex)) <= promptTokenBudget;

  let effectiveHistoryStartIndex = 0;

  if (await fitsBudget(0)) {
    effectiveHistoryStartIndex = 0;
  } else if (!(await fitsBudget(lastHistoryIndex))) {
    effectiveHistoryStartIndex = lastHistoryIndex;
  } else {
    let low = 0;
    let high = lastHistoryIndex;

    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (await fitsBudget(mid)) {
        high = mid;
      } else {
        low = mid + 1;
      }
    }

    effectiveHistoryStartIndex = low;
  }

  let normalizedHistoryMessages = historyMessages.slice(effectiveHistoryStartIndex);

  const shouldBackfillLeadingUserMessage =
    effectiveHistoryStartIndex > 0 &&
    normalizedHistoryMessages.length > 0 &&
    normalizedHistoryMessages[0]?.role === 'assistant' &&
    historyMessages[effectiveHistoryStartIndex - 1]?.role === 'user';

  if (shouldBackfillLeadingUserMessage) {
    const leadingUserMessage = historyMessages[effectiveHistoryStartIndex - 1];
    const canBackfillLeadingUserMessage =
      (await countTokensForHistoryStart(effectiveHistoryStartIndex - 1)) <= promptTokenBudget;

    if (canBackfillLeadingUserMessage) {
      effectiveHistoryStartIndex -= 1;
      normalizedHistoryMessages = historyMessages.slice(effectiveHistoryStartIndex);
    } else if (normalizedHistoryMessages.length === 1) {
      const userOnlyTokens = await countPromptTokensWithCancellation([...systemMessages, leadingUserMessage]);
      if (userOnlyTokens <= promptTokenBudget) {
        effectiveHistoryStartIndex -= 1;
        normalizedHistoryMessages = [leadingUserMessage];
      }
    }
  }

  while (
    normalizedHistoryMessages.length > 0 &&
    normalizedHistoryMessages[0]?.role !== 'user'
  ) {
    effectiveHistoryStartIndex += 1;
    normalizedHistoryMessages = historyMessages.slice(effectiveHistoryStartIndex);
  }

  const windowMessages = [...systemMessages, ...normalizedHistoryMessages];
  const truncatedMessageIds = [
    ...baseTruncatedMessageIds,
    ...historyMessageIds.slice(0, effectiveHistoryStartIndex),
  ];

  return {
    messages: windowMessages,
    promptTokens: await countTokensForHistoryStart(effectiveHistoryStartIndex),
    promptSafetyMarginTokens,
    truncatedMessageIds,
  };
}
