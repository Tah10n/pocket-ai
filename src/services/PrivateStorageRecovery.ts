import {
  resetPrivateAppStorageAfterConfirmation,
  type PrivateStorageHealthSnapshot,
} from './storage';
import { invalidateAppStorageForPrivateReset } from '../store/storage';
import { invalidateSettingsStorageForPrivateReset, resetSettingsRuntimeForPrivateStorageReset } from './SettingsStore';
import { invalidatePresetStorageForPrivateReset } from './PresetManager';
import { invalidateLastGoodProfileStorageForPrivateReset } from './InferenceLastGoodProfileStore';
import { invalidateAutotuneStorageForPrivateReset } from './InferenceAutotuneStore';
import { registry } from './LocalStorageRegistry';
import {
  resetModelDownloadManagerForPrivateStorageReset,
  stopModelDownloadManagerForPrivateStorageBlocked,
} from './ModelDownloadManager';
import { stopActiveChatGenerationForPrivateStorageBlocked } from '../hooks/useChatSession';
import { resetChatStoreForPrivateStorageReset } from '../store/chatStore';
import { resetDownloadStoreForPrivateStorageReset } from '../store/downloadStore';
import { resetModelsStoreForPrivateStorageReset } from '../store/modelsStore';
import { chatAttachmentStorageService } from './ChatAttachmentStorageService';

export function invalidatePrivateStorageRuntimeHandles(): void {
  invalidateAppStorageForPrivateReset();
  invalidateSettingsStorageForPrivateReset();
  invalidatePresetStorageForPrivateReset();
  invalidateLastGoodProfileStorageForPrivateReset();
  invalidateAutotuneStorageForPrivateReset();
  registry.invalidatePrivateStorageRuntimeHandle();
}

export function resetPrivatePersistedRuntimeStateForStorageReset(): void {
  resetChatStoreForPrivateStorageReset();
  resetDownloadStoreForPrivateStorageReset();
  resetModelsStoreForPrivateStorageReset();
  resetSettingsRuntimeForPrivateStorageReset();
}

export async function stopPrivateRuntimeWorkForStorageBlocked(): Promise<void> {
  await Promise.all([
    stopModelDownloadManagerForPrivateStorageBlocked(),
    stopActiveChatGenerationForPrivateStorageBlocked(),
  ]);
}

export async function resetPrivateAppStorageAndRuntimeStateAfterConfirmation(): Promise<PrivateStorageHealthSnapshot> {
  await Promise.all([
    resetModelDownloadManagerForPrivateStorageReset(),
    stopActiveChatGenerationForPrivateStorageBlocked(),
  ]);
  await registry.preserveExistingModelFilesForPrivateStorageReset();
  invalidatePrivateStorageRuntimeHandles();

  const storageHealth = await resetPrivateAppStorageAfterConfirmation();

  if (storageHealth.status !== 'blocked') {
    await chatAttachmentStorageService.deleteAllAttachmentFilesForPrivateStorageReset();
    resetPrivatePersistedRuntimeStateForStorageReset();
    invalidatePrivateStorageRuntimeHandles();
    registry.invalidatePrivateStorageRuntimeState();
  }

  return storageHealth;
}
