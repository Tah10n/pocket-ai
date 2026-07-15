import type { MultimodalReadinessState, ProjectorArtifact } from '../../src/types/multimodal';
import {
  isMultimodalReadinessReusableForModel,
  normalizeMultimodalReadinessState,
} from '../../src/utils/multimodalReadiness';

const projector: ProjectorArtifact = {
  id: 'projector-a',
  ownerModelId: 'author/model',
  ownerVariantId: 'variant-a',
  repoId: 'author/model',
  fileName: 'mmproj-a.gguf',
  downloadUrl: 'https://example.com/mmproj-a.gguf',
  size: 1,
  lifecycleStatus: 'downloaded',
  matchStatus: 'matched',
};

const model = {
  id: 'author/model',
  activeVariantId: 'variant-a',
  resolvedFileName: 'model-a.gguf',
  variants: [
    { variantId: 'variant-a', fileName: 'model-a.gguf', quantizationLabel: 'Q4', size: 1 },
    { variantId: 'variant-b', fileName: 'model-b.gguf', quantizationLabel: 'Q8', size: 2 },
  ],
  projectorCandidates: [projector],
};

function createReadiness(overrides: Partial<MultimodalReadinessState> = {}): MultimodalReadinessState {
  return {
    modelId: model.id,
    variantId: 'variant-a',
    status: 'ready',
    projectorId: projector.id,
    support: ['vision'],
    requestedSupport: ['vision'],
    checkedAt: 1,
    ...overrides,
  };
}

describe('multimodalReadiness', () => {
  it('reuses exact variant, projector and order-insensitive modality state', () => {
    expect(isMultimodalReadinessReusableForModel({
      model,
      readiness: createReadiness({ support: ['audio', 'vision'], requestedSupport: ['audio', 'vision'] }),
      projectorId: projector.id,
      requestedSupport: ['vision', 'audio'],
    })).toBe(true);
  });

  it.each([
    ['wrong model', createReadiness({ modelId: 'other/model' }), ['vision'] as const],
    ['wrong variant', createReadiness({ variantId: 'variant-b' }), ['vision'] as const],
    ['ready with empty support', createReadiness({ support: [] }), ['vision'] as const],
    ['stale support outside request', createReadiness({ support: ['vision', 'audio'], requestedSupport: ['audio'] }), ['audio'] as const],
    ['wrong requested set', createReadiness({ status: 'failed', support: [], requestedSupport: ['vision', 'audio'] }), ['audio'] as const],
    ['legacy failure without requested support', createReadiness({ status: 'failed', support: [], requestedSupport: undefined }), ['vision'] as const],
  ])('rejects %s', (_label, readiness, requestedSupport) => {
    expect(isMultimodalReadinessReusableForModel({
      model,
      readiness,
      projectorId: projector.id,
      requestedSupport,
    })).toBe(false);
  });

  it('rejects ready support without a projector identity', () => {
    expect(isMultimodalReadinessReusableForModel({
      model: { ...model, projectorCandidates: [] },
      readiness: createReadiness({ projectorId: undefined }),
      projectorId: undefined,
      requestedSupport: ['vision'],
    })).toBe(false);
  });

  it('allows safe legacy readiness for a single variant and matching projector', () => {
    expect(isMultimodalReadinessReusableForModel({
      model: { ...model, variants: [model.variants[0]] },
      readiness: createReadiness({ variantId: undefined, requestedSupport: undefined }),
      projectorId: projector.id,
      requestedSupport: ['vision'],
    })).toBe(true);
  });

  it('rejects legacy readiness without variant identity for a multi-variant model', () => {
    expect(isMultimodalReadinessReusableForModel({
      model,
      readiness: createReadiness({ variantId: undefined }),
      projectorId: projector.id,
      requestedSupport: ['vision'],
    })).toBe(false);
  });

  it('rejects a projector outside the active variant', () => {
    expect(isMultimodalReadinessReusableForModel({
      model,
      readiness: createReadiness(),
      projectorId: projector.id,
      requestedSupport: ['vision'],
      projectorCandidates: [{ ...projector, ownerVariantId: 'variant-b' }],
    })).toBe(false);
  });

  it('filters support entries outside requestedSupport during normalization', () => {
    expect(normalizeMultimodalReadinessState(createReadiness({
      support: ['vision', 'audio'],
      requestedSupport: ['audio'],
    }))).toEqual(expect.objectContaining({
      support: ['audio'],
      requestedSupport: ['audio'],
    }));
  });
});
