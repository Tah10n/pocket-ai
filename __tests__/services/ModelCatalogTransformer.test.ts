import {
  buildModelMetadataFromPayload,
  createFallbackModel,
  transformHFResponse,
} from '../../src/services/ModelCatalogTransformer';

const LOCAL_SHA256 = 'b'.repeat(64);
const OTHER_SHA256 = 'c'.repeat(64);
const LOCAL_SIZE = 4 * 1024 * 1024 * 1024;
const REMOTE_SIZE = 3 * 1024 * 1024 * 1024;

describe('ModelCatalogTransformer', () => {
  it('uses the short repo label for fallback models', () => {
    const model = createFallbackModel('author/model-q4');

    expect(model.name).toBe('model-q4');
    expect(model.author).toBe('author');
  });

  it('uses the short repo label for tree-probe catalog candidates without a display name', () => {
    const models = transformHFResponse([
      {
        id: 'author/model-q4',
        tags: ['gguf', 'chat'],
        gguf: {
          total: 1_000_000_000,
        },
      },
    ], null, null);

    expect(models).toHaveLength(1);
    expect(models[0]).toEqual(expect.objectContaining({
      id: 'author/model-q4',
      name: 'model-q4',
      author: 'author',
      requiresTreeProbe: true,
    }));
  });

  it('recomputes the short repo label when payload metadata changes the repo id', () => {
    const result = buildModelMetadataFromPayload(
      {
        modelId: 'author/model-q8',
        tags: ['gguf', 'chat'],
        gguf: {
          total: 2_000_000_000,
        },
      },
      null,
      null,
      {
        ...createFallbackModel('author/model-q4'),
        name: 'stale-name',
      },
    );

    expect(result.id).toBe('author/model-q8');
    expect(result.name).toBe('model-q8');
    expect(result.author).toBe('author');
  });

  it('preserves verified local integrity when the payload entry has no sha256', () => {
    const fallbackModel = {
      ...createFallbackModel('author/model-q4'),
      size: LOCAL_SIZE,
      sha256: LOCAL_SHA256,
      metadataTrust: 'verified_local' as const,
      downloadIntegrity: {
        kind: 'sha256' as const,
        sizeBytes: LOCAL_SIZE,
        checkedAt: 123,
        sha256: `sha256:${LOCAL_SHA256.toUpperCase()}`,
      },
      gguf: {
        totalBytes: LOCAL_SIZE,
        contextLengthTokens: 8192,
        architecture: 'llama',
        nLayers: 32,
      },
      maxContextTokens: 8192,
      hasVerifiedContextWindow: true,
    };

    const result = buildModelMetadataFromPayload(
      {
        id: fallbackModel.id,
        gguf: {
          total: REMOTE_SIZE,
          context_length: 4096,
          architecture: 'mistral',
        },
        siblings: [{ rfilename: 'model.Q4_K_M.gguf', size: REMOTE_SIZE }],
      },
      null,
      null,
      fallbackModel,
      4096,
    );

    expect(result.size).toBe(LOCAL_SIZE);
    expect(result.sha256).toBe(LOCAL_SHA256);
    expect(result.metadataTrust).toBe('verified_local');
    expect(result.downloadIntegrity).toEqual({
      kind: 'sha256',
      sizeBytes: LOCAL_SIZE,
      checkedAt: 123,
      sha256: LOCAL_SHA256,
    });
    expect(result.gguf).toEqual(expect.objectContaining({
      totalBytes: LOCAL_SIZE,
      contextLengthTokens: 8192,
      architecture: 'llama',
      nLayers: 32,
    }));
    expect(result.maxContextTokens).toBe(8192);
    expect(result.hasVerifiedContextWindow).toBe(true);
  });

  it('drops verified local integrity when the payload entry has a conflicting sha256', () => {
    const fallbackModel = {
      ...createFallbackModel('author/model-q4'),
      size: LOCAL_SIZE,
      sha256: LOCAL_SHA256,
      metadataTrust: 'verified_local' as const,
      downloadIntegrity: {
        kind: 'sha256' as const,
        sizeBytes: LOCAL_SIZE,
        checkedAt: 123,
        sha256: LOCAL_SHA256,
      },
      gguf: {
        totalBytes: LOCAL_SIZE,
        architecture: 'llama',
        nLayers: 32,
      },
      maxContextTokens: 8192,
      hasVerifiedContextWindow: true,
    };

    const result = buildModelMetadataFromPayload(
      {
        id: fallbackModel.id,
        siblings: [{
          rfilename: 'model.Q4_K_M.gguf',
          size: REMOTE_SIZE,
          lfs: { sha256: OTHER_SHA256 },
        }],
      },
      null,
      null,
      fallbackModel,
    );

    expect(result.size).toBe(REMOTE_SIZE);
    expect(result.sha256).toBe(OTHER_SHA256);
    expect(result.metadataTrust).toBe('trusted_remote');
    expect(result.downloadIntegrity).toBeUndefined();
    expect(result.gguf).toEqual({ totalBytes: REMOTE_SIZE });
    expect(result.maxContextTokens).toBeUndefined();
    expect(result.hasVerifiedContextWindow).toBe(false);
  });

  it('does not reuse verified local size when a conflicting sha256 has unknown size', () => {
    const fallbackModel = {
      ...createFallbackModel('author/model-q4'),
      size: LOCAL_SIZE,
      fitsInRam: true,
      memoryFitDecision: 'fits_high_confidence' as const,
      memoryFitConfidence: 'high' as const,
      sha256: LOCAL_SHA256,
      metadataTrust: 'verified_local' as const,
      downloadIntegrity: {
        kind: 'sha256' as const,
        sizeBytes: LOCAL_SIZE,
        checkedAt: 123,
        sha256: LOCAL_SHA256,
      },
      gguf: {
        totalBytes: LOCAL_SIZE,
        architecture: 'llama',
      },
      maxContextTokens: 8192,
      hasVerifiedContextWindow: true,
    };

    const result = buildModelMetadataFromPayload(
      {
        id: fallbackModel.id,
        siblings: [{
          rfilename: 'model.Q4_K_M.gguf',
          lfs: { sha256: OTHER_SHA256 },
        }],
      },
      null,
      null,
      fallbackModel,
    );

    expect(result.size).toBeNull();
    expect(result.sha256).toBe(OTHER_SHA256);
    expect(result.metadataTrust).toBeUndefined();
    expect(result.downloadIntegrity).toBeUndefined();
    expect(result.gguf).toBeUndefined();
    expect(result.fitsInRam).toBeNull();
    expect(result.memoryFitDecision).toBeUndefined();
    expect(result.memoryFitConfidence).toBeUndefined();
    expect(result.maxContextTokens).toBeUndefined();
    expect(result.hasVerifiedContextWindow).toBe(false);
  });
});
