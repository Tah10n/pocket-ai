import { modelDownloadManager } from '../../src/services/ModelDownloadManager';
import { hardwareListenerService } from '../../src/services/HardwareListenerService';
import RNBackgroundDownloader from 'react-native-background-downloader';

jest.mock('react-native-background-downloader', () => ({
    download: jest.fn(() => ({
        begin: jest.fn().mockReturnThis(),
        progress: jest.fn().mockReturnThis(),
        done: jest.fn().mockReturnThis(),
        error: jest.fn().mockReturnThis(),
    })),
    checkForExistingDownloads: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../src/services/HardwareListenerService', () => ({
    hardwareListenerService: {
        getCurrentStatus: jest.fn(),
    }
}));

jest.mock('react-native-fs', () => ({
    DocumentDirectoryPath: '/mock/path',
    hash: jest.fn(),
    unlink: jest.fn(),
}));

describe('ModelDownloadManager', () => {
    it('prevents download on cellular network', async () => {
        (hardwareListenerService.getCurrentStatus as jest.Mock).mockReturnValue({
            networkType: 'cellular'
        });

        await expect(modelDownloadManager.startDownload({
            id: 'test', name: 'test', parameters: '3B', contextWindow: 4096, sizeBytes: 100, downloadUrl: 'http://test.com'
        })).rejects.toThrow('CELLULAR_DATA_WARNING');

        expect(RNBackgroundDownloader.download).not.toHaveBeenCalled();
    });
});
