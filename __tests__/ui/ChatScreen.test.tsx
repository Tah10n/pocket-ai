import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert, Platform } from 'react-native';
import type { ProjectorArtifact } from '../../src/types/multimodal';

jest.mock('react-native-css-interop', () => {
  const mockReact = require('react');

  return {
    createInteropElement: mockReact.createElement,
  };
});

jest.mock('@shopify/flash-list', () => {
  const mockReact = require('react');
  const { View } = require('react-native');

  return {
    FlashList: ({
      data,
      extraData,
      renderItem,
      keyExtractor,
      ItemSeparatorComponent,
      ListEmptyComponent,
      maintainVisibleContentPosition,
      onContentSizeChange,
      onScroll,
      onScrollBeginDrag,
      onScrollEndDrag,
      onMomentumScrollBegin,
      onMomentumScrollEnd,
      onTouchStart,
      onTouchEnd,
      onTouchCancel,
    }: any) =>
      mockReact.createElement(
        View,
        {
          testID: 'chat-flash-list',
          data,
          extraData,
          maintainVisibleContentPosition,
          onContentSizeChange,
          onScroll,
          onScrollBeginDrag,
          onScrollEndDrag,
          onMomentumScrollBegin,
          onMomentumScrollEnd,
          onTouchStart,
          onTouchEnd,
          onTouchCancel,
        },
        data?.length > 0
          ? data.map((item: any, index: number) =>
              mockReact.createElement(
                mockReact.Fragment,
                { key: keyExtractor ? keyExtractor(item, index) : index },
                renderItem({ item, index }),
                index < data.length - 1 && ItemSeparatorComponent
                  ? mockReact.createElement(ItemSeparatorComponent)
                  : null,
              ),
            )
          : ListEmptyComponent
            ? mockReact.createElement(ListEmptyComponent)
            : null,
      ),
  };
});

jest.mock('@react-navigation/bottom-tabs', () => ({
  useBottomTabBarHeight: () => 0,
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({
    canGoBack: () => false,
    back: jest.fn(),
    navigate: mockRouterNavigate,
    push: mockRouterPush,
  }),
}));

beforeAll(() => {
  global.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  }) as typeof global.requestAnimationFrame;
  global.cancelAnimationFrame = ((_: number) => {}) as typeof global.cancelAnimationFrame;
});

const mockRegenerateFromUserMessage = jest.fn();
const mockAppendUserMessage = jest.fn();
const mockDeleteMessage = jest.fn();
const mockStop = jest.fn();
const mockCreateSummaryPlaceholder = jest.fn();
const mockRouterNavigate = jest.fn();
const mockRouterPush = jest.fn();
const mockRunBackendAutotune = jest.fn();
const mockGetRecommendedGpuLayers = jest.fn(() => new Promise<number>(() => {}));
const mockGetRecommendedLoadProfile = jest.fn<Promise<{ recommendedGpuLayers: number; gpuLayersCeiling: number }>, [string | null]>(() =>
  mockGetRecommendedGpuLayers().then((recommendedGpuLayers) => ({
    recommendedGpuLayers,
    gpuLayersCeiling: 512,
  })),
);
const mockLoadModel = jest.fn().mockResolvedValue(undefined);
const mockGetTotalMemory = jest.fn().mockResolvedValue(8 * 1024 * 1024 * 1024);
const mockRefreshModelMetadata = jest.fn((model) => Promise.resolve(model));
const mockAttachImages = jest.fn();
const mockRemoveAttachmentDraft = jest.fn();
const mockClearAttachmentDrafts = jest.fn();
const mockClearFailedAttachmentDrafts = jest.fn();
const mockCommitAttachmentDrafts = jest.fn();
const mockConsumeAttachmentDrafts = jest.fn();
const mockRestoreAttachmentDrafts = jest.fn();
const mockDiscardAttachmentDrafts = jest.fn();
const mockUseChatImageAttachments = jest.fn();
let lastPresetSelectorProps: any = null;
let lastModelParametersSheetProps: any = null;
let lastErrorReportSheetProps: any = null;
let lastChatHeaderProps: any = null;
let lastChatInputBarProps: any = null;
const mockStartNewChat = jest.fn(() => {
  require('../../src/store/chatStore').useChatStore.getState().setActiveThread(null);
});
  let mockSafeModeLoadLimits: {
    maxContextTokens: number;
    requestedGpuLayers: number;
    loadedGpuLayers: number;
  } | null = null;
let mockLoadedContextSize: number | null = null;
let mockLoadedGpuLayers: number | null = null;

const reactI18nextMock = jest.requireMock('react-i18next') as {
  __setTranslationOverride: (key: string, value: string, nextLanguage?: string) => void;
  __resetTranslations: () => void;
};

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}
let hardwareStatusListener: ((status: any) => void) | null = null;
let mockHardwareBannerInputs = {
  showLowMemoryWarning: false,
  showThermalWarning: false,
  thermalState: 'nominal',
};
let mockEngineState: {
  activeModelId: string | null;
  loadProgress?: number;
  status: string;
  diagnostics?: {
    backendMode: 'cpu' | 'gpu' | 'npu' | 'unknown';
    backendDevices: string[];
    reasonNoGPU?: string;
    systemInfo?: string;
    androidLib?: string;
    requestedGpuLayers?: number;
    loadedGpuLayers?: number;
    actualGpuAccelerated?: boolean;
  };
} = {
  activeModelId: 'author/model-q4',
  status: 'ready',
};

jest.mock('../../src/hooks/useLLMEngine', () => ({
  useLLMEngine: () => ({
    state: mockEngineState,
    loadModel: (modelId: string, options?: any) => mockLoadModel(modelId, options),
  }),
}));

jest.mock('../../src/hooks/useChatImageAttachments', () => ({
  useChatImageAttachments: (options: any) => mockUseChatImageAttachments(options),
}));

jest.mock('../../src/services/LLMEngineService', () => ({
  llmEngineService: {
    ensurePersistedCapabilitySnapshot: (model: any) => {
      if (!model) {
        return null;
      }

      const snapshotLayerCount = typeof model?.capabilitySnapshot?.modelLayerCount === 'number'
        ? model.capabilitySnapshot.modelLayerCount
        : null;
      const ggufLayerCount = typeof model?.gguf?.nLayers === 'number' ? model.gguf.nLayers : null;
      const modelLayerCount = snapshotLayerCount ?? ggufLayerCount;
      const snapshotCeiling = typeof model?.capabilitySnapshot?.gpuLayersCeiling === 'number'
        ? model.capabilitySnapshot.gpuLayersCeiling
        : null;
      const gpuLayersCeiling = snapshotCeiling ?? modelLayerCount ?? 512;

      return { modelLayerCount, gpuLayersCeiling };
    },
    getRecommendedLoadProfile: (modelId: string | null) => mockGetRecommendedLoadProfile(modelId),
    getRecommendedGpuLayers: () => mockGetRecommendedGpuLayers(),
    load: (...args: any[]) => mockLoadModel(...args),
    getSafeModeLoadLimits: () => mockSafeModeLoadLimits,
    getContextSize: () => {
      if (typeof mockLoadedContextSize === 'number') {
        return mockLoadedContextSize;
      }

      const { getSettings } = require('../../src/services/SettingsStore');
      if (!mockEngineState.activeModelId) {
        return 4096;
      }

      return getSettings().modelLoadParamsByModelId?.[mockEngineState.activeModelId]?.contextSize ?? 4096;
    },
    getLoadedGpuLayers: () => {
      if (typeof mockLoadedGpuLayers === 'number') {
        return mockLoadedGpuLayers;
      }

      const { getSettings } = require('../../src/services/SettingsStore');
      if (!mockEngineState.activeModelId) {
        return null;
      }

      return getSettings().modelLoadParamsByModelId?.[mockEngineState.activeModelId]?.gpuLayers ?? null;
    },
  },
}));

jest.mock('react-native-device-info', () => ({
  getTotalMemory: () => mockGetTotalMemory(),
}));

jest.mock('../../src/services/ModelCatalogService', () => ({
  modelCatalogService: {
    refreshModelMetadata: (model: any) => mockRefreshModelMetadata(model),
  },
}));

jest.mock('@/services/InferenceAutotuneService', () => ({
  inferenceAutotuneService: {
    runBackendAutotune: (...args: any[]) => mockRunBackendAutotune(...args),
  },
}));

jest.mock('../../src/components/ui/ChatHeader', () => {
  const mockReact = require('react');
  const { Text, Pressable, View } = require('react-native');

  return {
    ChatHeader: ({
      title,
      canStartNewChat,
      onStartNewChat,
      statusLabel,
      presetLabel,
      modelLabel,
      onOpenPresetSelector,
      canOpenPresetSelector,
      modelSelectable,
      onOpenModelSelector,
      canOpenModelSelector,
      onOpenModelControls,
      canOpenModelControls,
    }: any) => {
      lastChatHeaderProps = {
        title,
        canStartNewChat,
        onStartNewChat,
        statusLabel,
        presetLabel,
        modelLabel,
        onOpenPresetSelector,
        canOpenPresetSelector,
        modelSelectable,
        onOpenModelSelector,
        canOpenModelSelector,
        onOpenModelControls,
        canOpenModelControls,
      };

      return mockReact.createElement(
        View,
        null,
        mockReact.createElement(Text, null, title),
        presetLabel
          ? mockReact.createElement(
              Pressable,
              {
                testID: 'preset-button',
                onPress: onOpenPresetSelector,
                disabled: !canOpenPresetSelector,
              },
              mockReact.createElement(Text, null, presetLabel),
            )
          : null,
        modelLabel
          ? onOpenModelSelector
            ? mockReact.createElement(
                Pressable,
                {
                  testID: 'model-selector-button',
                  onPress: onOpenModelSelector,
                  disabled: !canOpenModelSelector,
                },
                mockReact.createElement(Text, null, modelLabel),
              )
            : mockReact.createElement(Text, null, modelLabel)
          : null,
        statusLabel ? mockReact.createElement(Text, null, statusLabel) : null,
        onStartNewChat
          ? mockReact.createElement(
              Pressable,
              {
                testID: 'new-chat-button',
                onPress: onStartNewChat,
                disabled: !canStartNewChat,
              },
              mockReact.createElement(Text, null, 'New chat'),
            )
          : null,
        onOpenModelControls
          ? mockReact.createElement(
              Pressable,
              {
                testID: 'model-controls-button',
                onPress: onOpenModelControls,
                disabled: !canOpenModelControls,
              },
              mockReact.createElement(Text, null, 'Model controls'),
            )
          : null,
      );
    },
  };
});

jest.mock('../../src/components/ui/ChatInputBar', () => {
  const mockReact = require('react');
  const { Pressable, Text, View } = require('react-native');

  return {
    markChatInputDraftConsumedError: (error: unknown) => {
      if (error && typeof error === 'object') {
        (error as { chatInputDraftConsumed?: true }).chatInputDraftConsumed = true;
      }
      return error;
    },
    ChatInputBar: (props: any) => {
      const {
        isSending,
        onStopGeneration,
        onSendMessage,
        modeLabel,
        attachmentsTray,
      } = props;
      lastChatInputBarProps = {
        ...props,
      };

      return mockReact.createElement(
        View,
        { testID: 'chat-input-bar' },
        modeLabel ? mockReact.createElement(Text, null, modeLabel) : null,
        attachmentsTray ?? null,
        mockReact.createElement(
          Pressable,
          { testID: 'send-button', onPress: () => onSendMessage('Edited from test') },
          mockReact.createElement(Text, null, 'Send'),
        ),
        isSending
          ? mockReact.createElement(
              Pressable,
              { testID: 'stop-button', onPress: onStopGeneration },
              mockReact.createElement(Text, null, 'Stop'),
            )
          : null,
      );
    },
  };
});

jest.mock('../../src/components/ui/ChatMessageBubble', () => {
  const mockReact = require('react');
  const { Pressable, Text, View } = require('react-native');

  return {
    ChatMessageBubble: ({ id, content, canRegenerate, onRegenerate, onDelete }: any) =>
      mockReact.createElement(
        View,
        null,
        mockReact.createElement(Text, null, content),
        canRegenerate && onRegenerate
          ? mockReact.createElement(
              Pressable,
              { testID: `regenerate-message-${id}`, onPress: () => onRegenerate(id) },
              mockReact.createElement(Text, null, 'Regenerate message'),
            )
          : null,
        onDelete
          ? mockReact.createElement(
              Pressable,
              { testID: `delete-message-${id}`, onPress: () => onDelete(id) },
              mockReact.createElement(Text, null, 'Delete message'),
            )
          : null,
      ),
  };
});

jest.mock('@/components/ui/PresetSelectorSheet', () => {
  const mockReact = require('react');
  const { Pressable, Text, View } = require('react-native');

  return {
    PresetSelectorSheet: (props: any) => {
      lastPresetSelectorProps = props;
      const { visible, onSelectPreset } = props;
      return visible
        ? mockReact.createElement(
            View,
            { testID: 'preset-selector' },
            mockReact.createElement(
              Pressable,
              {
                testID: 'preset-option-default',
                onPress: () => onSelectPreset(null),
              },
              mockReact.createElement(Text, null, 'Default preset'),
            ),
            mockReact.createElement(
              Pressable,
              {
                testID: 'preset-option-preset-2',
                onPress: () => onSelectPreset('preset-2'),
              },
              mockReact.createElement(Text, null, 'Preset 2'),
            ),
          )
        : null;
    },
  };
});

jest.mock('@/components/ui/ModelParametersSheet', () => {
  const mockReact = require('react');
  const { Pressable, Text, View } = require('react-native');

  return {
    ModelParametersSheet: (props: any) => {
      lastModelParametersSheetProps = props;
      const { visible, onReset, onResetParamField, onChangeParams, loadParamsDraft } = props;
      return visible
        ? mockReact.createElement(
            View,
            { testID: 'model-parameters-sheet' },
            mockReact.createElement(Text, { testID: 'context-size-value' }, String(loadParamsDraft.contextSize)),
            mockReact.createElement(
              Pressable,
              {
                testID: 'set-medium-reasoning-effort-button',
                onPress: () => onChangeParams({ reasoningEffort: 'medium' }),
              },
              mockReact.createElement(Text, null, 'Set medium reasoning effort'),
            ),
            mockReact.createElement(
              Pressable,
              {
                testID: 'reset-top-p-button',
                onPress: () => onResetParamField('topP'),
              },
              mockReact.createElement(Text, null, 'Reset Top-P'),
            ),
            mockReact.createElement(
              Pressable,
              {
                testID: 'reset-all-button',
                onPress: onReset,
              },
              mockReact.createElement(Text, null, 'Reset all'),
            ),
          )
        : null;
    },
  };
});

jest.mock('@/components/ui/ErrorReportSheet', () => {
  const mockReact = require('react');
  const { Text, View } = require('react-native');

  return {
    ErrorReportSheet: (props: any) => {
      lastErrorReportSheetProps = props;
      return props.visible
        ? mockReact.createElement(View, { testID: 'error-report-sheet' }, mockReact.createElement(Text, null, 'Error report'))
        : null;
    },
  };
});

jest.mock('@/components/ui/box', () => {
  const mockReact = require('react');
  const { View } = require('react-native');

  return {
    Box: ({ children, className: _className, ...props }: any) => mockReact.createElement(View, props, children),
  };
});

jest.mock('@/components/ui/text', () => {
  const mockReact = require('react');
  const { Text } = require('react-native');

  return {
    composeTextRole: (_role: string, className?: string) => className ?? '',
    Text: ({ children }: any) => mockReact.createElement(Text, null, children),
  };
});

jest.mock('@/components/ui/pressable', () => {
  const mockReact = require('react');
  const { Pressable } = require('react-native');

  return {
    Pressable: ({ children, ...props }: any) => mockReact.createElement(Pressable, props, children),
  };
});

jest.mock('../../src/hooks/useChatSession', () => ({
  useChatSession: () => ({
    activeThread: require('../../src/store/chatStore').useChatStore.getState().getActiveThread(),
    messages: require('../../src/store/chatStore').useChatStore.getState().getActiveThread()?.messages ?? [],
    messageListRevision: require('../../src/store/chatStore').useChatStore.getState().streamingRevision,
    isGenerating: require('../../src/store/chatStore').useChatStore.getState().getActiveThread()?.status === 'generating',
    shouldOfferSummary: Boolean(
      require('../../src/store/chatStore').useChatStore
        .getState()
        .getActiveThread()
        ?.messages?.length > 24,
    ),
    truncatedMessageCount: Math.max(
      (require('../../src/store/chatStore').useChatStore.getState().getActiveThread()?.messages?.length ?? 0) - 24,
      0,
    ),
    appendUserMessage: mockAppendUserMessage,
    deleteMessage: mockDeleteMessage,
    deleteThread: jest.fn(),
    stopGeneration: mockStop,
    regenerateFromUserMessage: mockRegenerateFromUserMessage,
    createSummaryPlaceholder: mockCreateSummaryPlaceholder,
    startNewChat: mockStartNewChat,
  }),
  resolvePresetSnapshot: (presetId: string | null) => {
    if (presetId === 'preset-2') {
      return {
        id: 'preset-2',
        name: 'Research Analyst',
        systemPrompt: 'Organize findings clearly.',
      };
    }

    if (presetId === 'preset-1') {
      return {
        id: 'preset-1',
        name: 'Helpful Assistant',
        systemPrompt: 'Be concise.',
      };
    }

    return {
      id: null,
      name: 'Default',
      systemPrompt: 'You are a helpful AI assistant.',
    };
  },
}));

jest.mock('../../src/services/HardwareListenerService', () => ({
  hardwareListenerService: {
    getCurrentStatus: () => ({
      isLowMemory: false,
      isConnected: true,
      networkType: 'wifi',
      thermalState: 'nominal',
    }),
    subscribe: (listener: (status: any) => void) => {
      hardwareStatusListener = listener;
      listener({
        isLowMemory: false,
        isConnected: true,
        networkType: 'wifi',
        thermalState: 'nominal',
      });
      return jest.fn();
    },
  },
  getChatHardwareBannerInputs: () => mockHardwareBannerInputs,
}));

const {
  ChatScreen,
  getFlashListAutoScrollBottomThreshold,
  getNextShouldStickToBottom,
  getAndroidFloatingComposerBottomOffset,
  getAndroidKeyboardOverlapCompensation,
  getAndroidKeyboardSpacerHeight,
  getChatListBottomChromeInset,
  getChatWarmupBannerBottomOffset,
  handleAndroidBackNavigation,
  resolveFallbackMultimodalReadiness,
  shouldRenderAndroidKeyboardSpacer,
  shouldFloatAndroidComposerOverContent,
} = require('../../src/ui/screens/ChatScreen');
const { useChatStore } = require('../../src/store/chatStore');
const {
  getSettings,
  UNKNOWN_MODEL_GPU_LAYERS_CEILING,
  updateSettings,
} = require('../../src/services/SettingsStore');
const { registry } = require('../../src/services/LocalStorageRegistry');
const { AppError } = require('../../src/services/AppError');
const { buildModelCapabilitySnapshot } = require('../../src/utils/modelCapabilities');
const { buildProjectorArtifactId } = require('../../src/utils/modelProjectors');
const VERIFIED_LOCAL_SHA256 = 'f'.repeat(64);
const copiedDraftImageAttachment = {
  id: 'draft-image-1',
  pickerUri: 'ph://library-image-1',
  previewUri: 'test-dir/chat-attachments/draft-image-1.jpg',
  localUri: 'test-dir/chat-attachments/draft-image-1.jpg',
  pathCategory: 'chat_attachment',
  mediaType: 'image/jpeg',
  fileName: 'draft-image-1.jpg',
  size: 123_456,
  width: 1024,
  height: 768,
  copyStatus: 'copied',
};
const consumedDraftImageAttachment = {
  ...copiedDraftImageAttachment,
  id: 'consumed-draft-image-1',
  localUri: 'test-dir/chat-attachments/consumed-draft-image-1.jpg',
  previewUri: 'test-dir/chat-attachments/consumed-draft-image-1.jpg',
  fileName: 'consumed-draft-image-1.jpg',
};
const secondConsumedDraftImageAttachment = {
  ...copiedDraftImageAttachment,
  id: 'consumed-draft-image-2',
  localUri: 'test-dir/chat-attachments/consumed-draft-image-2.jpg',
  previewUri: 'test-dir/chat-attachments/consumed-draft-image-2.jpg',
  fileName: 'consumed-draft-image-2.jpg',
};
const failedDraftImageAttachment = {
  pickerUri: 'ph://library-image-failed',
  previewUri: 'ph://library-image-failed',
  mediaType: 'image/jpeg',
  copyStatus: 'failed',
  errorReason: 'copy_failed',
};

function createVisionProjector(overrides: Partial<ProjectorArtifact> = {}): ProjectorArtifact {
  return {
    id: 'author/model-q4-mmproj',
    ownerModelId: 'author/model-q4',
    repoId: 'author/model-q4',
    fileName: 'mmproj.gguf',
    downloadUrl: 'https://example.com/mmproj.gguf',
    size: 32 * 1024 * 1024,
    localPath: 'author-model-q4-mmproj.gguf',
    lifecycleStatus: 'downloaded',
    matchStatus: 'matched',
    ...overrides,
  };
}

function getCanonicalVisionProjectorId(projector = createVisionProjector()): string {
  return buildProjectorArtifactId({
    repoId: projector.repoId,
    hfRevision: projector.hfRevision,
    ownerVariantId: projector.ownerVariantId,
    fileName: projector.fileName,
  });
}

function createVisionModel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'author/model-q4',
    name: 'Vision model',
    author: 'Test',
    size: 512 * 1024 * 1024,
    localPath: 'author-model-q4.gguf',
    lifecycleStatus: 'downloaded',
    chatModalities: ['text', 'vision'],
    ...overrides,
  };
}

function createReadyVisionModel(overrides: Record<string, unknown> = {}) {
  const projector = createVisionProjector();

  return createVisionModel({
    selectedProjectorId: projector.id,
    projectorCandidates: [projector],
    multimodalReadiness: {
      modelId: 'author/model-q4',
      status: 'ready',
      projectorId: projector.id,
      support: ['vision'],
      checkedAt: 1,
    },
    ...overrides,
  });
}

function setImageOnlyRegenerateThread() {
  useChatStore.setState({
    threads: {
      'thread-1': {
        ...useChatStore.getState().threads['thread-1'],
        messages: [
          {
            id: 'message-image-only',
            role: 'user',
            content: '',
            attachments: [{
              id: 'attachment-image-only',
              threadId: 'thread-1',
              messageId: 'message-image-only',
              localUri: 'test-dir/chat-attachments/image-only.jpg',
              pathCategory: 'chat_attachment',
              mediaType: 'image/jpeg',
              fileName: 'image-only.jpg',
              size: 123_456,
              source: 'photo_library',
              createdAt: 1,
            }],
            createdAt: 1,
            state: 'complete',
          },
          {
            id: 'message-2',
            role: 'assistant',
            content: 'Saved assistant reply',
            createdAt: 2,
            state: 'complete',
          },
        ],
      },
    },
    activeThreadId: 'thread-1',
  });
}

function setAudioOnlyRegenerateThread() {
  useChatStore.setState({
    threads: {
      'thread-1': {
        ...useChatStore.getState().threads['thread-1'],
        messages: [
          {
            id: 'message-audio-only',
            role: 'user',
            content: '',
            attachments: [{
              id: 'attachment-audio-only',
              kind: 'audio',
              state: 'ready',
              threadId: 'thread-1',
              messageId: 'message-audio-only',
              localUri: 'test-dir/chat-attachments/audio-only.mp3',
              pathCategory: 'chat_attachment',
              fileName: 'audio-only.mp3',
              mimeType: 'audio/mpeg',
              sizeBytes: 123_456,
              source: 'document_picker',
              createdAt: 1,
              audio: {
                format: 'mp3',
              },
            }],
            createdAt: 1,
            state: 'complete',
          },
          {
            id: 'message-2',
            role: 'assistant',
            content: 'Saved assistant reply',
            createdAt: 2,
            state: 'complete',
          },
        ],
      },
    },
    activeThreadId: 'thread-1',
  });
}

function setVideoOnlyRegenerateThread() {
  useChatStore.setState({
    threads: {
      'thread-1': {
        ...useChatStore.getState().threads['thread-1'],
        messages: [
          {
            id: 'message-video-only',
            role: 'user',
            content: '',
            attachments: [{
              id: 'attachment-video-only',
              kind: 'video',
              state: 'ready',
              threadId: 'thread-1',
              messageId: 'message-video-only',
              localUri: 'test-dir/chat-attachments/video-only.mp4',
              pathCategory: 'chat_attachment',
              fileName: 'video-only.mp4',
              mimeType: 'video/mp4',
              sizeBytes: 123_456,
              source: 'photo_library',
              createdAt: 1,
              video: {
                derivedAttachmentIds: [],
                samplingVersion: 1,
              },
            }],
            createdAt: 1,
            state: 'complete',
          },
          {
            id: 'message-2',
            role: 'assistant',
            content: 'Saved assistant reply',
            createdAt: 2,
            state: 'complete',
          },
        ],
      },
    },
    activeThreadId: 'thread-1',
  });
}

describe('ChatScreen', () => {
  const originalPlatformOS = Platform.OS;
  let alertSpy: jest.SpyInstance;

  beforeAll(() => {
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
  });

  afterAll(() => {
    alertSpy.mockRestore();
  });

  beforeEach(() => {
    reactI18nextMock.__resetTranslations();
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => originalPlatformOS });
    mockRegenerateFromUserMessage.mockClear();
    mockAppendUserMessage.mockReset();
    mockAppendUserMessage.mockResolvedValue(undefined);
    mockDeleteMessage.mockClear();
    mockStop.mockClear();
    mockCreateSummaryPlaceholder.mockClear();
    mockAttachImages.mockReset();
    mockAttachImages.mockResolvedValue(undefined);
    mockRemoveAttachmentDraft.mockClear();
    mockClearAttachmentDrafts.mockClear();
    mockClearFailedAttachmentDrafts.mockClear();
    mockCommitAttachmentDrafts.mockClear();
    mockConsumeAttachmentDrafts.mockReset();
    mockConsumeAttachmentDrafts.mockReturnValue([]);
    mockRestoreAttachmentDrafts.mockClear();
    mockDiscardAttachmentDrafts.mockClear();
    mockUseChatImageAttachments.mockReset();
    mockUseChatImageAttachments.mockImplementation(() => ({
      drafts: [],
      isPicking: false,
      remainingSlots: 4,
      attachImages: mockAttachImages,
      removeDraft: mockRemoveAttachmentDraft,
      clearDrafts: mockClearAttachmentDrafts,
      clearFailedDrafts: mockClearFailedAttachmentDrafts,
      commitDrafts: mockCommitAttachmentDrafts,
      consumeDraftsForSend: mockConsumeAttachmentDrafts,
      restoreDraftsForRetry: mockRestoreAttachmentDrafts,
      discardDrafts: mockDiscardAttachmentDrafts,
    }));
    mockRouterNavigate.mockClear();
    mockRouterPush.mockClear();
    mockRunBackendAutotune.mockReset();
    mockRunBackendAutotune.mockResolvedValue({
      createdAtMs: 1,
      modelId: 'author/model-q4',
      contextSize: 4096,
      kvCacheType: 'f16',
      candidates: [],
    });
    mockStartNewChat.mockClear();
    alertSpy.mockClear();
    lastPresetSelectorProps = null;
    lastModelParametersSheetProps = null;
    lastErrorReportSheetProps = null;
    lastChatHeaderProps = null;
    lastChatInputBarProps = null;
    mockLoadModel.mockReset();
    mockLoadModel.mockResolvedValue(undefined);
    hardwareStatusListener = null;
    mockHardwareBannerInputs = {
      showLowMemoryWarning: false,
      showThermalWarning: false,
      thermalState: 'nominal',
    };
  mockEngineState = {
    activeModelId: 'author/model-q4',
    loadProgress: 0,
    status: 'ready',
  };
    mockGetRecommendedGpuLayers.mockReset();
    mockGetRecommendedGpuLayers.mockImplementation(() => new Promise<number>(() => {}));
    mockGetRecommendedLoadProfile.mockReset();
    mockGetRecommendedLoadProfile.mockImplementation(() =>
      mockGetRecommendedGpuLayers().then((recommendedGpuLayers) => ({
        recommendedGpuLayers,
        gpuLayersCeiling: 512,
      })),
    );
    registry.saveModels([]);
    mockGetTotalMemory.mockClear();
    mockGetTotalMemory.mockResolvedValue(8 * 1024 * 1024 * 1024);
    mockRefreshModelMetadata.mockClear();
    mockRefreshModelMetadata.mockImplementation((model) => Promise.resolve(model));
    mockSafeModeLoadLimits = null;
    mockLoadedContextSize = null;
    mockLoadedGpuLayers = null;
    updateSettings({
      activeModelId: 'author/model-q4',
      activePresetId: 'preset-1',
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 512,
      modelParamsByModelId: {
        'author/model-q4': {
          temperature: 0.7,
          topP: 0.6,
          maxTokens: 1024,
          reasoningEffort: 'auto',
        },
      },
      modelLoadParamsByModelId: {},
    });
    useChatStore.setState({
      threads: {
        'thread-1': {
          id: 'thread-1',
          title: 'Restored conversation',
          modelId: 'author/model-q4',
          presetId: 'preset-1',
          presetSnapshot: {
            id: 'preset-1',
            name: 'Helpful Assistant',
            systemPrompt: 'Be concise.',
          },
          paramsSnapshot: {
            temperature: 0.7,
            topP: 0.6,
            maxTokens: 1024,
            reasoningEffort: 'auto',
          },
          messages: [
            {
              id: 'message-1',
              role: 'user',
              content: 'Saved user prompt',
              createdAt: 1,
              state: 'complete',
            },
            {
              id: 'message-2',
              role: 'assistant',
              content: 'Saved assistant reply',
              createdAt: 2,
              state: 'complete',
            },
          ],
          createdAt: 1,
          updatedAt: 2,
          status: 'idle',
        },
      },
      activeThreadId: 'thread-1',
    });
  });

  it('enables ready vision attachments and sends copied drafts with multimodal readiness', async () => {
    registry.saveModels([
      createReadyVisionModel(),
    ]);
    mockUseChatImageAttachments.mockImplementation((options) => ({
      drafts: [copiedDraftImageAttachment],
      isPicking: false,
      remainingSlots: 3,
      attachImages: mockAttachImages,
      removeDraft: mockRemoveAttachmentDraft,
      clearDrafts: mockClearAttachmentDrafts,
      commitDrafts: mockCommitAttachmentDrafts,
      consumeDraftsForSend: mockConsumeAttachmentDrafts,
      restoreDraftsForRetry: mockRestoreAttachmentDrafts,
      discardDrafts: mockDiscardAttachmentDrafts,
      options,
    }));
    mockConsumeAttachmentDrafts.mockReturnValueOnce([consumedDraftImageAttachment]);
    mockAppendUserMessage.mockImplementationOnce(async (_content, options) => {
      options?.onUserMessageAppended?.({ id: 'message-appended' });
    });

    render(React.createElement(ChatScreen));

    expect(mockUseChatImageAttachments.mock.calls[mockUseChatImageAttachments.mock.calls.length - 1][0]).toEqual(
      expect.objectContaining({
        enabled: true,
        disabledReason: 'chat.visionReadiness.ready',
      }),
    );
    expect(lastChatInputBarProps).toEqual(expect.objectContaining({
      attachmentDrafts: [copiedDraftImageAttachment],
      imageAttachmentsEnabled: true,
      imageAttachmentsDisabledReason: 'chat.visionReadiness.ready',
      audioAttachmentsSupported: false,
      audioAttachmentsEnabled: false,
      audioAttachmentsDisabledReason: 'chat.attachments.audioModelUnsupported',
      isImageAttachmentActionBusy: false,
    }));

    await act(async () => {
      await lastChatInputBarProps.onSendMessage('Describe this image');
    });

    expect(mockAppendUserMessage).toHaveBeenCalledWith(
      'Describe this image',
      expect.objectContaining({
        attachmentDrafts: [consumedDraftImageAttachment],
        multimodalReadiness: expect.objectContaining({
          status: 'ready',
          support: ['vision'],
        }),
        onUserMessageAppended: expect.any(Function),
      }),
    );
    expect(mockConsumeAttachmentDrafts).toHaveBeenCalledTimes(1);
    expect(mockCommitAttachmentDrafts).not.toHaveBeenCalled();
  });

  it('does not reuse stale mixed readiness for audio-only model metadata', () => {
    const projector = createVisionProjector();
    const model = createVisionModel({
      chatModalities: ['text', 'audio'],
      selectedProjectorId: projector.id,
      projectorCandidates: [projector],
      multimodalReadiness: {
        modelId: 'author/model-q4',
        status: 'ready',
        projectorId: projector.id,
        support: ['audio'],
        requestedSupport: ['vision', 'audio'],
        checkedAt: 1,
      },
    });

    expect(resolveFallbackMultimodalReadiness(model, 'author/model-q4')).toEqual(
      expect.objectContaining({
        modelId: 'author/model-q4',
        status: 'initializing',
        projectorId: getCanonicalVisionProjectorId(projector),
        support: [],
        requestedSupport: ['audio'],
      }),
    );

    registry.saveModels([model]);

    render(React.createElement(ChatScreen));

    expect(lastChatInputBarProps).toEqual(expect.objectContaining({
      imageAttachmentsEnabled: false,
      imageAttachmentsDisabledReason: 'chat.visionReadiness.initializing',
      audioAttachmentsSupported: true,
      audioAttachmentsEnabled: false,
      audioAttachmentsDisabledReason: 'chat.attachments.audioRuntimeUnavailable',
    }));
  });

  it('reports runtime unavailable when the displayed audio model differs from the engine model', () => {
    const projector = createVisionProjector();
    registry.saveModels([
      createVisionModel({
        chatModalities: ['text', 'audio'],
        selectedProjectorId: projector.id,
        projectorCandidates: [projector],
        multimodalReadiness: {
          modelId: 'author/model-q4',
          status: 'ready',
          projectorId: projector.id,
          support: ['audio'],
          requestedSupport: ['audio'],
          checkedAt: 1,
        },
      }),
    ]);
    mockEngineState = {
      activeModelId: 'other/model',
      status: 'ready',
    };

    render(React.createElement(ChatScreen));

    expect(lastChatInputBarProps).toEqual(expect.objectContaining({
      audioAttachmentsSupported: true,
      audioAttachmentsEnabled: false,
      audioAttachmentsDisabledReason: 'chat.attachments.audioRuntimeUnavailable',
    }));
  });

  it('never enables image attachments for an active audio-only variant', () => {
    const projector = createVisionProjector({ ownerVariantId: 'audio-variant' });
    const model = createVisionModel({
      chatModalities: ['text', 'vision'],
      activeVariantId: 'audio-variant',
      resolvedFileName: 'audio.gguf',
      variants: [{
        variantId: 'audio-variant',
        fileName: 'audio.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 1,
        chatModalities: ['text', 'audio'],
        projectorCandidates: [projector],
        selectedProjectorId: projector.id,
      }],
      selectedProjectorId: projector.id,
      projectorCandidates: [projector],
      multimodalReadiness: {
        modelId: 'author/model-q4',
        variantId: 'audio-variant',
        status: 'ready',
        projectorId: projector.id,
        support: ['audio'],
        requestedSupport: ['audio'],
        checkedAt: 1,
      },
    });
    registry.saveModels([model]);

    render(React.createElement(ChatScreen));

    expect(lastChatInputBarProps).toEqual(expect.objectContaining({
      imageAttachmentsEnabled: false,
      imageAttachmentsDisabledReason: 'chat.visionReadiness.unsupported',
      audioAttachmentsSupported: true,
      audioAttachmentsEnabled: true,
    }));
  });

  it('does not request stale audio readiness owned by another model', () => {
    const projector = createVisionProjector();
    const model = createVisionModel({
      chatModalities: undefined,
      selectedProjectorId: projector.id,
      projectorCandidates: [projector],
      multimodalReadiness: {
        modelId: 'other/model',
        status: 'ready',
        projectorId: projector.id,
        support: ['audio'],
        requestedSupport: ['audio'],
        checkedAt: 1,
      },
    });

    expect(resolveFallbackMultimodalReadiness(model, 'author/model-q4')).toEqual(expect.objectContaining({
      modelId: 'author/model-q4',
      status: 'initializing',
      projectorId: getCanonicalVisionProjectorId(projector),
      support: [],
      requestedSupport: ['vision'],
    }));
  });

  it.each([
    {
      label: 'vision-only',
      parentModalities: ['text', 'audio'] as const,
      variantModalities: ['text', 'vision'] as const,
      support: ['vision'] as const,
      expectedImageEnabled: true,
      expectedAudioEnabled: false,
    },
    {
      label: 'mixed',
      parentModalities: ['text'] as const,
      variantModalities: ['text', 'vision', 'audio'] as const,
      support: ['vision', 'audio'] as const,
      expectedImageEnabled: true,
      expectedAudioEnabled: true,
    },
  ])('enables exact composer modalities for an active $label variant', ({
    label,
    parentModalities,
    variantModalities,
    support,
    expectedImageEnabled,
    expectedAudioEnabled,
  }) => {
    const variantId = `${label}-variant`;
    const projector = createVisionProjector({ ownerVariantId: variantId });
    const model = createVisionModel({
      chatModalities: [...parentModalities],
      activeVariantId: variantId,
      resolvedFileName: `${label}.gguf`,
      variants: [{
        variantId,
        fileName: `${label}.gguf`,
        quantizationLabel: 'Q4_K_M',
        size: 1,
        chatModalities: [...variantModalities],
        projectorCandidates: [projector],
        selectedProjectorId: projector.id,
      }],
      selectedProjectorId: projector.id,
      projectorCandidates: [projector],
      multimodalReadiness: {
        modelId: 'author/model-q4',
        variantId,
        status: 'ready',
        projectorId: projector.id,
        support: [...support],
        requestedSupport: [...support],
        checkedAt: 1,
      },
    });
    registry.saveModels([model]);

    render(React.createElement(ChatScreen));

    expect(resolveFallbackMultimodalReadiness(model, model.id)).toEqual(expect.objectContaining({
      status: 'ready',
      variantId,
      projectorId: projector.id,
      support: [...support],
      requestedSupport: [...support],
    }));
    expect(lastChatInputBarProps).toEqual(expect.objectContaining({
      imageAttachmentsEnabled: expectedImageEnabled,
      imageAttachmentsDisabledReason: 'chat.visionReadiness.ready',
      audioAttachmentsSupported: expectedAudioEnabled,
      audioAttachmentsEnabled: expectedAudioEnabled,
    }));
  });

  it('uses initializing fallback for vision models with a selected downloaded projector and no persisted readiness', () => {
    registry.saveModels([
      createVisionModel({
        selectedProjectorId: 'author/model-q4-mmproj',
        projectorCandidates: [
          createVisionProjector({
            matchStatus: 'user_selected',
          }),
        ],
      }),
    ]);
    mockUseChatImageAttachments.mockImplementation((options) => ({
      drafts: [],
      isPicking: false,
      remainingSlots: 4,
      attachImages: mockAttachImages,
      removeDraft: mockRemoveAttachmentDraft,
      clearDrafts: mockClearAttachmentDrafts,
      commitDrafts: mockCommitAttachmentDrafts,
      consumeDraftsForSend: mockConsumeAttachmentDrafts,
      restoreDraftsForRetry: mockRestoreAttachmentDrafts,
      discardDrafts: mockDiscardAttachmentDrafts,
      options,
    }));
    mockConsumeAttachmentDrafts.mockReturnValueOnce([consumedDraftImageAttachment]);

    render(React.createElement(ChatScreen));

    expect(mockUseChatImageAttachments.mock.calls[mockUseChatImageAttachments.mock.calls.length - 1][0]).toEqual(
      expect.objectContaining({
        enabled: false,
        disabledReason: 'chat.visionReadiness.initializing',
      }),
    );
    expect(lastChatInputBarProps).toEqual(expect.objectContaining({
      imageAttachmentsEnabled: false,
      imageAttachmentsDisabledReason: 'chat.visionReadiness.initializing',
    }));
    expect(lastChatInputBarProps.imageAttachmentsDisabledReason).not.toBe('chat.visionReadiness.missingProjector');
    expect(resolveFallbackMultimodalReadiness(registry.getModel('author/model-q4'), 'author/model-q4')).toEqual(
      expect.objectContaining({
        status: 'initializing',
        projectorId: getCanonicalVisionProjectorId(),
        requestedSupport: ['vision'],
      }),
    );
  });

  it('uses initializing fallback for a single downloaded projector without a selected projector id', () => {
    const model = createVisionModel({
      projectorCandidates: [createVisionProjector()],
    });

    expect(resolveFallbackMultimodalReadiness(model, 'author/model-q4')).toEqual(
      expect.objectContaining({
        modelId: 'author/model-q4',
        status: 'initializing',
        projectorId: getCanonicalVisionProjectorId(),
        requestedSupport: ['vision'],
      }),
    );

    registry.saveModels([model]);
    render(React.createElement(ChatScreen));

    expect(lastChatInputBarProps).toEqual(expect.objectContaining({
      imageAttachmentsEnabled: false,
      imageAttachmentsDisabledReason: 'chat.visionReadiness.initializing',
    }));
  });

  it('uses projector fallback readiness for audio-only model metadata', () => {
    const projector = createVisionProjector();
    const model = createVisionModel({
      chatModalities: ['text', 'audio'],
      selectedProjectorId: projector.id,
      projectorCandidates: [projector],
    });

    expect(resolveFallbackMultimodalReadiness(model, 'author/model-q4')).toEqual(
      expect.objectContaining({
        modelId: 'author/model-q4',
        status: 'initializing',
        projectorId: getCanonicalVisionProjectorId(projector),
        support: [],
        requestedSupport: ['audio'],
      }),
    );
  });

  it('preserves checked unsupported readiness for audio-only model metadata', () => {
    const projector = createVisionProjector();
    const model = createVisionModel({
      chatModalities: ['text', 'audio'],
      selectedProjectorId: projector.id,
      multimodalReadiness: {
        modelId: 'author/model-q4',
        status: 'unsupported',
        projectorId: projector.id,
        support: [],
        requestedSupport: ['audio'],
        failureReason: 'runtime_did_not_report_audio',
        checkedAt: 1,
      },
      projectorCandidates: [projector],
    });

    expect(resolveFallbackMultimodalReadiness(model, 'author/model-q4')).toEqual(
      expect.objectContaining({
        modelId: 'author/model-q4',
        status: 'unsupported',
        projectorId: projector.id,
        support: [],
        requestedSupport: ['audio'],
      }),
    );
  });

  it('does not preserve legacy ready readiness when requested native modalities expand', () => {
    const projector = createVisionProjector();
    const model = createVisionModel({
      chatModalities: ['text', 'vision', 'audio'],
      selectedProjectorId: projector.id,
      multimodalReadiness: {
        modelId: 'author/model-q4',
        status: 'ready',
        projectorId: projector.id,
        support: ['vision'],
        checkedAt: 1,
      },
      projectorCandidates: [projector],
    });

    expect(resolveFallbackMultimodalReadiness(model, 'author/model-q4')).toEqual(
      expect.objectContaining({
        modelId: 'author/model-q4',
        status: 'initializing',
        projectorId: getCanonicalVisionProjectorId(projector),
        support: [],
        requestedSupport: ['vision', 'audio'],
      }),
    );
  });

  it('preserves partial ready readiness after all requested native modalities were checked', () => {
    const projector = createVisionProjector();
    const model = createVisionModel({
      chatModalities: ['text', 'vision', 'audio'],
      selectedProjectorId: projector.id,
      multimodalReadiness: {
        modelId: 'author/model-q4',
        status: 'ready',
        projectorId: projector.id,
        support: ['vision'],
        requestedSupport: ['vision', 'audio'],
        checkedAt: 1,
      },
      projectorCandidates: [projector],
    });

    expect(resolveFallbackMultimodalReadiness(model, 'author/model-q4')).toEqual(
      expect.objectContaining({
        modelId: 'author/model-q4',
        status: 'ready',
        projectorId: projector.id,
        support: ['vision'],
        requestedSupport: ['vision', 'audio'],
      }),
    );
  });

  it('uses runtime-compatible fallback when projector metadata is present before chat modalities hydrate', () => {
    const model = createVisionModel({
      chatModalities: undefined,
      projectorCandidates: [createVisionProjector()],
    });

    expect(resolveFallbackMultimodalReadiness(model, 'author/model-q4')).toEqual(
      expect.objectContaining({
        modelId: 'author/model-q4',
        status: 'initializing',
        projectorId: getCanonicalVisionProjectorId(),
        requestedSupport: ['vision'],
      }),
    );
  });

  it('refreshes stale persisted missing-projector readiness when projector metadata hydrates', () => {
    const model = createVisionModel({
      multimodalReadiness: {
        modelId: 'author/model-q4',
        status: 'missing_projector',
        support: [],
        checkedAt: 1,
      },
      projectorCandidates: [createVisionProjector()],
    });

    expect(resolveFallbackMultimodalReadiness(model, 'author/model-q4')).toEqual(
      expect.objectContaining({
        modelId: 'author/model-q4',
        status: 'initializing',
        projectorId: getCanonicalVisionProjectorId(),
        requestedSupport: ['vision'],
      }),
    );
  });

  it('does not preserve stale ready readiness when current projector resolution is missing', () => {
    const model = createVisionModel({
      multimodalReadiness: {
        modelId: 'author/model-q4',
        status: 'ready',
        projectorId: 'author/model-q4-mmproj',
        support: ['vision'],
        checkedAt: 1,
      },
    });

    expect(resolveFallbackMultimodalReadiness(model, 'author/model-q4')).toEqual(
      expect.objectContaining({
        modelId: 'author/model-q4',
        status: 'missing_projector',
        support: [],
        requestedSupport: ['vision'],
      }),
    );
  });

  it('does not preserve stale ready readiness when current projector resolution is ambiguous', () => {
    const model = createVisionModel({
      multimodalReadiness: {
        modelId: 'author/model-q4',
        status: 'ready',
        projectorId: 'author/model-q4-mmproj-a',
        support: ['vision'],
        checkedAt: 1,
      },
      projectorCandidates: [
        createVisionProjector({
          id: 'author/model-q4-mmproj-a',
          fileName: 'mmproj-a.gguf',
          downloadUrl: 'https://example.com/mmproj-a.gguf',
        }),
        createVisionProjector({
          id: 'author/model-q4-mmproj-b',
          fileName: 'mmproj-b.gguf',
          downloadUrl: 'https://example.com/mmproj-b.gguf',
        }),
      ],
    });

    expect(resolveFallbackMultimodalReadiness(model, 'author/model-q4')).toEqual(
      expect.objectContaining({
        modelId: 'author/model-q4',
        status: 'ambiguous_projector',
        support: [],
        requestedSupport: ['vision'],
      }),
    );
  });

  it.each([
    ['available', 'missing_projector'],
    ['queued', 'projector_downloading'],
    ['downloading', 'projector_downloading'],
    ['paused', 'projector_downloading'],
    ['failed', 'failed'],
  ] as const)(
    'does not preserve stale ready readiness for a %s selected projector',
    (lifecycleStatus, expectedStatus) => {
      const model = createVisionModel({
        selectedProjectorId: 'author/model-q4-mmproj',
        multimodalReadiness: {
          modelId: 'author/model-q4',
          status: 'ready',
          projectorId: 'author/model-q4-mmproj',
          support: ['vision'],
          checkedAt: 1,
        },
        projectorCandidates: [
          createVisionProjector({
            lifecycleStatus,
            matchReason: lifecycleStatus === 'failed' ? 'Checksum mismatch' : undefined,
          }),
        ],
      });

      expect(resolveFallbackMultimodalReadiness(model, 'author/model-q4')).toEqual(
        expect.objectContaining({
          modelId: 'author/model-q4',
          status: expectedStatus,
          support: [],
          requestedSupport: ['vision'],
        }),
      );
    },
  );

  it('preserves unsupported runtime readiness only for the same downloaded projector', () => {
    const model = createVisionModel({
      selectedProjectorId: 'author/model-q4-mmproj',
      multimodalReadiness: {
        modelId: 'author/model-q4',
        status: 'unsupported',
        projectorId: 'author/model-q4-mmproj',
        support: [],
        requestedSupport: ['vision'],
        checkedAt: 1,
      },
      projectorCandidates: [createVisionProjector()],
    });

    expect(resolveFallbackMultimodalReadiness(model, 'author/model-q4')).toEqual(
      expect.objectContaining({
        status: 'unsupported',
        projectorId: 'author/model-q4-mmproj',
      }),
    );
  });

  it('preserves a runtime failure for the same downloaded projector until runtime refresh succeeds', () => {
    const model = createVisionModel({
      multimodalReadiness: {
        modelId: 'author/model-q4',
        status: 'failed',
        projectorId: 'author/model-q4-mmproj',
        support: ['vision'],
        requestedSupport: ['vision'],
        failureReason: 'Runtime init failed',
        checkedAt: 1,
      },
      projectorCandidates: [createVisionProjector()],
    });

    expect(resolveFallbackMultimodalReadiness(model, 'author/model-q4')).toEqual(
      expect.objectContaining({
        status: 'failed',
        projectorId: 'author/model-q4-mmproj',
        failureReason: 'Runtime init failed',
      }),
    );
  });

  it.each(['downloading', 'paused'] as const)(
    'uses projector_downloading fallback for a %s projector',
    (lifecycleStatus) => {
      const model = createVisionModel({
        projectorCandidates: [createVisionProjector({ lifecycleStatus })],
      });

      expect(resolveFallbackMultimodalReadiness(model, 'author/model-q4')).toEqual(
        expect.objectContaining({
          modelId: 'author/model-q4',
          status: 'projector_downloading',
          projectorId: getCanonicalVisionProjectorId(),
          requestedSupport: ['vision'],
        }),
      );
    },
  );

  it('uses failed fallback with projector id and failure reason for a failed projector', () => {
    const model = createVisionModel({
      projectorCandidates: [
        createVisionProjector({
          lifecycleStatus: 'failed',
          matchReason: 'Checksum mismatch',
        }),
      ],
    });

    expect(resolveFallbackMultimodalReadiness(model, 'author/model-q4')).toEqual(
      expect.objectContaining({
        modelId: 'author/model-q4',
        status: 'failed',
        projectorId: getCanonicalVisionProjectorId(),
        failureReason: 'Checksum mismatch',
        requestedSupport: ['vision'],
      }),
    );
  });

  it('sends copied drafts for an image-only composer submission', async () => {
    registry.saveModels([
      createReadyVisionModel(),
    ]);
    mockUseChatImageAttachments.mockImplementation(() => ({
      drafts: [copiedDraftImageAttachment],
      isPicking: false,
      remainingSlots: 3,
      attachImages: mockAttachImages,
      removeDraft: mockRemoveAttachmentDraft,
      clearDrafts: mockClearAttachmentDrafts,
      commitDrafts: mockCommitAttachmentDrafts,
      consumeDraftsForSend: mockConsumeAttachmentDrafts,
      restoreDraftsForRetry: mockRestoreAttachmentDrafts,
      discardDrafts: mockDiscardAttachmentDrafts,
    }));
    mockConsumeAttachmentDrafts.mockReturnValueOnce([consumedDraftImageAttachment]);
    mockAppendUserMessage.mockImplementationOnce(async (_content, options) => {
      options?.onUserMessageAppended?.({ id: 'message-appended' });
    });

    render(React.createElement(ChatScreen));

    await act(async () => {
      await lastChatInputBarProps.onSendMessage('');
    });

    expect(mockAppendUserMessage).toHaveBeenCalledWith(
      '',
      expect.objectContaining({
        attachmentDrafts: [consumedDraftImageAttachment],
        multimodalReadiness: expect.objectContaining({ status: 'ready' }),
        onUserMessageAppended: expect.any(Function),
      }),
    );
    expect(mockConsumeAttachmentDrafts).toHaveBeenCalledTimes(1);
    expect(mockCommitAttachmentDrafts).not.toHaveBeenCalled();
  });

  it('sends only copied drafts and clears failed leftovers after success', async () => {
    registry.saveModels([
      createReadyVisionModel(),
    ]);
    mockUseChatImageAttachments.mockImplementation(() => ({
      drafts: [copiedDraftImageAttachment, failedDraftImageAttachment],
      isPicking: false,
      remainingSlots: 2,
      attachImages: mockAttachImages,
      removeDraft: mockRemoveAttachmentDraft,
      clearDrafts: mockClearAttachmentDrafts,
      clearFailedDrafts: mockClearFailedAttachmentDrafts,
      commitDrafts: mockCommitAttachmentDrafts,
      consumeDraftsForSend: mockConsumeAttachmentDrafts,
      restoreDraftsForRetry: mockRestoreAttachmentDrafts,
      discardDrafts: mockDiscardAttachmentDrafts,
    }));
    mockConsumeAttachmentDrafts.mockReturnValueOnce([consumedDraftImageAttachment]);

    render(React.createElement(ChatScreen));

    await act(async () => {
      await lastChatInputBarProps.onSendMessage('Describe this image');
    });

    expect(mockAppendUserMessage).toHaveBeenCalledWith(
      'Describe this image',
      expect.objectContaining({
        attachmentDrafts: [consumedDraftImageAttachment],
        multimodalReadiness: expect.objectContaining({ status: 'ready' }),
      }),
    );
    expect(mockConsumeAttachmentDrafts).toHaveBeenCalledTimes(1);
    expect(mockClearFailedAttachmentDrafts).toHaveBeenCalledTimes(1);
  });

  it('sends text without attachment options and clears failed drafts when only failed drafts remain', async () => {
    registry.saveModels([
      createReadyVisionModel(),
    ]);
    mockUseChatImageAttachments.mockImplementation(() => ({
      drafts: [failedDraftImageAttachment],
      isPicking: false,
      remainingSlots: 3,
      attachImages: mockAttachImages,
      removeDraft: mockRemoveAttachmentDraft,
      clearDrafts: mockClearAttachmentDrafts,
      clearFailedDrafts: mockClearFailedAttachmentDrafts,
      commitDrafts: mockCommitAttachmentDrafts,
      consumeDraftsForSend: mockConsumeAttachmentDrafts,
      restoreDraftsForRetry: mockRestoreAttachmentDrafts,
      discardDrafts: mockDiscardAttachmentDrafts,
    }));
    mockConsumeAttachmentDrafts.mockReturnValueOnce([]);

    render(React.createElement(ChatScreen));

    await act(async () => {
      await lastChatInputBarProps.onSendMessage('Send text only');
    });

    expect(mockAppendUserMessage).toHaveBeenCalledWith(
      'Send text only',
      expect.not.objectContaining({
        attachmentDrafts: expect.anything(),
      }),
    );
    expect(mockConsumeAttachmentDrafts).toHaveBeenCalledTimes(1);
    expect(mockClearFailedAttachmentDrafts).toHaveBeenCalledTimes(1);
  });

  it('keeps consumed copied drafts and clears failed leftovers when generation fails after append', async () => {
    registry.saveModels([
      createReadyVisionModel(),
    ]);
    mockAppendUserMessage.mockImplementationOnce(async (_content, options) => {
      options?.onUserMessageAppended?.({ id: 'message-appended' });
      throw new Error('generation failed');
    });
    mockUseChatImageAttachments.mockImplementation(() => ({
      drafts: [copiedDraftImageAttachment, failedDraftImageAttachment],
      isPicking: false,
      remainingSlots: 2,
      attachImages: mockAttachImages,
      removeDraft: mockRemoveAttachmentDraft,
      clearDrafts: mockClearAttachmentDrafts,
      clearFailedDrafts: mockClearFailedAttachmentDrafts,
      commitDrafts: mockCommitAttachmentDrafts,
      consumeDraftsForSend: mockConsumeAttachmentDrafts,
      restoreDraftsForRetry: mockRestoreAttachmentDrafts,
      discardDrafts: mockDiscardAttachmentDrafts,
    }));
    mockConsumeAttachmentDrafts.mockReturnValueOnce([consumedDraftImageAttachment]);

    render(React.createElement(ChatScreen));

    let thrown: unknown;
    await act(async () => {
      try {
        await lastChatInputBarProps.onSendMessage('Describe this image');
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toEqual(expect.objectContaining({
      message: 'generation failed',
      chatInputDraftConsumed: true,
    }));
    expect(mockConsumeAttachmentDrafts).toHaveBeenCalledTimes(1);
    expect(mockCommitAttachmentDrafts).not.toHaveBeenCalled();
    expect(mockDiscardAttachmentDrafts).not.toHaveBeenCalled();
    expect(mockClearFailedAttachmentDrafts).toHaveBeenCalledTimes(1);
    expect(mockClearAttachmentDrafts).not.toHaveBeenCalled();
    expect(lastChatInputBarProps.draft).toBe('');
  });

  it('restores consumed copied drafts and retains failed drafts when attachment send fails before append', async () => {
    registry.saveModels([
      createReadyVisionModel(),
    ]);
    mockAppendUserMessage.mockRejectedValueOnce(new Error('send failed'));
    mockUseChatImageAttachments.mockImplementation(() => ({
      drafts: [copiedDraftImageAttachment, failedDraftImageAttachment],
      isPicking: false,
      remainingSlots: 2,
      attachImages: mockAttachImages,
      removeDraft: mockRemoveAttachmentDraft,
      clearDrafts: mockClearAttachmentDrafts,
      clearFailedDrafts: mockClearFailedAttachmentDrafts,
      commitDrafts: mockCommitAttachmentDrafts,
      consumeDraftsForSend: mockConsumeAttachmentDrafts,
      restoreDraftsForRetry: mockRestoreAttachmentDrafts,
      discardDrafts: mockDiscardAttachmentDrafts,
    }));
    mockConsumeAttachmentDrafts.mockReturnValueOnce([consumedDraftImageAttachment]);

    render(React.createElement(ChatScreen));

    let thrown: unknown;
    await act(async () => {
      try {
        await lastChatInputBarProps.onSendMessage('Describe this image');
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toEqual(expect.objectContaining({ message: 'send failed' }));
    expect(mockConsumeAttachmentDrafts).toHaveBeenCalledTimes(1);
    expect(mockRestoreAttachmentDrafts).toHaveBeenCalledWith([consumedDraftImageAttachment]);
    expect(mockDiscardAttachmentDrafts).not.toHaveBeenCalled();
    expect(mockClearFailedAttachmentDrafts).not.toHaveBeenCalled();
    expect(mockCommitAttachmentDrafts).not.toHaveBeenCalled();
    expect(mockClearAttachmentDrafts).not.toHaveBeenCalled();
  });

  it('discards consumed copied drafts when their copied file is missing before append', async () => {
    registry.saveModels([
      createReadyVisionModel(),
    ]);
    mockAppendUserMessage.mockRejectedValueOnce(
      new AppError('chat_attachment_missing', 'Attachment file is missing.', {
        details: {
          attachmentId: consumedDraftImageAttachment.id,
          attachmentIds: [consumedDraftImageAttachment.id],
        },
      }),
    );
    mockUseChatImageAttachments.mockImplementation(() => ({
      drafts: [copiedDraftImageAttachment],
      isPicking: false,
      remainingSlots: 3,
      attachImages: mockAttachImages,
      removeDraft: mockRemoveAttachmentDraft,
      clearDrafts: mockClearAttachmentDrafts,
      commitDrafts: mockCommitAttachmentDrafts,
      consumeDraftsForSend: mockConsumeAttachmentDrafts,
      restoreDraftsForRetry: mockRestoreAttachmentDrafts,
      discardDrafts: mockDiscardAttachmentDrafts,
    }));
    mockConsumeAttachmentDrafts.mockReturnValueOnce([consumedDraftImageAttachment]);

    render(React.createElement(ChatScreen));

    await act(async () => {
      try {
        await lastChatInputBarProps.onSendMessage('Describe this image');
      } catch {
        // expected
      }
    });

    expect(mockConsumeAttachmentDrafts).toHaveBeenCalledTimes(1);
    expect(mockDiscardAttachmentDrafts).toHaveBeenCalledWith([consumedDraftImageAttachment], 'missing copied drafts after failed send');
    expect(mockRestoreAttachmentDrafts).not.toHaveBeenCalled();
  });

  it('discards id-less consumed copied drafts when a missing attachment error has no usable ids', async () => {
    registry.saveModels([
      createReadyVisionModel(),
    ]);
    const idlessConsumedDraft = {
      ...consumedDraftImageAttachment,
      id: undefined,
      localUri: 'test-dir/chat-attachments/idless-draft.jpg',
      previewUri: 'test-dir/chat-attachments/idless-draft-thumb.jpg',
    };
    mockAppendUserMessage.mockRejectedValueOnce(
      new AppError('chat_attachment_missing', 'Attachment file is missing.', {
        details: {
          attachmentIds: [],
          pathCategories: ['chat_attachment'],
        },
      }),
    );
    mockUseChatImageAttachments.mockImplementation(() => ({
      drafts: [copiedDraftImageAttachment],
      isPicking: false,
      remainingSlots: 3,
      attachImages: mockAttachImages,
      removeDraft: mockRemoveAttachmentDraft,
      clearDrafts: mockClearAttachmentDrafts,
      commitDrafts: mockCommitAttachmentDrafts,
      consumeDraftsForSend: mockConsumeAttachmentDrafts,
      restoreDraftsForRetry: mockRestoreAttachmentDrafts,
      discardDrafts: mockDiscardAttachmentDrafts,
    }));
    mockConsumeAttachmentDrafts.mockReturnValueOnce([idlessConsumedDraft]);

    render(React.createElement(ChatScreen));

    await act(async () => {
      try {
        await lastChatInputBarProps.onSendMessage('Describe this image');
      } catch {
        // expected
      }
    });

    expect(mockConsumeAttachmentDrafts).toHaveBeenCalledTimes(1);
    expect(mockDiscardAttachmentDrafts).toHaveBeenCalledWith(
      [idlessConsumedDraft],
      'missing copied drafts after failed send',
    );
    expect(mockRestoreAttachmentDrafts).not.toHaveBeenCalled();
  });

  it('only discards missing consumed drafts and restores remaining copied drafts before append', async () => {
    registry.saveModels([
      createReadyVisionModel(),
    ]);
    mockAppendUserMessage.mockRejectedValueOnce(
      new AppError('chat_attachment_missing', 'Attachment file is missing.', {
        details: {
          attachmentIds: [consumedDraftImageAttachment.id],
        },
      }),
    );
    mockUseChatImageAttachments.mockImplementation(() => ({
      drafts: [copiedDraftImageAttachment],
      isPicking: false,
      remainingSlots: 2,
      attachImages: mockAttachImages,
      removeDraft: mockRemoveAttachmentDraft,
      clearDrafts: mockClearAttachmentDrafts,
      commitDrafts: mockCommitAttachmentDrafts,
      consumeDraftsForSend: mockConsumeAttachmentDrafts,
      restoreDraftsForRetry: mockRestoreAttachmentDrafts,
      discardDrafts: mockDiscardAttachmentDrafts,
    }));
    mockConsumeAttachmentDrafts.mockReturnValueOnce([
      consumedDraftImageAttachment,
      secondConsumedDraftImageAttachment,
    ]);

    render(React.createElement(ChatScreen));

    await act(async () => {
      try {
        await lastChatInputBarProps.onSendMessage('Describe this image');
      } catch {
        // expected
      }
    });

    expect(mockDiscardAttachmentDrafts).toHaveBeenCalledWith(
      [consumedDraftImageAttachment],
      'missing copied drafts after failed send',
    );
    expect(mockRestoreAttachmentDrafts).toHaveBeenCalledWith([secondConsumedDraftImageAttachment]);
  });

  it('sends text only without committing copied drafts when readiness turns off', async () => {
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Text model',
        author: 'Test',
        size: 512 * 1024 * 1024,
        localPath: 'author-model-q4.gguf',
        lifecycleStatus: 'downloaded',
        chatModalities: ['text'],
        multimodalReadiness: {
          modelId: 'author/model-q4',
          status: 'text_only',
          support: [],
          checkedAt: 1,
        },
      },
    ]);
    mockUseChatImageAttachments.mockImplementation((options) => ({
      drafts: [copiedDraftImageAttachment],
      isPicking: false,
      remainingSlots: 3,
      attachImages: mockAttachImages,
      removeDraft: mockRemoveAttachmentDraft,
      clearDrafts: mockClearAttachmentDrafts,
      commitDrafts: mockCommitAttachmentDrafts,
      consumeDraftsForSend: mockConsumeAttachmentDrafts,
      restoreDraftsForRetry: mockRestoreAttachmentDrafts,
      discardDrafts: mockDiscardAttachmentDrafts,
      options,
    }));

    render(React.createElement(ChatScreen));

    expect(mockUseChatImageAttachments.mock.calls[mockUseChatImageAttachments.mock.calls.length - 1][0]).toEqual(
      expect.objectContaining({
        enabled: false,
        disabledReason: 'chat.visionReadiness.textOnly',
      }),
    );
    expect(lastChatInputBarProps).toEqual(expect.objectContaining({
      imageAttachmentsEnabled: false,
      imageAttachmentsDisabledReason: 'chat.visionReadiness.textOnly',
    }));

    await act(async () => {
      await lastChatInputBarProps.onSendMessage('Describe this image');
    });

    expect(mockAppendUserMessage).toHaveBeenCalledWith(
      'Describe this image',
      expect.not.objectContaining({
        attachmentDrafts: expect.anything(),
      }),
    );
    expect(mockCommitAttachmentDrafts).not.toHaveBeenCalled();
    expect(mockClearAttachmentDrafts).not.toHaveBeenCalled();
  });

  it('keeps auto-scroll armed when content grows without user dragging the list', () => {
    expect(
      getNextShouldStickToBottom(
        true,
        {
          contentOffset: { x: 0, y: 0 },
          contentSize: { width: 320, height: 1200 },
          layoutMeasurement: { width: 320, height: 640 },
        },
        false,
      ),
    ).toBe(true);
  });

  it('turns off auto-scroll only after the user drags away from the bottom', () => {
    expect(
      getNextShouldStickToBottom(
        true,
        {
          contentOffset: { x: 0, y: 240 },
          contentSize: { width: 320, height: 1200 },
          layoutMeasurement: { width: 320, height: 640 },
        },
        true,
      ),
    ).toBe(false);
  });

  describe('exported helper functions', () => {
    it('getNextShouldStickToBottom returns current value when not interacting or metrics are invalid', () => {
      expect(getNextShouldStickToBottom(false, {
        contentOffset: { x: 0, y: 0 },
        contentSize: { width: 0, height: 1000 },
        layoutMeasurement: { width: 0, height: 500 },
      }, false)).toBe(false);

      expect(getNextShouldStickToBottom(true, {
        contentOffset: { x: 0, y: Number.NaN },
        contentSize: { width: 0, height: 1000 },
        layoutMeasurement: { width: 0, height: 500 },
      }, true)).toBe(true);
    });

    it('getNextShouldStickToBottom arms/disarms based on distance from bottom with hysteresis', () => {
      // at bottom (distance=0) => arm
      expect(getNextShouldStickToBottom(false, {
        contentOffset: { x: 0, y: 500 },
        contentSize: { width: 0, height: 1000 },
        layoutMeasurement: { width: 0, height: 500 },
      }, true)).toBe(true);

      // far from bottom (distance=500) => disarm
      expect(getNextShouldStickToBottom(true, {
        contentOffset: { x: 0, y: 0 },
        contentSize: { width: 0, height: 1000 },
        layoutMeasurement: { width: 0, height: 500 },
      }, true)).toBe(false);

      // within hysteresis band (distance=50) => keep current
      expect(getNextShouldStickToBottom(true, {
        contentOffset: { x: 0, y: 450 },
        contentSize: { width: 0, height: 1000 },
        layoutMeasurement: { width: 0, height: 500 },
      }, true)).toBe(true);
      expect(getNextShouldStickToBottom(false, {
        contentOffset: { x: 0, y: 450 },
        contentSize: { width: 0, height: 1000 },
        layoutMeasurement: { width: 0, height: 500 },
      }, true)).toBe(false);
    });

    it('getFlashListAutoScrollBottomThreshold and handleAndroidBackNavigation cover edge cases', () => {
      expect(getFlashListAutoScrollBottomThreshold(0)).toBe(0.02);
      expect(getFlashListAutoScrollBottomThreshold(-10)).toBe(0.02);
      expect(getFlashListAutoScrollBottomThreshold(20)).toBe(1);
      expect(getFlashListAutoScrollBottomThreshold(1600)).toBe(0.02);

      const onGoBack = jest.fn();
      expect(handleAndroidBackNavigation({ canGoBack: false, onGoBack })).toBe(false);
      expect(handleAndroidBackNavigation({ canGoBack: true, onGoBack })).toBe(true);
      expect(onGoBack).toHaveBeenCalledTimes(1);
    });
  });
  it('keeps auto-scroll armed after a small scroll near the bottom', () => {
    expect(
      getNextShouldStickToBottom(
        true,
        {
          contentOffset: { x: 0, y: 548 },
          contentSize: { width: 320, height: 1200 },
          layoutMeasurement: { width: 320, height: 640 },
        },
        true,
      ),
    ).toBe(true);
  });

  it('keeps auto-scroll stable inside the hysteresis band', () => {
    const scrollEvent = {
      contentOffset: { x: 0, y: 520 },
      contentSize: { width: 320, height: 1200 },
      layoutMeasurement: { width: 320, height: 640 },
    };

    expect(getNextShouldStickToBottom(true, scrollEvent, true)).toBe(true);
    expect(getNextShouldStickToBottom(false, scrollEvent, true)).toBe(false);
  });

  it('re-arms auto-scroll only when the user scrolls back to the bottom', () => {
    expect(
      getNextShouldStickToBottom(
        false,
        {
          contentOffset: { x: 0, y: 556 },
          contentSize: { width: 320, height: 1200 },
          layoutMeasurement: { width: 320, height: 640 },
        },
        true,
      ),
    ).toBe(true);
  });

  it('converts the FlashList bottom threshold from pixels into a viewport ratio', () => {
    expect(getFlashListAutoScrollBottomThreshold(640)).toBeCloseTo(32 / 640);
    expect(getFlashListAutoScrollBottomThreshold(1)).toBe(1);
    expect(getFlashListAutoScrollBottomThreshold(0)).toBe(0.02);
  });

  it('uses the measured list viewport height to compute the FlashList bottom threshold', () => {
    const { getByTestId } = render(React.createElement(ChatScreen));

    expect(getByTestId('chat-flash-list').props.maintainVisibleContentPosition.autoscrollToBottomThreshold).toBe(0.02);

    act(() => {
      fireEvent(getByTestId('chat-list-viewport'), 'layout', {
        nativeEvent: {
          layout: {
            x: 0,
            y: 0,
            width: 320,
            height: 640,
          },
        },
      });
    });

    expect(getByTestId('chat-flash-list').props.maintainVisibleContentPosition.autoscrollToBottomThreshold)
      .toBeCloseTo(32 / 640);
  });

  it('passes the chat content blur target to floating chrome and modal sheets', () => {
    const { getByTestId } = render(React.createElement(ChatScreen));

    const blurTarget = lastPresetSelectorProps?.androidContentBlurTargetRef;
    const contentBlurTarget = getByTestId('chat-warmup-content-blur-target');

    expect(contentBlurTarget).toBeTruthy();
    expect(blurTarget).toBeTruthy();
    expect(lastChatInputBarProps?.androidContentBlurTargetRef).toBe(blurTarget);
    expect(lastModelParametersSheetProps?.androidContentBlurTargetRef).toBe(blurTarget);
    expect(lastErrorReportSheetProps?.androidContentBlurTargetRef).toBe(blurTarget);
    expect(() => contentBlurTarget.findByProps({ testID: 'chat-input-bar' })).toThrow();
  });

  it('clears the list-touch guard after drag end so auto-follow can resume without touchEnd', () => {
    jest.useFakeTimers();
    const originalRequestAnimationFrame = global.requestAnimationFrame;
    const rafSpy = jest.fn((callback: FrameRequestCallback) => originalRequestAnimationFrame(callback));
    global.requestAnimationFrame = rafSpy as typeof global.requestAnimationFrame;

    try {
      const { getByTestId } = render(React.createElement(ChatScreen));

      // Ignore any initial auto-follow scheduling from mount effects.
      rafSpy.mockClear();

      fireEvent(getByTestId('chat-flash-list'), 'scrollBeginDrag', {
        nativeEvent: {
          contentOffset: { x: 0, y: 556 },
          contentSize: { width: 320, height: 1200 },
          layoutMeasurement: { width: 320, height: 640 },
        },
      });

      // Drag ends near the bottom and should re-arm auto-follow.
      fireEvent(getByTestId('chat-flash-list'), 'scrollEndDrag', {
        nativeEvent: {
          contentOffset: { x: 0, y: 556 },
          contentSize: { width: 320, height: 1200 },
          layoutMeasurement: { width: 320, height: 640 },
        },
      });

      act(() => {
        jest.runOnlyPendingTimers();
      });

      rafSpy.mockClear();
      fireEvent(getByTestId('chat-flash-list'), 'contentSizeChange', 320, 1400);

      expect(rafSpy).toHaveBeenCalledTimes(1);
    } finally {
      global.requestAnimationFrame = originalRequestAnimationFrame;
      jest.useRealTimers();
    }
  });

  it('compensates only the portion of the Android keyboard that still overlaps the resized viewport', () => {
    expect(getAndroidKeyboardOverlapCompensation({
      baseWindowHeight: 2400,
      currentWindowHeight: 2140,
      keyboardHeight: 320,
    })).toBe(60);
  });

  it('keeps only a small gap when the tab bar area is already part of the covered keyboard space', () => {
    expect(getAndroidKeyboardOverlapCompensation({
      baseWindowHeight: 2400,
      currentWindowHeight: 2154,
      keyboardHeight: 320,
      coveredBottomInset: 74,
      gap: 12,
    })).toBe(12);
  });

  it('keeps enough spacer to lift the composer above the keyboard when resize alone is not enough', () => {
    expect(getAndroidKeyboardSpacerHeight({
      viewportCompensation: 20,
      composerBottomY: 2190,
      keyboardTopY: 2140,
    })).toBe(58);
  });

  it('reduces an overestimated Android keyboard spacer after measuring the composer gap', () => {
    expect(getAndroidKeyboardSpacerHeight({
      viewportCompensation: 240,
      currentSpacerHeight: 240,
      composerBottomY: 1900,
      keyboardTopY: 2140,
      gap: 12,
    })).toBe(12);
  });

  it('keeps the current Android keyboard spacer while composer coordinates are missing', () => {
    expect(getAndroidKeyboardSpacerHeight({
      viewportCompensation: 20,
      currentSpacerHeight: 72,
      composerBottomY: null,
      keyboardTopY: null,
      gap: 12,
    })).toBe(72);
  });

  it('ignores sub-pixel Android keyboard spacer deltas to avoid measurement jitter', () => {
    expect(getAndroidKeyboardSpacerHeight({
      viewportCompensation: 20,
      currentSpacerHeight: 48,
      composerBottomY: 2128.25,
      keyboardTopY: 2140,
      gap: 12,
    })).toBe(48);
  });

  it('keeps the Android glass composer floating across keyboard visibility changes', () => {
    expect(shouldFloatAndroidComposerOverContent({
      platform: 'android',
      surfaceKind: 'glass',
      isKeyboardVisible: false,
    })).toBe(true);
    expect(shouldFloatAndroidComposerOverContent({
      platform: 'android',
      surfaceKind: 'solid',
      isKeyboardVisible: false,
    })).toBe(false);
    expect(shouldFloatAndroidComposerOverContent({
      platform: 'android',
      surfaceKind: 'glass',
      isKeyboardVisible: true,
    })).toBe(true);
    expect(shouldFloatAndroidComposerOverContent({
      platform: 'ios',
      surfaceKind: 'glass',
      isKeyboardVisible: false,
    })).toBe(false);
  });

  it('uses the tab bar inset for the hidden-keyboard Android floating composer position', () => {
    expect(getAndroidFloatingComposerBottomOffset({
      tabBarInset: 92,
      androidKeyboardInset: 0,
      isKeyboardVisible: false,
      gap: 12,
    })).toBe(92);
  });

  it('uses the measured keyboard inset for the visible-keyboard Android floating composer position', () => {
    expect(getAndroidFloatingComposerBottomOffset({
      tabBarInset: 92,
      androidKeyboardInset: 220,
      isKeyboardVisible: true,
      gap: 12,
    })).toBe(220);
  });

  it('keeps a minimum keyboard gap before the first Android composer measurement settles', () => {
    expect(getAndroidFloatingComposerBottomOffset({
      tabBarInset: 92,
      androidKeyboardInset: 0,
      isKeyboardVisible: true,
      gap: 12,
    })).toBe(12);
  });

  it('reserves stable list padding for the floating Android composer while the keyboard is hidden', () => {
    expect(getChatListBottomChromeInset({
      composerContainerHeight: 64,
      tabBarInset: 92,
      androidKeyboardInset: 0,
      shouldFloatComposerOverContent: true,
      isKeyboardVisible: false,
      gap: 12,
    })).toBe(168);
  });

  it('reserves stable list padding for the floating Android composer while the keyboard is visible', () => {
    expect(getChatListBottomChromeInset({
      composerContainerHeight: 64,
      tabBarInset: 92,
      androidKeyboardInset: 220,
      shouldFloatComposerOverContent: true,
      isKeyboardVisible: true,
      gap: 12,
    })).toBe(296);
  });

  it('does not reserve composer height in list padding when the composer is in normal flow', () => {
    expect(getChatListBottomChromeInset({
      composerContainerHeight: 64,
      tabBarInset: 92,
      androidKeyboardInset: 220,
      shouldFloatComposerOverContent: false,
      isKeyboardVisible: true,
      gap: 12,
    })).toBe(92);
  });

  it('does not render an Android keyboard spacer when the composer already floats above the keyboard', () => {
    expect(shouldRenderAndroidKeyboardSpacer({
      platform: 'android',
      shouldFloatComposerOverContent: true,
      androidKeyboardInset: 220,
    })).toBe(false);
  });

  it('renders an Android keyboard spacer only for normal-flow composer positioning', () => {
    expect(shouldRenderAndroidKeyboardSpacer({
      platform: 'android',
      shouldFloatComposerOverContent: false,
      androidKeyboardInset: 220,
    })).toBe(true);
    expect(shouldRenderAndroidKeyboardSpacer({
      platform: 'ios',
      shouldFloatComposerOverContent: false,
      androidKeyboardInset: 220,
    })).toBe(false);
  });

  it('keeps the warmup banner above the floating Android composer and tab bar', () => {
    expect(getChatWarmupBannerBottomOffset({
      composerContainerHeight: 64,
      tabBarInset: 92,
      androidKeyboardInset: 0,
      shouldFloatComposerOverContent: true,
    })).toBe(156);
  });

  it('keeps the warmup banner above the floating Android composer and keyboard', () => {
    expect(getChatWarmupBannerBottomOffset({
      composerContainerHeight: 64,
      tabBarInset: 92,
      androidKeyboardInset: 220,
      shouldFloatComposerOverContent: true,
      isKeyboardVisible: true,
    })).toBe(284);
  });

  it('keeps the warmup banner above the Android keyboard spacer when the composer is not floating', () => {
    expect(getChatWarmupBannerBottomOffset({
      composerContainerHeight: 64,
      tabBarInset: 92,
      androidKeyboardInset: 220,
      shouldFloatComposerOverContent: false,
    })).toBe(284);
  });

  it('uses stack history first for Android back when chat was pushed from another screen', () => {
    const onGoBack = jest.fn();

    expect(handleAndroidBackNavigation({
      canGoBack: true,
      onGoBack,
    })).toBe(true);
    expect(onGoBack).toHaveBeenCalledTimes(1);
  });

  it('lets the navigator fall through when there is no stack history for Android back', () => {
    const onGoBack = jest.fn();

    expect(handleAndroidBackNavigation({
      canGoBack: false,
      onGoBack,
    })).toBe(false);
    expect(onGoBack).not.toHaveBeenCalled();
  });

  it('renders messages from the restored active thread', () => {
    const { getByTestId, getByText, queryByText } = render(React.createElement(ChatScreen));

    expect(getByTestId('chat-keyboard-avoiding-view')).toBeTruthy();
    expect(getByText('Restored conversation')).toBeTruthy();
    expect(getByText('Helpful Assistant')).toBeTruthy();
    expect(getByText('model-q4')).toBeTruthy();
    expect(getByText('Saved user prompt')).toBeTruthy();
    expect(getByText('Saved assistant reply')).toBeTruthy();
    expect(queryByText('T0.7 • P0.6 • K40 • 1024 tok')).toBeNull();
  });

  it('passes the stable presentation list and latest transient assistant to FlashList', () => {
    const { getByTestId, rerender } = render(React.createElement(ChatScreen));
    let assistantId = '';

    act(() => {
      assistantId = useChatStore.getState().createAssistantPlaceholder('thread-1');
    });
    rerender(React.createElement(ChatScreen));

    const messagesAfterPlaceholder = useChatStore.getState().getActiveThread()!.messages;
    expect(getByTestId('chat-flash-list').props.data).toBe(messagesAfterPlaceholder);
    expect(getByTestId('chat-flash-list').props.data.at(-1)).toEqual(expect.objectContaining({
      id: assistantId,
      content: '',
      state: 'streaming',
    }));

    act(() => {
      useChatStore.getState().patchAssistantMessage('thread-1', assistantId, {
        content: 'Latest transient answer',
        thoughtContent: 'Transient reasoning',
        tokensPerSec: 7.25,
        state: 'streaming',
      });
    });
    rerender(React.createElement(ChatScreen));

    const flashList = getByTestId('chat-flash-list');
    expect(useChatStore.getState().getActiveThread()!.messages).toBe(messagesAfterPlaceholder);
    expect(flashList.props.data).toBe(messagesAfterPlaceholder);
    expect(flashList.props.data.at(-1)).toEqual(expect.objectContaining({
      id: assistantId,
      content: 'Latest transient answer',
      thoughtContent: 'Transient reasoning',
      tokensPerSec: 7.25,
      state: 'streaming',
    }));
    expect(flashList.props.extraData).toContain(`${assistantId}:streaming:23:7.25:1`);

    act(() => {
      useChatStore.getState().patchAssistantMessage('thread-1', assistantId, {
        content: 'Newest transient answer',
        thoughtContent: 'Changed reasoning',
        tokensPerSec: 7.25,
      });
    });
    rerender(React.createElement(ChatScreen));

    const flashListAfterSameLengthSnapshot = getByTestId('chat-flash-list');
    expect(flashListAfterSameLengthSnapshot.props.data).toBe(messagesAfterPlaceholder);
    expect(flashListAfterSameLengthSnapshot.props.data.at(-1)).toEqual(expect.objectContaining({
      id: assistantId,
      content: 'Newest transient answer',
      thoughtContent: 'Changed reasoning',
      tokensPerSec: 7.25,
    }));
    expect(flashListAfterSameLengthSnapshot.props.extraData)
      .toContain(`${assistantId}:streaming:23:7.25:2`);

    act(() => {
      useChatStore.getState().stopAssistantMessage('thread-1', assistantId);
    });
  });

  it('does not disable auto-follow after a tap during generation', () => {
    jest.useFakeTimers();
    try {
    useChatStore.setState({
      threads: {
        ...useChatStore.getState().threads,
        'thread-1': {
          ...useChatStore.getState().threads['thread-1'],
          status: 'generating',
        },
      },
      activeThreadId: 'thread-1',
    });

    const { getByTestId } = render(React.createElement(ChatScreen));

    expect(getByTestId('chat-flash-list').props.maintainVisibleContentPosition.autoscrollToBottomThreshold).toBe(0.02);

    fireEvent(getByTestId('chat-flash-list'), 'touchStart');

    expect(getByTestId('chat-flash-list').props.maintainVisibleContentPosition.autoscrollToBottomThreshold).toBe(-1);

    fireEvent(getByTestId('chat-flash-list'), 'touchEnd');

    expect(getByTestId('chat-flash-list').props.maintainVisibleContentPosition.autoscrollToBottomThreshold).toBe(0.02);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps auto-scroll paused after an upward swipe even if the list is still near the bottom', () => {
    jest.useFakeTimers();
    try {
    useChatStore.setState({
      threads: {
        ...useChatStore.getState().threads,
        'thread-1': {
          ...useChatStore.getState().threads['thread-1'],
          status: 'generating',
        },
      },
      activeThreadId: 'thread-1',
    });

    const { getByTestId } = render(React.createElement(ChatScreen));

    fireEvent(getByTestId('chat-flash-list'), 'touchStart');
    expect(getByTestId('chat-flash-list').props.maintainVisibleContentPosition.autoscrollToBottomThreshold).toBe(-1);

    fireEvent(getByTestId('chat-flash-list'), 'scrollBeginDrag', {
      nativeEvent: {
        contentOffset: { x: 0, y: 560 },
        contentSize: { width: 320, height: 1200 },
        layoutMeasurement: { width: 320, height: 640 },
      },
    });

    // User swipes upward but remains within the bottom re-arm threshold.
    fireEvent(getByTestId('chat-flash-list'), 'scrollEndDrag', {
      nativeEvent: {
        contentOffset: { x: 0, y: 540 },
        contentSize: { width: 320, height: 1200 },
        layoutMeasurement: { width: 320, height: 640 },
      },
    });

    act(() => {
      jest.runOnlyPendingTimers();
    });

    expect(getByTestId('chat-flash-list').props.maintainVisibleContentPosition.autoscrollToBottomThreshold).toBe(-1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('re-arms auto-scroll only after momentum ends when the user flings to the bottom', () => {
    useChatStore.setState({
      threads: {
        ...useChatStore.getState().threads,
        'thread-1': {
          ...useChatStore.getState().threads['thread-1'],
          status: 'generating',
        },
      },
      activeThreadId: 'thread-1',
    });

    const { getByTestId } = render(React.createElement(ChatScreen));

    fireEvent(getByTestId('chat-flash-list'), 'scrollBeginDrag', {
      nativeEvent: {
        contentOffset: { x: 0, y: 240 },
        contentSize: { width: 320, height: 1200 },
        layoutMeasurement: { width: 320, height: 640 },
      },
    });
    fireEvent(getByTestId('chat-flash-list'), 'scrollEndDrag', {
      nativeEvent: {
        contentOffset: { x: 0, y: 240 },
        contentSize: { width: 320, height: 1200 },
        layoutMeasurement: { width: 320, height: 640 },
      },
    });

    expect(getByTestId('chat-flash-list').props.maintainVisibleContentPosition.autoscrollToBottomThreshold).toBe(-1);

    fireEvent(getByTestId('chat-flash-list'), 'momentumScrollBegin', {
      nativeEvent: {
        contentOffset: { x: 0, y: 240 },
        contentSize: { width: 320, height: 1200 },
        layoutMeasurement: { width: 320, height: 640 },
      },
    });
    fireEvent(getByTestId('chat-flash-list'), 'momentumScrollEnd', {
      nativeEvent: {
        contentOffset: { x: 0, y: 560 },
        contentSize: { width: 320, height: 1200 },
        layoutMeasurement: { width: 320, height: 640 },
      },
    });

    expect(getByTestId('chat-flash-list').props.maintainVisibleContentPosition.autoscrollToBottomThreshold).toBe(0.02);
  });

  it('defers auto-follow scheduling while the list is touched and flushes it after touch ends', () => {
    jest.useFakeTimers();
    const originalRequestAnimationFrame = global.requestAnimationFrame;
    const rafSpy = jest.fn((callback: FrameRequestCallback) => originalRequestAnimationFrame(callback));
    global.requestAnimationFrame = rafSpy as typeof global.requestAnimationFrame;

    try {
      useChatStore.setState({
        threads: {
          ...useChatStore.getState().threads,
          'thread-1': {
            ...useChatStore.getState().threads['thread-1'],
            status: 'generating',
          },
        },
        activeThreadId: 'thread-1',
      });

      const { getByTestId } = render(React.createElement(ChatScreen));

      // Ignore any initial auto-follow scheduling from mount effects.
      rafSpy.mockClear();

      fireEvent(getByTestId('chat-flash-list'), 'touchStart');
      fireEvent(getByTestId('chat-flash-list'), 'contentSizeChange', 320, 1400);

      expect(rafSpy).not.toHaveBeenCalled();

      fireEvent(getByTestId('chat-flash-list'), 'touchEnd');

      act(() => {
        jest.runOnlyPendingTimers();
      });

      expect(rafSpy).toHaveBeenCalledTimes(1);
    } finally {
      global.requestAnimationFrame = originalRequestAnimationFrame;
      jest.useRealTimers();
    }
  });

  it('does not restore bottom anchoring after a drag when touchEnd fires last', () => {
    const { getByTestId } = render(React.createElement(ChatScreen));

    fireEvent(getByTestId('chat-flash-list'), 'touchStart');

    fireEvent(getByTestId('chat-flash-list'), 'scrollBeginDrag', {
      nativeEvent: {
        contentOffset: { x: 0, y: 240 },
        contentSize: { width: 320, height: 1200 },
        layoutMeasurement: { width: 320, height: 640 },
      },
    });

    fireEvent.scroll(getByTestId('chat-flash-list'), {
      nativeEvent: {
        contentOffset: { x: 0, y: 240 },
        contentSize: { width: 320, height: 1200 },
        layoutMeasurement: { width: 320, height: 640 },
      },
    });

    fireEvent(getByTestId('chat-flash-list'), 'scrollEndDrag', {
      nativeEvent: {
        contentOffset: { x: 0, y: 240 },
        contentSize: { width: 320, height: 1200 },
        layoutMeasurement: { width: 320, height: 640 },
      },
    });
    fireEvent(getByTestId('chat-flash-list'), 'touchEnd');

    expect(getByTestId('chat-flash-list').props.maintainVisibleContentPosition.autoscrollToBottomThreshold).toBe(-1);
  });

  it('disables the model selector contract on the chat header by default', () => {
    render(React.createElement(ChatScreen));

    expect(lastChatHeaderProps.modelSelectable).toBe(false);
    expect(lastChatHeaderProps.canOpenModelSelector).toBe(false);
  });

  it('opens a downloaded-only model selector from the header badge', () => {
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Model Q4',
        author: 'Test',
        size: 1024,
        localPath: 'model-q4.gguf',
        lifecycleStatus: 'downloaded',
      },
      {
        id: 'author/model-q8',
        name: 'Model Q8',
        author: 'Test',
        size: 1024,
        localPath: 'model-q8.gguf',
        lifecycleStatus: 'downloaded',
      },
      {
        id: 'author/model-remote',
        name: 'Remote model',
        author: 'Test',
        size: 1024,
        lifecycleStatus: 'available',
      },
    ]);

    const { getByTestId, queryByTestId, rerender } = render(React.createElement(ChatScreen));

    expect(lastChatHeaderProps.modelSelectable).toBe(true);
    expect(lastChatHeaderProps.canOpenModelSelector).toBe(true);

    fireEvent.press(getByTestId('model-selector-button'));

    expect(getByTestId('chat-model-selector-sheet')).toBeTruthy();
    expect(getByTestId('model-option-author/model-q4')).toBeTruthy();
    expect(getByTestId('model-option-author/model-q8')).toBeTruthy();
    expect(queryByTestId('model-option-author/model-remote')).toBeNull();
  });

  it('switches models inside the existing thread when selecting another model', async () => {
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Model Q4',
        author: 'Test',
        size: 1024,
        localPath: 'model-q4.gguf',
        lifecycleStatus: 'downloaded',
      },
      {
        id: 'author/model-q8',
        name: 'Model Q8',
        author: 'Test',
        size: 1024,
        localPath: 'model-q8.gguf',
        lifecycleStatus: 'downloaded',
      },
    ]);

    const { getByTestId, queryByTestId, rerender } = render(React.createElement(ChatScreen));
    const beforeThread = useChatStore.getState().getActiveThread();

    fireEvent.press(getByTestId('model-selector-button'));
    expect(getByTestId('chat-model-selector-sheet')).toBeTruthy();

    await act(async () => {
      fireEvent.press(getByTestId('model-option-author/model-q8'));
    });

    const afterThread = useChatStore.getState().getActiveThread();

    expect(mockLoadModel).toHaveBeenCalled();
    expect(afterThread?.id).toBe(beforeThread?.id);
    expect(afterThread?.activeModelId).toBe('author/model-q8');
    expect(afterThread?.messages.some((message: any) => message.kind === 'model_switch')).toBe(true);

    expect(queryByTestId('chat-model-selector-sheet')).toBeNull();
    expect(lastChatHeaderProps.modelLabel).toBe('model-q8');
  });

  it('treats the current thread model as active in model controls after an in-chat switch', async () => {
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Model Q4',
        author: 'Test',
        size: 1024,
        localPath: 'model-q4.gguf',
        lifecycleStatus: 'downloaded',
      },
      {
        id: 'author/model-q8',
        name: 'Model Q8',
        author: 'Test',
        size: 1024,
        localPath: 'model-q8.gguf',
        lifecycleStatus: 'downloaded',
      },
    ]);
    updateSettings({ activeModelId: 'author/model-q4' });

    const { getByTestId } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-selector-button'));
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.press(getByTestId('model-option-author/model-q8'));
    });

    expect(useChatStore.getState().getActiveThread()?.activeModelId).toBe('author/model-q8');

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    expect(lastModelParametersSheetProps?.modelId).toBe('author/model-q8');
    expect(lastModelParametersSheetProps?.applyAction).toBe('reload');
  });

  it('closes the selector and updates the header immediately while the model is still loading', async () => {
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Model Q4',
        author: 'Test',
        size: 1024,
        localPath: 'model-q4.gguf',
        lifecycleStatus: 'downloaded',
      },
      {
        id: 'author/model-q8',
        name: 'Model Q8',
        author: 'Test',
        size: 1024,
        localPath: 'model-q8.gguf',
        lifecycleStatus: 'downloaded',
      },
    ]);

    const deferredLoad = createDeferred<void>();
    mockLoadModel.mockImplementationOnce(() => deferredLoad.promise);

    const { getByTestId, queryByTestId } = render(React.createElement(ChatScreen));

    fireEvent.press(getByTestId('model-selector-button'));
    expect(getByTestId('chat-model-selector-sheet')).toBeTruthy();

    fireEvent.press(getByTestId('model-option-author/model-q8'));

    const { getThreadActiveModelId } = require('../../src/types/chat');

    expect(queryByTestId('chat-model-selector-sheet')).toBeNull();
    expect(lastChatHeaderProps.modelLabel).toBe('model-q8');
    expect(getThreadActiveModelId(useChatStore.getState().getActiveThread())).toBe('author/model-q4');

    await act(async () => {
      deferredLoad.resolve(undefined);
      await deferredLoad.promise;
    });

    expect(useChatStore.getState().getActiveThread()?.activeModelId).toBe('author/model-q8');
  });

  it('keeps model switching disabled in other chats while a model load is pending', async () => {
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Model Q4',
        author: 'Test',
        size: 1024,
        localPath: 'model-q4.gguf',
        lifecycleStatus: 'downloaded',
      },
      {
        id: 'author/model-q6',
        name: 'Model Q6',
        author: 'Test',
        size: 1024,
        localPath: 'model-q6.gguf',
        lifecycleStatus: 'downloaded',
      },
      {
        id: 'author/model-q8',
        name: 'Model Q8',
        author: 'Test',
        size: 1024,
        localPath: 'model-q8.gguf',
        lifecycleStatus: 'downloaded',
      },
    ]);

    useChatStore.setState((state: any) => ({
      threads: {
        ...state.threads,
        'thread-2': {
          ...state.threads['thread-1'],
          id: 'thread-2',
          title: 'Second conversation',
          modelId: 'author/model-q6',
          activeModelId: 'author/model-q6',
          updatedAt: 3,
        },
      },
      activeThreadId: 'thread-1',
    }));

    const deferredLoad = createDeferred<void>();
    mockLoadModel.mockImplementationOnce(() => deferredLoad.promise);

    const { getByTestId, queryByTestId, rerender } = render(React.createElement(ChatScreen));

    fireEvent.press(getByTestId('model-selector-button'));
    fireEvent.press(getByTestId('model-option-author/model-q8'));

    expect(queryByTestId('chat-model-selector-sheet')).toBeNull();
    expect(lastChatHeaderProps.canOpenModelSelector).toBe(false);
    expect(lastChatHeaderProps.canOpenModelControls).toBe(false);

    act(() => {
      useChatStore.setState({ activeThreadId: 'thread-2' });
    });
    rerender(React.createElement(ChatScreen));

    await waitFor(() => {
      expect(lastChatHeaderProps.title).toBe('Second conversation');
      expect(lastChatHeaderProps.modelLabel).toBe('model-q6');
      expect(lastChatHeaderProps.canOpenModelSelector).toBe(false);
      expect(lastChatHeaderProps.canOpenModelControls).toBe(false);
    });

    await act(async () => {
      deferredLoad.resolve(undefined);
      await deferredLoad.promise;
    });

    expect(useChatStore.getState().threads['thread-1']?.activeModelId).toBe('author/model-q8');
    expect(useChatStore.getState().threads['thread-2']?.activeModelId).toBe('author/model-q6');

    await waitFor(() => {
      expect(lastChatHeaderProps.canOpenModelSelector).toBe(true);
      expect(lastChatHeaderProps.canOpenModelControls).toBe(true);
    });
  });

  it('clears pending model selection for a new chat after the engine model updates', async () => {
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Model Q4',
        author: 'Test',
        size: 1024,
        localPath: 'model-q4.gguf',
        lifecycleStatus: 'downloaded',
      },
      {
        id: 'author/model-q8',
        name: 'Model Q8',
        author: 'Test',
        size: 1024,
        localPath: 'model-q8.gguf',
        lifecycleStatus: 'downloaded',
      },
    ]);

    useChatStore.setState({ activeThreadId: null });

    const deferredLoad = createDeferred<void>();
    mockLoadModel.mockImplementationOnce(async () => {
      await deferredLoad.promise;
      updateSettings({ activeModelId: 'author/model-q8' });
    });

    const { getByTestId, queryByTestId } = render(React.createElement(ChatScreen));

    fireEvent.press(getByTestId('model-selector-button'));
    fireEvent.press(getByTestId('model-option-author/model-q8'));

    expect(queryByTestId('chat-model-selector-sheet')).toBeNull();
    expect(lastChatHeaderProps.modelLabel).toBe('model-q8');
    expect(lastChatHeaderProps.canOpenModelSelector).toBe(false);

    await act(async () => {
      deferredLoad.resolve(undefined);
      await deferredLoad.promise;
    });

    await waitFor(() => {
      expect(lastChatHeaderProps.modelLabel).toBe('model-q8');
      expect(lastChatHeaderProps.canOpenModelSelector).toBe(true);
      expect(lastChatHeaderProps.canOpenModelControls).toBe(true);
    });
  });

  it('clears pending model selection after leaving a new chat before the model load finishes', async () => {
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Model Q4',
        author: 'Test',
        size: 1024,
        localPath: 'model-q4.gguf',
        lifecycleStatus: 'downloaded',
      },
      {
        id: 'author/model-q8',
        name: 'Model Q8',
        author: 'Test',
        size: 1024,
        localPath: 'model-q8.gguf',
        lifecycleStatus: 'downloaded',
      },
    ]);

    useChatStore.setState({ activeThreadId: null });

    const deferredLoad = createDeferred<void>();
    mockLoadModel.mockImplementationOnce(() => deferredLoad.promise);

    const { getByTestId, rerender } = render(React.createElement(ChatScreen));

    fireEvent.press(getByTestId('model-selector-button'));
    await act(async () => {
      fireEvent.press(getByTestId('model-option-author/model-q8'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(lastChatHeaderProps.modelLabel).toBe('model-q8');
      expect(lastChatHeaderProps.canOpenModelSelector).toBe(false);
      expect(lastChatHeaderProps.canOpenModelControls).toBe(false);
    });

    act(() => {
      useChatStore.setState({ activeThreadId: 'thread-1' });
    });
    rerender(React.createElement(ChatScreen));

    await waitFor(() => {
      expect(lastChatHeaderProps.title).toBe('Restored conversation');
      expect(lastChatHeaderProps.modelLabel).toBe('model-q4');
      expect(lastChatHeaderProps.canOpenModelSelector).toBe(false);
      expect(lastChatHeaderProps.canOpenModelControls).toBe(false);
    });

    await act(async () => {
      deferredLoad.resolve(undefined);
      await deferredLoad.promise;
    });

    await waitFor(() => {
      expect(lastChatHeaderProps.modelLabel).toBe('model-q4');
      expect(lastChatHeaderProps.canOpenModelSelector).toBe(true);
      expect(lastChatHeaderProps.canOpenModelControls).toBe(true);
    });
  });

  it('does not create a switch event when selecting the current model', async () => {
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Model Q4',
        author: 'Test',
        size: 1024,
        localPath: 'model-q4.gguf',
        lifecycleStatus: 'downloaded',
      },
      {
        id: 'author/model-q8',
        name: 'Model Q8',
        author: 'Test',
        size: 1024,
        localPath: 'model-q8.gguf',
        lifecycleStatus: 'downloaded',
      },
    ]);

    const { getByTestId, queryByTestId } = render(React.createElement(ChatScreen));
    const beforeThread = useChatStore.getState().getActiveThread();

    fireEvent.press(getByTestId('model-selector-button'));
    expect(getByTestId('chat-model-selector-sheet')).toBeTruthy();

    await act(async () => {
      fireEvent.press(getByTestId('model-option-author/model-q4'));
    });

    const afterThread = useChatStore.getState().getActiveThread();
    expect(afterThread).toBe(beforeThread);
    expect(afterThread?.messages.some((message: any) => message.kind === 'model_switch')).toBe(false);
    expect(mockLoadModel).not.toHaveBeenCalled();
    expect(queryByTestId('chat-model-selector-sheet')).toBeNull();
  });

  it('does not mutate the thread when the selected model fails to load', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Model Q4',
        author: 'Test',
        size: 1024,
        localPath: 'model-q4.gguf',
        lifecycleStatus: 'downloaded',
      },
      {
        id: 'author/model-q8',
        name: 'Model Q8',
        author: 'Test',
        size: 1024,
        localPath: 'model-q8.gguf',
        lifecycleStatus: 'downloaded',
      },
    ]);

    mockLoadModel.mockRejectedValueOnce(new Error('load failed'));

    const { getByTestId, queryByTestId } = render(React.createElement(ChatScreen));
    const beforeThread = useChatStore.getState().getActiveThread();

    fireEvent.press(getByTestId('model-selector-button'));
    expect(getByTestId('chat-model-selector-sheet')).toBeTruthy();

    await act(async () => {
      fireEvent.press(getByTestId('model-option-author/model-q8'));
    });

    const afterThread = useChatStore.getState().getActiveThread();

    expect(afterThread).toBe(beforeThread);
    expect(afterThread?.messages.some((message: any) => message.kind === 'model_switch')).toBe(false);
    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith('common.actionFailed', expect.any(String));
    });
    expect(queryByTestId('chat-model-selector-sheet')).toBeNull();
    expect(lastChatHeaderProps.modelLabel).toBe('model-q4');
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it.each([
    ['model_load_blocked', 'models.ramLikelyOom'],
    ['model_memory_warning', 'models.memoryWarningTitle'],
  ])('retries a header model switch after %s without mutating the thread first', async (errorCode, alertTitle) => {
    const { AppError } = require('../../src/services/AppError');
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Model Q4',
        author: 'Test',
        size: 1024,
        localPath: 'model-q4.gguf',
        lifecycleStatus: 'downloaded',
      },
      {
        id: 'author/model-q8',
        name: 'Model Q8',
        author: 'Test',
        size: 1024,
        localPath: 'model-q8.gguf',
        lifecycleStatus: 'downloaded',
      },
    ]);

    mockLoadModel
      .mockRejectedValueOnce(new AppError(errorCode as any))
      .mockResolvedValueOnce(undefined);

    const { getByTestId } = render(React.createElement(ChatScreen));
    const beforeThread = useChatStore.getState().getActiveThread();
    const { getThreadActiveModelId } = require('../../src/types/chat');

    fireEvent.press(getByTestId('model-selector-button'));

    await act(async () => {
      fireEvent.press(getByTestId('model-option-author/model-q8'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith(alertTitle, expect.any(String), expect.any(Array));
    });

    expect(useChatStore.getState().getActiveThread()).toBe(beforeThread);
    expect(getThreadActiveModelId(useChatStore.getState().getActiveThread())).toBe('author/model-q4');
    expect(useChatStore.getState().getActiveThread()?.messages.some((message: any) => message.kind === 'model_switch')).toBe(false);

    const alertButtons = alertSpy.mock.calls.find((call) => call[0] === alertTitle)?.[2] as Array<{ onPress?: () => void }>;
    expect(alertButtons).toBeTruthy();

    await act(async () => {
      alertButtons[1]?.onPress?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => {
      expect(mockLoadModel).toHaveBeenCalledTimes(2);
    });

    expect(mockLoadModel).toHaveBeenNthCalledWith(
      2,
      'author/model-q8',
      expect.objectContaining({ allowUnsafeMemoryLoad: true }),
    );

    await waitFor(() => {
      expect(useChatStore.getState().getActiveThread()?.activeModelId).toBe('author/model-q8');
      expect(useChatStore.getState().getActiveThread()?.messages.some((message: any) => message.kind === 'model_switch')).toBe(true);
    });
  });

  it('disables the model selector while a response is generating', () => {
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Model Q4',
        author: 'Test',
        size: 1024,
        localPath: 'model-q4.gguf',
        lifecycleStatus: 'downloaded',
      },
    ]);

    useChatStore.setState({
      threads: {
        'thread-1': {
          ...useChatStore.getState().threads['thread-1'],
          status: 'generating',
        },
      },
      activeThreadId: 'thread-1',
    });

    render(React.createElement(ChatScreen));

    expect(lastChatHeaderProps.modelSelectable).toBe(true);
    expect(lastChatHeaderProps.canOpenModelSelector).toBe(false);
  });

  it('starts message-scoped regenerate flow from a user bubble', async () => {
    const { getByTestId, getByText, queryByText } = render(React.createElement(ChatScreen));

    fireEvent.press(getByTestId('regenerate-message-message-1'));
    expect(getByText('chat.editEarlierMessage')).toBeTruthy();
    expect(lastChatInputBarProps.allowEmptyMessageSend).toBe(false);
    expect(lastChatInputBarProps.imageAttachmentsDisabledReason).toBe('chat.visionReadiness.editingMessage');

    await act(async () => {
      fireEvent.press(getByTestId('send-button'));
    });
    expect(mockRegenerateFromUserMessage).toHaveBeenCalledWith('message-1', 'Edited from test');
    expect(queryByText('chat.editEarlierMessage')).toBeNull();
  });

  it('clears regenerate composer mode when deleting an earlier message removes the pending target branch', async () => {
    useChatStore.setState({
      threads: {
        'thread-1': {
          ...useChatStore.getState().threads['thread-1'],
          messages: [
            {
              id: 'message-earlier',
              role: 'user',
              content: 'Earlier user prompt',
              createdAt: 1,
              state: 'complete',
            },
            {
              id: 'message-earlier-assistant',
              role: 'assistant',
              content: 'Earlier assistant reply',
              createdAt: 2,
              state: 'complete',
            },
            ...useChatStore.getState().threads['thread-1'].messages,
          ],
        },
      },
      activeThreadId: 'thread-1',
    });
    mockDeleteMessage.mockReturnValueOnce(true);
    const { getByTestId, getByText, queryByText } = render(React.createElement(ChatScreen));

    fireEvent.press(getByTestId('regenerate-message-message-1'));
    expect(getByText('chat.editEarlierMessage')).toBeTruthy();
    expect(lastChatInputBarProps.draft).toBe('Saved user prompt');

    fireEvent.press(getByTestId('delete-message-message-earlier'));
    const deleteAlertButtons = alertSpy.mock.calls.find((call) => call[0] === 'chat.deleteMessageTitle')?.[2] as Array<{ onPress?: () => void }> | undefined;
    const confirmDelete = deleteAlertButtons?.find((button) => button.onPress)?.onPress;
    expect(confirmDelete).toBeTruthy();

    await act(async () => {
      confirmDelete?.();
    });

    expect(mockDeleteMessage).toHaveBeenCalledWith('message-earlier');
    expect(queryByText('chat.editEarlierMessage')).toBeNull();
    expect(lastChatInputBarProps.draft).toBe('');
  });

  it('submits image-only regenerate flow with current multimodal readiness', async () => {
    const readyReadiness = {
      modelId: 'author/model-q4',
      status: 'ready',
      projectorId: 'author/model-q4-mmproj',
      support: ['vision'],
      checkedAt: 1,
    };
    registry.saveModels([
      createVisionModel({
        selectedProjectorId: 'author/model-q4-mmproj',
        projectorCandidates: [createVisionProjector()],
        multimodalReadiness: readyReadiness,
      }),
    ]);
    setImageOnlyRegenerateThread();
    const { getByTestId } = render(React.createElement(ChatScreen));

    fireEvent.press(getByTestId('regenerate-message-message-image-only'));
    expect(lastChatInputBarProps.allowEmptyMessageSend).toBe(true);
    expect(lastChatInputBarProps.sendDisabled).toBe(false);
    expect(getByTestId('chat-regenerate-retained-attachments')).toBeTruthy();
    expect(lastChatInputBarProps.attachmentsTray).toBeTruthy();

    await act(async () => {
      await lastChatInputBarProps.onSendMessage('');
    });

    expect(mockRegenerateFromUserMessage).toHaveBeenCalledWith(
      'message-image-only',
      '',
      { multimodalReadiness: expect.objectContaining({ status: 'ready', support: ['vision'] }) },
    );
  });

  it('uses the unsupported-model reason when retained audio cannot be regenerated', () => {
    reactI18nextMock.__setTranslationOverride(
      'chat.attachments.retainedForRegenerateBlockedDescription',
      'blocked: {{reason}}',
    );
    reactI18nextMock.__setTranslationOverride(
      'chat.attachments.audioModelUnsupported',
      'Current model does not support audio',
    );
    reactI18nextMock.__setTranslationOverride('chat.visionReadiness.ready', 'Vision ready');
    registry.saveModels([
      createReadyVisionModel(),
    ]);
    setAudioOnlyRegenerateThread();

    const { getByTestId, getByText } = render(React.createElement(ChatScreen));

    fireEvent.press(getByTestId('regenerate-message-message-audio-only'));

    expect(lastChatInputBarProps.allowEmptyMessageSend).toBe(false);
    expect(lastChatInputBarProps.sendDisabled).toBe(true);
    expect(getByText('blocked: Current model does not support audio')).toBeTruthy();
  });

  it('blocks legacy video regeneration even when vision runtime is ready', async () => {
    reactI18nextMock.__setTranslationOverride(
      'chat.attachments.retainedForRegenerateBlockedDescription',
      'blocked: {{reason}}',
    );
    reactI18nextMock.__setTranslationOverride(
      'chat.attachments.videoRegenerateUnsupported',
      'Video input is disabled',
    );
    registry.saveModels([createReadyVisionModel()]);
    setVideoOnlyRegenerateThread();

    const { getByTestId, getByText } = render(React.createElement(ChatScreen));

    fireEvent.press(getByTestId('regenerate-message-message-video-only'));

    expect(lastChatInputBarProps.allowEmptyMessageSend).toBe(false);
    expect(lastChatInputBarProps.sendDisabled).toBe(true);
    expect(lastChatInputBarProps.attachmentsTray).toBeTruthy();
    expect(getByText('blocked: Video input is disabled')).toBeTruthy();

    await act(async () => {
      await lastChatInputBarProps.onSendMessage('Edited video prompt');
    });

    expect(mockRegenerateFromUserMessage).not.toHaveBeenCalled();
  });

  it.each([
    [
      'text-only model',
      () => [{
        id: 'author/model-q4',
        name: 'Text model',
        author: 'Test',
        size: 512 * 1024 * 1024,
        localPath: 'author-model-q4.gguf',
        lifecycleStatus: 'downloaded',
        chatModalities: ['text'],
        multimodalReadiness: {
          modelId: 'author/model-q4',
          status: 'text_only',
          support: [],
          checkedAt: 1,
        },
      }],
      'chat.visionReadiness.textOnly',
    ],
    [
      'initializing vision model',
      () => [createVisionModel({
        selectedProjectorId: 'author/model-q4-mmproj',
        projectorCandidates: [createVisionProjector()],
      })],
      'chat.visionReadiness.initializing',
    ],
  ])('keeps image-only regenerate empty send disabled for %s', async (_label, getModels, expectedReadinessReason) => {
    registry.saveModels(getModels());
    setImageOnlyRegenerateThread();

    const { getByTestId } = render(React.createElement(ChatScreen));

    expect(lastChatInputBarProps.allowEmptyMessageSend).toBe(false);
    expect(lastChatInputBarProps.imageAttachmentsEnabled).toBe(false);
    expect(lastChatInputBarProps.imageAttachmentsDisabledReason).toBe(expectedReadinessReason);

    fireEvent.press(getByTestId('regenerate-message-message-image-only'));

    expect(lastChatInputBarProps.allowEmptyMessageSend).toBe(false);
    expect(lastChatInputBarProps.sendDisabled).toBe(true);
    expect(lastChatInputBarProps.attachmentsTray).toBeTruthy();
    expect(getByTestId('chat-regenerate-retained-attachments')).toBeTruthy();
    expect(lastChatInputBarProps.imageAttachmentsDisabledReason).toBe('chat.visionReadiness.editingMessage');

    await act(async () => {
      await lastChatInputBarProps.onSendMessage('');
    });

    expect(mockRegenerateFromUserMessage).not.toHaveBeenCalled();

    await act(async () => {
      await lastChatInputBarProps.onSendMessage('Edited text should still wait for vision');
    });

    expect(mockRegenerateFromUserMessage).not.toHaveBeenCalled();
  });

  it('renders model switch system events as a dedicated row', () => {
    reactI18nextMock.__setTranslationOverride('chat.modelSwitchedLine', 'Model switched: {{from}} → {{to}}');

    useChatStore.setState({
      threads: {
        'thread-1': {
          ...useChatStore.getState().threads['thread-1'],
          messages: [
            ...useChatStore.getState().threads['thread-1'].messages,
            {
              id: 'switch-1',
              role: 'system',
              kind: 'model_switch',
              content: 'should-not-render-as-bubble',
              modelId: 'author/model-q8',
              switchFromModelId: 'author/model-q4',
              switchToModelId: 'author/model-q8',
              createdAt: 3,
              state: 'complete',
            },
          ],
        },
      },
      activeThreadId: 'thread-1',
    });

    const { getByTestId, getByText, queryByText } = render(React.createElement(ChatScreen));

    expect(getByTestId('chat-flash-list')).toBeTruthy();
    expect(getByText('Model switched: model-q4 → model-q8')).toBeTruthy();
    expect(queryByText('should-not-render-as-bubble')).toBeNull();
  });

  it('starts a new chat and clears the current thread from the screen', () => {
    const { getByTestId, getByText, queryByText, rerender } = render(React.createElement(ChatScreen));

    expect(getByText('Saved user prompt')).toBeTruthy();
    fireEvent.press(getByTestId('new-chat-button'));
    rerender(React.createElement(ChatScreen));

    expect(mockStartNewChat).toHaveBeenCalledTimes(1);
    expect(getByText('chat.noMessages')).toBeTruthy();
    expect(queryByText('Saved user prompt')).toBeNull();
  });

  it('shows an alert instead of throwing when header new chat fails synchronously', () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      mockStartNewChat.mockImplementationOnce(() => {
        throw new Error('Stop the current response before starting a new chat.');
      });

      const { getByTestId, getByText } = render(React.createElement(ChatScreen));

      expect(getByText('Saved user prompt')).toBeTruthy();

      fireEvent.press(getByTestId('new-chat-button'));

      expect(alertSpy).toHaveBeenCalledWith(
        'conversations.startNewChatErrorTitle',
        'common.errors.engineBusy',
      );
      expect(getByText('Saved user prompt')).toBeTruthy();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('hides regenerate control when the engine is not ready', () => {
    mockEngineState = {
      activeModelId: null,
      status: 'idle',
    };

    const { queryByTestId, getByText } = render(React.createElement(ChatScreen));

    expect(getByText('chat.loadModelWarning')).toBeTruthy();
    expect(queryByTestId('regenerate-message-message-1')).toBeNull();
  });

  it('replaces the empty-state prompt with a recovery card when no model is loaded for a new chat', () => {
    mockEngineState = {
      activeModelId: null,
      status: 'idle',
    };
    updateSettings({ activeModelId: null });
    useChatStore.setState({
      threads: {},
      activeThreadId: null,
    });

    const { getByText, queryByText } = render(React.createElement(ChatScreen));

    expect(getByText('chat.loadModelWarning')).toBeTruthy();
    expect(queryByText('chat.noMessages')).toBeNull();
    expect(lastChatInputBarProps.imageAttachmentsDisabledReason).toBe('chat.visionReadiness.noModel');
  });

  it('shows inline warmup progress in the empty chat recovery card', () => {
    mockEngineState = {
      activeModelId: 'author/model-q4',
      loadProgress: 0.42,
      status: 'initializing',
    };
    useChatStore.setState({
      threads: {},
      activeThreadId: null,
    });

    const { getByTestId, getByText, queryByTestId } = render(React.createElement(ChatScreen));

    expect(getByText('chat.warmingUp')).toBeTruthy();
    expect(getByText('42%')).toBeTruthy();
    expect(getByTestId('chat-recovery-warmup-progress-fill').props.style).toEqual({ width: '42%' });
    expect(queryByTestId('model-warmup-progress-fill')).toBeNull();
  });

  it('shows stop control while a response is generating', () => {
    useChatStore.setState({
      threads: {
        'thread-1': {
          ...useChatStore.getState().threads['thread-1'],
          messages: [
            ...useChatStore.getState().threads['thread-1'].messages,
            {
              id: 'message-3',
              role: 'assistant',
              content: 'Streaming reply',
              createdAt: 3,
              state: 'streaming',
            },
          ],
          status: 'generating',
        },
      },
      activeThreadId: 'thread-1',
    });

    const { getByTestId, queryByText } = render(React.createElement(ChatScreen));

    expect(queryByText('chat.statusGenerating')).toBeNull();
    fireEvent.press(getByTestId('stop-button'));
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  it('keeps header actions visible but disabled while a response is generating', async () => {
    useChatStore.setState({
      threads: {
        'thread-1': {
          ...useChatStore.getState().threads['thread-1'],
          messages: [
            ...useChatStore.getState().threads['thread-1'].messages,
            {
              id: 'message-3',
              role: 'assistant',
              content: 'Streaming reply',
              createdAt: 3,
              state: 'streaming',
            },
          ],
          status: 'generating',
        },
      },
      activeThreadId: 'thread-1',
    });

    const { getByTestId, queryByTestId } = render(React.createElement(ChatScreen));

    expect(getByTestId('new-chat-button')).toBeTruthy();
    expect(getByTestId('model-controls-button')).toBeTruthy();

    await act(async () => {
      fireEvent.press(getByTestId('new-chat-button'));
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    expect(mockStartNewChat).not.toHaveBeenCalled();
    expect(queryByTestId('model-parameters-sheet')).toBeNull();
  });

  it('does not stop generation when the screen unmounts', () => {
    useChatStore.setState({
      threads: {
        'thread-1': {
          ...useChatStore.getState().threads['thread-1'],
          status: 'generating',
        },
      },
      activeThreadId: 'thread-1',
    });

    const { unmount } = render(React.createElement(ChatScreen));
    unmount();

    expect(mockStop).not.toHaveBeenCalled();
  });

  it('shows a low-memory warning banner when hardware inputs require it', () => {
    mockHardwareBannerInputs = {
      showLowMemoryWarning: true,
      showThermalWarning: false,
      thermalState: 'nominal',
    };

    const { getByText } = render(React.createElement(ChatScreen));

    expect(getByText('chat.memoryPressureTitle')).toBeTruthy();
    expect(getByText('chat.memoryPressureDescription')).toBeTruthy();
  });

  it('offers a model recovery action from the disabled banner', () => {
    mockEngineState = {
      activeModelId: null,
      status: 'idle',
    };

    const { getByText } = render(React.createElement(ChatScreen));

    fireEvent.press(getByText('chat.downloadModel'));
    expect(mockRouterNavigate).toHaveBeenCalledWith('/(tabs)/models');
  });

  it('offers a load-model recovery action when downloaded models already exist', () => {
    mockEngineState = {
      activeModelId: null,
      status: 'idle',
    };
    registry.saveModels([
      {
        id: 'downloaded-model',
        name: 'Downloaded model',
        author: 'Test',
        size: 1024,
        localPath: 'downloaded-model.gguf',
        lifecycleStatus: 'downloaded',
      },
    ]);

    const { getByText } = render(React.createElement(ChatScreen));

    fireEvent.press(getByText('chat.loadModel'));
    expect(mockRouterNavigate).toHaveBeenCalledWith({
      pathname: '/(tabs)/models',
      params: { initialTab: 'downloaded' },
    });
  });

  it('shows an overheating warning banner when thermal state is elevated', () => {
    mockHardwareBannerInputs = {
      showLowMemoryWarning: false,
      showThermalWarning: true,
      thermalState: 'critical',
    };

    const { getByText } = render(React.createElement(ChatScreen));

    expect(getByText('chat.thermalTitle')).toBeTruthy();
    expect(getByText('chat.thermalDescriptionCritical')).toBeTruthy();
  });

  it('updates hardware warning banners when the service publishes a new status', () => {
    const { queryByText, getByText } = render(React.createElement(ChatScreen));

    expect(queryByText('Device is running hot')).toBeNull();

    mockHardwareBannerInputs = {
      showLowMemoryWarning: false,
      showThermalWarning: true,
      thermalState: 'critical',
    };

    act(() => {
      hardwareStatusListener?.({
        isLowMemory: false,
        isConnected: true,
        networkType: 'wifi',
        thermalState: 'critical',
      });
    });

    expect(getByText('chat.thermalTitle')).toBeTruthy();
  });

  it('shows summary unavailable notice when older messages are truncated from prompt context', () => {
    useChatStore.setState({
      threads: {
        'thread-1': {
          ...useChatStore.getState().threads['thread-1'],
          messages: Array.from({ length: 26 }, (_, index) => ({
            id: `message-${index + 1}`,
            role: index % 2 === 0 ? 'user' : 'assistant',
            content: `Message ${index + 1}`,
            createdAt: index + 1,
            state: 'complete',
          })),
        },
      },
      activeThreadId: 'thread-1',
    });

    const { getByText, queryByText } = render(React.createElement(ChatScreen));

    expect(getByText('chat.summaryUnavailableTitle')).toBeTruthy();
    expect(queryByText('chat.summarizeChat')).toBeNull();
    expect(mockCreateSummaryPlaceholder).not.toHaveBeenCalled();
  });

  it('does not render legacy summary placeholder metadata as a generated summary', () => {
    useChatStore.setState({
      threads: {
        'thread-1': {
          ...useChatStore.getState().threads['thread-1'],
          summary: {
            content: 'Summary generation is not available yet.',
            createdAt: 10,
            sourceMessageIds: ['message-1'],
            isPlaceholder: true,
          },
        },
      },
      activeThreadId: 'thread-1',
    });

    const { queryByText } = render(React.createElement(ChatScreen));

    expect(queryByText('chat.summarySavedTitle')).toBeNull();
    expect(queryByText('Summary generation is not available yet.')).toBeNull();
  });

  it('opens preset selection from the header and updates the active thread preset', () => {
    const { getByTestId, getByText, rerender } = render(React.createElement(ChatScreen));

    fireEvent.press(getByTestId('preset-button'));
    fireEvent.press(getByTestId('preset-option-preset-2'));
    rerender(React.createElement(ChatScreen));

    expect(getByText('Research Analyst')).toBeTruthy();
    expect(useChatStore.getState().getActiveThread()?.presetSnapshot).toEqual(
      expect.objectContaining({
        id: 'preset-2',
        name: 'Research Analyst',
        systemPrompt: 'Organize findings clearly.',
      }),
    );
  });

  it('passes the current thread preset to the selector instead of the global preset', () => {
    updateSettings({ activePresetId: 'preset-2' });
    useChatStore.setState({
      threads: {
        'thread-1': {
          ...useChatStore.getState().threads['thread-1'],
          presetId: 'preset-1',
          presetSnapshot: {
            id: 'preset-1',
            name: 'Helpful Assistant',
            systemPrompt: 'Be concise.',
          },
        },
      },
      activeThreadId: 'thread-1',
    });

    const { getByTestId } = render(React.createElement(ChatScreen));

    fireEvent.press(getByTestId('preset-button'));

    expect(lastPresetSelectorProps?.activePresetId).toBe('preset-1');
  });

  it('allows resetting the preset back to the default state', () => {
    const { getByTestId, getByText, rerender } = render(React.createElement(ChatScreen));

    fireEvent.press(getByTestId('preset-button'));
    fireEvent.press(getByTestId('preset-option-default'));
    rerender(React.createElement(ChatScreen));

    expect(getByText('Default')).toBeTruthy();
    expect(useChatStore.getState().getActiveThread()?.presetId).toBeNull();
    expect(useChatStore.getState().getActiveThread()?.presetSnapshot).toEqual(
      expect.objectContaining({
        id: null,
        name: 'Default',
        systemPrompt: 'You are a helpful AI assistant.',
      }),
    );
  });

  it('resets a single generation parameter from the model controls sheet', async () => {
    const { getByTestId, rerender } = render(React.createElement(ChatScreen));

    expect(useChatStore.getState().getActiveThread()?.paramsSnapshot.topP).toBe(0.6);

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.press(getByTestId('reset-top-p-button'));
      await Promise.resolve();
    });
    rerender(React.createElement(ChatScreen));

    expect(useChatStore.getState().getActiveThread()?.paramsSnapshot.topP).toBe(0.9);
  });

  it('updates the active thread reasoning effort from the model controls sheet', async () => {
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Qwen3-4B-Instruct-GGUF',
        author: 'Test',
        size: 512 * 1024 * 1024,
        localPath: 'author-model-q4.gguf',
        lifecycleStatus: 'downloaded',
        modelType: 'qwen3',
        tags: ['gguf', 'chat'],
      },
    ]);
    const { getByTestId, rerender } = render(React.createElement(ChatScreen));

    expect(useChatStore.getState().getActiveThread()?.paramsSnapshot.reasoningEffort).toBe('auto');

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.press(getByTestId('set-medium-reasoning-effort-button'));
      await Promise.resolve();
    });
    rerender(React.createElement(ChatScreen));

    expect(useChatStore.getState().getActiveThread()?.paramsSnapshot.reasoningEffort).toBe('medium');
  });

  it('alerts when autotune cannot restore the previously loaded model', async () => {
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Qwen3-4B-Instruct-GGUF',
        author: 'Test',
        size: 512 * 1024 * 1024,
        localPath: 'author-model-q4.gguf',
        lifecycleStatus: 'downloaded',
        modelType: 'qwen3',
        tags: ['gguf', 'chat'],
      },
    ]);
    mockRunBackendAutotune.mockResolvedValueOnce({
      createdAtMs: 1,
      modelId: 'author/model-q4',
      contextSize: 4096,
      kvCacheType: 'f16',
      candidates: [],
      restorationError: 'native reload crashed',
    });

    const { getByTestId } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await act(async () => {
      await lastModelParametersSheetProps?.onRunAutotune();
    });

    expect(mockRunBackendAutotune).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'author/model-q4', onProgress: expect.any(Function) }),
    );
    expect(alertSpy).toHaveBeenCalledWith(
      'chat.modelControls.backendBenchmarkRestoreWarningTitle',
      'chat.modelControls.backendBenchmarkRestoreWarningDescription',
    );
  });

  it('keeps reasoning disabled for models without reasoning support', async () => {
    updateSettings({
      modelParamsByModelId: {
        'author/model-q4': {
          temperature: 0.7,
          topP: 0.6,
          maxTokens: 1024,
          reasoningEffort: 'high',
        },
      },
    });
    useChatStore.setState({
      threads: {
        'thread-1': {
          ...useChatStore.getState().threads['thread-1'],
          paramsSnapshot: {
            ...useChatStore.getState().threads['thread-1'].paramsSnapshot,
            reasoningEffort: 'high',
          },
        },
      },
      activeThreadId: 'thread-1',
    });
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'gemma-2-2b-it-GGUF',
        author: 'Test',
        size: 512 * 1024 * 1024,
        localPath: 'author-model-q4.gguf',
        lifecycleStatus: 'downloaded',
        modelType: 'gemma2',
        tags: ['gguf', 'chat'],
      },
    ]);

    const { getByTestId } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(lastModelParametersSheetProps?.supportsReasoning).toBe(false);
      expect(lastModelParametersSheetProps?.params.reasoningEffort).toBe('auto');
      // Opening the sheet should not mutate persisted/thread params.
      expect(useChatStore.getState().getActiveThread()?.paramsSnapshot.reasoningEffort).toBe('high');
    });

    await act(async () => {
      lastModelParametersSheetProps?.onChangeParams({ reasoningEffort: 'high' });
      await Promise.resolve();
    });

    expect(useChatStore.getState().getActiveThread()?.paramsSnapshot.reasoningEffort).toBe('auto');
  });

  it('keeps auto reasoning effort enabled for reasoning-first models', async () => {
    updateSettings({
      activeModelId: 'author/model-r1',
      modelParamsByModelId: {
        'author/model-r1': {
          temperature: 0.7,
          topP: 0.6,
          maxTokens: 1024,
          reasoningEffort: 'auto',
        },
      },
    });
    useChatStore.setState({
      threads: {
        'thread-1': {
          ...useChatStore.getState().threads['thread-1'],
          modelId: 'author/model-r1',
          paramsSnapshot: {
            ...useChatStore.getState().threads['thread-1'].paramsSnapshot,
            reasoningEffort: 'auto',
          },
        },
      },
      activeThreadId: 'thread-1',
    });
    mockEngineState.activeModelId = 'author/model-r1';
    registry.saveModels([
      {
        id: 'author/model-r1',
        name: 'DeepSeek-R1-Distill-Qwen-7B-GGUF',
        author: 'Test',
        size: 512 * 1024 * 1024,
        localPath: 'author-model-r1.gguf',
        lifecycleStatus: 'downloaded',
        modelType: 'deepseek-r1',
        baseModels: ['deepseek-ai/DeepSeek-R1'],
        tags: ['gguf', 'reasoning'],
        thinkingCapability: {
          detectedAt: Date.now(),
          supportsThinking: true,
          canDisableThinking: false,
        },
      },
    ]);

    const { getByTestId } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(lastModelParametersSheetProps?.requiresReasoning).toBe(true);
      expect(lastModelParametersSheetProps?.params.reasoningEffort).toBe('auto');
      // Opening the sheet should not mutate persisted/thread params.
      expect(useChatStore.getState().getActiveThread()?.paramsSnapshot.reasoningEffort).toBe('auto');
    });

    await act(async () => {
      lastModelParametersSheetProps?.onChangeParams({ reasoningEffort: 'low' });
      await Promise.resolve();
    });

    expect(useChatStore.getState().getActiveThread()?.paramsSnapshot.reasoningEffort).toBe('low');
  });

  it('keeps the reset context window draft instead of restoring the saved override', async () => {
    updateSettings({
      modelLoadParamsByModelId: {
        'author/model-q4': {
          contextSize: 8192,
          gpuLayers: null,
        },
      },
    });

    const { getByTestId } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });
    expect(lastModelParametersSheetProps?.loadParamsDraft.contextSize).toBe(8192);

    await act(async () => {
      fireEvent.press(getByTestId('reset-all-button'));
      await Promise.resolve();
    });

    expect(lastModelParametersSheetProps?.loadParamsDraft.contextSize).toBe(4096);
    expect(getByTestId('context-size-value').props.children).toBe('4096');
  });

  it('keeps apply visible when an old saved context override is clamped by the current ceiling', async () => {
    updateSettings({
      modelLoadParamsByModelId: {
        'author/model-q4': {
          contextSize: 32768,
          gpuLayers: null,
        },
      },
    });
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Q4 model',
        author: 'Test',
        size: 512 * 1024 * 1024,
        maxContextTokens: 8192,
        hasVerifiedContextWindow: true,
        localPath: 'author-model-q4.gguf',
        lifecycleStatus: 'downloaded',
      },
    ]);

    const { getByTestId } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(lastModelParametersSheetProps?.loadParamsDraft.contextSize).toBe(8192);
      expect(lastModelParametersSheetProps?.showApplyReload).toBe(true);
    });
  });

  it('keeps the saved load profile intact when the active model is running in safe mode', async () => {
    updateSettings({
      modelLoadParamsByModelId: {
        'author/model-q4': {
          contextSize: 8192,
          gpuLayers: 12,
        },
      },
    });
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Q4 model',
        author: 'Test',
        size: 512 * 1024 * 1024,
        maxContextTokens: 8192,
        hasVerifiedContextWindow: true,
        localPath: 'author-model-q4.gguf',
        lifecycleStatus: 'downloaded',
      },
    ]);
    mockSafeModeLoadLimits = {
      maxContextTokens: 4096,
      requestedGpuLayers: 12,
      loadedGpuLayers: 4,
    };
    mockLoadedContextSize = 4096;
    mockLoadedGpuLayers = 4;

    const { getByTestId } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(lastModelParametersSheetProps?.contextWindowCeiling).toBe(8192);
      expect(lastModelParametersSheetProps?.loadParamsDraft).toEqual(
        expect.objectContaining({
          contextSize: 8192,
          gpuLayers: 12,
        }),
      );
      expect(lastModelParametersSheetProps?.loadedContextSize).toBe(4096);
      expect(lastModelParametersSheetProps?.loadedGpuLayers).toBe(4);
      expect(lastModelParametersSheetProps?.isSafeModeActive).toBe(true);
      expect(lastModelParametersSheetProps?.showApplyReload).toBe(false);
    });

    await act(async () => {
      await lastModelParametersSheetProps.onApplyReload();
    });

    expect(getSettings().modelLoadParamsByModelId['author/model-q4']).toEqual({
      contextSize: 8192,
      gpuLayers: 12,
      kvCacheType: 'auto',
    });
  });

  it('passes runtime backend diagnostics separately from the saved load profile', async () => {
    updateSettings({
      modelLoadParamsByModelId: {
        'author/model-q4': {
          contextSize: 4096,
          gpuLayers: 12,
        },
      },
    });
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Q4 model',
        author: 'Test',
        size: 512 * 1024 * 1024,
        maxContextTokens: 8192,
        hasVerifiedContextWindow: true,
        localPath: 'author-model-q4.gguf',
        lifecycleStatus: 'downloaded',
      },
    ]);
    mockLoadedContextSize = 4096;
    mockLoadedGpuLayers = 0;
    mockEngineState = {
      activeModelId: 'author/model-q4',
      status: 'ready',
      diagnostics: {
        backendMode: 'cpu',
        backendDevices: [],
        reasonNoGPU: 'OpenCL backend unavailable',
        requestedGpuLayers: 12,
        loadedGpuLayers: 0,
        actualGpuAccelerated: false,
      },
    };

    const { getByTestId, rerender } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(lastModelParametersSheetProps?.loadParamsDraft).toEqual(expect.objectContaining({
        contextSize: 4096,
        gpuLayers: 12,
      }));
      expect(lastModelParametersSheetProps?.loadedGpuLayers).toBe(0);
      expect(lastModelParametersSheetProps?.engineDiagnostics).toEqual(expect.objectContaining({
        backendMode: 'cpu',
        requestedGpuLayers: 12,
        loadedGpuLayers: 0,
        actualGpuAccelerated: false,
        reasonNoGPU: 'OpenCL backend unavailable',
      }));
    });
  });

  it('resets the GPU ceiling when reopening model controls for a different model before recommendations resolve', async () => {
    const highModelRecommendation = createDeferred<{ recommendedGpuLayers: number; gpuLayersCeiling: number }>();

    mockGetRecommendedLoadProfile.mockImplementation((modelId: string | null) => {
      if (modelId === 'author/model-q4') {
        return Promise.resolve({
          recommendedGpuLayers: 4,
          gpuLayersCeiling: 4,
        });
      }

      if (modelId === 'author/model-q8') {
        return highModelRecommendation.promise;
      }

      return Promise.resolve({
        recommendedGpuLayers: 0,
        gpuLayersCeiling: UNKNOWN_MODEL_GPU_LAYERS_CEILING,
      });
    });

    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Q4 model',
        author: 'Test',
        size: 512 * 1024 * 1024,
        maxContextTokens: 8192,
        hasVerifiedContextWindow: true,
        localPath: 'author-model-q4.gguf',
        lifecycleStatus: 'downloaded',
      },
      {
        id: 'author/model-q8',
        name: 'Q8 model',
        author: 'Test',
        size: 768 * 1024 * 1024,
        maxContextTokens: 8192,
        hasVerifiedContextWindow: true,
        localPath: 'author-model-q8.gguf',
        lifecycleStatus: 'downloaded',
      },
    ]);

    const { getByTestId, rerender } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(lastModelParametersSheetProps?.modelId).toBe('author/model-q4');
      expect(lastModelParametersSheetProps?.gpuLayersCeiling).toBe(4);
    });

    await act(async () => {
      lastModelParametersSheetProps.onClose();
      await Promise.resolve();
    });

    await act(async () => {
      useChatStore.setState({
        threads: {
          'thread-1': {
            ...useChatStore.getState().threads['thread-1'],
            modelId: 'author/model-q8',
          },
        },
        activeThreadId: 'thread-1',
      });
      await Promise.resolve();
    });

    rerender(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(lastModelParametersSheetProps?.modelId).toBe('author/model-q8');
      expect(lastModelParametersSheetProps?.gpuLayersCeiling).toBe(UNKNOWN_MODEL_GPU_LAYERS_CEILING);
    });

    await act(async () => {
      lastModelParametersSheetProps.onChangeLoadParams({
        gpuLayers: 100,
      });
    });

    await act(async () => {
      await lastModelParametersSheetProps.onApplyReload();
    });

    expect(getSettings().modelLoadParamsByModelId['author/model-q8']).toEqual({
      contextSize: 4096,
      gpuLayers: 100,
      kvCacheType: 'auto',
    });
  });

  it('shows the cached stable GPU ceiling before async recommendations resolve', async () => {
    mockGetRecommendedLoadProfile.mockImplementation(() => new Promise(() => {}));

    const modelSizeBytes = 512 * 1024 * 1024;
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Q4 model',
        author: 'Test',
        size: modelSizeBytes,
        sha256: VERIFIED_LOCAL_SHA256,
        downloadIntegrity: {
          kind: 'sha256',
          sizeBytes: modelSizeBytes,
          checkedAt: 1,
          sha256: VERIFIED_LOCAL_SHA256,
        },
        metadataTrust: 'verified_local',
        gguf: {
          totalBytes: modelSizeBytes,
          architecture: 'llama',
          nLayers: 28,
        },
        hasVerifiedContextWindow: true,
        maxContextTokens: 8192,
        localPath: 'author-model-q4.gguf',
        lifecycleStatus: 'downloaded',
        capabilitySnapshot: buildModelCapabilitySnapshot({
          size: modelSizeBytes,
          metadataTrust: 'verified_local',
          gguf: {
            totalBytes: modelSizeBytes,
            architecture: 'llama',
            nLayers: 28,
          },
          hasVerifiedContextWindow: true,
          maxContextTokens: 8192,
          lastModifiedAt: undefined,
          sha256: VERIFIED_LOCAL_SHA256,
        }),
      },
    ]);

    const { getByTestId } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(lastModelParametersSheetProps?.gpuLayersCeiling).toBe(28);
    });
  });

  it('does not persist a gpuLayers=0 override when apply runs before recommendations resolve', async () => {
    mockGetRecommendedGpuLayers.mockReturnValueOnce(new Promise<number>(() => {}));

    const { getByTestId } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await act(async () => {
      lastModelParametersSheetProps.onChangeLoadParams({
        contextSize: 8192,
      });
    });

    await act(async () => {
      await lastModelParametersSheetProps.onApplyReload();
    });

    expect(getSettings().modelLoadParamsByModelId['author/model-q4']).toEqual({
      contextSize: 8192,
      gpuLayers: null,
      kvCacheType: 'auto',
    });
  });

  it('shows warmup progress while the active model reloads after applying load settings', async () => {
    const reloadDeferred = createDeferred<void>();
    mockLoadModel.mockImplementationOnce(() => reloadDeferred.promise);

    const { getByTestId, getByText, rerender } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(lastModelParametersSheetProps?.modelId).toBe('author/model-q4');
    });

    await act(async () => {
      lastModelParametersSheetProps.onChangeLoadParams({
        contextSize: 8192,
      });
    });

    let applyPromise: Promise<void> | undefined;
    await act(async () => {
      applyPromise = lastModelParametersSheetProps.onApplyReload();
      await Promise.resolve();
    });

    expect(mockLoadModel).toHaveBeenCalledWith('author/model-q4', {
      forceReload: true,
      loadParamsOverride: expect.objectContaining({
        contextSize: 8192,
        gpuLayers: null,
        kvCacheType: 'auto',
      }),
    });

    mockEngineState = {
      ...mockEngineState,
      activeModelId: 'author/model-q4',
      loadProgress: 0.42,
      status: 'initializing',
    };
    rerender(React.createElement(ChatScreen));

    expect(getByText('chat.warmingUp 42%')).toBeTruthy();
    expect(getByTestId('model-warmup-progress-fill').props.style).toEqual({ width: '42%' });

    await act(async () => {
      reloadDeferred.resolve();
      await applyPromise;
    });
  });

  it('applies the per-model MTP preference transactionally through reload', async () => {
    const draftArtifactId = 'mtp-draft-q4';
    registry.saveModels([{
      id: 'author/model-q4',
      name: 'Q4 model',
      author: 'Test',
      size: 512 * 1024 * 1024,
      maxContextTokens: 8192,
      hasVerifiedContextWindow: true,
      localPath: 'author-model-q4.gguf',
      lifecycleStatus: 'downloaded',
      artifacts: [{
        id: draftArtifactId,
        kind: 'speculative_draft',
        requiredFor: ['text'],
        remoteFileName: 'MTP/gemma-MTP-Q8_0.gguf',
        downloadUrl: 'https://example.com/MTP/gemma-MTP-Q8_0.gguf',
        sizeBytes: 1024,
        localPath: 'gemma-MTP-Q8_0.gguf',
        installState: 'installed',
      }],
      speculativeDecoding: {
        type: 'mtp',
        mode: 'draft_model',
        enabled: true,
        maxDraftTokens: 3,
        draftArtifactId,
      },
    } as any]);
    mockLoadModel
      .mockRejectedValueOnce(new Error('reload failed'))
      .mockResolvedValueOnce(undefined);

    const { getByTestId } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(lastModelParametersSheetProps?.mtpSupported).toBe(true);
      expect(lastModelParametersSheetProps?.mtpEnabled).toBe(true);
    });

    await act(async () => {
      lastModelParametersSheetProps.onChangeMtpEnabled(false);
    });
    expect(lastModelParametersSheetProps?.mtpHasPendingChange).toBe(true);

    await act(async () => {
      await lastModelParametersSheetProps.onApplyReload();
    });

    expect(mockLoadModel).toHaveBeenNthCalledWith(1, 'author/model-q4', {
      forceReload: true,
      loadParamsOverride: expect.objectContaining({ mtpEnabled: false }),
    });
    expect(getSettings().modelLoadParamsByModelId['author/model-q4']?.mtpEnabled).toBeUndefined();

    await act(async () => {
      await lastModelParametersSheetProps.onApplyReload();
    });

    expect(mockLoadModel).toHaveBeenNthCalledWith(2, 'author/model-q4', {
      forceReload: true,
      loadParamsOverride: expect.objectContaining({ mtpEnabled: false }),
    });
    expect(getSettings().modelLoadParamsByModelId['author/model-q4']?.mtpEnabled).toBe(false);
  });

  it('defers saving active load profile changes until a blocked reload is retried successfully', async () => {
    const { AppError } = require('../../src/services/AppError');
    updateSettings({
      modelLoadParamsByModelId: {
        'author/model-q4': {
          contextSize: 4096,
          gpuLayers: 6,
          kvCacheType: 'q8_0',
        },
      },
    });
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Q4 model',
        author: 'Test',
        size: 512 * 1024 * 1024,
        maxContextTokens: 8192,
        hasVerifiedContextWindow: true,
        localPath: 'author-model-q4.gguf',
        lifecycleStatus: 'downloaded',
      },
    ]);
    mockLoadModel
      .mockRejectedValueOnce(new AppError('model_load_blocked'))
      .mockResolvedValueOnce(undefined);

    const { getByTestId } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await act(async () => {
      lastModelParametersSheetProps.onChangeLoadParams({
        contextSize: 8192,
        kvCacheType: 'f16',
      });
    });

    await act(async () => {
      await lastModelParametersSheetProps.onApplyReload();
      await Promise.resolve();
    });

    expect(mockLoadModel).toHaveBeenNthCalledWith(1, 'author/model-q4', {
      forceReload: true,
      loadParamsOverride: expect.objectContaining({
        contextSize: 8192,
        gpuLayers: 6,
        kvCacheType: 'f16',
      }),
    });
    expect(getSettings().modelLoadParamsByModelId['author/model-q4']).toEqual({
      contextSize: 4096,
      gpuLayers: 6,
      kvCacheType: 'q8_0',
    });

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith('models.ramLikelyOom', expect.any(String), expect.any(Array));
    });

    const alertButtons = alertSpy.mock.calls.find((call) => call[0] === 'models.ramLikelyOom')?.[2] as Array<{ onPress?: () => void }>;
    expect(alertButtons).toBeTruthy();

    await act(async () => {
      alertButtons[1]?.onPress?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => {
      expect(mockLoadModel).toHaveBeenCalledTimes(2);
    });
    expect(mockLoadModel).toHaveBeenNthCalledWith(
      2,
      'author/model-q4',
      expect.objectContaining({
        forceReload: true,
        allowUnsafeMemoryLoad: true,
        loadParamsOverride: expect.objectContaining({
          contextSize: 8192,
          gpuLayers: 6,
          kvCacheType: 'f16',
        }),
      }),
    );
    await waitFor(() => {
      expect(getSettings().modelLoadParamsByModelId['author/model-q4']).toEqual({
        contextSize: 8192,
        gpuLayers: 6,
        kvCacheType: 'f16',
      });
    });
  });

  it('keeps gpuLayers on auto when the field is reset before recommendations resolve', async () => {
    mockGetRecommendedGpuLayers.mockReturnValueOnce(new Promise<number>(() => {}));
    updateSettings({
      modelLoadParamsByModelId: {
        'author/model-q4': {
          contextSize: 4096,
          gpuLayers: 12,
        },
      },
    });

    const { getByTestId } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await act(async () => {
      lastModelParametersSheetProps.onResetLoadField('gpuLayers');
      lastModelParametersSheetProps.onChangeLoadParams({
        contextSize: 8192,
      });
    });

    await act(async () => {
      await lastModelParametersSheetProps.onApplyReload();
    });

    expect(getSettings().modelLoadParamsByModelId['author/model-q4']).toEqual({
      contextSize: 8192,
      gpuLayers: null,
      kvCacheType: 'auto',
    });
  });

  it('keeps gpuLayers on auto when reset all is applied before recommendations resolve', async () => {
    mockGetRecommendedGpuLayers.mockReturnValueOnce(new Promise<number>(() => {}));
    updateSettings({
      modelLoadParamsByModelId: {
        'author/model-q4': {
          contextSize: 4096,
          gpuLayers: 12,
        },
      },
    });

    const { getByTestId } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.press(getByTestId('reset-all-button'));
    });

    await act(async () => {
      await lastModelParametersSheetProps.onApplyReload();
    });

    expect(getSettings().modelLoadParamsByModelId['author/model-q4']).toBeUndefined();
  });

  it('passes a RAM-aware context window ceiling into the model controls sheet', async () => {
    const totalMemoryBytes = 8 * 1024 * 1024 * 1024;
    const { resolveContextWindowCeiling } = require('../../src/utils/contextWindow');
    const modelSizeBytes = 4 * 1024 * 1024 * 1024;

    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Q4 model',
        author: 'Test',
        size: modelSizeBytes,
        sha256: VERIFIED_LOCAL_SHA256,
        downloadIntegrity: {
          kind: 'sha256',
          sizeBytes: modelSizeBytes,
          checkedAt: 1,
          sha256: VERIFIED_LOCAL_SHA256,
        },
        metadataTrust: 'verified_local',
        gguf: {
          totalBytes: modelSizeBytes,
          architecture: 'llama',
          nLayers: 32,
          nHeadKv: 16,
          nEmbdHeadK: 128,
          nEmbdHeadV: 128,
        },
        maxContextTokens: 8192,
        hasVerifiedContextWindow: true,
        localPath: 'author-model-q4.gguf',
        lifecycleStatus: 'downloaded',
      },
    ]);

    const { getByTestId } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(lastModelParametersSheetProps?.contextWindowCeiling).toBe(resolveContextWindowCeiling({
        modelMaxContextTokens: 8192,
        totalMemoryBytes,
        input: {
          modelSizeBytes,
          verifiedFileSizeBytes: modelSizeBytes,
          metadataTrust: 'verified_local',
          ggufMetadata: {
            totalBytes: modelSizeBytes,
            architecture: 'llama',
            nLayers: 32,
            nHeadKv: 16,
            nEmbdHeadK: 128,
            nEmbdHeadV: 128,
          },
          runtimeParams: {
            gpuLayers: 0,
            cacheTypeK: 'f16',
            cacheTypeV: 'f16',
            useMmap: true,
          },
        },
      }));
    });
  });

  it('surfaces context window ceilings above 8192 when the model supports them', async () => {
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Q4 model',
        author: 'Test',
        size: 512 * 1024 * 1024,
        maxContextTokens: 32768,
        hasVerifiedContextWindow: true,
        localPath: 'author-model-q4.gguf',
        lifecycleStatus: 'downloaded',
      },
    ]);

    const { getByTestId } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(lastModelParametersSheetProps?.contextWindowCeiling).toBe(32768);
    });
  });

  it('refreshes stale model metadata before calculating the context window ceiling', async () => {
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Q4 model',
        author: 'Test',
        size: 512 * 1024 * 1024,
        maxContextTokens: 8192,
        hasVerifiedContextWindow: false,
        localPath: 'author-model-q4.gguf',
        lifecycleStatus: 'downloaded',
      },
    ]);
    mockRefreshModelMetadata.mockResolvedValueOnce({
      id: 'author/model-q4',
      name: 'Q4 model',
      author: 'Test',
      size: 512 * 1024 * 1024,
      maxContextTokens: 32768,
      hasVerifiedContextWindow: true,
      localPath: 'author-model-q4.gguf',
      lifecycleStatus: 'downloaded',
    });

    const { getByTestId } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mockRefreshModelMetadata).toHaveBeenCalledWith(expect.objectContaining({
        id: 'author/model-q4',
        maxContextTokens: 8192,
      }));
      expect(lastModelParametersSheetProps?.contextWindowCeiling).toBe(32768);
    });
  });

  it('refreshes unverified long-context metadata before calculating the context window ceiling', async () => {
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Q4 model',
        author: 'Test',
        size: 512 * 1024 * 1024,
        maxContextTokens: 32768,
        hasVerifiedContextWindow: false,
        localPath: 'author-model-q4.gguf',
        lifecycleStatus: 'downloaded',
      },
    ]);
    mockRefreshModelMetadata.mockResolvedValueOnce({
      id: 'author/model-q4',
      name: 'Q4 model',
      author: 'Test',
      size: 512 * 1024 * 1024,
      maxContextTokens: 65536,
      hasVerifiedContextWindow: true,
      localPath: 'author-model-q4.gguf',
      lifecycleStatus: 'downloaded',
    });

    const { getByTestId } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mockRefreshModelMetadata).toHaveBeenCalledWith(expect.objectContaining({
        id: 'author/model-q4',
        maxContextTokens: 32768,
        hasVerifiedContextWindow: false,
      }));
      expect(lastModelParametersSheetProps?.contextWindowCeiling).toBe(65536);
    });
  });

  it('preserves unsaved load-parameter edits while async recommendations are still resolving', async () => {
    const recommendedGpuLayers = createDeferred<number>();
    const refreshedModel = {
      id: 'author/model-q4',
      name: 'Q4 model',
      author: 'Test',
      size: 512 * 1024 * 1024,
      maxContextTokens: 32768,
      localPath: 'author-model-q4.gguf',
      lifecycleStatus: 'downloaded',
    };
    const refreshedMetadata = createDeferred<typeof refreshedModel>();

    mockGetRecommendedGpuLayers.mockReturnValueOnce(recommendedGpuLayers.promise);
    mockRefreshModelMetadata.mockReturnValueOnce(refreshedMetadata.promise);
    registry.saveModels([
      {
        ...refreshedModel,
        maxContextTokens: 8192,
        hasVerifiedContextWindow: false,
      },
    ]);

    const { getByTestId } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    await act(async () => {
      lastModelParametersSheetProps.onChangeLoadParams({
        contextSize: 8192,
        gpuLayers: 12,
      });
    });

    await act(async () => {
      recommendedGpuLayers.resolve(20);
      refreshedMetadata.resolve(refreshedModel);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(lastModelParametersSheetProps?.loadParamsDraft.contextSize).toBe(8192);
    expect(lastModelParametersSheetProps?.loadParamsDraft.gpuLayers).toBe(12);
  });

  it('re-clamps a user draft when async RAM checks lower the context window ceiling', async () => {
    const totalMemoryBytes = 8 * 1024 * 1024 * 1024;
    const { resolveContextWindowCeiling } = require('../../src/utils/contextWindow');
    const modelSizeBytes = 4 * 1024 * 1024 * 1024;
    const totalMemory = createDeferred<number>();

    mockGetTotalMemory.mockReturnValueOnce(totalMemory.promise);
    registry.saveModels([
      {
        id: 'author/model-q4',
        name: 'Q4 model',
        author: 'Test',
        size: modelSizeBytes,
        sha256: VERIFIED_LOCAL_SHA256,
        downloadIntegrity: {
          kind: 'sha256',
          sizeBytes: modelSizeBytes,
          checkedAt: 1,
          sha256: VERIFIED_LOCAL_SHA256,
        },
        metadataTrust: 'verified_local',
        gguf: {
          totalBytes: modelSizeBytes,
          architecture: 'llama',
          nLayers: 32,
          nHeadKv: 16,
          nEmbdHeadK: 128,
          nEmbdHeadV: 128,
        },
        maxContextTokens: 32768,
        hasVerifiedContextWindow: true,
        localPath: 'author-model-q4.gguf',
        lifecycleStatus: 'downloaded',
      },
    ]);

    const { getByTestId } = render(React.createElement(ChatScreen));

    await act(async () => {
      fireEvent.press(getByTestId('model-controls-button'));
      await Promise.resolve();
    });

    expect(lastModelParametersSheetProps?.contextWindowCeiling).toBe(32768);

    await act(async () => {
      lastModelParametersSheetProps.onChangeLoadParams({
        contextSize: 8192,
      });
    });

    expect(lastModelParametersSheetProps?.loadParamsDraft.contextSize).toBe(8192);
    expect(getByTestId('context-size-value').props.children).toBe('8192');

    await act(async () => {
      totalMemory.resolve(totalMemoryBytes);
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      const loweredCeiling = resolveContextWindowCeiling({
        modelMaxContextTokens: 32768,
        totalMemoryBytes,
        input: {
          modelSizeBytes,
          verifiedFileSizeBytes: modelSizeBytes,
          metadataTrust: 'verified_local',
          ggufMetadata: {
            totalBytes: modelSizeBytes,
            architecture: 'llama',
            nLayers: 32,
            nHeadKv: 16,
            nEmbdHeadK: 128,
            nEmbdHeadV: 128,
          },
          runtimeParams: {
            gpuLayers: 0,
            cacheTypeK: 'f16',
            cacheTypeV: 'f16',
            useMmap: true,
          },
        },
      });

      expect(lastModelParametersSheetProps?.contextWindowCeiling).toBe(resolveContextWindowCeiling({
        modelMaxContextTokens: 32768,
        totalMemoryBytes,
        input: {
          modelSizeBytes,
          verifiedFileSizeBytes: modelSizeBytes,
          metadataTrust: 'verified_local',
          ggufMetadata: {
            totalBytes: modelSizeBytes,
            architecture: 'llama',
            nLayers: 32,
            nHeadKv: 16,
            nEmbdHeadK: 128,
            nEmbdHeadV: 128,
          },
          runtimeParams: {
            gpuLayers: 0,
            cacheTypeK: 'f16',
            cacheTypeV: 'f16',
            useMmap: true,
          },
        },
      }));
      expect(lastModelParametersSheetProps?.loadParamsDraft.contextSize).toBe(loweredCeiling);
      expect(getByTestId('context-size-value').props.children).toBe(String(loweredCeiling));
    });
  });
});
