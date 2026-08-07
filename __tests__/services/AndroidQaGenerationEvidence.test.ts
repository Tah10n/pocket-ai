import {
  activateAndroidQaGenerationAfterFirstDurableOutput,
  armAndroidQaGenerationGate,
  beginAndroidQaGeneration,
  buildAndroidQaPreparedGenerationEvidence,
  getAndroidQaGenerationEvidenceSnapshot,
  isAndroidQaGenerationGateArmed,
  recordAndroidQaPreparedGenerationEvidence,
  releaseAndroidQaGenerationGate,
  resetAndroidQaGenerationEvidenceForTests,
  shouldReduceAndroidQaStreamingMotion,
  shouldHoldAndroidQaGenerationBeforeFirstOutput,
  waitForAndroidQaGenerationGateRelease,
} from '../../src/services/AndroidQaGenerationEvidence';
import type { LlmChatMessage } from '../../src/types/chat';

describe('AndroidQaGenerationEvidence', () => {
  beforeEach(() => {
    resetAndroidQaGenerationEvidenceForTests();
  });

  it('holds the first native output until the matching operation is released', async () => {
    expect(armAndroidQaGenerationGate('before-first-output')).toBe(true);
    beginAndroidQaGeneration('assistant-1');

    expect(shouldHoldAndroidQaGenerationBeforeFirstOutput('assistant-1')).toBe(true);
    expect(getAndroidQaGenerationEvidenceSnapshot().activeGate).toEqual({
      phase: 'before-first-output',
      operationId: 'assistant-1',
    });

    let released = false;
    const pendingRelease = waitForAndroidQaGenerationGateRelease('assistant-1').then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);

    releaseAndroidQaGenerationGate('assistant-1');
    await pendingRelease;
    expect(released).toBe(true);
  });

  it('does not activate the durable-output gate until the first persisted patch', () => {
    expect(armAndroidQaGenerationGate('after-first-durable-output')).toBe(true);
    expect(isAndroidQaGenerationGateArmed('after-first-durable-output')).toBe(true);
    expect(isAndroidQaGenerationGateArmed('before-first-output')).toBe(false);
    beginAndroidQaGeneration('assistant-2');

    expect(shouldHoldAndroidQaGenerationBeforeFirstOutput('assistant-2')).toBe(false);
    expect(getAndroidQaGenerationEvidenceSnapshot().activeGate).toBeNull();
    expect(activateAndroidQaGenerationAfterFirstDurableOutput('assistant-2')).toBe(true);
    expect(isAndroidQaGenerationGateArmed('after-first-durable-output')).toBe(false);
    expect(getAndroidQaGenerationEvidenceSnapshot().activeGate).toEqual({
      phase: 'after-first-durable-output',
      operationId: 'assistant-2',
    });
  });

  it('derives attachment evidence only from the final prepared user request', () => {
    const evidence = buildAndroidQaPreparedGenerationEvidence({
      userMessageId: 'user-2',
      assistantMessageId: 'assistant-2',
      preparedMessages: [
        {
          role: 'user',
          content: 'old',
          attachments: [{
            id: 'old-image',
            threadId: 'thread-1',
            messageId: 'user-1',
            localUri: 'file:///private/old.jpg',
            pathCategory: 'chat_attachment',
            fileName: 'old.jpg',
            source: 'photo_library',
            createdAt: 1,
          }],
        },
        {
          role: 'user',
          content: 'latest secret prompt',
          attachments: [
            {
              id: 'image-1',
              threadId: 'thread-1',
              messageId: 'user-2',
              localUri: 'file:///private/photo.jpg',
              pathCategory: 'chat_attachment',
              fileName: 'photo.jpg',
              source: 'photo_library',
              createdAt: 2,
            },
            {
              id: 'audio-1',
              kind: 'audio',
              state: 'ready',
              threadId: 'thread-1',
              messageId: 'user-2',
              localUri: 'file:///private/audio.mp3',
              pathCategory: 'chat_attachment',
              fileName: 'audio.mp3',
              mimeType: 'audio/mpeg',
              sizeBytes: 10,
              source: 'document_picker',
              createdAt: 3,
              audio: { format: 'mp3' },
            },
          ],
          contentParts: [{
            type: 'input_audio',
            input_audio: { format: 'mp3', url: 'file:///private/audio.mp3' },
          }],
        },
      ],
    });

    expect(evidence).toEqual({
      userMessageId: 'user-2',
      assistantMessageId: 'assistant-2',
      attachments: [
        { id: 'audio-1', kind: 'audio' },
        { id: 'image-1', kind: 'image' },
      ],
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain('file:///');
    expect(serialized).not.toContain('photo.jpg');
    expect(serialized).not.toContain('audio.mp3');
    expect(serialized).not.toContain('latest secret prompt');
    expect(serialized).not.toContain('contentParts');
  });

  it('records only fixed sentinel ids for synthetic prepared document context', () => {
    const documentAttachment = {
      id: 'document-1',
      kind: 'document',
    } as NonNullable<LlmChatMessage['attachments']>[number];
    const evidence = buildAndroidQaPreparedGenerationEvidence({
      userMessageId: 'user-document',
      assistantMessageId: 'assistant-document',
      preparedMessages: [{
        role: 'user',
        content: 'private prefix ORCHID-742 private middle ZEBRA-END-991 private suffix',
        attachments: [documentAttachment],
      }],
    });

    expect(evidence).toEqual({
      userMessageId: 'user-document',
      assistantMessageId: 'assistant-document',
      attachments: [{ id: 'document-1', kind: 'document' }],
      documentSentinelIds: ['orchid-742', 'zebra-end-991'],
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain('private prefix');
    expect(serialized).not.toContain('private middle');
    expect(serialized).not.toContain('private suffix');
    expect(serialized).not.toContain('ORCHID-742');
    expect(serialized).not.toContain('ZEBRA-END-991');
  });

  it('clears stale prepared evidence when the next generation begins', () => {
    const evidence = {
      userMessageId: 'user-1',
      assistantMessageId: 'assistant-1',
      attachments: [{ id: 'image-1', kind: 'image' as const }],
    };
    recordAndroidQaPreparedGenerationEvidence(evidence);
    expect(getAndroidQaGenerationEvidenceSnapshot().preparedGeneration).toEqual(evidence);

    beginAndroidQaGeneration('assistant-2');
    expect(getAndroidQaGenerationEvidenceSnapshot().preparedGeneration).toBeNull();
  });

  it('reduces streaming motion only for an explicit Android QA evidence bundle', () => {
    const originalAndroidQa = process.env.EXPO_PUBLIC_ANDROID_QA;
    try {
      delete process.env.EXPO_PUBLIC_ANDROID_QA;
      expect(shouldReduceAndroidQaStreamingMotion()).toBe(false);

      process.env.EXPO_PUBLIC_ANDROID_QA = '1';
      expect(shouldReduceAndroidQaStreamingMotion()).toBe(true);

      process.env.EXPO_PUBLIC_ANDROID_QA = '0';
      expect(shouldReduceAndroidQaStreamingMotion()).toBe(false);
    } finally {
      if (originalAndroidQa === undefined) {
        delete process.env.EXPO_PUBLIC_ANDROID_QA;
      } else {
        process.env.EXPO_PUBLIC_ANDROID_QA = originalAndroidQa;
      }
    }
  });
});
