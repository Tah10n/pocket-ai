import { prepareAndroidQaStage7Seed } from '../../src/services/AndroidQaStage7Seed';
import manifest from '../../docs/validation/llama-rn-stage7/audio-input-fixtures.json';
import { TTS_EXECUTION_PROFILES } from '../../src/services/TtsExecutionProfiles';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';
import { normalizePersistedModelMetadata } from '../../src/services/ModelMetadataNormalizer';

type File = { size: number; hash: string; header: string; isDirectory?: boolean };
const mockFiles = new Map<string, File>();
const mockInfo = jest.fn(async (uri: string) => mockFiles.has(uri)
  ? { exists: true, ...mockFiles.get(uri) } : { exists: false });
const mockHash = jest.fn(async (path: string, _algorithm?: string) => mockFiles.get('file://' + path)?.hash);
const mockMove = jest.fn(async ({ from, to }: { from: string; to: string }) => {
  if (mockFiles.has(to) || !mockFiles.has(from)) throw new Error('unsafe_move');
  mockFiles.set(to, mockFiles.get(from)!); mockFiles.delete(from);
});
const mockCancel = jest.fn(async (id: string, _options?: { waitForDrain?: boolean }) => { mockQueue = mockQueue.filter(item => item.id !== id); });
const mockRegistryWrite = jest.fn();
let mockDownloadLease = false; let mockResourceLease = false;
let mockEnabled = true; let mockPackage = 'com.github.tah10n.pocketai.qa';
let mockCurrent: ModelMetadata | undefined; let mockQueue: ModelMetadata[] = [];
let mockOptions: Record<string, { companionArtifactId?: string }> = {};
const cache = 'file:///data/user/0/com.github.tah10n.pocketai.qa/cache/';
const models = 'file:///data/user/0/com.github.tah10n.pocketai.qa/files/models/';
let mockCache = cache; let mockModels = models;
jest.mock('expo-file-system/legacy', () => ({
  EncodingType: { Base64: 'base64' }, getInfoAsync: (uri: string) => mockInfo(uri),
  readAsStringAsync: async (uri: string, options: { length: number; position: number }) => {
    expect(options).toEqual({ encoding: 'base64', length: 24, position: 0 });
    return mockFiles.get(uri)?.header;
  },
  moveAsync: (options: { from: string; to: string }) => mockMove(options), makeDirectoryAsync: jest.fn(),
}));
jest.mock('react-native-fs', () => ({ __esModule: true, default: { hash: (path: string, algorithm: string) => mockHash(path, algorithm) } }));
jest.mock('react-native-device-info', () => ({ __esModule: true, default: { getBundleId: () => mockPackage } }));
jest.mock('../../src/services/AndroidQaDocumentModelBootstrap', () => ({ isAndroidQaDocumentModelBootstrapEnabled: () => mockEnabled }));
jest.mock('../../src/services/FileSystemSetup', () => ({
  getAppCacheRootDir: () => mockCache,
  getModelsDir: () => mockModels,
}));
jest.mock('../../src/services/LocalStorageRegistry', () => ({ registry: {
  getModel: () => mockCurrent, updateModel: (...args: unknown[]) => mockRegistryWrite(...args),
} }));
jest.mock('../../src/services/ModelDownloadManager', () => ({
  getModelDownloadManager: () => ({ cancelDownload: (id: string, options: { waitForDrain?: boolean }) => mockCancel(id, options) }),
  runWithIdleModelDownloads: async (operation: () => Promise<unknown>) => {
    mockDownloadLease = true; try { return await operation(); } finally { mockDownloadLease = false; }
  },
}));
jest.mock('../../src/services/LLMEngineService', () => ({ llmEngineService: {
  runWithIdleModelResources: async (operation: () => Promise<unknown>) => {
    mockResourceLease = true; try { return await operation(); } finally { mockResourceLease = false; }
  },
} }));
jest.mock('../../src/services/storage', () => ({ assertPrivateStorageWritable: jest.fn() }));
jest.mock('../../src/store/downloadStore', () => ({ useDownloadStore: {
  getState: () => ({ queue: mockQueue, downloadOptionsByModelId: mockOptions }),
} }));

const url = (repository: string, revision: string, filename: string) =>
  `https://huggingface.co/${repository}/resolve/${revision}/${filename}?download=true`;
function desired(kind: 'ultravox' | 'neutts' | 'qwen3' = 'ultravox'): ModelMetadata {
  const input = manifest.audioInput;
  const profile = TTS_EXECUTION_PROFILES.find(item => item.family === (kind === 'neutts' ? 'neutts' : 'qwen3_tts'))!;
  const backbone = kind === 'ultravox' ? { ...input.backbone, repository: input.repository, revision: input.revision } : profile.backbone;
  const projectorId = 'android-qa-stage7-ultravox-projector';
  return { id: kind === 'ultravox' ? 'pocket-ai/android-qa-ultravox-1b' : `pocket-ai/android-qa-tts-${profile.id}`,
    name: 'QA', author: 'public', downloadUrl: url(backbone.repository, backbone.revision, backbone.filename),
    size: backbone.bytes, sha256: backbone.sha256, hfRevision: backbone.revision, resolvedFileName: backbone.filename,
    lifecycleStatus: LifecycleStatus.AVAILABLE, fitsInRam: null, downloadProgress: 0,
    accessState: ModelAccessState.PUBLIC, isPrivate: false, isGated: false,
    ...(kind === 'ultravox' ? { selectedProjectorId: projectorId,
      projectorCandidates: [{ id: projectorId, ownerModelId: 'pocket-ai/android-qa-ultravox-1b',
        repoId: input.repository, fileName: input.projector.filename, hfRevision: input.revision,
        downloadUrl: url(input.repository, input.revision, input.projector.filename), size: input.projector.bytes,
        sha256: input.projector.sha256, lifecycleStatus: 'available', matchStatus: 'matched' }],
      artifacts: [{ id: projectorId, kind: 'multimodal_projector', requiredFor: ['audio'],
        remoteFileName: input.projector.filename, hfRevision: input.revision,
        downloadUrl: url(input.repository, input.revision, input.projector.filename),
        sizeBytes: input.projector.bytes, sha256: input.projector.sha256, installState: 'remote' }] } : {}),
  };
}
function seed(kind: 'ultravox' | 'neutts' | 'qwen3' = 'ultravox') {
  const profile = TTS_EXECUTION_PROFILES.find(item => item.family === (kind === 'neutts' ? 'neutts' : 'qwen3_tts'))!;
  const sources = kind === 'ultravox' ? [manifest.audioInput.backbone, manifest.audioInput.projector] : [profile.backbone, profile.codec];
  const header = Buffer.alloc(24); header.write('GGUF'); header.writeUInt32LE(3, 4); header.writeUInt32LE(1, 8);
  for (const source of sources) mockFiles.set(mockCache + 'stage7-model-fixtures/' + source.sha256 + '.gguf',
    { size: source.bytes, hash: source.sha256, header: header.toString('base64') });
  return sources;
}
const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
beforeEach(() => {
  jest.clearAllMocks(); mockFiles.clear(); mockEnabled = true; mockPackage = 'com.github.tah10n.pocketai.qa';
  mockCurrent = undefined; mockQueue = []; mockOptions = {};
  mockCache = cache; mockModels = models;
  mockDownloadLease = false; mockResourceLease = false;
  mockRegistryWrite.mockImplementation(() => {
    expect(mockDownloadLease).toBe(true); expect(mockResourceLease).toBe(true);
  });
  mockHash.mockImplementation(async (path: string, _algorithm?: string) => mockFiles.get('file://' + path)?.hash);
  mockCancel.mockImplementation(async (id: string) => { mockQueue = mockQueue.filter(item => item.id !== id); });
});

test.each(['ultravox', 'neutts', 'qwen3'] as const)('verifies the fixed %s pair natively before returning installed metadata', async kind => {
  const sources = seed(kind); const result = await prepareAndroidQaStage7Seed(kind, desired(kind));
  expect(mockHash).toHaveBeenCalledTimes(4);
  expect(mockHash.mock.calls.every(call => call[1] === 'sha256')).toBe(true);
  expect(result).toMatchObject({ lifecycleStatus: LifecycleStatus.DOWNLOADED, downloadProgress: 1,
    metadataTrust: 'verified_local', localPath: 'qa-stage7-' + sources[0].sha256 + '.gguf',
    downloadIntegrity: { kind: 'sha256', sha256: sources[0].sha256, sizeBytes: sources[0].bytes },
    artifacts: expect.arrayContaining([expect.objectContaining({ installState: 'installed',
      localPath: 'qa-stage7-' + sources[1].sha256 + '.gguf', integrity: { kind: 'sha256',
        sha256: sources[1].sha256, sizeBytes: sources[1].bytes, checkedAt: expect.any(Number) } })]) });
  expect(mockRegistryWrite).toHaveBeenCalledTimes(1); expect(mockRegistryWrite).toHaveBeenCalledWith(result);
  expect(mockDownloadLease).toBe(false); expect(mockResourceLease).toBe(false);
});

test.each(['ultravox', 'neutts', 'qwen3'] as const)('keeps the named QA %s seed inside its actual bundle cache under both leases', async kind => {
  mockPackage = 'com.github.tah10n.pocketai.stage7.qa';
  mockCache = `file:///data/user/0/${mockPackage}/cache/`;
  mockModels = `file:///data/user/0/${mockPackage}/files/models/`;
  const sources = seed(kind);
  const result = await prepareAndroidQaStage7Seed(kind, desired(kind));
  expect(result?.localPath).toBe('qa-stage7-' + sources[0].sha256 + '.gguf');
  expect(mockHash).toHaveBeenCalledTimes(4);
  expect(mockMove.mock.calls.every(([options]) => options.from.startsWith(mockCache) && options.to.startsWith(mockModels))).toBe(true);
  expect(mockRegistryWrite).toHaveBeenCalledWith(result);
  expect(mockDownloadLease).toBe(false); expect(mockResourceLease).toBe(false);
});

test('rejects the old QA cache when the running bundle is the named instance before any file access', async () => {
  mockPackage = 'com.github.tah10n.pocketai.stage7.qa'; seed();
  await expect(prepareAndroidQaStage7Seed('ultravox', desired())).rejects.toThrow('stage7_seed_invalid');
  expect(mockInfo).not.toHaveBeenCalled(); expect(mockHash).not.toHaveBeenCalled();
  expect(mockMove).not.toHaveBeenCalled(); expect(mockRegistryWrite).not.toHaveBeenCalled();
});

test.each(['com.github.tah10n.pocketai', 'com.other.stage7.qa', 'com.github.tah10n.pocketai.other.stage7.qa',
  'com.github.tah10n.pocketai.Stage7.qa', 'com.github.tah10n.pocketai.stage7.qa\n'])(
  'does not provision fixtures for unsupported bundle %j', async packageName => {
    mockPackage = packageName; seed();
    await expect(prepareAndroidQaStage7Seed('ultravox', desired())).resolves.toBeNull();
    expect(mockInfo).not.toHaveBeenCalled(); expect(mockHash).not.toHaveBeenCalled();
    expect(mockRegistryWrite).not.toHaveBeenCalled();
  },
);

test('admits the actual registry-normalized projector source while preserving native verification and file leases', async () => {
  seed();
  const raw = desired();
  mockCurrent = normalizePersistedModelMetadata(raw);
  const projector = mockCurrent.artifacts?.find(item => item.id === mockCurrent?.selectedProjectorId)!;
  const candidate = mockCurrent.projectorCandidates?.find(item => item.id === projector.id)!;
  expect(mockCurrent.selectedProjectorId).not.toBe(raw.selectedProjectorId);
  expect(projector.downloadUrl).not.toBe(raw.artifacts?.[0].downloadUrl);
  expect(candidate.downloadUrl).not.toBe(raw.projectorCandidates?.[0].downloadUrl);
  expect(projector.downloadUrl).not.toContain('?download=true');
  const result = await prepareAndroidQaStage7Seed('ultravox', raw);
  expect(result?.selectedProjectorId).toBe(mockCurrent.selectedProjectorId);
  expect(mockHash).toHaveBeenCalledTimes(4);
  expect(mockRegistryWrite).toHaveBeenCalledTimes(1);
  expect(mockRegistryWrite).toHaveBeenCalledWith(result);
  expect(mockDownloadLease).toBe(false); expect(mockResourceLease).toBe(false);
});

test.each(['repository', 'url_revision', 'url_filename', 'revision', 'filename', 'sha256', 'size'] as const)(
  'does not reinterpret a normalized projector with a changed %s as the pinned fixture', async field => {
    seed(); mockCurrent = normalizePersistedModelMetadata(desired());
    const projector = mockCurrent.artifacts?.find(item => item.id === mockCurrent?.selectedProjectorId)!;
    if (field === 'repository') projector.downloadUrl = projector.downloadUrl.replace('ggml-org/', 'other-owner/');
    if (field === 'url_revision') projector.downloadUrl = projector.downloadUrl.replace(manifest.audioInput.revision, 'other-revision');
    if (field === 'url_filename') projector.downloadUrl = projector.downloadUrl.replace(manifest.audioInput.projector.filename, 'other.gguf');
    if (field === 'revision') projector.hfRevision = 'other-revision';
    if (field === 'filename') projector.remoteFileName = 'other.gguf';
    if (field === 'sha256') projector.sha256 = 'b'.repeat(64);
    if (field === 'size') projector.sizeBytes = (projector.sizeBytes ?? 0) + 1;
    await expect(prepareAndroidQaStage7Seed('ultravox', desired())).rejects.toThrow();
    expect(mockMove).not.toHaveBeenCalled(); expect(mockHash).not.toHaveBeenCalled();
    expect(mockRegistryWrite).not.toHaveBeenCalled(); expect(mockCancel).not.toHaveBeenCalled();
  },
);

test('disabled flags or ordinary package never access staged files', async () => {
  mockEnabled = false; expect(await prepareAndroidQaStage7Seed('ultravox', desired())).toBeNull();
  mockEnabled = true; mockPackage = 'com.github.tah10n.pocketai';
  expect(await prepareAndroidQaStage7Seed('ultravox', desired())).toBeNull();
  expect(mockInfo).not.toHaveBeenCalled(); expect(mockHash).not.toHaveBeenCalled();
});
test('only an entirely missing pair allows normal download fallback', async () => {
  expect(await prepareAndroidQaStage7Seed('ultravox', desired())).toBeNull();
  const sources = seed(); mockFiles.delete(cache + 'stage7-model-fixtures/' + sources[1].sha256 + '.gguf');
  await expect(prepareAndroidQaStage7Seed('ultravox', desired())).rejects.toThrow('stage7_seed_invalid');
  expect(mockMove).not.toHaveBeenCalled();
});
test.each(['size', 'header', 'hash'] as const)('rejects malformed seed %s before moving or publishing', async field => {
  const sources = seed(); const file = mockFiles.get(cache + 'stage7-model-fixtures/' + sources[1].sha256 + '.gguf')!;
  if (field === 'size') file.size--;
  if (field === 'header') file.header = Buffer.alloc(24).toString('base64');
  if (field === 'hash') file.hash = 'a'.repeat(64);
  await expect(prepareAndroidQaStage7Seed('ultravox', desired())).rejects.toThrow();
  expect(mockMove).not.toHaveBeenCalled(); expect(mockRegistryWrite).not.toHaveBeenCalled();
});
test('rejects arbitrary model identity and preserves a different registered source', async () => {
  seed();
  await expect(prepareAndroidQaStage7Seed('ultravox', { ...desired(), id: 'other' })).rejects.toThrow();
  mockCurrent = { ...desired(), sha256: 'b'.repeat(64), localPath: 'user.gguf' };
  await expect(prepareAndroidQaStage7Seed('ultravox', desired())).rejects.toThrow();
  expect(mockInfo).not.toHaveBeenCalled(); expect(mockMove).not.toHaveBeenCalled();
});
test('native final verification must settle before metadata becomes available', async () => {
  const sources = seed(); let resolveHash!: (hash: string) => void;
  mockHash.mockImplementation(async path => path.includes('/files/models/')
    ? new Promise<string>(resolve => { resolveHash = resolve; }) : mockFiles.get('file://' + path)?.hash);
  let returned = false; const pending = prepareAndroidQaStage7Seed('ultravox', desired()).then(value => { returned = true; return value; });
  await flush(); expect(mockMove).toHaveBeenCalledTimes(1); expect(returned).toBe(false);
  expect(mockRegistryWrite).not.toHaveBeenCalled();
  resolveHash(sources[0].sha256); await flush(); expect(returned).toBe(false);
  expect(mockRegistryWrite).not.toHaveBeenCalled();
  resolveHash(sources[1].sha256); expect(await pending).not.toBeNull();
  expect(mockRegistryWrite).toHaveBeenCalledTimes(1);
});
test('changed bytes after moving fail final native SHA and roll back only this operation', async () => {
  const sources = seed();
  mockHash.mockImplementation(async path => path.includes('/files/models/') ? 'a'.repeat(64) : mockFiles.get('file://' + path)?.hash);
  await expect(prepareAndroidQaStage7Seed('ultravox', desired())).rejects.toThrow();
  expect(mockFiles.has(cache + 'stage7-model-fixtures/' + sources[0].sha256 + '.gguf')).toBe(true);
  expect(mockFiles.has(models + 'qa-stage7-' + sources[0].sha256 + '.gguf')).toBe(false);
  expect(mockRegistryWrite).not.toHaveBeenCalled();
});
test('existing wrong destination is preserved and never overwritten', async () => {
  const sources = seed(); const target = models + 'qa-stage7-' + sources[0].sha256 + '.gguf';
  const existing = { ...mockFiles.get(cache + 'stage7-model-fixtures/' + sources[0].sha256 + '.gguf')!, hash: 'b'.repeat(64) };
  mockFiles.set(target, existing);
  await expect(prepareAndroidQaStage7Seed('ultravox', desired())).rejects.toThrow();
  expect(mockFiles.get(target)).toBe(existing); expect(mockMove).not.toHaveBeenCalled();
});
test('waits for same-fixture download drain and preserves other queued downloads', async () => {
  seed(); mockQueue = [desired(), { ...desired(), id: 'unrelated' }];
  let drain!: () => void;
  mockCancel.mockImplementation(async () => { await new Promise<void>(resolve => { drain = resolve; }); mockQueue.shift(); });
  const pending = prepareAndroidQaStage7Seed('ultravox', desired());
  await flush(); expect(mockCancel).toHaveBeenCalledWith(desired().id, { waitForDrain: true });
  expect(mockMove).not.toHaveBeenCalled(); drain(); await pending;
  expect(mockQueue.map(item => item.id)).toEqual(['unrelated']);
});
test('never cancels a queue row with changed fixture identity', async () => {
  seed(); mockQueue = [{ ...desired(), sha256: 'b'.repeat(64) }];
  await expect(prepareAndroidQaStage7Seed('ultravox', desired())).rejects.toThrow();
  expect(mockCancel).not.toHaveBeenCalled(); expect(mockMove).not.toHaveBeenCalled();
});

test('never replaces an existing selected codec with a different source', async () => {
  seed('neutts'); mockCurrent = { ...desired('neutts'), artifacts: [{ id: 'other-codec',
    kind: 'tts_codec', requiredFor: [], selected: true, remoteFileName: 'user.gguf',
    downloadUrl: 'https://huggingface.co/user/model/resolve/main/user.gguf',
    sizeBytes: 1000, sha256: 'a'.repeat(64), installState: 'installed', localPath: 'user.gguf' }] };
  await expect(prepareAndroidQaStage7Seed('neutts', desired('neutts'))).rejects.toThrow();
  expect(mockMove).not.toHaveBeenCalled(); expect(mockRegistryWrite).not.toHaveBeenCalled();
});
test('never cancels a same-backbone job whose companion identity changed', async () => {
  seed(); const model = desired();
  mockQueue = [{ ...model, artifacts: model.artifacts?.map(item => ({ ...item, sha256: 'b'.repeat(64) })) }];
  await expect(prepareAndroidQaStage7Seed('ultravox', model)).rejects.toThrow();
  expect(mockCancel).not.toHaveBeenCalled(); expect(mockMove).not.toHaveBeenCalled();
});

test('publication failure preserves verified private files when registry outcome is uncertain', async () => {
  const sources = seed(); mockRegistryWrite.mockImplementation(() => {
    expect(mockDownloadLease).toBe(true); expect(mockResourceLease).toBe(true);
    throw new Error('registry_failed');
  });
  await expect(prepareAndroidQaStage7Seed('ultravox', desired())).rejects.toThrow('registry_failed');
  for (const source of sources)
    expect(mockFiles.get(models + 'qa-stage7-' + source.sha256 + '.gguf')?.hash).toBe(source.sha256);
  expect(mockMove).toHaveBeenCalledTimes(2);
});
