import type { LlamaContext } from 'llama.rn';
import * as FileSystem from 'expo-file-system/legacy';
import * as RNFS from 'react-native-fs';
import { TtsService, resolveTtsBinding, getTtsSelectionStatus } from '../../src/services/TtsService';
import { selectAuxiliaryModel, validateAuxiliaryFile } from '../../src/services/AuxiliaryModelService';
import { llmEngineService, type AuxiliaryContextRequest, type AuxiliaryContextSequence,
  type AuxiliarySequenceRequest } from '../../src/services/LLMEngineService';
import { runWithIdleModelDownloads } from '../../src/services/ModelDownloadManager';
import { registry } from '../../src/services/LocalStorageRegistry';
import { getSettings, resetSettings, updateSettings } from '../../src/services/SettingsStore';
import * as settingsStore from '../../src/services/SettingsStore';
import { getSystemMemorySnapshot } from '../../src/services/SystemMetricsService';
import { DEFAULT_TTS_PROFILE_ID, TTS_EXECUTION_PROFILES, getTtsInitParameters, estimateTtsPeakBytes,
  type TtsExecutionProfile } from '../../src/services/TtsExecutionProfiles';
import { synthesizeTtsOnContext, type TtsPcmResult } from '../../src/services/TtsSynthesisRuntime';
import { TtsPlaybackController } from '../../src/services/TtsPlayback';
import { useChatStore } from '../../src/store/chatStore';
import { useDownloadStore } from '../../src/store/downloadStore';
import { bindManagedCompanion } from '../../src/utils/modelArtifacts';
import { TtsCleanupError, TtsError, type TtsObservation } from '../../src/types/tts';
import { EngineStatus, LifecycleStatus, ModelAccessState, type EngineState, type ModelMetadata } from '../../src/types/models';
import * as audioPreparation from '../../src/services/AudioPreparationService';
import { referenceVoiceStore, type ReferenceVoiceLease } from '../../src/services/ReferenceVoiceStore';
import * as androidQaEvidence from '../../src/services/AndroidQaGenerationEvidence';

jest.mock('../../src/services/LLMEngineService', () => ({ llmEngineService: {
  getState: jest.fn(), hasAuxiliaryContextOperation: jest.fn(() => false),
  hasActiveCompletion: jest.fn(() => false), hasActiveChatBlockingContextOperation: jest.fn(() => false),
  runWithAuxiliarySequence: jest.fn(),
  runWithIdleModelResources: jest.fn((operation: () => Promise<unknown>) => operation()),
} }));
jest.mock('../../src/services/AuxiliaryModelService', () => ({
  ...jest.requireActual('../../src/services/AuxiliaryModelService'), validateAuxiliaryFile: jest.fn(),
}));
jest.mock('../../src/services/SystemMetricsService', () => ({ getSystemMemorySnapshot: jest.fn() }));
jest.mock('../../src/services/FileSystemSetup', () => ({ getModelsDir: () => 'file:///models/' }));
jest.mock('../../src/utils/ggufValidation', () => ({
  validateGgufFileHeader: jest.fn(async () => ({ ok: true })), GgufValidationError: class extends Error {},
}));
jest.mock('../../src/services/TtsSynthesisRuntime', () => ({ synthesizeTtsOnContext: jest.fn() }));
jest.mock('../../src/services/TtsPlayback', () => ({
  TtsPlaybackController: jest.fn().mockImplementation(() => ({
    subscribe: jest.fn(() => () => undefined),
    getState: jest.fn(() => ({ phase: 'stopped', position: 0, duration: 0 })),
    cancelStart: jest.fn(), clear: jest.fn(async () => undefined), stop: jest.fn(async () => undefined),
    setClip: jest.fn(async () => undefined), play: jest.fn(async () => undefined),
    pause: jest.fn(async () => undefined), replay: jest.fn(async () => undefined),
  })), cleanupColdTtsClips: jest.fn(async () => undefined),
}));


// Integration boundary: a loaded clip with an accepted Play never fabricates
// playing=true. Only a deliberately delivered native snapshot can confirm it.
const mockClipFiles = new Map<string, Uint8Array>();
const mockClipDirectories = new Set<string>();
const mockClipWrite = jest.fn();
const mockClipDelete = jest.fn();
const mockCreateNativePlayer = jest.fn();
jest.mock('expo-audio', () => ({ setAudioModeAsync: jest.fn(async () => undefined),
  createAudioPlayer: (...args: unknown[]) => mockCreateNativePlayer(...args) }));
jest.mock('expo-file-system', () => {
  const join = (parts: (string | { uri: string })[]) => parts.map(p => typeof p === 'string' ? p : p.uri)
    .reduce((result, part, index) => index === 0 ? part : result.replace(/\/$/, '') + '/' + part.replace(/^\/+/, ''), '');
  class Directory {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) { this.uri = join(parts); }
    get exists() { return mockClipDirectories.has(this.uri); }
    create() { mockClipDirectories.add(this.uri); }
    list() { return Array.from(mockClipFiles.keys()).filter(p => p.startsWith(this.uri + '/')).map(p => new File(p)); }
  }
  class File {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) { this.uri = join(parts); }
    get name() { return this.uri.split('/').at(-1); }
    get parentDirectory() { return new Directory(this.uri.slice(0, this.uri.lastIndexOf('/'))); }
    get exists() { return mockClipFiles.has(this.uri); }
    get size() { return mockClipFiles.get(this.uri)?.length ?? 0; }
    create() { mockClipFiles.set(this.uri, new Uint8Array()); }
    write(bytes: Uint8Array) { mockClipWrite(bytes); mockClipFiles.set(this.uri, bytes); }
    delete() { mockClipDelete(); mockClipFiles.delete(this.uri); }
  }
  return { File, Directory, Paths: { cache: { uri: 'file:///test-cache' } } };
});

const engine = jest.mocked(llmEngineService);
const synthesize = jest.mocked(synthesizeTtsOnContext);
const tokensProfile = TTS_EXECUTION_PROFILES.find(profile => profile.flow === 'tokens')!;
const continuousProfile = TTS_EXECUTION_PROFILES.find(profile => profile.flow === 'continuous_embd')!;
const qwenProfile = TTS_EXECUTION_PROFILES.find(profile => profile.family === 'qwen3_tts')!;
const chatId = 'chat/a';
let service: TtsService;
let playback: jest.Mocked<TtsPlaybackController>;
let state: EngineState;
let contextRequests: AuxiliaryContextRequest[];
let sequenceRequests: AuxiliarySequenceRequest[];
let events: string[];
let releaseContext: jest.Mock<Promise<void>, []>;
let restoreA: jest.Mock<Promise<void>, []>;
let initContext: jest.Mock;
let settleTestGates: (() => void)[];
// The engine/native boundary is the only partial context; the service request types are real.
const context = {} as LlamaContext;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // A failed assertion must not leave a task-owned deferred callback hanging in afterEach.
  settleTestGates.push(() => resolve(undefined as T));
  return { promise, resolve, reject };
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 120 && !predicate(); i++) await Promise.resolve();
  expect(predicate()).toBe(true);
}
function pcm(profile = tokensProfile): TtsPcmResult {
  return { samples: [0.25, -0.25], sampleRate: profile.sampleRate, flow: profile.flow,
    audioElements: 4, promptTokens: 3 };
}
function chatModel(): ModelMetadata {
  return { id: chatId, name: 'Chat A', author: 'test', size: 1024,
    downloadUrl: 'https://example.com/a.gguf', resolvedFileName: 'a.gguf', localPath: 'a.gguf',
    sha256: 'a'.repeat(64), accessState: ModelAccessState.PUBLIC, isGated: false,
    isPrivate: false, fitsInRam: true, lifecycleStatus: LifecycleStatus.DOWNLOADED, downloadProgress: 1 };
}
function ttsModel(profile: TtsExecutionProfile): ModelMetadata {
  const model: ModelMetadata = { id: `tts/${profile.flow}`, name: profile.id, author: 'test',
    size: profile.backbone.bytes,
    downloadUrl: `https://huggingface.co/${profile.backbone.repository}/resolve/${profile.backbone.revision}/${profile.backbone.filename}`,
    hfRevision: profile.backbone.revision, resolvedFileName: profile.backbone.filename,
    localPath: `${profile.flow}-backbone-original.gguf`, sha256: profile.backbone.sha256,
    accessState: ModelAccessState.PUBLIC, isGated: false, isPrivate: false, fitsInRam: null,
    lifecycleStatus: LifecycleStatus.DOWNLOADED, downloadProgress: 1,
    roleEvidence: [{ role: 'tts', source: 'pipeline_tag', confidence: 'declared' }] };
  const bound = bindManagedCompanion(model, { kind: 'tts_codec',
    downloadUrl: `https://huggingface.co/${profile.codec.repository}/resolve/${profile.codec.revision}/${profile.codec.filename}`,
    sha256: profile.codec.sha256, sizeBytes: profile.codec.bytes });
  return { ...bound, artifacts: bound.artifacts!.map(artifact => ({ ...artifact,
    installState: 'installed' as const, localPath: `${profile.flow}-codec-original.gguf` })) };
}
function choose(profile = tokensProfile) {
  selectAuxiliaryModel('tts', registry.getModel(`tts/${profile.flow}`)!);
}
function createAssistantSource() {
  const threadId = useChatStore.getState().createThread({ modelId: chatId, presetId: null,
    presetSnapshot: { id: 'default', name: 'Default', systemPrompt: 'Private system instructions.' },
    paramsSnapshot: { temperature: 0.7, topP: 0.9, maxTokens: 128, seed: 77 } });
  const thread = useChatStore.getState().threads[threadId];
  useChatStore.setState({ threads: { [threadId]: { ...thread, messages: [{ id: 'answer',
    role: 'assistant', content: 'Hello.', thoughtContent: 'Private reasoning.', createdAt: 1,
    state: 'complete' }] } }, activeThreadId: threadId });
  return { threadId, messageId: 'answer' };
}
async function normalSequence<T>(request: AuxiliarySequenceRequest,
  operation: (sequence: AuxiliaryContextSequence) => Promise<T>): Promise<T> {
  sequenceRequests.push(request);
  events.push('detach-a');
  state = { status: EngineStatus.IDLE, loadProgress: 0 };
  const sequence: AuxiliaryContextSequence = { withContext: async <R>(phase: AuxiliaryContextRequest,
    callback: (native: LlamaContext) => Promise<R>): Promise<R> => {
    contextRequests.push(phase);
    await phase.beforeInit?.();
    initContext(phase.initParams);
    events.push('init-tts');
    try { return await callback(context); }
    finally { await releaseContext(); events.push('context-released'); }
  } };
  try { return await operation(sequence); }
  finally {
    if (request.isSelectionCurrent?.()) {
      await restoreA();
      state = { status: EngineStatus.READY, activeModelId: chatId, loadProgress: 1 };
      events.push('a-restored');
    }
  }
}

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  resetSettings();
  registry.invalidatePrivateStorageRuntimeState();
  useChatStore.setState({ threads: {}, activeThreadId: null });
  useDownloadStore.setState({ queue: [], activeDownloadId: null });
  registry.saveModels([chatModel(), ttsModel(tokensProfile), ttsModel(continuousProfile)]);
  updateSettings({ activeModelId: chatId,
    modelLoadParamsByModelId: { [chatId]: { contextSize: 2048, gpuLayers: 0, kvCacheType: 'f16', cpuThreads: 2 } },
    modelParamsByModelId: { [chatId]: { temperature: 0.7, topP: 0.9, topK: 40,
      minP: 0.05, repetitionPenalty: 1.1, maxTokens: 128, seed: 77 } } });
  state = { status: EngineStatus.READY, activeModelId: chatId, loadProgress: 1 };
  engine.getState.mockImplementation(() => state);
  engine.hasAuxiliaryContextOperation.mockReturnValue(false);
  engine.hasActiveCompletion.mockReturnValue(false);
  engine.hasActiveChatBlockingContextOperation.mockReturnValue(false);
  engine.runWithAuxiliarySequence.mockImplementation(normalSequence);
  contextRequests = []; sequenceRequests = []; events = [];
  releaseContext = jest.fn(async () => undefined);
  restoreA = jest.fn(async () => undefined);
  initContext = jest.fn();
  settleTestGates = [];
  jest.mocked(validateAuxiliaryFile).mockReset();
  jest.mocked(FileSystem.getInfoAsync).mockReset();
  jest.mocked(RNFS.hash).mockReset();
  jest.mocked(getSystemMemorySnapshot).mockReset();
  synthesize.mockReset();
  jest.mocked(validateAuxiliaryFile).mockImplementation(async model => `/models/${model.localPath}`);
  jest.mocked(FileSystem.getInfoAsync).mockImplementation(async uri => {
    const profile = String(uri).includes('continuous_embd') ? continuousProfile : tokensProfile;
    return { exists: true, isDirectory: false, uri: String(uri), size: profile.codec.bytes, modificationTime: 1 };
  });
  jest.mocked(RNFS.hash).mockImplementation(async path => String(path).includes('continuous_embd')
    ? continuousProfile.codec.sha256 : tokensProfile.codec.sha256);
  jest.mocked(getSystemMemorySnapshot).mockResolvedValue({ availableBytes: 32 * 2 ** 30,
    freeBytes: 32 * 2 ** 30, thresholdBytes: 0, lowMemory: false } as never);
  synthesize.mockImplementation(async (_native, profile) => pcm(profile));
  service = new TtsService();
  const playerConstructor = TtsPlaybackController as jest.MockedClass<typeof TtsPlaybackController>;
  playback = playerConstructor.mock.results[playerConstructor.mock.results.length - 1].value;
  playback.play.mockImplementation(async () => {
    const next = { phase: 'playing' as const, position: 0, duration: 1 };
    playback.getState.mockReturnValue(next); playback.subscribe.mock.calls[0][0](next);
  });
});

afterEach(async () => {
  const cleanup = service.cancelAndClear();
  settleTestGates.splice(0).forEach(settle => settle());
  await cleanup.catch(() => undefined);
});

function chooseReference() {
  registry.saveModels([chatModel(), ttsModel(qwenProfile)]);
  choose(qwenProfile);
  jest.mocked(FileSystem.getInfoAsync).mockImplementation(async uri => ({ exists: true, isDirectory: false,
    uri: String(uri), size: qwenProfile.codec.bytes, modificationTime: 1 }));
  jest.mocked(RNFS.hash).mockResolvedValue(qwenProfile.codec.sha256);
  const prepared = { uri: 'file:///test-cache/audio-preparation/reference.wav', sourceSha256: 'c'.repeat(64),
    identity: 'bounded reference', sampleRate: 24000, channels: 1 as const, sampleCount: 4800, durationMs: 200, sizeBytes: 9644 };
  const prepare = jest.spyOn(audioPreparation, 'prepareManagedAudio').mockResolvedValue(prepared);
  const read = jest.spyOn(audioPreparation, 'readPreparedReferencePcm').mockResolvedValue(Array(4800).fill(0.25));
  const discard = jest.spyOn(audioPreparation, 'discardPreparedAudio').mockResolvedValue(undefined);
  const voice = { kind: 'reference' as const, bake: 'lazy' as const, source: { kind: 'temporary' as const,
    sourceUri: 'file:///reference-source.wav', sourceSha256: 'c'.repeat(64), durationMs: 200, consent: true as const } };
  return { voice, prepare, prepared, read, discard };
}

it('prepares and checks the immutable reference at profile rate before createSpeaker and drops derivative/PCM', async () => {
  const { voice, prepare, read, discard } = chooseReference();
  await service.start({ text: 'Hello.', language: 'en', voice, playAfterSynthesis: false });
  expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ sourceUri: voice.source.sourceUri,
    sampleRate: 24000, purpose: 'reference', assertCurrent: expect.any(Function) }));
  expect(discard.mock.invocationCallOrder[0]).toBeLessThan(synthesize.mock.invocationCallOrder[0]);
  expect(synthesize).toHaveBeenCalledWith(context, qwenProfile, expect.objectContaining({ voice,
    referenceAudio: { sampleRate: 24000, samples: [] } })); // Same private array emptied after actual context drain.
  expect((await read.mock.results[0].value).length).toBe(0);
  expect(service.getExecutionIdentity()).toContain('lazy');
  expect(engine.getState().activeModelId).toBe(chatId);
});

it('rejects missing permission and mutated original hash before allocating a speaker or native TTS context', async () => {
  const { voice, prepare, prepared, read, discard } = chooseReference();
  await expect(service.start({ text: 'Hello.', language: 'en', voice: { ...voice,
    source: { ...voice.source, consent: false } as unknown as typeof voice.source } })).rejects.toMatchObject({ code: 'consent_required' });
  expect(prepare).not.toHaveBeenCalled();
  prepare.mockResolvedValue({ ...prepared, sourceSha256: 'd'.repeat(64) });
  await expect(service.start({ text: 'Hello.', language: 'en', voice })).rejects.toMatchObject({ code: 'reference_invalid' });
  expect(read).not.toHaveBeenCalled(); expect(discard).toHaveBeenCalledTimes(1);
  expect(initContext).not.toHaveBeenCalled(); expect(synthesize).not.toHaveBeenCalled();
});

it('waits for late native preparation and deletes its derivative before stop resolves', async () => {
  const { voice, prepare, prepared, discard } = chooseReference();
  const gate = deferred<typeof prepared>(); prepare.mockReturnValue(gate.promise);
  const work = service.start({ text: 'Hello.', language: 'en', voice });
  const rejected = expect(work).rejects.toMatchObject({ code: 'cancelled' });
  await until(() => prepare.mock.calls.length > 0);
  let stopped = false; const stop = service.stop().then(() => { stopped = true; });
  await Promise.resolve(); expect(stopped).toBe(false); expect(discard).not.toHaveBeenCalled();
  gate.resolve(prepared); await rejected; await stop;
  expect(discard).toHaveBeenCalledWith(prepared); expect(synthesize).not.toHaveBeenCalled();
});

it('keeps the free-memory cap before decrypting a saved reference while A is loaded', async () => {
  const { prepare } = chooseReference();
  const voice = { id: 'saved-voice', name: 'Saved', sourceSha256: 'c'.repeat(64), durationMs: 200,
    sourceBytes: 9644, sourceMimeType: 'audio/wav' as const, createdAt: 1, consentRecordedAt: 1 };
  jest.spyOn(referenceVoiceStore, 'getState').mockReturnValue({ voices: [voice], selectedVoiceId: voice.id });
  const lease: ReferenceVoiceLease = { voice, isCurrent: () => true,
    materialize: jest.fn(async () => ({ uri: 'file:///saved-materialized.wav', release: jest.fn(async () => undefined) })),
    release: jest.fn(async () => undefined) };
  jest.spyOn(referenceVoiceStore, 'acquire').mockReturnValue(lease);
  jest.mocked(getSystemMemorySnapshot).mockResolvedValue({ availableBytes: 32 * 2 ** 30, freeBytes: 1024,
    thresholdBytes: 0, lowMemory: false } as never);
  await expect(service.start({ text: 'Hello.', language: 'en', voice: { kind: 'reference',
    source: { kind: 'saved', voiceId: voice.id, sourceSha256: voice.sourceSha256 } } }))
    .rejects.toMatchObject({ code: 'memory_insufficient' });
  expect(lease.materialize).not.toHaveBeenCalled();
  expect(lease.release).toHaveBeenCalledTimes(1);
  expect(prepare).not.toHaveBeenCalled(); expect(initContext).not.toHaveBeenCalled();
  expect(engine.getState().activeModelId).toBe(chatId);
});

it.each(['deletion', 'reselection'] as const)('releases a saved source lease after native drain on %s and restores unchanged A', async change => {
  const { prepare, discard } = chooseReference();
  updateSettings({ modelLoadParamsByModelId: { [chatId]: { ...getSettings().modelLoadParamsByModelId?.[chatId],
    loraAdapters: [{ artifactId: 'chat-adapter', artifactIdentity: 'adapter-bytes', baseModelIdentity: 'chat-bytes', scale: 0.5, sizeBytes: 1024 }] } } });
  const unchangedChatProfile = getSettings().modelLoadParamsByModelId?.[chatId];
  const voice = { id: 'saved-voice', name: 'Saved', sourceSha256: 'c'.repeat(64), durationMs: 200,
    sourceBytes: 9644, sourceMimeType: 'audio/wav' as const, createdAt: 1, consentRecordedAt: 1 };
  let voiceState = { voices: [voice], selectedVoiceId: voice.id as string | null };
  let changed: () => void = () => undefined;
  jest.spyOn(referenceVoiceStore, 'getState').mockImplementation(() => voiceState);
  jest.spyOn(referenceVoiceStore, 'subscribe').mockImplementation(listener => { changed = listener; return () => undefined; });
  const lease: ReferenceVoiceLease = { voice, isCurrent: () => voiceState.voices.length > 0,
    materialize: jest.fn(async () => ({ uri: 'file:///saved-materialized.wav', release: jest.fn(async () => undefined) })),
    release: jest.fn(async () => { events.push('reference-source-released'); }) };
  jest.spyOn(referenceVoiceStore, 'acquire').mockReturnValue(lease);
  const gate = deferred<TtsPcmResult>(); synthesize.mockReturnValue(gate.promise);
  const work = service.start({ text: 'Hello.', language: 'en', voice: { kind: 'reference', bake: 'eager',
    source: { kind: 'saved', voiceId: voice.id, sourceSha256: voice.sourceSha256 } } });
  const rejected = expect(work).rejects.toMatchObject({ code: 'selection_changed' });
  await until(() => synthesize.mock.calls.length > 0);
  voiceState = change === 'deletion' ? { voices: [], selectedVoiceId: null }
    : { voices: [voice], selectedVoiceId: 'replacement-voice' };
  changed();
  expect(lease.release).not.toHaveBeenCalled();
  gate.resolve(pcm(qwenProfile)); await rejected;
  expect(prepare).toHaveBeenCalled(); expect(discard).toHaveBeenCalled();
  expect(events.indexOf('context-released')).toBeLessThan(events.indexOf('reference-source-released'));
  expect(playback.setClip).not.toHaveBeenCalled(); expect(restoreA).toHaveBeenCalledTimes(1);
  expect(engine.getState().activeModelId).toBe(chatId);
  expect(getSettings().modelLoadParamsByModelId?.[chatId]).toEqual(unchangedChatProfile);
});

it('honors an explicitly cleared TTS selection and never falls back to the active chat model', async () => {
  updateSettings({ auxiliaryModels: {}, autoSelectTtsModel: false });
  expect(getTtsSelectionStatus()).toEqual({ errorCode: 'selection_missing' });
  await expect(service.start({ text: 'Hello.', language: 'en' })).rejects.toMatchObject({ code: 'selection_missing' });
  expect(engine.runWithAuxiliarySequence).not.toHaveBeenCalled();
  expect(initContext).not.toHaveBeenCalled();
  expect(getSettings().activeModelId).toBe(chatId);
});

it('rejects an unknown artifact pair before hashing or allocating a native context', async () => {
  const unknown = registry.getModel('tts/tokens')!;
  registry.updateModel({ ...unknown, artifacts: unknown.artifacts!.map(artifact => ({ ...artifact, sha256: 'b'.repeat(64) })) });
  choose();
  await expect(service.start({ text: 'Hello.', language: 'en' })).rejects.toMatchObject({ code: 'profile_unverified' });
  expect(validateAuxiliaryFile).not.toHaveBeenCalled();
  expect(RNFS.hash).not.toHaveBeenCalled();
  expect(initContext).not.toHaveBeenCalled();
  expect(synthesize).not.toHaveBeenCalled();
});

it('checks the original bound files without claiming synthesis or changing chat selection', async () => {
  const source = createAssistantSource();
  const settings = getSettings();
  const threads = useChatStore.getState().threads;
  choose();
  expect(getSettings()).toEqual({ ...settings, auxiliaryModels: { tts: expect.any(Object) }, autoSelectTtsModel: false });
  expect(useChatStore.getState().threads).toBe(threads);
  expect(useChatStore.getState().activeThreadId).toBe(source.threadId);
  await service.checkFiles();
  expect(validateAuxiliaryFile).toHaveBeenCalledWith(expect.objectContaining({ localPath: 'tokens-backbone-original.gguf' }));
  expect(RNFS.hash).toHaveBeenCalledWith('/models/tokens-codec-original.gguf', 'sha256');
  expect(engine.runWithAuxiliarySequence).not.toHaveBeenCalled();
  expect(synthesize).not.toHaveBeenCalled();
  expect(playback.setClip).not.toHaveBeenCalled();
  expect(service.getState()).toMatchObject({ phase: null, profileId: tokensProfile.id, memoryConfidence: 'low' });
  expect(getSettings().activeModelId).toBe(chatId);
  expect(registry.getModel('tts/tokens')?.roleValidation).toBeUndefined();
});

it('fails file integrity before native initialization and preserves the selected A profile', async () => {
  choose();
  jest.mocked(RNFS.hash).mockResolvedValueOnce('f'.repeat(64));
  const settings = getSettings();
  await expect(service.start({ text: 'Hello.', language: 'en' })).rejects.toMatchObject({ code: 'integrity_failed' });
  expect(initContext).not.toHaveBeenCalled();
  expect(synthesize).not.toHaveBeenCalled();
  expect(restoreA).toHaveBeenCalledTimes(1);
  expect(getSettings()).toEqual(settings);
});

it('rejects a selection changed while the file digest is still pending', async () => {
  choose();
  const digest = deferred<string>();
  jest.mocked(RNFS.hash).mockReturnValueOnce(digest.promise);
  const work = service.checkFiles();
  const rejected = expect(work).rejects.toMatchObject({ code: 'selection_changed' });
  await until(() => jest.mocked(RNFS.hash).mock.calls.length === 1);
  choose(continuousProfile);
  digest.resolve(tokensProfile.codec.sha256);
  await rejected;
  expect(engine.runWithAuxiliarySequence).not.toHaveBeenCalled();
  expect(playback.setClip).not.toHaveBeenCalled();
  expect(resolveTtsBinding().profile.id).toBe(continuousProfile.id);
});

it.each(TTS_EXECUTION_PROFILES.filter(profile => !profile.voiceModes))('uses a fresh isolated native profile for $flow without writing history or running chat tools', async profile => {
  const source = createAssistantSource();
  choose(profile);
  const settings = getSettings();
  const threads = useChatStore.getState().threads;
  const historyWrite = jest.spyOn(settingsStore, 'saveChatHistory');
  await service.start({ text: 'Hello.', language: profile.languages[0], source, playAfterSynthesis: false });
  await service.start({ text: 'Hello again.', language: profile.languages[0], source, playAfterSynthesis: false });
  expect(contextRequests).toHaveLength(2);
  expect(contextRequests[0].initParams).toEqual(getTtsInitParameters(profile, `/models/${profile.flow}-backbone-original.gguf`));
  expect(contextRequests[0].initParams).not.toBe(contextRequests[1].initParams);
  expect(contextRequests[0]).toMatchObject({ modelId: `tts/${profile.flow}`, nativeDrainTimeoutMs: 600_000 });
  expect(synthesize).toHaveBeenLastCalledWith(context, profile, expect.objectContaining({
    text: 'Hello again.', language: profile.languages[0], codecPath: `/models/${profile.flow}-codec-original.gguf`,
  }));
  expect(synthesize.mock.calls[0][2]).not.toHaveProperty('tools');
  expect(synthesize.mock.calls[0][2]).not.toHaveProperty('messages');
  expect(historyWrite).not.toHaveBeenCalled();
  expect(useChatStore.getState().threads).toBe(threads);
  expect(getSettings()).toEqual(settings);
  expect(engine.getState().activeModelId).toBe(chatId);
  expect(service.getExecutionIdentity()).toContain(profile.backbone.sha256);
  expect(service.getState()).toMatchObject({ phase: 'ready', sampleRate: profile.sampleRate, sampleCount: 2 });
  expect(JSON.stringify(service.getState())).not.toContain('samples');
  expect(playback.play).not.toHaveBeenCalled();
});

it('admits sufficient OS allocatable memory after detaching A even when free pages are scarce', async () => {
  choose();
  const requiredBytes = estimateTtsPeakBytes(tokensProfile);
  const thresholdBytes = 256 * 2 ** 20;
  jest.mocked(getSystemMemorySnapshot).mockImplementationOnce(async () => {
    expect(state.status).toBe(EngineStatus.IDLE);
    expect(events).toEqual(['detach-a']);
    return { availableBytes: requiredBytes + thresholdBytes, freeBytes: 1,
      thresholdBytes, lowMemory: false, pressureLevel: 'normal' } as never;
  });
  await service.start({ text: 'Hello.', language: 'en', playAfterSynthesis: false });
  expect(initContext).toHaveBeenCalledTimes(1);
  expect(synthesize).toHaveBeenCalledTimes(1);
  expect(playback.setClip).toHaveBeenCalledTimes(1);
  expect(state.activeModelId).toBe(chatId);
  expect(getSystemMemorySnapshot).toHaveBeenCalledTimes(1);
  expect(service.getState().memoryAdmission).toEqual({
    availableBytes: requiredBytes + thresholdBytes, freeBytes: 1, processAvailableBytes: undefined,
    thresholdBytes, budgetBytes: requiredBytes, requiredBytes, lowMemory: false, pressureLevel: 'normal',
  });
});

it('admits the automatically selected legacy builtin profile within the observed phone budget', async () => {
  const preferred = TTS_EXECUTION_PROFILES.find(profile => profile.id === DEFAULT_TTS_PROFILE_ID)!;
  registry.saveModels([chatModel(), ttsModel(preferred)]);
  updateSettings({ auxiliaryModels: {}, autoSelectTtsModel: true });
  expect(getTtsSelectionStatus()).toMatchObject({ profileId: DEFAULT_TTS_PROFILE_ID });
  jest.mocked(FileSystem.getInfoAsync).mockImplementation(async uri => ({ exists: true, isDirectory: false,
    uri: String(uri), size: preferred.codec.bytes, modificationTime: 1 }));
  jest.mocked(RNFS.hash).mockResolvedValue(preferred.codec.sha256);
  const requiredBytes = estimateTtsPeakBytes(preferred);
  const availableBytes = 2_814_287_872;
  const freeBytes = 161_202_176;
  const thresholdBytes = 452_984_832;
  const budgetBytes = 2_361_303_040;
  jest.mocked(getSystemMemorySnapshot).mockImplementationOnce(async () => {
    expect(state.status).toBe(EngineStatus.IDLE);
    expect(events).toEqual(['detach-a']);
    return { availableBytes, freeBytes, thresholdBytes, lowMemory: false, pressureLevel: 'normal' } as never;
  });
  await service.start({ text: 'Hello.', language: 'en', voice: { kind: 'builtin', voice: 'default' },
    playAfterSynthesis: false });
  expect(requiredBytes).toBe(2_020_891_040);
  expect(contextRequests[0].initParams).toMatchObject({ n_ctx: 3840, n_batch: 128,
    embedding: false, cache_type_k: 'f16', cache_type_v: 'f16', n_gpu_layers: 0,
    use_mmap: true, use_mlock: false, no_extra_bufts: true });
  expect(synthesize).toHaveBeenCalledWith(context, preferred, expect.objectContaining({
    voice: { kind: 'builtin', voice: 'default' } }));
  expect(service.getState().memoryAdmission).toMatchObject({ requiredBytes, availableBytes, freeBytes,
    thresholdBytes, budgetBytes, lowMemory: false, pressureLevel: 'normal' });
  expect(budgetBytes).toBeGreaterThan(requiredBytes);
  expect(getSystemMemorySnapshot).toHaveBeenCalledTimes(1);
  expect(state.activeModelId).toBe(chatId);
});

it('retains the exact failed admission snapshot before loading or inference can start', async () => {
  choose();
  const availableBytes = 2_440_790_016;
  const thresholdBytes = 256 * 2 ** 20;
  const freeBytes = 206_880 * 1024;
  const phases: (string | null)[] = [];
  const remove = service.subscribe(() => { phases.push(service.getState().phase); });
  jest.mocked(getSystemMemorySnapshot).mockResolvedValueOnce({ availableBytes, freeBytes,
    thresholdBytes, lowMemory: false, pressureLevel: 'normal' } as never);
  try {
    await expect(service.start({ text: 'Hello.', language: 'en' }))
      .rejects.toMatchObject({ code: 'memory_insufficient' });
    expect(service.getState().memoryAdmission).toEqual({ availableBytes, freeBytes,
      processAvailableBytes: undefined, thresholdBytes, budgetBytes: availableBytes - thresholdBytes,
      requiredBytes: estimateTtsPeakBytes(tokensProfile), lowMemory: false, pressureLevel: 'normal' });
    expect(phases).not.toContain('loading');
    expect(getSystemMemorySnapshot).toHaveBeenCalledTimes(1);
    expect(initContext).not.toHaveBeenCalled();
    expect(synthesize).not.toHaveBeenCalled();
  } finally { remove(); }
});

it('does not retain admission evidence when QA evidence is disabled', async () => {
  choose();
  const enabled = jest.spyOn(androidQaEvidence, 'isAndroidQaGenerationEvidenceEnabled').mockReturnValue(false);
  try {
    await service.start({ text: 'Hello.', language: 'en', playAfterSynthesis: false });
    expect(service.getState().memoryAdmission).toBeUndefined();
    expect(getSystemMemorySnapshot).toHaveBeenCalledTimes(1);
  } finally { enabled.mockRestore(); }
});

it('keeps out-of-range snapshot bytes out of admission evidence without changing the gate', async () => {
  choose();
  jest.mocked(getSystemMemorySnapshot).mockResolvedValueOnce({ availableBytes: 65 * 2 ** 30,
    freeBytes: Number.NaN, thresholdBytes: -1, lowMemory: false, pressureLevel: 'normal' } as never);
  await service.start({ text: 'Hello.', language: 'en', playAfterSynthesis: false });
  expect(service.getState().memoryAdmission).toEqual({ availableBytes: undefined, freeBytes: undefined,
    processAvailableBytes: undefined, thresholdBytes: undefined, budgetBytes: undefined,
    requiredBytes: estimateTtsPeakBytes(tokensProfile), lowMemory: false, pressureLevel: 'normal' });
  expect(initContext).toHaveBeenCalledTimes(1);
});

it.each([
  { reason: 'missing snapshot', memory: null, code: 'memory_unknown' },
  { reason: 'zero available memory', memory: { availableBytes: 0, freeBytes: 0,
    thresholdBytes: 0, lowMemory: false }, code: 'memory_unknown' },
  { reason: 'insufficient allocatable memory', memory: { availableBytes: estimateTtsPeakBytes(tokensProfile) - 1,
    freeBytes: 32 * 2 ** 30, thresholdBytes: 0, lowMemory: false, pressureLevel: 'normal' }, code: 'memory_insufficient' },
  { reason: 'reserved OS threshold', memory: { availableBytes: estimateTtsPeakBytes(tokensProfile) + 1024,
    freeBytes: 32 * 2 ** 30, thresholdBytes: 1025, lowMemory: false, pressureLevel: 'normal' }, code: 'memory_insufficient' },
  { reason: 'insufficient process headroom', memory: { availableBytes: 32 * 2 ** 30,
    freeBytes: 32 * 2 ** 30, processAvailableBytes: estimateTtsPeakBytes(tokensProfile) - 1,
    thresholdBytes: 0, lowMemory: false, pressureLevel: 'normal' }, code: 'memory_insufficient' },
  { reason: 'low-memory state', memory: { availableBytes: 32 * 2 ** 30,
    freeBytes: 32 * 2 ** 30, thresholdBytes: 0, lowMemory: true }, code: 'memory_insufficient' },
  { reason: 'critical pressure free-page cap', memory: { availableBytes: 32 * 2 ** 30,
    freeBytes: 1, thresholdBytes: 0, lowMemory: false, pressureLevel: 'critical' }, code: 'memory_insufficient' },
])('refuses $reason before context initialization', async ({ memory, code }) => {
  choose();
  jest.mocked(getSystemMemorySnapshot).mockResolvedValueOnce(memory as never);
  await expect(service.start({ text: 'Hello.', language: 'en' })).rejects.toMatchObject({ code });
  expect(initContext).not.toHaveBeenCalled();
  expect(synthesize).not.toHaveBeenCalled();
  expect(playback.setClip).not.toHaveBeenCalled();
  expect(service.getState()).toMatchObject({ errorCode: code, requiredBytes: estimateTtsPeakBytes(tokensProfile), memoryConfidence: 'low' });
});

it('hands WAV to playback only after confirmed context release and restoration of A', async () => {
  choose();
  const release = deferred<void>();
  const restoration = deferred<void>();
  releaseContext.mockReturnValueOnce(release.promise);
  restoreA.mockReturnValueOnce(restoration.promise);
  playback.setClip.mockImplementation(async () => { events.push('set-clip'); });
  const work = service.start({ text: 'Hello.', language: 'en' });
  await until(() => releaseContext.mock.calls.length === 1);
  expect(playback.setClip).not.toHaveBeenCalled();
  expect(restoreA).not.toHaveBeenCalled();
  release.resolve();
  await until(() => restoreA.mock.calls.length === 1);
  expect(playback.setClip).not.toHaveBeenCalled();
  restoration.resolve();
  await work;
  expect(events).toEqual(['detach-a', 'init-tts', 'context-released', 'a-restored', 'set-clip']);
  const [wav, metadata, isCurrent] = playback.setClip.mock.calls[0];
  expect(wav).toBeInstanceOf(Uint8Array);
  expect(Array.from(wav.slice(0, 4))).toEqual([82, 73, 70, 70]);
  expect(metadata).toEqual({ sampleRate: 24000, sampleCount: 2 });
  expect(isCurrent()).toBe(true);
  expect(playback.play).toHaveBeenCalledTimes(1);
});

it('Stop waits for the real callback and retains the outer download lease until A is restored', async () => {
  choose();
  const callback = deferred<TtsPcmResult>();
  synthesize.mockReturnValueOnce(callback.promise);
  const work = service.start({ text: 'Hello.', language: 'en' });
  const rejected = expect(work).rejects.toMatchObject({ code: 'cancelled' });
  await until(() => synthesize.mock.calls.length === 1);
  let stopped = false;
  const stop = service.stop().then(() => { stopped = true; });
  expect(sequenceRequests[0].isCurrent()).toBe(false);
  expect(sequenceRequests[0].isSelectionCurrent?.()).toBe(true);
  await expect(runWithIdleModelDownloads(async () => undefined)).rejects.toMatchObject({ code: 'action_failed' });
  expect(stopped).toBe(false);
  expect(releaseContext).not.toHaveBeenCalled();
  expect(restoreA).not.toHaveBeenCalled();
  callback.resolve(pcm());
  await rejected;
  await stop;
  expect(releaseContext).toHaveBeenCalledTimes(1);
  expect(restoreA).toHaveBeenCalledTimes(1);
  expect(playback.setClip).not.toHaveBeenCalled();
  expect(service.getState()).toMatchObject({ phase: 'stopped', errorCode: 'cancelled' });
  await expect(runWithIdleModelDownloads(async () => 'free')).resolves.toBe('free');
});

it('cancelAndClear drains an unchanged selection and still permits exact A restoration', async () => {
  choose();
  const callback = deferred<TtsPcmResult>();
  synthesize.mockReturnValueOnce(callback.promise);
  const work = service.start({ text: 'Hello.', language: 'en', isTextCurrent: () => true });
  const rejected = expect(work).rejects.toBeInstanceOf(TtsError);
  await until(() => synthesize.mock.calls.length === 1);
  const clear = service.cancelAndClear();
  expect(sequenceRequests[0].isCurrent()).toBe(false);
  expect(sequenceRequests[0].isSelectionCurrent?.()).toBe(true);
  callback.resolve(pcm());
  await rejected;
  await clear;
  expect(releaseContext).toHaveBeenCalledTimes(1);
  expect(restoreA).toHaveBeenCalledTimes(1);
  expect(playback.setClip).not.toHaveBeenCalled();
  expect(service.getState()).toEqual({ phase: null });
});

it.each(['stop', 'cancelAndClear'] as const)('blocks a new synthesis or file check until ready-player %s cleanup has drained', async operation => {
  choose();
  await service.start({ text: 'Hello.', language: 'en', playAfterSynthesis: false });
  const playerDrain = deferred<void>();
  playback.stop.mockReturnValueOnce(playerDrain.promise);
  let settled = false;
  const control = service[operation]().then(() => { settled = true; });
  await until(() => playback.stop.mock.calls.length === 1);
  await expect(service.start({ text: 'New preview.', language: 'en' })).rejects.toMatchObject({ code: 'busy' });
  await expect(service.checkFiles()).rejects.toMatchObject({ code: 'busy' });
  expect(contextRequests).toHaveLength(1);
  expect(settled).toBe(false);
  playerDrain.resolve();
  await control;
  await service.start({ text: 'New preview.', language: 'en', playAfterSynthesis: false });
  expect(contextRequests).toHaveLength(2);
  expect(service.getState()).toMatchObject({ phase: 'ready', profileId: tokensProfile.id });
  expect(service.getExecutionIdentity()).toContain(tokensProfile.backbone.sha256);
});

it('retains the raw callback drain after an engine watchdog rejects its public sequence', async () => {
  choose();
  const callback = deferred<TtsPcmResult>();
  const watchdog = deferred<void>();
  synthesize.mockReturnValueOnce(callback.promise);
  engine.runWithAuxiliarySequence.mockImplementationOnce(async (request, operation) => {
    sequenceRequests.push(request);
    const raw = operation({ withContext: async (phase, native) => {
      contextRequests.push(phase); await phase.beforeInit?.(); initContext(phase.initParams);
      return native(context);
    } });
    void raw.catch(() => undefined);
    await watchdog.promise;
    throw Object.assign(new Error('sanitized quarantine'), { code: 'engine_recovery_required' });
  });
  let settled = false;
  const work = service.start({ text: 'Hello.', language: 'en' });
  void work.then(() => { settled = true; }, () => { settled = true; });
  const rejected = expect(work).rejects.toMatchObject({ code: 'release_failed' });
  await until(() => synthesize.mock.calls.length === 1);
  watchdog.resolve();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(settled).toBe(false);
  await expect(runWithIdleModelDownloads(async () => undefined)).rejects.toMatchObject({ code: 'action_failed' });
  await expect(service.start({ text: 'Another.', language: 'en' })).rejects.toMatchObject({ code: 'busy' });
  callback.resolve(pcm());
  await rejected;
  expect(playback.setClip).not.toHaveBeenCalled();
  expect(restoreA).not.toHaveBeenCalled();
  expect(service.getState()).toMatchObject({ phase: 'error', errorCode: 'release_failed' });
  await expect(runWithIdleModelDownloads(async () => 'free')).resolves.toBe('free');
});

it.each(['chat', 'text', 'codec', 'backbone', 'previous-a', 'source'] as const)('cannot publish late PCM or restore A after %s changes', async change => {
  const source = createAssistantSource();
  choose();
  const callback = deferred<TtsPcmResult>();
  synthesize.mockReturnValueOnce(callback.promise);
  let textCurrent = true;
  const work = service.start({ text: 'Hello.', language: 'en', source, isTextCurrent: () => textCurrent });
  const rejected = expect(work).rejects.toMatchObject({ code: 'selection_changed' });
  await until(() => synthesize.mock.calls.length === 1);
  const bound = registry.getModel('tts/tokens')!;
  if (change === 'chat') updateSettings({ activeModelId: 'chat/new-choice' });
  if (change === 'text') textCurrent = false;
  if (change === 'codec') registry.updateModel({ ...bound, artifacts: bound.artifacts!.map(artifact => ({ ...artifact, localPath: 'new-codec.gguf' })) });
  if (change === 'backbone') registry.updateModel({ ...bound, localPath: 'new-backbone.gguf' });
  if (change === 'previous-a') registry.updateModel({ ...registry.getModel(chatId)!, localPath: 'replaced-a.gguf' });
  if (change === 'source') {
    const thread = useChatStore.getState().threads[source.threadId];
    useChatStore.setState({ threads: { [thread.id]: { ...thread, messages: thread.messages.map(message => ({ ...message, content: 'Edited answer.' })) } } });
  }
  expect(sequenceRequests[0].isSelectionCurrent?.()).toBe(false);
  callback.resolve(pcm());
  await rejected;
  expect(releaseContext).toHaveBeenCalledTimes(1);
  expect(restoreA).not.toHaveBeenCalled();
  expect(playback.setClip).not.toHaveBeenCalled();
  expect(playback.play).not.toHaveBeenCalled();
  if (change === 'chat') expect(getSettings().activeModelId).toBe('chat/new-choice');
});

it('preserves a sanitized primary runtime code when codec cleanup also failed', async () => {
  choose();
  const primary = Object.freeze(new TtsError('payload_invalid'));
  synthesize.mockRejectedValueOnce(new TtsCleanupError(primary));
  await expect(service.start({ text: 'Hello.', language: 'en' })).rejects.toMatchObject({ code: 'payload_invalid', message: 'payload_invalid' });
  expect(service.getState()).toMatchObject({ phase: 'error', errorCode: 'payload_invalid' });
  expect(restoreA).toHaveBeenCalledTimes(1);
  expect(playback.setClip).not.toHaveBeenCalled();
});

it.each([false, true])('preserves phonemizer diagnostics through actual service catch (codec cleanup wrapper=%s)', async wrapped => {
  choose();
  const primary = new TtsError('phonemizer_failed', { reason: 'module_init', elapsedMs: 123, moduleInitMs: 123 });
  const failure = wrapped ? new TtsCleanupError(primary) : primary;
  Object.assign(failure, { native: 'private payload', cause: 'private cause', message: 'private message',
    phonemizerFailure: { ...primary.phonemizerFailure, phones: 'private IPA' } });
  synthesize.mockRejectedValueOnce(failure);
  const error = await service.start({ text: 'Hello.', language: 'en' }).catch(value => value);
  expect(error).toBeInstanceOf(TtsError); expect(error).not.toBeInstanceOf(TtsCleanupError);
  expect(error).not.toBe(failure);
  expect(error).toMatchObject({ name: 'TtsError', code: 'phonemizer_failed', message: 'phonemizer_failed',
    phonemizerFailure: { reason: 'module_init', elapsedMs: 123, moduleInitMs: 123 } });
  for (const field of ['native', 'cause', 'operationError', 'cleanupError']) expect(error).not.toHaveProperty(field);
  expect(JSON.stringify(error)).not.toContain('private');
  expect(service.getState()).toMatchObject({ phase: 'error', errorCode: 'phonemizer_failed' });
  expect(restoreA).toHaveBeenCalledTimes(1); expect(playback.setClip).not.toHaveBeenCalled();
});
it('reconstructs the generic cancellation error at the service boundary', async () => {
  choose(); const cancelled = Object.freeze(new TtsError('cancelled'));
  synthesize.mockRejectedValueOnce(cancelled);
  const error = await service.start({ text: 'Hello.', language: 'en' }).catch(value => value);
  expect(error).toBeInstanceOf(TtsError); expect(error).not.toBe(cancelled);
  expect(error).toMatchObject({ code: 'cancelled', message: 'cancelled' });
  expect(service.getState()).toMatchObject({ phase: 'stopped', errorCode: 'cancelled' });
});
it.each(['storage', 'recovery', 'restore'] as const)('keeps %s failure above phonemizer diagnostics', async override => {
  choose(); const primary = new TtsError('phonemizer_failed', { reason: 'deadline', elapsedMs: 1001, moduleInitMs: 8 });
  if (override === 'storage') {
    synthesize.mockRejectedValueOnce(primary);
    playback.clear.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('private cleanup'));
  } else if (override === 'recovery') {
    engine.runWithAuxiliarySequence.mockRejectedValueOnce(Object.assign(new Error('private context'),
      { code: 'engine_recovery_required', operationError: primary }));
  } else engine.runWithAuxiliarySequence.mockImplementationOnce(async () => {
    state = { ...state, auxiliaryRestoreError: 'private restore' }; throw primary;
  });
  const error = await service.start({ text: 'Hello.', language: 'en' }).catch(value => value);
  expect(error).toMatchObject({ code: override === 'storage' ? 'storage_failed' : override === 'recovery' ? 'release_failed' : 'restore_failed' });
  expect(error.phonemizerFailure).toBeUndefined(); expect(JSON.stringify(error)).not.toContain('private');
});

it('classifies frozen primary plus unconfirmed native release as recovery required without leaking either error', async () => {
  choose();
  const primary = Object.freeze(new Error('Private input and file:///private/model.gguf'));
  const cleanup = Object.freeze(new Error('Private codec release failure'));
  engine.runWithAuxiliarySequence.mockRejectedValueOnce(Object.assign(new Error('context cleanup failed'), {
    code: 'engine_recovery_required', cause: primary, operationError: primary, cleanupError: cleanup,
  }));
  await expect(service.start({ text: 'Hello.', language: 'en' })).rejects.toMatchObject({ code: 'release_failed', message: 'release_failed' });
  expect(service.getState()).toMatchObject({ phase: 'error', errorCode: 'release_failed' });
  expect(JSON.stringify(service.getState())).not.toMatch(/Private|file:\/\/|model\.gguf/);
  expect(playback.setClip).not.toHaveBeenCalled();
});

it.each(['release_failed', 'storage_failed'] as const)(
  'retains asynchronous player %s through stopped events and Stop until confirmed clear', async errorCode => {
    choose();
    await service.start({ text: 'Hello.', language: 'en' });
    const status = playback.subscribe.mock.calls[0][0];
    const failure = { phase: 'error' as const, errorCode, position: 0, duration: 0 };
    const stopped = { phase: 'stopped' as const, position: 0, duration: 0 };
    const nativeEvent = deferred<void>();
    const delivered = nativeEvent.promise.then(() => {
      playback.getState.mockReturnValue(failure);
      status(failure);
    });
    expect(service.getState().phase).toBe('playing');
    nativeEvent.resolve();
    await delivered;
    expect(service.getState()).toMatchObject({ phase: 'error', errorCode });

    const publishStopped = () => { playback.getState.mockReturnValue(stopped); status(stopped); };
    publishStopped();
    playback.stop.mockImplementation(async () => publishStopped());
    await service.stop();
    publishStopped();
    expect(service.getState()).toMatchObject({ phase: 'error', errorCode });

    const release = deferred<void>();
    playback.clear.mockReturnValueOnce(release.promise);
    const clear = service.cancelAndClear();
    let clearSettled = false;
    void clear.then(() => { clearSettled = true; });
    await until(() => playback.clear.mock.calls.length === 2);
    publishStopped();
    expect(clearSettled).toBe(false);
    expect(service.getState()).toMatchObject({ phase: 'error', errorCode });
    await expect(service.start({ text: 'Another clip.', language: 'en' })).rejects.toMatchObject({ code: 'busy' });
    await expect(service.checkFiles()).rejects.toMatchObject({ code: 'busy' });
    expect(synthesize).toHaveBeenCalledTimes(1);

    release.resolve();
    await clear;
    expect(service.getState()).toEqual({ phase: null });
    publishStopped();
    expect(service.getState()).toMatchObject({ phase: 'stopped', position: 0, duration: 0 });
    expect(service.getState().errorCode).toBeUndefined();
  },
);

it('keeps an ordinary native playback error generic without latching cleanup failure', async () => {
  choose();
  await service.start({ text: 'Hello.', language: 'en' });
  const status = playback.subscribe.mock.calls[0][0];
  const failed = { phase: 'error' as const, errorCode: 'playback_failed' as const, position: 0, duration: 0 };
  playback.getState.mockReturnValue(failed);
  status(failed);
  expect(service.getState()).toMatchObject({ phase: 'error', errorCode: 'playback_failed' });
  const stopped = { phase: 'stopped' as const, position: 0, duration: 0 };
  playback.getState.mockReturnValue(stopped);
  status(stopped);
  expect(service.getState().phase).toBe('stopped');
});

it('keeps a player cleanup rejection visible across Stop and failed private-reset cleanup', async () => {
  choose();
  synthesize.mockRejectedValueOnce(new TtsError('native_failed'));
  playback.clear.mockResolvedValueOnce(undefined).mockRejectedValue(new Error('Private player cleanup failure'));
  await expect(service.start({ text: 'Hello.', language: 'en' })).rejects.toMatchObject({ code: 'storage_failed' });
  const stopped = { phase: 'stopped' as const, position: 0, duration: 0 };
  playback.stop.mockImplementation(async () => {
    playback.getState.mockReturnValue(stopped);
    playback.subscribe.mock.calls[0][0](stopped);
  });
  await service.stop();
  expect(service.getState()).toMatchObject({ phase: 'error', errorCode: 'storage_failed' });
  // A later status event also cannot hide an unresolved file/player ownership failure.
  playback.subscribe.mock.calls[0][0](stopped);
  expect(service.getState()).toMatchObject({ phase: 'error', errorCode: 'storage_failed' });
  await expect(service.cancelAndClear()).rejects.toMatchObject({ code: 'storage_failed' });
  expect(service.getState()).toMatchObject({ phase: 'error', errorCode: 'storage_failed' });
});

it.each([true, false])('closing a preview drains late PCM and restores A only if stable text ownership remains %s', async restoreCurrent => {
  choose();
  const callback = deferred<TtsPcmResult>();
  synthesize.mockReturnValueOnce(callback.promise);
  let visible = true;
  let stableText = true;
  const work = service.start({ text: 'Hello.', language: 'en',
    isTextCurrent: () => visible, isRestoreCurrent: () => stableText });
  const rejected = expect(work).rejects.toMatchObject({ code: restoreCurrent ? 'cancelled' : 'selection_changed' });
  await until(() => synthesize.mock.calls.length === 1);
  visible = false;
  stableText = restoreCurrent;
  const clear = service.cancelAndClear();
  expect(sequenceRequests[0].isCurrent()).toBe(false);
  expect(contextRequests[0].isCurrent()).toBe(false);
  expect(sequenceRequests[0].isSelectionCurrent?.()).toBe(restoreCurrent);
  expect(releaseContext).not.toHaveBeenCalled();
  expect(restoreA).not.toHaveBeenCalled();
  await expect(runWithIdleModelDownloads(async () => undefined)).rejects.toMatchObject({ code: 'action_failed' });
  callback.resolve(pcm());
  await rejected;
  await clear;
  expect(releaseContext).toHaveBeenCalledTimes(1);
  expect(restoreA).toHaveBeenCalledTimes(restoreCurrent ? 1 : 0);
  expect(playback.setClip).not.toHaveBeenCalled();
  expect(playback.play).not.toHaveBeenCalled();
  expect(service.getState()).toEqual({ phase: null });
});

it('a restoration-only predicate cannot authorize native work for an invisible or stale preview', async () => {
  choose();
  await expect(service.start({ text: 'Hello.', language: 'en',
    isTextCurrent: () => false, isRestoreCurrent: () => true })).rejects.toMatchObject({ code: 'selection_changed' });
  expect(engine.runWithAuxiliarySequence).not.toHaveBeenCalled();
  expect(initContext).not.toHaveBeenCalled();
  expect(synthesize).not.toHaveBeenCalled();
  expect(playback.setClip).not.toHaveBeenCalled();
});
it('retaining restoration eligibility never keeps a hidden ready clip eligible for playback', async () => {
  choose();
  let visible = true;
  await service.start({ text: 'Hello.', language: 'en', playAfterSynthesis: false,
    isTextCurrent: () => visible, isRestoreCurrent: () => true });
  const isClipCurrent = playback.setClip.mock.calls[0][2];
  expect(isClipCurrent()).toBe(true);
  visible = false;
  expect(sequenceRequests[0].isSelectionCurrent?.()).toBe(true);
  expect(sequenceRequests[0].isCurrent()).toBe(false);
  expect(contextRequests[0].isCurrent()).toBe(false);
  expect(isClipCurrent()).toBe(false);
});

describe('service + real playback controller initial admission', () => {
  let native: ReturnType<typeof makeAdmissionPlayer>;
  let phases: (string | null)[];
  function makeAdmissionPlayer() {
    let listener: ((status: import('expo-audio').AudioStatus) => void) | undefined;
    let requestId = 0;
    const native = {
      isLoaded: true, preventAutomaticResume: false,
      // Intentionally silent: this is the original void native Play failure.
      play: jest.fn(),
      playAsync: jest.fn(async (id: number) => { requestId = id; }),
      pause: jest.fn(), seekTo: jest.fn(async () => undefined),
      disposeAsync: jest.fn(async () => undefined), release: jest.fn(),
      addListener: jest.fn((_event: string, next: typeof listener) => {
        listener = next; return { remove: jest.fn(() => { listener = undefined; }) };
      }),
      emit: (patch: Partial<import('expo-audio').AudioStatus> & { playbackRequestId?: number }) => listener?.({
        id: 'native', currentTime: 0, duration: 1, playbackState: 'ready', timeControlStatus: 'paused',
        reasonForWaitingToPlay: '', mute: false, playing: false, loop: false, didJustFinish: false,
        isBuffering: false, isLoaded: true, playbackRate: 1, shouldCorrectPitch: false,
        playbackRequestId: requestId, ...patch,
      } as import('expo-audio').AudioStatus),
    };
    return native;
  }
  beforeEach(() => {
    jest.useFakeTimers();
    mockClipFiles.clear(); mockClipDirectories.clear(); mockClipWrite.mockClear(); mockClipDelete.mockReset();
    native = makeAdmissionPlayer(); mockCreateNativePlayer.mockReset().mockReturnValue(native);
    const Actual = jest.requireActual<typeof import('../../src/services/TtsPlayback')>('../../src/services/TtsPlayback').TtsPlaybackController;
    jest.mocked(TtsPlaybackController).mockImplementationOnce(() => new Actual());
    service = new TtsService();
    phases = []; service.subscribe(() => phases.push(service.getState().phase));
    choose();
  });
  afterEach(() => { jest.useRealTimers(); });

  it.each(['FAILED', 'DELAYED'])('rejects initial AUDIOFOCUS_REQUEST_%s without ever announcing Playing, and retains the same WAV', async focus => {
    native.playAsync.mockRejectedValueOnce(Object.assign(new Error('sanitized focus denial'), { code: 'ERR_TTS_AUDIO_FOCUS_' + focus }));
    const start = service.start({ text: 'Hello.', language: 'en' });
    const rejected = expect(start).rejects.toMatchObject({ code: focus === 'FAILED' ? 'audio_focus_failed' : 'audio_focus_delayed' });
    await rejected;
    native.emit({ playing: false });
    expect(phases).not.toContain('playing');
    expect(service.getState()).toMatchObject({ phase: 'error', clipAvailable: true });
    expect(native.disposeAsync).toHaveBeenCalledTimes(1);
    expect(mockClipFiles.size).toBe(1);
  });

  it('retains an early real confirmation during the synthesis drain, and publishes Playing only afterwards', async () => {
    const admission = deferred<void>(); native.playAsync.mockReturnValueOnce(admission.promise);
    const start = service.start({ text: 'Hello.', language: 'en' });
    await until(() => native.playAsync.mock.calls.length === 1);
    expect(service.getState().phase).toBe('starting');
    expect(phases).not.toContain('playing');
    native.emit({ playing: true, playbackRequestId: native.playAsync.mock.calls[0][0] });
    expect(service.getState().phase).toBe('playing');
    admission.resolve(); await start;
    expect(service.getState().phase).toBe('playing');
  });

  it('waits for a delayed playing event after accepted focus and rejects old seek snapshots', async () => {
    const start = service.start({ text: 'Hello.', language: 'en' });
    await until(() => native.playAsync.mock.calls.length === 1);
    native.emit({ playing: false, playbackRequestId: 0 });
    native.emit({ playing: false });
    expect(service.getState().phase).toBe('starting');
    jest.advanceTimersByTime(250);
    native.emit({ playing: true }); await start;
    expect(service.getState().phase).toBe('playing');
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['FAILED', 'DELAYED'])('explicitly retries %s using the same WAV and no synthesis', async focus => {
    native.playAsync.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'ERR_TTS_AUDIO_FOCUS_' + focus }));
    await service.start({ text: 'Hello.', language: 'en' }).catch(() => undefined);
    const oldListener = native.addListener.mock.calls[0][1]!;
    const next = makeAdmissionPlayer(); mockCreateNativePlayer.mockReturnValueOnce(next);
    const retry = service.play();
    await until(() => next.playAsync.mock.calls.length === 1);
    oldListener({ playing: true, playbackRequestId: native.playAsync.mock.calls[0][0] } as import('expo-audio').AudioStatus);
    expect(service.getState().phase).toBe('starting');
    next.emit({ playing: true }); await retry;
    expect(service.getState()).toMatchObject({ phase: 'playing', errorCode: undefined });
    expect(synthesize).toHaveBeenCalledTimes(1); expect(mockClipWrite).toHaveBeenCalledTimes(1);
    expect(mockClipFiles.size).toBe(1);
  });

  it.each(['stop', 'cancelAndClear'] as const)('%s cancels waiting admission without late autoplay or timer leaks', async operation => {
    const admission = deferred<void>(); native.playAsync.mockReturnValueOnce(admission.promise);
    const start = service.start({ text: 'Hello.', language: 'en' });
    const cancelled = expect(start).rejects.toMatchObject({ code: 'cancelled' });
    await until(() => native.playAsync.mock.calls.length === 1);
    const late = native.addListener.mock.calls[0][1]!;
    const cleanup = service[operation]();
    await cancelled; await cleanup;
    admission.resolve();
    late({ playing: true, playbackRequestId: native.playAsync.mock.calls[0][0] } as import('expo-audio').AudioStatus);
    expect(phases).not.toContain('playing');
    expect(jest.getTimerCount()).toBe(0);
    expect(mockClipFiles.size).toBe(0);
    expect(service.getState().clipAvailable).not.toBe(true);
    expect(service.getState().sampleCount).toBeUndefined();
  });

  it('rejects a prior request on the same player during Pause/Replay', async () => {
    const start = service.start({ text: 'Hello.', language: 'en' });
    await until(() => native.playAsync.mock.calls.length === 1);
    const previousRequest = native.playAsync.mock.calls[0][0];
    native.emit({ playing: true }); await start;
    await service.pause();
    const replay = service.replay();
    await until(() => native.playAsync.mock.calls.length === 2);
    native.emit({ playing: true, playbackRequestId: previousRequest });
    native.emit({ playing: false, playbackRequestId: previousRequest });
    native.emit({ playing: false, playbackState: 'failed', playbackRequestId: previousRequest });
    expect(service.getState().phase).toBe('starting');
    native.emit({ playing: true }); await replay;
    expect(service.getState().phase).toBe('playing');
    expect(native.disposeAsync).not.toHaveBeenCalled(); expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it('keeps ownership and blocks retry when disposal after a start timeout fails', async () => {
    native.disposeAsync.mockRejectedValue(new Error('unsafe release'));
    const start = service.start({ text: 'Hello.', language: 'en' });
    const failed = expect(start).rejects.toMatchObject({ code: 'storage_failed' });
    await until(() => native.playAsync.mock.calls.length === 1);
    jest.advanceTimersByTime(3_000); await failed;
    expect(mockClipFiles.size).toBe(1); expect(mockClipDelete).not.toHaveBeenCalled();
    expect(service.getState()).toMatchObject({ phase: 'error', errorCode: 'storage_failed' });
    await expect(service.play()).rejects.toMatchObject({ code: 'storage_failed' });
    await expect(service.replay()).rejects.toMatchObject({ code: 'storage_failed' });
    expect(native.playAsync).toHaveBeenCalledTimes(1);
    native.disposeAsync.mockResolvedValue(undefined);
  });

  it('does not claim success for GRANTED without any playing:true before the deadline', async () => {
    const start = service.start({ text: 'Hello.', language: 'en' });
    const rejected = expect(start).rejects.toMatchObject({ code: 'playback_start_timeout' });
    await until(() => native.play.mock.calls.length > 0 || native.playAsync.mock.calls.length > 0);
    native.emit({ playing: false }); native.emit({ playing: false });
    expect(phases).not.toContain('playing');
    jest.advanceTimersByTime(3_000);
    await rejected;
    expect(service.getState()).toMatchObject({ phase: 'error', errorCode: 'playback_start_timeout', clipAvailable: true });
    expect(mockClipFiles.size).toBe(1);
  });
});

it('maps the real auxiliary failure hook to one backbone stage without exposing the native error', async () => {
  choose();
  engine.runWithAuxiliarySequence.mockImplementationOnce(async request => {
    request.observeFailure?.('backbone_init');
    request.observeFailure?.('restore');
    throw new Error('synthetic private init detail');
  });
  const observe = jest.fn();
  await expect(service.start({ text: 'Hello.', language: 'en', playAfterSynthesis: false, observe }))
    .rejects.toMatchObject({ code: 'native_failed' });
  expect(observe.mock.calls.map(([event]) => event).filter(event => event.operation === 'first_failure'))
    .toEqual([{ operation: 'first_failure', phase: 'failed', failureStage: 'tts_backbone_init' }]);
  expect(synthesize).not.toHaveBeenCalled();
  expect(JSON.stringify(observe.mock.calls)).not.toContain('private');
});

it('keeps the runtime first failure when later restoration changes the existing terminal error code', async () => {
  choose();
  synthesize.mockImplementationOnce(async (_context, _profile, options) => {
    options.observe?.({ operation: 'first_failure', phase: 'failed', failureStage: 'formatter' });
    throw new TtsError('native_failed');
  });
  engine.runWithAuxiliarySequence.mockImplementationOnce(async (request, operation) => {
    try { return await normalSequence(request, operation); }
    finally {
      request.observeFailure?.('restore');
      state = { ...state, auxiliaryRestoreError: 'synthetic fixed restore failure' };
      throw new Error('synthetic restore detail');
    }
  });
  const observe = jest.fn();
  await expect(service.start({ text: 'Hello.', language: 'en', playAfterSynthesis: false, observe }))
    .rejects.toMatchObject({ code: 'restore_failed' });
  expect(observe.mock.calls.map(([event]) => event).filter(event => event.operation === 'first_failure'))
    .toEqual([{ operation: 'first_failure', phase: 'failed', failureStage: 'formatter' }]);
  expect(releaseContext).toHaveBeenCalledTimes(1);
  expect(restoreA).toHaveBeenCalledTimes(1);
});

it('contains request observer exceptions while preserving normal synthesis and A restoration', async () => {
  choose();
  synthesize.mockImplementationOnce(async (_context, _profile, options) => {
    options.observe?.({ operation: 'formatter', phase: 'settled' });
    return pcm();
  });
  const observe = jest.fn((_event: TtsObservation) => { throw new Error('ignored diagnostic observer'); });
  await expect(service.start({ text: 'Hello.', language: 'en', playAfterSynthesis: false, observe })).resolves.toBeUndefined();
  expect(observe).toHaveBeenCalled();
  expect(releaseContext).toHaveBeenCalledTimes(1);
  expect(restoreA).toHaveBeenCalledTimes(1);
});
