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
    await llmEngineService.load(modelId);
  }, []);

  const unloadModel = useCallback(async () => {
    await llmEngineService.unload();
  }, []);

  return {
    state,
    loadModel,
    unloadModel,
    isReady: state.status === EngineStatus.READY,
    isInitializing: state.status === EngineStatus.INITIALIZING,
  };
}
