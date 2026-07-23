import {
  blockPrivateStorageAfterResetFailure,
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
import {
  resetActiveChatGenerationRuntimeForPrivateStorageReset,
  stopActiveChatGenerationForPrivateStorageBlocked,
} from '../hooks/useChatSession';
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
  resetActiveChatGenerationRuntimeForPrivateStorageReset();
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
    let attachmentCleanupFailed = false;
    try {
      await chatAttachmentStorageService.deleteAllAttachmentFilesForPrivateStorageReset();
    } catch (error) {
      console.warn('[PrivateStorageRecovery] Failed to clean chat attachments during private storage reset', {
        pathCategory: 'chat_attachment',
        context: 'private_storage_reset_attachment_cleanup',
        ...(error instanceof Error
          ? { errorName: error.name || 'Error' }
          : { errorType: typeof error }),
      });

      attachmentCleanupFailed = true;
    } finally {
      resetPrivatePersistedRuntimeStateForStorageReset();
      invalidatePrivateStorageRuntimeHandles();
      registry.invalidatePrivateStorageRuntimeState();
    }

    if (attachmentCleanupFailed) {
      return blockPrivateStorageAfterResetFailure();
    }
  }

  return storageHealth;
}
