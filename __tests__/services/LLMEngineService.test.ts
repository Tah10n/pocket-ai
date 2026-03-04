import { hardwareListenerService } from '../../src/services/HardwareListenerService';
import { initLlama, releaseAllLlama } from 'llama.rn';

const mockContext = {
    completion: jest.fn().mockResolvedValue({ text: 'Hello!' }),
    stopCompletion: jest.fn().mockResolvedValue(undefined),
};

jest.mock('llama.rn', () => ({
    initLlama: jest.fn().mockResolvedValue(mockContext),
    releaseAllLlama: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('react-native-fs', () => ({
    DocumentDirectoryPath: '/mock/path',
    exists: jest.fn().mockResolvedValue(true),
}));

jest.mock('../../src/services/HardwareListenerService', () => {
    let subCb: any = null;
    return {
        hardwareListenerService: {
            subscribe: jest.fn((cb) => {
                subCb = cb;
                return jest.fn();
            }),
            _simulateLowMemory: () => {
                if (subCb) subCb({ isLowMemory: true });
            },
        },
    };
});

// Re-import after mocks are set up
import { llmEngineService } from '../../src/services/LLMEngineService';

describe('LLMEngineService (llama.rn)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('initializes the engine with initLlama', async () => {
        await llmEngineService.initialize({
            id: 'test-model',
            name: 'Test',
            parameters: '3B',
            contextWindow: 2048,
            sizeBytes: 100,
            downloadUrl: '',
        });
        expect(initLlama).toHaveBeenCalledWith(
            expect.objectContaining({ model: '/mock/path/test-model.bin' }),
            undefined,
        );
    });

    it('calls releaseAllLlama on low memory', async () => {
        await llmEngineService.initialize({
            id: 'test-model',
            name: 'Test',
            parameters: '3B',
            contextWindow: 2048,
            sizeBytes: 100,
            downloadUrl: '',
        });

        // @ts-ignore — test helper
        hardwareListenerService._simulateLowMemory();

        expect(releaseAllLlama).toHaveBeenCalled();
    });
});
