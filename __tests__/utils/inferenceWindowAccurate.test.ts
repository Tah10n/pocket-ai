import type { ChatThread, LlmChatMessage } from '../../src/types/chat';
import { buildInferenceWindowWithAccurateTokenCounts } from '../../src/utils/inferenceWindow';

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
});
