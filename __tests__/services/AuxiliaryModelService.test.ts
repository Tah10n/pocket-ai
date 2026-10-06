import * as FileSystem from 'expo-file-system/legacy';
import * as RNFS from 'react-native-fs';
import { checkAuxiliaryModel, selectAuxiliaryModel, getAuxiliarySelection, estimateAuxiliaryCheckBytes, resolveModelForResourceEdit } from '../../src/services/AuxiliaryModelService';
import { getSettings, updateSettings, resetSettings, clearAuxiliaryBindingsForModel, invalidateSettingsStorageForPrivateReset, storage, SETTINGS_KEY } from '../../src/services/SettingsStore';
import { llmEngineService } from '../../src/services/LLMEngineService';
import { registry } from '../../src/services/LocalStorageRegistry';
import { getSystemMemorySnapshot } from '../../src/services/SystemMetricsService';
import { LifecycleStatus, ModelAccessState, type ModelArtifactMetadata, type ModelMetadata } from '../../src/types/models';
import { useChatStore } from '../../src/store/chatStore';
import { useDownloadStore } from '../../src/store/downloadStore';
import { bindManagedCompanion, getSelectedManagedCompanions } from '../../src/utils/modelArtifacts';
import { getModelFileIdentity } from '../../src/utils/modelRoles';
import { DEFAULT_TTS_PROFILE_ID, TTS_EXECUTION_PROFILES, type TtsExecutionProfile } from '../../src/services/TtsExecutionProfiles';

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

const preferredTtsProfile = TTS_EXECUTION_PROFILES.find(profile => profile.id === DEFAULT_TTS_PROFILE_ID)!;
function installedTtsModel(profile: TtsExecutionProfile = preferredTtsProfile, id = 'tts/oute'): ModelMetadata {
  const base = { ...model(id), size: profile.backbone.bytes, sha256: profile.backbone.sha256,
    downloadUrl: `https://huggingface.co/${profile.backbone.repository}/resolve/${profile.backbone.revision}/${profile.backbone.filename}`,
    hfRevision: profile.backbone.revision, resolvedFileName: profile.backbone.filename,
    roleEvidence: [{ role: 'tts' as const, source: 'pipeline_tag' as const, confidence: 'declared' as const }] };
  const bound = bindManagedCompanion(base, { kind: 'tts_codec',
    downloadUrl: `https://huggingface.co/${profile.codec.repository}/resolve/${profile.codec.revision}/${profile.codec.filename}`,
    sha256: profile.codec.sha256, sizeBytes: profile.codec.bytes });
  return { ...bound, artifacts: bound.artifacts!.map(artifact => ({ ...artifact,
    installState: 'installed' as const, localPath: id.replace('/', '-') + '-codec.gguf' })) };
}
function withCodecChanges(entry: ModelMetadata, changes: Partial<ModelArtifactMetadata>): ModelMetadata {
  return { ...entry, artifacts: entry.artifacts?.map(artifact => artifact.kind === 'tts_codec'
    ? { ...artifact, ...changes } : artifact) };
}

it('resolves the preferred installed TTS pair without selecting, downloading, hashing, or loading it', () => {
  const preferred = installedTtsModel();
  registry.saveModels([model('chat/a'), preferred]);
  const before = getSettings();
  const modelsBefore = registry.getModels();
  expect(getAuxiliarySelection('tts')?.id).toBe(preferred.id);
  expect(getSettings()).toEqual(before);
  expect(getSettings().auxiliaryModels?.tts).toBeUndefined();
  expect(registry.getModels()).toEqual(modelsBefore);
  expect(useDownloadStore.getState().queue).toEqual([]);
  expect(FileSystem.getInfoAsync).not.toHaveBeenCalled();
  expect(RNFS.hash).not.toHaveBeenCalled();
  expect(engine.runWithAuxiliaryContext).not.toHaveBeenCalled();
});

it('keeps the automatic choice stable when registry order changes', () => {
  const first = installedTtsModel(preferredTtsProfile, 'tts/a');
  const second = installedTtsModel(preferredTtsProfile, 'tts/z');
  registry.saveModels([second, first]);
  expect(getAuxiliarySelection('tts')?.id).toBe(first.id);
  registry.saveModels([first, second]);
  expect(getAuxiliarySelection('tts')?.id).toBe(first.id);
});

it('allows the preferred pair with active installed lifecycle metadata', () => {
  const preferred = { ...installedTtsModel(), lifecycleStatus: LifecycleStatus.ACTIVE };
  registry.saveModels([preferred]);
  expect(getAuxiliarySelection('tts')?.id).toBe(preferred.id);
});

it('does not substitute another supported profile for a missing preferred pair', () => {
  registry.saveModels([installedTtsModel(TTS_EXECUTION_PROFILES.find(profile => profile.family === 'neutts')!, 'tts/other')]);
  expect(getAuxiliarySelection('tts')).toBeUndefined();
});

it('requires the first selected codec to match the preferred profile', () => {
  const preferred = installedTtsModel();
  const codec = preferred.artifacts![0];
  registry.saveModels([{ ...preferred, artifacts: [
    { ...codec, id: 'wrong-first-codec', sha256: 'c'.repeat(64) }, codec,
  ] }]);
  expect(getAuxiliarySelection('tts')).toBeUndefined();
});

it('preserves an explicit custom TTS selection and does not revive the default after its deletion', () => {
  const customProfile = TTS_EXECUTION_PROFILES.find(profile => profile.family === 'neutts')!;
  const custom = installedTtsModel(customProfile, 'tts/custom');
  registry.saveModels([installedTtsModel(), custom]);
  selectAuxiliaryModel('tts', custom);
  expect(getAuxiliarySelection('tts')?.id).toBe(custom.id);
  expect(getSettings().autoSelectTtsModel).toBe(false);
  clearAuxiliaryBindingsForModel(custom.id);
  expect(getAuxiliarySelection('tts')).toBeUndefined();
});

it('retains an explicit unavailable custom TTS model instead of silently choosing an installed default', () => {
  const custom = { ...installedTtsModel(TTS_EXECUTION_PROFILES.find(profile => profile.family === 'neutts')!, 'tts/custom'),
    localPath: undefined, lifecycleStatus: LifecycleStatus.AVAILABLE, artifacts: [] };
  registry.saveModels([installedTtsModel(), custom]);
  selectAuxiliaryModel('tts', custom);
  expect(getAuxiliarySelection('tts')?.id).toBe(custom.id);
  expect(getAuxiliarySelection('tts')?.localPath).toBeUndefined();
});

it('persists explicit TTS unselect across a fresh settings handle', () => {
  registry.saveModels([installedTtsModel()]);
  expect(getAuxiliarySelection('tts')).toBeDefined();
  selectAuxiliaryModel('tts', null);
  invalidateSettingsStorageForPrivateReset();
  expect(getSettings().autoSelectTtsModel).toBe(false);
  expect(getAuxiliarySelection('tts')).toBeUndefined();
});

it.each(['missing model', 'changed file identity'] as const)('does not fall back past an explicit TTS binding with %s', reason => {
  const preferred = installedTtsModel();
  registry.saveModels([preferred]);
  updateSettings({ autoSelectTtsModel: true, auxiliaryModels: { tts: {
    modelId: reason === 'missing model' ? 'tts/removed' : preferred.id, fileIdentity: 'stale-identity',
  } } });
  expect(getAuxiliarySelection('tts')).toBeUndefined();
});

it('fails closed when malformed persisted explicit TTS identity is removed during settings sanitation', () => {
  registry.saveModels([installedTtsModel()]);
  storage.set(SETTINGS_KEY, JSON.stringify({ autoSelectTtsModel: true,
    auxiliaryModels: { tts: { modelId: 'tts/custom', fileIdentity: '' } } }));
  expect(getAuxiliarySelection('tts')).toBeUndefined();
  expect(getSettings().autoSelectTtsModel).toBe(false);
});

it.each<[string, (entry: ModelMetadata) => ModelMetadata]>([
  ['missing backbone path', entry => ({ ...entry, localPath: undefined })],
  ['uninstalled backbone', entry => ({ ...entry, lifecycleStatus: LifecycleStatus.AVAILABLE })],
  ['malformed backbone hash', entry => ({ ...entry, sha256: 'not-a-sha256' })],
  ['different backbone size', entry => ({ ...entry, size: preferredTtsProfile.backbone.bytes + 1 })],
  ['missing TTS role evidence', entry => ({ ...entry, roleEvidence: [] })],
  ['missing codec', entry => ({ ...entry, artifacts: [] })],
  ['unselected codec', entry => withCodecChanges(entry, { selected: false })],
  ['wrong codec base binding', entry => withCodecChanges(entry, { boundToModelIdentity: 'another-base' })],
  ['uninstalled codec', entry => withCodecChanges(entry, { installState: 'remote' })],
  ['missing codec path', entry => withCodecChanges(entry, { localPath: undefined })],
  ['unsafe codec path', entry => withCodecChanges(entry, { localPath: '../codec.gguf' })],
  ['malformed codec hash', entry => withCodecChanges(entry, { sha256: 'not-a-sha256' })],
  ['different codec size', entry => withCodecChanges(entry, { sizeBytes: preferredTtsProfile.codec.bytes + 1 })],
])('keeps automatic TTS unavailable with %s', (_reason, change) => {
  registry.saveModels([change(installedTtsModel())]);
  expect(getAuxiliarySelection('tts')).toBeUndefined();
  expect(engine.runWithAuxiliaryContext).not.toHaveBeenCalled();
});

it('does not apply the TTS default to embedding or reranker selections', () => {
  registry.saveModels([installedTtsModel()]);
  expect(getAuxiliarySelection('embedding')).toBeUndefined();
  expect(getAuxiliarySelection('reranker')).toBeUndefined();
  selectAuxiliaryModel('embedding', model());
  expect(getSettings().autoSelectTtsModel).toBe(true);
  expect(getAuxiliarySelection('embedding')?.id).toBe('embed/b');
});
