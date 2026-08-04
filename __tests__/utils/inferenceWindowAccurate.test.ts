import type { ChatThread, LlmChatMessage } from '../../src/types/chat';
import {
  buildInferenceWindowWithAccurateTokenCounts,
  estimateLlmMessageTokens,
  getThreadInferenceWindow,
  MAX_EXACT_HISTORY_BACKFILL_MESSAGES,
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

  it.each([
    {
      label: 'document text',
      contentParts: [
        { type: 'text' as const, text: 'Ask about this attachment' },
        { type: 'text' as const, text: 'Extracted document body '.repeat(20) },
      ],
    },
    {
      label: 'audio input',
      contentParts: [
        { type: 'text' as const, text: 'Ask about this attachment' },
        {
          type: 'input_audio' as const,
          input_audio: { format: 'wav' as const, url: 'file:///document/audio.wav' },
        },
      ],
    },
  ])('counts scalar content mirrored in $label parts only once', ({ contentParts }) => {
    const mirroredEstimate = estimateLlmMessageTokens({
      role: 'user',
      content: 'Ask about this attachment',
      contentParts,
    });
    const canonicalEstimate = estimateLlmMessageTokens({
      role: 'user',
      content: '',
      contentParts,
    });

    expect(mirroredEstimate).toBe(canonicalEstimate);
  });

  it('backfills only a bounded number of messages after exact counting finds spare room', async () => {
    const messages = Array.from({ length: 60 }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `message-${index}-${'x'.repeat(160)}`,
      createdAt: index + 1,
      state: 'complete' as const,
    }));
    const thread: ChatThread = {
      id: 'thread-bounded-backfill',
      title: 'Bounded backfill',
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: '',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 64,
        seed: null,
      },
      messages,
      createdAt: 1,
      updatedAt: 60,
      status: 'idle',
    };
    const options = {
      maxContextMessages: Number.MAX_SAFE_INTEGER,
      maxContextTokens: 320,
      responseReserveTokens: 0,
      promptSafetyMarginTokens: 0,
    };
    const heuristicWindow = getThreadInferenceWindow(thread, options);
    const exactPreparationCalls: LlmChatMessage[][] = [];

    const result = await buildInferenceWindowWithAccurateTokenCounts(
      thread,
      options,
      async (windowMessages) => {
        exactPreparationCalls.push(windowMessages);
        return windowMessages.length * 2;
      },
    );

    expect(heuristicWindow.truncatedMessageIds.length).toBeGreaterThan(MAX_EXACT_HISTORY_BACKFILL_MESSAGES);
    expect(result.truncatedMessageIds.length).toBeLessThan(heuristicWindow.truncatedMessageIds.length);
    expect(heuristicWindow.truncatedMessageIds.length - result.truncatedMessageIds.length)
      .toBeLessThanOrEqual(MAX_EXACT_HISTORY_BACKFILL_MESSAGES);

    const earliestBackfillIndex = heuristicWindow.truncatedMessageIds.length
      - MAX_EXACT_HISTORY_BACKFILL_MESSAGES;
    const exactMessageIndexes = exactPreparationCalls.flatMap((windowMessages) => (
      windowMessages.flatMap((message) => {
        const match = message.content.match(/^message-(\d+)-/);
        return match?.[1] ? [Number(match[1])] : [];
      })
    ));
    expect(Math.min(...exactMessageIndexes)).toBeGreaterThanOrEqual(earliestBackfillIndex);
    expect(result.messages.find((message) => message.role !== 'system')?.role).toBe('user');
  });

  it('never sends heuristic-truncated attachment messages to exact-count preparation', async () => {
    const thread: ChatThread = {
      id: 'thread-window-first',
      title: 'Window first',
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
        maxTokens: 64,
        seed: null,
      },
      messages: Array.from({ length: 1_000 }, (_, index) => ({
        id: `message-${index}`,
        role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
        content: index < 900 ? `Old attachment turn ${index}` : `Retained tail turn ${index}`,
        createdAt: index + 1,
        state: 'complete' as const,
        ...(index < 900
          ? {
              attachments: [{
                ...copiedImageAttachment,
                id: `attachment-${index}`,
                localUri: `test-dir/chat-attachments/truncated-${index}.jpg`,
              }],
            }
          : null),
      })),
      createdAt: 1,
      updatedAt: 1_000,
      status: 'idle',
    };
    const exactPreparationCalls: LlmChatMessage[][] = [];

    const result = await buildInferenceWindowWithAccurateTokenCounts(
      thread,
      {
        maxContextMessages: Number.MAX_SAFE_INTEGER,
        maxContextTokens: 900,
        responseReserveTokens: 64,
        promptSafetyMarginTokens: 64,
      },
      async (messages) => {
        exactPreparationCalls.push(messages);
        return messages.length * 8;
      },
    );

    expect(result.truncatedMessageIds).toContain('message-899');
    expect(exactPreparationCalls.flat().some((message) => (
      message.content.startsWith('Old attachment turn') || Boolean(message.attachments?.length)
    ))).toBe(false);
    expect(result.messages.at(-1)).toEqual(expect.objectContaining({
      content: 'Retained tail turn 999',
    }));
  });

  it('keeps the heuristic-truncated image pair out of exact preparation while retaining the text pair', async () => {
    const imageUserContent = 'What is in this image?';
    const imageAssistantContent = 'A detailed description of the image content. '.repeat(10);
    const thread: ChatThread = {
      id: 'thread-atomic-backfill',
      title: 'Atomic backfill',
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
        maxTokens: 64,
        seed: null,
      },
      messages: [
        {
          id: 'image-user',
          role: 'user',
          content: imageUserContent,
          createdAt: 1,
          state: 'complete',
          attachments: [copiedImageAttachment],
        },
        {
          id: 'image-assistant',
          role: 'assistant',
          content: imageAssistantContent,
          createdAt: 2,
          state: 'complete',
        },
        {
          id: 'text-user',
          role: 'user',
          content: 'Thanks for the description!',
          createdAt: 3,
          state: 'complete',
        },
        {
          id: 'text-assistant',
          role: 'assistant',
          content: 'You are welcome.',
          createdAt: 4,
          state: 'complete',
        },
      ],
      createdAt: 1,
      updatedAt: 4,
      status: 'idle',
    };
    const options = {
      maxContextMessages: Number.MAX_SAFE_INTEGER,
      maxContextTokens: 70,
      responseReserveTokens: 0,
      promptSafetyMarginTokens: 0,
    };

    // Heuristic precondition: the moderate assistant description plus the huge
    // image attachment estimate push the image pair over the budget, so the
    // estimate-based window drops exactly that pair.
    const heuristicWindow = getThreadInferenceWindow(thread, options);
    expect(heuristicWindow.truncatedMessageIds).toEqual(['image-user', 'image-assistant']);

    const exactPreparationCalls: LlmChatMessage[][] = [];
    const result = await buildInferenceWindowWithAccurateTokenCounts(
      thread,
      options,
      async (messages) => {
        exactPreparationCalls.push(messages);
        return messages.length * 2;
      },
    );

    expect(exactPreparationCalls.length).toBeGreaterThan(0);
    for (const callMessages of exactPreparationCalls) {
      expect(callMessages.some((message) => (
        message.content === imageUserContent
        || message.content === imageAssistantContent
        || Boolean(message.attachments?.length)
      ))).toBe(false);
    }

    const historyMessages = result.messages.filter((message) => message.role !== 'system');
    expect(historyMessages.map((message) => message.content)).toEqual([
      'Thanks for the description!',
      'You are welcome.',
    ]);
    expect(result.truncatedMessageIds).toEqual(['image-user', 'image-assistant']);
    expect(historyMessages[0]?.role).toBe('user');
  });

  it('drops a leading assistant message on the no-token-limit early return path', async () => {
    const thread: ChatThread = {
      id: 'thread-orphan-lead',
      title: 'Orphan lead',
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
        maxTokens: 64,
        seed: null,
      },
      messages: [
        {
          id: 'orphan-assistant',
          role: 'assistant',
          content: 'Orphan reply from an earlier run.',
          createdAt: 1,
          state: 'complete',
        },
        {
          id: 'retained-user',
          role: 'user',
          content: 'What about this?',
          createdAt: 2,
          state: 'complete',
        },
        {
          id: 'retained-assistant',
          role: 'assistant',
          content: 'Here is the answer.',
          createdAt: 3,
          state: 'complete',
        },
      ],
      createdAt: 1,
      updatedAt: 3,
      status: 'idle',
    };
    const exactPreparationCalls: LlmChatMessage[][] = [];

    const result = await buildInferenceWindowWithAccurateTokenCounts(
      thread,
      { maxContextMessages: Number.MAX_SAFE_INTEGER },
      async (messages) => {
        exactPreparationCalls.push(messages);
        return messages.length;
      },
    );

    const historyMessages = result.messages.filter((message) => message.role !== 'system');
    expect(historyMessages[0]?.role).toBe('user');
    expect(historyMessages.map((message) => message.content)).toEqual([
      'What about this?',
      'Here is the answer.',
    ]);
    expect(result.truncatedMessageIds).toContain('orphan-assistant');
    expect(result.messages.some((message) => (
      message.content === 'Orphan reply from an earlier run.'
    ))).toBe(false);
    expect(exactPreparationCalls).toEqual([result.messages]);
  });
});
