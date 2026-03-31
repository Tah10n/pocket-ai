export const MODEL_CATALOG_TABS = ['all', 'downloaded'] as const;

export type ModelsCatalogTab = (typeof MODEL_CATALOG_TABS)[number];

export function resolveModelsCatalogTab(initialTab?: string): ModelsCatalogTab {
  return initialTab === 'downloaded' ? 'downloaded' : 'all';
}
