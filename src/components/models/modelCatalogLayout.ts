export const modelCatalogFloatingChrome = {
  topGap: 8,
  searchHeight: 48,
  rowGap: 6,
  tabsHeight: 40,
  controlsToFilterGap: 6,
  filterHeight: 36,
  filterToContentGap: 8,
} as const;

export const MODEL_CATALOG_FILTER_TOP_OFFSET =
  modelCatalogFloatingChrome.topGap
  + modelCatalogFloatingChrome.searchHeight
  + modelCatalogFloatingChrome.rowGap
  + modelCatalogFloatingChrome.tabsHeight
  + modelCatalogFloatingChrome.controlsToFilterGap;

export const MODEL_CATALOG_LIST_TOP_OFFSET =
  MODEL_CATALOG_FILTER_TOP_OFFSET
  + modelCatalogFloatingChrome.filterHeight
  + modelCatalogFloatingChrome.filterToContentGap;
