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
  runWithIdleModelDownloads,
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
import { documentSessionContextCache } from './DocumentSessionContextCache';
import { llmEngineService } from './LLMEngineService';
import { documentIndexStore } from './DocumentIndexStore';
import { stopDocumentRetrievalPreparation } from './DocumentRetrievalPreparation';
import { clearDocumentRetrievalStatus } from './DocumentRetrievalStatus';
import { ttsService } from './TtsService';
import { referenceVoiceStore } from './ReferenceVoiceStore';
import { audioRecordingService } from './AudioRecordingService';
import { audioSamplePreviewService } from './AudioSamplePreviewService';
import { cleanupPreparedAudioAfterDrain } from './AudioPreparationService';

export function invalidatePrivateStorageRuntimeHandles(): void {
  referenceVoiceStore.invalidate();
  documentIndexStore.invalidate();
  clearDocumentRetrievalStatus();
  invalidateAppStorageForPrivateReset();
  invalidateSettingsStorageForPrivateReset();
  invalidatePresetStorageForPrivateReset();
  invalidateLastGoodProfileStorageForPrivateReset();
  invalidateAutotuneStorageForPrivateReset();
  registry.invalidatePrivateStorageRuntimeHandle();
}

export function resetPrivatePersistedRuntimeStateForStorageReset(): void {
  referenceVoiceStore.resetRuntime();
  resetActiveChatGenerationRuntimeForPrivateStorageReset();
  resetChatStoreForPrivateStorageReset();
  resetDownloadStoreForPrivateStorageReset();
  resetModelsStoreForPrivateStorageReset();
  resetSettingsRuntimeForPrivateStorageReset();
}

export async function stopPrivateRuntimeWorkForStorageBlocked(): Promise<void> {
  referenceVoiceStore.invalidate();
  documentIndexStore.invalidate();
  llmEngineService.invalidateAuxiliaryContextOperation();
  await referenceVoiceStore.drainForPrivateReset(Promise.all([
    ttsService.cancelAndClear(),
    audioRecordingService.cancelAndClear(),
    audioSamplePreviewService.stop(),
    stopDocumentRetrievalPreparation(),
    stopModelDownloadManagerForPrivateStorageBlocked(),
    stopActiveChatGenerationForPrivateStorageBlocked(),
  ]));
  await documentSessionContextCache.clearAll();
  await cleanupPreparedAudioAfterDrain();
  await referenceVoiceStore.cleanupCold();
}

export async function resetPrivateAppStorageAndRuntimeStateAfterConfirmation(): Promise<PrivateStorageHealthSnapshot> {
  referenceVoiceStore.invalidate();
  documentIndexStore.invalidate();
  llmEngineService.invalidateAuxiliaryContextOperation();
  const consumersDrained = Promise.all([
    ttsService.cancelAndClear(),
    audioRecordingService.cancelAndClear(),
    audioSamplePreviewService.stop(),
    stopDocumentRetrievalPreparation(),
    resetModelDownloadManagerForPrivateStorageReset(),
    stopActiveChatGenerationForPrivateStorageBlocked(),
  ]);
  await consumersDrained;
  try {
    await referenceVoiceStore.drainForPrivateReset(consumersDrained);
    await documentSessionContextCache.clearAll();
    await cleanupPreparedAudioAfterDrain();
    await referenceVoiceStore.cleanupCold();
  } catch {
    // Do not reopen private storage while a sensitive plaintext sample may remain.
    return blockPrivateStorageAfterResetFailure();
  }
  await llmEngineService.unload();
  return runWithIdleModelDownloads(() => llmEngineService.runWithIdleModelResources(async () => {
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
  }));
}
