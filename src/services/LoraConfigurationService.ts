import { getThreadActiveModelId } from '../types/chat';
import { useChatStore } from '../store/chatStore';
import { getCompanionBindingIdentity, getCompanionSourceIdentity } from '../utils/modelArtifacts';
import type { LoraProfileAdapter } from '../utils/advancedLoadProfile';
import { getAdvancedLoadProfileIdentity } from '../utils/advancedLoadProfile';
import { AppError } from './AppError';
import { hasActiveChatGenerationWork } from './ChatGenerationService';
import { registry } from './LocalStorageRegistry';
import { llmEngineService } from './LLMEngineService';
import { runWithIdleModelDownloads } from './ModelDownloadManager';
import { getModelLoadParametersForModel, getSettings, subscribeSettings, updateModelLoadParametersForModel } from './SettingsStore';
import { assertPrivateStorageWritable, isPrivateStorageWritable } from './storage';

export interface LoraSelection { artifactId: string; scale: number }

/** Resolve managed artifact IDs only. Native paths never come from an editor. */
export function buildLoraProfile(modelId: string, selection: readonly LoraSelection[]): LoraProfileAdapter[] {
  const model = registry.getModel(modelId);
  if (!model || selection.length > 8) throw new AppError('model_incompatible', 'Invalid adapter selection.');
  const baseModelIdentity = getCompanionBindingIdentity(model);
  const seen = new Set<string>();
  return selection.map(({ artifactId, scale }) => {
    const artifact = model.artifacts?.find(entry => entry.id === artifactId);
    if (!artifact || artifact.kind !== 'lora_adapter' || artifact.boundToModelIdentity !== baseModelIdentity
      || artifact.installState !== 'installed' || !artifact.localPath || !artifact.sizeBytes
      || !Number.isFinite(scale) || scale < -16 || scale > 16 || seen.has(artifactId)) {
      throw new AppError('model_incompatible', 'Prepare compatible adapters for this model variant first.');
    }
    seen.add(artifactId);
    return { artifactId, artifactIdentity: getCompanionSourceIdentity(artifact), baseModelIdentity,
      scale, sizeBytes: artifact.sizeBytes };
  });
}

function selectionIdentity(modelId: string): string {
  const model = registry.getModel(modelId);
  const state = useChatStore.getState();
  const thread = state.activeThreadId ? state.threads[state.activeThreadId] : undefined;
  return JSON.stringify([
    state.activeThreadId, thread ? getThreadActiveModelId(thread) : null, getSettings().activeModelId,
    model ? getCompanionBindingIdentity(model) : null,
    model?.localPath,
    model?.artifacts?.filter(artifact => artifact.kind === 'lora_adapter').map(artifact => [
      artifact.id, getCompanionSourceIdentity(artifact), artifact.localPath, artifact.installState,
      artifact.boundToModelIdentity, artifact.selected,
    ]),
    getAdvancedLoadProfileIdentity(getModelLoadParametersForModel(modelId)),
  ]);
}

/** Persist only a native-confirmed configuration while its original chat/file selection still owns it. */
export async function applyModelLoraAdapters(
  modelId: string,
  selection: readonly LoraSelection[],
  signal?: AbortSignal,
): Promise<LoraProfileAdapter[]> {
  assertPrivateStorageWritable();
  if (hasActiveChatGenerationWork()) throw new AppError('engine_busy', 'Wait for the response to finish.');
  const profile = buildLoraProfile(modelId, selection);
  const originalThreadId = useChatStore.getState().activeThreadId;
  const identity = selectionIdentity(modelId);
  let invalidated = false;
  const check = () => {
    if (!isPrivateStorageWritable() || selectionIdentity(modelId) !== identity) invalidated = true;
  };
  const subscriptions = [subscribeSettings(check), useChatStore.subscribe(check), registry.subscribeModels(check)];
  const isCurrent = () => !invalidated && isPrivateStorageWritable() && selectionIdentity(modelId) === identity;
  try {
    const applied = await runWithIdleModelDownloads(() => llmEngineService.applyLoraConfiguration(
      modelId, profile, { signal, isCurrent },
    ));
    if (signal?.aborted || !isCurrent()) throw new AppError('action_failed', 'The adapter selection changed.');
    updateModelLoadParametersForModel(modelId, { loraAdapters: applied });
    const state = useChatStore.getState();
    if (originalThreadId && state.activeThreadId === originalThreadId
      && state.threads[originalThreadId] && getThreadActiveModelId(state.threads[originalThreadId]) === modelId) {
      state.updateThreadLoraSnapshot(originalThreadId, applied);
    }
    return applied;
  } catch (error) {
    // Native LoRA loader errors include private file paths. Never forward their text/cause.
    if (error instanceof AppError) throw error;
    throw new AppError('model_incompatible', 'The adapters could not be applied.');
  } finally {
    subscriptions.forEach(unsubscribe => unsubscribe());
  }
}
