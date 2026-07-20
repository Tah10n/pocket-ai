import {
  buildModelInitLayerRetryCandidates,
  classifyModelInitFailure,
  dedupeAndBoundModelInitProfiles,
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

  it('reports only bounded failure categories instead of raw native error text', () => {
    expect(classifyModelInitFailure(new Error('GPU OOM at C:\\private\\model.gguf'), true))
      .toBe('out_of_memory');
    expect(classifyModelInitFailure(new Error('backend unavailable at /private/model.gguf'), false))
      .toBe('backend_unavailable');
    expect(classifyModelInitFailure(new Error('failed at /private/model.gguf'), false))
      .toBe('native_error');
  });
});
