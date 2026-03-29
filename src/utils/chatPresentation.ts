import type { ChatMessageRole } from '../types/chat';

const REASONING_OPEN_TAG_REGEX = /^\s*<(think|thinking)\b[^>]*>/i;

export interface AssistantPresentation {
  finalContent: string;
  thoughtContent: string;
  hasThought: boolean;
  isThoughtStreaming: boolean;
}

function trimBoundaryBlankLines(content: string) {
  return content
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

function findReasoningCloseTag(content: string, cursor: number, tagName: string) {
  const closeTagRegex = new RegExp(`</${tagName}>`, 'i');
  const closeMatch = content.slice(cursor).match(closeTagRegex);
  if (!closeMatch || closeMatch.index == null) {
    return null;
  }

  return {
    index: cursor + closeMatch.index,
    length: closeMatch[0].length,
  };
}

export function getAssistantPresentation(
  content: string,
  options: {
    isStreaming?: boolean;
  } = {},
): AssistantPresentation {
  if (!content || !REASONING_OPEN_TAG_REGEX.test(content)) {
    return {
      finalContent: trimBoundaryBlankLines(content),
      thoughtContent: '',
      hasThought: false,
      isThoughtStreaming: false,
    };
  }

  const thoughtParts: string[] = [];
  let cursor = 0;

  while (true) {
    const remaining = content.slice(cursor);
    const openMatch = remaining.match(REASONING_OPEN_TAG_REGEX);
    if (!openMatch) {
      break;
    }

    const tagName = openMatch[1]?.toLowerCase();
    if (!tagName) {
      break;
    }

    cursor += openMatch[0].length;
    const closeMatch = findReasoningCloseTag(content, cursor, tagName);

    if (!closeMatch) {
      thoughtParts.push(trimBoundaryBlankLines(content.slice(cursor)));
      return {
        finalContent: '',
        thoughtContent: thoughtParts.filter(Boolean).join('\n\n'),
        hasThought: true,
        isThoughtStreaming: Boolean(options.isStreaming),
      };
    }

    const closeIndex = closeMatch.index;
    thoughtParts.push(trimBoundaryBlankLines(content.slice(cursor, closeIndex)));
    cursor = closeIndex + closeMatch.length;
  }

  return {
    finalContent: trimBoundaryBlankLines(content.slice(cursor)),
    thoughtContent: thoughtParts.filter(Boolean).join('\n\n'),
    hasThought: thoughtParts.some((part) => part.length > 0),
    isThoughtStreaming: false,
  };
}

export function getVisibleAssistantContent(content: string) {
  const presentation = getAssistantPresentation(content);
  return presentation.finalContent;
}

export function getCopyableAssistantContent(content: string) {
  const presentation = getAssistantPresentation(content);
  return presentation.hasThought ? presentation.finalContent : content;
}

export function getVisibleMessageContent(role: ChatMessageRole, content: string) {
  return role === 'assistant' ? getVisibleAssistantContent(content) : content;
}
