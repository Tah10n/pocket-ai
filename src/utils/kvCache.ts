import { DECIMAL_GIGABYTE } from './modelSize';
import type { ModelLoadParameters } from '../services/SettingsStore';

export type ResolvedKvCacheType = 'f16' | 'q8_0' | 'q4_0';

export function resolveKvCacheTypes({
  kvCacheType,
  requestedContextTokens,
  totalMemoryBytes,
  availableBudgetBytes,
}: {
  kvCacheType: ModelLoadParameters['kvCacheType'] | string | null | undefined;
  requestedContextTokens: number | null | undefined;
  totalMemoryBytes?: number | null;
  availableBudgetBytes?: number | null;
}): { cacheTypeK: ResolvedKvCacheType; cacheTypeV: ResolvedKvCacheType } {
  const normalizedPreference = typeof kvCacheType === 'string' ? kvCacheType.trim().toLowerCase() : 'auto';

  if (normalizedPreference === 'f16' || normalizedPreference === 'fp16') {
    return { cacheTypeK: 'f16', cacheTypeV: 'f16' };
  }

  if (normalizedPreference === 'q8_0' || normalizedPreference === 'q8') {
    return { cacheTypeK: 'q8_0', cacheTypeV: 'q8_0' };
  }

  if (normalizedPreference === 'q4_0' || normalizedPreference === 'q4') {
    return { cacheTypeK: 'q4_0', cacheTypeV: 'q4_0' };
  }

  const contextTokens = typeof requestedContextTokens === 'number' && Number.isFinite(requestedContextTokens) && requestedContextTokens > 0
    ? Math.round(requestedContextTokens)
    : 0;
  const normalizedAvailableBudgetBytes = typeof availableBudgetBytes === 'number'
    && Number.isFinite(availableBudgetBytes)
    && availableBudgetBytes >= 0
    ? availableBudgetBytes
    : null;

  if (normalizedAvailableBudgetBytes !== null) {
    if (normalizedAvailableBudgetBytes < 1.25 * DECIMAL_GIGABYTE) {
      return { cacheTypeK: 'q4_0', cacheTypeV: 'q4_0' };
    }

    if (normalizedAvailableBudgetBytes < 2.5 * DECIMAL_GIGABYTE) {
      return { cacheTypeK: 'q8_0', cacheTypeV: 'q8_0' };
    }
  }

  if (contextTokens >= 16384) {
    return { cacheTypeK: 'q4_0', cacheTypeV: 'q4_0' };
  }

  if (contextTokens >= 8192) {
    return { cacheTypeK: 'q8_0', cacheTypeV: 'q8_0' };
  }

  const totalGB = typeof totalMemoryBytes === 'number' && Number.isFinite(totalMemoryBytes) && totalMemoryBytes > 0
    ? totalMemoryBytes / DECIMAL_GIGABYTE
    : null;

  if (totalGB !== null && totalGB < 8) {
    return { cacheTypeK: 'q8_0', cacheTypeV: 'q8_0' };
  }

  return { cacheTypeK: 'f16', cacheTypeV: 'f16' };
}
