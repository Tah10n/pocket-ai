import { useChatStore } from '../store/chatStore';
import { getCompanionBindingIdentity } from '../utils/modelArtifacts';
import { registry } from './LocalStorageRegistry';
import { llmEngineService, type LoadModelOptions } from './LLMEngineService';
import { AppError } from './AppError';
import { hasActiveChatGenerationWork } from './ChatGenerationService';
import { getSettings, subscribeSettings } from './SettingsStore';
import { isPrivateStorageWritable } from './storage';
import { runWithIdleModelDownloads } from './ModelDownloadManager';

function selectionIdentity(modelId: string): string {
  const state = useChatStore.getState();
  const model = registry.getModel(modelId);
  return JSON.stringify([state.activeThreadId, state.inferenceRevision, getSettings().activeModelId,
    model ? getCompanionBindingIdentity(model) : null, model?.localPath]);
}

/** A retry is valid only for the original conversation and variant selection. */
export function captureModelProfileSelection(modelId: string): () => boolean {
  const identity = selectionIdentity(modelId);
  return () => isPrivateStorageWritable() && selectionIdentity(modelId) === identity;
}

export async function applyActiveModelLoadProfile(
  modelId: string, options: LoadModelOptions, selectionIsCurrent: () => boolean,
): Promise<void> {
  if (hasActiveChatGenerationWork()) throw new AppError('engine_busy', 'Wait for the response to finish.');
  let invalidated = !selectionIsCurrent();
  const check = () => { if (!selectionIsCurrent()) invalidated = true; };
  const assertCurrent = () => {
    check();
    if (invalidated) throw new AppError('engine_busy', 'The load settings change was cancelled because the model selection changed.');
  };
  const subscriptions = [useChatStore.subscribe(check), registry.subscribeModels(check), subscribeSettings(check)];
  try {
    assertCurrent();
    await runWithIdleModelDownloads(() => llmEngineService.applyLoadProfileTransaction(
      modelId, options, () => !invalidated && selectionIsCurrent(),
    ));
    // READY subscribers can synchronously switch away after the engine's last
    // ownership check. A fulfilled native promise is not a persistence receipt
    // for a selection that expired during that publication (including A-B-A).
    assertCurrent();
  } finally {
    subscriptions.forEach(unsubscribe => unsubscribe());
  }
}
