import type { ContextParams } from 'llama.rn';

export type PublicKvCacheType = NonNullable<ContextParams['cache_type_k']>;
export const PUBLIC_KV_CACHE_TYPES: readonly PublicKvCacheType[] = [
  'f16', 'f32', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1',
];

/** Local artifact references only; native paths are resolved under the engine's lease. */
export interface LoraProfileAdapter {
  artifactId: string;
  artifactIdentity: string;
  baseModelIdentity: string;
  scale: number;
  sizeBytes?: number;
}

export interface AdvancedLoadParameters {
  cacheTypeK?: PublicKvCacheType;
  cacheTypeV?: PublicKvCacheType;
  ropeFreqBase?: number;
  ropeFreqScale?: number;
  noExtraBufts?: boolean;
  swaFull?: boolean;
  nCpuMoe?: number;
  specDraftNMax?: number;
  specDraftNMin?: number;
  specDraftPMin?: number;
  specDraftPSplit?: number;
  specDraftNGpuLayers?: number;
  specDraftCacheTypeK?: PublicKvCacheType;
  specDraftCacheTypeV?: PublicKvCacheType;
  loraAdapters?: LoraProfileAdapter[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isPublicKvCacheType(value: unknown): value is PublicKvCacheType {
  return PUBLIC_KV_CACHE_TYPES.some(type => type === value);
}

function finiteRange(value: unknown, min: number, max: number, integer = false): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    && (!integer || Number.isSafeInteger(value)) ? value : undefined;
}

function identityText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 8192
    ? value : undefined;
}

/** Reject the entire list rather than silently applying a subset of a malformed selection. */
export function sanitizeLoraProfileAdapters(value: unknown): LoraProfileAdapter[] | undefined {
  if (!Array.isArray(value) || value.length > 8) return undefined;
  const result: LoraProfileAdapter[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    const artifactId = identityText(entry.artifactId);
    const artifactIdentity = identityText(entry.artifactIdentity);
    const baseModelIdentity = identityText(entry.baseModelIdentity);
    // Product bound, not a native model-compatibility guarantee. Zero is a valid disabled scale.
    const scale = finiteRange(entry.scale, -16, 16);
    const sizeBytes = finiteRange(entry.sizeBytes, 1, Number.MAX_SAFE_INTEGER, true);
    if (!artifactId || !artifactIdentity || !baseModelIdentity || scale === undefined || ids.has(artifactId)) return undefined;
    ids.add(artifactId);
    result.push({ artifactId, artifactIdentity, baseModelIdentity, scale, ...(sizeBytes !== undefined ? { sizeBytes } : {}) });
  }
  return result;
}

/** Bounded persisted settings. Absent fields retain the runtime's existing defaults. */
export function sanitizeAdvancedLoadParameters(value: unknown): AdvancedLoadParameters {
  if (!isRecord(value)) return {};
  const result: AdvancedLoadParameters = {};
  for (const key of ['cacheTypeK', 'cacheTypeV', 'specDraftCacheTypeK', 'specDraftCacheTypeV'] as const) {
    if (isPublicKvCacheType(value[key])) result[key] = value[key];
  }
  for (const key of ['noExtraBufts', 'swaFull'] as const) {
    if (typeof value[key] === 'boolean') result[key] = value[key];
  }
  for (const key of ['ropeFreqBase', 'ropeFreqScale'] as const) {
    const parsed = finiteRange(value[key], 0, key === 'ropeFreqBase' ? 1e9 : 1e6);
    if (parsed !== undefined) result[key] = parsed;
  }
  for (const key of ['nCpuMoe', 'specDraftNMax', 'specDraftNMin', 'specDraftNGpuLayers'] as const) {
    // Native draft GPU layers support -1 (all); the engine must still bound backend admission.
    const parsed = finiteRange(value[key], key === 'specDraftNGpuLayers' ? -1 : 0, key === 'nCpuMoe' || key === 'specDraftNGpuLayers' ? 4096 : 64, true);
    if (parsed !== undefined) result[key] = parsed;
  }
  for (const key of ['specDraftPMin', 'specDraftPSplit'] as const) {
    const parsed = finiteRange(value[key], 0, 1);
    if (parsed !== undefined) result[key] = parsed;
  }
  const adapters = sanitizeLoraProfileAdapters(value.loraAdapters);
  if (adapters !== undefined) result.loraAdapters = adapters;
  return result;
}

export function assertAdvancedLoadParameterCombinations(profile: AdvancedLoadParameters, mtpEnabled?: boolean): void {
  if (mtpEnabled && profile.specDraftNMax === 0) throw new Error('MTP requires a positive draft token limit');
  if (profile.specDraftNMin !== undefined && profile.specDraftNMax !== undefined
    && profile.specDraftNMin > profile.specDraftNMax) throw new Error('Draft minimum exceeds draft maximum');
}

/** Stable order, including adapter order/scales and absence vs explicit false/zero/empty. Private storage only. */
export function getAdvancedLoadProfileIdentity(value: unknown): string {
  return JSON.stringify(sanitizeAdvancedLoadParameters(value));
}

export function getOptionalAdvancedLoadProfileIdentity(value: unknown): string | undefined {
  const identity = getAdvancedLoadProfileIdentity(value);
  return identity === '{}' ? undefined : identity;
}

/** Preserve legacy identity when no advanced allocation was requested. */
export function getEffectiveAdvancedLoadProfileIdentity(requested: unknown, effective: unknown): string | undefined {
  const selected = sanitizeAdvancedLoadParameters(requested);
  const applied = sanitizeAdvancedLoadParameters(effective);
  const projected: Record<string, unknown> = {};
  for (const key of Object.keys(selected) as (keyof AdvancedLoadParameters)[]) projected[key] = applied[key];
  // A forced allocation change is evidence even when the legacy request omitted it.
  // The ordinary legacy false/default path keeps its original absent identity.
  if (selected.noExtraBufts === undefined && applied.noExtraBufts === true) projected.noExtraBufts = true;
  return getOptionalAdvancedLoadProfileIdentity(projected);
}

export function getAdvancedLoadDiagnostics(value: unknown): Omit<AdvancedLoadParameters, 'loraAdapters'> & {
  loraAdapterCount?: number; loraScales?: number[];
} {
  const { loraAdapters, ...scalars } = sanitizeAdvancedLoadParameters(value);
  return { ...scalars, ...(loraAdapters !== undefined
    ? { loraAdapterCount: loraAdapters.length, loraScales: loraAdapters.map(adapter => adapter.scale) } : {}) };
}

/** Unknown selected adapter bytes cannot be admitted as zero, even for a zero scale. */
export function getLoraAdapterMemoryBytes(adapters: readonly LoraProfileAdapter[] | undefined): number | null {
  let total = 0;
  for (const adapter of adapters ?? []) {
    if (finiteRange(adapter.sizeBytes, 1, Number.MAX_SAFE_INTEGER, true) === undefined) return null;
    total += adapter.sizeBytes!;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

/** Scalar declarations only. LoRA and draft paths are never accepted from settings. */
export function buildAdvancedNativeLoadParams(profile: AdvancedLoadParameters): Pick<ContextParams,
  'rope_freq_base' | 'rope_freq_scale' | 'no_extra_bufts' | 'swa_full' | 'n_cpu_moe'
  | 'spec_draft_n_max' | 'spec_draft_n_min' | 'spec_draft_p_min' | 'spec_draft_p_split'
  | 'spec_draft_n_gpu_layers' | 'spec_draft_cache_type_k' | 'spec_draft_cache_type_v'> {
  const p = sanitizeAdvancedLoadParameters(profile);
  assertAdvancedLoadParameterCombinations(p);
  return {
    ...(p.ropeFreqBase !== undefined ? { rope_freq_base: p.ropeFreqBase } : {}),
    ...(p.ropeFreqScale !== undefined ? { rope_freq_scale: p.ropeFreqScale } : {}),
    ...(p.noExtraBufts !== undefined ? { no_extra_bufts: p.noExtraBufts } : {}),
    ...(p.swaFull !== undefined ? { swa_full: p.swaFull } : {}),
    ...(p.nCpuMoe !== undefined ? { n_cpu_moe: p.nCpuMoe } : {}),
    ...(p.specDraftNMax !== undefined ? { spec_draft_n_max: p.specDraftNMax } : {}),
    ...(p.specDraftNMin !== undefined ? { spec_draft_n_min: p.specDraftNMin } : {}),
    ...(p.specDraftPMin !== undefined ? { spec_draft_p_min: p.specDraftPMin } : {}),
    ...(p.specDraftPSplit !== undefined ? { spec_draft_p_split: p.specDraftPSplit } : {}),
    ...(p.specDraftNGpuLayers !== undefined ? { spec_draft_n_gpu_layers: p.specDraftNGpuLayers } : {}),
    ...(p.specDraftCacheTypeK !== undefined ? { spec_draft_cache_type_k: p.specDraftCacheTypeK } : {}),
    ...(p.specDraftCacheTypeV !== undefined ? { spec_draft_cache_type_v: p.specDraftCacheTypeV } : {}),
  };
}
