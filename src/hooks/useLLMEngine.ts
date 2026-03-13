import { useState, useEffect, useCallback } from 'react';
import { llmEngineService } from '../services/LLMEngineService';
import { EngineState, EngineStatus } from '../types/models';

export function useLLMEngine() {
  const [state, setState] = useState<EngineState>(llmEngineService.getState());

  useEffect(() => {
    return llmEngineService.subscribe((newState) => {
      setState(newState);
    });
  }, []);

  const loadModel = useCallback(async (modelId: string) => {
    try {
      await llmEngineService.load(modelId);
    } catch (e) {
      console.error('[useLLMEngine] Failed to load model', e);
    }
  }, []);

  const unloadModel = useCallback(async () => {
    try {
      await llmEngineService.unload();
    } catch (e) {
      console.error('[useLLMEngine] Failed to unload model', e);
    }
  }, []);

  return {
    state,
    loadModel,
    unloadModel,
    isReady: state.status === EngineStatus.READY,
    isInitializing: state.status === EngineStatus.INITIALIZING,
  };
}
