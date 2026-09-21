import * as FileSystem from 'expo-file-system/legacy';
import * as RNFS from 'react-native-fs';
import { LifecycleStatus, type ModelMetadata } from '../types/models';
import { getThreadActiveModelId } from '../types/chat';
import { useChatStore } from '../store/chatStore';
import { getModelFileIdentity, getModelRoleEvidence } from '../utils/modelRoles';
import { fileUriToNativePath, safeJoinModelPath } from '../utils/safeFilePath';
import { validateGgufFileHeader } from '../utils/ggufValidation';
import { normalizeSha256Digest } from '../utils/sha256';
import { resolveConservativeAvailableMemoryBudget } from '../memory/budget';
import { registry } from './LocalStorageRegistry';
import { llmEngineService } from './LLMEngineService';
import { getModelsDir } from './FileSystemSetup';
import { getSystemMemorySnapshot } from './SystemMetricsService';
import { assertPrivateStorageWritable, isPrivateStorageWritable } from './storage';
import {
  getSettings, subscribeSettings, updateSettings,
  type AuxiliaryModelRole,
} from './SettingsStore';

export type AuxiliaryCheckCode = 'selection_missing' | 'selection_changed' | 'role_unknown'
  | 'files_missing' | 'integrity_failed' | 'memory_unknown' | 'memory_insufficient'
  | 'busy' | 'cancelled' | 'native_failed' | 'restore_failed';

export class AuxiliaryModelError extends Error {
  constructor(readonly code: AuxiliaryCheckCode) { super(code); this.name = 'AuxiliaryModelError'; }
}

export function selectAuxiliaryModel(role: AuxiliaryModelRole, model: ModelMetadata | null): void {
  assertPrivateStorageWritable();
  const auxiliaryModels = { ...getSettings().auxiliaryModels };
  if (!model) delete auxiliaryModels[role];
  else {
    if (!getModelRoleEvidence(model).some((evidence) => evidence.role === role)) {
      throw new AuxiliaryModelError('role_unknown');
    }
    // The catalog selection is persisted without changing chat settings or loading a context.
    const persisted = registry.getModel(model.id);
    if (persisted && getModelFileIdentity(persisted) !== getModelFileIdentity(model)) {
      throw new AuxiliaryModelError('selection_changed');
    }
    if (!persisted) registry.updateModel(model);
    auxiliaryModels[role] = { modelId: model.id, fileIdentity: getModelFileIdentity(persisted ?? model) };
  }
  updateSettings({ auxiliaryModels });
}

export function getAuxiliarySelection(role: AuxiliaryModelRole): ModelMetadata | undefined {
  const binding = getSettings().auxiliaryModels?.[role];
  const model = binding ? registry.getModel(binding.modelId) : undefined;
  return model && getModelFileIdentity(model) === binding?.fileIdentity ? model : undefined;
}

// Small CPU embedding/rank checks use a bounded context and explicit workspace reserve.
// This is a conservative, low-confidence admission policy, not a chat-profile estimate.
export function estimateAuxiliaryCheckBytes(model: ModelMetadata, role: AuxiliaryModelRole): number | null {
  if (role === 'tts' || !model.size || model.size <= 0 || model.size > 512 * 1024 * 1024) return null;
  return Math.ceil(model.size * 2 + 256 * 1024 * 1024);
}

async function validateAuxiliaryFile(model: ModelMetadata): Promise<string> {
  const modelsDir = getModelsDir();
  const uri = modelsDir && model.localPath ? safeJoinModelPath(modelsDir, model.localPath) : null;
  if (!uri || ![LifecycleStatus.DOWNLOADED, LifecycleStatus.ACTIVE].includes(model.lifecycleStatus)) {
    throw new AuxiliaryModelError('files_missing');
  }
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists || info.isDirectory || !model.size || info.size !== model.size) {
      throw new AuxiliaryModelError('integrity_failed');
    }
    await validateGgufFileHeader(uri, info);
    const expectedHash = normalizeSha256Digest(model.sha256);
    if (expectedHash && normalizeSha256Digest(await RNFS.hash(fileUriToNativePath(uri), 'sha256')) !== expectedHash) {
      throw new AuxiliaryModelError('integrity_failed');
    }
    return fileUriToNativePath(uri);
  } catch (error) {
    if (error instanceof AuxiliaryModelError) throw error;
    throw new AuxiliaryModelError('integrity_failed');
  }
}

function selectionSnapshot(): string {
  const state = useChatStore.getState();
  const thread = state.activeThreadId ? state.threads[state.activeThreadId] : undefined;
  const settings = getSettings();
  return JSON.stringify([state.activeThreadId, thread ? getThreadActiveModelId(thread) : null,
    settings.activeModelId, settings.modelLoadParamsByModelId, settings.modelParamsByModelId, settings.auxiliaryModels]);
}

export async function checkAuxiliaryModel(
  role: AuxiliaryModelRole,
  options: { signal?: AbortSignal; verifyEmbedding?: boolean } = {},
): Promise<{ operation: 'load' | 'embedding'; dimensions?: number; memoryConfidence: 'low' }> {
  assertPrivateStorageWritable();
  if (llmEngineService.hasAuxiliaryContextOperation()) throw new AuxiliaryModelError('busy');
  const model = getAuxiliarySelection(role);
  if (!model) throw new AuxiliaryModelError('selection_missing');
  if (!getModelRoleEvidence(model).some((entry) => entry.role === role)) throw new AuxiliaryModelError('role_unknown');
  const requiredBytes = estimateAuxiliaryCheckBytes(model, role);
  if (requiredBytes === null) throw new AuxiliaryModelError('memory_unknown');
  const identity = getModelFileIdentity(model);
  const initialSelection = selectionSnapshot();
  const previousModelId = llmEngineService.getState().activeModelId;
  const previousModel = previousModelId ? registry.getModel(previousModelId) : undefined;
  const previousIdentity = previousModel ? getModelFileIdentity(previousModel) : undefined;
  let invalidated = false;
  const checkSelection = () => {
    if (!isPrivateStorageWritable() || selectionSnapshot() !== initialSelection) invalidated = true;
  };
  const unsubscribers = [subscribeSettings(checkSelection), useChatStore.subscribe(checkSelection),
    registry.subscribeModels(() => {
      const current = registry.getModel(model.id);
      if (!current || getModelFileIdentity(current) !== identity || current.localPath !== model.localPath) invalidated = true;
      if (previousModel) {
        const currentPrevious = registry.getModel(previousModel.id);
        if (!currentPrevious || getModelFileIdentity(currentPrevious) !== previousIdentity
          || currentPrevious.localPath !== previousModel.localPath) invalidated = true;
      }
    })];
  const isCurrent = () => !invalidated && isPrivateStorageWritable();
  try {
    const path = await validateAuxiliaryFile(model);
    if (!isCurrent()) throw new AuxiliaryModelError('selection_changed');
    const result = await llmEngineService.runWithAuxiliaryContext({
      modelId: model.id,
      signal: options.signal,
      isCurrent,
      initParams: {
        model: path, n_ctx: 512, n_batch: 512, n_ubatch: 512, n_gpu_layers: 0,
        embedding: true, ...(role === 'reranker' ? { pooling_type: 'rank' as const } : {}),
        n_parallel: 1, use_mmap: true, use_mlock: false,
        state_cache_budget_mb: 0, state_cache_max_checkpoints: 8,
      },
      beforeInit: async () => {
        if (!isCurrent()) throw new AuxiliaryModelError('selection_changed');
        await validateAuxiliaryFile(model);
        const snapshot = await getSystemMemorySnapshot();
        const budget = snapshot ? resolveConservativeAvailableMemoryBudget(snapshot, { strictFreeCap: true }) : null;
        if (budget === null) throw new AuxiliaryModelError('memory_unknown');
        if (snapshot?.lowMemory || budget < requiredBytes) throw new AuxiliaryModelError('memory_insufficient');
      },
    }, async (context) => {
      if (options.verifyEmbedding && role === 'embedding') {
        const { embedding } = await context.embedding('Resource compatibility check.');
        if (!embedding.length || embedding.some((value) => !Number.isFinite(value))
          || (context.model.nEmbd > 0 && embedding.length !== context.model.nEmbd)) {
          throw new AuxiliaryModelError('native_failed');
        }
        return { operation: 'embedding' as const, dimensions: embedding.length, memoryConfidence: 'low' as const };
      }
      return { operation: 'load' as const, memoryConfidence: 'low' as const };
    });
    if (!isCurrent() || options.signal?.aborted) throw new AuxiliaryModelError(options.signal?.aborted ? 'cancelled' : 'selection_changed');
    const current = registry.getModel(model.id);
    if (current && getModelFileIdentity(current) === identity) {
      registry.updateModel({ ...current, roleValidation: [
        ...(current.roleValidation ?? []).filter((entry) => entry.role !== role),
        { role, fileIdentity: identity, runtimeVersion: '0.13.0-rc.3', checkedAt: Date.now(),
          operation: result.operation, status: 'passed' },
      ] });
    }
    return result;
  } catch (error) {
    if (error instanceof AuxiliaryModelError) throw error;
    if (options.signal?.aborted) throw new AuxiliaryModelError('cancelled');
    if (llmEngineService.getState().auxiliaryRestoreError) throw new AuxiliaryModelError('restore_failed');
    // Native diagnostics can contain paths or input; expose only a bounded error category.
    const code = (error as { code?: string })?.code;
    throw new AuxiliaryModelError(code === 'engine_busy' ? 'busy' : 'native_failed');
  } finally {
    unsubscribers.forEach((unsubscribe) => unsubscribe());
  }
}
