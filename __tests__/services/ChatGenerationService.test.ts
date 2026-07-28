jest.mock('../../src/services/LLMEngineService', () => ({
  llmEngineService: {
    cancelActiveContextOperations: jest.fn().mockResolvedValue('drained'),
    hasActiveCompletion: jest.fn().mockReturnValue(false),
    interruptActiveCompletion: jest.fn().mockResolvedValue(undefined),
    stopCompletion: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../src/services/BackgroundTaskService', () => ({
  backgroundTaskService: {
    isTaskActive: jest.fn().mockReturnValue(false),
    stopBackgroundTask: jest.fn().mockResolvedValue(undefined),
  },
}));

import {
  __resetChatGenerationServiceForTests,
  beginChatGenerationWork,
  registerActiveChatGenerationStop,
  stopAllGenerationWork,
} from '../../src/services/ChatGenerationService';
import { backgroundTaskService } from '../../src/services/BackgroundTaskService';
import { llmEngineService } from '../../src/services/LLMEngineService';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe('ChatGenerationService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetChatGenerationServiceForTests();
    (llmEngineService.cancelActiveContextOperations as jest.Mock).mockResolvedValue('drained');
    (llmEngineService.hasActiveCompletion as jest.Mock).mockReturnValue(false);
    (llmEngineService.interruptActiveCompletion as jest.Mock).mockResolvedValue(undefined);
    (llmEngineService.stopCompletion as jest.Mock).mockResolvedValue(undefined);
    (backgroundTaskService.isTaskActive as jest.Mock).mockReturnValue(false);
    (backgroundTaskService.stopBackgroundTask as jest.Mock).mockResolvedValue(undefined);
  });

  afterEach(() => {
    __resetChatGenerationServiceForTests();
  });

  it('invalidates pre-native work immediately and shares one concurrent stop', async () => {
    const stopDeferred = createDeferred<void>();
    const stopHandler = jest.fn(() => stopDeferred.promise);
    registerActiveChatGenerationStop({
      hasNativeCompletion: () => false,
      stop: stopHandler,
    });
    const work = beginChatGenerationWork('test_pre_native');
    const blockedPreparation = work.waitFor(new Promise<void>(() => {}));

    const firstStop = stopAllGenerationWork();
    const secondStop = stopAllGenerationWork();

    expect(firstStop).toBe(secondStop);
    await expect(blockedPreparation).rejects.toMatchObject({
      name: 'ChatGenerationCancelledError',
    });
    work.finish();
    stopDeferred.resolve(undefined);

    await expect(firstStop).resolves.toBe('drained');
    expect(stopHandler).toHaveBeenCalledTimes(1);
    expect(llmEngineService.cancelActiveContextOperations).toHaveBeenCalledTimes(1);
    expect(llmEngineService.stopCompletion).toHaveBeenCalledTimes(1);
    expect(llmEngineService.interruptActiveCompletion).not.toHaveBeenCalled();
  });

  it('drains the native completion path when the registered generation crossed the boundary', async () => {
    registerActiveChatGenerationStop({
      hasNativeCompletion: () => true,
      stop: jest.fn().mockResolvedValue(undefined),
    });

    await expect(stopAllGenerationWork()).resolves.toBe('drained');

    expect(llmEngineService.cancelActiveContextOperations).toHaveBeenCalledTimes(1);
    expect(llmEngineService.interruptActiveCompletion).toHaveBeenCalledTimes(1);
    expect(llmEngineService.stopCompletion).not.toHaveBeenCalled();
  });

  it('is safe to invoke again after an already-drained stop', async () => {
    await expect(stopAllGenerationWork()).resolves.toBe('drained');
    await expect(stopAllGenerationWork()).resolves.toBe('drained');

    expect(llmEngineService.cancelActiveContextOperations).toHaveBeenCalledTimes(2);
    expect(llmEngineService.stopCompletion).toHaveBeenCalledTimes(2);
  });

  it('stops an orphaned inference background task without an active controller', async () => {
    (backgroundTaskService.isTaskActive as jest.Mock).mockReturnValue(true);

    await expect(stopAllGenerationWork()).resolves.toBe('drained');

    expect(backgroundTaskService.stopBackgroundTask).toHaveBeenCalledWith('inference');
  });
});
