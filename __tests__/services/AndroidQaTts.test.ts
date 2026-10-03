import { AppState, type AppStateStatus } from 'react-native';
import { ttsService, type TtsServiceState } from '../../src/services/TtsService';
import { continueAndroidQaTts, waitForAndroidQaTtsPublicControls, prepareAndroidQaTtsProfile } from '../../src/services/AndroidQaTts';
import { TTS_EXECUTION_PROFILES, type TtsExecutionProfile } from '../../src/services/TtsExecutionProfiles';
import { LifecycleStatus, type ModelMetadata } from '../../src/types/models';

const mockSeed = jest.fn(); const mockRegistryUpdate = jest.fn(); const mockQueue = jest.fn();
const mockPrepareCompanion = jest.fn(); const mockCancelDownload = jest.fn();
const mockModels = new Map<string, ModelMetadata>();

jest.mock('../../src/services/TtsService', () => ({ ttsService: { getState: jest.fn() }, resolveTtsBinding: jest.fn() }));
jest.mock('../../src/services/AndroidQaDocumentModelBootstrap', () => ({
  isAndroidQaDocumentModelBootstrapEnabled: () => true, ANDROID_QA_DOCUMENT_MODEL_ID: 'qa-model',
}));
jest.mock('../../src/services/AndroidQaStage7Seed', () => ({ prepareAndroidQaStage7Seed: (...args: unknown[]) => mockSeed(...args) }));
jest.mock('../../src/services/LocalStorageRegistry', () => ({ registry: {
  getModel: (id: string) => mockModels.get(id), updateModel: (...args: unknown[]) => mockRegistryUpdate(...args),
} }));
jest.mock('../../src/store/downloadStore', () => ({ useDownloadStore: { getState: () => ({
  queue: [], downloadOptionsByModelId: {}, addToQueue: (...args: unknown[]) => mockQueue(...args),
}) } }));
jest.mock('../../src/services/ModelDownloadManager', () => ({
  getModelDownloadManager: () => ({ prepareCompanion: (...args: unknown[]) => mockPrepareCompanion(...args),
    cancelDownload: (...args: unknown[]) => mockCancelDownload(...args) }),
  ModelFileLeaseBusyError: class ModelFileLeaseBusyError extends Error {},
}));

describe('single-clip QA background acceptance', () => {
  let state: TtsServiceState;
  let notify: (next: AppStateStatus) => void;
  let remove: jest.Mock;
  let listener: jest.SpyInstance;
  beforeEach(() => {
    jest.useFakeTimers();
    state = { phase: 'ready', clipAvailable: true };
    jest.mocked(ttsService.getState).mockImplementation(() => state);
    remove = jest.fn();
    listener = jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, callback) => {
      notify = callback;
      return { remove };
    });
  });
  afterEach(() => { listener.mockRestore(); jest.useRealTimers(); });

  it('accepts background only while the retained clip is actually playing', async () => {
    const work = waitForAndroidQaTtsPublicControls();
    state = { phase: 'playing', clipAvailable: true };
    notify('background');
    state = { phase: null };
    notify('active');
    continueAndroidQaTts();
    await expect(work).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each<TtsServiceState>([
    { phase: null },
    { phase: 'paused', clipAvailable: true },
    { phase: 'stopped', clipAvailable: true },
    { phase: 'starting', clipAvailable: true },
    { phase: 'playing', clipAvailable: false },
    { phase: 'playing', clipAvailable: true, errorCode: 'playback_failed' },
  ])('rejects a stale prior playing state when background begins from %j', async inactive => {
    const work = waitForAndroidQaTtsPublicControls();
    state = { phase: 'playing', clipAvailable: true };
    state = inactive; // Close/clear, Pause or pending admission replaces the previous playback.
    notify('background');
    continueAndroidQaTts();
    await expect(work).rejects.toThrow('background_playback_missing');
    expect(remove).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('bounds the host-controls wait and removes its native app-state listener', async () => {
    const work = waitForAndroidQaTtsPublicControls();
    const rejection = expect(work).rejects.toThrow('public_controls_timeout');
    await jest.advanceTimersByTimeAsync(180000);
    await rejection;
    expect(remove).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('fixed Stage7 speech fixture seed consumers', () => {
  const profiles = [
    ['neutts', 'neutts-nano-q4_k_m-neucodec-q8_0'],
    ['qwen3', 'qwen3-tts-0.6b-q4_k_m-tokenizer-q8_0'],
  ] as const;
  const profileById = (id: string): TtsExecutionProfile => TTS_EXECUTION_PROFILES.find(profile => profile.id === id)!;
  function installedBackbone(model: ModelMetadata): ModelMetadata {
    return { ...model, localPath: 'verified-backbone.gguf', lifecycleStatus: LifecycleStatus.DOWNLOADED,
      metadataTrust: 'verified_local', downloadIntegrity: { kind: 'sha256', sha256: model.sha256!,
        sizeBytes: model.size!, checkedAt: 1 } };
  }
  beforeEach(() => {
    jest.useFakeTimers(); jest.clearAllMocks(); mockModels.clear(); mockSeed.mockResolvedValue(null);
    mockRegistryUpdate.mockImplementation((model: ModelMetadata) => { mockModels.set(model.id, model); });
    mockQueue.mockImplementation((model: ModelMetadata) => { mockModels.set(model.id, installedBackbone(model)); });
    mockPrepareCompanion.mockImplementation((model: ModelMetadata, id: string) => {
      mockModels.set(model.id, { ...model, artifacts: model.artifacts?.map(artifact => artifact.id === id
        ? { ...artifact, installState: 'installed', localPath: 'verified-codec.gguf', integrity: {
          kind: 'sha256', sha256: artifact.sha256!, sizeBytes: artifact.sizeBytes!, checkedAt: 1 } } : artifact) });
    });
    mockCancelDownload.mockResolvedValue(undefined);
  });
  afterEach(() => jest.useRealTimers());

  it.each(profiles)('returns a verified %s seed without caller publication or download enqueue', async (kind, id) => {
    let verified: ModelMetadata | undefined;
    mockSeed.mockImplementationOnce(async (received: string, desired: ModelMetadata) => {
      expect(received).toBe(kind); verified = installedBackbone(desired); return verified;
    });
    const actual = await prepareAndroidQaTtsProfile(profileById(id));
    expect(actual).toBe(verified);
    expect(mockSeed).toHaveBeenCalledWith(kind, expect.objectContaining({
      id: `pocket-ai/android-qa-tts-${id}`, sha256: profileById(id).backbone.sha256 }));
    expect(mockRegistryUpdate).not.toHaveBeenCalled(); expect(mockQueue).not.toHaveBeenCalled();
    expect(mockPrepareCompanion).not.toHaveBeenCalled(); expect(mockCancelDownload).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(profiles)('keeps backbone and codec download fallback for an entirely missing %s seed', async (kind, id) => {
    const actual = await prepareAndroidQaTtsProfile(profileById(id));
    expect(mockSeed).toHaveBeenCalledWith(kind, expect.anything());
    expect(mockRegistryUpdate).toHaveBeenCalledTimes(2); expect(mockQueue).toHaveBeenCalledTimes(1);
    expect(mockPrepareCompanion).toHaveBeenCalledTimes(1);
    expect(mockQueue).toHaveBeenCalledWith(mockRegistryUpdate.mock.calls[0][0]);
    expect(actual).toMatchObject({ localPath: 'verified-backbone.gguf', artifacts: expect.arrayContaining([
      expect.objectContaining({ installState: 'installed', localPath: 'verified-codec.gguf' })]) });
    expect(mockCancelDownload).not.toHaveBeenCalled(); expect(jest.getTimerCount()).toBe(0);
  });

  it.each(profiles.flatMap(([kind, id]) => ['partial', 'invalid'].map(state => [kind, id, state] as const)))(
    'does not fall through to download/publication for a %s %s %s seed rejection', async (kind, id, _state) => {
      const rejected = new Error('stage7_seed_invalid'); mockSeed.mockRejectedValueOnce(rejected);
      await expect(prepareAndroidQaTtsProfile(profileById(id))).rejects.toBe(rejected);
      expect(mockSeed).toHaveBeenCalledWith(kind, expect.anything());
      expect(mockRegistryUpdate).not.toHaveBeenCalled(); expect(mockQueue).not.toHaveBeenCalled();
      expect(mockPrepareCompanion).not.toHaveBeenCalled(); expect(mockCancelDownload).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });

  it.each(['outetts-1.0-0.6b-q4_k_m-dac-speech-f16', 'bluemagpie-barbet-1b-q4_k_m-audiovae-q8_0'])(
    'preserves the Stage6 %s download path without calling Stage7 seed', async id => {
      const profile = profileById(id); const actual = await prepareAndroidQaTtsProfile(profile);
      expect(actual.id).toBe(`pocket-ai/android-qa-tts-${profile.flow}`);
      expect(mockSeed).not.toHaveBeenCalled(); expect(mockQueue).toHaveBeenCalledTimes(1);
      expect(mockPrepareCompanion).toHaveBeenCalledTimes(1); expect(mockCancelDownload).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });
});
