import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

export type BootstrapBackgroundState = 'idle' | 'running' | 'done' | 'error';
export type BootstrapCriticalOutcome = 'success' | 'active_model_missing' | 'active_model_blocked' | 'error';

type BootstrapState = {
  criticalOutcome: BootstrapCriticalOutcome;
  backgroundState: BootstrapBackgroundState;
  backgroundError: string | null;
  setCriticalOutcome: (outcome: BootstrapCriticalOutcome) => void;
  setBackgroundState: (state: BootstrapBackgroundState) => void;
  setBackgroundError: (error: string | null) => void;
};

export const useBootstrapStore = create<BootstrapState>()(
  subscribeWithSelector((set) => ({
    criticalOutcome: 'success',
    backgroundState: 'idle',
    backgroundError: null,
    setCriticalOutcome: (criticalOutcome) => set({ criticalOutcome }),
    setBackgroundState: (backgroundState) => set({ backgroundState }),
    setBackgroundError: (backgroundError) => set({ backgroundError }),
  })),
);
