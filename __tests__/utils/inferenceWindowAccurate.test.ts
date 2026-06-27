import type { ChatThread, LlmChatMessage } from '../../src/types/chat';
import {
  buildInferenceWindowWithAccurateTokenCounts,
  estimateLlmMessageTokens,
  getThreadInferenceWindow,
} from '../../src/utils/inferenceWindow';
import { copiedImageAttachment } from '../fixtures/chatImageAttachmentFixtures';

describe('buildInferenceWindowWithAccurateTokenCounts', () => {
  it('throws message_too_long when even the newest message cannot fit the context window', async () => {
    const thread: ChatThread = {
      id: 'thread-1',
      title: 'Test',
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: 'You are helpful.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
        minP: 0.05,
        repetitionPenalty: 1,
        maxTokens: 128,
        seed: null,
      },
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'A very long message',
          createdAt: 1,
          state: 'complete',
        },
      ],
      createdAt: 1,
      updatedAt: 1,
      status: 'idle',
    };

    const countPromptTokens = async (messages: LlmChatMessage[]) => {
      // Pretend any prompt that includes a non-system message is too large.
      return messages.some((message) => message.role !== 'system') ? 999 : 1;
    };

    await expect(
      buildInferenceWindowWithAccurateTokenCounts(
        thread,
        {
          maxContextMessages: 24,
          maxContextTokens: 10,
          responseReserveTokens: 0,
          promptSafetyMarginTokens: 0,
        },
        countPromptTokens,
      ),
    ).rejects.toMatchObject({
      code: 'message_too_long',
    });
  });

  it('does not probe token counts with an assistant-only window when the thread ends with assistant output', async () => {
    const thread: ChatThread = {
      id: 'thread-2',
      title: 'Test',
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: 'You are helpful.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
        minP: 0.05,
        repetitionPenalty: 1,
        maxTokens: 128,
        seed: null,
      },
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Hi!',
          createdAt: 1,
          state: 'complete',
        },
        {
          id: 'message-2',
          role: 'assistant',
          content: 'Hello.',
          createdAt: 2,
          state: 'complete',
        },
      ],
      createdAt: 1,
      updatedAt: 2,
      status: 'idle',
    };

    const countPromptTokens = async (messages: LlmChatMessage[]) => {
      if (!messages.some((message) => message.role === 'user')) {
        throw new Error('Jinja Exception: No user query found in messages.');
      }
      return messages.length;
    };

    await expect(
      buildInferenceWindowWithAccurateTokenCounts(
        thread,
        {
          maxContextMessages: 24,
          maxContextTokens: 2048,
          responseReserveTokens: 0,
          promptSafetyMarginTokens: 0,
        },
        countPromptTokens,
      ),
    ).resolves.toEqual(expect.objectContaining({
      truncatedMessageIds: [],
    }));
  });

  it('retains user image attachments and media paths in the inference window', async () => {
    const thread: ChatThread = {
      id: 'thread-vision-1',
      title: 'Vision',
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: 'You are helpful.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
        minP: 0.05,
        repetitionPenalty: 1,
        maxTokens: 128,
        seed: null,
      },
      messages: [
        {
          id: 'message-user-1',
          role: 'user',
          content: 'Describe this image',
          createdAt: 1,
          state: 'complete',
          attachments: [copiedImageAttachment],
        },
      ],
      createdAt: 1,
      updatedAt: 1,
      status: 'idle',
    };

    const window = getThreadInferenceWindow(thread, { maxContextMessages: 24 });

    expect(window.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'user',
        content: 'Describe this image',
        attachments: [copiedImageAttachment],
        mediaPaths: ['test-dir/chat-attachments/thread-vision-1/attachment-image-1.jpg'],
      }),
    ]));
  });

  it('adds image attachment overhead to heuristic token estimates', () => {
    expect(estimateLlmMessageTokens({
      role: 'user',
      content: 'Describe this image',
      mediaPaths: ['/document/image.jpg'],
    })).toBeGreaterThan(estimateLlmMessageTokens({
      role: 'user',
      content: 'Describe this image',
    }));
  });

  it('adds structured media content overhead to heuristic token estimates', () => {
    const textOnlyEstimate = estimateLlmMessageTokens({
      role: 'user',
      content: 'Analyze these inputs',
    });

    expect(estimateLlmMessageTokens({
      role: 'user',
      content: 'Analyze these inputs',
      contentParts: [
        { type: 'image_url', image_url: { url: '/document/image.jpg' } },
        { type: 'input_audio', input_audio: { format: 'wav', url: 'file:///document/audio.wav' } },
      ],
    })).toBeGreaterThan(textOnlyEstimate);
  });
});
