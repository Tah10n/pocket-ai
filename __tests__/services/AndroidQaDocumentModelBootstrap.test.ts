import * as FileSystem from 'expo-file-system/legacy';
import RNFS from 'react-native-fs';

const mockUpdateModel = jest.fn();
const mockUpdateSettings = jest.fn();
const mockSetupFileSystem = jest.fn().mockResolvedValue(undefined);

jest.mock('../../src/services/FileSystemSetup', () => ({
  getModelsDir: () => 'file:///models/',
  setupFileSystem: () => mockSetupFileSystem(),
}));

jest.mock('../../src/services/LocalStorageRegistry', () => ({
  registry: { updateModel: (model: unknown) => mockUpdateModel(model) },
}));

jest.mock('../../src/services/SettingsStore', () => ({
  updateSettings: (settings: unknown) => mockUpdateSettings(settings),
}));

import {
  ANDROID_QA_DOCUMENT_MODEL_ID,
  ANDROID_QA_DOCUMENT_MODEL_SHA256,
  isAndroidQaDocumentModelBootstrapEnabled,
  provisionAndroidQaDocumentModel,
} from '../../src/services/AndroidQaDocumentModelBootstrap';

describe('AndroidQaDocumentModelBootstrap', () => {
  const previousEvidenceFlag = process.env.EXPO_PUBLIC_ANDROID_QA;
  const previousDocumentsFlag = process.env.EXPO_PUBLIC_ANDROID_QA_DOCUMENTS;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EXPO_PUBLIC_ANDROID_QA = '1';
    process.env.EXPO_PUBLIC_ANDROID_QA_DOCUMENTS = '1';
    Object.defineProperty(require('react-native').Platform, 'OS', {
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
});
