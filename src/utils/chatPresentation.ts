import type { ChatMessageRole } from '../types/chat';

const HTML_REASONING_OPEN_TAG_REGEX = /^\s*<(think|thinking)\b[^>]*>/i;
const BRACKET_REASONING_OPEN_TAG_REGEX = /^\s*\[think\]/i;
const CHANNEL_REASONING_OPEN_TAG_REGEX = /^\s*<\|channel>thought\b/i;
const START_THINKING_OPEN_TAG_REGEX = /^\s*<\|start_thinking\|>/i;

const STREAMING_BRACKET_OPEN_TAG = '[think]';
const STREAMING_CHANNEL_OPEN_TAG = '<|channel>thought';
const STREAMING_START_THINKING_OPEN_TAG = '<|start_thinking|>';
const STREAMING_HTML_THINK_OPEN_PREFIX = '<think';
const STREAMING_HTML_THINKING_OPEN_PREFIX = '<thinking';

type ReasoningOpenMatch = {
  openLength: number;
  closeTag: string;
  kind: 'html' | 'delimiter';
  tagName?: string;
};

function matchLeadingReasoningOpenTag(content: string): ReasoningOpenMatch | null {
  const htmlMatch = content.match(HTML_REASONING_OPEN_TAG_REGEX);
  if (htmlMatch) {
    const tagName = htmlMatch[1]?.toLowerCase();
    if (!tagName) {
      return null;
    }
    return {
      kind: 'html',
      openLength: htmlMatch[0].length,
      closeTag: `</${tagName}>`,
      tagName,
    };
  }

  const bracketMatch = content.match(BRACKET_REASONING_OPEN_TAG_REGEX);
  if (bracketMatch) {
    return {
      kind: 'delimiter',
      openLength: bracketMatch[0].length,
      closeTag: '[/THINK]',
    };
  }

  const channelMatch = content.match(CHANNEL_REASONING_OPEN_TAG_REGEX);
  if (channelMatch) {
    return {
      kind: 'delimiter',
      openLength: channelMatch[0].length,
      closeTag: '<channel|>',
    };
  }

  const startThinkingMatch = content.match(START_THINKING_OPEN_TAG_REGEX);
  if (startThinkingMatch) {
    return {
      kind: 'delimiter',
      openLength: startThinkingMatch[0].length,
      closeTag: '<|end_thinking|>',
    };
  }

  return null;
}

function isPartialLeadingReasoningOpenTagPrefix(content: string): boolean {
  const trimmed = content.trimStart();
  if (trimmed.length === 0) {
    return false;
  }

  const lower = trimmed.toLowerCase();

  // Bracket-style: "[THINK]..."
  if (lower.startsWith('[')) {
    if (STREAMING_BRACKET_OPEN_TAG.startsWith(lower) && lower.length < STREAMING_BRACKET_OPEN_TAG.length) {
      return true;
    }
    if (lower.startsWith('[think') && !lower.includes(']')) {
      return true;
    }
  }

  // Channel delimiter: "<|channel>thought ..."
  if (STREAMING_CHANNEL_OPEN_TAG.startsWith(lower) && lower.length < STREAMING_CHANNEL_OPEN_TAG.length) {
    return true;
  }

  // Llama.cpp thinking delimiter: "<|start_thinking|> ..."
  if (STREAMING_START_THINKING_OPEN_TAG.startsWith(lower) && lower.length < STREAMING_START_THINKING_OPEN_TAG.length) {
    return true;
  }

  // HTML tags with optional attributes: "<think ...>"
  if (lower.startsWith('<') && !lower.includes('>')) {
    if (
      STREAMING_HTML_THINK_OPEN_PREFIX.startsWith(lower)
      || STREAMING_HTML_THINKING_OPEN_PREFIX.startsWith(lower)
      || lower.startsWith(STREAMING_HTML_THINK_OPEN_PREFIX)
      || lower.startsWith(STREAMING_HTML_THINKING_OPEN_PREFIX)
    ) {
      return true;
    }

    // Also treat partial "<|..." special tokens as potential reasoning markers.
    if (lower.startsWith('<|') && (
      STREAMING_CHANNEL_OPEN_TAG.startsWith(lower) || STREAMING_START_THINKING_OPEN_TAG.startsWith(lower)
    )) {
      return true;
    }
  }

  return false;
}

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

function findDelimiterCloseTag(content: string, cursor: number, closeTag: string) {
  const lower = content.toLowerCase();
  const lowerClose = closeTag.toLowerCase();
  const closeIndex = lower.indexOf(lowerClose, cursor);
  if (closeIndex === -1) {
    return null;
  }

  return {
    index: closeIndex,
    length: closeTag.length,
  };
}

export function getAssistantPresentation(
  content: string,
  options: {
    isStreaming?: boolean;
  } = {},
): AssistantPresentation {
  if (!content) {
    return {
      finalContent: '',
      thoughtContent: '',
      hasThought: false,
      isThoughtStreaming: false,
    };
  }

  const leadingOpenMatch = matchLeadingReasoningOpenTag(content);
  if (!leadingOpenMatch) {
    if (options.isStreaming && isPartialLeadingReasoningOpenTagPrefix(content)) {
      return {
        finalContent: '',
        thoughtContent: '',
        hasThought: true,
        isThoughtStreaming: true,
      };
    }

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
    const openMatch = matchLeadingReasoningOpenTag(remaining);
    if (!openMatch) {
      break;
    }

    cursor += openMatch.openLength;
    const closeMatch = openMatch.kind === 'html' && openMatch.tagName
      ? findReasoningCloseTag(content, cursor, openMatch.tagName)
      : findDelimiterCloseTag(content, cursor, openMatch.closeTag);

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

export function getVisibleAssistantContent(
  content: string,
  options: {
    isStreaming?: boolean;
  } = {},
) {
  const presentation = getAssistantPresentation(content, options);
  return presentation.finalContent;
}

export function getCopyableAssistantContent(content: string) {
  const presentation = getAssistantPresentation(content);
  return presentation.hasThought ? presentation.finalContent : content;
}

export function getVisibleMessageContent(role: ChatMessageRole, content: string) {
  return role === 'assistant' ? getVisibleAssistantContent(content) : content;
}
