import { llmEngineService } from '../../src/services/LLMEngineService';
import { hardwareListenerService } from '../../src/services/HardwareListenerService';
import { registry } from '../../src/services/LocalStorageRegistry';
import { inferenceBackendService } from '../../src/services/InferenceBackendService';
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
    getBackendDevicesInfo: jest.fn().mockResolvedValue([
        {
            type: 'gpu',
            backend: 'OpenCL',
            deviceName: 'QUALCOMM Adreno(TM) 740',
            maxMemorySize: 0,
        },
    ]),
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

function createMockContext(options?: { n_gpu_layers?: number }) {
    const layers = options?.n_gpu_layers ?? 0;
    const accelerated = layers > 0;

    return {
        completion: jest.fn().mockResolvedValue({ text: '' }),
        getFormattedChat: jest.fn().mockResolvedValue({ prompt: 'Formatted prompt', additional_stops: [] }),
        tokenize: jest.fn().mockResolvedValue({ tokens: [] }),
        stopCompletion: jest.fn().mockResolvedValue(undefined),
        gpu: accelerated,
        devices: accelerated ? ['Adreno GPU'] : [],
        reasonNoGPU: accelerated ? '' : 'GPU disabled',
        systemInfo: 'Android test device',
        androidLib: accelerated ? 'libOpenCL.so' : null,
    };
}

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
        (initLlama as jest.Mock).mockImplementation(async (options?: { n_gpu_layers?: number }) => createMockContext(options));
        (releaseAllLlama as jest.Mock).mockResolvedValue(undefined);
        (registry.getModel as jest.Mock).mockReturnValue({
            id: mockModel.id,
            localPath: 'model.gguf',
            lifecycleStatus: 'downloaded'
        });
        (registry.getModels as jest.Mock).mockReturnValue([]);
        inferenceBackendService.clearCache();
        // Reset singleton state
        (llmEngineService as any).state = {
            status: 'idle',
            loadProgress: 0,
        };
        (llmEngineService as any).context = null;
        (llmEngineService as any).initPromise = null;
        (llmEngineService as any).operationQueue = Promise.resolve();
        (llmEngineService as any).contextOperationQueue = Promise.resolve();
        (llmEngineService as any).activeCompletionPromise = null;
        (llmEngineService as any).activeContextOperationPromises?.clear?.();
        (llmEngineService as any).completionInterruptGeneration = 0;
        (llmEngineService as any).additionalStopWordsCache?.clear?.();
        (llmEngineService as any).isUnloading = false;
        (llmEngineService as any).activeContextSize = 2048;
        (llmEngineService as any).activeGpuLayers = null;
        (llmEngineService as any).safeModeLoadLimits = null;
        hardwareListenerService.resetLowMemoryFlag();
    });

    it('loads a model even when total-memory resolution fails', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

        (DeviceInfo.getTotalMemory as jest.Mock).mockRejectedValueOnce(new Error('E_TOTAL_MEM'));
        (initLlama as jest.Mock).mockImplementation(async (options?: { n_gpu_layers?: number }) => createMockContext(options));

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
        (initLlama as jest.Mock).mockImplementation(async (options?: { n_gpu_layers?: number }) => createMockContext(options));

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
        
        // Fail any GPU init attempt, succeed on CPU fallback.
        (initLlama as jest.Mock).mockImplementation(async (options: { n_gpu_layers?: number }) => {
            if ((options?.n_gpu_layers ?? 0) > 0) {
                throw new Error('GPU OOM');
            }
            return createMockContext(options);
        });

        await llmEngineService.load(mockModel.id);

        expect((initLlama as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(2);
        
        const firstInitOptions = (initLlama as jest.Mock).mock.calls[0]?.[0] as { n_gpu_layers?: number } | undefined;
        expect(firstInitOptions?.n_gpu_layers ?? 0).toBeGreaterThan(0);
        
        const lastInitOptions = (initLlama as jest.Mock).mock.calls.at(-1)?.[0] as { n_gpu_layers?: number } | undefined;
        expect(lastInitOptions?.n_gpu_layers ?? 0).toBe(0);
    });

    it('unloads model automatically when system issues memory warning', async () => {
        (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(8 * 1024 * 1024 * 1024);
        (initLlama as jest.Mock).mockImplementation(async (options?: { n_gpu_layers?: number }) => createMockContext(options));

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
            .mockImplementationOnce((options?: { n_gpu_layers?: number }) => new Promise((resolve) => {
                resolveFirstLoad = () => resolve(createMockContext(options));
            }))
            .mockImplementationOnce(async (options?: { n_gpu_layers?: number }) => createMockContext(options));

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
        const completion = jest.fn(() => new Promise((resolve) => {
            resolveCompletion = resolve;
        }));

        (initLlama as jest.Mock).mockImplementation(async (options?: { n_gpu_layers?: number }) => ({
            ...createMockContext(options),
            completion,
            stopCompletion,
        }));

        await llmEngineService.load(mockModel.id);
        const completionPromise = llmEngineService.chatCompletion({
            messages: [{ role: 'user', content: 'Hello' }],
            params: { n_predict: 16 },
        });

        for (let i = 0; i < 5 && completion.mock.calls.length === 0; i += 1) {
            await Promise.resolve();
        }
        expect(completion).toHaveBeenCalled();

        await llmEngineService.unload();

        await expect(completionPromise).resolves.toEqual({ text: 'Stopped during unload' });
        expect(stopCompletion).toHaveBeenCalled();
        expect(llmEngineService.getState().status).toBe('idle');
    });

    it('waits for a completion task that has not reached native completion before releasing llama', async () => {
        let resolveFormatted: (() => void) | undefined;
        const getFormattedChat = jest.fn(() => new Promise((resolve) => {
            resolveFormatted = () => resolve({ prompt: 'Formatted prompt', additional_stops: [] });
        }));
        const completion = jest.fn().mockResolvedValue({ text: 'Should not run during unload' });
        const stopCompletion = jest.fn().mockResolvedValue(undefined);

        (initLlama as jest.Mock).mockImplementation(async (options?: { n_gpu_layers?: number }) => ({
            ...createMockContext(options),
            completion,
            getFormattedChat,
            stopCompletion,
        }));

        await llmEngineService.load(mockModel.id);
        const completionPromise = llmEngineService.chatCompletion({
            messages: [{ role: 'user', content: 'Hello' }],
            params: { n_predict: 16 },
        });

        for (let i = 0; i < 5 && getFormattedChat.mock.calls.length === 0; i += 1) {
            await Promise.resolve();
        }
        expect(getFormattedChat).toHaveBeenCalled();

        const unloadPromise = llmEngineService.unload();
        for (let i = 0; i < 5 && stopCompletion.mock.calls.length === 0; i += 1) {
            await Promise.resolve();
        }

        expect(stopCompletion).toHaveBeenCalled();
        expect(releaseAllLlama).not.toHaveBeenCalled();

        resolveFormatted?.();
        await Promise.resolve();
        expect(completion).not.toHaveBeenCalled();
        await expect(completionPromise).rejects.toMatchObject({ code: 'engine_unloading' });
        await unloadPromise;

        expect(releaseAllLlama).toHaveBeenCalled();
        expect(llmEngineService.getState().status).toBe('idle');
    });

    it('does not start native completion after stop is requested during template formatting', async () => {
        let resolveFormatted: (() => void) | undefined;
        const getFormattedChat = jest.fn(() => new Promise((resolve) => {
            resolveFormatted = () => resolve({ prompt: 'Formatted prompt', additional_stops: [] });
        }));
        const completion = jest.fn().mockResolvedValue({ text: 'Should not run after interrupt' });
        const stopCompletion = jest.fn().mockResolvedValue(undefined);

        (initLlama as jest.Mock).mockImplementation(async (options?: { n_gpu_layers?: number }) => ({
            ...createMockContext(options),
            completion,
            getFormattedChat,
            stopCompletion,
        }));

        await llmEngineService.load(mockModel.id);
        const completionPromise = llmEngineService.chatCompletion({
            messages: [{ role: 'user', content: 'Hello' }],
            params: { n_predict: 16 },
        });

        for (let i = 0; i < 5 && getFormattedChat.mock.calls.length === 0; i += 1) {
            await Promise.resolve();
        }
        expect(getFormattedChat).toHaveBeenCalled();

        const stopPromise = llmEngineService.stopCompletion();
        for (let i = 0; i < 5 && stopCompletion.mock.calls.length === 0; i += 1) {
            await Promise.resolve();
        }

        expect(stopCompletion).toHaveBeenCalled();
        await expect(stopPromise).resolves.toBeUndefined();

        resolveFormatted?.();
        await expect(completionPromise).rejects.toMatchObject({ code: 'engine_not_ready' });

        expect(completion).not.toHaveBeenCalled();
    });

    it('waits for prompt token counting before releasing llama during unload', async () => {
        let resolveFormatted: (() => void) | undefined;
        const getFormattedChat = jest.fn(() => new Promise((resolve) => {
            resolveFormatted = () => resolve({ prompt: 'Formatted prompt' });
        }));
        const tokenize = jest.fn().mockResolvedValue({ tokens: [1, 2, 3] });

        (initLlama as jest.Mock).mockImplementation(async (options?: { n_gpu_layers?: number }) => ({
            ...createMockContext(options),
            getFormattedChat,
            tokenize,
        }));

        await llmEngineService.load(mockModel.id);
        const countPromise = llmEngineService.countPromptTokens({
            messages: [{ role: 'user', content: 'Hello' }],
        });

        for (let i = 0; i < 5 && getFormattedChat.mock.calls.length === 0; i += 1) {
            await Promise.resolve();
        }
        expect(getFormattedChat).toHaveBeenCalled();

        const unloadPromise = llmEngineService.unload();
        await Promise.resolve();

        expect(releaseAllLlama).not.toHaveBeenCalled();

        resolveFormatted?.();
        await expect(countPromise).rejects.toMatchObject({ code: 'engine_unloading' });
        await unloadPromise;

        expect(tokenize).not.toHaveBeenCalled();
        expect(releaseAllLlama).toHaveBeenCalled();
    });

    it('serializes prompt token counting operations on the native context', async () => {
        let resolveFirstFormat: (() => void) | undefined;
        const getFormattedChat = jest
            .fn()
            .mockImplementationOnce(() => new Promise((resolve) => {
                resolveFirstFormat = () => resolve({ prompt: 'First prompt' });
            }))
            .mockResolvedValue({ prompt: 'Second prompt' });
        const tokenize = jest.fn().mockResolvedValue({ tokens: [1, 2, 3] });

        (initLlama as jest.Mock).mockImplementation(async (options?: { n_gpu_layers?: number }) => ({
            ...createMockContext(options),
            getFormattedChat,
            tokenize,
        }));

        await llmEngineService.load(mockModel.id);
        const firstCount = llmEngineService.countPromptTokens({
            messages: [{ role: 'user', content: 'First' }],
        });
        for (let i = 0; i < 5 && getFormattedChat.mock.calls.length === 0; i += 1) {
            await Promise.resolve();
        }
        expect(getFormattedChat).toHaveBeenCalledTimes(1);

        const secondCount = llmEngineService.countPromptTokens({
            messages: [{ role: 'user', content: 'Second' }],
        });
        await Promise.resolve();
        expect(getFormattedChat).toHaveBeenCalledTimes(1);

        resolveFirstFormat?.();
        await expect(firstCount).resolves.toBe(3);
        await expect(secondCount).resolves.toBe(3);

        expect(getFormattedChat).toHaveBeenCalledTimes(2);
        expect(tokenize).toHaveBeenCalledTimes(2);
    });

    it('releases llama during unload without waiting for the thinking capability probe', async () => {
        const previousEnv = process.env.NODE_ENV;
        (process.env as any).NODE_ENV = 'development';

        let resolveProbeFormat: (() => void) | undefined;
        const getFormattedChat = jest.fn(() => new Promise((resolve) => {
            resolveProbeFormat = () => resolve({
                prompt: 'Formatted prompt <think>reasoning</think>',
                thinking_start_tag: '<think>',
                thinking_end_tag: '</think>',
            });
        }));

        (initLlama as jest.Mock).mockImplementation(async (options?: { n_gpu_layers?: number }) => ({
            ...createMockContext(options),
            getFormattedChat,
        }));

        try {
            await llmEngineService.load(mockModel.id);
            (llmEngineService as any).launchThinkingCapabilityProbe(mockModel.id);
            for (let i = 0; i < 5 && getFormattedChat.mock.calls.length === 0; i += 1) {
                await Promise.resolve();
            }
            expect(getFormattedChat).toHaveBeenCalled();
            (registry.updateModel as jest.Mock).mockClear();

            const unloadPromise = llmEngineService.unload();
            for (let i = 0; i < 5 && (releaseAllLlama as jest.Mock).mock.calls.length === 0; i += 1) {
                await Promise.resolve();
            }

            expect(releaseAllLlama).toHaveBeenCalled();
            await unloadPromise;

            resolveProbeFormat?.();
            for (let i = 0; i < 5; i += 1) {
                await Promise.resolve();
            }

            expect(registry.updateModel).not.toHaveBeenCalledWith(expect.objectContaining({
                thinkingCapability: expect.anything(),
            }));
        } finally {
            (process.env as any).NODE_ENV = previousEnv;
        }
    });
});
