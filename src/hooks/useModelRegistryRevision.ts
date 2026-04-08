import { useSyncExternalStore } from 'react';
import { registry } from '@/services/LocalStorageRegistry';

const subscribeToModelRegistry = (listener: () => void) => registry.subscribeModels(listener);
const getModelRegistrySnapshot = () => registry.getModelsRevision();

export function useModelRegistryRevision(): number {
  return useSyncExternalStore(
    subscribeToModelRegistry,
    getModelRegistrySnapshot,
    getModelRegistrySnapshot,
  );
}
