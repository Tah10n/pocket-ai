import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { PrivateStorageHealthSnapshot } from '../services/storage';

export type BootstrapBackgroundState = 'idle' | 'running' | 'done' | 'blocked' | 'error';
export type BootstrapCriticalOutcome = 'success' | 'active_model_missing' | 'active_model_blocked' | 'storage_blocked' | 'error';

type BootstrapState = {
  criticalOutcome: BootstrapCriticalOutcome;
  criticalStorageHealth: PrivateStorageHealthSnapshot | null;
  backgroundState: BootstrapBackgroundState;
  backgroundError: string | null;
  setCriticalOutcome: (outcome: BootstrapCriticalOutcome, storageHealth?: PrivateStorageHealthSnapshot | null) => void;
  setBackgroundState: (state: BootstrapBackgroundState) => void;
  setBackgroundError: (error: string | null) => void;
};

function sanitizePrivateStorageHealthSnapshot(
  storageHealth: PrivateStorageHealthSnapshot,
): PrivateStorageHealthSnapshot {
  return {
    status: storageHealth.status,
    ...(storageHealth.reason ? { reason: storageHealth.reason } : {}),
    retryable: storageHealth.retryable === true,
    requiresExplicitReset: storageHealth.requiresExplicitReset === true,
    ...(storageHealth.messageKey ? { messageKey: storageHealth.messageKey } : {}),
    lastUpdatedAt: Number.isFinite(storageHealth.lastUpdatedAt) ? storageHealth.lastUpdatedAt : Date.now(),
  };
}

export const useBootstrapStore = create<BootstrapState>()(
  subscribeWithSelector((set) => ({
    criticalOutcome: 'success',
    criticalStorageHealth: null,
    backgroundState: 'idle',
    backgroundError: null,
    setCriticalOutcome: (criticalOutcome, storageHealth = null) => set({
      criticalOutcome,
      criticalStorageHealth: criticalOutcome === 'storage_blocked' && storageHealth
        ? sanitizePrivateStorageHealthSnapshot(storageHealth)
        : null,
    }),
    setBackgroundState: (backgroundState) => set({ backgroundState }),
    setBackgroundError: (backgroundError) => set({ backgroundError }),
  })),
);
