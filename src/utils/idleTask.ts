type IdleCallbackHandle = number;

type IdleCallbackApi = {
  requestIdleCallback?: (
    callback: () => void,
    options?: { timeout?: number },
  ) => IdleCallbackHandle;
  cancelIdleCallback?: (handle: IdleCallbackHandle) => void;
};

let interactiveWorkRevision = 0;
const interactiveWorkListeners = new Set<() => void>();

export function markInteractiveWorkStarted(): void {
  interactiveWorkRevision += 1;
  interactiveWorkListeners.forEach((listener) => listener());
}

function subscribeToInteractiveWork(listener: () => void): () => void {
  interactiveWorkListeners.add(listener);
  return () => interactiveWorkListeners.delete(listener);
}

export function getInteractiveWorkRevision(): number {
  return interactiveWorkRevision;
}

export type ScheduleIdleTaskOptions = {
  delayMs?: number;
  idleTimeoutMs?: number;
};

/**
 * Defers passive work until both a short interaction-cooldown and an idle turn
 * have elapsed. The returned cancellation function prevents callbacks that
 * have not started from doing any work.
 */
export function scheduleIdleTask(
  task: () => void,
  options: ScheduleIdleTaskOptions = {},
): () => void {
  const delayMs = Math.max(0, options.delayMs ?? 150);
  const idleTimeoutMs = Math.max(1, options.idleTimeoutMs ?? 750);
  const idleApi = globalThis as typeof globalThis & IdleCallbackApi;
  let cancelled = false;
  let delayHandle: ReturnType<typeof setTimeout> | null = null;
  let idleHandle: IdleCallbackHandle | null = null;
  let fallbackHandle: ReturnType<typeof setTimeout> | null = null;
  let unsubscribeFromInteractiveWork: (() => void) | null = null;
  let scheduledTurnRevision = 0;

  const clearScheduledTurn = () => {
    if (delayHandle !== null) {
      clearTimeout(delayHandle);
      delayHandle = null;
    }
    if (fallbackHandle !== null) {
      clearTimeout(fallbackHandle);
      fallbackHandle = null;
    }
    if (idleHandle !== null && typeof idleApi.cancelIdleCallback === 'function') {
      idleApi.cancelIdleCallback(idleHandle);
      idleHandle = null;
    }
  };

  const run = (turnRevision: number) => {
    if (cancelled || turnRevision !== scheduledTurnRevision) {
      return;
    }

    fallbackHandle = null;
    idleHandle = null;
    cancelled = true;
    unsubscribeFromInteractiveWork?.();
    unsubscribeFromInteractiveWork = null;
    task();
  };

  const scheduleAfterInteractionCooldown = () => {
    if (cancelled) {
      return;
    }

    clearScheduledTurn();
    scheduledTurnRevision += 1;
    const turnRevision = scheduledTurnRevision;
    delayHandle = setTimeout(() => {
      delayHandle = null;
      if (cancelled || turnRevision !== scheduledTurnRevision) {
        return;
      }

      if (typeof idleApi.requestIdleCallback === 'function') {
        idleHandle = idleApi.requestIdleCallback(
          () => run(turnRevision),
          { timeout: idleTimeoutMs },
        );
        return;
      }

      fallbackHandle = setTimeout(() => run(turnRevision), 0);
    }, delayMs);
  };

  unsubscribeFromInteractiveWork = subscribeToInteractiveWork(scheduleAfterInteractionCooldown);
  scheduleAfterInteractionCooldown();

  return () => {
    if (cancelled) {
      return;
    }

    cancelled = true;
    scheduledTurnRevision += 1;
    unsubscribeFromInteractiveWork?.();
    unsubscribeFromInteractiveWork = null;
    clearScheduledTurn();
  };
}
