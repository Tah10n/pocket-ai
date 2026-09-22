import { llmEngineService } from '../../src/services/LLMEngineService';
import { registry } from '../../src/services/LocalStorageRegistry';
import { offloadModel } from '../../src/services/StorageManagerService';
import { ModelDownloadManager, runWithIdleModelDownloads } from '../../src/services/ModelDownloadManager';
import { initLlama, releaseAllLlama } from 'llama.rn';
import * as FileSystem from 'expo-file-system/legacy';
import * as RNFS from 'react-native-fs';
import { checkAuxiliaryModel, selectAuxiliaryModel } from '../../src/services/AuxiliaryModelService';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';

jest.mock('../../src/services/ModelCatalogService', () => ({ modelCatalogService: {} }));
jest.mock('llama.rn', () => ({
  initLlama: jest.fn(), releaseAllLlama: jest.fn().mockResolvedValue(undefined),
  toggleNativeLog: jest.fn().mockResolvedValue(undefined),
  addNativeLogListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
  loadLlamaModelInfo: jest.fn().mockResolvedValue({}),
  getBackendDevicesInfo: jest.fn().mockResolvedValue([]),
  BuildInfo: { number: 'test', commit: 'test' },
}));

function model(id: string, localPath: string): ModelMetadata {
  return { id, name: id, author: 'test', localPath, size: 1024,
    downloadUrl: `https://example.com/${localPath}`, lifecycleStatus: LifecycleStatus.DOWNLOADED,
    accessState: ModelAccessState.PUBLIC, isGated: false, fitsInRam: true } as ModelMetadata;
}

function context() {
  return { completion: jest.fn().mockResolvedValue({ text: 'still here' }),
    getFormattedChat: jest.fn().mockResolvedValue({ prompt: 'Prompt', additional_stops: [] }),
    tokenize: jest.fn().mockResolvedValue({ tokens: [] }), stopCompletion: jest.fn().mockResolvedValue(undefined),
    gpu: false, devices: [], reasonNoGPU: 'CPU', systemInfo: 'test', androidLib: null };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function untilCalled(mock: jest.Mock) {
  for (let i = 0; i < 100 && !mock.mock.calls.length; i++) await Promise.resolve();
  expect(mock).toHaveBeenCalled();
}

function removeCompanion(modelId: string, artifactId: string) {
  // Invoke the actual entry point without starting the download singleton's observers.
  return ModelDownloadManager.prototype.removeCompanion.call({ activeJob: null } as any, modelId, artifactId);
}

describe('resource deletion with the real engine and registry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (initLlama as jest.Mock).mockImplementation(async () => context());
    (releaseAllLlama as jest.Mock).mockResolvedValue(undefined);
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 1024 });
    (FileSystem.deleteAsync as jest.Mock).mockResolvedValue(undefined);
    registry.saveModels([model('org/A', 'A.gguf'), model('org/B', 'B.gguf')]);
  });

  it('removes an unused companion while keeping the loaded context', async () => {
    const b = model('org/B', 'B.gguf');
    b.artifacts = [{ id: 'codec', kind: 'tts_codec', requiredFor: [], selected: true,
      remoteFileName: 'codec.gguf', downloadUrl: 'https://example.com/codec.gguf', sizeBytes: 1024,
      localPath: 'codec.gguf', installState: 'installed' }];
    registry.updateModel(b);
    await llmEngineService.load('org/A');
    const loaded = (llmEngineService as any).context;
    await removeCompanion('org/B', 'codec');
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(expect.stringContaining('/codec.gguf'));
    expect(registry.getModel('org/B')?.artifacts?.find(item => item.id === 'codec')).toMatchObject({ installState: 'remote', selected: false });
    expect((llmEngineService as any).context).toBe(loaded);
    expect(initLlama).toHaveBeenCalledTimes(1);
    expect(releaseAllLlama).not.toHaveBeenCalled();
  });

  it('removes only the second reference when A and B share a file', async () => {
    registry.updateModel(model('org/B', 'A.gguf'));
    await llmEngineService.load('org/A');
    await offloadModel('org/B');
    expect(registry.getModel('org/B')).toBeUndefined();
    expect(registry.getModel('org/A')?.localPath).toBe('A.gguf');
    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    expect(releaseAllLlama).not.toHaveBeenCalled();
  });

  it('preserves companion metadata refreshed while deletion is suspended', async () => {
    const b = model('org/B', 'B.gguf');
    b.artifacts = [{ id: 'codec', kind: 'tts_codec', requiredFor: [], selected: true,
      remoteFileName: 'codec.gguf', downloadUrl: 'https://example.com/codec.gguf', sizeBytes: 1024,
      localPath: 'codec.gguf', installState: 'installed' }];
    registry.updateModel(b);
    await llmEngineService.load('org/A');
    const disk = deferred();
    (FileSystem.deleteAsync as jest.Mock).mockImplementationOnce(() => disk.promise);
    const removing = removeCompanion('org/B', 'codec');
    await untilCalled(FileSystem.deleteAsync as jest.Mock);
    const current = registry.getModel('org/B')!;
    registry.updateModel({ ...current, name: 'refreshed B', artifacts: current.artifacts?.map(item => item.id === 'codec'
      ? { ...item, downloadUrl: 'https://example.com/new-codec.gguf' } : item) });
    disk.resolve();
    await removing;
    expect(registry.getModel('org/B')?.name).toBe('refreshed B');
    expect(registry.getModel('org/B')?.artifacts?.find(item => item.id === 'codec')?.installState).toBe('remote');
    expect(registry.getModel('org/B')?.artifacts?.find(item => item.id === 'codec')?.downloadUrl).toBe('https://example.com/new-codec.gguf');
  });

  it('protects A original native file even after its registry path changes', async () => {
    await llmEngineService.load('org/A');
    registry.updateModel(model('org/A', 'new-A.gguf'));
    registry.updateModel(model('org/B', 'A.gguf'));
    await expect(offloadModel('org/B')).rejects.toMatchObject({ code: 'engine_busy' });
    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
  });

  it.each(['projector', 'draft', 'unknown'])('protects loaded %s ownership independently of registry selection', async kind => {
    await llmEngineService.load('org/A');
    const engine = llmEngineService as any;
    if (kind === 'projector') engine.activeMultimodalContext = { projectorResolvedPath: registry.getModelResourcePathsForRemoval('org/B')[0] };
    if (kind === 'draft') {
      engine.activeSpeculativeDecoding = { mode: 'draft_model' };
      engine.activeSpeculativeDraftPath = registry.getModelResourcePathsForRemoval('org/B')[0];
    }
    if (kind === 'unknown') engine.loadedArtifactIdentity = null;
    try {
      await expect(offloadModel('org/B')).rejects.toMatchObject({ code: 'engine_busy' });
      expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    } finally {
      engine.activeMultimodalContext = null;
      engine.activeSpeculativeDecoding = null;
      engine.activeSpeculativeDraftPath = null;
    }
  });

  it('rejects a deletion plan widened by registry changes before the lease executes', async () => {
    await llmEngineService.load('org/A');
    const removing = offloadModel('org/B');
    registry.updateModel(model('org/A', 'new-A.gguf'));
    registry.updateModel(model('org/B', 'A.gguf'));
    await expect(removing).rejects.toMatchObject({ code: 'engine_busy' });
    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
  });

  it('queues a new native load behind the whole deferred deletion', async () => {
    await llmEngineService.load('org/A');
    const disk = deferred();
    (FileSystem.deleteAsync as jest.Mock).mockImplementationOnce(() => disk.promise);
    const deleting = offloadModel('org/B');
    await untilCalled(FileSystem.deleteAsync as jest.Mock);
    await expect(offloadModel('org/B')).rejects.toMatchObject({ code: 'action_failed' });
    await expect(llmEngineService.runWithIdleModelResources(async () => undefined, [])).rejects.toMatchObject({ code: 'engine_busy' });
    registry.updateModel(model('org/C', 'C.gguf'));
    const loading = llmEngineService.load('org/C');
    await Promise.resolve();
    expect(initLlama).toHaveBeenCalledTimes(1);
    expect(releaseAllLlama).not.toHaveBeenCalled();
    disk.resolve();
    await deleting;
    await loading;
    expect(registry.getModel('org/C')?.localPath).toBe('C.gguf');
    expect(llmEngineService.getState().activeModelId).toBe('org/C');
  });

  it('preserves a new shared reference registered during the pre-delete file check', async () => {
    await llmEngineService.load('org/A');
    const inspected = deferred<{ exists: boolean; size: number }>();
    (FileSystem.getInfoAsync as jest.Mock).mockClear().mockImplementationOnce(() => inspected.promise);
    const deleting = offloadModel('org/B');
    await untilCalled(FileSystem.getInfoAsync as jest.Mock);
    registry.updateModel(model('org/C', 'B.gguf'));
    inspected.resolve({ exists: true, size: 1024 });
    await deleting;
    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    expect(registry.getModel('org/C')?.localPath).toBe('B.gguf');
  });

  it('failed deletion releases its own lease while a queued pending init stays protected', async () => {
    await llmEngineService.load('org/A');
    const disk = deferred();
    const initializing = deferred<ReturnType<typeof context>>();
    (FileSystem.deleteAsync as jest.Mock).mockImplementationOnce(() => disk.promise);
    const deleting = offloadModel('org/B');
    const failed = expect(deleting).rejects.toThrow('disk failure');
    await untilCalled(FileSystem.deleteAsync as jest.Mock);
    registry.updateModel(model('org/C', 'C.gguf'));
    (initLlama as jest.Mock).mockClear().mockImplementationOnce(() => initializing.promise);
    const loading = llmEngineService.load('org/C');
    disk.reject(new Error('disk failure'));
    await failed;
    await untilCalled(initLlama as jest.Mock);
    await expect(offloadModel('org/B')).rejects.toMatchObject({ code: 'engine_busy' });
    expect(registry.getModel('org/B')).toBeDefined();
    initializing.resolve(context());
    await loading;
    await expect(runWithIdleModelDownloads(async () => true)).resolves.toBe(true);
  });

  it('keeps pending release ownership until native release finishes', async () => {
    await llmEngineService.load('org/A');
    const released = deferred();
    (releaseAllLlama as jest.Mock).mockImplementationOnce(() => released.promise);
    const unloading = llmEngineService.unload();
    await untilCalled(releaseAllLlama as jest.Mock);
    await expect(offloadModel('org/B')).rejects.toMatchObject({ code: 'engine_busy' });
    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    released.resolve();
    await unloading;
  });

  it('keeps orphaned native ownership blocked', async () => {
    const engine = llmEngineService as any;
    const release = deferred();
    engine.orphanedContextReleasePromise = release.promise;
    try {
      await expect(offloadModel('org/B')).rejects.toMatchObject({ code: 'engine_unloading' });
      expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      engine.orphanedContextReleasePromise = null;
    }
  });

  it('rejects removal during an auxiliary file check before native init', async () => {
    const checked = deferred();
    const beforeInit = jest.fn(() => checked.promise);
    const checking = llmEngineService.runWithAuxiliaryContext({ modelId: 'org/B',
      initParams: { model: '/B.gguf', embedding: true, n_ctx: 512, n_gpu_layers: 0 },
      isCurrent: () => true, beforeInit }, async () => true);
    await untilCalled(beforeInit);
    await expect(offloadModel('org/B')).rejects.toMatchObject({ code: 'engine_busy' });
    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    checked.resolve();
    await checking;
  });

  it('owns the initial auxiliary hash check while A stays loaded', async () => {
    const b = { ...model('org/B', 'B.gguf'), sha256: 'a'.repeat(64),
      roleEvidence: [{ role: 'embedding' as const, source: 'pipeline_tag' as const, confidence: 'declared' as const }] };
    registry.updateModel(b);
    await llmEngineService.load('org/A');
    selectAuxiliaryModel('embedding', b);
    const loaded = (llmEngineService as any).context;
    const hash = deferred<string>();
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue(Buffer.from([
      0x47, 0x47, 0x55, 0x46, 3, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]).toString('base64'));
    (RNFS.hash as jest.Mock).mockClear().mockImplementationOnce(() => hash.promise);
    const checked = expect(checkAuxiliaryModel('embedding')).rejects.toMatchObject({ code: 'integrity_failed' });
    await untilCalled(RNFS.hash as jest.Mock);
    try {
      await expect(offloadModel('org/B')).rejects.toMatchObject({ code: 'action_failed' });
      expect(() => llmEngineService.assertModelResourcesIdle([])).toThrow();
      expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
      expect((llmEngineService as any).context).toBe(loaded);
      expect(initLlama).toHaveBeenCalledTimes(1);
      expect(releaseAllLlama).not.toHaveBeenCalled();
    } finally {
      hash.resolve('b'.repeat(64));
      await checked;
    }
    // Failed file validation gives up its leases and does not unload A.
    await offloadModel('org/B');
    expect((llmEngineService as any).context).toBe(loaded);
  });
  afterEach(async () => { await llmEngineService.unload(); });

  it('offloads independent B while idle A retains its exact context and selection', async () => {
    await llmEngineService.load('org/A');
    const loaded = (llmEngineService as any).context;
    const before = llmEngineService.getState();
    await offloadModel('org/B');
    expect(registry.getModel('org/B')).toBeUndefined();
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(expect.stringContaining('/B.gguf'));
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(expect.stringContaining('/A.gguf'));
    expect((llmEngineService as any).context).toBe(loaded);
    expect(llmEngineService.getState().activeModelId).toBe(before.activeModelId);
    expect(initLlama).toHaveBeenCalledTimes(1);
    expect(releaseAllLlama).not.toHaveBeenCalled();
  });
});
