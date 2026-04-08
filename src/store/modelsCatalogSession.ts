import type { HuggingFaceTokenStateChangeSource } from '../services/HuggingFaceTokenService';
import type { CatalogDiscoveryMode } from './modelsStore';
import type { ModelsCatalogTab } from './modelsCatalogTabs';

export function shouldWaitForCatalogTokenHydration(
  activeTab: ModelsCatalogTab,
  isTokenStateHydrated: boolean,
): boolean {
  return activeTab === 'all' && !isTokenStateHydrated;
}

export function shouldResetCatalogForTokenEvent(
  source: HuggingFaceTokenStateChangeSource,
): boolean {
  return source === 'mutation';
}

export function shouldBootstrapCatalogSession(
  activeTab: ModelsCatalogTab,
  discoveryMode: CatalogDiscoveryMode,
  isTokenStateHydrated: boolean = true,
): boolean {
  if (shouldWaitForCatalogTokenHydration(activeTab, isTokenStateHydrated)) {
    return false;
  }

  return activeTab !== 'all' || discoveryMode !== 'uninitialized';
}
