describe('resolveModelFilePathOrThrow', () => {
  afterEach(() => {
    jest.resetModules();
    jest.unmock('../../src/services/FileSystemSetup');
    jest.unmock('../../src/utils/safeFilePath');
    jest.unmock('expo-file-system/legacy');
  });

  it('throws when the models directory is unavailable', async () => {
    jest.doMock('expo-file-system/legacy', () => ({
      getInfoAsync: jest.fn().mockResolvedValue({ exists: true }),
    }));
    jest.doMock('../../src/services/FileSystemSetup', () => ({
      getModelsDir: () => null,
    }));
    jest.doMock('../../src/utils/safeFilePath', () => ({
      safeJoinModelPath: jest.fn(),
    }));

    const { resolveModelFilePathOrThrow } = require('../../src/services/LLMEngineService.modelFile');

    await expect(resolveModelFilePathOrThrow({
      modelId: 'author/model-q4',
      localPath: 'model.gguf',
    })).rejects.toEqual(expect.objectContaining({
      code: 'action_failed',
      message: 'Local file system is unavailable on this platform.',
    }));
  });

  it('throws when the model path is unsafe', async () => {
    jest.doMock('expo-file-system/legacy', () => ({
      getInfoAsync: jest.fn().mockResolvedValue({ exists: true }),
    }));
    jest.doMock('../../src/services/FileSystemSetup', () => ({
      getModelsDir: () => 'document://models/',
    }));
    jest.doMock('../../src/utils/safeFilePath', () => ({
      safeJoinModelPath: () => null,
    }));

    const { resolveModelFilePathOrThrow } = require('../../src/services/LLMEngineService.modelFile');

    await expect(resolveModelFilePathOrThrow({
      modelId: 'author/model-q4',
      localPath: '../escape.gguf',
    })).rejects.toEqual(expect.objectContaining({
      code: 'action_failed',
      message: 'Invalid model file path for author/model-q4',
    }));
  });

  it('throws a download_file_missing error when the resolved model file does not exist', async () => {
    jest.doMock('../../src/services/FileSystemSetup', () => ({
      getModelsDir: () => 'document://models/',
    }));
    jest.doMock('../../src/utils/safeFilePath', () => ({
      safeJoinModelPath: () => 'document://models/model.gguf',
    }));
    jest.doMock('expo-file-system/legacy', () => ({
      getInfoAsync: jest.fn().mockResolvedValue({ exists: false }),
    }));

    const { resolveModelFilePathOrThrow } = require('../../src/services/LLMEngineService.modelFile');

    await expect(resolveModelFilePathOrThrow({
      modelId: 'author/model-q4',
      localPath: 'model.gguf',
    })).rejects.toEqual(expect.objectContaining({
      code: 'download_file_missing',
      message: 'Model file is not available locally.',
      details: expect.objectContaining({
        modelId: 'author/model-q4',
        pathCategory: 'models',
      }),
    }));
  });

  it('returns the resolved model path and file info on success', async () => {
    const mockGetInfoAsync = jest.fn().mockResolvedValue({ exists: true, size: 1234 });
    const mockSafeJoinModelPath = jest.fn(() => 'document://models/model.gguf');

    jest.doMock('../../src/services/FileSystemSetup', () => ({
      getModelsDir: () => 'document://models/',
    }));
    jest.doMock('../../src/utils/safeFilePath', () => ({
      safeJoinModelPath: mockSafeJoinModelPath,
    }));
    jest.doMock('expo-file-system/legacy', () => ({
      getInfoAsync: mockGetInfoAsync,
    }));

    const { resolveModelFilePathOrThrow } = require('../../src/services/LLMEngineService.modelFile');

    await expect(resolveModelFilePathOrThrow({
      modelId: 'author/model-q4',
      localPath: 'model.gguf',
    })).resolves.toEqual({
      modelPath: 'document://models/model.gguf',
      fileInfo: { exists: true, size: 1234 },
    });

    expect(mockSafeJoinModelPath).toHaveBeenCalledWith('document://models/', 'model.gguf');
    expect(mockGetInfoAsync).toHaveBeenCalledWith('document://models/model.gguf');
  });
});

describe('resolveProjectorFilePathOrThrow', () => {
  const projector = {
    id: 'author/model::main::mmproj-model.gguf',
    ownerModelId: 'author/model',
    repoId: 'author/model',
    fileName: 'mmproj-model.gguf',
    downloadUrl: 'https://huggingface.co/author/model/resolve/main/mmproj-model.gguf',
    hfRevision: 'main',
    size: 1000,
    lifecycleStatus: 'downloaded' as const,
    matchStatus: 'matched' as const,
  };

  afterEach(() => {
    jest.resetModules();
    jest.unmock('../../src/services/FileSystemSetup');
    jest.unmock('../../src/utils/safeFilePath');
    jest.unmock('expo-file-system/legacy');
    jest.unmock('react-native-fs');
  });

  it('rejects a raw upstream projector filename collision when identity is not verified', async () => {
    const hash = jest.fn();
    jest.doMock('../../src/services/FileSystemSetup', () => ({
      getModelsDir: () => 'document://models/',
    }));
    jest.doMock('../../src/utils/safeFilePath', () => ({
      fileUriToNativePath: (uri: string) => uri,
      isValidLocalFileName: (value: string) => !value.includes('/'),
      safeJoinModelPath: (_modelsDir: string, candidate: string) => `document://models/${candidate}`,
    }));
    jest.doMock('expo-file-system/legacy', () => ({
      getInfoAsync: jest.fn(async (uri: string) => (
        uri === 'document://models/mmproj-model.gguf'
          ? { exists: true, size: 1000 }
          : { exists: false }
      )),
    }));
    jest.doMock('react-native-fs', () => ({
      hash,
    }));

    const { resolveProjectorFilePathOrThrow } = require('../../src/services/LLMEngineService.modelFile');

    await expect(resolveProjectorFilePathOrThrow({
      modelId: 'author/model',
      projector,
    })).rejects.toEqual(expect.objectContaining({
      code: 'download_file_missing',
      message: 'Projector file is not available locally.',
    }));
    expect(hash).not.toHaveBeenCalled();
  });

  it('preserves legacy completed projector localPath that uses the raw filename', async () => {
    jest.doMock('../../src/services/FileSystemSetup', () => ({
      getModelsDir: () => 'document://models/',
    }));
    jest.doMock('../../src/utils/safeFilePath', () => ({
      fileUriToNativePath: (uri: string) => uri,
      isValidLocalFileName: (value: string) => !value.includes('/'),
      safeJoinModelPath: (_modelsDir: string, candidate: string) => `document://models/${candidate}`,
    }));
    jest.doMock('expo-file-system/legacy', () => ({
      getInfoAsync: jest.fn(async (uri: string) => (
        uri === 'document://models/mmproj-model.gguf'
          ? { exists: true, size: 999 }
          : { exists: false }
      )),
    }));
    jest.doMock('react-native-fs', () => ({
      hash: jest.fn(),
    }));

    const { resolveProjectorFilePathOrThrow } = require('../../src/services/LLMEngineService.modelFile');

    await expect(resolveProjectorFilePathOrThrow({
      modelId: 'author/model',
      projector: { ...projector, localPath: 'mmproj-model.gguf' },
    })).resolves.toEqual({
      projectorPath: 'document://models/mmproj-model.gguf',
      localPath: 'mmproj-model.gguf',
      fileInfo: { exists: true, size: 999 },
    });
  });

  it('accepts an explicit raw projector localPath when sha256 identity matches', async () => {
    const sha256 = 'b'.repeat(64);
    const hash = jest.fn().mockResolvedValue(sha256);
    jest.doMock('../../src/services/FileSystemSetup', () => ({
      getModelsDir: () => 'document://models/',
    }));
    jest.doMock('../../src/utils/safeFilePath', () => ({
      fileUriToNativePath: (uri: string) => uri.replace('document://', '/'),
      isValidLocalFileName: (value: string) => !value.includes('/'),
      safeJoinModelPath: (_modelsDir: string, candidate: string) => `document://models/${candidate}`,
    }));
    jest.doMock('expo-file-system/legacy', () => ({
      getInfoAsync: jest.fn(async (uri: string) => (
        uri === 'document://models/mmproj-model.gguf'
          ? { exists: true, size: 999 }
          : { exists: false }
      )),
    }));
    jest.doMock('react-native-fs', () => ({ hash }));

    const { resolveProjectorFilePathOrThrow } = require('../../src/services/LLMEngineService.modelFile');

    await expect(resolveProjectorFilePathOrThrow({
      modelId: 'author/model',
      projector: { ...projector, localPath: 'mmproj-model.gguf', sha256 },
    })).resolves.toEqual({
      projectorPath: 'document://models/mmproj-model.gguf',
      localPath: 'mmproj-model.gguf',
      fileInfo: { exists: true, size: 999 },
    });
    expect(hash).toHaveBeenCalledWith('/models/mmproj-model.gguf', 'sha256');
  });

  it('rejects an explicit raw projector localPath when sha256 identity mismatches', async () => {
    const sha256 = 'c'.repeat(64);
    const hash = jest.fn().mockResolvedValue('d'.repeat(64));
    jest.doMock('../../src/services/FileSystemSetup', () => ({
      getModelsDir: () => 'document://models/',
    }));
    jest.doMock('../../src/utils/safeFilePath', () => ({
      fileUriToNativePath: (uri: string) => uri.replace('document://', '/'),
      isValidLocalFileName: (value: string) => !value.includes('/'),
      safeJoinModelPath: (_modelsDir: string, candidate: string) => `document://models/${candidate}`,
    }));
    jest.doMock('expo-file-system/legacy', () => ({
      getInfoAsync: jest.fn(async (uri: string) => (
        uri === 'document://models/mmproj-model.gguf'
          ? { exists: true, size: 999 }
          : { exists: false }
      )),
    }));
    jest.doMock('react-native-fs', () => ({ hash }));

    const { resolveProjectorFilePathOrThrow } = require('../../src/services/LLMEngineService.modelFile');

    await expect(resolveProjectorFilePathOrThrow({
      modelId: 'author/model',
      projector: { ...projector, localPath: 'mmproj-model.gguf', sha256 },
    })).rejects.toEqual(expect.objectContaining({
      code: 'download_file_missing',
      message: 'Projector file is not available locally.',
    }));
    expect(hash).toHaveBeenCalledWith('/models/mmproj-model.gguf', 'sha256');
  });

  it('accepts a raw upstream projector filename only when sha256 identity matches', async () => {
    const sha256 = 'a'.repeat(64);
    const hash = jest.fn().mockResolvedValue(sha256);
    jest.doMock('../../src/services/FileSystemSetup', () => ({
      getModelsDir: () => 'document://models/',
    }));
    jest.doMock('../../src/utils/safeFilePath', () => ({
      fileUriToNativePath: (uri: string) => uri.replace('document://', '/'),
      isValidLocalFileName: (value: string) => !value.includes('/'),
      safeJoinModelPath: (_modelsDir: string, candidate: string) => `document://models/${candidate}`,
    }));
    jest.doMock('expo-file-system/legacy', () => ({
      getInfoAsync: jest.fn(async (uri: string) => (
        uri === 'document://models/mmproj-model.gguf'
          ? { exists: true, size: 1000 }
          : { exists: false }
      )),
    }));
    jest.doMock('react-native-fs', () => ({ hash }));

    const { resolveProjectorFilePathOrThrow } = require('../../src/services/LLMEngineService.modelFile');

    await expect(resolveProjectorFilePathOrThrow({
      modelId: 'author/model',
      projector: { ...projector, sha256 },
    })).resolves.toEqual(expect.objectContaining({
      projectorPath: 'document://models/mmproj-model.gguf',
      localPath: 'mmproj-model.gguf',
    }));
    expect(hash).toHaveBeenCalledWith('/models/mmproj-model.gguf', 'sha256');
  });

  it('rehashes raw projector files even when file info appears unchanged', async () => {
    const sha256 = 'e'.repeat(64);
    const hash = jest.fn()
      .mockResolvedValueOnce(sha256)
      .mockResolvedValueOnce('0'.repeat(64));
    jest.doMock('../../src/services/FileSystemSetup', () => ({
      getModelsDir: () => 'document://models/',
    }));
    jest.doMock('../../src/utils/safeFilePath', () => ({
      fileUriToNativePath: (uri: string) => uri.replace('document://', '/'),
      isValidLocalFileName: (value: string) => !value.includes('/'),
      safeJoinModelPath: (_modelsDir: string, candidate: string) => `document://models/${candidate}`,
    }));
    jest.doMock('expo-file-system/legacy', () => ({
      getInfoAsync: jest.fn(async (uri: string) => (
        uri === 'document://models/mmproj-model.gguf'
          ? { exists: true, size: 1000, modificationTime: 123 }
          : { exists: false }
      )),
    }));
    jest.doMock('react-native-fs', () => ({ hash }));

    const { resolveProjectorFilePathOrThrow } = require('../../src/services/LLMEngineService.modelFile');

    await expect(resolveProjectorFilePathOrThrow({
      modelId: 'author/model',
      projector: { ...projector, sha256 },
    })).resolves.toEqual(expect.objectContaining({
      projectorPath: 'document://models/mmproj-model.gguf',
      localPath: 'mmproj-model.gguf',
    }));
    await expect(resolveProjectorFilePathOrThrow({
      modelId: 'author/model',
      projector: { ...projector, sha256 },
    })).rejects.toEqual(expect.objectContaining({
      code: 'download_file_missing',
      message: 'Projector file is not available locally.',
    }));

    expect(hash).toHaveBeenCalledTimes(2);
    expect(hash).toHaveBeenCalledWith('/models/mmproj-model.gguf', 'sha256');
  });

  it('rehashes raw projector files when modification time is unavailable', async () => {
    const sha256 = 'f'.repeat(64);
    const hash = jest.fn()
      .mockResolvedValueOnce(sha256)
      .mockResolvedValueOnce('0'.repeat(64));
    jest.doMock('../../src/services/FileSystemSetup', () => ({
      getModelsDir: () => 'document://models/',
    }));
    jest.doMock('../../src/utils/safeFilePath', () => ({
      fileUriToNativePath: (uri: string) => uri.replace('document://', '/'),
      isValidLocalFileName: (value: string) => !value.includes('/'),
      safeJoinModelPath: (_modelsDir: string, candidate: string) => `document://models/${candidate}`,
    }));
    jest.doMock('expo-file-system/legacy', () => ({
      getInfoAsync: jest.fn(async (uri: string) => (
        uri === 'document://models/mmproj-model.gguf'
          ? { exists: true, size: 1000 }
          : { exists: false }
      )),
    }));
    jest.doMock('react-native-fs', () => ({ hash }));

    const { resolveProjectorFilePathOrThrow } = require('../../src/services/LLMEngineService.modelFile');

    await expect(resolveProjectorFilePathOrThrow({
      modelId: 'author/model',
      projector: { ...projector, sha256 },
    })).resolves.toEqual(expect.objectContaining({
      projectorPath: 'document://models/mmproj-model.gguf',
      localPath: 'mmproj-model.gguf',
    }));
    await expect(resolveProjectorFilePathOrThrow({
      modelId: 'author/model',
      projector: { ...projector, sha256 },
    })).rejects.toEqual(expect.objectContaining({
      code: 'download_file_missing',
      message: 'Projector file is not available locally.',
    }));

    expect(hash).toHaveBeenCalledTimes(2);
  });
});
