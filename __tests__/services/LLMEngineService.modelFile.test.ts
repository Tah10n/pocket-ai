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
      message: 'Model file not found at document://models/model.gguf',
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
