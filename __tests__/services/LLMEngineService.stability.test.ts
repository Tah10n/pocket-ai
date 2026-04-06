import { llmEngineService } from '../../src/services/LLMEngineService';
import { hardwareListenerService } from '../../src/services/HardwareListenerService';
import { registry } from '../../src/services/LocalStorageRegistry';
import DeviceInfo from 'react-native-device-info';
import { initLlama, releaseAllLlama } from 'llama.rn';

jest.mock('../../src/services/LocalStorageRegistry', () => ({
    registry: {
        getModel: jest.fn(),
        updateModel: jest.fn(),
        getModels: jest.fn(),
        saveModels: jest.fn(),
    }
}));

jest.mock('react-native-device-info', () => ({
    getTotalMemory: jest.fn(),
}));

jest.mock('llama.rn', () => ({
    initLlama: jest.fn(),
    releaseAllLlama: jest.fn().mockResolvedValue(undefined),
    toggleNativeLog: jest.fn().mockResolvedValue(undefined),
    addNativeLogListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
    loadLlamaModelInfo: jest.fn().mockResolvedValue({}),
    BuildInfo: { number: 'test', commit: 'test' },
}));

jest.mock('expo-file-system/legacy', () => ({
    getInfoAsync: jest.fn().mockResolvedValue({ exists: true }),
    documentDirectory: '/mock/',
}));

jest.mock('../../src/services/SettingsStore', () => ({
    getModelLoadParametersForModel: jest.fn().mockReturnValue({
        contextSize: 2048,
        gpuLayers: null,
    }),
    updateSettings: jest.fn(),
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
        (initLlama as jest.Mock).mockReset();
        (releaseAllLlama as jest.Mock).mockResolvedValue(undefined);
        (registry.getModel as jest.Mock).mockReturnValue({
            id: mockModel.id,
            localPath: 'model.gguf',
            lifecycleStatus: 'downloaded'
        });
        (registry.getModels as jest.Mock).mockReturnValue([]);
        // Reset singleton state
        (llmEngineService as any).state = {
            status: 'idle',
            loadProgress: 0,
        };
        (llmEngineService as any).context = null;
        (llmEngineService as any).initPromise = null;
        (llmEngineService as any).operationQueue = Promise.resolve();
        (llmEngineService as any).activeCompletionPromise = null;
        (llmEngineService as any).isUnloading = false;
        (llmEngineService as any).activeContextSize = 2048;
        (llmEngineService as any).activeGpuLayers = null;
        (llmEngineService as any).safeModeLoadLimits = null;
        hardwareListenerService.resetLowMemoryFlag();
    });

    it('loads a model even when total-memory resolution fails', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

        (DeviceInfo.getTotalMemory as jest.Mock).mockRejectedValueOnce(new Error('E_TOTAL_MEM'));
        (initLlama as jest.Mock).mockResolvedValue({}); // Success

        try {
            await expect(llmEngineService.load(mockModel.id)).resolves.toBeUndefined();
            expect(initLlama).toHaveBeenCalled();
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('returns unknown for fitsInRam checks when total-memory resolution fails', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

        (DeviceInfo.getTotalMemory as jest.Mock).mockRejectedValueOnce(new Error('E_TOTAL_MEM'));

        try {
            await expect(llmEngineService.fitsInRam(1_700_000_000)).resolves.toMatchObject({
                decision: 'unknown',
                confidence: 'low',
            });
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('uses 0 GPU layers on low-end devices (e.g. 4GB RAM)', async () => {
        // Mock 4GB RAM
        (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(4 * 1024 * 1024 * 1024);
        (initLlama as jest.Mock).mockResolvedValue({}); // Success

        await llmEngineService.load(mockModel.id);

        expect(initLlama).toHaveBeenCalledWith(
            expect.objectContaining({
                n_gpu_layers: 0,
            }),
            expect.any(Function)
        );
    });

    it('falls back to CPU if GPU initialization fails', async () => {
        // Mock 12GB RAM -> should try 35 GPU layers first
        (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(12 * 1024 * 1024 * 1024);
        
        // Fail first init, succeed second
        (initLlama as jest.Mock)
            .mockRejectedValueOnce(new Error('GPU OOM'))
            .mockResolvedValueOnce({});

        await llmEngineService.load(mockModel.id);

        expect(initLlama).toHaveBeenCalledTimes(2);
        
        // First attempt with GPU
        expect(initLlama).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ n_gpu_layers: 35 }),
            expect.any(Function)
        );
        
        // Second attempt with CPU fallback
        expect(initLlama).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ n_gpu_layers: 0 }),
            expect.any(Function)
        );
    });

    it('unloads model automatically when system issues memory warning', async () => {
        (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(8 * 1024 * 1024 * 1024);
        (initLlama as jest.Mock).mockResolvedValue({});

        await llmEngineService.load(mockModel.id);
        expect(llmEngineService.getState().status).toBe('ready');

        // Simulate OS memory warning via hardwareListenerService
        // @ts-ignore - access private method for testing or use the public setter if we made one
        hardwareListenerService.updateStatus({ isLowMemory: true });

        // Unload is asynchronous, wait a tick
        await new Promise(process.nextTick);

        expect(releaseAllLlama).toHaveBeenCalled();
        expect(llmEngineService.getState().status).toBe('idle');
        
        // Ensure flag is reset after unload
        expect(hardwareListenerService.getCurrentStatus().isLowMemory).toBe(false);
    });

    it('serializes concurrent load requests and leaves the newest model active', async () => {
        (registry.getModel as jest.Mock).mockImplementation((modelId: string) => ({
            id: modelId,
            localPath: `${modelId.replace('/', '_')}.gguf`,
            lifecycleStatus: 'downloaded',
        }));

        let resolveFirstLoad: (() => void) | undefined;
        (initLlama as jest.Mock)
            .mockImplementationOnce(() => new Promise((resolve) => {
                resolveFirstLoad = () => resolve({});
            }))
            .mockResolvedValueOnce({});

        const firstLoad = llmEngineService.load('repo/model-a');
        const secondLoad = llmEngineService.load('repo/model-b');

        while ((initLlama as jest.Mock).mock.calls.length === 0) {
            await Promise.resolve();
        }
        resolveFirstLoad?.();
        await Promise.all([firstLoad, secondLoad]);

        expect(initLlama).toHaveBeenCalledTimes(2);
        expect(releaseAllLlama).toHaveBeenCalledTimes(1);
        expect(llmEngineService.getState()).toEqual(
            expect.objectContaining({
                status: 'ready',
                activeModelId: 'repo/model-b',
            }),
        );
    });

    it('stops an in-flight completion before unloading the model', async () => {
        let resolveCompletion: ((value: { text: string }) => void) | undefined;
        const stopCompletion = jest.fn().mockImplementation(async () => {
            resolveCompletion?.({ text: 'Stopped during unload' });
        });

        (initLlama as jest.Mock).mockResolvedValue({
            completion: jest.fn(() => new Promise((resolve) => {
                resolveCompletion = resolve;
            })),
            stopCompletion,
        });

        await llmEngineService.load(mockModel.id);
        const completionPromise = llmEngineService.chatCompletion({
            messages: [{ role: 'user', content: 'Hello' }],
            params: { n_predict: 16 },
        });

        await llmEngineService.unload();

        await expect(completionPromise).resolves.toEqual({ text: 'Stopped during unload' });
        expect(stopCompletion).toHaveBeenCalled();
        expect(llmEngineService.getState().status).toBe('idle');
    });
});
