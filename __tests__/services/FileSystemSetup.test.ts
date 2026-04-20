import * as FileSystem from 'expo-file-system/legacy';

import { getCacheDir, getModelsDir, setupFileSystem } from '@/services/FileSystemSetup';

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'doc/',
  cacheDirectory: 'cache/',
  getInfoAsync: jest.fn(async (_path: string) => ({ exists: true })),
  makeDirectoryAsync: jest.fn(async () => undefined),
}));

describe('FileSystemSetup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves models and cache dirs', () => {
    expect(getModelsDir()).toBe('doc/models/');
    expect(getCacheDir()).toBe('cache/models-cache/');
  });

  it('creates base directories when missing', async () => {
    (FileSystem.getInfoAsync as jest.Mock)
      .mockResolvedValueOnce({ exists: false })
      .mockResolvedValueOnce({ exists: false });

    await setupFileSystem();

    expect(FileSystem.makeDirectoryAsync).toHaveBeenCalledWith('doc/models/', { intermediates: true });
    expect(FileSystem.makeDirectoryAsync).toHaveBeenCalledWith('cache/models-cache/', { intermediates: true });
  });

  it('does nothing when dirs already exist', async () => {
    (FileSystem.getInfoAsync as jest.Mock)
      .mockResolvedValueOnce({ exists: true })
      .mockResolvedValueOnce({ exists: true });

    await setupFileSystem();

    expect(FileSystem.makeDirectoryAsync).not.toHaveBeenCalled();
  });

  it('bails out when base directories are unavailable', async () => {
    let promise: Promise<unknown> | null = null;

    jest.isolateModules(() => {
      jest.doMock('expo-file-system/legacy', () => ({
        documentDirectory: null,
        cacheDirectory: null,
        getInfoAsync: jest.fn(),
        makeDirectoryAsync: jest.fn(),
      }));

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { setupFileSystem: setupFileSystemReloaded } = require('@/services/FileSystemSetup');
      promise = setupFileSystemReloaded();
    });

    await promise;
  });

  it('logs and rethrows when file system operations fail', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('fs failed');
    (FileSystem.getInfoAsync as jest.Mock).mockRejectedValueOnce(failure);

    await expect(setupFileSystem()).rejects.toThrow('fs failed');
    expect(errorSpy).toHaveBeenCalledWith('[FileSystemSetup] Failed to setup base directories', failure);

    errorSpy.mockRestore();
  });
});
