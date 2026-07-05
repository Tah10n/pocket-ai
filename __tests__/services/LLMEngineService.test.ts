import * as llamaRn from 'llama.rn';
import * as FileSystem from 'expo-file-system/legacy';
import * as RNFS from 'react-native-fs';
import DeviceInfo from 'react-native-device-info';
import { llmEngineService } from '../../src/services/LLMEngineService';
import { buildMultimodalDiagnosticsSummary } from '../../src/services/LLMEngineService.diagnostics';
import { inferenceBackendService } from '../../src/services/InferenceBackendService';
import { registry } from '../../src/services/LocalStorageRegistry';
import { writeAutotuneResult } from '../../src/services/InferenceAutotuneStore';
import { createStorage } from '../../src/services/storage';
import { getModelLoadParametersForModel, updateSettings } from '../../src/services/SettingsStore';
import { getFreshMemorySnapshot } from '../../src/services/SystemMetricsService';
import { performanceMonitor } from '../../src/services/PerformanceMonitor';
import { EngineStatus, LifecycleStatus } from '../../src/types/models';
import type { ProjectorArtifact } from '../../src/types/multimodal';
import { UNKNOWN_PROJECTOR_MEMORY_FIT_FALLBACK_BYTES } from '../../src/utils/memoryFit';

jest.mock('llama.rn', () => {
  const completion = jest.fn();
  const getFormattedChat = jest.fn().mockResolvedValue({ prompt: 'Formatted prompt', additional_stops: [] });
  const tokenize = jest.fn().mockResolvedValue({ tokens: [] });
  const initMultimodal = jest.fn().mockResolvedValue(true);
  const getMultimodalSupport = jest.fn().mockResolvedValue({ vision: true, audio: false });
  const releaseMultimodal = jest.fn().mockResolvedValue(undefined);
  const removeNativeLogListener = jest.fn();
  return {
    initLlama: jest.fn().mockImplementation(async (options?: { n_gpu_layers?: number }) => ({
      completion,
      getFormattedChat,
      tokenize,
      initMultimodal,
      getMultimodalSupport,
      releaseMultimodal,
      stopCompletion: jest.fn().mockResolvedValue(undefined),
      gpu: (options?.n_gpu_layers ?? 0) > 0,
      devices: (options?.n_gpu_layers ?? 0) > 0 ? ['Adreno GPU'] : [],
      reasonNoGPU: (options?.n_gpu_layers ?? 0) > 0 ? '' : 'GPU disabled',
      systemInfo: 'Android test device',
      androidLib: (options?.n_gpu_layers ?? 0) > 0 ? 'libOpenCL.so' : null,
    })),
    releaseAllLlama: jest.fn().mockResolvedValue(undefined),
    toggleNativeLog: jest.fn().mockResolvedValue(undefined),
    addNativeLogListener: jest.fn().mockReturnValue({ remove: removeNativeLogListener }),
    loadLlamaModelInfo: jest.fn().mockResolvedValue({
      'general.architecture': 'llama',
      'general.type': 'model',
      'llama.block_count': 32,
      'llama.attention.head_count': 32,
      'llama.embedding_length': 4096,
    }),
    getBackendDevicesInfo: jest.fn().mockResolvedValue([]),
    BuildInfo: { number: 'test', commit: 'test' },
    __completionMock: completion,
    __getFormattedChatMock: getFormattedChat,
    __tokenizeMock: tokenize,
    __initMultimodalMock: initMultimodal,
    __getMultimodalSupportMock: getMultimodalSupport,
    __releaseMultimodalMock: releaseMultimodal,
  };
});

jest.mock('react-native-device-info', () => ({
  getTotalMemory: jest.fn().mockResolvedValue(8 * 1024 * 1024 * 1024),
}));

jest.mock('../../src/services/SettingsStore', () => ({
  getModelLoadParametersForModel: jest.fn().mockReturnValue({
    contextSize: 2048,
    gpuLayers: null,
  }),
  updateSettings: jest.fn(),
}));

jest.mock('../../src/services/SystemMetricsService', () => ({
  getFreshMemorySnapshot: jest.fn().mockResolvedValue(null),
}));

function getBackendDevicesInfoMock(): jest.Mock {
  return (llamaRn as unknown as { getBackendDevicesInfo: jest.Mock }).getBackendDevicesInfo;
}

function getFormattedChatMock(): jest.Mock {
  return (llamaRn as unknown as { __getFormattedChatMock: jest.Mock }).__getFormattedChatMock;
}

function getTokenizeMock(): jest.Mock {
  return (llamaRn as unknown as { __tokenizeMock: jest.Mock }).__tokenizeMock;
}

function getInitMultimodalMock(): jest.Mock {
  return (llamaRn as unknown as { __initMultimodalMock: jest.Mock }).__initMultimodalMock;
}

function getMultimodalSupportMock(): jest.Mock {
  return (llamaRn as unknown as { __getMultimodalSupportMock: jest.Mock }).__getMultimodalSupportMock;
}

function getReleaseMultimodalMock(): jest.Mock {
  return (llamaRn as unknown as { __releaseMultimodalMock: jest.Mock }).__releaseMultimodalMock;
}

async function waitForMockCall(mock: jest.Mock, count = 1): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (mock.mock.calls.length >= count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(`Expected mock to be called at least ${count} time(s).`);
}

async function waitForCondition(assertion: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (assertion()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(`Timed out waiting for ${label}.`);
}

function allowThinkingCapabilityProbe() {
  (registry.getModel as jest.Mock).mockReturnValue({
    id: 'test/model',
    localPath: 'model.gguf',
    lifecycleStatus: LifecycleStatus.DOWNLOADED,
    thinkingCapability: undefined,
  });
}

const downloadedProjector: ProjectorArtifact = {
  id: 'projector-test-model-main-mmproj-model.gguf',
  ownerModelId: 'test/model',
  repoId: 'test/model',
  fileName: 'mmproj-model.gguf',
  downloadUrl: 'https://huggingface.co/test/model/resolve/main/mmproj-model.gguf',
  size: 24_000_000,
  lifecycleStatus: 'downloaded',
  matchStatus: 'matched',
  localPath: 'mmproj-model.gguf',
};

function createReadyMultimodalReadiness() {
  return {
    modelId: 'test/model',
    status: 'ready' as const,
    projectorId: downloadedProjector.id,
    support: ['vision' as const],
    checkedAt: 1,
  };
}

function createDownloadedVisionModel() {
  return {
    id: 'test/model',
    localPath: 'model.gguf',
    lifecycleStatus: LifecycleStatus.DOWNLOADED,
    chatModalities: ['text', 'vision'],
    projectorCandidates: [downloadedProjector],
    selectedProjectorId: downloadedProjector.id,
    thinkingCapability: {
      detectedAt: 1,
      supportsThinking: false,
      canDisableThinking: true,
    },
  };
}

function createDownloadedAudioModel() {
  return {
    ...createDownloadedVisionModel(),
    chatModalities: ['text', 'audio'],
  };
}

function createReadyVisionModel() {
  return {
    ...createDownloadedVisionModel(),
    multimodalReadiness: createReadyMultimodalReadiness(),
  };
}

type TestActiveMultimodalContext = {
  modelId: string;
  projectorId: string;
  projectorFallbackMarker: string | null;
};

function getActiveMultimodalContext(): TestActiveMultimodalContext | null {
  return (llmEngineService as unknown as {
    activeMultimodalContext: TestActiveMultimodalContext | null;
  }).activeMultimodalContext;
}

function createTestImageAttachment(id: string, localUri: string, size = 4096) {
  return {
    id,
    threadId: 'thread-1',
    messageId: 'message-1',
    localUri,
    pathCategory: 'chat_attachment' as const,
    fileName: `${id}.jpg`,
    mediaType: 'image/jpeg',
    size,
    source: 'photo_library' as const,
    createdAt: 1,
  };
}

const multimodalDowngradeCases = [
  {
    label: 'missing projector',
    expectedStatus: 'missing_projector',
    createModel: () => ({
      ...createDownloadedVisionModel(),
      projectorCandidates: [],
      selectedProjectorId: undefined,
      multimodalReadiness: createReadyMultimodalReadiness(),
    }),
  },
  {
    label: 'downloading projector',
    expectedStatus: 'projector_downloading',
    createModel: () => ({
      ...createDownloadedVisionModel(),
      projectorCandidates: [{
        ...downloadedProjector,
        lifecycleStatus: 'downloading' as const,
      }],
      multimodalReadiness: createReadyMultimodalReadiness(),
    }),
  },
  {
    label: 'failed projector',
    expectedStatus: 'failed',
    createModel: () => ({
      ...createDownloadedVisionModel(),
      projectorCandidates: [{
        ...downloadedProjector,
        lifecycleStatus: 'failed' as const,
        matchReason: 'projector_download_failed',
      }],
      multimodalReadiness: createReadyMultimodalReadiness(),
    }),
  },
  {
    label: 'text-only model',
    expectedStatus: 'text_only',
    createModel: () => ({
      ...createDownloadedVisionModel(),
      chatModalities: ['text'],
      projectorCandidates: [],
      selectedProjectorId: undefined,
      multimodalReadiness: createReadyMultimodalReadiness(),
    }),
  },
];

describe('LLMEngineService', () => {
  let consoleErrorSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;

  beforeAll(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterAll(() => {
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  beforeEach(() => {
    (process.env as any).NODE_ENV = 'test';
    jest.clearAllMocks();
    performanceMonitor.clear();
    performanceMonitor.setEnabled(false);
    createStorage('pocket-ai-autotune', { tier: 'private' }).clearAll();
    inferenceBackendService.clearCache();
    (llmEngineService as any).contextOperationQueue = Promise.resolve();
    (llmEngineService as any).contextOperationRunner?.reset?.(new Error('test reset'));
    (llmEngineService as any).activeContextOperationPromises?.clear?.();
    (llmEngineService as any).activeContextOperationRejects?.clear?.();
    (llmEngineService as any).activeCompletionReject = null;
    (llmEngineService as any).activeMultimodalContext = null;
    (llmEngineService as any).loadedContextDisablesContextShiftForMultimodal = false;
    (llmEngineService as any).additionalStopWordsCache?.clear?.();
    getBackendDevicesInfoMock().mockResolvedValue([
      {
        type: 'gpu',
        backend: 'OpenCL',
        deviceName: 'QUALCOMM Adreno(TM) 740',
        maxMemorySize: 0,
      },
    ]);
    (getFreshMemorySnapshot as jest.Mock).mockResolvedValue(null);
    getInitMultimodalMock().mockResolvedValue(true);
    getMultimodalSupportMock().mockResolvedValue({ vision: true, audio: false });
    getReleaseMultimodalMock().mockResolvedValue(undefined);
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 1024 });
    (llamaRn.initLlama as jest.Mock).mockImplementation(async (options?: { n_gpu_layers?: number }) => ({
      completion: (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock,
      getFormattedChat: getFormattedChatMock(),
      tokenize: (llamaRn as unknown as { __tokenizeMock: jest.Mock }).__tokenizeMock,
      initMultimodal: getInitMultimodalMock(),
      getMultimodalSupport: getMultimodalSupportMock(),
      releaseMultimodal: getReleaseMultimodalMock(),
      stopCompletion: jest.fn().mockResolvedValue(undefined),
      gpu: (options?.n_gpu_layers ?? 0) > 0,
      devices: (options?.n_gpu_layers ?? 0) > 0 ? ['Adreno GPU'] : [],
      reasonNoGPU: (options?.n_gpu_layers ?? 0) > 0 ? '' : 'GPU disabled',
      systemInfo: 'Android test device',
      androidLib: (options?.n_gpu_layers ?? 0) > 0 ? 'libOpenCL.so' : null,
    }));
    (registry.getModel as jest.Mock) = jest.fn().mockReturnValue({
      id: 'test/model',
      localPath: 'model.gguf',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      thinkingCapability: {
        detectedAt: 1,
        supportsThinking: false,
        canDisableThinking: true,
      },
    });
    (registry.updateModel as jest.Mock) = jest.fn();
    (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock.mockResolvedValue({ text: 'Hello back' });
    getFormattedChatMock().mockResolvedValue({ prompt: 'Formatted prompt', additional_stops: [] });

    // Ensure each test starts with a realistic, non-empty GGUF metadata payload.
    (llamaRn.loadLlamaModelInfo as jest.Mock).mockResolvedValue({
      'general.architecture': 'llama',
      'general.type': 'model',
      'llama.block_count': 32,
      'llama.attention.head_count': 32,
      'llama.embedding_length': 4096,
    });
  });

  it('forwards structured messages to llama.rn completion', async () => {
    await llmEngineService.load('test/model');

    expect(llmEngineService.getState().status).toBe(EngineStatus.READY);
    expect(updateSettings).toHaveBeenCalledWith({ activeModelId: 'test/model' });

    await llmEngineService.chatCompletion({
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Hello' },
      ],
      params: {
        temperature: 0.4,
        top_p: 0.8,
        n_predict: 128,
      },
    });

    expect(llamaRn.initLlama).toHaveBeenCalled();
    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: 'system', content: 'Be concise.' },
          { role: 'user', content: 'Hello' },
        ],
        temperature: 0.4,
        top_p: 0.8,
        n_predict: 128,
      }),
      expect.any(Function),
    );
  });

  it('forwards ready image media paths to llama.rn completion', async () => {
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());

    await llmEngineService.load('test/model');

    await llmEngineService.chatCompletion({
      messages: [{ role: 'user', content: 'Describe this', mediaPaths: ['test-dir/chat-attachments/image.jpg'] }],
      multimodalReadiness: {
        modelId: 'test/model',
        status: 'ready',
        projectorId: downloadedProjector.id,
        support: ['vision'],
        checkedAt: 1,
      },
      params: { n_predict: 32 },
    });

    expect(getInitMultimodalMock()).toHaveBeenCalledWith(expect.objectContaining({
      path: 'test-dir/models/mmproj-model.gguf',
    }));
    expect(getMultimodalSupportMock()).toHaveBeenCalledTimes(1);
    expect(registry.updateModel).toHaveBeenCalledWith(expect.objectContaining({
      multimodalReadiness: expect.objectContaining({
        status: 'ready',
        projectorId: downloadedProjector.id,
        projectorSize: 1024,
        support: ['vision'],
      }),
    }));
    expect(getFormattedChatMock()).toHaveBeenCalledWith(
      [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this' },
          { type: 'image_url', image_url: { url: 'test-dir/chat-attachments/image.jpg' } },
        ],
      }],
      null,
      expect.any(Object),
    );
    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        media_paths: ['test-dir/chat-attachments/image.jpg'],
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this' },
            { type: 'image_url', image_url: { url: 'test-dir/chat-attachments/image.jpg' } },
          ],
        }],
      }),
      expect.any(Function),
    );
    expect(llmEngineService.getState().diagnostics?.multimodal).toEqual(expect.objectContaining({
      visionCapability: 'vision_capable',
      projectorPresence: 'downloaded',
      projectorPathCategory: 'models',
      readinessStatus: 'ready',
      attachmentCount: 1,
    }));
    const serializedDiagnostics = JSON.stringify(llmEngineService.getState().diagnostics);
    expect(serializedDiagnostics).not.toContain('test-dir/chat-attachments/image.jpg');
    expect(serializedDiagnostics).not.toContain('chat-attachments');
    expect(serializedDiagnostics).not.toContain('test-dir/models/mmproj-model.gguf');
  });

  it('forwards structured image content parts without duplicating them as legacy media paths', async () => {
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());

    await llmEngineService.load('test/model');

    await llmEngineService.chatCompletion({
      messages: [{
        role: 'user',
        content: 'Describe this',
        contentParts: [
          { type: 'image_url', image_url: { url: 'test-dir/chat-attachments/image.jpg' } },
        ],
      }],
      multimodalReadiness: {
        modelId: 'test/model',
        status: 'ready',
        projectorId: downloadedProjector.id,
        support: ['vision'],
        checkedAt: 1,
      },
      params: { n_predict: 32 },
    });

    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        media_paths: ['test-dir/chat-attachments/image.jpg'],
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this' },
            { type: 'image_url', image_url: { url: 'test-dir/chat-attachments/image.jpg' } },
          ],
        }],
      }),
      expect.any(Function),
    );
  });

  it('rejects explicit media paths outside app-owned chat attachment storage', async () => {
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());

    await llmEngineService.load('test/model');

    await expect(llmEngineService.chatCompletion({
      messages: [{ role: 'user', content: 'Describe this', mediaPaths: ['/private/tmp/image.jpg'] }],
      multimodalReadiness: {
        modelId: 'test/model',
        status: 'ready',
        projectorId: downloadedProjector.id,
        support: ['vision'],
        checkedAt: 1,
      },
      params: { n_predict: 32 },
    })).rejects.toMatchObject({
      code: 'chat_attachment_not_ready',
      details: expect.objectContaining({
        pathCategory: 'non_chat_attachment',
      }),
    });

    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).not.toHaveBeenCalled();
  });

  it('rejects structured image content parts outside app-owned chat attachment storage', async () => {
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());

    await llmEngineService.load('test/model');

    await expect(llmEngineService.chatCompletion({
      messages: [{
        role: 'user',
        content: 'Describe this',
        contentParts: [
          { type: 'image_url', image_url: { url: '/private/tmp/image.jpg' } },
        ],
      }],
      multimodalReadiness: {
        modelId: 'test/model',
        status: 'ready',
        projectorId: downloadedProjector.id,
        support: ['vision'],
        checkedAt: 1,
      },
      params: { n_predict: 32 },
    })).rejects.toMatchObject({
      code: 'chat_attachment_not_ready',
      details: expect.objectContaining({
        pathCategory: 'non_chat_attachment',
      }),
    });

    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).not.toHaveBeenCalled();
  });

  it('rejects image media paths when readiness belongs to another model', async () => {
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());

    await llmEngineService.load('test/model');

    await expect(llmEngineService.chatCompletion({
      messages: [{ role: 'user', content: 'Describe this', mediaPaths: ['test-dir/chat-attachments/image.jpg'] }],
      multimodalReadiness: {
        modelId: 'other/model',
        status: 'ready',
        projectorId: downloadedProjector.id,
        support: ['vision'],
        checkedAt: 1,
      },
      params: { n_predict: 32 },
    })).rejects.toMatchObject({
      code: 'multimodal_not_ready',
    });

    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).not.toHaveBeenCalled();
  });

  it('forwards retained historical and latest user media paths before llama normalization', async () => {
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());

    await llmEngineService.load('test/model');

    await llmEngineService.chatCompletion({
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Earlier image', mediaPaths: ['test-dir/chat-attachments/first.jpg'] },
        { role: 'assistant', content: 'Earlier answer' },
        { role: 'user', content: 'Now describe', mediaPaths: ['test-dir/chat-attachments/latest-existing.jpg'] },
      ],
      mediaPaths: [
        'test-dir/chat-attachments/first.jpg',
        'test-dir/chat-attachments/top.jpg',
      ],
      multimodalReadiness: {
        modelId: 'test/model',
        status: 'ready',
        projectorId: downloadedProjector.id,
        support: ['vision'],
        checkedAt: 1,
      },
      params: { n_predict: 32 },
    });

    expect(getFormattedChatMock()).toHaveBeenCalledWith(
      [
        { role: 'system', content: 'Be concise.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Earlier image' },
            { type: 'image_url', image_url: { url: 'test-dir/chat-attachments/first.jpg' } },
          ],
        },
        { role: 'assistant', content: 'Earlier answer' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Now describe' },
            { type: 'image_url', image_url: { url: 'test-dir/chat-attachments/latest-existing.jpg' } },
            { type: 'image_url', image_url: { url: 'test-dir/chat-attachments/top.jpg' } },
          ],
        },
      ],
      null,
      expect.any(Object),
    );
    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        media_paths: ['test-dir/chat-attachments/first.jpg', 'test-dir/chat-attachments/latest-existing.jpg', 'test-dir/chat-attachments/top.jpg'],
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: [
              { type: 'text', text: 'Earlier image' },
              { type: 'image_url', image_url: { url: 'test-dir/chat-attachments/first.jpg' } },
            ],
          }),
          expect.objectContaining({
            role: 'user',
            content: [
              { type: 'text', text: 'Now describe' },
              { type: 'image_url', image_url: { url: 'test-dir/chat-attachments/latest-existing.jpg' } },
              { type: 'image_url', image_url: { url: 'test-dir/chat-attachments/top.jpg' } },
            ],
          }),
        ]),
      }),
      expect.any(Function),
    );
  });

  it('forwards retained historical image media paths for a latest text-only follow-up', async () => {
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());

    await llmEngineService.load('test/model');

    await llmEngineService.chatCompletion({
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Earlier image', mediaPaths: ['test-dir/chat-attachments/first.jpg'] },
        { role: 'assistant', content: 'Earlier answer' },
        { role: 'user', content: 'Continue with text only' },
      ],
      multimodalReadiness: {
        modelId: 'test/model',
        status: 'ready',
        projectorId: downloadedProjector.id,
        support: ['vision'],
        checkedAt: 1,
      },
      params: { n_predict: 32 },
    });

    expect(getFormattedChatMock()).toHaveBeenCalledWith(
      [
        { role: 'system', content: 'Be concise.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Earlier image' },
            { type: 'image_url', image_url: { url: 'test-dir/chat-attachments/first.jpg' } },
          ],
        },
        { role: 'assistant', content: 'Earlier answer' },
        { role: 'user', content: 'Continue with text only' },
      ],
      null,
      expect.any(Object),
    );
    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        media_paths: ['test-dir/chat-attachments/first.jpg'],
        messages: [
          { role: 'system', content: 'Be concise.' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Earlier image' },
              { type: 'image_url', image_url: { url: 'test-dir/chat-attachments/first.jpg' } },
            ],
          },
          { role: 'assistant', content: 'Earlier answer' },
          { role: 'user', content: 'Continue with text only' },
        ],
      }),
      expect.any(Function),
    );
    const completionParams = (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock.mock.calls.at(-1)?.[0];
    expect(completionParams.media_paths).toEqual(['test-dir/chat-attachments/first.jpg']);
  });

  it('waits for in-flight multimodal runtime initialization before sending image media paths', async () => {
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());
    let resolveInitMultimodal!: (value: boolean) => void;
    getInitMultimodalMock().mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      resolveInitMultimodal = resolve;
    }));

    const loadPromise = llmEngineService.load('test/model', { forceReload: true });
    await waitForCondition(
      () => llmEngineService.getState().status === EngineStatus.INITIALIZING,
      'engine initialization',
    );

    const completionPromise = llmEngineService.chatCompletion({
      messages: [{ role: 'user', content: 'Describe this', mediaPaths: ['test-dir/chat-attachments/image.jpg'] }],
      multimodalReadiness: {
        modelId: 'test/model',
        status: 'ready',
        projectorId: downloadedProjector.id,
        support: ['vision'],
        checkedAt: 1,
      },
      params: { n_predict: 32 },
    });

    await Promise.resolve();
    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).not.toHaveBeenCalled();

    await waitForMockCall(getInitMultimodalMock());
    resolveInitMultimodal(true);
    await loadPromise;
    await expect(completionPromise).resolves.toEqual({ text: 'Hello back' });
    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        media_paths: ['test-dir/chat-attachments/image.jpg'],
      }),
      expect.any(Function),
    );
  });

  it('keeps text inference ready and records failure when projector init fails', async () => {
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());
    getInitMultimodalMock().mockResolvedValueOnce(false);

    await llmEngineService.load('test/model');

    expect(llmEngineService.getState().status).toBe(EngineStatus.READY);
    expect(registry.updateModel).toHaveBeenCalledWith(expect.objectContaining({
      multimodalReadiness: expect.objectContaining({
        status: 'failed',
        projectorId: downloadedProjector.id,
        projectorSize: 1024,
        requestedSupport: ['vision'],
      }),
    }));
  });

  it('sanitizes multimodal runtime failure reasons before persistence', async () => {
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());
    getInitMultimodalMock().mockRejectedValueOnce(
      new Error('Native init failed for file:///private/mobile/Project for Client/mmproj file.gguf after retry'),
    );

    await llmEngineService.load('test/model');

    const persistedModel = (registry.updateModel as jest.Mock).mock.calls
      .map(([model]) => model)
      .find((model) => model?.multimodalReadiness?.status === 'failed');
    expect(persistedModel).toEqual(expect.objectContaining({
      multimodalReadiness: expect.objectContaining({
        status: 'failed',
        requestedSupport: ['vision'],
        failureReason: 'runtime:initialization_failed:path_redacted:retry',
      }),
    }));
    expect(JSON.stringify(persistedModel)).not.toContain('file:///private');
    expect(JSON.stringify(persistedModel)).not.toContain('Project for Client');
    expect(JSON.stringify(llmEngineService.getState().diagnostics?.multimodal)).not.toContain('Project for Client');
  });

  it('releases native contexts when multimodal readiness persistence fails during initialization', async () => {
    await llmEngineService.unload().catch(() => undefined);
    (llamaRn.initLlama as jest.Mock).mockClear();
    (llamaRn.releaseAllLlama as jest.Mock).mockClear();
    getInitMultimodalMock().mockClear();
    getReleaseMultimodalMock().mockClear();
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());
    const persistenceError = new Error('readiness persistence failed');
    (registry.updateModel as jest.Mock).mockImplementation((model) => {
      if (model?.multimodalReadiness) {
        throw persistenceError;
      }
    });

    await expect(llmEngineService.load('test/model')).rejects.toMatchObject({
      code: 'model_load_failed',
      message: persistenceError.message,
      cause: persistenceError,
    });

    expect(llamaRn.initLlama).toHaveBeenCalled();
    expect(getInitMultimodalMock()).toHaveBeenCalledTimes(1);
    expect(getReleaseMultimodalMock()).toHaveBeenCalledTimes(1);
    expect(llamaRn.releaseAllLlama).toHaveBeenCalledTimes(1);
    expect((llmEngineService as any).context).toBeNull();
    expect(llmEngineService.getState()).toMatchObject({
      status: EngineStatus.ERROR,
      activeModelId: undefined,
      loadProgress: 0,
      lastError: persistenceError.message,
    });
  });

  it('releases initialized multimodal projector state when unloading the context', async () => {
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());

    await llmEngineService.load('test/model');
    await llmEngineService.unload();

    expect(getReleaseMultimodalMock()).toHaveBeenCalledTimes(1);
  });

  it.each(multimodalDowngradeCases)(
    'releases initialized multimodal projector state when readiness downgrades to $label',
    async ({ createModel, expectedStatus }) => {
      (registry.getModel as jest.Mock).mockReturnValue(createReadyVisionModel());

      await llmEngineService.load('test/model');
      expect(getInitMultimodalMock()).toHaveBeenCalledTimes(1);

      getReleaseMultimodalMock().mockClear();
      getInitMultimodalMock().mockClear();
      (registry.getModel as jest.Mock).mockReturnValue(createModel());

      await llmEngineService.load('test/model');

      expect(getReleaseMultimodalMock()).toHaveBeenCalledTimes(1);
      expect(getInitMultimodalMock()).not.toHaveBeenCalled();
      expect(registry.updateModel).toHaveBeenLastCalledWith(expect.objectContaining({
        multimodalReadiness: expect.objectContaining({
          status: expectedStatus,
        }),
      }));
    },
  );

  it('does not release initialized multimodal projector state for unchanged ready same-projector reloads', async () => {
    (registry.getModel as jest.Mock).mockReturnValue(createReadyVisionModel());

    await llmEngineService.load('test/model');

    getReleaseMultimodalMock().mockClear();
    getInitMultimodalMock().mockClear();

    await llmEngineService.load('test/model');

    expect(getReleaseMultimodalMock()).not.toHaveBeenCalled();
    expect(getInitMultimodalMock()).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'missing persisted readiness',
      createReloadedModel: () => createDownloadedVisionModel(),
    },
    {
      label: 'downgraded persisted readiness',
      createReloadedModel: () => ({
        ...createDownloadedVisionModel(),
        multimodalReadiness: {
          ...createReadyMultimodalReadiness(),
          status: 'failed' as const,
          support: [],
        },
      }),
    },
  ])(
    'refreshes active same-projector multimodal readiness without reinitializing when $label',
    async ({ createReloadedModel }) => {
      (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());

      await llmEngineService.load('test/model');
      expect(getInitMultimodalMock()).toHaveBeenCalledTimes(1);
      const context = (llmEngineService as any).context;
      expect(context).toBeTruthy();

      getInitMultimodalMock().mockClear();
      getReleaseMultimodalMock().mockClear();
      getMultimodalSupportMock().mockClear();
      (registry.updateModel as jest.Mock).mockClear();
      (registry.getModel as jest.Mock).mockReturnValue(createReloadedModel());

      await llmEngineService.load('test/model');

      expect((llmEngineService as any).context).toBe(context);
      expect(getInitMultimodalMock()).not.toHaveBeenCalled();
      expect(getReleaseMultimodalMock()).not.toHaveBeenCalled();
      expect(getMultimodalSupportMock()).toHaveBeenCalledTimes(1);
      expect(registry.updateModel).toHaveBeenLastCalledWith(expect.objectContaining({
        multimodalReadiness: expect.objectContaining({
          status: 'ready',
          projectorId: downloadedProjector.id,
          support: ['vision'],
        }),
      }));
    },
  );

  it('defers same-model multimodal readiness refresh until an active completion settles', async () => {
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());

    await llmEngineService.load('test/model');
    expect(getInitMultimodalMock()).toHaveBeenCalledTimes(1);

    getInitMultimodalMock().mockClear();
    getReleaseMultimodalMock().mockClear();
    getMultimodalSupportMock().mockClear();
    (registry.updateModel as jest.Mock).mockClear();
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());

    const completionMock = (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock;
    let releaseCompletion!: () => void;
    completionMock.mockImplementationOnce(() => new Promise((resolve) => {
      releaseCompletion = () => resolve({ text: 'Done' });
    }));

    const completionPromise = llmEngineService.chatCompletion({
      messages: [{ role: 'user', content: 'Hello' }],
      params: { n_predict: 1 },
    });

    expect(llmEngineService.hasActiveCompletion()).toBe(true);
    await expect(llmEngineService.load('test/model')).resolves.toBeUndefined();

    expect(getInitMultimodalMock()).not.toHaveBeenCalled();
    expect(getReleaseMultimodalMock()).not.toHaveBeenCalled();
    expect(getMultimodalSupportMock()).not.toHaveBeenCalled();
    expect(registry.updateModel).not.toHaveBeenCalled();

    await waitForMockCall(completionMock);
    await waitForMockCall(completionMock);
    releaseCompletion();
    await completionPromise;

    await waitForMockCall(getMultimodalSupportMock());
    expect(getInitMultimodalMock()).not.toHaveBeenCalled();
    expect(getReleaseMultimodalMock()).not.toHaveBeenCalled();
    expect(registry.updateModel).toHaveBeenLastCalledWith(expect.objectContaining({
      multimodalReadiness: expect.objectContaining({
        status: 'ready',
        projectorId: downloadedProjector.id,
      }),
    }));
  });

  it('contains deferred projector reload failures when a queued refresh becomes reload-required', async () => {
    (registry.getModel as jest.Mock).mockReturnValue({
      ...createDownloadedVisionModel(),
      projectorCandidates: [],
      selectedProjectorId: undefined,
    });

    await llmEngineService.load('test/model', { forceReload: true });

    const context = (llmEngineService as any).context;
    expect(context).toBeTruthy();
    expect((llamaRn.initLlama as jest.Mock).mock.calls[0][0]).not.toHaveProperty('ctx_shift');

    (llmEngineService as any).pendingMultimodalReadinessRefresh = {
      modelId: 'test/model',
      context,
      useGpu: false,
    };
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());
    (llamaRn.initLlama as jest.Mock).mockRejectedValue(new Error('reload failed'));

    await expect((llmEngineService as any).runPendingMultimodalReadinessRefresh()).resolves.toBeUndefined();

    expect((llmEngineService as any).pendingMultimodalReadinessRefresh).toBeNull();
    expect((llamaRn.initLlama as jest.Mock).mock.calls.length).toBeGreaterThan(1);
  });

  it('requeues delayed projector reloads when a completion starts during projector resolution', async () => {
    (registry.getModel as jest.Mock).mockReturnValue({
      ...createDownloadedVisionModel(),
      projectorCandidates: [],
      selectedProjectorId: undefined,
    });

    await llmEngineService.load('test/model', { forceReload: true });

    const context = (llmEngineService as any).context;
    expect(context).toBeTruthy();
    expect((llamaRn.initLlama as jest.Mock).mock.calls[0][0]).not.toHaveProperty('ctx_shift');

    (llamaRn.initLlama as jest.Mock).mockClear();
    (llamaRn.releaseAllLlama as jest.Mock).mockClear();
    getInitMultimodalMock().mockClear();
    (registry.updateModel as jest.Mock).mockClear();
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());

    let releaseProjectorLookup!: () => void;
    let didHoldProjectorLookup = false;
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (!uri.includes('mmproj')) {
        return { exists: true, size: 1024 };
      }

      if (!didHoldProjectorLookup) {
        didHoldProjectorLookup = true;
        return new Promise((resolve) => {
          releaseProjectorLookup = () => resolve({ exists: true, size: 1024 });
        });
      }

      return { exists: true, size: 1024 };
    });

    (llmEngineService as any).pendingMultimodalReadinessRefresh = {
      modelId: 'test/model',
      context,
      useGpu: false,
    };

    const refreshPromise = (llmEngineService as any).runPendingMultimodalReadinessRefresh();
    await waitForCondition(
      () => didHoldProjectorLookup,
      'deferred projector resolution to start',
    );

    const completionMock = (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock;
    let releaseCompletion!: () => void;
    completionMock.mockImplementationOnce(() => new Promise((resolve) => {
      releaseCompletion = () => resolve({ text: 'Done' });
    }));

    const completionPromise = llmEngineService.chatCompletion({
      messages: [{ role: 'user', content: 'Hello while projector resolves' }],
      params: { n_predict: 1 },
    });
    await waitForCondition(
      () => llmEngineService.hasActiveCompletion(),
      'active completion during deferred projector resolution',
    );

    releaseProjectorLookup();
    await refreshPromise;

    expect(llamaRn.releaseAllLlama).not.toHaveBeenCalled();
    expect(llamaRn.initLlama).not.toHaveBeenCalled();
    expect(getInitMultimodalMock()).not.toHaveBeenCalled();
    expect((llmEngineService as any).pendingMultimodalReadinessRefresh).toEqual(expect.objectContaining({
      modelId: 'test/model',
      context,
    }));

    await waitForMockCall(completionMock);
    releaseCompletion();
    await completionPromise;

    await waitForCondition(
      () => (llamaRn.initLlama as jest.Mock).mock.calls
        .some(([options]: [{ ctx_shift?: boolean }]) => options?.ctx_shift === false),
      'delayed projector reload after completion',
    );
    expect(llamaRn.releaseAllLlama).toHaveBeenCalledTimes(1);
    expect(getInitMultimodalMock()).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'test-dir/models/mmproj-model.gguf',
      }),
    );
  });

  it('requeues delayed projector reloads when a completion starts after reload is selected but before unload', async () => {
    (registry.getModel as jest.Mock).mockReturnValue({
      ...createDownloadedVisionModel(),
      projectorCandidates: [],
      selectedProjectorId: undefined,
    });

    await llmEngineService.load('test/model', { forceReload: true });

    const context = (llmEngineService as any).context;
    expect(context).toBeTruthy();
    expect((llamaRn.initLlama as jest.Mock).mock.calls[0][0]).not.toHaveProperty('ctx_shift');

    (llamaRn.initLlama as jest.Mock).mockClear();
    (llamaRn.releaseAllLlama as jest.Mock).mockClear();
    getInitMultimodalMock().mockClear();
    (registry.updateModel as jest.Mock).mockClear();
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());

    const completionMock = (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock;
    let releaseCompletion: (() => void) | undefined;
    completionMock.mockImplementationOnce(() => new Promise((resolve) => {
      releaseCompletion = () => resolve({ text: 'Done' });
    }));

    const completionState: { promise: Promise<unknown> | null } = { promise: null };
    let shouldReloadCallCount = 0;
    const originalShouldReload = (llmEngineService as any)
      .shouldReloadLoadedContextForMultimodalContextShift
      .bind(llmEngineService);
    const shouldReloadSpy = jest.spyOn(
      llmEngineService as any,
      'shouldReloadLoadedContextForMultimodalContextShift',
    ).mockImplementation(async (...args: unknown[]) => {
      const shouldReload = await originalShouldReload(...args);
      shouldReloadCallCount += 1;

      if (shouldReloadCallCount === 2 && shouldReload && !completionState.promise) {
        completionState.promise = llmEngineService.chatCompletion({
          messages: [{ role: 'user', content: 'Hello before background unload' }],
          params: { n_predict: 1 },
        });
        expect(llmEngineService.hasActiveCompletion()).toBe(true);
      }

      return shouldReload;
    });

    try {
      (llmEngineService as any).pendingMultimodalReadinessRefresh = {
        modelId: 'test/model',
        context,
        useGpu: false,
      };

      await (llmEngineService as any).runPendingMultimodalReadinessRefresh();

      expect(shouldReloadCallCount).toBeGreaterThanOrEqual(2);
      expect(completionState.promise).toBeTruthy();
      expect(llamaRn.releaseAllLlama).not.toHaveBeenCalled();
      expect(llamaRn.initLlama).not.toHaveBeenCalled();
      expect(getInitMultimodalMock()).not.toHaveBeenCalled();
      expect((llmEngineService as any).pendingMultimodalReadinessRefresh).toEqual(expect.objectContaining({
        modelId: 'test/model',
        context,
      }));

      await waitForMockCall(completionMock);
      releaseCompletion?.();
      await completionState.promise;

      await waitForCondition(
        () => (llamaRn.initLlama as jest.Mock).mock.calls
          .some(([options]: [{ ctx_shift?: boolean }]) => options?.ctx_shift === false),
        'delayed projector reload after completion',
      );
      expect(llamaRn.releaseAllLlama).toHaveBeenCalledTimes(1);
      expect(getInitMultimodalMock()).toHaveBeenCalledWith(
        expect.objectContaining({
          path: 'test-dir/models/mmproj-model.gguf',
        }),
      );
    } finally {
      shouldReloadSpy.mockRestore();
      releaseCompletion?.();
      await completionState.promise?.catch(() => undefined);
    }
  });

  it('drops queued multimodal readiness refreshes when unload cancels the active completion first', async () => {
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());

    await llmEngineService.load('test/model');
    expect(getInitMultimodalMock()).toHaveBeenCalledTimes(1);

    getInitMultimodalMock().mockClear();
    getReleaseMultimodalMock().mockClear();
    getMultimodalSupportMock().mockClear();
    (registry.updateModel as jest.Mock).mockClear();
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());

    const completionMock = (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock;
    let releaseCompletion!: () => void;
    completionMock.mockImplementationOnce(() => new Promise((resolve) => {
      releaseCompletion = () => resolve({ text: 'Done' });
    }));

    const completionPromise = llmEngineService.chatCompletion({
      messages: [{ role: 'user', content: 'Hello before unload' }],
      params: { n_predict: 1 },
    });
    await waitForMockCall(completionMock);

    await expect(llmEngineService.load('test/model')).resolves.toBeUndefined();
    expect(getMultimodalSupportMock()).not.toHaveBeenCalled();
    expect(registry.updateModel).not.toHaveBeenCalled();

    const unloadPromise = llmEngineService.unload();
    await Promise.resolve();
    releaseCompletion();
    await completionPromise;
    await unloadPromise;
    await Promise.resolve();

    expect(getMultimodalSupportMock()).not.toHaveBeenCalled();
    expect(getInitMultimodalMock()).not.toHaveBeenCalled();
    expect(registry.updateModel).not.toHaveBeenCalled();
    expect(getReleaseMultimodalMock()).toHaveBeenCalledTimes(1);
    expect(getActiveMultimodalContext()).toBeNull();
    expect(llmEngineService.getState().status).toBe(EngineStatus.IDLE);
  });

  it('defers context release when active completion does not drain during unload', async () => {
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());

    await llmEngineService.load('test/model');
    expect(getActiveMultimodalContext()).not.toBeNull();

    getReleaseMultimodalMock().mockClear();
    (llamaRn.releaseAllLlama as jest.Mock).mockClear();

    const completionMock = (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock;
    let releaseCompletion!: () => void;
    completionMock.mockImplementationOnce(() => new Promise((resolve) => {
      releaseCompletion = () => resolve({ text: 'Done' });
    }));
    const completionPromise = llmEngineService.chatCompletion({
      messages: [{ role: 'user', content: 'Hello before unload' }],
      params: { n_predict: 1 },
    }).catch((error) => error);
    await waitForMockCall(completionMock);

    jest.useFakeTimers();
    try {
      const unloadPromise = llmEngineService.unload();
      for (let tick = 0; tick < 3; tick += 1) {
        await Promise.resolve();
        jest.advanceTimersByTime(5000);
      }
      await Promise.resolve();

      await expect(unloadPromise).rejects.toMatchObject({
        code: 'engine_unloading',
      });
      expect(getReleaseMultimodalMock()).not.toHaveBeenCalled();
      expect(llamaRn.releaseAllLlama).not.toHaveBeenCalled();
      expect(getActiveMultimodalContext()).not.toBeNull();
      expect(llmEngineService.hasActiveCompletion()).toBe(true);

      const completionError = await completionPromise;
      expect(completionError).toEqual(expect.objectContaining({
        code: 'engine_unloading',
      }));
    } finally {
      jest.useRealTimers();
    }

    releaseCompletion();
    await waitForCondition(
      () => (llamaRn.releaseAllLlama as jest.Mock).mock.calls.length === 1,
      'deferred releaseAllLlama after active completion drain',
    );
    expect(getReleaseMultimodalMock()).toHaveBeenCalledTimes(1);
    expect(getActiveMultimodalContext()).toBeNull();
    expect(llmEngineService.getState().status).toBe(EngineStatus.IDLE);
  });

  it('cancels context operations when an active completion times out during unload', async () => {
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());

    await llmEngineService.load('test/model');
    expect(getActiveMultimodalContext()).not.toBeNull();

    let releaseContextOperation!: () => void;
    const contextOperationPromise = (llmEngineService as any).trackContextOperation(
      async () => new Promise<void>((resolve) => {
        releaseContextOperation = resolve;
      }),
      { chatBlocking: true },
    ).catch((error: unknown) => error);
    await waitForCondition(
      () => llmEngineService.hasActiveContextOperation(),
      'active context operation before completion',
    );

    getReleaseMultimodalMock().mockClear();
    (llamaRn.releaseAllLlama as jest.Mock).mockClear();

    const completionPromise = llmEngineService.chatCompletion({
      messages: [{ role: 'user', content: 'Hello while context op is stuck' }],
      params: { n_predict: 1 },
    }).catch((error) => error);
    await waitForCondition(
      () => llmEngineService.hasActiveCompletion(),
      'active completion waiting on context operation',
    );

    jest.useFakeTimers();
    try {
      const unloadPromise = llmEngineService.unload();
      for (let tick = 0; tick < 3; tick += 1) {
        await Promise.resolve();
        jest.advanceTimersByTime(5000);
      }
      await Promise.resolve();

      await expect(unloadPromise).rejects.toMatchObject({
        code: 'engine_unloading',
      });
      expect(llmEngineService.getState()).toEqual(expect.objectContaining({
        status: EngineStatus.ERROR,
        activeModelId: 'test/model',
        lastError: 'Timed out waiting for active completion during unload',
      }));
      expect(getReleaseMultimodalMock()).not.toHaveBeenCalled();
      expect(llamaRn.releaseAllLlama).not.toHaveBeenCalled();
      expect(llmEngineService.hasActiveContextOperation()).toBe(true);

      await expect(contextOperationPromise).resolves.toMatchObject({
        code: 'engine_unloading',
      });
      await expect(completionPromise).resolves.toMatchObject({
        code: 'engine_unloading',
      });
    } finally {
      jest.useRealTimers();
    }

    releaseContextOperation();
    await waitForCondition(
      () => (llamaRn.releaseAllLlama as jest.Mock).mock.calls.length === 1,
      'deferred releaseAllLlama after context operation drain',
    );
    expect(getReleaseMultimodalMock()).toHaveBeenCalledTimes(1);
    expect(getActiveMultimodalContext()).toBeNull();
    expect(llmEngineService.hasActiveContextOperation()).toBe(false);
    expect(llmEngineService.getState().status).toBe(EngineStatus.IDLE);
  });

  it('detaches the active context when prompt preparation does not drain after stop', async () => {
    await llmEngineService.load('test/model');

    let releasePromptPreparation!: () => void;
    getFormattedChatMock().mockImplementationOnce(() => new Promise((resolve) => {
      releasePromptPreparation = () => resolve({ prompt: 'Late formatted prompt', additional_stops: [] });
    }));

    const completionPromise = llmEngineService.chatCompletion({
      messages: [{ role: 'user', content: 'Stop during prompt prep' }],
      params: { n_predict: 1 },
    }).catch((error) => error);

    await waitForCondition(
      () => llmEngineService.hasActiveChatBlockingContextOperation(),
      'chat-blocking prompt preparation',
    );

    jest.useFakeTimers();
    try {
      const interruptPromise = llmEngineService.interruptActiveCompletion();
      await Promise.resolve();
      jest.advanceTimersByTime(5000);
      await interruptPromise;
    } finally {
      jest.useRealTimers();
    }

    await expect(completionPromise).resolves.toMatchObject({
      code: 'engine_busy',
    });
    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).not.toHaveBeenCalled();
    expect(llmEngineService.hasActiveCompletion()).toBe(false);
    expect(llmEngineService.hasActiveChatBlockingContextOperation()).toBe(false);
    expect(llmEngineService.getState()).toEqual(expect.objectContaining({
      status: EngineStatus.ERROR,
      activeModelId: 'test/model',
      lastError: 'Timed out waiting for prompt preparation to stop',
    }));
    await expect(llmEngineService.chatCompletion({
      messages: [{ role: 'user', content: 'Second request after detach' }],
      params: { n_predict: 1 },
    })).rejects.toMatchObject({
      code: 'engine_not_ready',
    });
    expect(llmEngineService.hasActiveCompletion()).toBe(false);

    releasePromptPreparation();
    await Promise.resolve();
    await Promise.resolve();

    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).not.toHaveBeenCalled();
    expect(llmEngineService.hasActiveCompletion()).toBe(false);
    expect(llmEngineService.hasActiveChatBlockingContextOperation()).toBe(false);
  });

  it('detaches the active context when direct stop does not drain prompt preparation', async () => {
    await llmEngineService.load('test/model');

    let releasePromptPreparation!: () => void;
    getFormattedChatMock().mockImplementationOnce(() => new Promise((resolve) => {
      releasePromptPreparation = () => resolve({ prompt: 'Late formatted prompt', additional_stops: [] });
    }));

    const completionPromise = llmEngineService.chatCompletion({
      messages: [{ role: 'user', content: 'Direct stop during prompt prep' }],
      params: { n_predict: 1 },
    }).catch((error) => error);

    await waitForCondition(
      () => llmEngineService.hasActiveChatBlockingContextOperation(),
      'chat-blocking prompt preparation before direct stop',
    );

    jest.useFakeTimers();
    try {
      const stopPromise = llmEngineService.stopCompletion();
      await Promise.resolve();
      jest.advanceTimersByTime(5000);
      await stopPromise;
    } finally {
      jest.useRealTimers();
    }

    await expect(completionPromise).resolves.toMatchObject({
      code: 'engine_busy',
    });
    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).not.toHaveBeenCalled();
    expect(llmEngineService.hasActiveCompletion()).toBe(false);
    expect(llmEngineService.hasActiveChatBlockingContextOperation()).toBe(false);
    expect(llmEngineService.getState()).toEqual(expect.objectContaining({
      status: EngineStatus.ERROR,
      activeModelId: 'test/model',
      lastError: 'Timed out waiting for prompt preparation to stop',
    }));

    await expect(llmEngineService.load('test/model')).resolves.toBeUndefined();
    releasePromptPreparation();
    await Promise.resolve();
    await Promise.resolve();

    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).not.toHaveBeenCalled();
    expect(llmEngineService.hasActiveCompletion()).toBe(false);
    expect(llmEngineService.hasActiveChatBlockingContextOperation()).toBe(false);
    expect(llmEngineService.getState().status).toBe(EngineStatus.READY);
  });

  it('ignores active multimodal readiness refresh results after context operation cancellation', async () => {
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());

    await llmEngineService.load('test/model');
    expect(getInitMultimodalMock()).toHaveBeenCalledTimes(1);

    getMultimodalSupportMock().mockClear();
    (registry.updateModel as jest.Mock).mockClear();
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());

    const supportGate: { resolve?: () => void } = {};
    getMultimodalSupportMock().mockImplementationOnce(() => new Promise((resolve) => {
      supportGate.resolve = () => resolve({ vision: true, audio: false });
    }));

    const loadPromise = llmEngineService.load('test/model');
    try {
      await waitForMockCall(getMultimodalSupportMock());
      expect(llmEngineService.hasActiveContextOperation()).toBe(true);

      const cancelPromise = llmEngineService.cancelActiveContextOperations({ timeoutMs: 1000 });
      supportGate.resolve?.();
      supportGate.resolve = undefined;
      await cancelPromise;
      await loadPromise.catch(() => undefined);

      expect(registry.updateModel).not.toHaveBeenCalled();
    } finally {
      supportGate.resolve?.();
      await loadPromise.catch(() => undefined);
    }
  });

  it('preempts a background thinking capability probe before starting completion', async () => {
    allowThinkingCapabilityProbe();
    await llmEngineService.load('test/model');

    (registry.updateModel as jest.Mock).mockClear();
    getFormattedChatMock().mockClear();
    let releaseProbeFormat!: () => void;
    getFormattedChatMock()
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseProbeFormat = () => resolve({
          prompt: '<think>probe</think>',
          type: 'jinja',
          thinking_start_tag: '<think>',
          thinking_end_tag: '</think>',
          additional_stops: [],
        });
      }))
      .mockResolvedValue({ prompt: 'Formatted prompt', additional_stops: [] });

    (llmEngineService as any).launchThinkingCapabilityProbe('test/model');
    await waitForMockCall(getFormattedChatMock());

    expect(llmEngineService.hasActiveContextOperation()).toBe(true);
    expect(llmEngineService.hasActiveChatBlockingContextOperation()).toBe(false);

    const completionPromise = llmEngineService.chatCompletion({
      messages: [{ role: 'user', content: 'Hello while probe is active' }],
      params: { n_predict: 1 },
    });
    await waitForCondition(
      () => llmEngineService.hasActiveCompletion(),
      'active completion waiting for thinking probe preemption',
    );
    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).not.toHaveBeenCalled();

    releaseProbeFormat();
    await completionPromise;

    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).toHaveBeenCalledTimes(1);
    expect(registry.updateModel).not.toHaveBeenCalledWith(expect.objectContaining({
      thinkingCapability: expect.anything(),
    }));
    expect(llmEngineService.hasActiveContextOperation()).toBe(false);
  });

  it('releases a newly initialized projector when readiness refresh is canceled before support resolves', async () => {
    (registry.getModel as jest.Mock).mockReturnValue(createReadyVisionModel());

    await llmEngineService.load('test/model');
    expect(getInitMultimodalMock()).toHaveBeenCalledTimes(1);

    const replacementProjector: ProjectorArtifact = {
      ...downloadedProjector,
      id: 'projector-test-model-main-cancelled-mmproj-model.gguf',
      fileName: 'cancelled-mmproj-model.gguf',
      localPath: 'cancelled-mmproj-model.gguf',
    };
    getInitMultimodalMock().mockClear();
    getReleaseMultimodalMock().mockClear();
    getMultimodalSupportMock().mockClear();
    (registry.updateModel as jest.Mock).mockClear();
    (registry.getModel as jest.Mock).mockReturnValue({
      ...createReadyVisionModel(),
      projectorCandidates: [replacementProjector],
      selectedProjectorId: replacementProjector.id,
      multimodalReadiness: {
        ...createReadyMultimodalReadiness(),
        projectorId: replacementProjector.id,
      },
    });

    const supportGate: { resolve?: () => void } = {};
    getMultimodalSupportMock().mockImplementationOnce(() => new Promise((resolve) => {
      supportGate.resolve = () => resolve({ vision: true, audio: false });
    }));

    const loadPromise = llmEngineService.load('test/model');
    try {
      await waitForMockCall(getMultimodalSupportMock());
      expect(getInitMultimodalMock()).toHaveBeenCalledTimes(1);
      expect(getActiveMultimodalContext()).toEqual(expect.objectContaining({
        modelId: 'test/model',
        projectorId: replacementProjector.id,
      }));

      const cancelPromise = llmEngineService.cancelActiveContextOperations({ timeoutMs: 1000 });
      supportGate.resolve?.();
      supportGate.resolve = undefined;
      await cancelPromise;
      await loadPromise.catch(() => undefined);

      expect(getReleaseMultimodalMock()).toHaveBeenCalledTimes(2);
      expect(getActiveMultimodalContext()).toBeNull();
      expect(registry.updateModel).not.toHaveBeenCalled();
    } finally {
      supportGate.resolve?.();
      await loadPromise.catch(() => undefined);
    }
  });

  it('clears a newly initialized projector identity when the llama context changes before init resolves', async () => {
    await llmEngineService.unload().catch(() => undefined);
    (registry.getModel as jest.Mock).mockReturnValue(createReadyVisionModel());
    getInitMultimodalMock().mockClear();
    getReleaseMultimodalMock().mockClear();
    getMultimodalSupportMock().mockClear();
    (registry.updateModel as jest.Mock).mockClear();

    let didResolveInit = false;
    let resolveInit: ((didInitialize: boolean) => void) | undefined;
    getInitMultimodalMock().mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      resolveInit = (didInitialize) => {
        didResolveInit = true;
        resolve(didInitialize);
      };
    }));

    const loadPromise = llmEngineService.load('test/model');
    try {
      await waitForMockCall(getInitMultimodalMock());
      expect(getActiveMultimodalContext()).toBeNull();

      (llmEngineService as any).setContext({ __testReplacementContext: true });
      resolveInit?.(true);
      await loadPromise;

      expect(getActiveMultimodalContext()).toBeNull();
      expect(getMultimodalSupportMock()).not.toHaveBeenCalled();
      expect(getReleaseMultimodalMock()).not.toHaveBeenCalled();
    } finally {
      if (!didResolveInit) {
        resolveInit?.(true);
      }
      await loadPromise.catch(() => undefined);
      await llmEngineService.unload().catch(() => undefined);
    }
  });

  it('preempts active same-model multimodal readiness refreshes and retries them after completion', async () => {
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());

    await llmEngineService.load('test/model');
    expect(getInitMultimodalMock()).toHaveBeenCalledTimes(1);

    getMultimodalSupportMock().mockClear();
    (registry.updateModel as jest.Mock).mockClear();
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());

    const supportGate: { resolve?: () => void } = {};
    getMultimodalSupportMock().mockImplementationOnce(() => new Promise((resolve) => {
      supportGate.resolve = () => resolve({ vision: true, audio: false });
    }));

    const loadPromise = llmEngineService.load('test/model');
    try {
      await waitForMockCall(getMultimodalSupportMock());
      expect(llmEngineService.hasActiveContextOperation()).toBe(true);

      const completionMock = (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock;
      completionMock.mockClear();
      const completionPromise = llmEngineService.chatCompletion({
        messages: [{ role: 'user', content: 'Hello while refreshing' }],
        params: { n_predict: 1 },
      });

      await Promise.resolve();
      expect(completionMock).not.toHaveBeenCalled();

      supportGate.resolve?.();
      supportGate.resolve = undefined;
      await loadPromise;
      await completionPromise;

      expect(completionMock).toHaveBeenCalledTimes(1);
      await waitForMockCall(registry.updateModel as jest.Mock);
      expect(registry.updateModel).toHaveBeenLastCalledWith(expect.objectContaining({
        multimodalReadiness: expect.objectContaining({
          status: 'ready',
          projectorId: downloadedProjector.id,
        }),
      }));
    } finally {
      supportGate.resolve?.();
      await loadPromise.catch(() => undefined);
    }
  });

  it('requeues deferred same-model multimodal readiness refreshes preempted by a later completion', async () => {
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());

    await llmEngineService.load('test/model');
    expect(getInitMultimodalMock()).toHaveBeenCalledTimes(1);

    getMultimodalSupportMock().mockClear();
    (registry.updateModel as jest.Mock).mockClear();
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());

    const completionMock = (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock;
    completionMock.mockClear();

    let releaseFirstCompletion!: () => void;
    completionMock.mockImplementationOnce(() => new Promise((resolve) => {
      releaseFirstCompletion = () => resolve({ text: 'First done' });
    }));

    const firstCompletionPromise = llmEngineService.chatCompletion({
      messages: [{ role: 'user', content: 'First request' }],
      params: { n_predict: 1 },
    });
    await waitForMockCall(completionMock);

    await expect(llmEngineService.load('test/model')).resolves.toBeUndefined();
    expect(getMultimodalSupportMock()).not.toHaveBeenCalled();

    const supportGate: { resolve?: () => void } = {};
    getMultimodalSupportMock().mockImplementationOnce(() => new Promise((resolve) => {
      supportGate.resolve = () => resolve({ vision: true, audio: false });
    }));

    releaseFirstCompletion();
    await firstCompletionPromise;
    await waitForMockCall(getMultimodalSupportMock());
    expect(llmEngineService.hasActiveContextOperation()).toBe(true);

    let releaseSecondCompletion: (() => void) | undefined;
    completionMock.mockImplementationOnce(() => new Promise((resolve) => {
      releaseSecondCompletion = () => resolve({ text: 'Second done' });
    }));

    const secondCompletionPromise = llmEngineService.chatCompletion({
      messages: [{ role: 'user', content: 'Second request' }],
      params: { n_predict: 1 },
    });

    try {
      await Promise.resolve();
      expect(completionMock).toHaveBeenCalledTimes(1);

      supportGate.resolve?.();
      supportGate.resolve = undefined;
      await waitForMockCall(completionMock, 2);
      expect(registry.updateModel).not.toHaveBeenCalled();

      releaseSecondCompletion?.();
      releaseSecondCompletion = undefined;
      await secondCompletionPromise;

      await waitForMockCall(getMultimodalSupportMock(), 2);
      expect(registry.updateModel).toHaveBeenLastCalledWith(expect.objectContaining({
        multimodalReadiness: expect.objectContaining({
          status: 'ready',
          projectorId: downloadedProjector.id,
        }),
      }));
    } finally {
      supportGate.resolve?.();
      releaseSecondCompletion?.();
      await secondCompletionPromise.catch(() => undefined);
    }
  });

  it('reinitializes same-id projectors when the resolved local artifact changes', async () => {
    (registry.getModel as jest.Mock).mockReturnValue(createReadyVisionModel());

    await llmEngineService.load('test/model');
    getReleaseMultimodalMock().mockClear();
    getInitMultimodalMock().mockClear();

    const replacedProjector: ProjectorArtifact = {
      ...downloadedProjector,
      localPath: 'fresh-mmproj-model.gguf',
      fileName: 'fresh-mmproj-model.gguf',
    };
    (registry.getModel as jest.Mock).mockReturnValue({
      ...createReadyVisionModel(),
      projectorCandidates: [replacedProjector],
      selectedProjectorId: replacedProjector.id,
      multimodalReadiness: {
        ...createReadyMultimodalReadiness(),
        projectorId: replacedProjector.id,
      },
    });

    await llmEngineService.load('test/model');

    expect(getReleaseMultimodalMock()).toHaveBeenCalledTimes(1);
    expect(getInitMultimodalMock()).toHaveBeenCalledTimes(1);
    expect((llmEngineService as any).activeMultimodalContext).toEqual(expect.objectContaining({
      modelId: 'test/model',
      projectorId: replacedProjector.id,
      projectorLocalPath: 'fresh-mmproj-model.gguf',
    }));
  });

  it('reinitializes same active projector when stable artifact metadata changes without mtime', async () => {
    const originalProjector: ProjectorArtifact = {
      ...downloadedProjector,
      hfRevision: 'revision-a',
      sha256: 'sha256-a',
    };
    (registry.getModel as jest.Mock).mockReturnValue({
      ...createReadyVisionModel(),
      projectorCandidates: [originalProjector],
      selectedProjectorId: originalProjector.id,
      multimodalReadiness: {
        ...createReadyMultimodalReadiness(),
        projectorId: originalProjector.id,
      },
    });

    await llmEngineService.load('test/model');
    const originalActiveMultimodalContext = getActiveMultimodalContext();
    expect(originalActiveMultimodalContext).toEqual(expect.objectContaining({
      modelId: 'test/model',
      projectorId: originalProjector.id,
      projectorLocalPath: downloadedProjector.localPath,
      projectorResolvedPath: 'test-dir/models/mmproj-model.gguf',
      projectorSizeBytes: 1024,
      projectorModificationTime: null,
      projectorFallbackMarker: expect.any(String),
      projectorFileName: downloadedProjector.fileName,
      projectorHfRevision: 'revision-a',
      projectorSha256: 'sha256-a',
    }));

    getReleaseMultimodalMock().mockClear();
    getInitMultimodalMock().mockClear();
    (registry.updateModel as jest.Mock).mockClear();

    const updatedProjector: ProjectorArtifact = {
      ...originalProjector,
      fileName: 'renamed-mmproj-model.gguf',
      downloadUrl: 'https://huggingface.co/test/model/resolve/revision-b/renamed-mmproj-model.gguf',
      hfRevision: 'revision-b',
      sha256: 'sha256-b',
    };
    (registry.getModel as jest.Mock).mockReturnValue({
      ...createReadyVisionModel(),
      projectorCandidates: [updatedProjector],
      selectedProjectorId: updatedProjector.id,
      multimodalReadiness: {
        ...createReadyMultimodalReadiness(),
        projectorId: updatedProjector.id,
      },
    });

    await llmEngineService.load('test/model');

    expect(getReleaseMultimodalMock()).toHaveBeenCalledTimes(1);
    expect(getInitMultimodalMock()).toHaveBeenCalledTimes(1);
    expect(registry.updateModel).toHaveBeenLastCalledWith(expect.objectContaining({
      multimodalReadiness: expect.objectContaining({
        status: 'ready',
        projectorId: updatedProjector.id,
      }),
    }));
    const updatedActiveMultimodalContext = getActiveMultimodalContext();
    expect(updatedActiveMultimodalContext).toEqual(expect.objectContaining({
      modelId: 'test/model',
      projectorId: updatedProjector.id,
      projectorLocalPath: downloadedProjector.localPath,
      projectorResolvedPath: 'test-dir/models/mmproj-model.gguf',
      projectorSizeBytes: 1024,
      projectorModificationTime: null,
      projectorFallbackMarker: expect.any(String),
      projectorFileName: 'renamed-mmproj-model.gguf',
      projectorDownloadUrl: updatedProjector.downloadUrl,
      projectorHfRevision: 'revision-b',
      projectorSha256: 'sha256-b',
    }));
    expect(updatedActiveMultimodalContext?.projectorFallbackMarker)
      .not.toBe(originalActiveMultimodalContext?.projectorFallbackMarker);
  });

  it('marks multimodal runtime unavailable while native release is pending', async () => {
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());

    await llmEngineService.load('test/model');
    const context = (llmEngineService as any).context;
    expect((llmEngineService as any).activeMultimodalContext).toEqual(expect.objectContaining({
      modelId: 'test/model',
      projectorId: downloadedProjector.id,
    }));

    let resolveRelease!: () => void;
    getReleaseMultimodalMock().mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveRelease = resolve;
    }));

    const releasePromise = (llmEngineService as any).releaseActiveMultimodalContext({
      modelId: 'test/model',
      context,
    });

    await waitForMockCall(getReleaseMultimodalMock());
    expect((llmEngineService as any).activeMultimodalContext).toBeNull();

    resolveRelease();
    await expect(releasePromise).resolves.toBe(true);
    expect((llmEngineService as any).activeMultimodalContext).toBeNull();
  });

  it('releases initialized multimodal projector state when projector file resolution fails', async () => {
    (registry.getModel as jest.Mock).mockReturnValue(createReadyVisionModel());

    await llmEngineService.load('test/model');
    const context = (llmEngineService as any).context;
    expect(context).toBeTruthy();

    getReleaseMultimodalMock().mockClear();
    getInitMultimodalMock().mockClear();
    const replacementProjector: ProjectorArtifact = {
      ...downloadedProjector,
      id: 'projector-test-model-main-replacement-mmproj-model.gguf',
      fileName: 'replacement-mmproj-model.gguf',
      localPath: 'replacement-mmproj-model.gguf',
    };
    (llmEngineService as any).activeMultimodalContext = {
      modelId: 'test/model',
      projectorId: downloadedProjector.id,
      projectorLocalPath: downloadedProjector.localPath,
    };
    (registry.getModel as jest.Mock).mockReturnValue({
      ...createDownloadedVisionModel(),
      projectorCandidates: [replacementProjector],
      selectedProjectorId: replacementProjector.id,
      multimodalReadiness: {
        ...createReadyMultimodalReadiness(),
        status: 'missing_projector' as const,
      },
    });
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: false, size: 0 });

    await (llmEngineService as any).initializeMultimodalReadinessForLoadedContext({
      modelId: 'test/model',
      context,
      useGpu: false,
    });

    expect(getReleaseMultimodalMock()).toHaveBeenCalledTimes(1);
    expect(getInitMultimodalMock()).not.toHaveBeenCalled();
    expect(registry.updateModel).toHaveBeenLastCalledWith(expect.objectContaining({
      multimodalReadiness: expect.objectContaining({
        status: 'failed',
        projectorId: replacementProjector.id,
      }),
    }));
  });

  it('keeps active multimodal JS state when native release fails with a live context', async () => {
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());

    await llmEngineService.load('test/model');
    const context = (llmEngineService as any).context;
    const activeMultimodalContext = (llmEngineService as any).activeMultimodalContext;
    expect(context).toBeTruthy();
    expect(activeMultimodalContext).toEqual(expect.objectContaining({
      modelId: 'test/model',
      projectorId: downloadedProjector.id,
    }));

    getReleaseMultimodalMock().mockRejectedValueOnce(new Error('native release failed'));

    await expect((llmEngineService as any).releaseActiveMultimodalContext({
      modelId: 'test/model',
      context,
    })).resolves.toBe(false);

    expect(getReleaseMultimodalMock()).toHaveBeenCalledTimes(1);
    expect((llmEngineService as any).activeMultimodalContext).toBe(activeMultimodalContext);

    await llmEngineService.unload();
  });

  it('clears active multimodal JS state without native release when no context is loaded', async () => {
    (llmEngineService as any).setContext(null);
    (llmEngineService as any).activeMultimodalContext = {
      modelId: 'test/model',
      projectorId: downloadedProjector.id,
      projectorLocalPath: downloadedProjector.localPath,
    };

    await expect((llmEngineService as any).releaseActiveMultimodalContext()).resolves.toBe(true);

    expect(getReleaseMultimodalMock()).not.toHaveBeenCalled();
    expect((llmEngineService as any).activeMultimodalContext).toBeNull();

    await llmEngineService.unload().catch(() => undefined);
  });

  it('omits projector and native error paths from multimodal release warning logs', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const projectorLocalPath = 'Projector Files/mmproj model.gguf';
    const fileUriPath = 'file:///storage/emulated/0/Download/mmproj.gguf';
    const androidDataPath = '/data/user/0/com.pocketai/files/models/mmproj.gguf';
    const projectorWithSpacedPath: ProjectorArtifact = {
      ...downloadedProjector,
      localPath: projectorLocalPath,
    };
    (registry.getModel as jest.Mock).mockReturnValue({
      ...createDownloadedVisionModel(),
      projectorCandidates: [projectorWithSpacedPath],
      selectedProjectorId: projectorWithSpacedPath.id,
    });
    getReleaseMultimodalMock().mockRejectedValueOnce(
      new Error(`release failed for ${fileUriPath} and ${androidDataPath}`),
    );
    (process.env as any).NODE_ENV = 'production';

    try {
      await llmEngineService.load('test/model');
      await llmEngineService.unload();
    } finally {
      (process.env as any).NODE_ENV = previousNodeEnv;
    }

    const releaseWarning = consoleWarnSpy.mock.calls.find(
      ([message]) => message === '[LLMEngine] Failed to release multimodal context',
    );
    expect(releaseWarning).toBeDefined();
    expect(releaseWarning?.[1]).toEqual(expect.objectContaining({
      modelId: 'test/model',
      projectorId: downloadedProjector.id,
      error: 'release failed for [path] and [path]',
    }));
    expect(releaseWarning?.[1]).toEqual(expect.not.objectContaining({
      projectorLocalPath: expect.anything(),
    }));
    expect(JSON.stringify(releaseWarning?.[1])).not.toContain(projectorLocalPath);
    expect(JSON.stringify(releaseWarning?.[1])).not.toContain(fileUriPath);
    expect(JSON.stringify(releaseWarning?.[1])).not.toContain(androidDataPath);
    expect(JSON.stringify(releaseWarning?.[1])).not.toContain('file:///storage');
    expect(JSON.stringify(releaseWarning?.[1])).not.toContain('/data/user');
  });

  it('rejects image media paths when multimodal readiness is not ready', async () => {
    await llmEngineService.load('test/model');

    await expect(llmEngineService.chatCompletion({
      messages: [{ role: 'user', content: 'Describe this', mediaPaths: ['test-dir/chat-attachments/image.jpg'] }],
      multimodalReadiness: {
        modelId: 'test/model',
        status: 'text_only',
        support: [],
        checkedAt: 1,
      },
      params: { n_predict: 32 },
    })).rejects.toMatchObject({
      code: 'multimodal_not_ready',
    });

    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).not.toHaveBeenCalled();
  });

  it('rejects structured audio content parts when runtime audio readiness is missing', async () => {
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());

    await llmEngineService.load('test/model');

    await expect(llmEngineService.chatCompletion({
      messages: [{
        role: 'user',
        content: 'Transcribe this',
        contentParts: [
          { type: 'input_audio', input_audio: { format: 'wav', url: 'file:///document/audio.wav' } },
        ],
      }],
      multimodalReadiness: {
        modelId: 'test/model',
        status: 'ready',
        projectorId: downloadedProjector.id,
        support: ['vision'],
        checkedAt: 1,
      },
      params: { n_predict: 32 },
    })).rejects.toMatchObject({
      code: 'multimodal_not_ready',
      details: expect.objectContaining({
        audioInputCount: 1,
      }),
    });

    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).not.toHaveBeenCalled();
  });

  it('forwards structured audio content parts when runtime audio readiness is available', async () => {
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());
    getMultimodalSupportMock().mockResolvedValue({ vision: true, audio: true });

    await llmEngineService.load('test/model');

    await llmEngineService.chatCompletion({
      messages: [{
        role: 'user',
        content: 'Transcribe this',
        contentParts: [
          { type: 'input_audio', input_audio: { format: 'wav', url: 'file:///document/audio.wav' } },
        ],
      }],
      multimodalReadiness: {
        modelId: 'test/model',
        status: 'ready',
        projectorId: downloadedProjector.id,
        support: ['audio'],
        checkedAt: 1,
      },
      params: { n_predict: 32 },
    });

    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Transcribe this' },
            { type: 'input_audio', input_audio: { format: 'wav', url: 'file:///document/audio.wav' } },
          ],
        }],
      }),
      expect.any(Function),
    );
  });

  it('rejects requests with more than the supported image attachment limit before native completion', async () => {
    await llmEngineService.load('test/model');

    await expect(llmEngineService.chatCompletion({
      messages: [{
        role: 'user',
        content: 'Compare these images',
        mediaPaths: [
          'test-dir/chat-attachments/image-1.jpg',
          'test-dir/chat-attachments/image-2.jpg',
          'test-dir/chat-attachments/image-3.jpg',
          'test-dir/chat-attachments/image-4.jpg',
          'test-dir/chat-attachments/image-5.jpg',
        ],
      }],
      multimodalReadiness: {
        modelId: 'test/model',
        status: 'ready',
        support: ['vision'],
        checkedAt: 1,
      },
      params: { n_predict: 32 },
    })).rejects.toMatchObject({
      code: 'chat_attachment_limit_exceeded',
      details: expect.objectContaining({
        mediaPathCount: 5,
        limit: 4,
      }),
    });

    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).not.toHaveBeenCalled();
    expect(llmEngineService.getState().diagnostics?.multimodal).toEqual(expect.objectContaining({
      attachmentCount: 5,
    }));
  });

  it('counts duplicate media path occurrences before de-duping native media paths for the image limit', async () => {
    await llmEngineService.load('test/model');

    await expect(llmEngineService.chatCompletion({
      messages: [
        { role: 'user', content: 'First copy', mediaPaths: ['test-dir/chat-attachments/same.jpg'] },
        { role: 'assistant', content: 'Earlier answer' },
        { role: 'user', content: 'Second copy', mediaPaths: ['test-dir/chat-attachments/same.jpg'] },
        { role: 'assistant', content: 'Second answer' },
        { role: 'user', content: 'Third copy', mediaPaths: ['test-dir/chat-attachments/same.jpg'] },
        { role: 'assistant', content: 'Third answer' },
        { role: 'user', content: 'Fourth copy', mediaPaths: ['test-dir/chat-attachments/same.jpg'] },
        { role: 'assistant', content: 'Fourth answer' },
        { role: 'user', content: 'Fifth copy', mediaPaths: ['test-dir/chat-attachments/same.jpg'] },
      ],
      multimodalReadiness: {
        modelId: 'test/model',
        status: 'ready',
        support: ['vision'],
        checkedAt: 1,
      },
      params: { n_predict: 32 },
    })).rejects.toMatchObject({
      code: 'chat_attachment_limit_exceeded',
      details: expect.objectContaining({
        mediaPathCount: 5,
        limit: 4,
      }),
    });

    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).not.toHaveBeenCalled();
  });

  it('counts duplicate media path occurrences within one message before native de-dupe', async () => {
    await llmEngineService.load('test/model');

    await expect(llmEngineService.chatCompletion({
      messages: [{
        role: 'user',
        content: 'Compare these repeated images',
        mediaPaths: [
          'test-dir/chat-attachments/same.jpg',
          'test-dir/chat-attachments/same.jpg',
          'test-dir/chat-attachments/same.jpg',
          'test-dir/chat-attachments/same.jpg',
          'test-dir/chat-attachments/same.jpg',
        ],
      }],
      multimodalReadiness: {
        modelId: 'test/model',
        status: 'ready',
        support: ['vision'],
        checkedAt: 1,
      },
      params: { n_predict: 32 },
    })).rejects.toMatchObject({
      code: 'chat_attachment_limit_exceeded',
      details: expect.objectContaining({
        mediaPathCount: 5,
        limit: 4,
      }),
    });

    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).not.toHaveBeenCalled();
    expect(llmEngineService.getState().diagnostics?.multimodal).toEqual(expect.objectContaining({
      attachmentCount: 5,
    }));
  });

  it('counts duplicate top-level-only mediaPaths before native de-dupe for the image limit', async () => {
    await llmEngineService.load('test/model');

    await expect(llmEngineService.chatCompletion({
      messages: [{ role: 'user', content: 'Compare these repeated top-level images' }],
      mediaPaths: [
        'test-dir/chat-attachments/top-level-same.jpg',
        'test-dir/chat-attachments/top-level-same.jpg',
        'test-dir/chat-attachments/top-level-same.jpg',
        'test-dir/chat-attachments/top-level-same.jpg',
        'test-dir/chat-attachments/top-level-same.jpg',
      ],
      multimodalReadiness: {
        modelId: 'test/model',
        status: 'ready',
        support: ['vision'],
        checkedAt: 1,
      },
      params: { n_predict: 32 },
    })).rejects.toMatchObject({
      code: 'chat_attachment_limit_exceeded',
      details: expect.objectContaining({
        mediaPathCount: 5,
        limit: 4,
      }),
    });

    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).not.toHaveBeenCalled();
    expect(llmEngineService.getState().diagnostics?.multimodal).toEqual(expect.objectContaining({
      attachmentCount: 5,
    }));
  });

  it('counts distinct explicit and attachment media paths together for the image limit', async () => {
    await llmEngineService.load('test/model');

    await expect(llmEngineService.chatCompletion({
      messages: [{
        role: 'user',
        content: 'Compare explicit and attached images',
        mediaPaths: [
          'test-dir/chat-attachments/explicit-1.jpg',
          'test-dir/chat-attachments/explicit-2.jpg',
          'test-dir/chat-attachments/explicit-3.jpg',
        ],
        attachments: [
          createTestImageAttachment('attachment-1', 'test-dir/chat-attachments/attachment-1.jpg'),
          createTestImageAttachment('attachment-2', 'test-dir/chat-attachments/attachment-2.jpg'),
        ],
      }],
      multimodalReadiness: {
        modelId: 'test/model',
        status: 'ready',
        support: ['vision'],
        checkedAt: 1,
      },
      params: { n_predict: 32 },
    })).rejects.toMatchObject({
      code: 'chat_attachment_limit_exceeded',
      details: expect.objectContaining({
        mediaPathCount: 5,
        limit: 4,
      }),
    });

    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).not.toHaveBeenCalled();
    expect(llmEngineService.getState().diagnostics?.multimodal).toEqual(expect.objectContaining({
      attachmentCount: 5,
    }));
  });

  it('does not double-count mirrored explicit and attachment media paths', async () => {
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());

    await llmEngineService.load('test/model');

    await llmEngineService.chatCompletion({
      messages: [{
        role: 'user',
        content: 'Describe this mirrored image',
        mediaPaths: ['test-dir/chat-attachments/mirrored.jpg'],
        attachments: [
          createTestImageAttachment('mirrored', 'test-dir/chat-attachments/mirrored.jpg'),
        ],
      }],
      multimodalReadiness: {
        modelId: 'test/model',
        status: 'ready',
        projectorId: downloadedProjector.id,
        support: ['vision'],
        checkedAt: 1,
      },
      params: { n_predict: 32 },
    });

    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        media_paths: ['test-dir/chat-attachments/mirrored.jpg'],
      }),
      expect.any(Function),
    );
    expect(llmEngineService.getState().diagnostics?.multimodal).toEqual(expect.objectContaining({
      attachmentCount: 1,
    }));
  });

  it('does not double-count mirrored top-level media paths for limits or diagnostics', async () => {
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());

    await llmEngineService.load('test/model');

    await llmEngineService.chatCompletion({
      messages: [{
        role: 'user',
        content: 'Compare these mirrored images',
        mediaPaths: [
          'test-dir/chat-attachments/image-1.jpg',
          'test-dir/chat-attachments/image-2.jpg',
          'test-dir/chat-attachments/image-3.jpg',
          'test-dir/chat-attachments/image-4.jpg',
        ],
      }],
      mediaPaths: [
        'test-dir/chat-attachments/image-1.jpg',
        'test-dir/chat-attachments/image-2.jpg',
        'test-dir/chat-attachments/image-3.jpg',
        'test-dir/chat-attachments/image-4.jpg',
      ],
      multimodalReadiness: {
        modelId: 'test/model',
        status: 'ready',
        projectorId: downloadedProjector.id,
        support: ['vision'],
        checkedAt: 1,
      },
      params: { n_predict: 32 },
    });

    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        media_paths: [
          'test-dir/chat-attachments/image-1.jpg',
          'test-dir/chat-attachments/image-2.jpg',
          'test-dir/chat-attachments/image-3.jpg',
          'test-dir/chat-attachments/image-4.jpg',
        ],
      }),
      expect.any(Function),
    );
    expect(llmEngineService.getState().diagnostics?.multimodal).toEqual(expect.objectContaining({
      attachmentCount: 4,
    }));
  });

  it('records raw media occurrence count in runtime-not-ready diagnostics', async () => {
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());
    await llmEngineService.load('test/model');
    (llmEngineService as any).activeMultimodalContext = null;

    await expect(llmEngineService.chatCompletion({
      messages: [{
        role: 'user',
        content: 'Describe this repeated image',
        mediaPaths: [
          'test-dir/chat-attachments/same.jpg',
          'test-dir/chat-attachments/same.jpg',
          'test-dir/chat-attachments/same.jpg',
        ],
      }],
      multimodalReadiness: {
        modelId: 'test/model',
        status: 'ready',
        projectorId: downloadedProjector.id,
        support: ['vision'],
        checkedAt: 1,
      },
      params: { n_predict: 32 },
    })).rejects.toMatchObject({
      code: 'multimodal_not_ready',
      details: expect.objectContaining({
        mediaPathCount: 3,
      }),
    });

    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).not.toHaveBeenCalled();
    expect(llmEngineService.getState().diagnostics?.multimodal).toEqual(expect.objectContaining({
      readinessStatus: 'ready',
      attachmentCount: 3,
    }));
  });

  it('does not report ready audio-only multimodal diagnostics as vision-capable', () => {
    expect(buildMultimodalDiagnosticsSummary({
      readiness: {
        modelId: 'test/model',
        status: 'ready',
        projectorId: downloadedProjector.id,
        support: ['audio'],
        requestedSupport: ['audio'],
        checkedAt: 1,
      },
      attachmentCount: 1,
      attachmentTotalBytes: 4096,
    })).toEqual(expect.objectContaining({
      visionCapability: 'unknown',
      projectorPresence: 'downloaded',
      projectorPathCategory: 'models',
      readinessStatus: 'ready',
      attachmentCount: 1,
      attachmentTotalBytes: 4096,
    }));
  });

  it('does not report partial mixed audio readiness as vision-capable', () => {
    expect(buildMultimodalDiagnosticsSummary({
      readiness: {
        modelId: 'test/model',
        status: 'ready',
        projectorId: downloadedProjector.id,
        support: ['audio'],
        requestedSupport: ['vision', 'audio'],
        checkedAt: 1,
      },
      attachmentCount: 1,
      attachmentTotalBytes: 4096,
    })).toEqual(expect.objectContaining({
      visionCapability: 'unknown',
      projectorPresence: 'downloaded',
      projectorPathCategory: 'models',
      readinessStatus: 'ready',
      attachmentCount: 1,
      attachmentTotalBytes: 4096,
    }));
  });

  it('does not report unsupported audio-only readiness as vision unsupported', () => {
    expect(buildMultimodalDiagnosticsSummary({
      readiness: {
        modelId: 'test/model',
        status: 'unsupported',
        projectorId: downloadedProjector.id,
        projectorSize: downloadedProjector.size ?? undefined,
        support: [],
        requestedSupport: ['audio'],
        checkedAt: 1,
      },
      attachmentCount: 0,
    })).toEqual(expect.objectContaining({
      visionCapability: 'unknown',
      projectorPresence: 'downloaded',
      projectorPathCategory: 'models',
      projectorSize: downloadedProjector.size,
      readinessStatus: 'unsupported',
      attachmentCount: 0,
    }));

    expect(buildMultimodalDiagnosticsSummary({
      readiness: {
        modelId: 'test/model',
        status: 'unsupported',
        projectorSize: downloadedProjector.size ?? undefined,
        support: [],
        requestedSupport: ['audio'],
        checkedAt: 1,
      },
      attachmentCount: 0,
    })).toEqual(expect.objectContaining({
      visionCapability: 'unknown',
      projectorPresence: 'downloaded',
      projectorPathCategory: 'models',
      projectorSize: downloadedProjector.size,
      readinessStatus: 'unsupported',
    }));
  });

  it('keeps mixed vision and audio unsupported readiness reported as vision unsupported', () => {
    expect(buildMultimodalDiagnosticsSummary({
      readiness: {
        modelId: 'test/model',
        status: 'unsupported',
        projectorId: downloadedProjector.id,
        projectorSize: downloadedProjector.size ?? undefined,
        support: [],
        requestedSupport: ['vision', 'audio'],
        checkedAt: 1,
      },
      attachmentCount: 0,
    })).toEqual(expect.objectContaining({
      visionCapability: 'unsupported',
      projectorPresence: 'downloaded',
      projectorPathCategory: 'models',
      projectorSize: downloadedProjector.size,
      readinessStatus: 'unsupported',
    }));
  });

  it('preserves legacy unsupported diagnostics when requested support is absent', () => {
    expect(buildMultimodalDiagnosticsSummary({
      readiness: {
        modelId: 'test/model',
        status: 'unsupported',
        support: [],
        checkedAt: 1,
      },
      attachmentCount: 0,
    })).toEqual(expect.objectContaining({
      visionCapability: 'unsupported',
      projectorPresence: 'missing',
      projectorPathCategory: 'missing',
      readinessStatus: 'unsupported',
    }));
  });

  it('records sanitized multimodal diagnostics when readiness blocks image send', async () => {
    await llmEngineService.load('test/model');
    const failureReason = [
      'Projector failed at file:///private/mobile/Project Files/mmproj file.gguf',
      'and C:\\Users\\tester\\Model Files\\mmproj file.gguf;',
      'then /private/mobile/Model Files/mmproj file.gguf',
      'with content://media/external/images/My Photo.jpg',
      'and ph://ABC DEF after retry',
    ].join(' ');

    await expect(llmEngineService.chatCompletion({
      messages: [{
        role: 'user',
        content: 'Describe this',
        attachments: [{
          id: 'attachment-1',
          threadId: 'thread-1',
          messageId: 'message-1',
          localUri: 'test-dir/chat-attachments/attachment-1.jpg',
          pathCategory: 'chat_attachment',
          fileName: 'attachment-1.jpg',
          mediaType: 'image/jpeg',
          size: 4096,
          source: 'photo_library',
          createdAt: 1,
        }],
      }],
      multimodalReadiness: {
        modelId: 'test/model',
        status: 'failed',
        projectorId: 'projector-1',
        projectorSize: 24_000_000,
        support: ['vision'],
        failureReason,
        checkedAt: 1,
      },
      params: { n_predict: 32 },
    })).rejects.toMatchObject({
      code: 'multimodal_not_ready',
    });

    const multimodalDiagnostics = llmEngineService.getState().diagnostics?.multimodal;
    expect(multimodalDiagnostics).toEqual(expect.objectContaining({
      visionCapability: 'vision_capable',
      projectorPresence: 'failed',
      projectorPathCategory: 'models',
      projectorSize: 24_000_000,
      readinessStatus: 'failed',
      attachmentCount: 1,
      attachmentTotalBytes: 4096,
      failureReason: 'multimodal:projector_unavailable:path_redacted:retry',
    }));
    expect(JSON.stringify(multimodalDiagnostics)).not.toContain('file:///private');
    expect(JSON.stringify(multimodalDiagnostics)).not.toContain('Project Files');
    expect(JSON.stringify(multimodalDiagnostics)).not.toContain('C:\\Users\\tester');
    expect(JSON.stringify(multimodalDiagnostics)).not.toContain('Model Files');
    expect(JSON.stringify(multimodalDiagnostics)).not.toContain('/private/mobile');
    expect(JSON.stringify(multimodalDiagnostics)).not.toContain('content://media');
    expect(JSON.stringify(multimodalDiagnostics)).not.toContain('ph://ABC');
    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).not.toHaveBeenCalled();
  });

  it('stores only coarse multimodal diagnostics when native media completion errors include prompt text', async () => {
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());
    await llmEngineService.load('test/model');

    const privatePromptText = 'Describe Project Orchid acquisition photos';
    (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock.mockRejectedValueOnce(
      new Error(`Native completion failed while processing prompt "${privatePromptText}" at file:///private/mobile/image.jpg`),
    );

    await expect(llmEngineService.chatCompletion({
      messages: [{
        role: 'user',
        content: privatePromptText,
        mediaPaths: ['test-dir/chat-attachments/image.jpg'],
        attachments: [createTestImageAttachment('attachment-private', 'test-dir/chat-attachments/image.jpg', 8192)],
      }],
      multimodalReadiness: createReadyMultimodalReadiness(),
      params: { n_predict: 32 },
    })).rejects.toThrow('Native completion failed');

    const multimodalDiagnostics = llmEngineService.getState().diagnostics?.multimodal;
    expect(multimodalDiagnostics).toEqual(expect.objectContaining({
      readinessStatus: 'ready',
      attachmentCount: 1,
      attachmentTotalBytes: 8192,
      failureReason: 'runtime:completion_failed:path_redacted',
    }));
    expect(JSON.stringify(multimodalDiagnostics)).not.toContain(privatePromptText);
    expect(JSON.stringify(multimodalDiagnostics)).not.toContain('file:///private/mobile/image.jpg');
    expect(JSON.stringify(multimodalDiagnostics)).not.toContain('test-dir/chat-attachments/image.jpg');
  });

  it('passes formatted media paths into prompt tokenization', async () => {
    getFormattedChatMock().mockResolvedValueOnce({
      prompt: 'Formatted prompt',
      has_media: true,
      media_paths: ['test-dir/chat-attachments/image.jpg'],
      additional_stops: [],
    });
    await llmEngineService.load('test/model');

    await llmEngineService.countPromptTokens({
      messages: [{ role: 'user', content: 'Describe this', mediaPaths: ['test-dir/chat-attachments/image.jpg'] }],
      multimodalReadiness: createReadyMultimodalReadiness(),
      expectedModelId: 'test/model',
    });

    expect(getTokenizeMock()).toHaveBeenCalledWith(
      'Formatted prompt',
      { media_paths: ['test-dir/chat-attachments/image.jpg'] },
    );
  });

  it('falls back to all retained message media paths for prompt tokenization', async () => {
    getFormattedChatMock().mockResolvedValueOnce({
      prompt: 'Formatted prompt',
      additional_stops: [],
    });
    await llmEngineService.load('test/model');

    await llmEngineService.countPromptTokens({
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Earlier image', mediaPaths: ['test-dir/chat-attachments/first.jpg'] },
        { role: 'assistant', content: 'Earlier answer' },
        { role: 'user', content: 'Latest image', mediaPaths: ['test-dir/chat-attachments/latest.jpg'] },
      ],
      multimodalReadiness: createReadyMultimodalReadiness(),
      expectedModelId: 'test/model',
    });

    expect(getTokenizeMock()).toHaveBeenCalledWith(
      'Formatted prompt',
      { media_paths: ['test-dir/chat-attachments/first.jpg', 'test-dir/chat-attachments/latest.jpg'] },
    );
  });

  it('strips media paths from prompt tokenization only when media fallback is explicit', async () => {
    getFormattedChatMock().mockResolvedValueOnce({
      prompt: 'Formatted prompt',
      has_media: true,
        media_paths: ['test-dir/chat-attachments/image.jpg'],
      additional_stops: [],
    });
    await llmEngineService.load('test/model');

    await llmEngineService.countPromptTokens({
      messages: [{ role: 'user', content: 'Describe this', mediaPaths: ['test-dir/chat-attachments/image.jpg'] }],
      allowMediaFallback: true,
    });

    expect(getFormattedChatMock()).toHaveBeenCalledWith(
      [{ role: 'user', content: 'Describe this' }],
      null,
      expect.any(Object),
    );
    expect(getTokenizeMock()).toHaveBeenCalledWith('Formatted prompt', undefined);
  });

  it('preserves text content parts when prompt tokenization strips media inputs', async () => {
    getFormattedChatMock().mockResolvedValueOnce({
      prompt: 'Formatted document prompt',
      has_media: false,
      additional_stops: [],
    });
    await llmEngineService.load('test/model');

    await llmEngineService.countPromptTokens({
      messages: [{
        role: 'user',
        content: '',
        contentParts: [
          { type: 'text', text: 'Document attachment text\n\nImportant notes' },
        ],
      }],
      allowMediaFallback: true,
    });

    expect(getFormattedChatMock()).toHaveBeenCalledWith(
      [{
        role: 'user',
        content: [
          { type: 'text', text: 'Document attachment text\n\nImportant notes' },
        ],
      }],
      null,
      expect.any(Object),
    );
    expect(getTokenizeMock()).toHaveBeenCalledWith('Formatted document prompt', undefined);
  });

  it('rejects prompt tokenization with media when multimodal readiness is not ready by default', async () => {
    await llmEngineService.load('test/model');

    await expect(llmEngineService.countPromptTokens({
      messages: [{ role: 'user', content: 'Describe this', mediaPaths: ['test-dir/chat-attachments/image.jpg'] }],
    })).rejects.toMatchObject({
      code: 'multimodal_not_ready',
    });

    expect(getFormattedChatMock()).not.toHaveBeenCalled();
    expect(getTokenizeMock()).not.toHaveBeenCalled();
  });

  it('rejects prompt tokenization when media attachments exceed the chat limit even with fallback enabled', async () => {
    await llmEngineService.load('test/model');

    await expect(llmEngineService.countPromptTokens({
      messages: [{
        role: 'user',
        content: 'Describe these',
        mediaPaths: [
          'test-dir/chat-attachments/1.jpg',
          'test-dir/chat-attachments/2.jpg',
          'test-dir/chat-attachments/3.jpg',
          'test-dir/chat-attachments/4.jpg',
          'test-dir/chat-attachments/5.jpg',
        ],
      }],
      multimodalReadiness: createReadyMultimodalReadiness(),
      expectedModelId: 'test/model',
      allowMediaFallback: true,
    })).rejects.toMatchObject({
      code: 'chat_attachment_limit_exceeded',
    });

    expect(getFormattedChatMock()).not.toHaveBeenCalled();
    expect(getTokenizeMock()).not.toHaveBeenCalled();
  });

  it('forwards template-specific additional stop tokens to llama.rn completion', async () => {
    getFormattedChatMock().mockResolvedValueOnce({
      prompt: 'Formatted prompt',
      additional_stops: ['  <|custom_stop|>  ', '</s>', 42],
    });

    await llmEngineService.load('test/model');

    await llmEngineService.chatCompletion({
      messages: [{ role: 'user', content: 'Hello' }],
      params: { n_predict: 32 },
    });

    expect(getFormattedChatMock()).toHaveBeenCalledWith(
      [{ role: 'user', content: 'Hello' }],
      null,
      expect.objectContaining({
        enable_thinking: false,
        reasoning_format: 'none',
        add_generation_prompt: true,
      }),
    );
    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stop: expect.arrayContaining(['</s>', '<|custom_stop|>']),
      }),
      expect.any(Function),
    );
  });

  it('logs sanitized metadata when template stop formatting fails', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    (process.env as any).NODE_ENV = 'development';
    const sensitiveFormatterError = new Error(
      'formatter failed for prompt "secret prompt" at /document/private-image.jpg',
    );
    sensitiveFormatterError.name = 'FormatterError';
    getFormattedChatMock().mockRejectedValueOnce(sensitiveFormatterError);

    try {
      await llmEngineService.load('test/model');

      await llmEngineService.chatCompletion({
        messages: [{ role: 'user', content: 'Hello' }],
        params: { n_predict: 32 },
      });
    } finally {
      (process.env as any).NODE_ENV = previousNodeEnv;
    }

    const formatterWarning = consoleWarnSpy.mock.calls.find(
      (call) => call[0] === '[LLMEngine] Failed to resolve template stop tokens',
    );
    expect(formatterWarning).toEqual([
      '[LLMEngine] Failed to resolve template stop tokens',
      {
        errorType: 'FormatterError',
        hasMessage: true,
      },
    ]);
    expect(formatterWarning?.some((arg: unknown) => arg instanceof Error)).toBe(false);
    expect(JSON.stringify(formatterWarning)).not.toContain('secret prompt');
    expect(JSON.stringify(formatterWarning)).not.toContain('/document/private-image.jpg');
  });

  it('reuses cached template additional stop tokens for the same loaded context, messages, and options', async () => {
    getFormattedChatMock().mockResolvedValue({
      prompt: 'Formatted prompt',
      additional_stops: ['<|cached_stop|>'],
    });

    await llmEngineService.load('test/model', { forceReload: true });

    await llmEngineService.chatCompletion({
      messages: [{ role: 'user', content: 'Hello' }],
      params: { n_predict: 32 },
    });
    await llmEngineService.chatCompletion({
      messages: [{ role: 'user', content: 'Hello' }],
      params: { n_predict: 32 },
    });

    expect(getFormattedChatMock()).toHaveBeenCalledTimes(1);
    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stop: expect.arrayContaining(['<|cached_stop|>']),
      }),
      expect.any(Function),
    );
  });

  it('resolves template additional stops again for a different message payload', async () => {
    getFormattedChatMock()
      .mockResolvedValueOnce({
        prompt: 'Formatted prompt',
        additional_stops: ['<|first_payload_stop|>'],
      })
      .mockResolvedValueOnce({
        prompt: 'Formatted prompt',
        additional_stops: ['<|second_payload_stop|>'],
      });

    await llmEngineService.load('test/model', { forceReload: true });

    await llmEngineService.chatCompletion({
      messages: [{ role: 'user', content: 'Hello' }],
      params: { n_predict: 32 },
    });
    await llmEngineService.chatCompletion({
      messages: [{ role: 'user', content: 'Hello again' }],
      params: { n_predict: 32 },
    });

    expect(getFormattedChatMock()).toHaveBeenCalledTimes(2);
    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stop: expect.arrayContaining(['<|second_payload_stop|>']),
      }),
      expect.any(Function),
    );
  });

  it('resolves template additional stops again when same-length message text changes', async () => {
    getFormattedChatMock()
      .mockResolvedValueOnce({
        prompt: 'First formatted prompt',
        additional_stops: ['<|first_same_length_stop|>'],
      })
      .mockResolvedValueOnce({
        prompt: 'Second formatted prompt',
        additional_stops: ['<|second_same_length_stop|>'],
      });

    await llmEngineService.load('test/model', { forceReload: true });

    await llmEngineService.chatCompletion({
      messages: [{ role: 'user', content: 'Hello' }],
      params: { n_predict: 32 },
    });
    await llmEngineService.chatCompletion({
      messages: [{ role: 'user', content: 'Jello' }],
      params: { n_predict: 32 },
    });

    expect(getFormattedChatMock()).toHaveBeenCalledTimes(2);
    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stop: expect.arrayContaining(['<|second_same_length_stop|>']),
      }),
      expect.any(Function),
    );
  });

  it('uses template stops without global fallback for jinja templates with explicit stops', async () => {
    performanceMonitor.setEnabled(true);
    getFormattedChatMock().mockResolvedValueOnce({
      type: 'jinja',
      prompt: '<|user|>\nHello\n<|assistant|>',
      additional_stops: ['  <|jinja_stop|>  '],
    });

    await llmEngineService.load('test/model', { forceReload: true });

    await llmEngineService.chatCompletion({
      messages: [{ role: 'user', content: 'Hello' }],
      params: { n_predict: 32 },
    });

    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stop: ['<|jinja_stop|>'],
      }),
      expect.any(Function),
    );
    const stopEvent = performanceMonitor
      .snapshot()
      .events
      .find((event) => event.name === 'llm.stopWords.resolved');
    expect(stopEvent?.meta).toEqual(expect.objectContaining({
      source: 'template',
      templateType: 'jinja',
      templateStopCount: 1,
      fallbackStopCount: 0,
      resolvedStops: ['<|jinja_stop|>'],
    }));
  });

  it('invalidates cached template additional stops after unload and reload', async () => {
    getFormattedChatMock()
      .mockResolvedValueOnce({
        prompt: 'Formatted prompt',
        additional_stops: ['<|first_stop|>'],
      })
      .mockResolvedValueOnce({
        prompt: 'Formatted prompt',
        additional_stops: ['<|second_stop|>'],
      });

    await llmEngineService.load('test/model', { forceReload: true });
    await llmEngineService.chatCompletion({
      messages: [{ role: 'user', content: 'Hello' }],
      params: { n_predict: 32 },
    });

    await llmEngineService.unload();
    await llmEngineService.load('test/model', { forceReload: true });
    await llmEngineService.chatCompletion({
      messages: [{ role: 'user', content: 'Hello again' }],
      params: { n_predict: 32 },
    });

    expect(getFormattedChatMock()).toHaveBeenCalledTimes(2);
    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stop: expect.arrayContaining(['<|second_stop|>']),
      }),
      expect.any(Function),
    );
  });

  it('blocks another completion while the first request is still resolving template stops', async () => {
    let resolveFormatted!: () => void;
    getFormattedChatMock().mockImplementationOnce(() => new Promise((resolve) => {
      resolveFormatted = () => resolve({ prompt: 'Formatted prompt', additional_stops: [] });
    }));

    await llmEngineService.load('test/model', { forceReload: true });

    const completionPromise = llmEngineService.chatCompletion({
      messages: [{ role: 'user', content: 'Hello' }],
      params: { n_predict: 16 },
    });

    await waitForMockCall(getFormattedChatMock());
    expect(getFormattedChatMock()).toHaveBeenCalledTimes(1);

    await expect(llmEngineService.chatCompletion({
      messages: [{ role: 'user', content: 'Second request' }],
      params: { n_predict: 16 },
    })).rejects.toMatchObject({ code: 'engine_busy' });

    resolveFormatted();
    await expect(completionPromise).resolves.toEqual({ text: 'Hello back' });
  });

  it('aborts completion before native generation when the context changes after formatting', async () => {
    await llmEngineService.load('test/model', { forceReload: true });

    const originalContext = (llmEngineService as any).context;
    const replacementCompletion = jest.fn().mockResolvedValue({ text: 'replacement' });
    const replacementContext = {
      ...originalContext,
      completion: replacementCompletion,
    };
    getFormattedChatMock().mockImplementationOnce(async () => {
      (llmEngineService as any).setContext(replacementContext);
      return { prompt: 'Formatted prompt', additional_stops: [] };
    });

    await expect(llmEngineService.chatCompletion({
      messages: [{ role: 'user', content: 'Hello' }],
      params: { n_predict: 16 },
    })).rejects.toMatchObject({ code: 'engine_not_ready' });

    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).not.toHaveBeenCalled();
    expect(replacementCompletion).not.toHaveBeenCalled();

    await llmEngineService.unload();
  });

  it('clears thinking_budget_tokens when thinking is disabled', async () => {
    await llmEngineService.load('test/model');

    await llmEngineService.chatCompletion({
      messages: [{ role: 'user', content: 'Hello' }],
      params: {
        enable_thinking: true,
        reasoning_format: 'auto',
        thinking_budget_tokens: 128,
        n_predict: 32,
      },
    });

    await llmEngineService.chatCompletion({
      messages: [{ role: 'user', content: 'Hello again' }],
      params: {
        enable_thinking: false,
        reasoning_format: 'none',
        n_predict: 32,
      },
    });

    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enable_thinking: false,
        reasoning_format: 'none',
        thinking_budget_tokens: -1,
      }),
      expect.any(Function),
    );
  });

  it('clears thinking_budget_tokens when thinking is enabled but no budget is provided', async () => {
    await llmEngineService.load('test/model');

    await llmEngineService.chatCompletion({
      messages: [{ role: 'user', content: 'Hello' }],
      params: {
        enable_thinking: true,
        reasoning_format: 'auto',
        thinking_budget_tokens: 128,
        n_predict: 32,
      },
    });

    await llmEngineService.chatCompletion({
      messages: [{ role: 'user', content: 'Hello again' }],
      params: {
        enable_thinking: true,
        reasoning_format: 'auto',
        n_predict: 32,
      },
    });

    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enable_thinking: true,
        reasoning_format: 'auto',
        thinking_budget_tokens: -1,
      }),
      expect.any(Function),
    );
  });

  it('persists thinking capability snapshot during load when probe succeeds', async () => {
    const previousEnv = process.env.NODE_ENV;
    (process.env as any).NODE_ENV = 'development';
    allowThinkingCapabilityProbe();

    try {
      getFormattedChatMock().mockImplementation(async (_messages, _tools, formattingOptions) => {
        const enableThinking = formattingOptions?.enable_thinking === true;

        return enableThinking
          ? {
            prompt: 'Formatted prompt',
            thinking_start_tag: '<|channel>thought',
            thinking_end_tag: '<channel|>',
          }
          : {
            prompt: 'Formatted prompt',
            thinking_forced_open: true,
          };
      });

      await llmEngineService.load('test/model', { forceReload: true });
      await waitForCondition(
        () => (registry.updateModel as jest.Mock).mock.calls.some(([model]) => model.thinkingCapability),
        'thinking capability probe persistence',
      );

      expect(getFormattedChatMock()).toHaveBeenCalledWith(
        expect.anything(),
        null,
        expect.objectContaining({
          jinja: true,
          enable_thinking: true,
          reasoning_format: 'auto',
        }),
      );
      expect(getFormattedChatMock()).toHaveBeenCalledWith(
        expect.anything(),
        null,
        expect.objectContaining({
          jinja: true,
          enable_thinking: false,
          reasoning_format: 'none',
        }),
      );

      expect(registry.updateModel).toHaveBeenCalledWith(expect.objectContaining({
        id: 'test/model',
        thinkingCapability: expect.objectContaining({
          detectedAt: expect.any(Number),
          supportsThinking: true,
          canDisableThinking: false,
          thinkingStartTag: '<|channel>thought',
          thinkingEndTag: '<channel|>',
        }),
      }));
    } finally {
      (process.env as any).NODE_ENV = previousEnv;
    }
  });

  it('persists thinking capability snapshot when thinking tags are only present in the formatted prompt', async () => {
    const previousEnv = process.env.NODE_ENV;
    (process.env as any).NODE_ENV = 'development';
    allowThinkingCapabilityProbe();

    try {
      getFormattedChatMock().mockImplementation(async (_messages, _tools, formattingOptions) => {
        const enableThinking = formattingOptions?.enable_thinking === true;

        return enableThinking
          ? {
            type: 'jinja',
            prompt: 'Formatted prompt\n<think>\nReasoning...\n</think>\nAnswer:',
          }
          : {
            type: 'jinja',
            prompt: 'Formatted prompt\nAnswer:',
          };
      });

      await llmEngineService.load('test/model', { forceReload: true });
      await waitForCondition(
        () => (registry.updateModel as jest.Mock).mock.calls.some(([model]) => model.thinkingCapability),
        'thinking capability probe persistence',
      );

      expect(registry.updateModel).toHaveBeenCalledWith(expect.objectContaining({
        id: 'test/model',
        thinkingCapability: expect.objectContaining({
          detectedAt: expect.any(Number),
          supportsThinking: true,
          canDisableThinking: true,
          thinkingStartTag: '<think>',
          thinkingEndTag: '</think>',
        }),
      }));
    } finally {
      (process.env as any).NODE_ENV = previousEnv;
    }
  });

  it('waits for a tracked thinking capability probe before starting chat completion', async () => {
    const previousEnv = process.env.NODE_ENV;
    (process.env as any).NODE_ENV = 'development';
    allowThinkingCapabilityProbe();

    const completionMock = (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock;
    let resolveProbeFormat!: () => void;
    let resolveNativeCompletion!: () => void;
    let probeFormatCalls = 0;

    try {
      completionMock.mockImplementationOnce(() => new Promise((resolve) => {
        resolveNativeCompletion = () => resolve({ text: 'Hello back' });
      }));

      getFormattedChatMock().mockImplementation((_messages, _tools, formattingOptions) => {
        if (formattingOptions?.jinja === true) {
          probeFormatCalls += 1;

          if (probeFormatCalls === 1) {
            return new Promise((resolve) => {
              resolveProbeFormat = () => resolve({
                type: 'jinja',
                prompt: 'Formatted prompt <think>reasoning</think>',
                thinking_start_tag: '<think>',
                thinking_end_tag: '</think>',
              });
            });
          }

          return Promise.resolve({
            type: 'jinja',
            prompt: 'Formatted prompt',
            thinking_forced_open: false,
          });
        }

        return Promise.resolve({ prompt: 'Completion prompt', additional_stops: [] });
      });

      await llmEngineService.load('test/model', { forceReload: true });
      for (let i = 0; i < 5 && probeFormatCalls === 0; i += 1) {
        await Promise.resolve();
      }
      expect(probeFormatCalls).toBe(1);

      const completionPromise = llmEngineService.chatCompletion({
        messages: [{ role: 'user', content: 'Hello' }],
        params: { n_predict: 16 },
      });

      await Promise.resolve();
      expect(completionMock).not.toHaveBeenCalled();
      expect(probeFormatCalls).toBe(1);

      expect(registry.updateModel).not.toHaveBeenCalledWith(expect.objectContaining({
        thinkingCapability: expect.anything(),
      }));

      resolveProbeFormat();
      await Promise.resolve();
      await waitForMockCall(completionMock);

      resolveNativeCompletion();
      await expect(completionPromise).resolves.toEqual({ text: 'Hello back' });
      await llmEngineService.unload();
    } finally {
      (process.env as any).NODE_ENV = previousEnv;
    }
  });

  it('preempts a background thinking capability probe before counting prompt tokens', async () => {
    const previousEnv = process.env.NODE_ENV;
    (process.env as any).NODE_ENV = 'development';
    allowThinkingCapabilityProbe();

    const tokenizeMock = (llamaRn as unknown as { __tokenizeMock: jest.Mock }).__tokenizeMock;
    let resolveProbeFormat!: () => void;
    let probeFormatCalls = 0;

    try {
      tokenizeMock.mockResolvedValueOnce({ tokens: [1, 2, 3, 4] });
      getFormattedChatMock().mockImplementation((_messages, _tools, formattingOptions) => {
        if (formattingOptions?.jinja === true) {
          probeFormatCalls += 1;

          if (probeFormatCalls === 1) {
            return new Promise((resolve) => {
              resolveProbeFormat = () => resolve({
                type: 'jinja',
                prompt: 'Formatted prompt <think>reasoning</think>',
                thinking_start_tag: '<think>',
                thinking_end_tag: '</think>',
              });
            });
          }

          return Promise.resolve({
            type: 'jinja',
            prompt: 'Formatted prompt',
            thinking_forced_open: false,
          });
        }

        return Promise.resolve({ prompt: 'Count prompt', additional_stops: [] });
      });

      await llmEngineService.load('test/model', { forceReload: true });
      for (let i = 0; i < 5 && probeFormatCalls === 0; i += 1) {
        await Promise.resolve();
      }
      expect(probeFormatCalls).toBe(1);

      const countPromise = llmEngineService.countPromptTokens({
        messages: [{ role: 'user', content: 'Hello' }],
      });

      await Promise.resolve();
      expect(tokenizeMock).not.toHaveBeenCalled();
      expect(probeFormatCalls).toBe(1);

      expect(registry.updateModel).not.toHaveBeenCalledWith(expect.objectContaining({
        thinkingCapability: expect.anything(),
      }));

      resolveProbeFormat();
      await expect(countPromise).resolves.toBe(4);
      expect(tokenizeMock).toHaveBeenCalled();
      expect(probeFormatCalls).toBe(1);
      expect(registry.updateModel).not.toHaveBeenCalledWith(expect.objectContaining({
        thinkingCapability: expect.anything(),
      }));
      await llmEngineService.unload();
    } finally {
      (process.env as any).NODE_ENV = previousEnv;
    }
  });

  it('keeps passive prompt token counts queued behind background thinking probes', async () => {
    const previousEnv = process.env.NODE_ENV;
    (process.env as any).NODE_ENV = 'development';
    allowThinkingCapabilityProbe();

    const tokenizeMock = (llamaRn as unknown as { __tokenizeMock: jest.Mock }).__tokenizeMock;
    let resolveProbeFormat!: () => void;
    let probeFormatCalls = 0;

    try {
      tokenizeMock.mockResolvedValueOnce({ tokens: [1, 2, 3] });
      getFormattedChatMock().mockImplementation((_messages, _tools, formattingOptions) => {
        if (formattingOptions?.jinja === true) {
          probeFormatCalls += 1;

          if (probeFormatCalls === 1) {
            return new Promise((resolve) => {
              resolveProbeFormat = () => resolve({
                type: 'jinja',
                prompt: 'Formatted prompt <think>reasoning</think>',
                thinking_start_tag: '<think>',
                thinking_end_tag: '</think>',
              });
            });
          }

          return Promise.resolve({
            type: 'jinja',
            prompt: 'Formatted prompt',
            thinking_forced_open: false,
          });
        }

        return Promise.resolve({ prompt: 'Passive count prompt', additional_stops: [] });
      });

      await llmEngineService.load('test/model', { forceReload: true });
      for (let i = 0; i < 5 && probeFormatCalls === 0; i += 1) {
        await Promise.resolve();
      }
      expect(probeFormatCalls).toBe(1);

      const countPromise = llmEngineService.countPromptTokens({
        messages: [{ role: 'user', content: 'Hello' }],
        chatBlocking: false,
      });

      await Promise.resolve();
      expect(tokenizeMock).not.toHaveBeenCalled();

      resolveProbeFormat();
      await expect(countPromise).resolves.toBe(3);
      expect(probeFormatCalls).toBe(2);
      expect(registry.updateModel).toHaveBeenCalledWith(expect.objectContaining({
        thinkingCapability: expect.objectContaining({
          supportsThinking: true,
        }),
      }));
      await llmEngineService.unload();
    } finally {
      (process.env as any).NODE_ENV = previousEnv;
    }
  });

  it('blocks prompt token counting while a completion is in flight', async () => {
    await llmEngineService.load('test/model');

    const completionMock = (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock;
    let releaseCompletion!: () => void;
    completionMock.mockImplementationOnce(() => new Promise((resolve) => {
      releaseCompletion = () => resolve({ text: 'Done' });
    }));

    const completionPromise = llmEngineService.chatCompletion({
      messages: [{ role: 'user', content: 'Hello' }],
      params: { n_predict: 1 },
    });

    await waitForMockCall(completionMock);

    await expect(
      llmEngineService.countPromptTokens({ messages: [{ role: 'user', content: 'Hello' }] }),
    ).rejects.toMatchObject({ code: 'engine_busy' });

    releaseCompletion();
    await completionPromise;
  });

  it('passes frozen thread params through to completion even when they differ from defaults', async () => {
    await llmEngineService.load('test/model');

    await llmEngineService.chatCompletion({
      messages: [
        { role: 'system', content: 'Frozen system prompt.' },
        { role: 'user', content: 'Use thread snapshot params.' },
        { role: 'assistant', content: 'Prior answer.' },
      ],
      params: {
        temperature: 1.1,
        top_p: 0.55,
        n_predict: 333,
      },
    });

    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: [
          { role: 'system', content: 'Frozen system prompt.' },
          { role: 'user', content: 'Use thread snapshot params.' },
          { role: 'assistant', content: 'Prior answer.' },
        ],
        temperature: 1.1,
        top_p: 0.55,
        n_predict: 333,
      }),
      expect.any(Function),
    );
  });

  it('retries strict alternation failures with normalized chat history', async () => {
    const completionMock = (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock;
    getFormattedChatMock().mockResolvedValue({
      type: 'llama-chat',
      prompt: '[INST] <<SYS>>\nBe concise.\n<</SYS>>\n\nHello [/INST]',
      additional_stops: [],
    });
    completionMock
      .mockRejectedValueOnce(new Error('Conversation roles must alternate user/assistant'))
      .mockResolvedValueOnce({ text: 'Recovered reply' });

    await llmEngineService.load('test/model', { forceReload: true });

    await expect(llmEngineService.chatCompletion({
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'system', content: 'Conversation summary:\nEarlier context.' },
        { role: 'assistant', content: 'Leading assistant draft.' },
        { role: 'user', content: 'First user question.' },
        { role: 'assistant', content: 'First assistant reply.' },
        { role: 'assistant', content: 'Extra assistant details.' },
        { role: 'user', content: 'Latest user question.' },
      ],
      params: {
        temperature: 0.25,
        n_predict: 64,
      },
    })).resolves.toEqual({ text: 'Recovered reply' });

    expect(completionMock).toHaveBeenCalledTimes(2);
    expect(completionMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messages: [
          {
            role: 'user',
            content: '<<SYS>>\nBe concise.\n\nConversation summary:\nEarlier context.\n<</SYS>>\n\nFirst user question.',
          },
          {
            role: 'assistant',
            content: 'First assistant reply.\n\nExtra assistant details.',
          },
          {
            role: 'user',
            content: 'Latest user question.',
          },
        ],
        temperature: 0.25,
        n_predict: 64,
      }),
      expect.any(Function),
    );
  });

  it('retries strict alternation without Llama system wrappers for non-Llama templates', async () => {
    const completionMock = (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock;
    getFormattedChatMock().mockResolvedValue({
      type: 'jinja',
      prompt: '<|system|>\nBe concise. Literal <<SYS>> marker <</SYS>>.\n<|user|>\nHello',
      additional_stops: [],
    });
    completionMock
      .mockRejectedValueOnce(new Error('Conversation roles must alternate user/assistant'))
      .mockResolvedValueOnce({ text: 'Recovered reply' });

    await llmEngineService.load('test/model', { forceReload: true });

    await expect(llmEngineService.chatCompletion({
      messages: [
        { role: 'system', content: 'Be concise. Literal <<SYS>> marker <</SYS>>.' },
        { role: 'assistant', content: 'Leading assistant draft.' },
        { role: 'user', content: 'First user question.' },
        { role: 'assistant', content: 'First assistant reply.' },
        { role: 'assistant', content: 'Extra assistant details.' },
      ],
      params: {
        temperature: 0.25,
        n_predict: 64,
      },
    })).resolves.toEqual({ text: 'Recovered reply' });

    expect(completionMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messages: [
          {
            role: 'user',
            content: 'Be concise. Literal <<SYS>> marker <</SYS>>.\n\nFirst user question.',
          },
          {
            role: 'assistant',
            content: 'First assistant reply.\n\nExtra assistant details.',
          },
        ],
      }),
      expect.any(Function),
    );
  });

  it('preserves document text content parts when retrying strict alternation normalization', async () => {
    const completionMock = (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock;
    getFormattedChatMock().mockResolvedValue({
      type: 'jinja',
      prompt: '<|user|>\nHello',
      additional_stops: [],
    });
    completionMock
      .mockRejectedValueOnce(new Error('Conversation roles must alternate user/assistant'))
      .mockResolvedValueOnce({ text: 'Recovered reply' });

    await llmEngineService.load('test/model', { forceReload: true });

    await expect(llmEngineService.chatCompletion({
      messages: [
        { role: 'user', content: 'Previous question.' },
        {
          role: 'user',
          content: '',
          contentParts: [
            { type: 'text', text: 'Document attachment text\n\nImportant notes' },
          ],
        },
      ],
      params: { n_predict: 64 },
    })).resolves.toEqual({ text: 'Recovered reply' });

    expect(completionMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            role: 'user',
            content: expect.arrayContaining([
              { type: 'text', text: 'Previous question.\n\n' },
              { type: 'text', text: 'Document attachment text\n\nImportant notes' },
            ]),
          }),
        ],
      }),
      expect.any(Function),
    );
  });

  it('falls back to Llama system wrapping for legacy formatted payloads without type metadata', async () => {
    const completionMock = (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock;
    getFormattedChatMock().mockResolvedValue({
      prompt: '[INST] <<SYS>>\nBe concise.\n<</SYS>>\n\nHello [/INST]',
      additional_stops: [],
    });
    completionMock
      .mockRejectedValueOnce(new Error('Conversation roles must alternate user/assistant'))
      .mockResolvedValueOnce({ text: 'Recovered reply' });

    await llmEngineService.load('test/model', { forceReload: true });

    await expect(llmEngineService.chatCompletion({
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'First user question.' },
      ],
      params: { n_predict: 64 },
    })).resolves.toEqual({ text: 'Recovered reply' });

    expect(completionMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messages: [
          {
            role: 'user',
            content: '<<SYS>>\nBe concise.\n<</SYS>>\n\nFirst user question.',
          },
        ],
      }),
      expect.any(Function),
    );
  });

  it('loads the model with saved context and gpu preferences', async () => {
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 12,
      kvCacheType: 'f16',
    });

    await llmEngineService.load('test/model', { forceReload: true });

    expect(llamaRn.initLlama).toHaveBeenCalledWith(
      expect.objectContaining({
        n_ctx: 4096,
        n_gpu_layers: 12,
      }),
      expect.any(Function),
    );
    expect(llmEngineService.getContextSize()).toBe(4096);
    expect(llmEngineService.getLoadedGpuLayers()).toBe(12);
  });

  it('keeps llama.rn context shifting at the default for text-only model loads', async () => {
    await llmEngineService.load('test/model', { forceReload: true });

    expect(llamaRn.initLlama).toHaveBeenCalledTimes(1);
    expect((llamaRn.initLlama as jest.Mock).mock.calls[0][0]).not.toHaveProperty('ctx_shift');
  });

  it('keeps llama.rn context shifting at the default for vision-capable text-only loads without a ready projector', async () => {
    (registry.getModel as jest.Mock).mockReturnValue({
      ...createDownloadedVisionModel(),
      projectorCandidates: [],
      selectedProjectorId: undefined,
    });

    await llmEngineService.load('test/model', { forceReload: true });

    expect(llamaRn.initLlama).toHaveBeenCalledTimes(1);
    expect((llamaRn.initLlama as jest.Mock).mock.calls[0][0]).not.toHaveProperty('ctx_shift');
  });

  it('disables llama.rn context shifting when a vision projector is resolvable at load time', async () => {
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());

    await llmEngineService.load('test/model', { forceReload: true });

    expect(llamaRn.initLlama).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx_shift: false,
      }),
      expect.any(Function),
    );
  });

  it('caps multimodal projector image tokens while setting safe batch params', async () => {
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());

    await llmEngineService.load('test/model', { forceReload: true });

    expect(llamaRn.initLlama).toHaveBeenCalledWith(
      expect.objectContaining({
        n_batch: 512,
        n_ubatch: 512,
        ctx_shift: false,
      }),
      expect.any(Function),
    );
    expect(getInitMultimodalMock()).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'test-dir/models/mmproj-model.gguf',
        image_max_tokens: 512,
      }),
    );
    expect(getInitMultimodalMock().mock.calls[0][0]).not.toHaveProperty('image_min_tokens');
  });

  it('raises unsafe custom micro-batch settings to match the multimodal decode batch size', async () => {
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 2048,
      gpuLayers: null,
      kvCacheType: 'auto',
      nBatch: 128,
      nUbatch: 64,
    });

    await llmEngineService.load('test/model', { forceReload: true });

    expect(llamaRn.initLlama).toHaveBeenCalledWith(
      expect.objectContaining({
        n_batch: 128,
        n_ubatch: 128,
        ctx_shift: false,
      }),
      expect.any(Function),
    );
    expect(getInitMultimodalMock()).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'test-dir/models/mmproj-model.gguf',
        image_max_tokens: 512,
      }),
    );
    expect(getInitMultimodalMock().mock.calls[0][0]).not.toHaveProperty('image_min_tokens');
  });

  it('keeps low-memory multimodal batch profiles safe for non-causal image decode', () => {
    expect((llmEngineService as any).resolveMultimodalSafeBatchParams({
      configuredBatchParams: { nBatch: 256, nUbatch: 128 },
      hasLoadTimeMmproj: true,
      contextTokens: 4096,
    })).toEqual({ nBatch: 256, nUbatch: 256 });
  });

  it('blocks image completion before native media decode when the active multimodal batch profile is unsafe', async () => {
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());

    await llmEngineService.load('test/model', { forceReload: true });
    (llmEngineService as any).initNBatch = 256;
    (llmEngineService as any).initNUbatch = 128;

    await expect(llmEngineService.chatCompletion({
      messages: [{
        role: 'user',
        content: 'Describe this',
        mediaPaths: ['test-dir/chat-attachments/image.jpg'],
      }],
      multimodalReadiness: createReadyMultimodalReadiness(),
      params: { n_predict: 16 },
    })).rejects.toMatchObject({
      code: 'multimodal_not_ready',
    });

    expect((llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock).not.toHaveBeenCalled();
    const unsupportedReadinessUpdate = (registry.updateModel as jest.Mock).mock.calls
      .map(([model]) => model)
      .find((model: { multimodalReadiness?: { status?: string } }) => model.multimodalReadiness?.status === 'unsupported');
    expect(unsupportedReadinessUpdate?.multimodalReadiness).toEqual(expect.objectContaining({
      status: 'unsupported',
      projectorId: downloadedProjector.id,
      requestedSupport: ['vision'],
    }));
  });

  it('disables llama.rn context shifting for resolvable vision projectors with unknown size', async () => {
    (registry.getModel as jest.Mock).mockReturnValue({
      ...createDownloadedVisionModel(),
      projectorCandidates: [{
        ...downloadedProjector,
        size: null,
      }],
    });
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => (
      uri.includes('mmproj')
        ? { exists: true }
        : { exists: true, size: 1024 }
    ));

    await expect((llmEngineService as any).resolveLoadTimeProjectorMemoryInfo(
      registry.getModel('test/model'),
    )).resolves.toEqual(expect.objectContaining({
      projectorId: downloadedProjector.id,
      sizeBytes: null,
      memoryFitSizeBytes: UNKNOWN_PROJECTOR_MEMORY_FIT_FALLBACK_BYTES,
    }));

    await llmEngineService.load('test/model', { forceReload: true });

    expect(llamaRn.initLlama).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx_shift: false,
      }),
      expect.any(Function),
    );
    expect(getInitMultimodalMock()).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'test-dir/models/mmproj-model.gguf',
      }),
    );
    const readinessUpdate = (registry.updateModel as jest.Mock).mock.calls
      .map(([model]) => model)
      .find((model: { multimodalReadiness?: { status?: string } }) => model.multimodalReadiness?.status === 'ready');
    expect(readinessUpdate?.multimodalReadiness).toEqual(expect.not.objectContaining({
      projectorSize: expect.anything(),
    }));
  });

  it('initializes multimodal readiness for audio-only models', async () => {
    getMultimodalSupportMock().mockResolvedValue({ vision: false, audio: true });
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedAudioModel());

    await llmEngineService.load('test/model', { forceReload: true });

    expect(getInitMultimodalMock()).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'test-dir/models/mmproj-model.gguf',
      }),
    );
    const readinessUpdate = (registry.updateModel as jest.Mock).mock.calls
      .map(([model]) => model)
      .find((model: { multimodalReadiness?: { status?: string } }) => model.multimodalReadiness?.status === 'ready');
    expect(readinessUpdate?.multimodalReadiness).toEqual(expect.objectContaining({
      status: 'ready',
      projectorId: downloadedProjector.id,
      support: ['audio'],
      requestedSupport: ['audio'],
    }));
  });

  it('rechecks active projector readiness when requested modalities expand beyond a legacy cache', async () => {
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());

    await llmEngineService.load('test/model', { forceReload: true });
    const context = (llmEngineService as any).context;
    expect(context).toBeTruthy();

    getMultimodalSupportMock().mockClear();
    getMultimodalSupportMock().mockResolvedValue({ vision: true, audio: true });
    (registry.getModel as jest.Mock).mockReturnValue({
      ...createDownloadedVisionModel(),
      chatModalities: ['text', 'vision', 'audio'],
      multimodalReadiness: createReadyMultimodalReadiness(),
    });

    await (llmEngineService as any).initializeMultimodalReadinessForLoadedContext({
      modelId: 'test/model',
      context,
      useGpu: false,
    });

    expect(getMultimodalSupportMock()).toHaveBeenCalledTimes(1);
    const readinessUpdate = (registry.updateModel as jest.Mock).mock.calls
      .map(([model]) => model)
      .find((model: { multimodalReadiness?: { support?: string[] } }) => (
        model.multimodalReadiness?.support?.includes('audio')
      ));
    expect(readinessUpdate?.multimodalReadiness).toEqual(expect.objectContaining({
      status: 'ready',
      support: ['vision', 'audio'],
      requestedSupport: ['vision', 'audio'],
    }));
  });

  it('reuses partial active projector readiness after all requested modalities were checked', async () => {
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());

    await llmEngineService.load('test/model', { forceReload: true });
    const context = (llmEngineService as any).context;
    expect(context).toBeTruthy();

    getMultimodalSupportMock().mockClear();
    (registry.getModel as jest.Mock).mockReturnValue({
      ...createDownloadedVisionModel(),
      chatModalities: ['text', 'vision', 'audio'],
      multimodalReadiness: {
        ...createReadyMultimodalReadiness(),
        requestedSupport: ['vision', 'audio'],
      },
    });

    await (llmEngineService as any).initializeMultimodalReadinessForLoadedContext({
      modelId: 'test/model',
      context,
      useGpu: false,
    });

    expect(getMultimodalSupportMock()).not.toHaveBeenCalled();
  });

  it('reuses raw projector SHA verification within a single load and readiness operation', async () => {
    const sha256 = 'a'.repeat(64);
    const modelSizeBytes = 1_000_000_000;
    const projectorSizeBytes = 24_000_000;

    (registry.getModel as jest.Mock).mockReturnValue({
      ...createDownloadedVisionModel(),
      projectorCandidates: [{
        ...downloadedProjector,
        sha256,
      }],
    });
    (RNFS.hash as jest.Mock).mockResolvedValue(sha256);
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => ({
      exists: true,
      size: uri.includes('mmproj') ? projectorSizeBytes : modelSizeBytes,
    }));

    await llmEngineService.load('test/model', { forceReload: true, allowUnsafeMemoryLoad: true });

    expect(RNFS.hash).toHaveBeenCalledTimes(1);
    expect(getInitMultimodalMock()).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'test-dir/models/mmproj-model.gguf',
      }),
    );
  });

  it('reloads a same-model context with context shifting disabled when a projector becomes resolvable later', async () => {
    (registry.getModel as jest.Mock).mockReturnValue({
      ...createDownloadedVisionModel(),
      projectorCandidates: [],
      selectedProjectorId: undefined,
    });

    await llmEngineService.load('test/model', { forceReload: true });

    const textOnlyContext = (llmEngineService as any).context;
    expect(textOnlyContext).toBeTruthy();
    expect(llamaRn.initLlama).toHaveBeenCalledTimes(1);
    expect((llamaRn.initLlama as jest.Mock).mock.calls[0][0]).not.toHaveProperty('ctx_shift');
    expect(getInitMultimodalMock()).not.toHaveBeenCalled();

    (llamaRn.initLlama as jest.Mock).mockClear();
    (llamaRn.releaseAllLlama as jest.Mock).mockClear();
    getInitMultimodalMock().mockClear();
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());

    await llmEngineService.load('test/model');

    expect(llamaRn.releaseAllLlama).toHaveBeenCalledTimes(1);
    expect((llmEngineService as any).context).not.toBe(textOnlyContext);
    expect(llamaRn.initLlama).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx_shift: false,
      }),
      expect.any(Function),
    );
    expect(getInitMultimodalMock()).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'test-dir/models/mmproj-model.gguf',
      }),
    );
  });

  it('reloads a same-model projector context back to default context shifting when the projector is unavailable', async () => {
    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());

    await llmEngineService.load('test/model', { forceReload: true });

    const multimodalContext = (llmEngineService as any).context;
    expect(multimodalContext).toBeTruthy();
    expect(llamaRn.initLlama).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx_shift: false,
      }),
      expect.any(Function),
    );
    expect(getInitMultimodalMock()).toHaveBeenCalledTimes(1);

    (llamaRn.initLlama as jest.Mock).mockClear();
    (llamaRn.releaseAllLlama as jest.Mock).mockClear();
    getInitMultimodalMock().mockClear();
    getReleaseMultimodalMock().mockClear();
    (registry.updateModel as jest.Mock).mockClear();
    (registry.getModel as jest.Mock).mockReturnValue({
      ...createDownloadedVisionModel(),
      projectorCandidates: [],
      selectedProjectorId: undefined,
      multimodalReadiness: createReadyMultimodalReadiness(),
    });

    await llmEngineService.load('test/model');

    expect(llamaRn.releaseAllLlama).toHaveBeenCalledTimes(1);
    expect(getReleaseMultimodalMock()).toHaveBeenCalledTimes(1);
    expect((llmEngineService as any).context).not.toBe(multimodalContext);
    expect(llamaRn.initLlama).toHaveBeenCalledTimes(1);
    expect((llamaRn.initLlama as jest.Mock).mock.calls[0][0]).not.toHaveProperty('ctx_shift');
    expect(getInitMultimodalMock()).not.toHaveBeenCalled();
    expect(getActiveMultimodalContext()).toBeNull();
    expect(registry.updateModel).toHaveBeenLastCalledWith(expect.objectContaining({
      multimodalReadiness: expect.objectContaining({
        status: 'missing_projector',
        support: [],
      }),
    }));
  });

  it('starts automatic first GPU loads with a small conservative probe profile', async () => {
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: null,
      kvCacheType: 'f16',
    });
    (llamaRn.loadLlamaModelInfo as jest.Mock).mockResolvedValueOnce({
      'general.architecture': 'llama',
      'general.type': 'model',
      'llama.block_count': 12,
      'llama.attention.head_count': 8,
      'llama.embedding_length': 2048,
    });

    await llmEngineService.load('test/model', { forceReload: true });

    const calls = (llamaRn.initLlama as jest.Mock).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toEqual(expect.objectContaining({
      n_ctx: 4096,
      n_gpu_layers: 3,
    }));
    expect(llmEngineService.getLoadedGpuLayers()).toBe(3);
    expect(llmEngineService.getState().diagnostics).toEqual(expect.objectContaining({
      backendMode: 'gpu',
      requestedGpuLayers: 12,
      loadedGpuLayers: 3,
      backendInitAttempts: expect.arrayContaining([
        expect.objectContaining({ candidate: 'gpu', nGpuLayers: 3, outcome: 'success', actualGpu: true }),
      ]),
    }));
  });

  it('reports requested and loaded GPU layers separately after retrying with fewer layers', async () => {
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 12,
      kvCacheType: 'f16',
    });
    (llamaRn.initLlama as jest.Mock).mockImplementation(async (options?: { n_gpu_layers?: number }) => {
      if ((options?.n_gpu_layers ?? 0) >= 12) {
        throw new Error('GPU OOM');
      }

      return {
        completion: (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock,
        stopCompletion: jest.fn().mockResolvedValue(undefined),
        gpu: (options?.n_gpu_layers ?? 0) > 0,
        devices: ['Adreno GPU'],
        reasonNoGPU: '',
        systemInfo: 'Android test device',
        androidLib: 'libOpenCL.so',
      };
    });

    await llmEngineService.load('test/model', { forceReload: true });

    expect(llmEngineService.getLoadedGpuLayers()).toBe(9);
    expect(llmEngineService.getState().diagnostics).toEqual(expect.objectContaining({
      backendMode: 'gpu',
      requestedGpuLayers: 12,
      loadedGpuLayers: 9,
      actualGpuAccelerated: true,
      backendDevices: ['Adreno GPU'],
      backendInitAttempts: [
        expect.objectContaining({
          candidate: 'gpu',
          nGpuLayers: 12,
          outcome: 'error',
          error: 'GPU OOM',
        }),
        expect.objectContaining({
          candidate: 'gpu',
          nGpuLayers: 9,
          outcome: 'success',
          actualGpu: true,
        }),
      ],
    }));
  });

  it('includes backend init attempts in load errors when every profile fails', async () => {
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 12,
      kvCacheType: 'f16',
    });
    (llamaRn.initLlama as jest.Mock).mockImplementation(async (options?: { n_gpu_layers?: number }) => {
      const layers = options?.n_gpu_layers ?? 0;
      throw new Error(layers > 0 ? `GPU OOM at ${layers}` : 'CPU init failed');
    });

    const thrown = await llmEngineService.load('test/model', { forceReload: true }).catch((error) => error);

    expect(thrown).toMatchObject({
      code: 'model_load_failed',
      details: expect.objectContaining({
        gpuInitError: 'GPU OOM at 1',
        cpuInitError: 'CPU init failed',
        backendInitAttempts: [
          expect.objectContaining({
            candidate: 'gpu',
            nGpuLayers: 12,
            outcome: 'error',
            error: 'GPU OOM at 12',
          }),
          expect.objectContaining({
            candidate: 'gpu',
            nGpuLayers: 9,
            outcome: 'error',
            error: 'GPU OOM at 9',
          }),
          expect.objectContaining({
            candidate: 'gpu',
            nGpuLayers: 6,
            outcome: 'error',
            error: 'GPU OOM at 6',
          }),
          expect.objectContaining({
            candidate: 'gpu',
            nGpuLayers: 3,
            outcome: 'error',
            error: 'GPU OOM at 3',
          }),
          expect.objectContaining({
            candidate: 'gpu',
            nGpuLayers: 1,
            outcome: 'error',
            error: 'GPU OOM at 1',
          }),
          expect.objectContaining({
            candidate: 'cpu',
            nGpuLayers: 0,
            outcome: 'error',
            error: 'CPU init failed',
          }),
        ],
      }),
    });
    expect(llmEngineService.getLastModelLoadError()?.error.details).toEqual(
      expect.objectContaining({
        backendInitAttempts: thrown.details.backendInitAttempts,
      }),
    );
  });

  it('redacts private paths from backend init diagnostics', async () => {
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 1,
      kvCacheType: 'f16',
    });
    (llamaRn.initLlama as jest.Mock).mockImplementation(async () => {
      throw new Error('Failed to initialize C:\\Users\\tester\\Model Files\\model.gguf with file:///private/mobile/mmproj.gguf');
    });

    const thrown = await llmEngineService.load('test/model', { forceReload: true }).catch((error) => error);
    const serializedDetails = JSON.stringify(thrown.details);

    expect(serializedDetails).toContain('[path]');
    expect(serializedDetails).not.toContain('C:\\Users\\tester');
    expect(serializedDetails).not.toContain('file:///private');
  });

  it('reports CPU runtime honestly when upstream does not enable GPU acceleration', async () => {
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 12,
      kvCacheType: 'f16',
    });
    (llamaRn.initLlama as jest.Mock).mockImplementation(async (options?: { n_gpu_layers?: number }) => {
      const layers = options?.n_gpu_layers ?? 0;
      return {
        completion: (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock,
        stopCompletion: jest.fn().mockResolvedValue(undefined),
        gpu: false,
        devices: [],
        reasonNoGPU: layers > 0 ? 'OpenCL backend unavailable' : 'CPU fallback',
        systemInfo: 'Android test device',
        androidLib: null,
      };
    });

    await llmEngineService.load('test/model', { forceReload: true });

    const calls = (llamaRn.initLlama as jest.Mock).mock.calls;
    expect(calls).toHaveLength(2);
    expect((calls[0][0]?.n_gpu_layers ?? 0)).toBeGreaterThan(0);
    expect(calls[1][0]?.n_gpu_layers ?? 0).toBe(0);
    expect(llmEngineService.getLoadedGpuLayers()).toBe(0);
    expect(llmEngineService.getState().diagnostics).toEqual(expect.objectContaining({
      backendMode: 'cpu',
      requestedGpuLayers: 12,
      loadedGpuLayers: 0,
      actualGpuAccelerated: false,
      reasonNoGPU: 'CPU fallback',
      backendInitAttempts: expect.arrayContaining([
        expect.objectContaining({ candidate: 'gpu', outcome: 'success', actualGpu: false, reasonNoGPU: 'OpenCL backend unavailable' }),
        expect.objectContaining({ candidate: 'cpu', outcome: 'success', actualGpu: false }),
      ]),
    }));
  });

  it('does not attempt GPU init when no accelerator devices exist', async () => {
    getBackendDevicesInfoMock().mockResolvedValueOnce([]);
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 12,
      kvCacheType: 'f16',
    });

    await llmEngineService.load('test/model', { forceReload: true });

    const calls = (llamaRn.initLlama as jest.Mock).mock.calls;
    const attemptedGpu = calls.some((call) => (call[0]?.n_gpu_layers ?? 0) > 0);
    expect(attemptedGpu).toBe(false);
    expect(llmEngineService.getState().diagnostics).toEqual(expect.objectContaining({
      backendMode: 'cpu',
      requestedGpuLayers: 12,
      loadedGpuLayers: 0,
    }));
  });

  it('classifies HTP as NPU-only and uses offload layers for NPU loads', async () => {
    getBackendDevicesInfoMock().mockResolvedValueOnce([
      {
        type: 'gpu',
        backend: 'HTP',
        deviceName: 'HTP0',
        metadata: {
          socModel: 'SM8550',
        },
      },
    ]);
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 12,
      kvCacheType: 'f16',
      backendPolicy: 'npu',
    });
    (llamaRn.initLlama as jest.Mock).mockImplementation(async (options?: { n_gpu_layers?: number; devices?: string[] }) => ({
      completion: (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock,
      stopCompletion: jest.fn().mockResolvedValue(undefined),
      gpu: (options?.n_gpu_layers ?? 0) > 0,
      devices: options?.devices?.includes('HTP0') ? ['HTP0'] : [],
      reasonNoGPU: '',
      systemInfo: 'Android Hexagon test device',
      androidLib: 'libQnnHtp.so',
    }));

    const availability = await llmEngineService.getBackendAvailability();
    expect(availability).toEqual(expect.objectContaining({
      gpuBackendAvailable: false,
      npuBackendAvailable: true,
    }));

    await llmEngineService.load('test/model', { forceReload: true });

    expect(llamaRn.initLlama).toHaveBeenCalledWith(
      expect.objectContaining({
        n_ctx: 4096,
        n_gpu_layers: 12,
        devices: ['HTP0'],
      }),
      expect.any(Function),
    );
    expect(llmEngineService.getLoadedGpuLayers()).toBe(12);
    expect(llmEngineService.getState().diagnostics).toEqual(expect.objectContaining({
      backendMode: 'npu',
      requestedGpuLayers: 12,
      loadedGpuLayers: 12,
      actualGpuAccelerated: true,
      backendDevices: ['HTP0'],
    }));
  });

  it('reports both GPU and NPU availability when upstream lists both device types', async () => {
    getBackendDevicesInfoMock().mockResolvedValueOnce([
      {
        type: 'gpu',
        backend: 'HTP',
        deviceName: 'HTP0',
      },
      {
        type: 'gpu',
        backend: 'OpenCL',
        deviceName: 'QUALCOMM Adreno(TM) 740',
      },
    ]);

    await expect(llmEngineService.getBackendAvailability()).resolves.toEqual(expect.objectContaining({
      gpuBackendAvailable: true,
      npuBackendAvailable: true,
    }));
  });

  it('auto falls back from NPU to GPU when NPU init returns CPU runtime', async () => {
    getBackendDevicesInfoMock().mockResolvedValueOnce([
      {
        type: 'gpu',
        backend: 'HTP',
        deviceName: 'HTP0',
        metadata: {
          socModel: 'SM8550',
        },
      },
      {
        type: 'gpu',
        backend: 'OpenCL',
        deviceName: 'QUALCOMM Adreno(TM) 740',
        maxMemorySize: 0,
      },
    ]);
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 12,
      kvCacheType: 'f16',
    });
    (llamaRn.initLlama as jest.Mock).mockImplementation(async (options?: { n_gpu_layers?: number; devices?: string[] }) => {
      const isNpuCandidate = Array.isArray(options?.devices) && options.devices.some((device) => device.toUpperCase().startsWith('HTP'));
      return {
        completion: (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock,
        stopCompletion: jest.fn().mockResolvedValue(undefined),
        gpu: !isNpuCandidate && (options?.n_gpu_layers ?? 0) > 0,
        devices: isNpuCandidate ? ['HTP0'] : ['Adreno GPU'],
        reasonNoGPU: isNpuCandidate ? 'HTP acceleration disabled' : '',
        systemInfo: isNpuCandidate ? 'Android Hexagon test device' : 'Android test device',
        androidLib: isNpuCandidate ? 'libQnnHtp.so' : 'libOpenCL.so',
      };
    });

    await llmEngineService.load('test/model', { forceReload: true });

    const calls = (llamaRn.initLlama as jest.Mock).mock.calls;
    expect(calls[0][0].devices).toEqual(['HTP0']);
    expect(calls[1][0].devices).toBeUndefined();

    expect(llmEngineService.getLoadedGpuLayers()).toBe(12);
    expect(llmEngineService.getState().diagnostics).toEqual(expect.objectContaining({
      backendMode: 'gpu',
      backendInitAttempts: expect.arrayContaining([
        expect.objectContaining({ candidate: 'npu', outcome: 'success', actualGpu: false }),
        expect.objectContaining({ candidate: 'gpu', outcome: 'success', actualGpu: true }),
      ]),
    }));
  });

  it('does not fall back from NPU to GPU when GPU is unavailable', async () => {
    getBackendDevicesInfoMock().mockResolvedValueOnce([
      {
        type: 'gpu',
        backend: 'HTP',
        deviceName: 'HTP0',
        metadata: {
          socModel: 'SM8550',
        },
      },
    ]);
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 12,
      kvCacheType: 'f16',
    });
    (llamaRn.initLlama as jest.Mock).mockImplementation(async (options?: { n_gpu_layers?: number; devices?: string[] }) => {
      const isNpuCandidate = Array.isArray(options?.devices) && options.devices.some((device) => device.toUpperCase().startsWith('HTP'));
      return {
        completion: (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock,
        stopCompletion: jest.fn().mockResolvedValue(undefined),
        gpu: !isNpuCandidate && (options?.n_gpu_layers ?? 0) > 0,
        devices: isNpuCandidate ? ['HTP0'] : ['Adreno GPU'],
        reasonNoGPU: isNpuCandidate ? 'HTP acceleration disabled' : '',
        systemInfo: isNpuCandidate ? 'Android Hexagon test device' : 'Android test device',
        androidLib: isNpuCandidate ? 'libQnnHtp.so' : 'libOpenCL.so',
      };
    });

    await llmEngineService.load('test/model', { forceReload: true });

    const calls = (llamaRn.initLlama as jest.Mock).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0].devices).toEqual(['HTP0']);
    expect(calls[1][0].devices).toBeUndefined();
    expect(llmEngineService.getLoadedGpuLayers()).toBe(0);
    expect(llmEngineService.getState().diagnostics).toEqual(expect.objectContaining({
      backendMode: 'cpu',
      backendInitAttempts: expect.arrayContaining([
        expect.objectContaining({ candidate: 'npu', outcome: 'success', actualGpu: false }),
        expect.objectContaining({ candidate: 'cpu', outcome: 'success', actualGpu: false }),
      ]),
    }));
  });

  it('auto falls back from NPU to GPU when NPU init throws', async () => {
    getBackendDevicesInfoMock().mockResolvedValueOnce([
      {
        type: 'gpu',
        backend: 'HTP',
        deviceName: 'HTP0',
        metadata: {
          socModel: 'SM8550',
        },
      },
      {
        type: 'gpu',
        backend: 'OpenCL',
        deviceName: 'QUALCOMM Adreno(TM) 740',
        maxMemorySize: 0,
      },
    ]);
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 12,
      kvCacheType: 'f16',
    });
    (llamaRn.initLlama as jest.Mock).mockImplementation(async (options?: { n_gpu_layers?: number; devices?: string[] }) => {
      if (Array.isArray(options?.devices) && options.devices.some((device) => device.toUpperCase().startsWith('HTP'))) {
        throw new Error('NPU init failed');
      }

      return {
        completion: (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock,
        stopCompletion: jest.fn().mockResolvedValue(undefined),
        gpu: (options?.n_gpu_layers ?? 0) > 0,
        devices: ['Adreno GPU'],
        reasonNoGPU: '',
        systemInfo: 'Android test device',
        androidLib: 'libOpenCL.so',
      };
    });

    await llmEngineService.load('test/model', { forceReload: true });

    const calls = (llamaRn.initLlama as jest.Mock).mock.calls;
    expect(calls[0][0].devices).toEqual(['HTP0']);
    expect(calls[1][0].devices).toBeUndefined();

    expect(llmEngineService.getState().diagnostics).toEqual(expect.objectContaining({
      backendMode: 'gpu',
      backendInitAttempts: expect.arrayContaining([
        expect.objectContaining({ candidate: 'npu', outcome: 'error' }),
        expect.objectContaining({ candidate: 'gpu', outcome: 'success', actualGpu: true }),
      ]),
    }));
  });

  it('explicit NPU policy does not fall back to GPU when NPU init returns CPU runtime', async () => {
    getBackendDevicesInfoMock().mockResolvedValueOnce([
      {
        type: 'gpu',
        backend: 'HTP',
        deviceName: 'HTP0',
        metadata: {
          socModel: 'SM8550',
        },
      },
    ]);
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 12,
      kvCacheType: 'f16',
      backendPolicy: 'npu',
    });
    (llamaRn.initLlama as jest.Mock).mockImplementation(async (options?: { n_gpu_layers?: number; devices?: string[] }) => ({
      completion: (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock,
      stopCompletion: jest.fn().mockResolvedValue(undefined),
      gpu: false,
      devices: options?.devices?.includes('HTP0') ? ['HTP0'] : [],
      reasonNoGPU: 'HTP acceleration disabled',
      systemInfo: 'Android Hexagon test device',
      androidLib: 'libQnnHtp.so',
    }));

    await llmEngineService.load('test/model', { forceReload: true });

    const calls = (llamaRn.initLlama as jest.Mock).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0].devices).toEqual(['HTP0']);
    expect(calls[1][0].devices).toBeUndefined();
    expect(llmEngineService.getLoadedGpuLayers()).toBe(0);
    expect(llmEngineService.getState().diagnostics).toEqual(expect.objectContaining({
      backendMode: 'cpu',
      requestedBackendPolicy: 'npu',
      effectiveBackendPolicy: 'cpu',
      reasonNoGPU: 'HTP acceleration disabled',
      backendInitAttempts: expect.arrayContaining([
        expect.objectContaining({ candidate: 'npu', outcome: 'success', actualGpu: false }),
        expect.objectContaining({ candidate: 'cpu', outcome: 'success', actualGpu: false }),
      ]),
    }));
  });

  it('records a skipped NPU attempt and falls back to GPU when NPU policy is requested but no HTP devices exist', async () => {
    getBackendDevicesInfoMock().mockResolvedValueOnce([
      {
        type: 'gpu',
        backend: 'OpenCL',
        deviceName: 'QUALCOMM Adreno(TM) 740',
      },
    ]);
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 12,
      kvCacheType: 'f16',
      backendPolicy: 'npu',
    });
    (llamaRn.initLlama as jest.Mock).mockImplementation(async (options?: { n_gpu_layers?: number; devices?: string[] }) => ({
      completion: (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock,
      stopCompletion: jest.fn().mockResolvedValue(undefined),
      gpu: (options?.n_gpu_layers ?? 0) > 0,
      devices: ['Adreno GPU'],
      reasonNoGPU: '',
      systemInfo: 'Android test device',
      androidLib: 'libOpenCL.so',
    }));

    await llmEngineService.load('test/model', { forceReload: true });

    expect(llmEngineService.getState().diagnostics).toEqual(expect.objectContaining({
      backendMode: 'gpu',
      requestedBackendPolicy: 'npu',
      effectiveBackendPolicy: 'auto',
      backendPolicyReasons: expect.arrayContaining([
        'inference.backendPolicyReason.npuRequestedNoDevicesDiscovered',
      ]),
      backendInitAttempts: expect.arrayContaining([
        expect.objectContaining({ candidate: 'npu', outcome: 'skipped' }),
        expect.objectContaining({ candidate: 'gpu', outcome: 'success', actualGpu: true }),
      ]),
    }));
  });

  it('records a skipped GPU attempt when GPU policy is requested but no non-HTP devices exist', async () => {
    getBackendDevicesInfoMock().mockResolvedValueOnce([
      {
        type: 'gpu',
        backend: 'HTP',
        deviceName: 'HTP0',
      },
    ]);
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 12,
      kvCacheType: 'f16',
      backendPolicy: 'gpu',
    });
    (llamaRn.initLlama as jest.Mock).mockImplementation(async (options?: { n_gpu_layers?: number; devices?: string[] }) => ({
      completion: (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock,
      stopCompletion: jest.fn().mockResolvedValue(undefined),
      gpu: false,
      devices: options?.devices?.includes('HTP*') ? ['HTP0'] : [],
      reasonNoGPU: 'OpenCL backend unavailable',
      systemInfo: 'Android Hexagon test device',
      androidLib: 'libQnnHtp.so',
    }));

    await llmEngineService.load('test/model', { forceReload: true });

    expect(llmEngineService.getState().diagnostics).toEqual(expect.objectContaining({
      backendMode: 'cpu',
      requestedBackendPolicy: 'gpu',
      effectiveBackendPolicy: 'cpu',
      backendPolicyReasons: expect.arrayContaining([
        'inference.backendPolicyReason.gpuRequestedNoDevicesDiscovered',
      ]),
      backendInitAttempts: expect.arrayContaining([
        expect.objectContaining({ candidate: 'gpu', outcome: 'skipped' }),
      ]),
    }));
  });

  it('prefers the saved best-stable autotune profile when auto policy is enabled', async () => {
    getBackendDevicesInfoMock().mockResolvedValueOnce([
      {
        type: 'gpu',
        backend: 'HTP',
        deviceName: 'HTP0',
        metadata: {
          socModel: 'SM8550',
        },
      },
      {
        type: 'gpu',
        backend: 'OpenCL',
        deviceName: 'QUALCOMM Adreno(TM) 740',
      },
    ]);
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 12,
      kvCacheType: 'f16',
    });

    writeAutotuneResult({
      createdAtMs: Date.now(),
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
      modelFileSizeBytes: 1024,
      bestStable: {
        backendMode: 'gpu',
        nGpuLayers: 12,
      },
      candidates: [],
    });

    await llmEngineService.load('test/model', { forceReload: true });

    expect((llamaRn.initLlama as jest.Mock).mock.calls).toHaveLength(1);
    expect((llamaRn.initLlama as jest.Mock).mock.calls[0][0].devices).toBeUndefined();
    expect(llmEngineService.getState().diagnostics).toEqual(expect.objectContaining({
      backendMode: 'gpu',
      backendPolicyReasons: expect.arrayContaining([
        'inference.backendPolicyReason.autotunePreferringGpu',
      ]),
    }));
  });

  it('ignores a saved CPU autotune fallback when backend discovery was unavailable during autotune', async () => {
    getBackendDevicesInfoMock().mockResolvedValueOnce([
      {
        type: 'gpu',
        backend: 'OpenCL',
        deviceName: 'QUALCOMM Adreno(TM) 740',
      },
    ]);
    (registry.getModel as jest.Mock).mockReturnValue({
      id: 'test/model',
      localPath: 'model.gguf',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      sha256: 'live-sha',
    });
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 12,
      kvCacheType: 'f16',
    });

    writeAutotuneResult({
      createdAtMs: Date.now(),
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
      modelFileSizeBytes: 1024,
      modelSha256: 'live-sha',
      backendDiscoveryKnown: false,
      bestStable: {
        backendMode: 'cpu',
        nGpuLayers: 0,
      },
      candidates: [
        {
          profile: { backendMode: 'cpu', nGpuLayers: 0 },
          success: true,
          tokensPerSec: 10,
          actualBackendMode: 'cpu',
          actualGpuAccelerated: false,
        },
      ],
    });

    await llmEngineService.load('test/model', { forceReload: true });

    expect(llmEngineService.getState().diagnostics).toEqual(expect.objectContaining({
      backendMode: 'gpu',
    }));
    expect(llmEngineService.getState().diagnostics?.backendPolicyReasons ?? []).not.toContain(
      'inference.backendPolicyReason.autotunePreferringCpu',
    );
  });

  it('keeps a saved CPU autotune preference when backend discovery was known during autotune', async () => {
    getBackendDevicesInfoMock().mockResolvedValueOnce([
      {
        type: 'gpu',
        backend: 'OpenCL',
        deviceName: 'QUALCOMM Adreno(TM) 740',
      },
    ]);
    (registry.getModel as jest.Mock).mockReturnValue({
      id: 'test/model',
      localPath: 'model.gguf',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      sha256: 'live-sha',
    });
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 12,
      kvCacheType: 'f16',
    });

    writeAutotuneResult({
      createdAtMs: Date.now(),
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
      modelFileSizeBytes: 1024,
      modelSha256: 'live-sha',
      backendDiscoveryKnown: true,
      bestStable: {
        backendMode: 'cpu',
        nGpuLayers: 0,
      },
      candidates: [
        {
          profile: { backendMode: 'cpu', nGpuLayers: 0 },
          success: true,
          tokensPerSec: 10,
          actualBackendMode: 'cpu',
          actualGpuAccelerated: false,
        },
      ],
    });

    await llmEngineService.load('test/model', { forceReload: true });

    expect(llmEngineService.getState().diagnostics).toEqual(expect.objectContaining({
      backendMode: 'cpu',
      backendPolicyReasons: expect.arrayContaining([
        'inference.backendPolicyReason.autotunePreferringCpu',
      ]),
    }));
  });

  it('ignores a saved autotune profile when the model sha no longer matches', async () => {
    getBackendDevicesInfoMock().mockResolvedValueOnce([
      {
        type: 'gpu',
        backend: 'HTP',
        deviceName: 'HTP0',
        metadata: {
          socModel: 'SM8550',
        },
      },
      {
        type: 'gpu',
        backend: 'OpenCL',
        deviceName: 'QUALCOMM Adreno(TM) 740',
      },
    ]);
    (registry.getModel as jest.Mock).mockReturnValue({
      id: 'test/model',
      localPath: 'model.gguf',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      sha256: 'live-sha',
    });
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 12,
      kvCacheType: 'f16',
    });

    writeAutotuneResult({
      createdAtMs: Date.now(),
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
      modelFileSizeBytes: 1024,
      modelSha256: 'stale-sha',
      bestStable: {
        backendMode: 'gpu',
        nGpuLayers: 12,
      },
      candidates: [],
    });

    await llmEngineService.load('test/model', { forceReload: true });

    expect((llamaRn.initLlama as jest.Mock).mock.calls).toHaveLength(1);
    expect((llamaRn.initLlama as jest.Mock).mock.calls[0][0].devices).toEqual(['HTP0']);
    expect(llmEngineService.getState().diagnostics?.backendPolicyReasons ?? []).not.toContain(
      'inference.backendPolicyReason.autotunePreferringGpu',
    );
  });

  it('applies advanced load parameters to init options and diagnostics', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
      exists: true,
    });
    (registry.getModel as jest.Mock).mockReturnValue({
      id: 'test/model',
      localPath: 'model.gguf',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
    });
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 12,
      kvCacheType: 'f16',
      cpuThreads: 6,
      cpuMask: '4,5',
      cpuStrict: true,
      flashAttention: 'on',
      useMmap: false,
      useMlock: true,
      parallelSlots: 2,
      nBatch: 96,
      nUbatch: 48,
      kvUnified: true,
    });

    await llmEngineService.load('test/model', { forceReload: true });

    expect(llamaRn.initLlama).toHaveBeenLastCalledWith(
      expect.objectContaining({
        n_ctx: 4096,
        n_gpu_layers: 12,
        n_threads: 6,
        cpu_mask: '4,5',
        cpu_strict: true,
        n_parallel: 1,
        flash_attn_type: 'on',
        use_mmap: false,
        use_mlock: true,
        n_batch: 96,
        n_ubatch: 48,
        kv_unified: true,
      }),
      expect.any(Function),
    );

    expect(llmEngineService.getState().diagnostics).toEqual(expect.objectContaining({
      initFlashAttnType: 'on',
      initUseMmap: false,
      initUseMlock: true,
      initNParallel: 1,
      initNThreads: 6,
      initCpuMask: '4,5',
      initCpuStrict: true,
      initNBatch: 96,
      initNUbatch: 48,
      initKvUnified: true,
    }));
  });

  it('forces flash attention auto when V cache is quantized', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
      exists: true,
    });
    (registry.getModel as jest.Mock).mockReturnValue({
      id: 'test/model',
      localPath: 'model.gguf',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
    });
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 0,
      backendPolicy: 'cpu',
      kvCacheType: 'q8_0',
      flashAttention: 'off',
    });

    await llmEngineService.load('test/model', { forceReload: true });

    expect(llamaRn.initLlama).toHaveBeenLastCalledWith(
      expect.objectContaining({
        n_gpu_layers: 0,
        cache_type_v: 'q8_0',
        flash_attn_type: 'auto',
      }),
      expect.any(Function),
    );

    expect(llmEngineService.getState().diagnostics).toEqual(expect.objectContaining({
      initFlashAttnType: 'auto',
    }));
  });

  it('falls back to f16 KV cache when quantized head dims are incompatible', async () => {
    (llamaRn.loadLlamaModelInfo as jest.Mock).mockResolvedValueOnce({
      n_embd_head_k: 48,
      n_embd_head_v: 48,
    });

    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 0,
      backendPolicy: 'cpu',
      kvCacheType: 'q8_0',
      flashAttention: 'off',
    });

    await llmEngineService.load('test/model', { forceReload: true });

    expect(llamaRn.initLlama).toHaveBeenLastCalledWith(
      expect.objectContaining({
        n_gpu_layers: 0,
        cache_type_k: 'f16',
        cache_type_v: 'f16',
        flash_attn_type: 'off',
      }),
      expect.any(Function),
    );

    expect(llmEngineService.getState().diagnostics).toEqual(expect.objectContaining({
      initCacheTypeK: 'f16',
      initCacheTypeV: 'f16',
    }));
  });

  it('retries with discovered NPU devices when a saved autotune selector is stale and records actual runtime devices', async () => {
    getBackendDevicesInfoMock().mockResolvedValueOnce([
      {
        type: 'gpu',
        backend: 'HTP',
        deviceName: 'HTP0',
        metadata: {
          socModel: 'SM8550',
        },
      },
    ]);
    (registry.getModel as jest.Mock).mockReturnValue({
      id: 'test/model',
      localPath: 'model.gguf',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      sha256: 'live-sha',
    });
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 12,
      kvCacheType: 'f16',
    });

    writeAutotuneResult({
      createdAtMs: Date.now(),
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
      modelFileSizeBytes: 1024,
      modelSha256: 'live-sha',
      bestStable: {
        backendMode: 'npu',
        nGpuLayers: 12,
        devices: ['HTP9'],
      },
      candidates: [],
    });

    (llamaRn.initLlama as jest.Mock).mockImplementation(async (options?: { n_gpu_layers?: number; devices?: string[] }) => {
      if (options?.devices?.includes('HTP9')) {
        throw new Error('stale NPU selector');
      }

      const isNpuCandidate = options?.devices?.includes('HTP0');
      return {
        completion: (llamaRn as unknown as { __completionMock: jest.Mock }).__completionMock,
        stopCompletion: jest.fn().mockResolvedValue(undefined),
        gpu: (options?.n_gpu_layers ?? 0) > 0,
        devices: isNpuCandidate ? ['HTP0'] : ['Adreno GPU'],
        reasonNoGPU: '',
        systemInfo: isNpuCandidate ? 'Android Hexagon test device' : 'Android test device',
        androidLib: isNpuCandidate ? 'libQnnHtp.so' : 'libOpenCL.so',
      };
    });

    await llmEngineService.load('test/model', { forceReload: true });

    const calls = (llamaRn.initLlama as jest.Mock).mock.calls;
    expect(calls[0][0].devices).toEqual(['HTP9']);
    expect(calls[1][0].devices).toEqual(['HTP0']);
    expect(llmEngineService.getState().diagnostics).toEqual(expect.objectContaining({
      backendMode: 'npu',
      initDevices: ['HTP0'],
    }));
  });

  it('loads contexts larger than 8192 when the model supports them', async () => {
    (registry.getModel as jest.Mock).mockReturnValue({
      id: 'test/model',
      localPath: 'model.gguf',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      maxContextTokens: 32768,
    });
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 16384,
      gpuLayers: 0,
    });

    await llmEngineService.load('test/model', { forceReload: true });

    expect(llamaRn.initLlama).toHaveBeenLastCalledWith(
      expect.objectContaining({
        n_ctx: 16384,
        n_gpu_layers: 0,
      }),
      expect.any(Function),
    );
    expect(llmEngineService.getContextSize()).toBe(16384);
  });

  it('clamps requested context size to the model ceiling before loading', async () => {
    const totalMemoryBytes = 8 * 1024 * 1024 * 1024;
    const safeContextSize = 4096;
    const modelSizeBytes = 2_000_000_000;

    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(totalMemoryBytes);
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
      exists: true,
      size: modelSizeBytes,
    });
    (registry.getModel as jest.Mock).mockReturnValue({
      id: 'test/model',
      localPath: 'model.gguf',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      size: modelSizeBytes,
      maxContextTokens: safeContextSize,
    });
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 8192,
      gpuLayers: 0,
    });

    await llmEngineService.load('test/model', { forceReload: true });

    expect(llamaRn.initLlama).toHaveBeenLastCalledWith(
      expect.objectContaining({
        n_ctx: safeContextSize,
        n_gpu_layers: 0,
      }),
      expect.any(Function),
    );
    expect(llmEngineService.getContextSize()).toBe(safeContextSize);
  });

  it('reports insufficient memory when the minimum context window still exceeds budget', async () => {
    const totalMemoryBytes = 4 * 1024 * 1024 * 1024;
    const modelSizeBytes = 3 * 1024 * 1024 * 1024;

    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(totalMemoryBytes);
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
      exists: true,
      size: modelSizeBytes,
    });

    await expect(
      llmEngineService.load('test/model', { forceReload: true }),
    ).rejects.toMatchObject({
      code: 'model_memory_insufficient',
      details: expect.objectContaining({
        safeLoadProfile: expect.objectContaining({
          contextTokens: 512,
          gpuLayers: 0,
        }),
      }),
    });

    expect(llamaRn.initLlama).not.toHaveBeenCalled();
    expect(llmEngineService.getState().status).toBe(EngineStatus.IDLE);
    expect(registry.updateModel).toHaveBeenCalledWith(expect.objectContaining({
      id: 'test/model',
      fitsInRam: false,
      memoryFitDecision: 'likely_oom',
      memoryFitConfidence: 'high',
    }));
  });

  it('allows an unsafe retry for registry-marked likely_oom models', async () => {
    const totalMemoryBytes = 8 * 1024 * 1024 * 1024;
    const modelSizeBytes = 1_000_000_000;

    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(totalMemoryBytes);
    (registry.getModel as jest.Mock).mockReturnValue({
      id: 'test/model',
      localPath: 'model.gguf',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      size: modelSizeBytes,
      memoryFitDecision: 'likely_oom',
      memoryFitConfidence: 'high',
      fitsInRam: false,
    });
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
      exists: true,
      size: modelSizeBytes,
    });

    await expect(
      llmEngineService.load('test/model', { forceReload: true, allowUnsafeMemoryLoad: true }),
    ).resolves.toBeUndefined();

    expect(llamaRn.initLlama).toHaveBeenCalled();
    expect(updateSettings).toHaveBeenCalledWith({ activeModelId: 'test/model' });
  });

  it('reloads the same model id when the registry points to a different artifact', async () => {
    await llmEngineService.unload().catch(() => undefined);
    jest.clearAllMocks();

    let currentModel = {
      id: 'test/model',
      localPath: 'model-v1.gguf',
      resolvedFileName: 'model-v1.gguf',
      activeVariantId: 'variant-a',
      sha256: 'aaa',
      downloadIntegrity: { kind: 'sha256', sha256: 'aaa', sizeBytes: 1024, checkedAt: 1 },
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      size: 1024,
    };

    (registry.getModel as jest.Mock).mockImplementation(() => currentModel);
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => ({
      exists: true,
      size: uri.includes('model-v2.gguf') ? 2048 : 1024,
    }));

    await expect(llmEngineService.load('test/model', { forceReload: true })).resolves.toBeUndefined();

    jest.clearAllMocks();
    currentModel = {
      ...currentModel,
      localPath: 'model-v2.gguf',
      resolvedFileName: 'model-v2.gguf',
      activeVariantId: 'variant-b',
      sha256: 'bbb',
      downloadIntegrity: { kind: 'sha256', sha256: 'bbb', sizeBytes: 2048, checkedAt: 2 },
      size: 2048,
    };

    await expect(llmEngineService.load('test/model')).resolves.toBeUndefined();

    expect(llamaRn.releaseAllLlama).toHaveBeenCalledTimes(1);
    expect(llamaRn.initLlama).toHaveBeenCalledTimes(1);
    expect(llamaRn.initLlama).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.stringContaining('model-v2.gguf'),
      }),
      expect.any(Function),
    );

    await llmEngineService.unload();
  });

  it('does not reload the active model for metadata-only artifact changes', async () => {
    await llmEngineService.unload().catch(() => undefined);
    jest.clearAllMocks();

    let currentModel = {
      id: 'test/model',
      localPath: 'model.gguf',
      resolvedFileName: 'model-v1.gguf',
      activeVariantId: 'variant-a',
      sha256: 'aaa',
      downloadIntegrity: { kind: 'sha256', sha256: 'aaa', sizeBytes: 1024, checkedAt: 1 },
      downloadedAt: 1,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      size: 1024,
    };

    (registry.getModel as jest.Mock).mockImplementation(() => currentModel);
    (FileSystem.getInfoAsync as jest.Mock)
      .mockResolvedValueOnce({
        exists: true,
        size: 1024,
        modificationTime: 1000,
      });

    await expect(llmEngineService.load('test/model', { forceReload: true })).resolves.toBeUndefined();

    jest.clearAllMocks();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
      exists: true,
      size: 1024,
      modificationTime: 1000,
    });
    currentModel = {
      ...currentModel,
      resolvedFileName: 'model-v2.gguf',
      activeVariantId: 'variant-b',
      sha256: 'bbb',
      downloadIntegrity: { kind: 'sha256', sha256: 'bbb', sizeBytes: 2048, checkedAt: 2 },
      downloadedAt: 2,
      size: 2048,
    };

    await expect(llmEngineService.load('test/model')).resolves.toBeUndefined();

    expect(FileSystem.getInfoAsync).toHaveBeenCalledTimes(1);
    expect(llamaRn.releaseAllLlama).not.toHaveBeenCalled();
    expect(llamaRn.initLlama).not.toHaveBeenCalled();

    await llmEngineService.unload();
  });

  it('reloads the same local path when the file modification time changes', async () => {
    await llmEngineService.unload().catch(() => undefined);
    jest.clearAllMocks();

    const currentModel = {
      id: 'test/model',
      localPath: 'model.gguf',
      downloadIntegrity: { kind: 'sha256', sha256: 'aaa', sizeBytes: 1024, checkedAt: 1 },
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      size: 1024,
    };

    (registry.getModel as jest.Mock).mockImplementation(() => currentModel);
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
      exists: true,
      size: 1024,
      modificationTime: 1000,
    });

    await expect(llmEngineService.load('test/model', { forceReload: true })).resolves.toBeUndefined();

    jest.clearAllMocks();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
      exists: true,
      size: 1024,
      modificationTime: 2000,
    });

    await expect(llmEngineService.load('test/model')).resolves.toBeUndefined();

    expect(FileSystem.getInfoAsync).toHaveBeenCalledTimes(1);
    expect(llamaRn.releaseAllLlama).toHaveBeenCalledTimes(1);
    expect(llamaRn.initLlama).toHaveBeenCalledTimes(1);
    expect(llamaRn.initLlama).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.stringContaining('model.gguf'),
      }),
      expect.any(Function),
    );

    await llmEngineService.unload();
  });

  it('reloads the same local path when the fallback download marker changes without mtime', async () => {
    await llmEngineService.unload().catch(() => undefined);
    jest.clearAllMocks();

    let currentModel = {
      id: 'test/model',
      localPath: 'model.gguf',
      downloadIntegrity: { kind: 'sha256', sha256: 'aaa', sizeBytes: 1024, checkedAt: 1 },
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      size: 1024,
    };

    (registry.getModel as jest.Mock).mockImplementation(() => currentModel);
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: true, size: 1024 });

    await expect(llmEngineService.load('test/model', { forceReload: true })).resolves.toBeUndefined();

    jest.clearAllMocks();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: true, size: 1024 });
    currentModel = {
      ...currentModel,
      downloadIntegrity: { kind: 'sha256', sha256: 'aaa', sizeBytes: 1024, checkedAt: 2 },
    };

    await expect(llmEngineService.load('test/model')).resolves.toBeUndefined();

    expect(FileSystem.getInfoAsync).toHaveBeenCalledTimes(1);
    expect(llamaRn.releaseAllLlama).toHaveBeenCalledTimes(1);
    expect(llamaRn.initLlama).toHaveBeenCalledTimes(1);

    await llmEngineService.unload();
  });

  it('blocks registry-marked likely_oom replacement before unloading the active model', async () => {
    await llmEngineService.unload().catch(() => undefined);
    jest.clearAllMocks();

    const totalMemoryBytes = 8 * 1024 * 1024 * 1024;
    const modelSizeBytes = 1_000_000_000;

    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(totalMemoryBytes);
    (registry.getModel as jest.Mock).mockImplementation((modelId: string) => {
      if (modelId === 'test/old-model') {
        return {
          id: modelId,
          localPath: 'old-model.gguf',
          lifecycleStatus: LifecycleStatus.DOWNLOADED,
          size: modelSizeBytes,
        };
      }

      if (modelId === 'test/new-model') {
        return {
          id: modelId,
          localPath: 'new-model.gguf',
          lifecycleStatus: LifecycleStatus.DOWNLOADED,
          size: modelSizeBytes,
          memoryFitDecision: 'likely_oom',
          memoryFitConfidence: 'high',
          fitsInRam: false,
        };
      }

      return undefined;
    });
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
      exists: true,
      size: modelSizeBytes,
    });

    await expect(llmEngineService.load('test/old-model', { forceReload: true })).resolves.toBeUndefined();

    jest.clearAllMocks();

    await expect(llmEngineService.load('test/new-model')).rejects.toMatchObject({
      code: 'model_load_blocked',
      details: expect.objectContaining({
        modelId: 'test/new-model',
        allowUnsafeMemoryLoad: false,
      }),
    });

    expect(llamaRn.releaseAllLlama).not.toHaveBeenCalled();
    expect(llamaRn.initLlama).not.toHaveBeenCalled();
    expect(FileSystem.getInfoAsync).not.toHaveBeenCalled();
    expect(llmEngineService.getState()).toEqual(expect.objectContaining({
      status: EngineStatus.READY,
      activeModelId: 'test/old-model',
    }));

    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
      exists: true,
      size: modelSizeBytes,
    });

    await expect(
      llmEngineService.load('test/new-model', { allowUnsafeMemoryLoad: true }),
    ).resolves.toBeUndefined();

    expect(llamaRn.releaseAllLlama).toHaveBeenCalledTimes(1);
    expect(llamaRn.initLlama).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.stringContaining('new-model.gguf'),
      }),
      expect.any(Function),
    );
    expect(updateSettings).toHaveBeenCalledWith({ activeModelId: 'test/new-model' });

    await llmEngineService.unload();
  });

  it('does not hard-block persisted likely_oom flags unless confidence is high', async () => {
    const totalMemoryBytes = 8 * 1024 * 1024 * 1024;
    const modelSizeBytes = 1_000_000_000;

    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(totalMemoryBytes);
    (registry.getModel as jest.Mock).mockReturnValue({
      id: 'test/model',
      localPath: 'model.gguf',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      size: modelSizeBytes,
      memoryFitDecision: 'likely_oom',
      memoryFitConfidence: 'medium',
      fitsInRam: false,
    });
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
      exists: true,
      size: modelSizeBytes,
    });

    await expect(
      llmEngineService.load('test/model', { forceReload: true }),
    ).resolves.toBeUndefined();

    expect(llamaRn.initLlama).toHaveBeenCalled();
    expect(updateSettings).toHaveBeenCalledWith({ activeModelId: 'test/model' });
  });

  it('rejects mmproj / CLIP projector GGUF files before initializing the engine', async () => {
    (llamaRn.loadLlamaModelInfo as jest.Mock).mockResolvedValueOnce({
      'general.type': 'mmproj',
      'general.architecture': 'clip',
    });

    await expect(
      llmEngineService.load('test/model', { forceReload: true }),
    ).rejects.toMatchObject({ code: 'model_incompatible' });

    expect(llamaRn.initLlama).not.toHaveBeenCalled();
  });

  it('rejects CLIP architecture GGUF files even when the GGUF type is not mmproj', async () => {
    (llamaRn.loadLlamaModelInfo as jest.Mock).mockResolvedValueOnce({
      'general.type': 'model',
      'general.architecture': 'clip',
    });

    await expect(
      llmEngineService.load('test/model', { forceReload: true }),
    ).rejects.toMatchObject({ code: 'model_incompatible' });

    expect(llamaRn.initLlama).not.toHaveBeenCalled();
  });

  it('clamps an aggressive saved load profile back under the memory ceiling before loading', async () => {
    const totalMemoryBytes = 8 * 1024 * 1024 * 1024;
    const modelSizeBytes = 4_705_000_000;

    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(totalMemoryBytes);
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 8192,
      gpuLayers: 35,
    });
    (llamaRn.loadLlamaModelInfo as jest.Mock).mockResolvedValueOnce({
      n_layers: 32,
      n_head_kv: 8,
      n_embd_head_k: 128,
      n_embd_head_v: 128,
      sliding_window: 8192,
    });
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
      exists: true,
      size: modelSizeBytes,
    });

    await expect(
      llmEngineService.load('test/model', { forceReload: true, allowUnsafeMemoryLoad: true }),
    ).resolves.toBeUndefined();

    expect(llamaRn.initLlama).toHaveBeenCalledTimes(1);
    expect(llmEngineService.getContextSize()).toBeLessThan(8192);
    expect(llmEngineService.getContextSize()).toBeGreaterThan(512);
  });

  it('allows explicit unsafe loads when policy can still find a non-minimum load profile', async () => {
    const totalMemoryBytes = 8_000_000_000;
    const modelSizeBytes = 2_500_000_000;

    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(totalMemoryBytes);
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
      exists: true,
      size: modelSizeBytes,
    });
    (getFreshMemorySnapshot as jest.Mock).mockResolvedValue({
      timestampMs: Date.now(),
      platform: 'android',
      totalBytes: totalMemoryBytes,
      availableBytes: 200_000_000,
      freeBytes: 200_000_000,
      usedBytes: totalMemoryBytes - 200_000_000,
      appUsedBytes: 480_309_248,
      appResidentBytes: 480_309_248,
      appPssBytes: 395_870_208,
      lowMemory: false,
      pressureLevel: 'normal',
      thresholdBytes: 0,
    });
    (llamaRn.loadLlamaModelInfo as jest.Mock).mockResolvedValueOnce({
      'general.architecture': 'gemma2',
      'general.type': 'model',
    });

    await expect(
      llmEngineService.load('test/model', { forceReload: true, allowUnsafeMemoryLoad: true }),
    ).resolves.toBeUndefined();

    expect(llamaRn.initLlama).toHaveBeenCalled();
    await llmEngineService.unload();
  });

  it('loads normally when low-confidence estimates still fit within conservative live availability', async () => {
    const totalMemoryBytes = 8_000_000_000;
    const modelSizeBytes = 1_708_582_752;
    const getCalibrationRecordSpy = jest.spyOn(registry, 'getCalibrationRecord');

    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(totalMemoryBytes);
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
      exists: true,
      size: modelSizeBytes,
    });
    (getFreshMemorySnapshot as jest.Mock).mockResolvedValue({
      timestampMs: Date.now(),
      platform: 'android',
      totalBytes: totalMemoryBytes,
      availableBytes: 3_639_033_856,
      freeBytes: undefined,
      usedBytes: totalMemoryBytes - 3_639_033_856,
      appUsedBytes: 480_309_248,
      appResidentBytes: 480_309_248,
      appPssBytes: 395_870_208,
      lowMemory: false,
      pressureLevel: 'normal',
      thresholdBytes: 452_984_832,
    });
    (llamaRn.loadLlamaModelInfo as jest.Mock).mockResolvedValueOnce({
      'general.architecture': 'gemma2',
      'general.type': 'model',
    });
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 2048,
      gpuLayers: 20,
      kvCacheType: 'f16',
    });

    await expect(
      llmEngineService.load('test/model', { forceReload: true }),
    ).resolves.toBeUndefined();

    expect(llamaRn.initLlama).toHaveBeenCalledWith(
      expect.objectContaining({
        n_ctx: 2048,
        n_gpu_layers: 20,
      }),
      expect.any(Function),
    );

    const lowMemoryCalibrationLookup = getCalibrationRecordSpy.mock.calls
      .map(([key]) => key)
      .find((key): key is string => {
        if (typeof key !== 'string') {
          return false;
        }

        try {
          const parsed = JSON.parse(key) as { nBatch?: number; nUbatch?: number };
          return parsed.nBatch === 256 && parsed.nUbatch === 128;
        } catch {
          return false;
        }
      });
    expect(lowMemoryCalibrationLookup).toBeDefined();

    getCalibrationRecordSpy.mockRestore();
  });

  it('separates load-time memory calibration keys for downloaded multimodal projectors', async () => {
    const getCalibrationRecordSpy = jest.spyOn(registry, 'getCalibrationRecord');
    const modelSizeBytes = 1_000_000_000;
    const projectorSizeBytes = 24_000_000;

    (registry.getModel as jest.Mock).mockReturnValue(createDownloadedVisionModel());
    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(8_000_000_000);
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => ({
      exists: true,
      size: uri.includes('mmproj') ? projectorSizeBytes : modelSizeBytes,
    }));
    (getFreshMemorySnapshot as jest.Mock).mockResolvedValue({
      timestampMs: Date.now(),
      platform: 'android',
      totalBytes: 8_000_000_000,
      availableBytes: 4_000_000_000,
      freeBytes: 4_000_000_000,
      usedBytes: 4_000_000_000,
      appUsedBytes: 250_000_000,
      lowMemory: false,
      pressureLevel: 'normal',
      thresholdBytes: 0,
    });

    await expect(
      llmEngineService.load('test/model', { forceReload: true, allowUnsafeMemoryLoad: true }),
    ).resolves.toBeUndefined();

    const parsedCalibrationKeys = getCalibrationRecordSpy.mock.calls.flatMap(([key]) => {
      if (typeof key !== 'string') {
        return [];
      }

      try {
        return [JSON.parse(key)];
      } catch {
        return [];
      }
    });
    expect(parsedCalibrationKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hasMmproj: true }),
      ]),
    );

    getCalibrationRecordSpy.mockRestore();
  });

  it('credits recently unloaded model memory for load decisions without persisting it into calibration budget', async () => {
    await llmEngineService.unload().catch(() => undefined);
    jest.clearAllMocks();

    const totalMemoryBytes = 8_000_000_000;
    const oldModelSizeBytes = 500_000_000;
    const newModelSizeBytes = 1_700_000_000;
    const rawBudgetBytesAfterOldUnload = 700_000_000;
    const syntheticBudgetBytesAfterOldUnload = 2_700_000_000;
    const getCalibrationRecordSpy = jest
      .spyOn(registry, 'getCalibrationRecord')
      .mockReturnValue(undefined);
    const saveCalibrationRecordSpy = jest
      .spyOn(registry, 'saveCalibrationRecord')
      .mockImplementation(() => undefined);
    const beforeOldLoadSnapshot = {
      timestampMs: Date.now(),
      platform: 'android' as const,
      totalBytes: totalMemoryBytes,
      availableBytes: 5_000_000_000,
      freeBytes: 2_000_000_000,
      usedBytes: totalMemoryBytes - 5_000_000_000,
      appUsedBytes: 400_000_000,
      appResidentBytes: 400_000_000,
      appPssBytes: 400_000_000,
      lowMemory: false,
      pressureLevel: 'normal' as const,
      thresholdBytes: 200_000_000,
    };
    const afterOldLoadSnapshot = {
      ...beforeOldLoadSnapshot,
      availableBytes: 900_000_000,
      usedBytes: totalMemoryBytes - 900_000_000,
      appUsedBytes: 2_400_000_000,
      appResidentBytes: 2_400_000_000,
      appPssBytes: 2_400_000_000,
    };

    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(totalMemoryBytes);
    (registry.getModel as jest.Mock).mockImplementation((modelId: string) => ({
      id: modelId,
      localPath: modelId === 'test/old-model' ? 'old-model.gguf' : 'new-model.gguf',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      size: modelId === 'test/old-model' ? oldModelSizeBytes : newModelSizeBytes,
    }));
    (FileSystem.getInfoAsync as jest.Mock)
      .mockResolvedValueOnce({ exists: true, size: oldModelSizeBytes })
      .mockResolvedValueOnce({ exists: true, size: newModelSizeBytes });
    (getModelLoadParametersForModel as jest.Mock).mockReturnValue({
      contextSize: 2048,
      gpuLayers: 0,
      kvCacheType: 'f16',
    });
    (llamaRn.loadLlamaModelInfo as jest.Mock).mockResolvedValue({
      'general.architecture': 'llama',
      'general.type': 'model',
      n_layers: 32,
      n_head_kv: 8,
      n_embd_head_k: 128,
      n_embd_head_v: 128,
    });
    (getFreshMemorySnapshot as jest.Mock)
      .mockResolvedValueOnce(beforeOldLoadSnapshot)
      .mockResolvedValueOnce(afterOldLoadSnapshot)
      .mockResolvedValueOnce(afterOldLoadSnapshot)
      .mockResolvedValueOnce(afterOldLoadSnapshot)
      .mockResolvedValueOnce(afterOldLoadSnapshot);

    await expect(llmEngineService.load('test/old-model', { forceReload: true })).resolves.toBeUndefined();
    await expect(llmEngineService.load('test/new-model')).resolves.toBeUndefined();

    expect(llamaRn.releaseAllLlama).toHaveBeenCalledTimes(1);
    expect(llamaRn.initLlama).toHaveBeenLastCalledWith(
      expect.objectContaining({
        model: expect.stringContaining('new-model.gguf'),
      }),
      expect.any(Function),
    );

    await llmEngineService.unload();

    const newModelCalibrationRecord = saveCalibrationRecordSpy.mock.calls
      .map(([record]) => record)
      .find((record) => {
        try {
          const parsedKey = JSON.parse(record.key) as { verifiedFileSizeBytes?: number };
          return parsedKey.verifiedFileSizeBytes === newModelSizeBytes;
        } catch {
          return false;
        }
      });

    expect(newModelCalibrationRecord).toBeDefined();
    expect(newModelCalibrationRecord?.learnedSafeBudgetBytes).toBe(rawBudgetBytesAfterOldUnload);
    expect(newModelCalibrationRecord?.learnedSafeBudgetBytes).toBeLessThan(syntheticBudgetBytesAfterOldUnload);

    getCalibrationRecordSpy.mockRestore();
    saveCalibrationRecordSpy.mockRestore();
  });

  it.each([
    { missingSnapshot: 'before' as const },
    { missingSnapshot: 'after' as const },
  ])('does not credit recently unloaded model memory when the $missingSnapshot unload snapshot is missing', async ({ missingSnapshot }) => {
    await llmEngineService.unload().catch(() => undefined);
    jest.clearAllMocks();

    const totalMemoryBytes = 8_000_000_000;
    const oldModelSizeBytes = 500_000_000;
    const newModelSizeBytes = 1_700_000_000;
    const beforeOldLoadSnapshot = {
      timestampMs: Date.now(),
      platform: 'android' as const,
      totalBytes: totalMemoryBytes,
      availableBytes: 5_000_000_000,
      freeBytes: 2_000_000_000,
      usedBytes: totalMemoryBytes - 5_000_000_000,
      appUsedBytes: 400_000_000,
      appResidentBytes: 400_000_000,
      appPssBytes: 400_000_000,
      lowMemory: false,
      pressureLevel: 'normal' as const,
      thresholdBytes: 200_000_000,
    };
    const afterOldLoadSnapshot = {
      ...beforeOldLoadSnapshot,
      availableBytes: 900_000_000,
      usedBytes: totalMemoryBytes - 900_000_000,
      appUsedBytes: 2_400_000_000,
      appResidentBytes: 2_400_000_000,
      appPssBytes: 2_400_000_000,
    };
    const afterOldUnloadSnapshot = {
      ...beforeOldLoadSnapshot,
      availableBytes: 700_000_000,
      freeBytes: 700_000_000,
      usedBytes: totalMemoryBytes - 700_000_000,
      appUsedBytes: 2_350_000_000,
      appResidentBytes: 2_350_000_000,
      appPssBytes: 2_350_000_000,
    };

    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(totalMemoryBytes);
    (registry.getModel as jest.Mock).mockImplementation((modelId: string) => ({
      id: modelId,
      localPath: modelId === 'test/old-model' ? 'old-model.gguf' : 'new-model.gguf',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      size: modelId === 'test/old-model' ? oldModelSizeBytes : newModelSizeBytes,
    }));
    (FileSystem.getInfoAsync as jest.Mock)
      .mockResolvedValueOnce({ exists: true, size: oldModelSizeBytes })
      .mockResolvedValueOnce({ exists: true, size: newModelSizeBytes });
    (getModelLoadParametersForModel as jest.Mock).mockReturnValue({
      contextSize: 2048,
      gpuLayers: 0,
      kvCacheType: 'f16',
    });
    (llamaRn.loadLlamaModelInfo as jest.Mock).mockResolvedValue({
      'general.architecture': 'llama',
      'general.type': 'model',
      n_layers: 32,
      n_head_kv: 8,
      n_embd_head_k: 128,
      n_embd_head_v: 128,
    });
    (getFreshMemorySnapshot as jest.Mock)
      .mockResolvedValueOnce(beforeOldLoadSnapshot)
      .mockResolvedValueOnce(afterOldLoadSnapshot)
      .mockResolvedValueOnce(missingSnapshot === 'before' ? null : afterOldLoadSnapshot)
      .mockResolvedValueOnce(missingSnapshot === 'after' ? null : afterOldUnloadSnapshot)
      .mockResolvedValueOnce(afterOldUnloadSnapshot);

    await expect(llmEngineService.load('test/old-model', { forceReload: true })).resolves.toBeUndefined();

    jest.clearAllMocks();

    await expect(llmEngineService.load('test/new-model')).rejects.toMatchObject({
      code: 'model_memory_insufficient',
    });

    expect(llamaRn.releaseAllLlama).toHaveBeenCalledTimes(1);
    expect(llamaRn.initLlama).not.toHaveBeenCalled();
  });

  it('clamps context size to fit within current memory limits without forcing safe mode', async () => {
    const totalMemoryBytes = 8_000_000_000;
    const availableBytes = 1_700_000_000;
    const modelSizeBytes = 2_000_000_000;

    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(totalMemoryBytes);
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
      exists: true,
      size: modelSizeBytes,
    });
    (getModelLoadParametersForModel as jest.Mock).mockReturnValueOnce({
      contextSize: 4096,
      gpuLayers: 12,
      kvCacheType: 'f16',
    });
    (getFreshMemorySnapshot as jest.Mock).mockResolvedValue({
      timestampMs: Date.now(),
      platform: 'android',
      totalBytes: totalMemoryBytes,
      availableBytes,
      freeBytes: availableBytes,
      usedBytes: totalMemoryBytes - availableBytes,
      appUsedBytes: 500_000_000,
      appResidentBytes: 500_000_000,
      appPssBytes: 400_000_000,
      lowMemory: false,
      pressureLevel: 'normal',
      thresholdBytes: 0,
    });
    (llamaRn.loadLlamaModelInfo as jest.Mock).mockResolvedValue({
      n_layers: 32,
      n_head_kv: 8,
      n_embd_head_k: 128,
      n_embd_head_v: 128,
    });

    await expect(
      llmEngineService.load('test/model', { forceReload: true }),
    ).resolves.toBeUndefined();

    const safeLimits = llmEngineService.getSafeModeLoadLimits();
    expect(safeLimits).toBeNull();

    expect(llamaRn.initLlama).toHaveBeenCalledWith(
      expect.objectContaining({
        n_ctx: expect.any(Number),
        n_gpu_layers: 12,
      }),
      expect.any(Function),
    );
    expect(llmEngineService.getContextSize()).toBeLessThan(4096);
    expect(llmEngineService.getContextSize()).toBeGreaterThan(512);
  });

  it('blocks unsafe loads when minimum safe mode still exceeds memory budget', async () => {
    const totalMemoryBytes = 8 * 1024 * 1024 * 1024;
    const modelSizeBytes = 5_000_000_000;

    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(totalMemoryBytes);
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
      exists: true,
      size: modelSizeBytes,
    });
    (getFreshMemorySnapshot as jest.Mock).mockResolvedValue({
      timestampMs: Date.now(),
      platform: 'android',
      totalBytes: totalMemoryBytes,
      availableBytes: 900_000_000,
      freeBytes: 700_000_000,
      usedBytes: totalMemoryBytes - 900_000_000,
      appUsedBytes: 500_000_000,
      lowMemory: false,
      pressureLevel: 'normal',
      thresholdBytes: 250_000_000,
    });
    (llamaRn.loadLlamaModelInfo as jest.Mock).mockResolvedValueOnce({
      n_layers: 2,
      n_head_kv: 4,
      n_embd_head_k: 8,
      n_embd_head_v: 8,
      sliding_window: 64,
    });

    await expect(
      llmEngineService.load('test/model', { forceReload: true, allowUnsafeMemoryLoad: true }),
    ).rejects.toMatchObject({
      code: 'model_memory_insufficient',
      details: expect.objectContaining({
        safeLoadProfile: expect.objectContaining({
          contextTokens: 512,
          gpuLayers: 0,
        }),
      }),
    });

    expect(llamaRn.initLlama).not.toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalledWith({ activeModelId: 'test/model' });
  });

  it('includes KV-cache bytes in model-load diagnostics when GGUF metadata is available', async () => {
    const totalMemoryBytes = 8 * 1024 * 1024 * 1024;
    const modelSizeBytes = 1_000_000_000;

    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(totalMemoryBytes);
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
      exists: true,
      size: modelSizeBytes,
    });
    (getFreshMemorySnapshot as jest.Mock).mockResolvedValue({
      timestampMs: Date.now(),
      platform: 'android',
      totalBytes: totalMemoryBytes,
      availableBytes: 100_000_000,
      freeBytes: 100_000_000,
      usedBytes: totalMemoryBytes - 100_000_000,
      appUsedBytes: 250_000_000,
      lowMemory: false,
      pressureLevel: 'warning',
      thresholdBytes: 0,
    });
    (llamaRn.loadLlamaModelInfo as jest.Mock).mockResolvedValueOnce({
      n_layers: 2,
      n_head_kv: 4,
      n_embd_head_k: 8,
      n_embd_head_v: 8,
      sliding_window: 64,
    });

    const thrown = await llmEngineService.load('test/model', { forceReload: true }).catch((error) => error);

    expect(thrown).toMatchObject({
      code: 'model_memory_warning',
      details: expect.objectContaining({
        memoryFit: expect.objectContaining({
          breakdown: expect.objectContaining({
            kvCacheBytes: expect.any(Number),
          }),
        }),
      }),
    });
    expect(thrown.details.memoryFit.breakdown.kvCacheBytes).toBeGreaterThan(0);
  });

  it('keeps model-load diagnostics free of raw paths and full memory snapshots', async () => {
    const totalMemoryBytes = 8 * 1024 * 1024 * 1024;
    const modelSizeBytes = 1_700_000_000;

    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(totalMemoryBytes);
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
      exists: true,
      size: modelSizeBytes,
    });
    (getFreshMemorySnapshot as jest.Mock).mockResolvedValue({
      timestampMs: Date.now(),
      platform: 'android',
      totalBytes: totalMemoryBytes,
      availableBytes: 2_500_000_000,
      freeBytes: 1_500_000_000,
      usedBytes: totalMemoryBytes - 1_500_000_000,
      appUsedBytes: 500_000_000,
      lowMemory: true,
      pressureLevel: 'critical',
      thresholdBytes: 250_000_000,
    });
    (llamaRn.loadLlamaModelInfo as jest.Mock).mockResolvedValueOnce({
      n_layers: 2,
      n_head_kv: 4,
      n_embd_head_k: 8,
      n_embd_head_v: 8,
      sliding_window: 64,
    });

    const thrown = await llmEngineService.load('test/model', { forceReload: true }).catch((error) => error);

    expect(thrown).toMatchObject({
      code: 'model_memory_insufficient',
      details: expect.objectContaining({
        modelId: 'test/model',
        hasSystemMemorySnapshot: true,
        lowMemorySignal: true,
      }),
    });
    expect(thrown.details).toEqual(expect.not.objectContaining({
      modelPath: expect.anything(),
      localPath: expect.anything(),
      systemMemorySnapshot: expect.anything(),
    }));
  });

  it('uses the device total-memory budget for fitsInRam checks (not the live snapshot)', async () => {
    const totalMemoryBytes = 8 * 1024 * 1024 * 1024;
    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(totalMemoryBytes);
    (getFreshMemorySnapshot as jest.Mock).mockResolvedValue({
      timestampMs: Date.now(),
      platform: 'android',
      totalBytes: totalMemoryBytes,
      availableBytes: 2_500_000_000,
      freeBytes: 1_500_000_000,
      usedBytes: totalMemoryBytes - 1_500_000_000,
      appUsedBytes: 500_000_000,
      lowMemory: false,
      pressureLevel: 'normal',
      thresholdBytes: 250_000_000,
    });

    await expect(llmEngineService.fitsInRam(1_700_000_000)).resolves.toMatchObject({
      decision: 'fits_low_confidence',
      confidence: 'low',
      budget: expect.objectContaining({
        totalMemoryBytes,
        liveAvailableBytes: undefined,
      }),
    });
    await expect(llmEngineService.fitsInRam(6_000_000_000)).resolves.toMatchObject({
      decision: 'borderline',
      confidence: 'low',
      budget: expect.objectContaining({
        totalMemoryBytes,
        liveAvailableBytes: undefined,
      }),
    });
  });

  it('returns unknown for fitsInRam checks when total-memory resolution fails', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    (DeviceInfo.getTotalMemory as jest.Mock).mockRejectedValueOnce(new Error('E_TOTAL_MEM'));

    try {
      await expect(llmEngineService.fitsInRam(1_700_000_000)).resolves.toMatchObject({
        decision: 'unknown',
        confidence: 'low',
        budget: expect.objectContaining({
          totalMemoryBytes: 0,
          liveAvailableBytes: undefined,
        }),
      });
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('LLMEngineService backend telemetry helpers', () => {
  it('detects NPU runtime signals from devices/lib/system info', () => {
    const service: any = llmEngineService;

    expect(service.hasNpuRuntimeSignal({ devices: ['HTP 0'], gpu: false })).toBe(true);
    expect(service.hasNpuRuntimeSignal({ devices: ['something'], androidLib: 'libQNN.so', gpu: false })).toBe(true);
    expect(service.hasNpuRuntimeSignal({ devices: [], systemInfo: 'Hexagon DSP', gpu: false })).toBe(true);
    expect(service.hasNpuRuntimeSignal({ devices: ['Adreno GPU'], gpu: true, androidLib: 'libOpenCL.so' })).toBe(false);
  });

  it('resolves backend mode preferring NPU over GPU', () => {
    const service: any = llmEngineService;

    expect(service.resolveBackendMode({ devices: ['HTP 0'], gpu: true })).toBe('npu');
    expect(service.resolveBackendMode({ devices: [], gpu: true })).toBe('gpu');
    expect(service.resolveBackendMode({ devices: [], gpu: false })).toBe('cpu');
  });

  it('captures telemetry and marks requested NPU as GPU when runtime is GPU-only', () => {
    const service: any = llmEngineService;

    service.captureBackendTelemetry(
      {
        devices: ['Adreno GPU'],
        gpu: true,
        reasonNoGPU: '',
        systemInfo: 'Android',
        androidLib: 'libOpenCL.so',
      },
      { backendMode: 'npu', nGpuLayers: 12 },
      12,
    );

    expect(service.activeBackendMode).toBe('gpu');
    expect(service.actualGpuAccelerated).toBe(true);
  });

  it('does not mark NPU accelerated when reasonNoGPU is present and gpu is false', () => {
    const service: any = llmEngineService;

    service.captureBackendTelemetry(
      {
        devices: ['HTP 0'],
        gpu: false,
        reasonNoGPU: 'GPU disabled',
        systemInfo: 'QNN',
        androidLib: 'libQNN.so',
      },
      { backendMode: 'npu', nGpuLayers: 10 },
      10,
    );

    expect(service.activeBackendMode).toBe('npu');
    expect(service.actualGpuAccelerated).toBe(false);
  });
});
