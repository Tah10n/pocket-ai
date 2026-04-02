import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

export type BootstrapBackgroundState = 'idle' | 'running' | 'done' | 'error';

type BootstrapState = {
  backgroundState: BootstrapBackgroundState;
  backgroundError: string | null;
  setBackgroundState: (state: BootstrapBackgroundState) => void;
  setBackgroundError: (error: string | null) => void;
};

export const useBootstrapStore = create<BootstrapState>()(
  subscribeWithSelector((set) => ({
    backgroundState: 'idle',
    backgroundError: null,
    setBackgroundState: (backgroundState) => set({ backgroundState }),
    setBackgroundError: (backgroundError) => set({ backgroundError }),
  })),
);
