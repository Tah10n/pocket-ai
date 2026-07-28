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

const MAX_INCREMENTAL_MARKER_LOOKAHEAD = 256;
const STREAM_BOUNDARY_PUNCTUATION = '.!?。！？';
const STREAM_BOUNDARY_CLOSERS = `"')]}`;
const WHITESPACE_CHARACTER_REGEX = /\s/;

function updateStreamBoundaryState(currentState: boolean, content: string): boolean {
  let nextState = currentState;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (STREAM_BOUNDARY_PUNCTUATION.includes(character)) {
      nextState = true;
    } else if (
      !STREAM_BOUNDARY_CLOSERS.includes(character)
      && !WHITESPACE_CHARACTER_REGEX.test(character)
    ) {
      nextState = false;
    }
  }
  return nextState;
}

export function doesAssistantContentEndAtSentenceBoundary(content: string): boolean {
  return updateStreamBoundaryState(false, content);
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

class BoundaryNewlineTrimAccumulator {
  private content = '';
  private pendingTrailingNewlineCount = 0;
  private hasStarted = false;

  append(content: string): void {
    if (!content) {
      return;
    }

    let contentStart = 0;
    if (!this.hasStarted) {
      while (content[contentStart] === '\n') {
        contentStart += 1;
      }
      if (contentStart === content.length) {
        return;
      }
    }

    let contentEnd = content.length;
    while (contentEnd > contentStart && content[contentEnd - 1] === '\n') {
      contentEnd -= 1;
    }

    if (contentEnd === contentStart) {
      this.pendingTrailingNewlineCount += content.length;
      return;
    }

    const pendingNewlines = this.pendingTrailingNewlineCount > 0
      ? '\n'.repeat(this.pendingTrailingNewlineCount)
      : '';
    this.content += pendingNewlines + content.slice(contentStart, contentEnd);
    this.pendingTrailingNewlineCount = content.length - contentEnd;
    this.hasStarted = true;
  }

  reset(): void {
    this.content = '';
    this.pendingTrailingNewlineCount = 0;
    this.hasStarted = false;
  }

  getValue(): string {
    return this.content;
  }
}

type IncrementalParserMode = 'awaiting_open' | 'reasoning' | 'visible';

type AwaitingOpenClassification =
  | { kind: 'open'; match: ReasoningOpenMatch }
  | { kind: 'partial' }
  | { kind: 'whitespace' }
  | { kind: 'visible' };

function classifyIncrementalReasoningOpen(content: string): AwaitingOpenClassification {
  const openMatch = matchLeadingReasoningOpenTag(content);
  if (openMatch) {
    return { kind: 'open', match: openMatch };
  }

  if (content.trimStart().length === 0) {
    return content.length > MAX_INCREMENTAL_MARKER_LOOKAHEAD
      ? { kind: 'visible' }
      : { kind: 'whitespace' };
  }

  if (
    content.length <= MAX_INCREMENTAL_MARKER_LOOKAHEAD
    && isPartialLeadingReasoningOpenTagPrefix(content)
  ) {
    return { kind: 'partial' };
  }

  return { kind: 'visible' };
}

/**
 * Stateful streaming parser. Delta characters are consumed once; only the
 * bounded marker lookahead and close-tag suffix are revisited. Prefix-extending
 * cumulative snapshots consume only their new suffix. Explicit or non-prefix
 * snapshots rebuild raw presentation state for deterministic resynchronization.
 */
export class IncrementalAssistantPresentationParser {
  private mode: IncrementalParserMode = 'awaiting_open';
  private pendingOpen = '';
  private closeTag = '';
  private pendingClose = '';
  private visibleContent = new BoundaryNewlineTrimAccumulator();
  private visibleContentRevision = 0;
  private visibleContentEndsAtSentenceBoundary = false;
  private currentThought = new BoundaryNewlineTrimAccumulator();
  private derivedThoughtContent = '';
  private currentThoughtHasContent = false;
  private explicitReasoningRaw = '';
  private hasExplicitReasoning = false;
  private processedCharacterCount = 0;
  private rawStreamLength = 0;
  private explicitReasoningStreamLength = 0;

  appendDelta(delta: string): void {
    if (!delta) {
      return;
    }

    this.processRawCharacters(delta);
    this.rawStreamLength += delta.length;
  }

  applySnapshot(snapshot: string): void {
    this.resetRawPresentationState();
    this.rawStreamLength = snapshot.length;
    if (!snapshot) {
      return;
    }

    this.processRawCharacters(snapshot);
  }

  applyCumulativeSnapshot(snapshot: string): void {
    // Cumulative producers guarantee prefix extension. Deliberately use only
    // the consumed stream length here: startsWith(previousSnapshot) would itself rescan
    // the entire processed prefix on every callback. Call applySnapshot for an
    // explicit replacement; a shrinking cumulative value also resynchronizes.
    if (snapshot.length >= this.rawStreamLength) {
      const suffix = snapshot.slice(this.rawStreamLength);
      this.rawStreamLength = snapshot.length;
      if (suffix) {
        this.processRawCharacters(suffix);
      }
      return;
    }

    this.resetRawPresentationState();
    this.rawStreamLength = snapshot.length;
    if (snapshot) {
      this.processRawCharacters(snapshot);
    }
  }

  applyExplicitReasoningSnapshot(reasoning: string): void {
    this.hasExplicitReasoning = true;
    this.explicitReasoningRaw = reasoning;
    this.explicitReasoningStreamLength = reasoning.length;
    if (!reasoning) {
      return;
    }

    this.processedCharacterCount += reasoning.length;
  }

  applyCumulativeExplicitReasoningSnapshot(reasoning: string): void {
    this.hasExplicitReasoning = true;
    this.explicitReasoningRaw = reasoning;

    if (reasoning.length >= this.explicitReasoningStreamLength) {
      this.processedCharacterCount += reasoning.length - this.explicitReasoningStreamLength;
      this.explicitReasoningStreamLength = reasoning.length;
      return;
    }

    this.processedCharacterCount += reasoning.length;
    this.explicitReasoningStreamLength = reasoning.length;
  }

  appendExplicitReasoningDelta(delta: string): void {
    if (!delta) {
      return;
    }

    this.hasExplicitReasoning = true;
    this.explicitReasoningRaw += delta;
    this.explicitReasoningStreamLength += delta.length;
    this.processedCharacterCount += delta.length;
  }

  getPresentation(): AssistantPresentation {
    const hasPartialOpeningMarker = this.mode === 'awaiting_open'
      && this.pendingOpen.trimStart().length > 0;
    const derivedThoughtContent = this.getDerivedThoughtContent();
    const thoughtContent = this.hasExplicitReasoning
      ? this.explicitReasoningRaw
      : derivedThoughtContent;
    const finalContent = this.mode === 'visible'
      ? this.visibleContent.getValue()
      : this.mode === 'awaiting_open' && !hasPartialOpeningMarker
        ? trimBoundaryBlankLines(this.pendingOpen)
        : '';
    const hasExplicitThought = this.hasExplicitReasoning && thoughtContent.length > 0;
    const isThoughtStreaming = this.hasExplicitReasoning
      ? hasExplicitThought && finalContent.length === 0
      : this.mode === 'reasoning' || hasPartialOpeningMarker;
    const hasThought = this.hasExplicitReasoning
      ? hasExplicitThought
      : thoughtContent.length > 0 || this.mode === 'reasoning' || hasPartialOpeningMarker;

    return {
      finalContent,
      thoughtContent,
      hasThought,
      isThoughtStreaming,
    };
  }

  /** Source UTF-16 code units consumed by parser operations, excluding bounded marker-state checks. */
  getProcessedCharacterCount(): number {
    return this.processedCharacterCount;
  }

  getVisibleContentRevision(): number {
    return this.visibleContentRevision;
  }

  doesVisibleContentEndAtSentenceBoundary(): boolean {
    return this.visibleContentEndsAtSentenceBoundary;
  }

  private resetRawPresentationState(): void {
    this.mode = 'awaiting_open';
    this.pendingOpen = '';
    this.closeTag = '';
    this.pendingClose = '';
    this.visibleContent.reset();
    this.visibleContentRevision += 1;
    this.visibleContentEndsAtSentenceBoundary = false;
    this.currentThought.reset();
    this.derivedThoughtContent = '';
    this.currentThoughtHasContent = false;
  }

  private processRawCharacters(content: string): void {
    let cursor = 0;
    const stableThoughtCharacters: string[] = [];
    const flushStableThoughtCharacters = () => {
      if (stableThoughtCharacters.length === 0) {
        return;
      }

      this.appendCurrentThought(stableThoughtCharacters.join(''));
      stableThoughtCharacters.length = 0;
    };

    while (cursor < content.length) {
      if (this.mode === 'visible') {
        this.processedCharacterCount += content.length - cursor;
        this.appendVisibleContent(content.slice(cursor));
        return;
      }

      if (this.mode === 'awaiting_open') {
        this.pendingOpen += content[cursor];
        cursor += 1;
        this.processedCharacterCount += 1;
        const classification = classifyIncrementalReasoningOpen(this.pendingOpen);
        if (classification.kind === 'open') {
          this.mode = 'reasoning';
          this.closeTag = classification.match.closeTag.toLowerCase();
          this.pendingOpen = '';
          this.pendingClose = '';
          this.currentThought.reset();
          this.currentThoughtHasContent = false;
        } else if (classification.kind === 'visible') {
          this.mode = 'visible';
          this.appendVisibleContent(this.pendingOpen);
          this.pendingOpen = '';
        }
        continue;
      }

      this.pendingClose += content[cursor];
      cursor += 1;
      this.processedCharacterCount += 1;
      while (
        this.pendingClose.length > 0
        && !this.closeTag.startsWith(this.pendingClose.toLowerCase())
      ) {
        stableThoughtCharacters.push(this.pendingClose[0]);
        this.pendingClose = this.pendingClose.slice(1);
      }

      if (this.pendingClose.toLowerCase() === this.closeTag) {
        flushStableThoughtCharacters();
        this.completeCurrentThought();
      }
    }

    flushStableThoughtCharacters();
  }

  private appendVisibleContent(content: string): void {
    const previousLength = this.visibleContent.getValue().length;
    this.visibleContent.append(content);
    const nextVisibleContent = this.visibleContent.getValue();
    if (nextVisibleContent.length === previousLength) {
      return;
    }

    const stableVisibleAppend = nextVisibleContent.slice(previousLength);
    this.visibleContentEndsAtSentenceBoundary = updateStreamBoundaryState(
      this.visibleContentEndsAtSentenceBoundary,
      stableVisibleAppend,
    );
    this.visibleContentRevision += 1;
  }

  private appendCurrentThought(content: string): void {
    const previousLength = this.currentThought.getValue().length;
    this.currentThought.append(content);
    const nextThoughtContent = this.currentThought.getValue();
    if (nextThoughtContent.length === previousLength) {
      return;
    }

    if (!this.currentThoughtHasContent) {
      if (this.derivedThoughtContent) {
        this.derivedThoughtContent += '\n\n';
      }
      this.currentThoughtHasContent = true;
    }
    this.derivedThoughtContent += nextThoughtContent.slice(previousLength);
  }

  private completeCurrentThought(): void {
    this.mode = 'awaiting_open';
    this.pendingOpen = '';
    this.closeTag = '';
    this.pendingClose = '';
    this.currentThought.reset();
    this.currentThoughtHasContent = false;
  }

  private getDerivedThoughtContent(): string {
    return this.derivedThoughtContent;
  }
}

export function createIncrementalAssistantPresentationParser() {
  return new IncrementalAssistantPresentationParser();
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
