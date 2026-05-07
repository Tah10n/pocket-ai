import {
  resetPrivateAppStorageAfterConfirmation,
  type PrivateStorageHealthSnapshot,
} from './storage';
import { invalidateAppStorageForPrivateReset } from '../store/storage';
import { invalidateSettingsStorageForPrivateReset } from './SettingsStore';
import { invalidatePresetStorageForPrivateReset } from './PresetManager';
import { invalidateLastGoodProfileStorageForPrivateReset } from './InferenceLastGoodProfileStore';
import { invalidateAutotuneStorageForPrivateReset } from './InferenceAutotuneStore';
import { registry } from './LocalStorageRegistry';
import { resetModelDownloadManagerForPrivateStorageReset } from './ModelDownloadManager';
import { resetChatStoreForPrivateStorageReset } from '../store/chatStore';
import { resetDownloadStoreForPrivateStorageReset } from '../store/downloadStore';
import { resetModelsStoreForPrivateStorageReset } from '../store/modelsStore';

export function invalidatePrivateStorageRuntimeHandles(): void {
  invalidateAppStorageForPrivateReset();
  invalidateSettingsStorageForPrivateReset();
  invalidatePresetStorageForPrivateReset();
  invalidateLastGoodProfileStorageForPrivateReset();
  invalidateAutotuneStorageForPrivateReset();
  registry.invalidatePrivateStorageRuntimeState();
}

export function resetPrivatePersistedRuntimeStateForStorageReset(): void {
  resetChatStoreForPrivateStorageReset();
  resetDownloadStoreForPrivateStorageReset();
  resetModelsStoreForPrivateStorageReset();
}

export async function resetPrivateAppStorageAndRuntimeStateAfterConfirmation(): Promise<PrivateStorageHealthSnapshot> {
  await resetModelDownloadManagerForPrivateStorageReset();
  invalidatePrivateStorageRuntimeHandles();

  const storageHealth = await resetPrivateAppStorageAfterConfirmation();

  resetPrivatePersistedRuntimeStateForStorageReset();
  invalidatePrivateStorageRuntimeHandles();

  return storageHealth;
}
