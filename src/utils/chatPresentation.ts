import type { ChatMessageRole } from '../types/chat';

const THINK_OPEN_TAG_REGEX = /^\s*<think\b[^>]*>/i;
const THINK_CLOSE_TAG_REGEX = /<\/think>/i;

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

export function getAssistantPresentation(
  content: string,
  options: {
    isStreaming?: boolean;
  } = {},
): AssistantPresentation {
  if (!content || !THINK_OPEN_TAG_REGEX.test(content)) {
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
    const openMatch = remaining.match(THINK_OPEN_TAG_REGEX);
    if (!openMatch) {
      break;
    }

    cursor += openMatch[0].length;
    const closeMatch = content.slice(cursor).match(THINK_CLOSE_TAG_REGEX);

    if (!closeMatch || closeMatch.index == null) {
      thoughtParts.push(trimBoundaryBlankLines(content.slice(cursor)));
      return {
        finalContent: '',
        thoughtContent: thoughtParts.filter(Boolean).join('\n\n'),
        hasThought: true,
        isThoughtStreaming: Boolean(options.isStreaming),
      };
    }

    const closeIndex = cursor + closeMatch.index;
    thoughtParts.push(trimBoundaryBlankLines(content.slice(cursor, closeIndex)));
    cursor = closeIndex + closeMatch[0].length;
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
