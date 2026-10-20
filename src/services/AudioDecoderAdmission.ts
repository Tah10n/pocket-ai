import * as FileSystem from 'expo-file-system/legacy';
import type { LlmChatMessage } from '../types/chat';
import { MAX_CHAT_AUDIO_ATTACHMENT_BYTES } from '../utils/chatAttachments';
import { resolveConservativeAvailableMemoryBudget } from '../memory/budget';
import { AppError } from './AppError';
import { getFreshMemorySnapshot } from './SystemMetricsService';

// The guarded native decoder bounds each mono F32 allocation to 8 Mi samples.
// Reserve three copies (decoder, bitmap, processing), six encoded-file sizes
// (including possible JS/base64/bridge copies), and 64 MiB for codec workspace.
// This is a separate Send/token-count policy, not a recording/import duration limit.
export const AUDIO_DECODER_RESERVE_PER_INPUT = 3 * 8 * 1024 * 1024 * 4
  + 6 * MAX_CHAT_AUDIO_ATTACHMENT_BYTES + 64 * 1024 * 1024;

export async function assertAudioDecoderAdmission(
  messages: readonly LlmChatMessage[], assertCurrent: () => void,
): Promise<void> {
  const inputs = messages.flatMap(message => (message.contentParts ?? [])
    .flatMap(part => part.type === 'input_audio' ? [part.input_audio] : []));
  if (!inputs.length) return;
  for (const input of inputs) {
    assertCurrent();
    if (input.data?.trim()) {
      if (input.data.length > 4 * Math.ceil(MAX_CHAT_AUDIO_ATTACHMENT_BYTES / 3)) {
        throw new AppError('audio_decoder_size_limit', 'Audio exceeds the decoder input size limit.');
      }
    } else if (input.url?.trim()) {
      const uri = input.url.startsWith('/') ? `file://${input.url}` : input.url;
      if (!uri.startsWith('file://')) {
        throw new AppError('chat_attachment_unsupported_type', 'Audio decoder requires a local file.');
      }
      const info = await FileSystem.getInfoAsync(uri);
      assertCurrent();
      if (!info.exists || info.isDirectory || !Number.isSafeInteger(info.size) || info.size <= 0) {
        throw new AppError('chat_attachment_missing', 'Audio file is unavailable.');
      }
      if (info.size > MAX_CHAT_AUDIO_ATTACHMENT_BYTES) {
        throw new AppError('audio_decoder_size_limit', 'Audio exceeds the decoder input size limit.');
      }
    } else {
      throw new AppError('chat_attachment_corrupt', 'Audio input is empty.');
    }
  }
  const memory = await getFreshMemorySnapshot(0).catch(() => null);
  assertCurrent();
  const available = memory ? resolveConservativeAvailableMemoryBudget(memory, { strictFreeCap: true }) : null;
  const required = inputs.length * AUDIO_DECODER_RESERVE_PER_INPUT;
  if (available === null || !Number.isSafeInteger(required) || available < required
    || memory?.lowMemory || memory?.pressureLevel === 'critical') {
    throw new AppError('model_memory_insufficient', 'There is not enough verified free memory to decode audio safely.');
  }
}
