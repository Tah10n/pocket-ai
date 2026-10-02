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
import { TTS_EXECUTION_PROFILES, getTtsInitParameters, estimateTtsPeakBytes,
  type TtsExecutionProfile } from '../../src/services/TtsExecutionProfiles';
import { synthesizeTtsOnContext, type TtsPcmResult } from '../../src/services/TtsSynthesisRuntime';
import { TtsPlaybackController } from '../../src/services/TtsPlayback';
import { useChatStore } from '../../src/store/chatStore';
import { useDownloadStore } from '../../src/store/downloadStore';
import { bindManagedCompanion } from '../../src/utils/modelArtifacts';
import { TtsCleanupError, TtsError } from '../../src/types/tts';
import { EngineStatus, LifecycleStatus, ModelAccessState, type EngineState, type ModelMetadata } from '../../src/types/models';

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
    clear: jest.fn(async () => undefined), stop: jest.fn(async () => undefined),
    setClip: jest.fn(async () => undefined), play: jest.fn(async () => undefined),
    pause: jest.fn(async () => undefined), replay: jest.fn(async () => undefined),
  })), cleanupColdTtsClips: jest.fn(async () => undefined),
}));

const engine = jest.mocked(llmEngineService);
const synthesize = jest.mocked(synthesizeTtsOnContext);
const tokensProfile = TTS_EXECUTION_PROFILES.find(profile => profile.flow === 'tokens')!;
const continuousProfile = TTS_EXECUTION_PROFILES.find(profile => profile.flow === 'continuous_embd')!;
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
});

afterEach(async () => {
  const cleanup = service.cancelAndClear();
  settleTestGates.splice(0).forEach(settle => settle());
  await cleanup.catch(() => undefined);
});

it('requires an explicit selection and never falls back to the active chat model', async () => {
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
  expect(getSettings()).toEqual({ ...settings, auxiliaryModels: { tts: expect.any(Object) } });
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

it.each(TTS_EXECUTION_PROFILES)('uses a fresh isolated native profile for $flow without writing history or running chat tools', async profile => {
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

it.each([
  { memory: null, code: 'memory_unknown' },
  { memory: { availableBytes: 32 * 2 ** 30, freeBytes: 1, thresholdBytes: 0, lowMemory: false }, code: 'memory_insufficient' },
  { memory: { availableBytes: 32 * 2 ** 30, freeBytes: 32 * 2 ** 30, thresholdBytes: 0, lowMemory: true }, code: 'memory_insufficient' },
])('refuses $code before context initialization even if chat estimates would fit', async ({ memory, code }) => {
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