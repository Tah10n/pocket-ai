import type { CatalogDiscoveryMode } from '@/store/modelsStore';
import type { HuggingFaceTokenStateChangeSource } from '@/services/HuggingFaceTokenService';

export function shouldWaitForCatalogTokenHydration(
  activeTab: 'All Models' | 'Downloaded',
  isTokenStateHydrated: boolean,
): boolean {
  return activeTab === 'All Models' && !isTokenStateHydrated;
}

export function shouldResetCatalogForTokenEvent(
  source: HuggingFaceTokenStateChangeSource,
): boolean {
  return source === 'mutation';
}

export function shouldBootstrapCatalogSession(
  activeTab: 'All Models' | 'Downloaded',
  discoveryMode: CatalogDiscoveryMode,
  isTokenStateHydrated: boolean = true,
): boolean {
  if (shouldWaitForCatalogTokenHydration(activeTab, isTokenStateHydrated)) {
    return false;
  }

  return activeTab !== 'All Models' || discoveryMode !== 'uninitialized';
}
