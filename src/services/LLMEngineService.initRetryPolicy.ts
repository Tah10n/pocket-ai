import type {
  EngineModelInitFailureCategory,
} from '../types/models';

export const MAX_MODEL_INIT_PROFILE_CANDIDATES = 8;
export const MAX_MODEL_INIT_ACCELERATOR_ATTEMPTS = 12;
export const MAX_MODEL_INIT_LAYER_RETRY_CANDIDATES = 4;

export type ModelInitCandidateIdentity = {
  backendMode: 'cpu' | 'gpu' | 'npu';
  devices?: string[];
  nGpuLayers: number;
  nThreads?: number;
  cpuMask?: string;
  cpuStrict?: boolean;
  flashAttnType: 'auto' | 'on' | 'off';
  useMmap: boolean;
  useMlock: boolean;
  nBatch?: number;
  nUbatch?: number;
  kvUnified?: boolean;
  nParallel: number;
};

export type ModelInitAttemptIdentity = ModelInitCandidateIdentity & {
  contextSize: number;
  cacheTypeK: string;
  cacheTypeV: string;
  speculativeEnabled: boolean;
};

export type ModelInitAttemptDecision =
  | 'started'
  | 'duplicate'
  | 'known_oom_upper_bound'
  | 'attempt_limit';

function normalizeInteger(value: number | undefined, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : fallback;
}

function normalizeOptionalInteger(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : null;
}

function normalizeDevices(devices: string[] | undefined): string[] {
  if (!Array.isArray(devices)) {
    return [];
  }

  return devices
    .filter((device): device is string => typeof device === 'string')
    .map((device) => device.trim())
    .filter((device) => device.length > 0);
}

function buildCandidateKeyPayload(identity: ModelInitCandidateIdentity) {
  return {
    backendMode: identity.backendMode,
    devices: normalizeDevices(identity.devices),
    nGpuLayers: normalizeInteger(identity.nGpuLayers),
    nThreads: normalizeOptionalInteger(identity.nThreads),
    cpuMask: typeof identity.cpuMask === 'string' ? identity.cpuMask.trim() : '',
    cpuStrict: typeof identity.cpuStrict === 'boolean' ? identity.cpuStrict : null,
    flashAttnType: identity.flashAttnType,
    useMmap: identity.useMmap === true,
    useMlock: identity.useMlock === true,
    nBatch: normalizeOptionalInteger(identity.nBatch),
    nUbatch: normalizeOptionalInteger(identity.nUbatch),
    kvUnified: typeof identity.kvUnified === 'boolean' ? identity.kvUnified : null,
    nParallel: Math.max(1, normalizeInteger(identity.nParallel, 1)),
  };
}

export function buildModelInitCandidateKey(identity: ModelInitCandidateIdentity): string {
  return JSON.stringify(buildCandidateKeyPayload(identity));
}

export function buildModelInitAttemptKey(identity: ModelInitAttemptIdentity): string {
  return JSON.stringify({
    ...buildCandidateKeyPayload(identity),
    contextSize: Math.max(1, normalizeInteger(identity.contextSize, 1)),
    cacheTypeK: identity.cacheTypeK.trim().toLowerCase(),
    cacheTypeV: identity.cacheTypeV.trim().toLowerCase(),
    speculativeEnabled: identity.speculativeEnabled === true,
  });
}

function buildModelInitMemoryProfileKey(identity: ModelInitAttemptIdentity): string {
  const candidate = buildCandidateKeyPayload(identity);
  return JSON.stringify({
    ...candidate,
    nGpuLayers: undefined,
    contextSize: Math.max(1, normalizeInteger(identity.contextSize, 1)),
    cacheTypeK: identity.cacheTypeK.trim().toLowerCase(),
    cacheTypeV: identity.cacheTypeV.trim().toLowerCase(),
    speculativeEnabled: identity.speculativeEnabled === true,
  });
}

export function dedupeAndBoundModelInitProfiles<T extends ModelInitCandidateIdentity>(
  profiles: T[],
  maxCandidates = MAX_MODEL_INIT_PROFILE_CANDIDATES,
): T[] {
  const normalizedLimit = Math.max(1, Math.round(maxCandidates));
  const seen = new Set<string>();
  const unique = profiles.filter((profile) => {
    const key = buildModelInitCandidateKey(profile);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });

  if (unique.length <= normalizedLimit) {
    return unique;
  }

  const cpuFallback = unique.find((profile) => profile.backendMode === 'cpu');
  const acceleratorLimit = Math.max(0, normalizedLimit - (cpuFallback ? 1 : 0));
  const bounded = unique
    .filter((profile) => profile.backendMode !== 'cpu')
    .slice(0, acceleratorLimit);
  if (cpuFallback) {
    bounded.push(cpuFallback);
  }
  return bounded;
}

export function buildModelInitLayerRetryCandidates(
  initialGpuLayers: number,
): number[] {
  const normalizedLayers = normalizeInteger(initialGpuLayers);
  if (normalizedLayers <= 1) {
    return [];
  }

  return Array.from(new Set([
    Math.floor(normalizedLayers * 0.75),
    Math.floor(normalizedLayers / 2),
    Math.floor(normalizedLayers / 4),
    1,
  ]))
    .filter((candidateLayers) => candidateLayers > 0 && candidateLayers < normalizedLayers)
    .sort((left, right) => right - left)
    .slice(0, MAX_MODEL_INIT_LAYER_RETRY_CANDIDATES);
}

export class ModelInitAttemptGuard {
  private readonly attemptedKeys = new Set<string>();
  private readonly knownOomUpperBounds = new Map<string, number>();
  private acceleratorAttemptCount = 0;

  constructor(
    private readonly maxAcceleratorAttempts = MAX_MODEL_INIT_ACCELERATOR_ATTEMPTS,
  ) {}

  tryStart(
    identity: ModelInitAttemptIdentity,
    options: { allowBeyondLimit?: boolean } = {},
  ): ModelInitAttemptDecision {
    const attemptKey = buildModelInitAttemptKey(identity);
    if (this.attemptedKeys.has(attemptKey)) {
      return 'duplicate';
    }

    const normalizedLayers = normalizeInteger(identity.nGpuLayers);
    if (normalizedLayers > 0) {
      const knownUpperBound = this.knownOomUpperBounds.get(buildModelInitMemoryProfileKey(identity));
      if (knownUpperBound !== undefined && normalizedLayers >= knownUpperBound) {
        return 'known_oom_upper_bound';
      }

      if (
        options.allowBeyondLimit !== true
        && this.acceleratorAttemptCount >= Math.max(1, Math.round(this.maxAcceleratorAttempts))
      ) {
        return 'attempt_limit';
      }
    }

    this.attemptedKeys.add(attemptKey);
    if (normalizedLayers > 0) {
      this.acceleratorAttemptCount += 1;
    }
    return 'started';
  }

  recordProbableOom(identity: ModelInitAttemptIdentity): void {
    const normalizedLayers = normalizeInteger(identity.nGpuLayers);
    if (normalizedLayers <= 0) {
      return;
    }

    const memoryProfileKey = buildModelInitMemoryProfileKey(identity);
    const currentUpperBound = this.knownOomUpperBounds.get(memoryProfileKey);
    this.knownOomUpperBounds.set(
      memoryProfileKey,
      currentUpperBound === undefined
        ? normalizedLayers
        : Math.min(currentUpperBound, normalizedLayers),
    );
  }

  getKnownOomUpperBound(identity: ModelInitAttemptIdentity): number | null {
    return this.knownOomUpperBounds.get(buildModelInitMemoryProfileKey(identity)) ?? null;
  }
}

function getErrorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message.toLowerCase();
  }
  if (typeof error === 'string') {
    return error.toLowerCase();
  }
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' ? message.toLowerCase() : '';
  }
  return '';
}

export function classifyModelInitFailure(
  error: unknown,
  probableOom: boolean,
): EngineModelInitFailureCategory {
  if (probableOom) {
    return 'out_of_memory';
  }

  const text = getErrorText(error);
  if (/cancel|abort|interrupt/.test(text)) {
    return 'cancelled';
  }
  if (/unavailable|unsupported|no gpu|no npu|no device|backend.+disabled/.test(text)) {
    return 'backend_unavailable';
  }
  if (/invalid|configuration|argument|flash attention|cache type/.test(text)) {
    return 'invalid_configuration';
  }
  if (/incompatible|mmproj|clip projector/.test(text)) {
    return 'model_incompatible';
  }
  return 'native_error';
}
