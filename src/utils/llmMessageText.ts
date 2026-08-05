import type { LlmChatMessage } from '../types/chat';

type LlmTextContentPartLike = {
  type: string;
  text?: unknown;
};

export function hasEquivalentLlmTextContentPart(
  parts: readonly LlmTextContentPartLike[],
  content: string,
): boolean {
  const trimmedContent = content.trim();
  return parts.some((part) => (
    part.type === 'text'
    && typeof part.text === 'string'
    && part.text.trim() === trimmedContent
  ));
}

export function getNativeLlmMessageTextCharacterCount(message: LlmChatMessage): number {
  const contentParts = message.contentParts ?? [];
  const textContentPartCharacters = contentParts.reduce((total, part) => (
    part.type === 'text' ? total + part.text.trim().length : total
  ), 0);
  const shouldUseScalarContent = message.content.trim().length > 0
    && !hasEquivalentLlmTextContentPart(contentParts, message.content);

  return textContentPartCharacters
    + (shouldUseScalarContent ? message.content.trim().length : 0);
}
