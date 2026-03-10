import RNFS from 'react-native-fs';
import { modelDownloadManager } from '../../src/services/ModelDownloadManager';
import { hardwareListenerService } from '../../src/services/HardwareListenerService';
import { localStorageRegistry } from '../../src/services/LocalStorageRegistry';

jest.mock('../../src/services/HardwareListenerService', () => ({
    hardwareListenerService: {
        getCurrentStatus: jest.fn(),
    },
}));

jest.mock('../../src/services/LocalStorageRegistry', () => ({
    localStorageRegistry: {
        addModel: jest.fn(),
    },
}));

jest.mock('react-native-fs', () => ({
    DocumentDirectoryPath: '/mock/path',
    downloadFile: jest.fn(),
    hash: jest.fn(),
    unlink: jest.fn().mockResolvedValue(undefined),
    stopDownload: jest.fn(),
    getFSInfo: jest.fn(),
    exists: jest.fn(),
}));

describe('ModelDownloadManager Extended', () => {
    const mockModel = {
        id: 'repo/model',
        name: 'model',
        parameters: '7B',
        contextWindow: 4096,
        sizeBytes: 2 * 1024 * 1024 * 1024, // 2GB
        downloadUrl: 'https://huggingface.co/repo/model/resolve/main/model.gguf',
        sha256: 'correct-sha256',
    };

    beforeEach(() => {
        jest.clearAllMocks();
        (hardwareListenerService.getCurrentStatus as jest.Mock).mockReturnValue({
            networkType: 'wifi',
        });
    });

    it('fails when disk space is low (less than model size + 1GB buffer)', async () => {
        // 2GB model + 1GB buffer = 3GB required. Let's return 2.5GB free.
        (RNFS.getFSInfo as jest.Mock).mockResolvedValue({
            freeSpace: 2.5 * 1024 * 1024 * 1024,
            totalSpace: 100 * 1024 * 1024 * 1024,
        });

        await expect(modelDownloadManager.startDownload(mockModel)).rejects.toThrow('DISK_SPACE_LOW');
        expect(RNFS.downloadFile).not.toHaveBeenCalled();
    });

    it('succeeds when disk space is sufficient', async () => {
        (RNFS.getFSInfo as jest.Mock).mockResolvedValue({
            freeSpace: 10 * 1024 * 1024 * 1024,
            totalSpace: 100 * 1024 * 1024 * 1024,
        });

        (RNFS.downloadFile as jest.Mock).mockReturnValue({
            jobId: 1,
            promise: Promise.resolve({ statusCode: 200 }),
        });

        (RNFS.hash as jest.Mock).mockResolvedValue('correct-sha256');

        await modelDownloadManager.startDownload(mockModel);

        expect(RNFS.downloadFile).toHaveBeenCalled();
        expect(localStorageRegistry.addModel).toHaveBeenCalledWith(mockModel);
    });

    it('deletes the file and fails when checksum is incorrect', async () => {
        (RNFS.getFSInfo as jest.Mock).mockResolvedValue({
            freeSpace: 10 * 1024 * 1024 * 1024,
        });

        (RNFS.downloadFile as jest.Mock).mockReturnValue({
            jobId: 1,
            promise: Promise.resolve({ statusCode: 200 }),
        });

        (RNFS.hash as jest.Mock).mockResolvedValue('wrong-sha256');

        await modelDownloadManager.startDownload(mockModel);

        expect(RNFS.unlink).toHaveBeenCalled();
        expect(localStorageRegistry.addModel).not.toHaveBeenCalled();
    });

    it('skips verification if sha256 is missing in metadata', async () => {
        const modelNoSha = { ...mockModel, sha256: undefined };

        (RNFS.getFSInfo as jest.Mock).mockResolvedValue({
            freeSpace: 10 * 1024 * 1024 * 1024,
        });

        (RNFS.downloadFile as jest.Mock).mockReturnValue({
            jobId: 1,
            promise: Promise.resolve({ statusCode: 200 }),
        });

        await modelDownloadManager.startDownload(modelNoSha);

        expect(RNFS.hash).not.toHaveBeenCalled();
        expect(localStorageRegistry.addModel).toHaveBeenCalled();
    });
});
