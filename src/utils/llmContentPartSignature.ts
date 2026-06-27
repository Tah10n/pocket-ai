import type { LlmContentPart } from '../types/chat';

function hashSignatureValue(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }

  return `${value.length}:${hash.toString(36)}`;
}

function hashOptionalSignatureValue(value: string | null | undefined): string {
  const normalized = value?.trim() ?? '';
  return normalized.length > 0 ? hashSignatureValue(normalized) : 'none';
}

export function getLlmContentPartSignatureEntry(part: LlmContentPart): string {
  if (part.type === 'text') {
    return `text:${hashSignatureValue(part.text)}`;
  }

  if (part.type === 'image_url') {
    return `image_url:${hashOptionalSignatureValue(part.image_url.url)}`;
  }

  return [
    'input_audio',
    part.input_audio.format,
    `url:${hashOptionalSignatureValue(part.input_audio.url)}`,
    `data:${hashOptionalSignatureValue(part.input_audio.data)}`,
  ].join(':');
}
