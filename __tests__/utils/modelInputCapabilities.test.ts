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
      { source: 'architecture', value: 'qwen2vlforconditionalgeneration', confidence: 'medium' },
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
