import type { ChatMessage, ChatThread, LlmChatMessage } from '../types/chat';
import { AppError } from '../services/AppError';
import { getVisibleMessageContent } from './chatPresentation';

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
export const DEFAULT_INFERENCE_PROMPT_SAFETY_MARGIN_TOKENS = 64;
const RESPONSE_RESERVE_BALANCING_MIN_TOKENS = 256;
const MAX_RESPONSE_RESERVE_SHARE_OF_PROMPT_BUDGET = 0.5;

export function estimateLlmMessageTokens(message: LlmChatMessage) {
  return Math.max(1, Math.ceil(message.content.trim().length / CHARS_PER_ESTIMATED_TOKEN)) + MESSAGE_TOKEN_OVERHEAD;
}

export function estimateLlmMessagesTokens(messages: LlmChatMessage[]) {
  return messages.reduce((total, message) => total + estimateLlmMessageTokens(message), 0);
}

function resolveBalancedResponseReserveTokens(
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

export function getThreadInferenceWindow(
  thread: ChatThread,
  optionsOrMaxContextMessages: number | ThreadInferenceWindowOptions,
  latestUserMessage?: ChatMessage,
): ThreadInferenceWindow {
  const options = resolveInferenceWindowOptions(optionsOrMaxContextMessages);
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
      message.state !== 'error'
      && getVisibleMessageContent(message.role, message.content).trim().length > 0,
  );
  const historyMessages = eligibleMessages.map<LlmChatMessage>((message) => ({
    role: message.role,
    content: getVisibleMessageContent(message.role, message.content),
  }));

  if (
    latestUserMessage &&
    !historyMessages.some((message) => message.content === latestUserMessage.content && message.role === 'user')
  ) {
    historyMessages.push({
      role: 'user',
      content: latestUserMessage.content,
    });
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
      message.state !== 'error'
      && getVisibleMessageContent(message.role, message.content).trim().length > 0,
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
): Promise<{
  messages: LlmChatMessage[];
  promptTokens: number;
  promptSafetyMarginTokens: number;
  truncatedMessageIds: string[];
}> {
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

  const { messages: fullMessages, truncatedMessageIds: baseTruncatedMessageIds } = getThreadInferenceWindow(thread, {
    maxContextMessages: options.maxContextMessages,
  });
  const eligibleMessages = getEligibleThreadMessages(thread);

  if (maxContextTokens === null) {
    return {
      messages: fullMessages,
      promptTokens: await countPromptTokens(fullMessages),
      promptSafetyMarginTokens,
      truncatedMessageIds: baseTruncatedMessageIds,
    };
  }

  const systemMessages: LlmChatMessage[] = [];
  let firstHistoryIndex = 0;
  while (firstHistoryIndex < fullMessages.length && fullMessages[firstHistoryIndex]?.role === 'system') {
    systemMessages.push(fullMessages[firstHistoryIndex]);
    firstHistoryIndex += 1;
  }

  const historyMessages = fullMessages.slice(firstHistoryIndex);
  const historyMessageIds = eligibleMessages
    .slice(baseTruncatedMessageIds.length, baseTruncatedMessageIds.length + historyMessages.length)
    .map((message) => message.id);
  if (historyMessages.length === 0) {
    return {
      messages: fullMessages,
      promptTokens: await countPromptTokens(fullMessages),
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

    const tokens = await countPromptTokens([
      ...systemMessages,
      ...historyMessages.slice(historyStartIndex),
    ]);
    tokenCountCache.set(historyStartIndex, tokens);
    return tokens;
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
      const userOnlyTokens = await countPromptTokens([...systemMessages, leadingUserMessage]);
      if (userOnlyTokens <= promptTokenBudget) {
        effectiveHistoryStartIndex -= 1;
        normalizedHistoryMessages = [leadingUserMessage];
      }
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
