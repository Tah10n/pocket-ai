import { modelCatalogService } from '../../src/services/ModelCatalogService';
import DeviceInfo from 'react-native-device-info';

jest.mock('react-native-device-info', () => ({
    getTotalMemory: jest.fn(),
    getFreeDiskStorage: jest.fn(),
}));

describe('ModelCatalogService', () => {
    it('filters models based on hardware constraints', async () => {
        (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(4 * 1024 * 1024 * 1024); // 4GB
        (DeviceInfo.getFreeDiskStorage as jest.Mock).mockResolvedValue(10 * 1024 * 1024 * 1024); // 10GB

        global.fetch = jest.fn(() =>
            Promise.resolve({
                ok: true,
                json: () => Promise.resolve([
                    { id: 'small-model' }, // 1.5GB default from mock inside fetchHuggingFaceModels
                ]),
            })
        ) as jest.Mock;

        const available = await modelCatalogService.getAvailableModels();
        expect(available).toHaveLength(1);
        expect(available[0].id).toBe('small-model');
    });
});
