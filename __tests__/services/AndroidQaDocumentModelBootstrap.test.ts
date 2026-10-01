import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import RNFS from 'react-native-fs';
import loraFixture from '../../docs/validation/llama-rn-stage3/lora-fixture.json';
import { LifecycleStatus, type ModelArtifactMetadata, type ModelMetadata } from '../../src/types/models';
import { getCompanionBindingIdentity } from '../../src/utils/modelArtifacts';
import {
  ANDROID_QA_DOCUMENT_MODEL_ID,
  ANDROID_QA_DOCUMENT_MODEL_SHA256,
  ANDROID_QA_DOCUMENT_MODEL_URL,
  isAndroidQaDocumentModelBootstrapEnabled,
  provisionAndroidQaDocumentModel,
} from '../../src/services/AndroidQaDocumentModelBootstrap';

let mockRegisteredModel: ModelMetadata | undefined;
const mockUpdateModel = jest.fn((model: ModelMetadata) => { mockRegisteredModel = model; });
const mockGetModel = jest.fn((id: string) => mockRegisteredModel?.id === id ? mockRegisteredModel : undefined);
const mockUpdateSettings = jest.fn();
const mockSetupFileSystem = jest.fn().mockResolvedValue(undefined);

jest.mock('../../src/services/FileSystemSetup', () => ({
  getModelsDir: () => 'file:///models/',
  setupFileSystem: () => mockSetupFileSystem(),
}));

jest.mock('../../src/services/LocalStorageRegistry', () => ({
  registry: {
    updateModel: (model: ModelMetadata) => mockUpdateModel(model),
    getModel: (id: string) => mockGetModel(id),
  },
}));

jest.mock('../../src/services/SettingsStore', () => ({
  updateSettings: (settings: unknown) => mockUpdateSettings(settings),
}));

describe('AndroidQaDocumentModelBootstrap', () => {
  const previousEvidenceFlag = process.env.EXPO_PUBLIC_ANDROID_QA;
  const previousDocumentsFlag = process.env.EXPO_PUBLIC_ANDROID_QA_DOCUMENTS;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRegisteredModel = undefined;
    process.env.EXPO_PUBLIC_ANDROID_QA = '1';
    process.env.EXPO_PUBLIC_ANDROID_QA_DOCUMENTS = '1';
    Object.defineProperty(Platform, 'OS', {
      configurable: true,
      value: 'android',
    });
  });

  afterAll(() => {
    if (previousEvidenceFlag === undefined) {
      delete process.env.EXPO_PUBLIC_ANDROID_QA;
    } else {
      process.env.EXPO_PUBLIC_ANDROID_QA = previousEvidenceFlag;
    }
    if (previousDocumentsFlag === undefined) {
      delete process.env.EXPO_PUBLIC_ANDROID_QA_DOCUMENTS;
    } else {
      process.env.EXPO_PUBLIC_ANDROID_QA_DOCUMENTS = previousDocumentsFlag;
    }
  });

  it('requires both QA flags and Android', () => {
    expect(isAndroidQaDocumentModelBootstrapEnabled({
      EXPO_PUBLIC_ANDROID_QA: '1',
      EXPO_PUBLIC_ANDROID_QA_DOCUMENTS: '1',
    }, 'android')).toBe(true);
    expect(isAndroidQaDocumentModelBootstrapEnabled({
      EXPO_PUBLIC_ANDROID_QA: '1',
    }, 'android')).toBe(false);
    expect(isAndroidQaDocumentModelBootstrapEnabled({
      EXPO_PUBLIC_ANDROID_QA: '1',
      EXPO_PUBLIC_ANDROID_QA_DOCUMENTS: '1',
    }, 'ios')).toBe(false);
  });

  it('downloads, verifies, registers, and selects the pinned public QA model', async () => {
    (FileSystem.getInfoAsync as jest.Mock)
      .mockResolvedValueOnce({ exists: false })
      .mockResolvedValueOnce({ exists: true, size: 145_000_000 });
    (RNFS.hash as jest.Mock).mockResolvedValueOnce(ANDROID_QA_DOCUMENT_MODEL_SHA256);
    const downloadAsync = jest.fn().mockResolvedValue({ status: 200 });
    (FileSystem.createDownloadResumable as jest.Mock).mockReturnValueOnce({ downloadAsync });

    await expect(provisionAndroidQaDocumentModel()).resolves.toBe(true);

    expect(downloadAsync).toHaveBeenCalledTimes(1);
    expect(FileSystem.moveAsync).toHaveBeenCalledWith({
      from: 'file:///models/android-qa-smollm2-135m-instruct-q8.gguf.partial',
      to: 'file:///models/android-qa-smollm2-135m-instruct-q8.gguf',
    });
    expect(mockUpdateModel).toHaveBeenCalledWith(expect.objectContaining({
      id: ANDROID_QA_DOCUMENT_MODEL_ID,
      lifecycleStatus: 'downloaded',
      metadataTrust: 'verified_local',
      sha256: ANDROID_QA_DOCUMENT_MODEL_SHA256,
      size: 145_000_000,
    }));
    expect(mockUpdateSettings).toHaveBeenCalledWith({
      activeModelId: ANDROID_QA_DOCUMENT_MODEL_ID,
    });
  });

  it('fails closed and deletes an unverified download', async () => {
    (FileSystem.getInfoAsync as jest.Mock)
      .mockResolvedValueOnce({ exists: false })
      .mockResolvedValueOnce({ exists: true, size: 145_000_000 });
    (RNFS.hash as jest.Mock).mockResolvedValueOnce('0'.repeat(64));
    (FileSystem.createDownloadResumable as jest.Mock).mockReturnValueOnce({
      downloadAsync: jest.fn().mockResolvedValue({ status: 200 }),
    });

    await expect(provisionAndroidQaDocumentModel()).rejects.toThrow(
      'Android document QA model integrity verification failed.',
    );
    expect(mockUpdateModel).not.toHaveBeenCalled();
    expect(mockUpdateSettings).not.toHaveBeenCalled();
    expect(FileSystem.deleteAsync).toHaveBeenLastCalledWith(
      'file:///models/android-qa-smollm2-135m-instruct-q8.gguf.partial',
      { idempotent: true },
    );
  });

  function installFixtureAdapter(): ModelArtifactMetadata {
    const base = mockRegisteredModel!;
    const adapter: ModelArtifactMetadata = {
      id: 'qa-lora-adapter',
      kind: 'lora_adapter',
      requiredFor: [],
      selected: true,
      boundToModelIdentity: getCompanionBindingIdentity(base),
      remoteFileName: loraFixture.adapter.filename,
      downloadUrl: loraFixture.adapter.downloadUrl,
      hfRevision: loraFixture.adapter.revision,
      sha256: loraFixture.adapter.sha256,
      sizeBytes: loraFixture.adapter.sizeBytes,
      localPath: 'qa-lora-adapter.gguf',
      installState: 'installed',
      integrity: {
        kind: 'sha256',
        sha256: loraFixture.adapter.sha256,
        sizeBytes: loraFixture.adapter.sizeBytes,
        checkedAt: 1,
      },
    };
    mockRegisteredModel = { ...base, artifacts: [adapter] };
    return adapter;
  }

  function mockVerifiedBaseFile(): void {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: loraFixture.base.sizeBytes });
    (RNFS.hash as jest.Mock).mockResolvedValue(ANDROID_QA_DOCUMENT_MODEL_SHA256);
  }

  it('retains the installed LoRA across repeated cold provisioning while reverifying the base', async () => {
    mockVerifiedBaseFile();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(100);
    try {
      await provisionAndroidQaDocumentModel();
      const adapter = installFixtureAdapter();
      mockRegisteredModel = {
        ...mockRegisteredModel!,
        name: 'stale base name',
        lifecycleStatus: LifecycleStatus.ACTIVE,
        artifacts: [adapter, {
          id: 'stale-main',
          kind: 'main_model',
          requiredFor: ['text'],
          remoteFileName: 'stale.gguf',
          downloadUrl: 'https://example.org/stale.gguf',
          sizeBytes: 1,
          localPath: 'stale.gguf',
          installState: 'installed',
        }],
      };
      for (const checkedAt of [200, 300]) {
        clock.mockReturnValue(checkedAt);
        await provisionAndroidQaDocumentModel();
        expect(mockRegisteredModel).toMatchObject({
          name: 'Android QA SmolLM2 135M Instruct',
          lifecycleStatus: 'downloaded',
          localPath: 'android-qa-smollm2-135m-instruct-q8.gguf',
          downloadIntegrity: {
            sha256: ANDROID_QA_DOCUMENT_MODEL_SHA256,
            sizeBytes: loraFixture.base.sizeBytes,
            checkedAt,
          },
          artifacts: [adapter],
        });
        expect(mockRegisteredModel?.artifacts).toEqual([adapter]);
      }
      expect(RNFS.hash).toHaveBeenCalledTimes(3);
      expect(FileSystem.createDownloadResumable).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    ['base digest', { sha256: '0'.repeat(64) }],
    ['base URL', { downloadUrl: 'https://example.org/other.gguf' }],
    ['base revision', { hfRevision: 'other-commit' }],
    ['base filename', { resolvedFileName: 'other.gguf' }],
    ['local path', { localPath: 'other.gguf' }],
    ['missing integrity', { downloadIntegrity: undefined }],
    ['integrity digest', { downloadIntegrity: { kind: 'sha256', sha256: '0'.repeat(64), sizeBytes: loraFixture.base.sizeBytes, checkedAt: 1 } }],
    ['integrity size', { downloadIntegrity: { kind: 'sha256', sha256: ANDROID_QA_DOCUMENT_MODEL_SHA256, sizeBytes: 1, checkedAt: 1 } }],
  ] satisfies [string, Partial<ModelMetadata>][])('drops companion ownership when %s differs', async (_reason, changes) => {
    mockVerifiedBaseFile();
    await provisionAndroidQaDocumentModel();
    installFixtureAdapter();
    mockRegisteredModel = { ...mockRegisteredModel!, ...changes };

    await provisionAndroidQaDocumentModel();

    expect(mockRegisteredModel).toMatchObject({
      downloadUrl: ANDROID_QA_DOCUMENT_MODEL_URL,
      sha256: ANDROID_QA_DOCUMENT_MODEL_SHA256,
      localPath: 'android-qa-smollm2-135m-instruct-q8.gguf',
      downloadIntegrity: { sizeBytes: loraFixture.base.sizeBytes },
    });
    expect(mockRegisteredModel?.artifacts).toBeUndefined();
    expect(FileSystem.createDownloadResumable).not.toHaveBeenCalled();
  });

  it('rejects a companion bound to another base while retaining the matching adapter', async () => {
    mockVerifiedBaseFile();
    await provisionAndroidQaDocumentModel();
    const adapter = installFixtureAdapter();
    mockRegisteredModel = { ...mockRegisteredModel!, artifacts: [
      adapter,
      { ...adapter, id: 'wrong-binding', boundToModelIdentity: 'other-base' },
    ] };

    await provisionAndroidQaDocumentModel();

    expect(mockRegisteredModel?.artifacts).toEqual([adapter]);
  });
});
