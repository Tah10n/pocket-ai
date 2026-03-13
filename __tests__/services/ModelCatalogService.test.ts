import { modelCatalogService } from '../../src/services/ModelCatalogService';
import DeviceInfo from 'react-native-device-info';
import { hardwareListenerService } from '../../src/services/HardwareListenerService';

jest.mock('../../src/services/HardwareListenerService', () => ({
    hardwareListenerService: {
        getCurrentStatus: jest.fn().mockReturnValue({ isConnected: true }),
    }
}));

jest.mock('expo-file-system/legacy', () => ({
    documentDirectory: '/mock/',
    getInfoAsync: jest.fn(),
}));

jest.mock('react-native-device-info', () => ({
    getTotalMemory: jest.fn(),
    getFreeDiskStorage: jest.fn(),
}));

describe('ModelCatalogService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (modelCatalogService as any).searchCache.clear();
    });

    it('filters models based on hardware constraints', async () => {
        (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(4 * 1024 * 1024 * 1024); // 4GB
        (DeviceInfo.getFreeDiskStorage as jest.Mock).mockResolvedValue(10 * 1024 * 1024 * 1024); // 10GB

        global.fetch = jest.fn(() =>
            Promise.resolve({
                ok: true,
                json: () => Promise.resolve([
                    {
                        id: 'small-model',
                        sha: 'deadbeef',
                        siblings: [
                            {
                                rfilename: 'model.Q4_K_M.gguf',
                                size: 1.5 * 1024 * 1024 * 1024,
                            },
                        ],
                    },
                ]),
            })
        ) as jest.Mock;

        const available = await modelCatalogService.searchModels();
        expect(available).toHaveLength(1);
        expect(available[0].id).toBe('small-model');
    });

    it('appends gguf to search queries', async () => {
        (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(8 * 1024 * 1024 * 1024); // 8GB
        (DeviceInfo.getFreeDiskStorage as jest.Mock).mockResolvedValue(50 * 1024 * 1024 * 1024); // 50GB

        global.fetch = jest.fn(() =>
            Promise.resolve({
                ok: true,
                json: () => Promise.resolve([
                    {
                        id: 'phi-model',
                        sha: 'deadbeef',
                        siblings: [
                            {
                                rfilename: 'model.Q4_K_M.gguf',
                                size: 1.5 * 1024 * 1024 * 1024,
                            },
                        ],
                    },
                ]),
            })
        ) as jest.Mock;

        await modelCatalogService.searchModels('phi');

        const firstUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
        expect(firstUrl).toContain('search=phi%20gguf');
    });
});
