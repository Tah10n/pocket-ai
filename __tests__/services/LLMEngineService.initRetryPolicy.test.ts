import {
  buildModelInitLayerRetryCandidates,
  classifyModelInitFailure,
  dedupeAndBoundModelInitProfiles,
  MAX_MODEL_INIT_ACCELERATOR_ATTEMPTS,
  MAX_MODEL_INIT_TOTAL_ATTEMPTS,
  ModelInitAttemptGuard,
  type ModelInitAttemptIdentity,
} from '../../src/services/LLMEngineService.initRetryPolicy';

const baseCandidate = {
  backendMode: 'gpu' as const,
  nGpuLayers: 12,
  flashAttnType: 'auto' as const,
  useMmap: true,
  useMlock: false,
  nParallel: 1,
};

function createAttempt(overrides: Partial<ModelInitAttemptIdentity> = {}): ModelInitAttemptIdentity {
  return {
    ...baseCandidate,
    contextSize: 4096,
    cacheTypeK: 'f16',
    cacheTypeV: 'f16',
    speculativeEnabled: false,
    ...overrides,
  };
}

describe('model init retry policy', () => {
  it.each([
    [12, [9, 6, 3, 1]],
    [3, [2, 1]],
    [2, [1]],
    [1, []],
    [0, []],
  ])('builds a unique bounded descending retry sequence for %i GPU layers', (layers, expected) => {
    const candidates = buildModelInitLayerRetryCandidates(layers);

    expect(candidates).toEqual(expected);
    expect(new Set(candidates).size).toBe(candidates.length);
    expect(candidates.every((candidate, index) => index === 0 || candidate < candidates[index - 1])).toBe(true);
    expect(candidates.length).toBeLessThanOrEqual(4);
  });

  it('deduplicates exact profiles, retains distinct layer profiles, and reserves bounded CPU fallback', () => {
    const profiles = [
      { ...baseCandidate, nGpuLayers: 3 },
      { ...baseCandidate, nGpuLayers: 3 },
      { ...baseCandidate, nGpuLayers: 12 },
      { ...baseCandidate, nGpuLayers: 9 },
      { ...baseCandidate, nGpuLayers: 6 },
      {
        ...baseCandidate,
        backendMode: 'cpu' as const,
        nGpuLayers: 0,
        flashAttnType: 'off' as const,
      },
    ];

    expect(dedupeAndBoundModelInitProfiles(profiles, 3).map((profile) => (
      `${profile.backendMode}:${profile.nGpuLayers}`
    ))).toEqual(['gpu:3', 'gpu:12', 'cpu:0']);
  });

  it('rejects exact duplicates and profiles at a known OOM upper bound while allowing safer layers', () => {
    const guard = new ModelInitAttemptGuard();
    const failedProbe = createAttempt({ nGpuLayers: 3 });

    expect(guard.tryStart(failedProbe)).toBe('started');
    expect(guard.tryStart(failedProbe)).toBe('duplicate');
    guard.recordProbableOom(failedProbe);

    expect(guard.getKnownOomUpperBound(failedProbe)).toBe(3);
    expect(guard.tryStart(createAttempt({ nGpuLayers: 12 }))).toBe('known_oom_upper_bound');
    expect(guard.tryStart(createAttempt({ nGpuLayers: 2 }))).toBe('started');
  });

  it('treats speculative and base-only initialization as distinct conditions', () => {
    const guard = new ModelInitAttemptGuard();
    const speculative = createAttempt({ nGpuLayers: 4, speculativeEnabled: true });
    const baseOnly = createAttempt({ nGpuLayers: 4, speculativeEnabled: false });

    expect(guard.tryStart(speculative)).toBe('started');
    guard.recordProbableOom(speculative);
    expect(guard.tryStart(baseOnly)).toBe('started');
    expect(guard.tryStart(baseOnly)).toBe('duplicate');
  });

  it('canonicalizes equivalent backend device sets before duplicate detection', () => {
    const guard = new ModelInitAttemptGuard();

    expect(guard.tryStart(createAttempt({ devices: [' GPU1 ', 'GPU0', 'GPU1'] }))).toBe('started');
    expect(guard.tryStart(createAttempt({ devices: ['GPU0', 'GPU1'] }))).toBe('duplicate');
  });

  it('keeps normal and low-memory native buffer profiles distinct', () => {
    const guard = new ModelInitAttemptGuard();

    expect(guard.tryStart(createAttempt({ nBatch: 256, nUbatch: 128, noExtraBufts: false })))
      .toBe('started');
    expect(guard.tryStart(createAttempt({ nBatch: 256, nUbatch: 128, noExtraBufts: true })))
      .toBe('started');
  });

  it('bounds accelerator attempts without removing the CPU fallback', () => {
    const guard = new ModelInitAttemptGuard(2);

    expect(guard.tryStart(createAttempt({ nGpuLayers: 3 }))).toBe('started');
    expect(guard.tryStart(createAttempt({ nGpuLayers: 2 }))).toBe('started');
    expect(guard.tryStart(createAttempt({ nGpuLayers: 1 }))).toBe('attempt_limit');
    expect(guard.tryStart(createAttempt({
      backendMode: 'cpu',
      nGpuLayers: 0,
      flashAttnType: 'off',
    }))).toBe('started');
  });

  it('enforces an absolute native-attempt cap while reserving MTP-base and CPU fallback slots', () => {
    const guard = new ModelInitAttemptGuard();
    for (let layers = 1; layers < MAX_MODEL_INIT_ACCELERATOR_ATTEMPTS; layers += 1) {
      expect(guard.tryStart(createAttempt({ nGpuLayers: layers }))).toBe('started');
    }

    expect(guard.tryStart(createAttempt({
      nGpuLayers: MAX_MODEL_INIT_ACCELERATOR_ATTEMPTS,
      speculativeEnabled: true,
    }))).toBe('started');
    expect(guard.tryStart(createAttempt({
      nGpuLayers: MAX_MODEL_INIT_ACCELERATOR_ATTEMPTS,
      speculativeEnabled: false,
    }), { allowBeyondLimit: true })).toBe('started');
    expect(guard.tryStart(createAttempt({
      backendMode: 'cpu',
      nGpuLayers: 0,
      flashAttnType: 'off',
    }))).toBe('started');
    expect(MAX_MODEL_INIT_TOTAL_ATTEMPTS).toBe(MAX_MODEL_INIT_ACCELERATOR_ATTEMPTS + 2);
    expect(guard.tryStart(createAttempt({
      backendMode: 'cpu',
      nGpuLayers: 0,
      nThreads: 2,
      flashAttnType: 'off',
    }))).toBe('attempt_limit');
  });

  it('reports only bounded failure categories instead of raw native error text', () => {
    expect(classifyModelInitFailure(new Error('GPU OOM at C:\\private\\model.gguf'), true))
      .toBe('out_of_memory');
    expect(classifyModelInitFailure(new Error('backend unavailable at /private/model.gguf'), false))
      .toBe('backend_unavailable');
    expect(classifyModelInitFailure(new Error('failed at /private/model.gguf'), false))
      .toBe('native_error');
  });
});
