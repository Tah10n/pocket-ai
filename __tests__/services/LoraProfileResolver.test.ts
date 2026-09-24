import * as FileSystem from 'expo-file-system/legacy';
import * as RNFS from 'react-native-fs';
import { resolveLoraProfileForLoad } from '../../src/services/LoraProfileResolver';
import { loadLlamaModelInfo } from '../../src/services/LlamaRuntimeAdapter';
import { getCompanionBindingIdentity, getCompanionSourceIdentity } from '../../src/utils/modelArtifacts';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';
import type { LoraProfileAdapter } from '../../src/utils/advancedLoadProfile';

jest.mock('../../src/services/FileSystemSetup', () => ({ getModelsDir: () => 'file:///models/' }));
jest.mock('../../src/utils/ggufValidation', () => ({ validateGgufFileHeader: jest.fn(async () => undefined) }));
jest.mock('../../src/services/LlamaRuntimeAdapter', () => ({ loadLlamaModelInfo: jest.fn() }));

const hash = 'a'.repeat(64);
function fixture(): { model: ModelMetadata; profile: LoraProfileAdapter[] } {
  const model: ModelMetadata = { id: 'test/base', name: 'base', author: 'test', size: 1000,
    downloadUrl: 'https://huggingface.co/test/base/resolve/rev/base.gguf', hfRevision: 'rev',
    resolvedFileName: 'base.gguf', localPath: 'base.gguf', sha256: hash,
    accessState: ModelAccessState.PUBLIC, isGated: false, isPrivate: false, fitsInRam: null,
    lifecycleStatus: LifecycleStatus.DOWNLOADED, downloadProgress: 1 };
  const bound = getCompanionBindingIdentity(model);
  const artifact = { id: 'adapter', kind: 'lora_adapter' as const, requiredFor: [],
    selected: false, boundToModelIdentity: bound, hfRevision: 'adapter-rev',
    remoteFileName: 'adapter.gguf', downloadUrl: 'https://huggingface.co/test/adapter/resolve/adapter-rev/adapter.gguf',
    sizeBytes: 64, sha256: hash, localPath: 'adapter.gguf', installState: 'installed' as const };
  model.artifacts = [artifact];
  return { model, profile: [{ artifactId: artifact.id, artifactIdentity: getCompanionSourceIdentity(artifact),
    baseModelIdentity: bound, scale: 0.5, sizeBytes: 64 }] };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(FileSystem.getInfoAsync).mockResolvedValue({ exists: true, isDirectory: false, size: 64,
    uri: 'file:///models/adapter.gguf', modificationTime: 1 });
  jest.mocked(RNFS.hash).mockResolvedValue(hash);
  jest.mocked(loadLlamaModelInfo).mockImplementation(async path => path.endsWith('adapter.gguf')
    ? { 'general.architecture': 'llama', 'general.type': 'adapter', 'adapter.type': 'lora' }
    : { 'general.architecture': 'llama', 'general.type': 'model' });
});

it('resolves the original bound artifact during restoration even when deselected', async () => {
  const { model, profile } = fixture();
  expect(await resolveLoraProfileForLoad(model, profile)).toEqual({
    adapters: [{ path: '/models/adapter.gguf', scaled: 0.5 }], sizeBytes: 64, profile,
  });
  expect(RNFS.hash).toHaveBeenCalledWith('/models/adapter.gguf', 'sha256');
  expect(model.artifacts?.[0].selected).toBe(false);
});

it('never accepts file presence as proof of compatibility', async () => {
  const { model, profile } = fixture();
  jest.mocked(loadLlamaModelInfo).mockResolvedValue({ 'general.architecture': 'other' });
  await expect(resolveLoraProfileForLoad(model, profile)).rejects.toMatchObject({ code: 'model_incompatible' });
});

it('rejects stale variants, changed companion identities and corrupted bytes', async () => {
  const { model, profile } = fixture();
  await expect(resolveLoraProfileForLoad({ ...model, hfRevision: 'new' }, profile)).rejects.toThrow('verification failed');
  model.artifacts![0].hfRevision = 'new-adapter';
  await expect(resolveLoraProfileForLoad(model, profile)).rejects.toThrow('verification failed');
  const fresh = fixture();
  jest.mocked(RNFS.hash).mockResolvedValue('b'.repeat(64));
  await expect(resolveLoraProfileForLoad(fresh.model, fresh.profile)).rejects.toThrow('verification failed');
});

it('requires known actual bytes and masks native private paths', async () => {
  const { model, profile } = fixture();
  jest.mocked(FileSystem.getInfoAsync).mockResolvedValue({ exists: true, isDirectory: false, size: 63,
    uri: 'file:///models/adapter.gguf', modificationTime: 1 });
  await expect(resolveLoraProfileForLoad(model, profile)).rejects.toThrow('verification failed');
  jest.mocked(loadLlamaModelInfo).mockRejectedValue(new Error('/private/user/secret-adapter.gguf'));
  await expect(resolveLoraProfileForLoad(model, profile)).rejects.not.toThrow('secret-adapter');
});

it('does not invoke native metadata for an empty adapter selection', async () => {
  expect(await resolveLoraProfileForLoad(fixture().model, [])).toEqual({ adapters: [], profile: [], sizeBytes: 0 });
  expect(loadLlamaModelInfo).not.toHaveBeenCalled();
});
