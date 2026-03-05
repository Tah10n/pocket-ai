import { modelCatalogService } from '../../src/services/ModelCatalogService';
import DeviceInfo from 'react-native-device-info';

jest.mock('react-native-device-info', () => ({
    getTotalMemory: jest.fn(),
    getFreeDiskStorage: jest.fn(),
}));

describe('ModelCatalogService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
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

        const available = await modelCatalogService.getAvailableModels();
        expect(available).toHaveLength(1);
        expect(available[0].id).toBe('small-model');
    });

    it('uses downloads sorting for featured list', async () => {
        (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(8 * 1024 * 1024 * 1024); // 8GB
        (DeviceInfo.getFreeDiskStorage as jest.Mock).mockResolvedValue(50 * 1024 * 1024 * 1024); // 50GB

        global.fetch = jest.fn(() =>
            Promise.resolve({
                ok: true,
                json: () => Promise.resolve([
                    {
                        id: 'popular-model',
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

        await modelCatalogService.getAvailableModels();

        const firstUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
        expect(firstUrl).toContain('search=gguf');
        expect(firstUrl).toContain('sort=downloads');
        expect(firstUrl).toContain('direction=-1');
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

        await modelCatalogService.getAvailableModels('phi');

        const firstUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
        expect(firstUrl).toContain('search=phi%20gguf');
    });

    it('returns models even when file size is missing', async () => {
        (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(8 * 1024 * 1024 * 1024); // 8GB
        (DeviceInfo.getFreeDiskStorage as jest.Mock).mockResolvedValue(50 * 1024 * 1024 * 1024); // 50GB

        global.fetch = jest.fn((url: string) => {
            if (url.includes('/api/models?')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve([
                        {
                            id: 'nosize-model',
                            sha: 'deadbeef',
                        },
                    ]),
                });
            }

            if (url.includes('/api/models/nosize-model')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({
                        id: 'nosize-model',
                        sha: 'deadbeef',
                        siblings: [
                            {
                                rfilename: 'model.Q4_K_M.gguf',
                            },
                        ],
                    }),
                });
            }

            return Promise.resolve({
                ok: false,
                status: 404,
                statusText: 'Not Found',
                json: () => Promise.resolve({}),
            });
        }) as unknown as jest.Mock;

        const available = await modelCatalogService.getAvailableModels();
        expect(available).toHaveLength(1);
        expect(available[0].id).toBe('nosize-model');
        expect(available[0].sizeBytes).toBe(0);
        expect(available[0].downloadUrl).toContain('/resolve/deadbeef/model.Q4_K_M.gguf');
    });
});
