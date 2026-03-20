import React, { useEffect } from 'react';
import { render, act, waitFor } from '@testing-library/react-native';
import { useChatSession } from '../../src/hooks/useChatSession';
import { llmEngineService } from '../../src/services/LLMEngineService';
import { getSettings, saveChatHistory } from '../../src/services/SettingsStore';
import { EngineStatus } from '../../src/types/models';

jest.mock('../../src/services/LLMEngineService', () => ({
  llmEngineService: {
    getState: jest.fn(),
    chatCompletion: jest.fn(),
  },
}));

jest.mock('../../src/services/SettingsStore', () => ({
  getSettings: jest.fn(),
  saveChatHistory: jest.fn(),
}));

describe('useChatSession', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getSettings as jest.Mock).mockReturnValue({
      activeModelId: 'author/model-q4',
      activePresetId: 'preset-1',
    });
    (llmEngineService.getState as jest.Mock).mockReturnValue({
      status: EngineStatus.READY,
    });
    (llmEngineService.chatCompletion as jest.Mock).mockImplementation(
      async (_prompt: string, _system: string, onToken?: (token: string) => void) => {
        onToken?.('Hello back');
        return { text: 'Hello back' };
      },
    );
  });

  it('persists chat history when a conversation is created', async () => {
    let session: ReturnType<typeof useChatSession> | null = null;

    const Harness = () => {
      const value = useChatSession();

      useEffect(() => {
        session = value;
      }, [value]);

      return null;
    };

    render(<Harness />);

    await act(async () => {
      await session?.appendUserMessage('Hello there');
    });

    await waitFor(() => {
      expect(saveChatHistory).toHaveBeenCalled();
    });

    const lastCall = (saveChatHistory as jest.Mock).mock.calls.at(-1)?.[0];
    expect(lastCall).toEqual(
      expect.objectContaining({
        modelId: 'author/model-q4',
        presetId: 'preset-1',
        messages: [
          { role: 'user', content: 'Hello there' },
          { role: 'assistant', content: 'Hello back' },
        ],
      }),
    );
    expect(lastCall.id).toEqual(expect.any(String));
    expect(lastCall.createdAt).toEqual(expect.any(Number));
    expect(lastCall.updatedAt).toEqual(expect.any(Number));
  });
});
