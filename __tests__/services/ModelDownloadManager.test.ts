import RNFS from 'react-native-fs';
import { modelDownloadManager } from '../../src/services/ModelDownloadManager';
import { hardwareListenerService } from '../../src/services/HardwareListenerService';

jest.mock('../../src/services/HardwareListenerService', () => ({
    hardwareListenerService: {
        getCurrentStatus: jest.fn(),
    },
}));

jest.mock('react-native-fs', () => ({
    DocumentDirectoryPath: '/mock/path',
    downloadFile: jest.fn(),
    hash: jest.fn(),
    unlink: jest.fn(),
    stopDownload: jest.fn(),
}));

describe('ModelDownloadManager', () => {
    it('prevents download on cellular network', async () => {
        (hardwareListenerService.getCurrentStatus as jest.Mock).mockReturnValue({
            networkType: 'cellular',
        });

        await expect(
            modelDownloadManager.startDownload({
                id: 'test',
                name: 'test',
                parameters: '3B',
                contextWindow: 4096,
                sizeBytes: 100,
                downloadUrl: 'https://example.com/model.gguf',
            })
        ).rejects.toThrow('CELLULAR_DATA_WARNING');

        expect(RNFS.downloadFile).not.toHaveBeenCalled();
    });
});
