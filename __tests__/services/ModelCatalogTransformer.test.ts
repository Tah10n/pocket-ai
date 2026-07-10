import {
  buildModelMetadataFromPayload,
  createFallbackModel,
  transformHFResponse,
} from '../../src/services/ModelCatalogTransformer';
import { CATALOG_SEARCH_VARIANT_LIMIT } from '../../src/services/ModelCatalogFileSelector';
import { LifecycleStatus } from '../../src/types/models';
import {
  resolveEffectiveActiveVariantNativeSupport,
  resolveModelNativeMultimodalSupport,
} from '../../src/utils/modelCapabilities';
import {
  ambiguousProjectorCatalogSiblings,
  projectorOnlyCatalogSiblings,
  projectorFileName,
  visionCatalogSiblings,
  visionModelFileName,
} from '../fixtures/multimodalCatalogFixtures';

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

  it('filters MTP tree-probe candidates from catalog summaries', () => {
    const models = transformHFResponse([
      {
        id: 'author/model-mtp-gguf',
        tags: ['gguf', 'chat'],
        gguf: {
          total: 1_000_000_000,
        },
      },
      {
        id: 'author/model-with-nextn-config',
        tags: ['gguf', 'chat'],
        config: {
          nextn_predict_layers: 1,
        },
        gguf: {
          total: 1_000_000_000,
        },
      },
    ], null, null);

    expect(models).toEqual([]);
  });

  it('exposes sorted GGUF variants and selects the default download target from catalog siblings', () => {
    const models = transformHFResponse([
      {
        id: 'author/model-q4',
        author: 'author',
        tags: ['gguf', 'chat'],
        siblings: [
          { rfilename: 'model.mmproj.gguf', size: REMOTE_SIZE },
          { rfilename: 'model.NextN.Q4_K_M.gguf', size: REMOTE_SIZE },
          { rfilename: 'model.Q8_0.gguf', size: 8_000_000_000, lfs: { sha256: 'a'.repeat(64) } },
          { rfilename: 'model.Q4_K_M.gguf', size: REMOTE_SIZE, lfs: { sha256: OTHER_SHA256 } },
        ],
      },
    ], null, null);

    expect(models).toHaveLength(1);
    expect(models[0]).toEqual(expect.objectContaining({
      resolvedFileName: 'model.Q4_K_M.gguf',
      activeVariantId: 'model.Q4_K_M.gguf',
      size: REMOTE_SIZE,
      sha256: OTHER_SHA256,
    }));
    expect(models[0].variants).toEqual([
      expect.objectContaining({
        variantId: 'model.Q4_K_M.gguf',
        fileName: 'model.Q4_K_M.gguf',
        quantizationLabel: 'Q4_K_M',
        size: REMOTE_SIZE,
      }),
      expect.objectContaining({
        variantId: 'model.Q8_0.gguf',
        fileName: 'model.Q8_0.gguf',
        quantizationLabel: 'Q8_0',
        size: 8_000_000_000,
      }),
    ]);
  });

  it('marks vision-capable catalog models and preserves projector candidates as companions', () => {
    const models = transformHFResponse([
      {
        id: 'test-org/vision-chat-model',
        author: 'test-org',
        pipeline_tag: 'image-text-to-text',
        tags: ['gguf', 'vision'],
        siblings: [...visionCatalogSiblings],
        sha: 'main',
      },
    ], null, null);

    expect(models).toHaveLength(1);
    expect(models[0]).toEqual(expect.objectContaining({
      resolvedFileName: visionModelFileName,
      activeVariantId: visionModelFileName,
      artifactRole: 'primary_chat_model',
      chatModalities: ['text', 'vision'],
      visionSource: 'catalog_metadata',
      visionConfidence: 'trusted',
      inputCapabilities: expect.objectContaining({
        declared: expect.objectContaining({
          image: 'supported',
        }),
      }),
    }));
    expect(models[0].inputCapabilities?.evidence).toEqual(expect.arrayContaining([
      { source: 'pipeline_tag', value: 'image-text-to-text', confidence: 'high' },
      { source: 'projector', value: projectorFileName, confidence: 'medium' },
    ]));
    expect(models[0].variants?.map((variant) => variant.fileName)).toEqual([visionModelFileName]);
    expect(models[0].projectorCandidates).toEqual([
      expect.objectContaining({
        ownerModelId: 'test-org/vision-chat-model',
        fileName: projectorFileName,
        lifecycleStatus: 'available',
        matchStatus: 'matched',
      }),
    ]);
    expect(models[0].artifacts).toEqual([
      expect.objectContaining({
        kind: 'main_model',
        requiredFor: ['text'],
        remoteFileName: visionModelFileName,
        installState: 'remote',
      }),
      expect.objectContaining({
        id: models[0].projectorCandidates?.[0].id,
        kind: 'multimodal_projector',
        requiredFor: ['image'],
        remoteFileName: projectorFileName,
        installState: 'remote',
      }),
    ]);
    expect(models[0].projectorCandidates?.[0].ownerVariantId).toBeUndefined();
  });

  it('persists declared audio capability evidence without treating it as runtime support', () => {
    const models = transformHFResponse([
      {
        id: 'test-org/audio-chat-model-gguf',
        author: 'test-org',
        pipeline_tag: 'automatic-speech-recognition',
        tags: ['gguf', 'audio'],
        siblings: [
          { rfilename: 'audio-model.Q4_K_M.gguf', size: REMOTE_SIZE },
        ],
      },
    ], null, null);

    expect(models).toHaveLength(1);
    expect(models[0].chatModalities).toEqual(['text']);
    expect(resolveModelNativeMultimodalSupport(models[0])).toEqual({ vision: false, audio: false });
    expect(models[0].inputCapabilities).toEqual(expect.objectContaining({
      declared: {
        image: 'unknown',
        audio: 'supported',
        video: 'unknown',
      },
      evidence: expect.arrayContaining([
        { source: 'pipeline_tag', value: 'automatic-speech-recognition', confidence: 'high' },
        { source: 'tag', value: 'audio', confidence: 'medium' },
      ]),
    }));
    expect(models[0].multimodalReadiness).toBeUndefined();
    expect(models[0].artifacts).toEqual([
      expect.objectContaining({
        kind: 'main_model',
        requiredFor: ['text'],
        installState: 'remote',
      }),
    ]);
  });

  it('preserves vision and audio chat modalities when catalog metadata exposes both', () => {
    const models = transformHFResponse([
      {
        id: 'test-org/vision-audio-chat-model',
        author: 'test-org',
        pipeline_tag: 'image-text-to-text',
        tags: ['gguf', 'vision', 'audio'],
        siblings: [...visionCatalogSiblings],
        sha: 'main',
      },
    ], null, null);

    expect(models).toHaveLength(1);
    expect(models[0].chatModalities).toEqual(['text', 'vision', 'audio']);
    expect(models[0].inputCapabilities?.declared).toEqual(expect.objectContaining({
      image: 'supported',
      audio: 'supported',
    }));
    expect(models[0].artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'multimodal_projector',
        requiredFor: ['image', 'audio'],
      }),
    ]));
  });

  it('maps the Gemma 4 E2B nested config to deployable vision and audio support', () => {
    const modelFileName = 'gemma-4-E2B-it-Q4_K_M.gguf';
    const projectorFileName = 'mmproj-BF16.gguf';
    const models = transformHFResponse([
      {
        id: 'unsloth/gemma-4-E2B-it-GGUF',
        author: 'unsloth',
        tags: ['gguf', 'image-text-to-text'],
        config: {
          model_type: 'gemma4',
          architectures: ['Gemma4ForConditionalGeneration'],
          vision_config: { model_type: 'gemma4_vision' },
          audio_config: { model_type: 'gemma4_audio' },
        },
        gguf: { architecture: 'gemma4' },
        siblings: [
          { rfilename: modelFileName, size: REMOTE_SIZE },
          { rfilename: projectorFileName, size: 1_000_000 },
        ],
        sha: 'main',
      },
    ], null, null);

    expect(models).toHaveLength(1);
    expect(models[0]).toEqual(expect.objectContaining({
      chatModalities: ['text', 'vision', 'audio'],
      activeVariantId: modelFileName,
    }));
    expect(models[0].inputCapabilities?.declared).toEqual(expect.objectContaining({
      image: 'supported',
      audio: 'supported',
    }));
    expect(models[0].projectorCandidates).toEqual([
      expect.objectContaining({ fileName: projectorFileName }),
    ]);
    expect(models[0].artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'multimodal_projector',
        remoteFileName: projectorFileName,
        requiredFor: ['image', 'audio'],
      }),
    ]));
    expect(resolveEffectiveActiveVariantNativeSupport(models[0])).toEqual({
      vision: true,
      audio: true,
    });
  });

  it('preserves audio chat modalities from detailed payload input capabilities', () => {
    const result = buildModelMetadataFromPayload(
      {
        id: 'test-org/audio-detail-model',
        author: 'test-org',
        pipeline_tag: 'automatic-speech-recognition',
        tags: ['gguf'],
        siblings: [
          { rfilename: 'audio-model.Q4_K_M.gguf', size: REMOTE_SIZE },
          { rfilename: 'mmproj-audio-model-f16.gguf', size: 1_000_000 },
        ],
      },
      null,
      null,
      createFallbackModel('test-org/audio-detail-model'),
    );

    expect(result.chatModalities).toEqual(['text', 'audio']);
    expect(result.inputCapabilities?.declared.audio).toBe('supported');
    expect(result.inputCapabilities?.evidence).toEqual(expect.arrayContaining([
      { source: 'pipeline_tag', value: 'automatic-speech-recognition', confidence: 'high' },
      { source: 'projector', value: 'mmproj-audio-model-f16.gguf', confidence: 'medium' },
    ]));
    expect(result.projectorCandidates?.[0]).toEqual(expect.objectContaining({
      fileName: 'mmproj-audio-model-f16.gguf',
    }));
    expect(result.artifacts?.find((artifact) => artifact.kind === 'multimodal_projector')).toEqual(
      expect.objectContaining({
        requiredFor: ['audio'],
      }),
    );
    expect(result.visionSource).toBeUndefined();
    expect(result.visionConfidence).toBeUndefined();
  });

  it('includes matched projector bytes in catalog memory-fit estimates', () => {
    const models = transformHFResponse([
      {
        id: 'test-org/vision-chat-model',
        author: 'test-org',
        tags: ['gguf', 'vision'],
        siblings: [
          { rfilename: 'vision-model.Q4_K_M.gguf', size: 100_000_000 },
          { rfilename: 'vision-model.mmproj.gguf', size: 1_600_000_000 },
        ],
      },
    ], { totalMemoryBytes: 2_000_000_000 }, null);

    expect(models).toHaveLength(1);
    expect(models[0].fitsInRam).toBe(false);
    expect(models[0].memoryFitDecision).toBe('likely_oom');
    expect(models[0].variants?.[0]).toEqual(expect.objectContaining({
      fileName: 'vision-model.Q4_K_M.gguf',
      ramFit: 'likely_oom',
    }));
  });

  it('does not advertise non-GGUF projector-like siblings as downloadable projector artifacts', () => {
    const models = transformHFResponse([
      {
        id: 'test-org/vision-chat-model',
        author: 'test-org',
        tags: ['gguf', 'vision'],
        siblings: [
          { rfilename: 'mmproj-config.json', size: 2_048 },
          { rfilename: 'clip_projector.txt', size: 2_048 },
          { rfilename: 'adapter.mmproj.safetensors', size: 2_048 },
          { rfilename: visionModelFileName, size: REMOTE_SIZE },
        ],
      },
    ], null, null);

    expect(models).toHaveLength(1);
    expect(models[0]).toEqual(expect.objectContaining({
      resolvedFileName: visionModelFileName,
      activeVariantId: visionModelFileName,
    }));
    expect(models[0].projectorCandidates).toBeUndefined();
  });

  it('keeps ambiguous projector candidates unresolved instead of silently selecting one', () => {
    const models = transformHFResponse([
      {
        id: 'test-org/vision-chat-model',
        author: 'test-org',
        tags: ['gguf', 'vision'],
        siblings: [...ambiguousProjectorCatalogSiblings],
      },
    ], null, null);

    expect(models).toHaveLength(1);
    expect(models[0].projectorCandidates).toHaveLength(2);
    expect(models[0].selectedProjectorId).toBeUndefined();
    expect(models[0].projectorCandidates?.map((candidate) => candidate.matchStatus)).toEqual([
      'ambiguous',
      'ambiguous',
    ]);
  });

  it('drops MTP-only sibling payloads instead of creating a fallback tree-probe model', () => {
    const models = transformHFResponse([
      {
        id: 'author/model-q4',
        author: 'author',
        gated: 'manual',
        tags: ['gguf', 'chat'],
        siblings: [
          { rfilename: 'model.MTP.Q4_K_M.gguf', size: REMOTE_SIZE },
        ],
      },
    ], null, null);

    expect(models).toEqual([]);
  });

  it('drops projector-only sibling payloads instead of creating a fallback model.gguf tree-probe model', () => {
    const models = transformHFResponse([
      {
        id: 'test-org/projector-only-repo',
        author: 'test-org',
        gated: 'manual',
        tags: ['gguf', 'vision'],
        siblings: [...projectorOnlyCatalogSiblings],
        gguf: {
          total: 1_000_000_000,
        },
      },
    ], null, null);

    expect(models).toEqual([]);
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

  it('preserves an explicitly selected variant during metadata refresh', () => {
    const result = buildModelMetadataFromPayload(
      {
        id: 'author/model-q4',
        siblings: [
          { rfilename: 'model.Q4_K_M.gguf', size: REMOTE_SIZE, lfs: { sha256: OTHER_SHA256 } },
          { rfilename: 'model.Q8_0.gguf', size: 8_000_000_000, lfs: { sha256: LOCAL_SHA256 } },
        ],
      },
      null,
      null,
      {
        ...createFallbackModel('author/model-q4'),
        resolvedFileName: 'model.Q8_0.gguf',
        activeVariantId: 'model.Q8_0.gguf',
        variants: [
          {
            variantId: 'model.Q4_K_M.gguf',
            fileName: 'model.Q4_K_M.gguf',
            quantizationLabel: 'Q4_K_M',
            size: REMOTE_SIZE,
            sha256: OTHER_SHA256,
          },
          {
            variantId: 'model.Q8_0.gguf',
            fileName: 'model.Q8_0.gguf',
            quantizationLabel: 'Q8_0',
            size: 8_000_000_000,
            sha256: LOCAL_SHA256,
          },
        ],
      },
    );

    expect(result).toEqual(expect.objectContaining({
      resolvedFileName: 'model.Q8_0.gguf',
      activeVariantId: 'model.Q8_0.gguf',
      size: 8_000_000_000,
      sha256: LOCAL_SHA256,
    }));
  });

  it('caps detail payload variants while pinning the selected fallback variant', () => {
    const selectedFileName = `model-${String(CATALOG_SEARCH_VARIANT_LIMIT + 2).padStart(3, '0')}.Q4_K_M.gguf`;
    const result = buildModelMetadataFromPayload(
      {
        id: 'author/model-q4',
        siblings: Array.from({ length: CATALOG_SEARCH_VARIANT_LIMIT + 3 }, (_value, index) => ({
          rfilename: `model-${String(index).padStart(3, '0')}.Q4_K_M.gguf`,
          size: (index + 1) * 1024 * 1024 * 1024,
        })),
      },
      null,
      null,
      {
        ...createFallbackModel('author/model-q4'),
        resolvedFileName: selectedFileName,
        activeVariantId: selectedFileName,
      },
    );

    expect(result.variants).toHaveLength(CATALOG_SEARCH_VARIANT_LIMIT);
    expect(result.variants?.some((variant) => variant.fileName === selectedFileName)).toBe(true);
    expect(result.variants?.some((variant) => variant.fileName === `model-${String(CATALOG_SEARCH_VARIANT_LIMIT).padStart(3, '0')}.Q4_K_M.gguf`)).toBe(false);
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
          total: LOCAL_SIZE,
          context_length: 4096,
          architecture: 'mistral',
        },
        siblings: [{ rfilename: 'model.Q4_K_M.gguf', size: LOCAL_SIZE }],
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

  it('drops verified local integrity when a missing-sha payload selects a different file', () => {
    const fallbackModel = {
      ...createFallbackModel('author/model-q4'),
      size: LOCAL_SIZE,
      resolvedFileName: 'model.Q4_K_M.gguf',
      localPath: 'model.Q4_K_M.gguf',
      downloadedAt: 123,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
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
        siblings: [{ rfilename: 'model.Q5_K_M.gguf', size: REMOTE_SIZE }],
      },
      null,
      null,
      fallbackModel,
      4096,
    );

    expect(result).toEqual(expect.objectContaining({
      size: REMOTE_SIZE,
      resolvedFileName: 'model.Q5_K_M.gguf',
      localPath: undefined,
      downloadedAt: undefined,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      sha256: undefined,
      metadataTrust: 'trusted_remote',
      maxContextTokens: 4096,
      hasVerifiedContextWindow: false,
    }));
    expect(result.downloadIntegrity).toBeUndefined();
    expect(result.gguf).toEqual({
      totalBytes: REMOTE_SIZE,
      contextLengthTokens: 4096,
      architecture: 'mistral',
    });
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
