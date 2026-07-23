import type { LlmChatMessage, LlmContentPart } from '../types/chat';
import { getChatImageAttachmentMediaPaths } from './chatImageAttachments';

type SignatureHashState = {
  primary: number;
  secondary: number;
  codeUnits: number;
};

function appendSignatureSegment(state: SignatureHashState, value: string): void {
  const framedValue = `${value.length}:${value};`;
  state.codeUnits += framedValue.length;

  for (let index = 0; index < framedValue.length; index += 1) {
    const codeUnit = framedValue.charCodeAt(index);
    state.primary ^= codeUnit;
    state.primary = Math.imul(state.primary, 16777619) >>> 0;
    state.secondary ^= codeUnit;
    state.secondary = Math.imul(state.secondary, 2246822519) >>> 0;
  }
}

function appendContentPartSignature(state: SignatureHashState, part: LlmContentPart): void {
  appendSignatureSegment(state, part.type);

  if (part.type === 'text') {
    appendSignatureSegment(state, part.text);
    return;
  }

  if (part.type === 'image_url') {
    appendSignatureSegment(state, part.image_url.url.trim());
    return;
  }

  appendSignatureSegment(state, part.input_audio.format);
  appendSignatureSegment(state, part.input_audio.url?.trim() ?? '');
  appendSignatureSegment(state, part.input_audio.data?.trim() ?? '');
}

function getInferenceMessageMediaPaths(message: LlmChatMessage): string[] {
  return Array.from(new Set([
    ...(message.mediaPaths ?? []),
    ...(message.contentParts
      ?.filter((part) => part.type === 'image_url')
      .map((part) => part.image_url.url) ?? []),
    ...getChatImageAttachmentMediaPaths(message.attachments),
  ]
    .map((path) => path.trim())
    .filter((path) => path.length > 0)));
}

/**
 * Builds a fixed-size, content-sensitive identity for everything passed to native
 * chat formatting. The signature deliberately retains neither message objects nor
 * raw prompt/media values.
 */
export function buildLlmInferenceMessagesSignature(messages: readonly LlmChatMessage[]): string {
  const state: SignatureHashState = {
    primary: 2166136261,
    secondary: 3339675911,
    codeUnits: 0,
  };

  appendSignatureSegment(state, String(messages.length));
  for (const message of messages) {
    appendSignatureSegment(state, message.role);
    appendSignatureSegment(state, message.content);

    const mediaPaths = getInferenceMessageMediaPaths(message);
    appendSignatureSegment(state, String(mediaPaths.length));
    for (const mediaPath of mediaPaths) {
      appendSignatureSegment(state, mediaPath);
    }

    const contentParts = message.contentParts ?? [];
    appendSignatureSegment(state, String(contentParts.length));
    for (const contentPart of contentParts) {
      appendContentPartSignature(state, contentPart);
    }
  }

  return [
    messages.length,
    state.codeUnits,
    state.primary.toString(36),
    state.secondary.toString(36),
  ].join(':');
}
