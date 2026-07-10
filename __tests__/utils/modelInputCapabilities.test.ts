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
