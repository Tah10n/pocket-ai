import { llmEngineService } from '../../src/services/LLMEngineService';
import { hardwareListenerService } from '../../src/services/HardwareListenerService';
import DeviceInfo from 'react-native-device-info';
import { initLlama, releaseAllLlama } from 'llama.rn';
import RNFS from 'react-native-fs';

jest.mock('react-native-device-info', () => ({
    getTotalMemory: jest.fn(),
}));

jest.mock('llama.rn', () => ({
    initLlama: jest.fn(),
    releaseAllLlama: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('react-native-fs', () => ({
    DocumentDirectoryPath: '/mock/path',
    exists: jest.fn().mockResolvedValue(true),
}));

describe('LLMEngineService Stability', () => {
    const mockModel = {
        id: 'repo/model',
        name: 'model',
        parameters: '3B',
        contextWindow: 2048,
        sizeBytes: 1024,
        downloadUrl: 'url',
    };

    beforeEach(() => {
        jest.clearAllMocks();
        // Reset singleton state
        // @ts-ignore
        llmEngineService.state = 'uninitialized';
        // @ts-ignore
        llmEngineService.context = null;
        hardwareListenerService.resetLowMemoryFlag();
    });

    it('uses 0 GPU layers on low-end devices (e.g. 4GB RAM)', async () => {
        // Mock 4GB RAM
        (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(4 * 1024 * 1024 * 1024);
        (initLlama as jest.Mock).mockResolvedValue({}); // Success

        await llmEngineService.initialize(mockModel);

        expect(initLlama).toHaveBeenCalledWith(
            expect.objectContaining({
                n_gpu_layers: 0,
            }),
            undefined
        );
    });

    it('falls back to CPU if GPU initialization fails', async () => {
        // Mock 12GB RAM -> should try 35 GPU layers first
        (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(12 * 1024 * 1024 * 1024);
        
        // Fail first init, succeed second
        (initLlama as jest.Mock)
            .mockRejectedValueOnce(new Error('GPU OOM'))
            .mockResolvedValueOnce({});

        await llmEngineService.initialize(mockModel);

        expect(initLlama).toHaveBeenCalledTimes(2);
        
        // First attempt with GPU
        expect(initLlama).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ n_gpu_layers: 35 }),
            undefined
        );
        
        // Second attempt with CPU fallback
        expect(initLlama).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ n_gpu_layers: 0 }),
            undefined
        );
    });

    it('unloads model automatically when system issues memory warning', async () => {
        (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(8 * 1024 * 1024 * 1024);
        (initLlama as jest.Mock).mockResolvedValue({});

        await llmEngineService.initialize(mockModel);
        expect(llmEngineService.getState()).toBe('ready');

        // Simulate OS memory warning via hardwareListenerService
        // @ts-ignore - access private method for testing or use the public setter if we made one
        hardwareListenerService.updateStatus({ isLowMemory: true });

        // Unload is asynchronous, wait a tick
        await new Promise(process.nextTick);

        expect(releaseAllLlama).toHaveBeenCalled();
        expect(llmEngineService.getState()).toBe('uninitialized');
        
        // Ensure flag is reset after unload
        expect(hardwareListenerService.getCurrentStatus().isLowMemory).toBe(false);
    });
});
