import { AppState, type AppStateStatus } from 'react-native';
import { LifecycleStatus, type ModelMetadata } from '../../src/types/models';
import type { AuxiliaryModelBindings } from '../../src/services/SettingsStore';
import { bindManagedCompanion } from '../../src/utils/modelArtifacts';
import { getModelFileIdentity } from '../../src/utils/modelRoles';
import { DEFAULT_TTS_PROFILE_ID, TTS_EXECUTION_PROFILES } from '../../src/services/TtsExecutionProfiles';
import { getInstalledRecommendedTtsModel, getRecommendedTtsModelMetadata, RECOMMENDED_TTS_DOWNLOAD_MIB,
  RECOMMENDED_TTS_MODEL_ID, TtsModelSetupService } from '../../src/services/TtsModelSetupService';

const mockModels = new Map<string, ModelMetadata>();
let mockQueue: ModelMetadata[] = [];
let mockOptions: Record<string, { companionArtifactId?: string }> = {};
let mockSettings: { auxiliaryModels: AuxiliaryModelBindings; autoSelectTtsModel: boolean };
const mockSettingsListeners = new Set<() => void>();
const mockQueueListeners = new Set<(state: { queue: ModelMetadata[] }) => void>();
const mockRegistryUpdate = jest.fn();
const mockGetModels = jest.fn();
const mockAddToQueue = jest.fn();
const mockPrepareCompanion = jest.fn();
const mockCancelDownload = jest.fn();
const mockSelect = jest.fn();
const mockWritable = jest.fn();
const mockIsWritable = jest.fn();
jest.mock('../../src/services/LocalStorageRegistry', () => ({ registry: {
  getModel: (id: string) => mockModels.get(id), getModels: () => mockGetModels(),
  updateModel: (...args: unknown[]) => mockRegistryUpdate(...args),
} }));
jest.mock('../../src/store/downloadStore', () => ({ useDownloadStore: {
  getState: () => ({ queue: mockQueue, downloadOptionsByModelId: mockOptions, addToQueue: mockAddToQueue }),
  subscribe: (listener: (state: { queue: ModelMetadata[] }) => void) => {
    mockQueueListeners.add(listener); return () => mockQueueListeners.delete(listener);
  },
} }));
jest.mock('../../src/services/SettingsStore', () => ({
  getSettings: () => mockSettings,
  subscribeSettings: (listener: () => void) => { mockSettingsListeners.add(listener); return () => mockSettingsListeners.delete(listener); },
}));
jest.mock('../../src/services/AuxiliaryModelService', () => ({ selectAuxiliaryModel: (...args: unknown[]) => mockSelect(...args) }));
jest.mock('../../src/services/ModelDownloadManager', () => ({ getModelDownloadManager: () => ({
  prepareCompanion: (...args: unknown[]) => mockPrepareCompanion(...args),
  cancelDownload: (...args: unknown[]) => mockCancelDownload(...args),
}) }));
jest.mock('../../src/services/storage', () => ({
  assertPrivateStorageWritable: () => mockWritable(), isPrivateStorageWritable: () => mockIsWritable(),
}));

const profile = TTS_EXECUTION_PROFILES.find(entry => entry.id === DEFAULT_TTS_PROFILE_ID)!;
const codecUrl = `https://huggingface.co/${profile.codec.repository}/resolve/${profile.codec.revision}/${profile.codec.filename}?download=true`;
const notifyQueue = () => mockQueueListeners.forEach(listener => listener({ queue: mockQueue }));
const notifySettings = () => mockSettingsListeners.forEach(listener => listener());
function removeJob(id: string): void {
  mockQueue = mockQueue.filter(model => model.id !== id); delete mockOptions[id]; notifyQueue();
}
function installedBackbone(model = getRecommendedTtsModelMetadata()): ModelMetadata {
  return { ...model, localPath: 'verified-backbone.gguf', lifecycleStatus: LifecycleStatus.DOWNLOADED, downloadProgress: 1,
    metadataTrust: 'verified_local', downloadIntegrity: { kind: 'sha256', sha256: profile.backbone.sha256,
      sizeBytes: profile.backbone.bytes, checkedAt: 1 } };
}
function installedVoice(base = installedBackbone(), downloadUrl = codecUrl): ModelMetadata {
  const bound = bindManagedCompanion(base, { kind: 'tts_codec', downloadUrl,
    sizeBytes: profile.codec.bytes, sha256: profile.codec.sha256 });
  return { ...bound, artifacts: bound.artifacts?.map(artifact => artifact.kind === 'tts_codec' && artifact.selected
    ? { ...artifact, localPath: 'verified-codec.gguf', installState: 'installed', downloadProgress: 1,
      integrity: { kind: 'sha256', sha256: profile.codec.sha256, sizeBytes: profile.codec.bytes, checkedAt: 1 } } : artifact) };
}
const tick = () => jest.advanceTimersByTimeAsync(250);

describe('explicit recommended TTS setup', () => {
  let setup: TtsModelSetupService;
  let notifyAppState: (next: AppStateStatus) => void;
  let appStateListener: jest.SpyInstance;
  let removeAppState: jest.Mock;
  let originalAppStateDescriptor: PropertyDescriptor | undefined;
  beforeEach(() => {
    jest.useFakeTimers(); jest.clearAllMocks(); mockModels.clear(); mockQueue = []; mockOptions = {};
    originalAppStateDescriptor = Object.getOwnPropertyDescriptor(AppState, 'currentState');
    Object.defineProperty(AppState, 'currentState', { configurable: true, writable: true, value: 'active' });
    mockSettings = { auxiliaryModels: {}, autoSelectTtsModel: true };
    mockSettingsListeners.clear(); mockQueueListeners.clear(); setup = new TtsModelSetupService();
    removeAppState = jest.fn();
    appStateListener = jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, callback) => {
      notifyAppState = callback; return { remove: removeAppState };
    });
    mockWritable.mockReset().mockReturnValue(undefined);
    mockIsWritable.mockReset().mockReturnValue(true);
    mockGetModels.mockReset().mockImplementation(() => [...mockModels.values()]);
    mockRegistryUpdate.mockReset().mockImplementation((model: ModelMetadata) => mockModels.set(model.id, model));
    mockAddToQueue.mockReset().mockImplementation((model: ModelMetadata, options?: { companionArtifactId?: string }) => {
      mockQueue = [...mockQueue, { ...model, lifecycleStatus: LifecycleStatus.QUEUED }];
      if (options) mockOptions[model.id] = options;
      notifyQueue();
    });
    mockPrepareCompanion.mockReset().mockImplementation((model: ModelMetadata, id: string) => mockAddToQueue(model, { companionArtifactId: id }));
    mockCancelDownload.mockReset().mockImplementation(async (id: string) => removeJob(id));
    mockSelect.mockReset().mockImplementation((_role: string, model: ModelMetadata) => {
      expect(mockQueue.some(item => item.id === model.id)).toBe(false);
      mockSettings = { auxiliaryModels: { tts: { modelId: model.id, fileIdentity: getModelFileIdentity(model) } }, autoSelectTtsModel: false };
      notifySettings();
    });
  });
  afterEach(() => {
    appStateListener.mockRestore();
    if (originalAppStateDescriptor) Object.defineProperty(AppState, 'currentState', originalAppStateDescriptor);
    else Reflect.deleteProperty(AppState, 'currentState');
    jest.useRealTimers();
  });

  it('keeps installed lookups and pinned metadata free of download side effects', () => {
    expect(getInstalledRecommendedTtsModel()).toBeUndefined();
    expect(getRecommendedTtsModelMetadata()).toMatchObject({ id: RECOMMENDED_TTS_MODEL_ID, name: 'OuteTTS 0.3 (0.5B)',
      parameterSizeLabel: '0.5B', license: 'cc-by-sa-4.0', hfRevision: 'ae0577d4386cfb6f442a610a1ec5f2a27d935fc4',
      sha256: '086667b32948d618c4ddc3a36d2bdb5f40f7afbb721e51cd32b318680543965f', size: 357753600,
      roleEvidence: [{ role: 'tts', source: 'model_card', confidence: 'declared' }] });
    expect(RECOMMENDED_TTS_DOWNLOAD_MIB).toBe(503);
    expect(mockRegistryUpdate).not.toHaveBeenCalled(); expect(mockAddToQueue).not.toHaveBeenCalled(); expect(mockSelect).not.toHaveBeenCalled();
  });

  it('returns no installed recommendation without reading unavailable private storage', () => {
    mockIsWritable.mockReturnValue(false);
    expect(getInstalledRecommendedTtsModel()).toBeUndefined();
    expect(mockGetModels).not.toHaveBeenCalled(); expect(mockRegistryUpdate).not.toHaveBeenCalled();
    expect(mockAddToQueue).not.toHaveBeenCalled(); expect(mockPrepareCompanion).not.toHaveBeenCalled(); expect(mockSelect).not.toHaveBeenCalled();
  });

  it('rejects an inactive startup before reading models or creating any download', async () => {
    Object.defineProperty(AppState, 'currentState', { configurable: true, writable: true, value: 'background' });
    await expect(setup.startRecommended(() => true)).rejects.toMatchObject({ code: 'cancelled' });
    expect(mockGetModels).not.toHaveBeenCalled(); expect(mockRegistryUpdate).not.toHaveBeenCalled();
    expect(mockAddToQueue).not.toHaveBeenCalled(); expect(mockPrepareCompanion).not.toHaveBeenCalled(); expect(mockSelect).not.toHaveBeenCalled();
    expect(removeAppState).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
  });

  it('awaits verified backbone and queue drain before the codec, then explicitly persists the ready voice', async () => {
    const work = setup.startRecommended(() => true);
    await tick();
    expect(mockAddToQueue).toHaveBeenCalledTimes(1); expect(mockPrepareCompanion).not.toHaveBeenCalled();
    expect(setup.getState().phase).toBe('downloading_model');
    const base = installedBackbone(); mockModels.set(base.id, base);
    await tick();
    expect(mockPrepareCompanion).not.toHaveBeenCalled(); // The finished base still owns its queue slot.
    removeJob(base.id); await tick();
    expect(mockPrepareCompanion).toHaveBeenCalledTimes(1); expect(mockSelect).not.toHaveBeenCalled();
    expect(mockPrepareCompanion).toHaveBeenCalledWith(expect.objectContaining({ artifacts: expect.arrayContaining([
      expect.objectContaining({ kind: 'tts_codec', sizeBytes: 169512160,
        sha256: '9b08679358a172b1bf1d4f3394c8bad2779a077a9395d7cd0148dff989feb99f',
        hfRevision: '4cd6ecf17367ebc03bba4b2ce8186268a6ce7436' }),
    ]) }), expect.any(String));
    expect(setup.getState().phase).toBe('downloading_codec');
    const ready = installedVoice(mockModels.get(base.id)!); mockModels.set(ready.id, ready); removeJob(ready.id);
    await tick(); await work;
    expect(mockSelect).toHaveBeenCalledWith('tts', expect.objectContaining({ id: base.id, localPath: base.localPath }));
    expect(setup.getState()).toEqual({ phase: 'ready', progress: 1 });
    expect(mockCancelDownload).not.toHaveBeenCalled(); expect(removeAppState).toHaveBeenCalledTimes(1);
    expect(mockSettingsListeners.size).toBe(0); expect(mockQueueListeners.size).toBe(0); expect(jest.getTimerCount()).toBe(0);
  });

  it('reuses the exact verified voice under an existing catalog id without duplicating weights', async () => {
    const ready = installedVoice(installedBackbone({ ...getRecommendedTtsModelMetadata(), id: 'catalog/existing-oute' }));
    mockModels.set(ready.id, ready);
    expect(getInstalledRecommendedTtsModel()).toBe(ready);
    await setup.startRecommended(() => true);
    expect(mockSelect).toHaveBeenCalledWith('tts', expect.objectContaining({ id: ready.id }));
    expect(mockAddToQueue).not.toHaveBeenCalled(); expect(mockPrepareCompanion).not.toHaveBeenCalled();
    expect(mockModels.has(RECOMMENDED_TTS_MODEL_ID)).toBe(false);
  });

  it('preserves an installed pinned codec with a query-free resolve URL and its existing artifact identity', async () => {
    const ready = installedVoice(installedBackbone(), codecUrl.replace('?download=true', ''));
    const codec = ready.artifacts!.find(artifact => artifact.kind === 'tts_codec' && artifact.selected)!;
    mockModels.set(ready.id, ready);
    await setup.startRecommended(() => true);
    expect(mockSelect).toHaveBeenCalledWith('tts', expect.objectContaining({ artifacts: ready.artifacts }));
    expect(mockSelect.mock.calls[0][1].artifacts[0].id).toBe(codec.id);
    expect(mockSelect.mock.calls[0][1].artifacts[0].downloadUrl).toBe(codec.downloadUrl);
    expect(mockRegistryUpdate).not.toHaveBeenCalled(); expect(mockAddToQueue).not.toHaveBeenCalled();
    expect(mockPrepareCompanion).not.toHaveBeenCalled(); expect(mockCancelDownload).not.toHaveBeenCalled();
  });

  it('cancels and drains only its unfinished codec, keeping the completed backbone installed', async () => {
    const base = installedBackbone(); mockModels.set(base.id, base);
    const work = setup.startRecommended(() => true); const rejection = expect(work).rejects.toMatchObject({ code: 'cancelled' });
    await tick(); await setup.cancel(); await rejection;
    expect(mockCancelDownload).toHaveBeenCalledWith(base.id, { waitForDrain: true });
    expect(mockModels.get(base.id)?.localPath).toBe(base.localPath); expect(mockSelect).not.toHaveBeenCalled();
    const late = installedVoice(base); mockModels.set(base.id, late); await tick();
    expect(mockSelect).not.toHaveBeenCalled(); expect(setup.getState().phase).toBe('cancelled'); expect(jest.getTimerCount()).toBe(0);
  });

  it('observes a preexisting matching job without retrying or cancelling it', async () => {
    const model = getRecommendedTtsModelMetadata(); mockModels.set(model.id, model); mockAddToQueue(model); mockAddToQueue.mockClear();
    const work = setup.startRecommended(() => true); const rejection = expect(work).rejects.toMatchObject({ code: 'cancelled' });
    await tick(); await setup.cancel(); await rejection;
    expect(mockAddToQueue).not.toHaveBeenCalled(); expect(mockRegistryUpdate).not.toHaveBeenCalled();
    expect(mockCancelDownload).not.toHaveBeenCalled(); expect(mockQueue).toHaveLength(1);
  });

  it('preserves a preexisting codec job and does not overwrite its progress metadata', async () => {
    const base = installedBackbone();
    const bound = bindManagedCompanion(base, { kind: 'tts_codec', downloadUrl: codecUrl,
      sizeBytes: profile.codec.bytes, sha256: profile.codec.sha256 });
    mockModels.set(base.id, bound); mockAddToQueue(bound, { companionArtifactId: bound.artifacts![0].id }); mockAddToQueue.mockClear();
    const work = setup.startRecommended(() => true); const rejection = expect(work).rejects.toMatchObject({ code: 'cancelled' });
    await tick(); await setup.cancel(); await rejection;
    expect(mockRegistryUpdate).not.toHaveBeenCalled(); expect(mockPrepareCompanion).not.toHaveBeenCalled();
    expect(mockCancelDownload).not.toHaveBeenCalled(); expect(mockQueue).toHaveLength(1);
  });

  it.each(['installed', 'queued'])('rejects an unmatched %s file without overwriting or cancelling it', async kind => {
    const other = { ...getRecommendedTtsModelMetadata(), sha256: 'b'.repeat(64) };
    if (kind === 'installed') mockModels.set(other.id, installedBackbone(other));
    else mockAddToQueue(other);
    mockAddToQueue.mockClear();
    await expect(setup.startRecommended(() => true)).rejects.toMatchObject({ code: 'conflict' });
    expect(mockRegistryUpdate).not.toHaveBeenCalled(); expect(mockAddToQueue).not.toHaveBeenCalled();
    expect(mockCancelDownload).not.toHaveBeenCalled(); expect(mockSelect).not.toHaveBeenCalled();
  });

  it('invalidates a late completion even if the user changes their choice and then restores the original binding', async () => {
    const work = setup.startRecommended(() => true); const rejection = expect(work).rejects.toMatchObject({ code: 'selection_changed' });
    await tick();
    mockSettings = { auxiliaryModels: { tts: { modelId: 'custom', fileIdentity: 'custom-file' } }, autoSelectTtsModel: false }; notifySettings();
    mockSettings = { auxiliaryModels: {}, autoSelectTtsModel: true }; notifySettings();
    const late = installedBackbone(); mockModels.set(late.id, late); removeJob(late.id);
    await tick(); await rejection;
    expect(mockPrepareCompanion).not.toHaveBeenCalled(); expect(mockSelect).not.toHaveBeenCalled();
    expect(mockModels.get(late.id)?.localPath).toBe(late.localPath);
  });

  it('does not cancel a replacement job after its owned queue entry was removed', async () => {
    const work = setup.startRecommended(() => true); const rejection = expect(work).rejects.toMatchObject({ code: 'cancelled' });
    await tick(); removeJob(RECOMMENDED_TTS_MODEL_ID); mockAddToQueue(getRecommendedTtsModelMetadata());
    await setup.cancel(); await rejection;
    expect(mockCancelDownload).not.toHaveBeenCalled(); expect(mockQueue).toHaveLength(1);
  });

  it('cancels on background and releases its listener and wait timer', async () => {
    const work = setup.startRecommended(() => true); const rejection = expect(work).rejects.toMatchObject({ code: 'cancelled' });
    await tick(); notifyAppState('background'); await tick(); await rejection;
    expect(mockCancelDownload).toHaveBeenCalledTimes(1); expect(mockSelect).not.toHaveBeenCalled();
    expect(removeAppState).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
  });

  it('bounds failed downloads and cancels its own queue entry on timeout', async () => {
    const work = setup.startRecommended(() => true); const rejection = expect(work).rejects.toMatchObject({ code: 'timeout' });
    await tick(); jest.setSystemTime(Date.now() + 30 * 60 * 1000); await tick(); await rejection;
    expect(mockCancelDownload).toHaveBeenCalledTimes(1); expect(mockQueue).toHaveLength(0);
    expect(setup.getState().errorCode).toBe('timeout'); expect(jest.getTimerCount()).toBe(0);
  });

  it('fails closed if cancellation cannot drain within its finite deadline', async () => {
    let drain!: () => void;
    mockCancelDownload.mockImplementationOnce(() => new Promise<void>(resolve => { drain = resolve; }));
    const work = setup.startRecommended(() => true); const rejection = expect(work).rejects.toMatchObject({ code: 'cleanup_failed' });
    await tick(); const cancel = setup.cancel(); const cancelRejection = expect(cancel).rejects.toMatchObject({ code: 'cleanup_failed' });
    await jest.advanceTimersByTimeAsync(30_000); await rejection; await cancelRejection;
    expect(setup.getState().errorCode).toBe('cleanup_failed');
    await expect(setup.startRecommended(() => true)).rejects.toMatchObject({ code: 'cleanup_failed' });
    removeJob(RECOMMENDED_TTS_MODEL_ID); drain(); expect(jest.getTimerCount()).toBe(0);
  });
});
