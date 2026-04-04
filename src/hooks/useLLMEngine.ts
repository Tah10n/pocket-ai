import { useState, useEffect, useCallback } from 'react';
import { llmEngineService, type LoadModelOptions } from '../services/LLMEngineService';
import { EngineState, EngineStatus } from '../types/models';

export function useLLMEngine() {
  const [state, setState] = useState<EngineState>(llmEngineService.getState());

  useEffect(() => {
    return llmEngineService.subscribe((newState) => {
      setState(newState);
    });
  }, []);

  const loadModel = useCallback(async (modelId: string, options?: LoadModelOptions) => {
    await llmEngineService.load(modelId, options);
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
