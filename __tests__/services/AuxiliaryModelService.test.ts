import * as FileSystem from 'expo-file-system/legacy';
import * as RNFS from 'react-native-fs';
import { checkAuxiliaryModel, selectAuxiliaryModel, getAuxiliarySelection, estimateAuxiliaryCheckBytes, resolveModelForResourceEdit } from '../../src/services/AuxiliaryModelService';
import { getSettings, updateSettings, resetSettings, clearAuxiliaryBindingsForModel, storage, SETTINGS_KEY } from '../../src/services/SettingsStore';
import { llmEngineService } from '../../src/services/LLMEngineService';
import { registry } from '../../src/services/LocalStorageRegistry';
import { getSystemMemorySnapshot } from '../../src/services/SystemMetricsService';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';
import { useChatStore } from '../../src/store/chatStore';
import { useDownloadStore } from '../../src/store/downloadStore';
import { bindManagedCompanion, getSelectedManagedCompanions } from '../../src/utils/modelArtifacts';

jest.mock('../../src/services/LLMEngineService', () => ({ llmEngineService: {
  getState: jest.fn(() => ({ activeModelId: 'chat/a' })),
  hasAuxiliaryContextOperation: jest.fn(() => false), runWithAuxiliaryContext: jest.fn(),
  runWithIdleModelResources: jest.fn((operation: () => Promise<unknown>) => operation()),
} }));
jest.mock('../../src/services/SystemMetricsService', () => ({ getSystemMemorySnapshot: jest.fn() }));
jest.mock('../../src/services/FileSystemSetup', () => ({ getModelsDir: () => 'file:///models/' }));
jest.mock('../../src/utils/ggufValidation', () => ({ validateGgufFileHeader: jest.fn(async () => ({ ok: true })), GgufValidationError: class extends Error {} }));

const hash = 'a'.repeat(64);
function model(id = 'embed/b'): ModelMetadata {
  return { id, name: id, author: 'test', size: 25_000_000,
    downloadUrl: `https://huggingface.co/${id}/resolve/rev/model.gguf`, hfRevision: 'rev',
    resolvedFileName: 'model.gguf', localPath: id.replace('/', '-') + '.gguf', sha256: hash,
    accessState: ModelAccessState.PUBLIC, isGated: false, isPrivate: false, fitsInRam: null,
    lifecycleStatus: LifecycleStatus.DOWNLOADED, downloadProgress: 1,
    roleEvidence: [{ role: id === 'chat/a' ? 'chat' : 'embedding', source: 'pipeline_tag', confidence: 'declared' }] };
}
const engine = jest.mocked(llmEngineService);
const context = { model: { nEmbd: 3 }, embedding: jest.fn(async () => ({ embedding: [0.1, 0.2, 0.3] })) };

beforeEach(() => {
  jest.clearAllMocks();
  resetSettings();
  useChatStore.setState({ threads: {}, activeThreadId: null });
  useDownloadStore.setState({ queue: [], activeDownloadId: null });
  registry.saveModels([model('chat/a'), model()]);
  updateSettings({ activeModelId: 'chat/a', modelLoadParamsByModelId: { 'chat/a': { contextSize: 2048, gpuLayers: 0, kvCacheType: 'f16' } } });
  engine.getState.mockReturnValue({ status: 'ready' as never, activeModelId: 'chat/a', loadProgress: 1 });
  engine.hasAuxiliaryContextOperation.mockReturnValue(false);
  jest.mocked(FileSystem.getInfoAsync).mockResolvedValue({ exists: true, isDirectory: false, size: 25_000_000, uri: 'file:///models/file.gguf', modificationTime: 1 });
  jest.mocked(RNFS.hash).mockResolvedValue(hash);
  jest.mocked(getSystemMemorySnapshot).mockResolvedValue({ availableBytes: 2 ** 30, freeBytes: 2 ** 30, thresholdBytes: 0, lowMemory: false } as never);
  engine.runWithAuxiliaryContext.mockImplementation(async (request, operation) => {
    await request.beforeInit?.();
    return operation(context as never);
  });
});

it('hydrates legacy settings and keeps auxiliary choices separate from chat and profiles', () => {
  storage.set(SETTINGS_KEY, JSON.stringify({ activeModelId: 'chat/a' }));
  expect(getSettings().auxiliaryModels).toEqual({});
  const before = getSettings();
  selectAuxiliaryModel('embedding', model());
  expect(getSettings()).toEqual({ ...before, auxiliaryModels: { embedding: expect.objectContaining({ modelId: 'embed/b' }) } });
  expect(getAuxiliarySelection('embedding')?.id).toBe('embed/b');
  clearAuxiliaryBindingsForModel('embed/b');
  expect(getSettings().activeModelId).toBe('chat/a');
  expect(getSettings().auxiliaryModels).toEqual({});
});

it('does not overwrite a newer downloaded record with stale catalog runtime fields', () => {
  selectAuxiliaryModel('embedding', { ...model(), localPath: undefined, lifecycleStatus: LifecycleStatus.AVAILABLE });
  expect(registry.getModel('embed/b')?.localPath).toBe('embed-b.gguf');
  expect(() => selectAuxiliaryModel('embedding', { ...model(), sha256: 'b'.repeat(64) })).toThrow('selection_changed');
});

function availableVariant(fileName: string): ModelMetadata {
  return { ...model(), lifecycleStatus: LifecycleStatus.AVAILABLE, localPath: undefined, downloadProgress: 0,
    resolvedFileName: fileName, downloadUrl: `https://huggingface.co/embed/b/resolve/rev/${fileName}` };
}

it('replaces an explicitly selected available variant without changing the chat selection', () => {
  registry.saveModels([model('chat/a')]);
  selectAuxiliaryModel('embedding', availableVariant('v1.gguf'));
  selectAuxiliaryModel('embedding', availableVariant('v2.gguf'));
  expect(getAuxiliarySelection('embedding')?.resolvedFileName).toBe('v2.gguf');
  expect(getSettings().activeModelId).toBe('chat/a');
});

it('binds companions to the displayed available variant and preserves retained companion files', () => {
  const old = bindManagedCompanion(availableVariant('v1.gguf'), {
    kind: 'lora_adapter', downloadUrl: 'https://example.com/lora.gguf', sizeBytes: 1024,
  });
  old.artifacts![0] = { ...old.artifacts![0], localPath: 'retained-lora.gguf', installState: 'installed' };
  registry.saveModels([old]);
  const next = bindManagedCompanion(resolveModelForResourceEdit(availableVariant('v2.gguf')), {
    kind: 'tts_codec', downloadUrl: 'https://example.com/codec.gguf', sizeBytes: 2048,
  });
  registry.updateModel(next);
  const persisted = registry.getModel('embed/b')!;
  expect(persisted.resolvedFileName).toBe('v2.gguf');
  expect(getSelectedManagedCompanions(persisted).map((artifact) => artifact.kind)).toEqual(['tts_codec']);
  expect(persisted.artifacts?.find((artifact) => artifact.kind === 'lora_adapter')).toMatchObject({
    localPath: 'retained-lora.gguf', installState: 'installed',
  });
});

it.each([LifecycleStatus.QUEUED, LifecycleStatus.PAUSED, LifecycleStatus.VERIFYING])('does not replace a queued variant (%s)', (status) => {
  const original = availableVariant('v1.gguf');
  registry.saveModels([original]);
  useDownloadStore.setState({ queue: [{ ...original, lifecycleStatus: status }] });
  expect(() => selectAuxiliaryModel('embedding', availableVariant('v2.gguf'))).toThrow('busy');
  expect(() => resolveModelForResourceEdit(availableVariant('v2.gguf'))).toThrow('busy');
  expect(registry.getModel('embed/b')?.resolvedFileName).toBe('v1.gguf');
});

it('does not replace downloaded bytes when binding a companion from a stale variant', () => {
  expect(() => resolveModelForResourceEdit(availableVariant('v2.gguf'))).toThrow('selection_changed');
  expect(registry.getModel('embed/b')?.localPath).toBe('embed-b.gguf');
});

it('checks actual embedding output only inside the shared engine and preserves chat settings', async () => {
  selectAuxiliaryModel('embedding', model());
  const before = getSettings();
  expect(await checkAuxiliaryModel('embedding', { verifyEmbedding: true })).toEqual({ operation: 'embedding', dimensions: 3, memoryConfidence: 'low' });
  expect(engine.runWithAuxiliaryContext).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'embed/b', initParams: expect.objectContaining({ embedding: true, n_gpu_layers: 0, n_parallel: 1, n_ctx: 512, state_cache_budget_mb: 0 }) }), expect.any(Function));
  expect(getSettings()).toEqual(before);
  expect(registry.getModel('embed/b')?.roleValidation?.[0]).toMatchObject({ operation: 'embedding', status: 'passed' });
});

it('requires matching source hash before native ownership', async () => {
  selectAuxiliaryModel('embedding', model());
  jest.mocked(RNFS.hash).mockResolvedValue('b'.repeat(64));
  await expect(checkAuxiliaryModel('embedding')).rejects.toMatchObject({ code: 'integrity_failed' });
  expect(engine.runWithAuxiliaryContext).not.toHaveBeenCalled();
});

it('does not promote a successful load to an embedding operation', async () => {
  selectAuxiliaryModel('embedding', model());
  await checkAuxiliaryModel('embedding');
  expect(context.embedding).not.toHaveBeenCalled();
  expect(registry.getModel('embed/b')?.roleValidation?.[0].operation).toBe('load');
});

it.each([null, { availableBytes: 32, freeBytes: 32, thresholdBytes: 0, lowMemory: false }])('rejects unknown or insufficient live memory after chat detaches', async (snapshot) => {
  selectAuxiliaryModel('embedding', model());
  jest.mocked(getSystemMemorySnapshot).mockResolvedValue(snapshot as never);
  await expect(checkAuxiliaryModel('embedding')).rejects.toMatchObject({ code: snapshot ? 'memory_insufficient' : 'memory_unknown' });
  expect(context.embedding).not.toHaveBeenCalled();
  expect(registry.getModel('embed/b')?.roleValidation).toBeUndefined();
});

it('keeps TTS memory unknown instead of reusing chat estimates', () => {
  expect(estimateAuxiliaryCheckBytes(model(), 'tts')).toBeNull();
});

it.each(['chat/a', 'embed/b'])('invalidates restore when either owned model changes identity (%s)', async (id) => {
  selectAuxiliaryModel('embedding', model());
  engine.runWithAuxiliaryContext.mockImplementation(async (request) => {
    registry.updateModel({ ...model(id), sha256: 'b'.repeat(64) });
    expect(request.isCurrent()).toBe(false);
    throw new Error('native failure /private/path prompt=secret');
  });
  await expect(checkAuxiliaryModel('embedding')).rejects.toMatchObject({ message: 'native_failed' });
  expect(registry.getModel('embed/b')?.roleValidation).toBeUndefined();
});

it('rejects busy engine without attempting file validation or native work', async () => {
  selectAuxiliaryModel('embedding', model());
  engine.hasAuxiliaryContextOperation.mockReturnValue(true);
  await expect(checkAuxiliaryModel('embedding')).rejects.toMatchObject({ code: 'busy' });
  expect(engine.runWithAuxiliaryContext).not.toHaveBeenCalled();
});

it('invalidates a binding when a different file replaces the chosen variant', () => {
  selectAuxiliaryModel('embedding', model());
  registry.updateModel({ ...model(), hfRevision: 'next' });
  expect(getAuxiliarySelection('embedding')).toBeUndefined();
  expect(getSettings().activeModelId).toBe('chat/a');
});
