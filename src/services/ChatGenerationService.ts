import { AppError, getPrivacySafeErrorLogDetails } from './AppError';
import { backgroundTaskService } from './BackgroundTaskService';
import { llmEngineService } from './LLMEngineService';

const GENERATION_WORK_DRAIN_TIMEOUT_MS = 5_000;
const GENERATION_STOP_MESSAGE = 'Generation was stopped before completion started.';

export type ChatGenerationDrainResult = 'drained' | 'timed_out';

export interface ChatGenerationWorkHandle {
  assertCurrent: () => void;
  finish: () => void;
  waitFor: <T>(promise: Promise<T>) => Promise<T>;
}

type ActiveStopRegistration = {
  id: symbol;
  hasNativeCompletion: () => boolean;
  stop: () => Promise<void>;
};

type FallbackStopRegistration = ActiveStopRegistration & {
  isActive: () => boolean;
};

let cancellationGeneration = 0;
let activeStopRegistration: ActiveStopRegistration | null = null;
let fallbackStopRegistration: FallbackStopRegistration | null = null;
let stopAllPromise: Promise<ChatGenerationDrainResult> | null = null;
let admissionBlocked = false;
const activeWork = new Map<symbol, Promise<void>>();
const cancellationListeners = new Set<() => void>();

export class ChatGenerationCancelledError extends AppError {
  constructor(scope: string) {
    super('action_failed', GENERATION_STOP_MESSAGE, {
      details: { scope },
    });
    this.name = 'ChatGenerationCancelledError';
  }
}

export function isChatGenerationCancelledError(error: unknown): error is ChatGenerationCancelledError {
  return error instanceof ChatGenerationCancelledError;
}

function invalidateGenerationWork(): void {
  cancellationGeneration += 1;
  const listeners = Array.from(cancellationListeners);
  cancellationListeners.clear();
  listeners.forEach((listener) => listener());
}

export function beginChatGenerationWork(scope: string): ChatGenerationWorkHandle {
  if (admissionBlocked) {
    throw new AppError('engine_busy', 'Wait for the current response to finish stopping.');
  }

  const id = Symbol(scope);
  const generation = cancellationGeneration;
  let finished = false;
  let resolveFinished!: () => void;
  const finishedPromise = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  activeWork.set(id, finishedPromise);

  const assertCurrent = () => {
    if (finished || generation !== cancellationGeneration || admissionBlocked) {
      throw new ChatGenerationCancelledError(scope);
    }
  };

  return {
    assertCurrent,
    finish: () => {
      if (finished) {
        return;
      }
      finished = true;
      activeWork.delete(id);
      resolveFinished();
    },
    waitFor: <T>(promise: Promise<T>): Promise<T> => {
      try {
        assertCurrent();
      } catch (error) {
        return Promise.reject(error);
      }

      return new Promise<T>((resolve, reject) => {
        let settled = false;
        const settle = (callback: () => void) => {
          if (settled) {
            return;
          }
          settled = true;
          cancellationListeners.delete(cancel);
          callback();
        };
        const cancel = () => settle(() => reject(new ChatGenerationCancelledError(scope)));
        cancellationListeners.add(cancel);

        promise.then(
          (value) => settle(() => resolve(value)),
          (error) => settle(() => reject(error)),
        );
      });
    },
  };
}

export function registerActiveChatGenerationStop(
  registrationInput: {
    hasNativeCompletion: () => boolean;
    stop: () => Promise<void>;
  },
): () => void {
  const registration: ActiveStopRegistration = {
    id: Symbol('active-chat-generation'),
    ...registrationInput,
  };
  activeStopRegistration = registration;

  return () => {
    if (activeStopRegistration?.id === registration.id) {
      activeStopRegistration = null;
    }
  };
}

export function registerChatGenerationFallbackStop(
  registrationInput: {
    isActive: () => boolean;
    hasNativeCompletion: () => boolean;
    stop: () => Promise<void>;
  },
): void {
  fallbackStopRegistration = {
    id: Symbol('fallback-chat-generation'),
    ...registrationInput,
  };
}

function waitForWorkToDrain(
  work: readonly Promise<void>[],
  timeoutMs: number,
): Promise<ChatGenerationDrainResult> {
  if (work.length === 0) {
    return Promise.resolve('drained');
  }

  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve('timed_out');
      }
    }, timeoutMs);

    void Promise.allSettled(work).then(() => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve('drained');
    });
  });
}

export function stopAllGenerationWork(
  options: { blockNewWork?: boolean } = {},
): Promise<ChatGenerationDrainResult> {
  if (options.blockNewWork !== false) {
    admissionBlocked = true;
  }
  if (stopAllPromise) {
    return stopAllPromise;
  }

  const stopRegistration = activeStopRegistration
    ?? (fallbackStopRegistration?.isActive() ? fallbackStopRegistration : null);
  const workAtStop = Array.from(activeWork.values());
  invalidateGenerationWork();

  const stopTask = (async (): Promise<ChatGenerationDrainResult> => {
    let firstError: unknown = null;
    let contextDrainResult: ChatGenerationDrainResult = 'drained';
    const captureFirstError = (error: unknown) => {
      firstError ??= error;
    };

    try {
      await stopRegistration?.stop();
    } catch (error) {
      captureFirstError(error);
    }

    try {
      contextDrainResult = await llmEngineService.cancelActiveContextOperations();
    } catch (error) {
      captureFirstError(error);
    }

    try {
      if (stopRegistration?.hasNativeCompletion() || llmEngineService.hasActiveCompletion()) {
        await llmEngineService.interruptActiveCompletion();
      } else {
        await llmEngineService.stopCompletion();
      }
    } catch (error) {
      captureFirstError(error);
    }

    try {
      const stopStillOwnsActiveGeneration = stopRegistration
        ? activeStopRegistration
          ? activeStopRegistration.id === stopRegistration.id
          : fallbackStopRegistration?.id === stopRegistration.id
        : activeStopRegistration === null;
      if (
        stopStillOwnsActiveGeneration
        && backgroundTaskService.isTaskActive('inference')
      ) {
        await backgroundTaskService.stopBackgroundTask('inference');
      }
    } catch (error) {
      captureFirstError(error);
    }

    const workDrainResult = contextDrainResult === 'timed_out'
      ? 'timed_out'
      : stopRegistration
        // Once runAssistantCompletion has registered its stop controller, the
        // terminal store commit plus the LLM context/native drain above are the
        // authoritative barrier. Waiting for the React caller promise as well
        // would deadlock callers whose mocked/native completion resolves only
        // after the stop action returns.
        ? 'drained'
        : await waitForWorkToDrain(workAtStop, GENERATION_WORK_DRAIN_TIMEOUT_MS);

    if (workDrainResult === 'timed_out') {
      console.warn('[ChatGenerationService] Timed out draining cancelled generation work', {
        scope: 'chat_generation_stop',
        activeWorkCount: workAtStop.length,
      });
    }

    if (firstError) {
      console.warn('[ChatGenerationService] Failed to stop all generation work', {
        scope: 'chat_generation_stop',
        ...getPrivacySafeErrorLogDetails(firstError),
      });
      throw firstError;
    }

    return workDrainResult;
  })();

  const trackedStopTask = stopTask.finally(() => {
    if (stopAllPromise === trackedStopTask) {
      stopAllPromise = null;
      admissionBlocked = false;
    }
  });
  stopAllPromise = trackedStopTask;
  return trackedStopTask;
}

export function __resetChatGenerationServiceForTests(): void {
  invalidateGenerationWork();
  activeStopRegistration = null;
  stopAllPromise = null;
  admissionBlocked = false;
  activeWork.clear();
}
