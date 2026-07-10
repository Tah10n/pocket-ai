import { EngineStatus, LifecycleStatus } from '../../src/types/models';
import {
  canSendAttachments,
  getInputCapabilityEvidenceModalities,
  inferDeclaredInputCapabilities,
  mergeInputCapabilitySnapshots,
  normalizePersistedInputCapabilitySnapshot,
  resolveEffectiveInputCapabilities,
} from '../../src/utils/modelInputCapabilities';

describe('modelInputCapabilities', () => {
  it.each([
    ['pipeline audio', { source: 'pipeline_tag', value: 'automatic-speech-recognition' }, ['audio']],
    ['tag image', { source: 'tag', value: 'Qwen2.5-VL' }, ['image']],
    ['runtime audio', { source: 'runtime', value: 'audio' }, ['audio']],
    ['nested config audio', { source: 'config', value: 'gemma4_audio' }, ['audio']],
    ['Phi-4 multimodal architecture', { source: 'architecture', value: 'Phi4MMForCausalLM' }, ['image', 'audio']],
    ['Qwen 2.5 Omni config', { source: 'config', value: 'qwen2_5_omni' }, ['image', 'audio']],
    ['Voxtral architecture', { source: 'architecture', value: 'VoxtralForConditionalGeneration' }, ['audio']],
    ['Qwen 3 VL architecture', { source: 'architecture', value: 'Qwen3VLForConditionalGeneration' }, ['image']],
    ['image generation tag', { source: 'tag', value: 'text-to-image' }, []],
    ['catalog video', { source: 'repository_tree', value: 'video adapter' }, ['video']],
    ['passive projector', { source: 'projector', value: 'mmproj-audio.gguf' }, []],
  ] as const)('classifies %s evidence with the catalog inference rules', (_label, evidence, expected) => {
    expect(getInputCapabilityEvidenceModalities(evidence)).toEqual(expected);
  });

  it('infers separate declared image, audio, and video capabilities from catalog signals', () => {
    const snapshot = inferDeclaredInputCapabilities({
      id: 'test-org/video-audio-vision-model',
      pipeline_tag: 'audio-text-to-text',
      tags: ['gguf', 'vision', 'video'],
      config: {
        architectures: ['Qwen2VLForConditionalGeneration'],
      },
    }, [
      { rfilename: 'model.Q4_K_M.gguf', size: 100 },
      { rfilename: 'mmproj-model-f16.gguf', size: 50 },
      { rfilename: 'notes.txt', size: 10 },
    ], { detectedAt: 123 });

    expect(snapshot.detectedAt).toBe(123);
    expect(snapshot.declared).toEqual({
      image: 'supported',
      audio: 'supported',
      video: 'supported',
    });
    expect(snapshot.evidence).toEqual(expect.arrayContaining([
      { source: 'pipeline_tag', value: 'audio-text-to-text', confidence: 'high' },
      { source: 'tag', value: 'vision', confidence: 'medium' },
      { source: 'tag', value: 'video', confidence: 'low' },
      { source: 'architecture', value: 'qwen2vlforconditionalgeneration', confidence: 'high' },
      { source: 'projector', value: 'mmproj-model-f16.gguf', confidence: 'medium' },
    ]));
  });

  it('infers Gemma 4 image and audio inputs from nested model configs', () => {
    const snapshot = inferDeclaredInputCapabilities({
      id: 'google/gemma-4-E2B-it',
      config: {
        model_type: 'gemma4',
        architectures: ['Gemma4ForConditionalGeneration'],
        vision_config: { model_type: 'gemma4_vision' },
        audio_config: { model_type: 'gemma4_audio' },
      },
    }, [], { detectedAt: 456 });

    expect(snapshot.declared).toEqual({
      image: 'supported',
      audio: 'supported',
      video: 'unknown',
    });
    expect(snapshot.evidence).toEqual(expect.arrayContaining([
      { source: 'config', value: 'gemma4_vision', confidence: 'medium' },
      { source: 'config', value: 'gemma4_audio', confidence: 'medium' },
      { source: 'architecture', value: 'gemma4-e2b-audio-profile', confidence: 'high' },
    ]));
  });

  it('walks deep Omni config blocks and records explicit input sections', () => {
    const snapshot = inferDeclaredInputCapabilities({
      id: 'example/deep-omni-config',
      config: {
        model_type: 'custom_omni',
        thinker_config: {
          audio_config: { model_type: 'whisper_encoder' },
          vision_config: { model_type: 'siglip' },
        },
      },
    }, [], { detectedAt: 0 });

    expect(snapshot.declared).toEqual({
      image: 'supported',
      audio: 'supported',
      video: 'unknown',
    });
    expect(snapshot.evidence).toEqual(expect.arrayContaining([
      { source: 'config', value: 'audio_config', confidence: 'medium' },
      { source: 'config', value: 'vision_config', confidence: 'medium' },
    ]));
  });

  it('recognizes Phi-4-style processor and embedding blocks without relying on its family name', () => {
    const snapshot = inferDeclaredInputCapabilities({
      id: 'example/custom-conversion',
      config: {
        model_type: 'custom',
        audio_processor: { config: { input_size: 80 } },
        embd_layer: {
          audio_embd_layer: { embedding_cls: 'audio' },
          image_embd_layer: { embedding_cls: 'image' },
        },
      },
    }, [], { detectedAt: 0 });

    expect(snapshot.declared).toEqual({
      image: 'supported',
      audio: 'supported',
      video: 'unknown',
    });
    expect(snapshot.evidence).toEqual(expect.arrayContaining([
      { source: 'config', value: 'audio_processor', confidence: 'medium' },
      { source: 'config', value: 'audio_embd_layer', confidence: 'medium' },
      { source: 'config', value: 'image_embd_layer', confidence: 'medium' },
    ]));
  });

  it('does not treat output flags and token ids as input capability blocks', () => {
    const snapshot = inferDeclaredInputCapabilities({
      id: 'example/output-only-signals',
      config: {
        model_type: 'text_model',
        enable_audio_output: true,
        audio_token_index: 100,
        image_token_index: 101,
      },
    }, [], { detectedAt: 0 });

    expect(snapshot.declared).toEqual({
      image: 'unknown',
      audio: 'unknown',
      video: 'unknown',
    });
  });

  it('bounds recursive config discovery when a malformed payload contains cycles', () => {
    const config: { model_type: string; nested?: unknown } = { model_type: 'text_model' };
    config.nested = { self: config };

    expect(inferDeclaredInputCapabilities({ config }, [], { detectedAt: 0 }).declared).toEqual({
      image: 'unknown',
      audio: 'unknown',
      video: 'unknown',
    });
  });

  it.each([
    {
      name: 'Phi-4 multimodal',
      id: 'community/Phi-4-multimodal-instruct-GGUF',
      modelFile: 'Phi-4-multimodal-instruct-Q4_K_M.gguf',
      declared: { image: 'supported', audio: 'supported', video: 'unknown' },
    },
    {
      name: 'Qwen 2.5 Omni',
      id: 'community/Qwen2.5-Omni-7B-GGUF',
      modelFile: 'Qwen2.5-Omni-7B-Q4_K_M.gguf',
      declared: { image: 'supported', audio: 'supported', video: 'unknown' },
    },
    {
      name: 'Gemma 3n',
      id: 'community/gemma-3n-E4B-it-GGUF',
      modelFile: 'gemma-3n-E4B-it-Q4_K_M.gguf',
      declared: { image: 'supported', audio: 'supported', video: 'unknown' },
    },
    {
      name: 'Voxtral',
      id: 'community/Voxtral-Mini-3B-GGUF',
      modelFile: 'Voxtral-Mini-3B-Q4_K_M.gguf',
      declared: { image: 'unknown', audio: 'supported', video: 'unknown' },
    },
    {
      name: 'Ultravox',
      id: 'community/Ultravox-v0.5-GGUF',
      modelFile: 'Ultravox-v0.5-Q4_K_M.gguf',
      declared: { image: 'unknown', audio: 'supported', video: 'unknown' },
    },
    {
      name: 'Qwen 3 VL',
      id: 'community/Qwen3-VL-4B-GGUF',
      modelFile: 'Qwen3-VL-4B-Q4_K_M.gguf',
      declared: { image: 'supported', audio: 'unknown', video: 'unknown' },
    },
  ])('repairs sparse $name GGUF metadata only when model and projector artifacts agree', ({
    id,
    modelFile,
    declared,
  }) => {
    const snapshot = inferDeclaredInputCapabilities({ id }, [
      { path: modelFile },
      { path: 'mmproj-model-f16.gguf' },
    ], { detectedAt: 0 });

    expect(snapshot.declared).toEqual(declared);
    expect(snapshot.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'repository_tree',
        confidence: 'high',
      }),
    ]));
  });

  it('does not trust a known family name when the GGUF artifact belongs to another family', () => {
    const snapshot = inferDeclaredInputCapabilities({
      id: 'community/Voxtral-lookalike-GGUF',
    }, [
      { path: 'plain-text-model-Q4_K_M.gguf' },
      { path: 'mmproj-model-f16.gguf' },
    ], { detectedAt: 0 });

    expect(snapshot.declared.audio).toBe('unknown');
  });

  it.each(['E2B', 'E4B', '12B'])('recognizes the Gemma 4 %s audio architecture profile', (size) => {
    const snapshot = inferDeclaredInputCapabilities({
      id: `unsloth/gemma-4-${size}-it-GGUF`,
      config: { model_type: 'gemma4' },
    }, [], { detectedAt: 0 });

    expect(snapshot.declared.audio).toBe('supported');
    expect(snapshot.evidence).toContainEqual({
      source: 'architecture',
      value: `gemma4-${size.toLowerCase()}-audio-profile`,
      confidence: 'high',
    });
  });

  it.each(['A4B', '31B'])('does not assign audio support to the Gemma 4 %s profile', (size) => {
    const snapshot = inferDeclaredInputCapabilities({
      id: `unsloth/gemma-4-${size}-it-GGUF`,
      config: { model_type: 'gemma4' },
    }, [], { detectedAt: 0 });

    expect(snapshot.declared.audio).toBe('unknown');
    expect(snapshot.evidence).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ value: expect.stringContaining('audio-profile') }),
    ]));
  });

  it('recognizes a legacy Gemma 4 audio profile from matching repo, model file, and projector evidence', () => {
    const snapshot = inferDeclaredInputCapabilities({
      id: 'unsloth/gemma-4-E2B-it-GGUF',
    }, [
      { path: 'gemma-4-E2B-it-Q4_K_M.gguf' },
      { path: 'mmproj-BF16.gguf' },
    ], { detectedAt: 0 });

    expect(snapshot.declared.audio).toBe('supported');
    expect(snapshot.evidence).toEqual(expect.arrayContaining([
      {
        source: 'repository_tree',
        value: 'gemma4-e2b-audio-profile',
        confidence: 'high',
      },
      {
        source: 'projector',
        value: 'mmproj-bf16.gguf',
        confidence: 'medium',
      },
    ]));
  });

  it('does not infer the legacy profile when a matching Gemma repo has no projector artifact', () => {
    const snapshot = inferDeclaredInputCapabilities({
      id: 'unsloth/gemma-4-E2B-it-GGUF',
    }, [
      { path: 'gemma-4-E2B-it-Q4_K_M.gguf' },
    ], { detectedAt: 0 });

    expect(snapshot.declared.audio).toBe('unknown');
  });

  it('does not infer a Gemma 4 audio profile from a similarly named repo without architecture evidence', () => {
    const snapshot = inferDeclaredInputCapabilities({
      id: 'example/gemma-4-E2B-lookalike',
    }, [], { detectedAt: 0 });

    expect(snapshot.declared.audio).toBe('unknown');
  });

  it('merges catalog and tree-probe capability snapshots without losing earlier modalities', () => {
    const catalogSnapshot = inferDeclaredInputCapabilities({
      pipeline_tag: 'automatic-speech-recognition',
    }, [], { detectedAt: 100 });
    const treeSnapshot = inferDeclaredInputCapabilities(null, [
      { path: 'model.Q4_K_M.gguf', size: 100 },
      { path: 'mmproj-model-f16.gguf', size: 50 },
    ], { detectedAt: 200 });

    expect(mergeInputCapabilitySnapshots(catalogSnapshot, treeSnapshot)).toEqual({
      detectedAt: 200,
      declared: {
        image: 'unknown',
        audio: 'supported',
        video: 'unknown',
      },
      evidence: expect.arrayContaining([
        { source: 'pipeline_tag', value: 'automatic-speech-recognition', confidence: 'high' },
        { source: 'projector', value: 'mmproj-model-f16.gguf', confidence: 'medium' },
      ]),
    });
  });

  it('normalizes persisted snapshots and drops malformed evidence', () => {
    expect(normalizePersistedInputCapabilitySnapshot({
      detectedAt: 42.4,
      declared: {
        image: 'supported',
        audio: 'nope',
        video: 'unsupported',
      },
      evidence: [
        { source: 'pipeline_tag', value: ' image-text-to-text ', confidence: 'high' },
        { source: 'pipeline_tag', value: 'image-text-to-text', confidence: 'high' },
        { source: 'bad', value: 'vision', confidence: 'high' },
      ],
    })).toEqual({
      detectedAt: 42,
      declared: {
        image: 'supported',
        audio: 'unknown',
        video: 'unsupported',
      },
      evidence: [
        { source: 'pipeline_tag', value: 'image-text-to-text', confidence: 'high' },
      ],
    });

    expect(normalizePersistedInputCapabilitySnapshot(null)).toBeUndefined();
  });

  it('resolves effective capabilities from the active runtime and local processors only', () => {
    const capabilities = resolveEffectiveInputCapabilities({
      model: {
        id: 'test/model',
        lifecycleStatus: LifecycleStatus.ACTIVE,
        multimodalReadiness: {
          modelId: 'test/model',
          status: 'ready',
          support: ['vision'],
          checkedAt: 100,
        },
      },
      engineState: {
        status: EngineStatus.READY,
        activeModelId: 'test/model',
        loadProgress: 1,
      },
      processorRegistry: {
        document: true,
        videoFrames: true,
        videoAudio: true,
      },
    });

    expect(capabilities).toEqual({
      text: true,
      image: true,
      audio: false,
      document: true,
      videoFrames: false,
      videoAudio: false,
      directVideo: false,
      reasons: expect.objectContaining({
        audio: 'runtime_audio_unavailable',
        videoFrames: 'video_processing_disabled',
        videoAudio: 'video_processing_disabled',
      }),
    });
  });

  it('keeps catalog-declared media unsupported until the active runtime confirms it', () => {
    const capabilities = resolveEffectiveInputCapabilities({
      model: {
        id: 'test/model',
        lifecycleStatus: LifecycleStatus.ACTIVE,
        multimodalReadiness: {
          modelId: 'test/model',
          status: 'missing_projector',
          support: ['vision', 'audio'],
          checkedAt: 100,
        },
      },
      engineState: {
        status: EngineStatus.READY,
        activeModelId: 'test/model',
        loadProgress: 1,
      },
      processorRegistry: {
        document: true,
        videoFrames: true,
      },
    });

    expect(capabilities.image).toBe(false);
    expect(capabilities.audio).toBe(false);
    expect(capabilities.videoFrames).toBe(false);
    expect(capabilities.document).toBe(true);
    expect(capabilities.directVideo).toBe(false);
  });

  it('reports unsupported attachments without silently dropping them', () => {
    const capabilities = resolveEffectiveInputCapabilities({
      model: {
        id: 'test/model',
        lifecycleStatus: LifecycleStatus.ACTIVE,
        multimodalReadiness: {
          modelId: 'test/model',
          status: 'ready',
          support: ['vision'],
          checkedAt: 100,
        },
      },
      engineState: {
        status: EngineStatus.READY,
        activeModelId: 'test/model',
        loadProgress: 1,
      },
      processorRegistry: {
        document: true,
        videoFrames: true,
      },
    });

    expect(canSendAttachments(capabilities, [
      { kind: 'image', state: 'ready' },
      { kind: 'document', state: 'ready' },
    ])).toEqual({ ok: true });

    expect(canSendAttachments(capabilities, [
      { kind: 'audio', state: 'ready' },
      { kind: 'video', state: 'processing' },
    ])).toEqual({
      ok: false,
      unsupported: [
        { kind: 'audio', state: 'ready', reason: 'runtime_audio_unavailable' },
        { kind: 'video', state: 'processing', reason: 'attachment_not_ready' },
      ],
    });
  });
});
