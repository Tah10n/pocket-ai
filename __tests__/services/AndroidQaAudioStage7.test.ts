import { AppState } from 'react-native';
import { checkAndroidQaStage7ColdVoice, continueAndroidQaAudioStage7, getAndroidQaAudioStage7Evidence,
  isAndroidQaAudioStage7Enabled, runAndroidQaStage7Input, runAndroidQaStage7Recording,
  runAndroidQaStage7Voices, prepareAndroidQaStage7AudioModel } from '../../src/services/AndroidQaAudioStage7';
import fixture from '../../docs/validation/llama-rn-stage7/audio-input-fixtures.json';
import syntheticFixtures from '../../docs/validation/llama-rn-stage7/synthetic-inputs.json';
import type { TtsRequest } from '../../src/services/TtsService';
import { LifecycleStatus, type ModelMetadata } from '../../src/types/models';
import { AudioPreparationError } from '../../src/services/AudioPreparationService';
import { sanitizeAudioStage7Evidence } from '../../scripts/lib/audio-stage7-evidence';
import { normalizePersistedModelMetadata } from '../../src/services/ModelMetadataNormalizer';
import { TtsCleanupError, TtsError } from '../../src/types/tts';

const mockStartRecording = jest.fn(); const mockStopRecording = jest.fn(); const mockClearRecording = jest.fn();
const mockPrep = jest.fn(); const mockDiscard = jest.fn(); const mockPreviewPlay = jest.fn(); const mockPreviewStop = jest.fn();
const mockTtsStart = jest.fn(); const mockTtsClear = jest.fn(); const mockSave = jest.fn(); const mockDelete = jest.fn();
const mockChatCompletion = jest.fn(); const mockPrepareProfile = jest.fn(); const mockLoad = jest.fn();
const mockCopy = jest.fn(); const mockFileInfo = jest.fn(); const mockQueue = jest.fn();
const mockSeed = jest.fn(); const mockRegistryUpdate = jest.fn(); const mockCancelDownload = jest.fn();
const mockDownloadManager = jest.fn(() => ({ cancelDownload: mockCancelDownload }));
let mockEnabled = true; let mockCache = 'file:///data/user/0/app.qa/cache/';
let mockRecorderState: { phase: string; interrupted?: boolean };
let mockTtsState: { phase: string | null; clipAvailable?: boolean; sampleRate?: number; sampleCount?: number };
let mockVoices: { voices: Record<string, unknown>[]; selectedVoiceId: string | null };
let mockEngineModel = 'base';
let mockThread = 'original';
const mockThreads: Record<string, unknown> = {};
const mockBase = { id: 'base', artifacts: [{ id: 'lora', kind: 'lora_adapter',
  sha256: require('../../docs/validation/llama-rn-stage3/lora-fixture.json').adapter.sha256,
  installState: 'installed', localPath: 'lora.gguf', sizeBytes: 10 }] };
let mockAudioModel: Record<string, unknown>;
let fixtureDesired: ModelMetadata;

jest.mock('expo-file-system/legacy', () => ({ copyAsync: (...args: unknown[]) => mockCopy(...args),
  getInfoAsync: (...args: unknown[]) => mockFileInfo(...args) }));
jest.mock('../../src/services/AudioRecordingService', () => ({ audioRecordingService: {
  getState: () => mockRecorderState, start: (...args: unknown[]) => mockStartRecording(...args),
  stop: () => mockStopRecording(), cancelAndClear: () => mockClearRecording() } }));
jest.mock('../../src/services/storage', () => ({ assertPrivateStorageWritable: jest.fn() }));
jest.mock('../../src/services/AudioPreparationService', () => ({
  AudioPreparationError: jest.requireActual('../../src/services/AudioPreparationService').AudioPreparationError,
  prepareManagedAudio: (...args: unknown[]) => mockPrep(...args),
  discardPreparedAudio: (...args: unknown[]) => mockDiscard(...args) }));
jest.mock('../../src/services/AudioSamplePreviewService', () => ({ audioSamplePreviewService: {
  play: (...args: unknown[]) => mockPreviewPlay(...args), stop: () => mockPreviewStop(), getState: () => ({ phase: 'playing' }) } }));
jest.mock('../../src/services/AndroidQaDocumentModelBootstrap', () => ({ ANDROID_QA_DOCUMENT_MODEL_ID: 'base',
  isAndroidQaDocumentModelBootstrapEnabled: () => mockEnabled }));
jest.mock('../../src/services/AndroidQaStage3', () => ({ getAndroidQaEffectiveProfileIdentity: () => 'profile',
  prepareAndroidQaStage3Adapter: jest.fn(async () => undefined) }));
jest.mock('../../src/services/AndroidQaTts', () => ({ prepareAndroidQaTtsProfile: (...args: unknown[]) => mockPrepareProfile(...args) }));
jest.mock('../../src/services/AndroidQaStage7Seed', () => ({ prepareAndroidQaStage7Seed: (...args: unknown[]) => mockSeed(...args) }));
jest.mock('../../src/services/FileSystemSetup', () => ({ getAppCacheRootDir: () => mockCache }));
jest.mock('../../src/services/LocalStorageRegistry', () => ({ registry: { getModel: (id: string) => id === 'base' ? mockBase : mockAudioModel,
  updateModel: (...args: unknown[]) => mockRegistryUpdate(...args) } }));
jest.mock('../../src/services/ModelDownloadManager', () => ({ getModelDownloadManager: () => mockDownloadManager() }));
jest.mock('../../src/utils/modelArtifacts', () => ({ ...jest.requireActual('../../src/utils/modelArtifacts'),
  getCompanionBindingIdentity: () => 'base-identity' }));
jest.mock('../../src/utils/modelRoles', () => ({ ...jest.requireActual('../../src/utils/modelRoles'),
  getModelFileIdentity: (model: { sha256: string }) => model.sha256 }));
jest.mock('../../src/services/SettingsStore', () => ({ getSettings: () => ({ activeModelId: 'base', auxiliaryModels: {} }), updateSettings: jest.fn() }));
jest.mock('../../src/services/AuxiliaryModelService', () => ({ selectAuxiliaryModel: jest.fn() }));
jest.mock('../../src/store/downloadStore', () => ({ useDownloadStore: { getState: () => ({ queue: [], addToQueue: mockQueue }) } }));
jest.mock('../../src/store/chatStore', () => ({ useChatStore: { getState: () => ({ activeThreadId: mockThread, threads: mockThreads,
  createThread: () => { mockThread = 'owned'; return mockThread; }, deleteThread: jest.fn(),
  setActiveThread: (id: string) => { mockThread = id; } }) } }));
jest.mock('../../src/services/LLMEngineService', () => ({ llmEngineService: {
  getState: () => ({ activeModelId: mockEngineModel, status: 'ready', diagnostics: { backendMode: 'cpu',
    actualGpuAccelerated: false, initNParallel: 1, stateCacheBudgetMb: 0, stateCacheMaxCheckpoints: 8 } }),
  getEffectiveLoadParameters: () => ({ contextSize: 512 }), load: (...args: unknown[]) => mockLoad(...args), unload: jest.fn(),
  hasActiveCompletion: () => false, hasAuxiliaryContextOperation: () => false,
  chatCompletion: (...args: unknown[]) => mockChatCompletion(...args) } }));
jest.mock('../../src/services/TtsService', () => ({ ttsService: { start: (...args: unknown[]) => mockTtsStart(...args),
  getState: () => mockTtsState, play: async () => { mockTtsState.phase = 'playing'; }, stop: jest.fn(async () => undefined),
  cancelAndClear: () => mockTtsClear() } }));
jest.mock('../../src/services/ReferenceVoiceStore', () => ({ referenceVoiceStore: { hydrate: jest.fn(), getState: () => mockVoices,
  save: (...args: unknown[]) => mockSave(...args), select: (id: string) => { mockVoices.selectedVoiceId = id; },
  delete: (...args: unknown[]) => mockDelete(...args) } }));

const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
async function until(phase: string) {
  for (let i = 0; i < 20; i++) { await flush(); if (getAndroidQaAudioStage7Evidence().phase === phase) return; await jest.advanceTimersByTimeAsync(400); }
  throw new Error(`Expected ${phase}, saw ${getAndroidQaAudioStage7Evidence().phase}`);
}
beforeAll(async () => {
  mockAudioModel = {};
  mockSeed.mockImplementationOnce(async (_kind: string, desired: ModelMetadata) => {
    fixtureDesired = desired; return desired;
  });
  await prepareAndroidQaStage7AudioModel();
});
beforeEach(() => {
  jest.useFakeTimers(); jest.clearAllMocks(); mockEnabled = true; mockCache = 'file:///data/user/0/app.qa/cache/';
  mockRecorderState = { phase: 'idle' }; mockTtsState = { phase: null }; mockVoices = { voices: [], selectedVoiceId: null };
  mockEngineModel = 'base'; mockThread = 'original';
  mockSeed.mockResolvedValue(null); mockCancelDownload.mockResolvedValue(undefined);
  mockRegistryUpdate.mockImplementation((model: ModelMetadata) => { mockAudioModel = model as unknown as Record<string, unknown>; });
  mockQueue.mockImplementation((model: ModelMetadata) => { mockAudioModel = installedAudioModel(model) as unknown as Record<string, unknown>; });
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  mockStartRecording.mockImplementation(async () => { mockRecorderState = { phase: 'recording' }; });
  mockStopRecording.mockImplementation(async () => { mockRecorderState = { phase: 'ready' }; return { uri: 'file:///source.m4a', durationMillis: 1000, byteSize: 200 }; });
  mockClearRecording.mockImplementation(async () => { mockRecorderState = { phase: 'idle' }; });
  mockPrep.mockImplementation(async ({ sourceUri }: { sourceUri: string }) => {
    const expected = syntheticFixtures.fixtures.find(item => sourceUri.endsWith(item.filename));
    return { uri: 'file:///prepared.wav', sampleRate: expected?.sampleRate ?? 16000,
      sampleCount: expected?.sampleCount ?? 24000, durationMs: expected?.durationMs ?? 1000, sizeBytes: 48044,
      sourceSha256: expected?.sha256 ?? 'a'.repeat(64) };
  });
  mockDiscard.mockResolvedValue(undefined); mockPreviewPlay.mockResolvedValue(undefined); mockPreviewStop.mockResolvedValue(undefined);
  mockCopy.mockResolvedValue(undefined); mockFileInfo.mockImplementation(async (uri: string) => ({ exists: !uri.includes('source.m4a') }));
  mockLoad.mockImplementation(async (id: string) => { mockEngineModel = id; });
  mockChatCompletion.mockImplementation(async (request: { onToken: (value: string) => void }) => {
    request.onToken('token'); return { text: 'orange seven', content: 'orange seven' };
  });
  mockPrepareProfile.mockImplementation(async (profile: { id: string }) => ({ id: profile.id }));
  mockTtsClear.mockImplementation(async () => { mockTtsState = { phase: null }; });
  mockTtsStart.mockImplementation(async (request: TtsRequest) => {
    const settled = (operation: string, extra = {}) => request.observe?.({ operation, phase: 'settled', ...extra } as never);
    settled('vocoder_init');
    if (request.voice?.kind === 'reference') { settled('speaker_create'); if (request.voice.bake === 'eager') settled('speaker_bake'); }
    if (request.voice?.kind === 'builtin') settled('phonemizer', { elapsedMs: 10 });
    settled('formatter', request.voice?.kind === 'reference' ? { speakerRows: 1, speakerBaked: true } : {});
    settled('completion'); settled('decode', { sampleRate: 24000, sampleCount: 24000 });
    if (request.voice?.kind === 'reference') settled('speaker_release'); settled('vocoder_release');
    mockTtsState = { phase: 'ready', clipAvailable: true, sampleRate: 24000, sampleCount: 24000 };
  });
  mockSave.mockImplementation(async (input: Record<string, unknown>) => {
    const voice = { id: 'qa-saved', name: input.name, sourceSha256: input.sourceSha256 };
    mockVoices.voices = [voice]; return voice;
  });
  mockDelete.mockImplementation(async () => { mockVoices = { voices: [], selectedVoiceId: null }; });
  mockAudioModel = installedAudioModel(fixtureDesired) as unknown as Record<string, unknown>;
});
afterEach(() => jest.useRealTimers());

function installedAudioModel(model: ModelMetadata): ModelMetadata {
  const source = fixture.audioInput;
  return normalizePersistedModelMetadata({ ...model, localPath: 'verified-audio.gguf', lifecycleStatus: LifecycleStatus.DOWNLOADED,
    metadataTrust: 'verified_local', downloadIntegrity: { kind: 'sha256', sha256: source.backbone.sha256,
      sizeBytes: source.backbone.bytes, checkedAt: 1 },
    artifacts: model.artifacts?.map(artifact => ({ ...artifact, localPath: 'verified-projector.gguf',
      installState: 'installed', integrity: { kind: 'sha256', sha256: source.projector.sha256,
        sizeBytes: source.projector.bytes, checkedAt: 1 } })),
    projectorCandidates: model.projectorCandidates?.map(candidate => ({ ...candidate,
      localPath: 'verified-projector.gguf', lifecycleStatus: 'downloaded' })),
    multimodalReadiness: { modelId: model.id, status: 'ready', projectorId: model.selectedProjectorId,
      support: ['audio'], checkedAt: 1 } });
}

describe('audio fixture seed consumer', () => {
  it('returns the verified seed without caller publication or a download enqueue', async () => {
    mockAudioModel = {};
    let verified: ModelMetadata | undefined;
    mockSeed.mockImplementationOnce(async (kind: string, desired: ModelMetadata) => {
      expect(kind).toBe('ultravox'); verified = installedAudioModel(desired); return verified;
    });
    const actual = await prepareAndroidQaStage7AudioModel();
    expect(actual).toBe(verified);
    expect(mockSeed).toHaveBeenCalledWith('ultravox', expect.objectContaining({
      id: 'pocket-ai/android-qa-ultravox-1b', sha256: fixture.audioInput.backbone.sha256,
      selectedProjectorId: fixtureDesired.selectedProjectorId }));
    expect(mockRegistryUpdate).not.toHaveBeenCalled(); expect(mockQueue).not.toHaveBeenCalled();
    expect(mockDownloadManager).not.toHaveBeenCalled(); expect(mockCancelDownload).not.toHaveBeenCalled();
  });

  it('keeps the ordinary registry and queue fallback when the pair is entirely absent', async () => {
    mockAudioModel = {};
    const actual = await prepareAndroidQaStage7AudioModel();
    expect(mockSeed).toHaveBeenCalledTimes(1); expect(mockRegistryUpdate).toHaveBeenCalledTimes(1);
    expect(mockQueue).toHaveBeenCalledTimes(1);
    expect(mockQueue).toHaveBeenCalledWith(mockRegistryUpdate.mock.calls[0][0]);
    expect(actual).toMatchObject({ localPath: 'verified-audio.gguf', artifacts: expect.arrayContaining([
      expect.objectContaining({ installState: 'installed', localPath: 'verified-projector.gguf' })]) });
    expect(mockCancelDownload).not.toHaveBeenCalled(); expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['partial', 'invalid'])('propagates a %s seed rejection without falling through to downloads', async () => {
    mockAudioModel = {};
    const rejected = new Error('stage7_seed_invalid'); mockSeed.mockRejectedValueOnce(rejected);
    await expect(prepareAndroidQaStage7AudioModel()).rejects.toBe(rejected);
    expect(mockRegistryUpdate).not.toHaveBeenCalled(); expect(mockQueue).not.toHaveBeenCalled();
    expect(mockDownloadManager).not.toHaveBeenCalled(); expect(mockCancelDownload).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('reuses an already verified registry pair without accessing staged seeds', async () => {
    await expect(prepareAndroidQaStage7AudioModel()).resolves.toBe(mockAudioModel);
    expect(mockSeed).not.toHaveBeenCalled(); expect(mockRegistryUpdate).not.toHaveBeenCalled();
    expect(mockQueue).not.toHaveBeenCalled();
  });

  it('cold-reuses actual normalized canonical projector metadata without reseeding or enqueuing downloads', async () => {
    const current = normalizePersistedModelMetadata(mockAudioModel as unknown as ModelMetadata);
    mockAudioModel = current as unknown as Record<string, unknown>;
    const selected = current.artifacts?.find(item => item.id === current.selectedProjectorId)!;
    expect(current.selectedProjectorId).not.toBe('android-qa-stage7-ultravox-projector');
    expect(selected.downloadUrl).not.toContain('?download=true');
    await expect(prepareAndroidQaStage7AudioModel()).resolves.toBe(current);
    expect(mockSeed).not.toHaveBeenCalled(); expect(mockRegistryUpdate).not.toHaveBeenCalled();
    expect(mockQueue).not.toHaveBeenCalled(); expect(mockDownloadManager).not.toHaveBeenCalled();
  });

  it.each(['downloadUrl', 'hfRevision', 'remoteFileName', 'sha256', 'sizeBytes', 'selection'] as const)(
    'does not cold-reuse or overwrite a conflicting selected projector (%s)', async field => {
      const current = mockAudioModel as unknown as ModelMetadata;
      const selected = current.artifacts?.find(item => item.id === current.selectedProjectorId)!;
      if (field === 'downloadUrl') selected.downloadUrl = selected.downloadUrl.replace(fixture.audioInput.revision, 'changed-revision');
      if (field === 'hfRevision') selected.hfRevision = 'changed-revision';
      if (field === 'remoteFileName') selected.remoteFileName = 'changed.gguf';
      if (field === 'sha256') selected.sha256 = 'b'.repeat(64);
      if (field === 'sizeBytes') selected.sizeBytes = (selected.sizeBytes ?? 0) + 1;
      if (field === 'selection') current.selectedProjectorId = 'other-projector';
      const snapshot = JSON.stringify(current);
      mockSeed.mockRejectedValueOnce(new Error('stage7_seed_invalid'));
      await expect(prepareAndroidQaStage7AudioModel()).rejects.toThrow('stage7_seed_invalid');
      expect(mockSeed).toHaveBeenCalledTimes(1);
      expect(mockRegistryUpdate).not.toHaveBeenCalled(); expect(mockQueue).not.toHaveBeenCalled();
      expect(JSON.stringify(current)).toBe(snapshot);
    },
  );
});

it('refuses fixture/native activity outside the flagged isolated package', async () => {
  mockCache = 'file:///data/user/0/app/cache/'; expect(isAndroidQaAudioStage7Enabled()).toBe(false);
  await runAndroidQaStage7Recording(); expect(mockStartRecording).not.toHaveBeenCalled();
});
it.each(['module_init', 'conversion', 'deadline', 'invalid_output'] as const)(
  'publishes the finite phonemizer %s diagnostic through actual voices failure and host sanitization', async reason => {
    const failure = new TtsError('phonemizer_failed', { reason, elapsedMs: 1001, moduleInitMs: 30 });
    Object.assign(failure, { message: 'private input', uri: 'file:///private', phones: 'private IPA', native: 'private payload' });
    mockTtsStart.mockRejectedValueOnce(new TtsCleanupError(failure));
    await runAndroidQaStage7Voices();
    const evidence = getAndroidQaAudioStage7Evidence();
    expect(evidence).toMatchObject({ status: 'failed', failureCode: 'phonemizer_failed', steps: [],
      phonemizerFailure: { reason, elapsedMs: 1001, moduleInitMs: 30 } });
    const safe = sanitizeAudioStage7Evidence(evidence);
    expect(safe).toMatchObject({ phonemizerFailure: evidence.phonemizerFailure });
    expect(JSON.stringify(evidence)).not.toMatch(/private|IPA|payload|file:\/\/|"message"|"phones"/u);
    expect(JSON.stringify(safe)).not.toMatch(/private|IPA|payload|file:\/\//u);
    expect(mockTtsClear).toHaveBeenCalledTimes(1); expect(mockSave).not.toHaveBeenCalled();
  },
);
it.each(['unknown', 'negative', 'inconsistent', 'other-code'])(
  'rejects malformed phonemizer diagnostics in the actual QA consumer (%s)', async kind => {
    const failure = new TtsError(kind === 'other-code' ? 'cancelled' : 'phonemizer_failed');
    Object.assign(failure, { phonemizerFailure: { reason: kind === 'unknown' ? 'private' : 'deadline',
      elapsedMs: kind === 'negative' ? -1 : 1, moduleInitMs: kind === 'inconsistent' ? 2 : 0, phones: 'private' } });
    mockTtsStart.mockRejectedValueOnce(failure);
    await runAndroidQaStage7Voices();
    const evidence = getAndroidQaAudioStage7Evidence();
    expect(evidence.phonemizerFailure).toBeUndefined();
    expect(sanitizeAudioStage7Evidence(evidence)).not.toHaveProperty('phonemizerFailure');
    expect(JSON.stringify(evidence)).not.toContain('private');
  },
);
it('awaits actual controlled capture, preparation and real background draft before passing', async () => {
  const work = runAndroidQaStage7Recording(); await until('recording_awaiting_controlled_sound');
  expect(mockStopRecording).not.toHaveBeenCalled(); continueAndroidQaAudioStage7();
  await until('awaiting_clip_copy'); expect(mockStopRecording).toHaveBeenCalledTimes(1); expect(mockPrep).toHaveBeenCalled();
  continueAndroidQaAudioStage7(); await until('recording_awaiting_background');
  mockRecorderState = { phase: 'ready', interrupted: true }; continueAndroidQaAudioStage7();
  await jest.advanceTimersByTimeAsync(500); await work;
  expect(getAndroidQaAudioStage7Evidence().status).toBe('native_passed'); expect(mockStartRecording).toHaveBeenCalledTimes(2);
  expect(mockClearRecording).toHaveBeenCalledTimes(2);
});
it('never converts a false start receipt into native recording proof', async () => {
  mockStartRecording.mockResolvedValueOnce(undefined); await runAndroidQaStage7Recording();
  expect(getAndroidQaAudioStage7Evidence()).toMatchObject({ status: 'failed', failureCode: 'recorder_not_recording' });
  expect(mockPrep).not.toHaveBeenCalled(); expect(mockClearRecording).toHaveBeenCalled();
});
it.each([
  ['invalid_audio', 'audio_preparation_invalid_audio'],
  ['audio_limit', 'audio_preparation_limit'],
  ['cancelled', 'audio_preparation_cancelled'],
  ['preparation_failed', 'audio_preparation_failed'],
  ['cleanup_failed', 'audio_preparation_cleanup_failed'],
] as const)('preserves only the finite preparation code %s through the real QA run catch', async (code, expected) => {
  const error = Object.assign(new AudioPreparationError(code), {
    message: 'sensitive preparation message', uri: 'file:///personal-voice.m4a', stack: 'sensitive preparation stack',
  });
  mockPrep.mockRejectedValueOnce(error);
  const work = runAndroidQaStage7Recording(); await until('recording_awaiting_controlled_sound');
  continueAndroidQaAudioStage7(); await work;
  const evidence = getAndroidQaAudioStage7Evidence();
  expect(evidence).toMatchObject({ status: 'failed', phase: 'complete', failureCode: expected });
  expect(evidence.steps.map(step => step.id)).toEqual(['recording_started', 'recording_finalized']);
  const safe = sanitizeAudioStage7Evidence(evidence);
  expect(safe).toMatchObject({ failureCode: expected });
  for (const forbidden of ['sensitive', 'personal-voice', 'file:///', '"message"', '"uri"', '"stack"']) {
    expect(JSON.stringify(evidence)).not.toContain(forbidden);
    expect(JSON.stringify(safe)).not.toContain(forbidden);
  }
  expect(mockPreviewPlay).not.toHaveBeenCalled();
  expect(mockPreviewStop).toHaveBeenCalledTimes(1); expect(mockClearRecording).toHaveBeenCalledTimes(1);
});
it.each(['untyped', 'unknown'])('rejects %s preparation-shaped codes without publishing their payload', async kind => {
  const error = kind === 'untyped'
    ? Object.assign(new Error('sensitive preparation message'), { code: 'cleanup_failed' })
    : new AudioPreparationError('__proto__' as never);
  mockPrep.mockRejectedValueOnce(error);
  const work = runAndroidQaStage7Recording(); await until('recording_awaiting_controlled_sound');
  continueAndroidQaAudioStage7(); await work;
  expect(getAndroidQaAudioStage7Evidence()).toMatchObject({ status: 'failed', failureCode: 'qa_operation_failed' });
  expect(JSON.stringify(getAndroidQaAudioStage7Evidence())).not.toMatch(/sensitive|__proto__/u);
});
it.each([
  ['native_result', 'audio_preparation_native_result'], ['prepared_uri', 'audio_preparation_prepared_uri'],
  ['channels', 'audio_preparation_channels'], ['sample_rate', 'audio_preparation_sample_rate'],
  ['sample_count', 'audio_preparation_sample_count'], ['output_size', 'audio_preparation_output_size'],
  ['source_hash', 'audio_preparation_source_hash'], ['output_hash', 'audio_preparation_output_hash'],
  ['native_input', 'audio_preparation_native_input'], ['native_admission', 'audio_preparation_native_admission'],
  ['native_sniff', 'audio_preparation_native_sniff'], ['native_output', 'audio_preparation_native_output'],
  ['native_decode', 'audio_preparation_native_decode'], ['native_identity', 'audio_preparation_native_identity'],
  ['native_delivery', 'audio_preparation_native_delivery'],
] as const)('preserves the finite reason %s through the actual QA catch and host sanitizer', async (reason, expected) => {
  mockPrep.mockRejectedValueOnce(Object.assign(new AudioPreparationError('preparation_failed', reason), {
    message: 'sensitive reason message', uri: 'file:///private-reference.m4a', sourceSha256: 'private-source-hash',
    data: 'encoded-private-source', stack: 'sensitive reason stack',
  }));
  const work = runAndroidQaStage7Recording(); await until('recording_awaiting_controlled_sound');
  continueAndroidQaAudioStage7(); await work;
  const evidence = getAndroidQaAudioStage7Evidence();
  const safe = sanitizeAudioStage7Evidence(evidence);
  expect(evidence).toMatchObject({ status: 'failed', failureCode: expected });
  expect(safe).toMatchObject({ failureCode: expected });
  for (const forbidden of ['sensitive', 'private-reference', 'private-source-hash', 'encoded-private-source', '"safeReason"']) {
    expect(JSON.stringify(evidence)).not.toContain(forbidden);
    expect(JSON.stringify(safe)).not.toContain(forbidden);
  }
  expect(mockPreviewPlay).not.toHaveBeenCalled(); expect(mockClearRecording).toHaveBeenCalledTimes(1);
});
it.each(['__proto__', 'file:///private-reference.m4a', { uri: 'file:///private-reference.m4a' }])(
  'falls back to the finite code when the reason is malformed (%s)', async reason => {
    mockPrep.mockRejectedValueOnce(new AudioPreparationError('preparation_failed', reason as never));
    const work = runAndroidQaStage7Recording(); await until('recording_awaiting_controlled_sound');
    continueAndroidQaAudioStage7(); await work;
    const evidence = getAndroidQaAudioStage7Evidence();
    expect(evidence).toMatchObject({ status: 'failed', failureCode: 'audio_preparation_failed' });
    expect(sanitizeAudioStage7Evidence(evidence)).toMatchObject({ failureCode: 'audio_preparation_failed' });
    expect(JSON.stringify(evidence)).not.toMatch(/__proto__|private-reference|safeReason/u);
  },
);
it('does not let a known reason override an unknown preparation code', async () => {
  mockPrep.mockRejectedValueOnce(new AudioPreparationError('private-code' as never, 'native_input'));
  const work = runAndroidQaStage7Recording(); await until('recording_awaiting_controlled_sound');
  continueAndroidQaAudioStage7(); await work;
  expect(getAndroidQaAudioStage7Evidence()).toMatchObject({ status: 'failed', failureCode: 'qa_operation_failed' });
  expect(JSON.stringify(getAndroidQaAudioStage7Evidence())).not.toMatch(/private-code|native_input/u);
});
it('requires actual background finalization rather than the return-to-foreground gate alone', async () => {
  const work = runAndroidQaStage7Recording(); await until('recording_awaiting_controlled_sound'); continueAndroidQaAudioStage7();
  await until('awaiting_clip_copy'); continueAndroidQaAudioStage7(); await until('recording_awaiting_background');
  continueAndroidQaAudioStage7(); await work;
  expect(getAndroidQaAudioStage7Evidence()).toMatchObject({ status: 'failed', failureCode: 'background_not_finalized' });
});
it('sends separately prepared imported and recorded WAVs through the real input_audio service contract', async () => {
  mockPrep.mockImplementation(async ({ sourceUri }: { sourceUri: string }) => ({ uri: sourceUri, sampleRate: 16000,
    sampleCount: sourceUri.endsWith('input-orange-seven.wav') ? 57280 : 1000,
    sourceSha256: sourceUri.endsWith('input-orange-seven.wav') ? syntheticFixtures.fixtures[2].sha256 : 'c'.repeat(64) }));
  await runAndroidQaStage7Input();
  expect(mockChatCompletion).toHaveBeenCalledTimes(2);
  const requests = mockChatCompletion.mock.calls.map(call => call[0]);
  expect(requests[0].messages[0].contentParts[1]).toMatchObject({ type: 'input_audio', input_audio: { format: 'wav' } });
  expect(requests[0].messages[0].contentParts[1].input_audio.url).toContain('input-orange-seven.wav');
  expect(requests[1].messages[0].contentParts[1].input_audio.url).toContain('recorded.wav');
  expect(getAndroidQaAudioStage7Evidence().status).toBe('native_passed'); expect(mockQueue).not.toHaveBeenCalled();
  expect(mockEngineModel).toBe('base');
});
it('refuses a successful completion callback that misses the controlled audio content', async () => {
  mockChatCompletion.mockImplementationOnce(async (request: { onToken: (value: string) => void }) => {
    request.onToken('token'); return { text: 'I cannot hear it.' };
  });
  await runAndroidQaStage7Input();
  expect(getAndroidQaAudioStage7Evidence()).toMatchObject({ status: 'failed', failureCode: 'audio_imported_content_mismatch' });
  expect(mockChatCompletion).toHaveBeenCalledTimes(1); expect(mockDiscard).toHaveBeenCalled();
});

it('rejects changed fixture bytes before giving unrelated audio to the native model', async () => {
  mockPrep.mockResolvedValueOnce({ uri: 'file:///prepared.wav', sampleRate: 16000, sampleCount: 57280,
    sourceSha256: 'd'.repeat(64) });
  await runAndroidQaStage7Input();
  expect(getAndroidQaAudioStage7Evidence()).toMatchObject({ status: 'failed', failureCode: 'synthetic_fixture_identity_mismatch' });
  expect(mockChatCompletion).not.toHaveBeenCalled(); expect(mockDiscard).toHaveBeenCalled();
});
it('runs fixed-target builtin/eager/lazy/no-reference consumers and cold saved deletion without handles', async () => {
  const work = runAndroidQaStage7Voices();
  for (const id of ['neu-jo', 'qwen-r1-eager', 'qwen-r2-lazy', 'qwen-no-reference']) {
    await until('awaiting_clip_copy'); expect(getAndroidQaAudioStage7Evidence().clipId).toBe(id);
    continueAndroidQaAudioStage7();
  }
  await work; expect(getAndroidQaAudioStage7Evidence().status).toBe('native_passed');
  const requests = mockTtsStart.mock.calls.map(call => call[0]);
  expect(new Set(requests.map(request => request.text)).size).toBe(1);
  expect(requests.map(request => request.voice.kind)).toEqual(['builtin', 'reference', 'reference', 'speakerless']);
  expect(requests[1].voice.bake).toBe('eager'); expect(requests[2].voice.bake).toBe('lazy');
  mockTtsState = { phase: null }; const cold = checkAndroidQaStage7ColdVoice();
  await until('awaiting_clip_copy'); expect(getAndroidQaAudioStage7Evidence().clipId).toBe('qwen-saved-cold');
  continueAndroidQaAudioStage7(); await cold;
  expect(getAndroidQaAudioStage7Evidence().status).toBe('native_passed'); expect(mockDelete).toHaveBeenCalledWith('qa-saved');
  expect(mockTtsStart.mock.calls.at(-1)?.[0].voice.source).toMatchObject({ kind: 'saved', voiceId: 'qa-saved' });
});
it('requires an actual formatter speaker receipt before a reference path can pass', async () => {
  const original = mockTtsStart.getMockImplementation()!;
  mockTtsStart.mockImplementation(async (request: TtsRequest) => original({ ...request, observe: (event: unknown) => {
    const typed = event as { operation: string; speakerBaked?: boolean };
    request.observe?.({ ...typed, ...(typed.operation === 'formatter' ? { speakerBaked: false } : {}) } as never);
  } }));
  const work = runAndroidQaStage7Voices(); await until('awaiting_clip_copy'); continueAndroidQaAudioStage7();
  await work; expect(getAndroidQaAudioStage7Evidence()).toMatchObject({ status: 'failed', failureCode: 'reference_not_used' });
});
