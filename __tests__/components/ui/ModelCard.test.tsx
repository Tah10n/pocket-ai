import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../../src/types/models';
import { ModelCard } from '../../../src/components/ui/ModelCard';

const mockScreenBadge = jest.fn();
const mockT = jest.fn((key: string, options?: Record<string, unknown>) => {
  if (key === 'models.variantSelectorAccessibilityLabel') {
    return `${key}:${String(options?.modelName ?? '')}:${String(options?.value ?? '')}`;
  }

  return key;
});

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: mockT,
  }),
}));

jest.mock('../../../src/components/ui/box', () => {
  const mockReact = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  return {
    Box: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
  };
});

jest.mock('../../../src/components/ui/text', () => {
  const mockReact = jest.requireActual('react');
  const { Text } = jest.requireActual('react-native');
  return {
    Text: ({ children, ...props }: any) => mockReact.createElement(Text, props, children),
    composeTextRole: (_role: string, className = '') => className,
  };
});

jest.mock('../../../src/components/ui/button', () => {
  const mockReact = jest.requireActual('react');
  const { Pressable, Text } = jest.requireActual('react-native');
  return {
    Button: ({ children, onPress, ...props }: any) => mockReact.createElement(Pressable, { onPress, ...props }, children),
    ButtonText: ({ children, ...props }: any) => mockReact.createElement(Text, props, children),
  };
});

jest.mock('../../../src/components/ui/ScreenShell', () => {
  const mockReact = jest.requireActual('react');
  const { Pressable, Text, View } = jest.requireActual('react-native');
  return {
    getGlassCornerRadiusStyle: () => undefined,
    getGlassSurfaceFrameStyle: () => undefined,
    joinClassNames: (...values: Array<string | undefined | false>) => values.filter(Boolean).join(' '),
    useScreenAppearance: () => require('../../../src/utils/themeTokens').getThemeAppearance('default', 'light'),
    ScreenCard: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
    ScreenSurface: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
    ScreenPressableSurface: ({ children, onPress, ...props }: any) =>
      mockReact.createElement(Pressable, { onPress, ...props }, children),
    ScreenActionPill: ({ children, onPress, ...props }: any) =>
      mockReact.createElement(Pressable, { onPress, ...props }, children),
    ScreenIconButton: ({ onPress, ...props }: any) =>
      mockReact.createElement(Pressable, { onPress, ...props }),
    ScreenIconTile: ({ children, iconName, ...props }: any) =>
      mockReact.createElement(View, props, children ?? mockReact.createElement(Text, null, iconName)),
    ScreenBadge: (props: any) => {
      mockScreenBadge(props);
      return mockReact.createElement(Text, props, props.children);
    },
  };
});

jest.mock('../../../src/components/ui/pressable', () => {
  const mockReact = jest.requireActual('react');
  const { Pressable } = jest.requireActual('react-native');
  return {
    Pressable: ({ children, ...props }: any) => mockReact.createElement(Pressable, props, children),
  };
});

jest.mock('../../../src/components/ui/MaterialSymbols', () => {
  const mockReact = jest.requireActual('react');
  const { Text } = jest.requireActual('react-native');
  return {
    MaterialSymbols: ({ name }: any) => mockReact.createElement(Text, null, name),
  };
});

function buildModel(accessState: ModelAccessState): ModelMetadata {
  return {
    id: 'org/model',
    name: 'Model',
    author: 'org',
    size: 1024,
    downloadUrl: 'https://huggingface.co/org/model/resolve/main/model.gguf',
    fitsInRam: true,
    accessState,
    isGated: accessState !== ModelAccessState.PUBLIC,
    isPrivate: false,
    lifecycleStatus: LifecycleStatus.AVAILABLE,
    downloadProgress: 0,
  };
}

function buildModelCardHandlers(overrides: Partial<React.ComponentProps<typeof ModelCard>> = {}) {
  return {
    onOpenDetails: jest.fn(),
    onDownload: jest.fn(),
    onConfigureToken: jest.fn(),
    onOpenModelPage: jest.fn(),
    onLoad: jest.fn(),
    onOpenSettings: jest.fn(),
    onUnload: jest.fn(),
    onDelete: jest.fn(),
    onCancel: jest.fn(),
    onChat: jest.fn(),
    ...overrides,
  };
}

describe('ModelCard', () => {
  beforeEach(() => {
    mockScreenBadge.mockClear();
    mockT.mockClear();
  });

  it('renders a token CTA for auth-required models', () => {
    const onConfigureToken = jest.fn();
    const onOpenDetails = jest.fn();
    const screen = render(
      <ModelCard
        model={buildModel(ModelAccessState.AUTH_REQUIRED)}
        onOpenDetails={onOpenDetails}
        onDownload={jest.fn()}
        onConfigureToken={onConfigureToken}
        onOpenModelPage={jest.fn()}
        onLoad={jest.fn()}
        onOpenSettings={jest.fn()}
        onUnload={jest.fn()}
        onDelete={jest.fn()}
        onCancel={jest.fn()}
        onChat={jest.fn()}
        isActive={false}
      />,
    );

    expect(screen.getByText('models.requiresToken')).toBeTruthy();
    fireEvent.press(screen.getByText('models.setToken'));
    expect(onConfigureToken).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByTestId('model-details-org/model'));
    expect(onOpenDetails).toHaveBeenCalledWith('org/model');
  });

  it('renders an open-on-hf CTA for access-denied models', () => {
    const onOpenModelPage = jest.fn();
    const screen = render(
      <ModelCard
        model={buildModel(ModelAccessState.ACCESS_DENIED)}
        onOpenDetails={jest.fn()}
        onDownload={jest.fn()}
        onConfigureToken={jest.fn()}
        onOpenModelPage={onOpenModelPage}
        onLoad={jest.fn()}
        onOpenSettings={jest.fn()}
        onUnload={jest.fn()}
        onDelete={jest.fn()}
        onCancel={jest.fn()}
        onChat={jest.fn()}
        isActive={false}
      />,
    );

    expect(screen.getByText('models.accessDenied')).toBeTruthy();
    fireEvent.press(screen.getByText('models.openOnHuggingFace'));
    expect(onOpenModelPage).toHaveBeenCalledWith('org/model');
  });

  it('rerenders visible model text when name or author changes', () => {
    const screen = render(
      <ModelCard
        model={buildModel(ModelAccessState.PUBLIC)}
        onOpenDetails={jest.fn()}
        onDownload={jest.fn()}
        onConfigureToken={jest.fn()}
        onOpenModelPage={jest.fn()}
        onLoad={jest.fn()}
        onOpenSettings={jest.fn()}
        onUnload={jest.fn()}
        onDelete={jest.fn()}
        onCancel={jest.fn()}
        onChat={jest.fn()}
        isActive={false}
      />,
    );

    expect(screen.getByText('Model')).toBeTruthy();
    expect(screen.getByText('org')).toBeTruthy();

    screen.rerender(
      <ModelCard
        model={{
          ...buildModel(ModelAccessState.PUBLIC),
          name: 'Updated Model',
          author: 'updated-org',
        }}
        onOpenDetails={jest.fn()}
        onDownload={jest.fn()}
        onConfigureToken={jest.fn()}
        onOpenModelPage={jest.fn()}
        onLoad={jest.fn()}
        onOpenSettings={jest.fn()}
        onUnload={jest.fn()}
        onDelete={jest.fn()}
        onCancel={jest.fn()}
        onChat={jest.fn()}
        isActive={false}
      />,
    );

    expect(screen.getByText('Updated Model')).toBeTruthy();
    expect(screen.getByText('updated-org')).toBeTruthy();
  });

  it('renders a settings CTA for downloaded models', () => {
    const onOpenSettings = jest.fn();
    const screen = render(
      <ModelCard
        model={{
          ...buildModel(ModelAccessState.PUBLIC),
          lifecycleStatus: LifecycleStatus.DOWNLOADED,
        }}
        onOpenDetails={jest.fn()}
        onDownload={jest.fn()}
        onConfigureToken={jest.fn()}
        onOpenModelPage={jest.fn()}
        onLoad={jest.fn()}
        onOpenSettings={onOpenSettings}
        onUnload={jest.fn()}
        onDelete={jest.fn()}
        onCancel={jest.fn()}
        onChat={jest.fn()}
        isActive={false}
      />,
    );

    fireEvent.press(screen.getByText('models.settings'));

    expect(onOpenSettings).toHaveBeenCalledWith('org/model');
  });

  it('keeps a settings CTA for active models', () => {
    const onOpenSettings = jest.fn();
    const screen = render(
      <ModelCard
        model={{
          ...buildModel(ModelAccessState.PUBLIC),
          lifecycleStatus: LifecycleStatus.ACTIVE,
        }}
        onOpenDetails={jest.fn()}
        onDownload={jest.fn()}
        onConfigureToken={jest.fn()}
        onOpenModelPage={jest.fn()}
        onLoad={jest.fn()}
        onOpenSettings={onOpenSettings}
        onUnload={jest.fn()}
        onDelete={jest.fn()}
        onCancel={jest.fn()}
        onChat={jest.fn()}
        isActive
      />,
    );

    fireEvent.press(screen.getByText('models.settings'));

    expect(onOpenSettings).toHaveBeenCalledWith('org/model');
  });

  it('renders the active badge with success tone', () => {
    render(
      <ModelCard
        model={{
          ...buildModel(ModelAccessState.PUBLIC),
          lifecycleStatus: LifecycleStatus.ACTIVE,
        }}
        onOpenDetails={jest.fn()}
        onDownload={jest.fn()}
        onConfigureToken={jest.fn()}
        onOpenModelPage={jest.fn()}
        onLoad={jest.fn()}
        onOpenSettings={jest.fn()}
        onUnload={jest.fn()}
        onDelete={jest.fn()}
        onCancel={jest.fn()}
        onChat={jest.fn()}
        isActive
      />,
    );

    expect(
      mockScreenBadge.mock.calls.some(([props]) => props.tone === 'success' && props.children === 'common.active'),
    ).toBe(true);
  });

  it('renders a vision badge for vision-capable primary chat models', () => {
    render(
      <ModelCard
        model={{
          ...buildModel(ModelAccessState.PUBLIC),
          chatModalities: ['text', 'vision'],
          artifactRole: 'primary_chat_model',
          projectorCandidates: [{
            id: 'projector-org-model-main-mmproj-model-f16.gguf',
            ownerModelId: 'org/model',
            repoId: 'org/model',
            fileName: 'mmproj-model-f16.gguf',
            downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-model-f16.gguf',
            size: 536_870_912,
            lifecycleStatus: 'available',
            matchStatus: 'matched',
          }],
        }}
        {...buildModelCardHandlers()}
        isActive={false}
      />,
    );

    expect(
      mockScreenBadge.mock.calls.some(([props]) => (
        props.tone === 'warning'
        && props.iconName === 'visibility'
        && props.children === 'models.vision.badge'
      )),
    ).toBe(true);
  });

  it('renders an audio badge for native-audio primary chat models', () => {
    const audioProjector = {
      id: 'audio-projector',
      ownerModelId: 'org/model',
      repoId: 'org/model',
      fileName: 'mmproj-audio.gguf',
      downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-audio.gguf',
      size: 536_870_912,
      lifecycleStatus: 'available' as const,
      matchStatus: 'matched' as const,
    };
    const screen = render(
      <ModelCard
        model={{
          ...buildModel(ModelAccessState.PUBLIC),
          chatModalities: ['text', 'audio'],
          artifactRole: 'primary_chat_model',
          projectorCandidates: [audioProjector],
          artifacts: [{
            id: audioProjector.id,
            kind: 'multimodal_projector',
            requiredFor: ['audio'],
            remoteFileName: audioProjector.fileName,
            downloadUrl: audioProjector.downloadUrl,
            sizeBytes: audioProjector.size,
            installState: 'remote',
          }],
        }}
        {...buildModelCardHandlers()}
        isActive={false}
      />,
    );

    expect(
      mockScreenBadge.mock.calls.some(([props]) => (
        props.tone === 'info'
        && props.iconName === 'graphic-eq'
        && props.children === 'models.audio.badge'
      )),
    ).toBe(true);
    expect(screen.queryByText('models.vision.badge')).toBeNull();
  });

  it('rerenders when discovered audio capability changes the model card badge', () => {
    const handlers = buildModelCardHandlers();
    const createModel = (audio: 'unknown' | 'supported'): ModelMetadata => ({
      ...buildModel(ModelAccessState.PUBLIC),
      artifactRole: 'primary_chat_model',
      inputCapabilities: {
        detectedAt: audio === 'supported' ? 2 : 1,
        declared: {
          image: 'unknown',
          audio,
          video: 'unknown',
        },
        evidence: audio === 'supported'
          ? [{ source: 'tag', value: 'audio', confidence: 'medium' }]
          : [],
      },
      projectorCandidates: audio === 'supported'
        ? [{
          id: 'audio-projector',
          ownerModelId: 'org/model',
          repoId: 'org/model',
          fileName: 'mmproj-audio-model-f16.gguf',
          downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-audio-model-f16.gguf',
          size: 1024,
          lifecycleStatus: 'available',
          matchStatus: 'matched',
        }]
        : undefined,
    });
    const screen = render(
      <ModelCard
        model={createModel('unknown')}
        {...handlers}
        isActive={false}
      />,
    );

    expect(screen.queryByText('models.audio.badge')).toBeNull();

    screen.rerender(
      <ModelCard
        model={createModel('supported')}
        {...handlers}
        isActive={false}
      />,
    );

    expect(screen.getByText('models.audio.badge')).toBeTruthy();
  });

  it('does not inherit a top-level audio badge for an active text-only variant', () => {
    const screen = render(
      <ModelCard
        model={{
          ...buildModel(ModelAccessState.PUBLIC),
          chatModalities: ['text', 'audio'],
          activeVariantId: 'model.Q4_K_M.gguf',
          resolvedFileName: 'model.Q4_K_M.gguf',
          variants: [{
            variantId: 'model.Q4_K_M.gguf',
            fileName: 'model.Q4_K_M.gguf',
            quantizationLabel: 'Q4_K_M',
            size: 4_000_000_000,
            chatModalities: ['text'],
          }],
        }}
        {...buildModelCardHandlers()}
        isActive={false}
      />,
    );

    expect(screen.queryByText('models.audio.badge')).toBeNull();
  });

  it('shows only audio capability for an active audio-only variant with parent vision metadata', () => {
    const audioProjector = {
      id: 'audio-projector',
      ownerModelId: 'org/model',
      ownerVariantId: 'audio-variant',
      repoId: 'org/model',
      fileName: 'mmproj-audio.gguf',
      downloadUrl: 'https://example.com/mmproj-audio.gguf',
      size: 1,
      lifecycleStatus: 'available' as const,
      matchStatus: 'matched' as const,
    };
    const screen = render(
      <ModelCard
        model={{
          ...buildModel(ModelAccessState.PUBLIC),
          chatModalities: ['text', 'vision'],
          activeVariantId: 'audio-variant',
          resolvedFileName: 'audio.gguf',
          variants: [{
            variantId: 'audio-variant',
            fileName: 'audio.gguf',
            quantizationLabel: 'Q4_K_M',
            size: 1,
            chatModalities: ['text', 'audio'],
            projectorCandidates: [audioProjector],
          }],
          projectorCandidates: [audioProjector],
        }}
        {...buildModelCardHandlers()}
        isActive={false}
      />,
    );

    expect(screen.getByText('models.audio.badge')).toBeTruthy();
    expect(screen.queryByText('models.vision.badge')).toBeNull();
  });

  it('counts only the audio projector in active audio-only variant display size', () => {
    const audioProjector = {
      id: 'audio-projector',
      ownerModelId: 'org/model',
      ownerVariantId: 'audio-variant',
      repoId: 'org/model',
      fileName: 'mmproj-audio.gguf',
      downloadUrl: 'https://example.com/mmproj-audio.gguf',
      hfRevision: 'main',
      size: 200_000_000,
      lifecycleStatus: 'available' as const,
      matchStatus: 'matched' as const,
    };
    const visionProjector = {
      ...audioProjector,
      id: 'vision-projector',
      fileName: 'mmproj-vision.gguf',
      downloadUrl: 'https://example.com/mmproj-vision.gguf',
      size: 500_000_000,
      matchStatus: 'user_selected' as const,
    };
    const screen = render(
      <ModelCard
        model={{
          ...buildModel(ModelAccessState.PUBLIC),
          size: 1_000_000_000,
          chatModalities: ['text', 'vision'],
          activeVariantId: 'audio-variant',
          resolvedFileName: 'audio.gguf',
          selectedProjectorId: visionProjector.id,
          variants: [{
            variantId: 'audio-variant',
            fileName: 'audio.gguf',
            quantizationLabel: 'Q4_K_M',
            size: 1_000_000_000,
            chatModalities: ['text', 'audio'],
            projectorCandidates: [audioProjector, visionProjector],
          }],
          projectorCandidates: [audioProjector, visionProjector],
          artifacts: [
            {
              id: audioProjector.id,
              kind: 'multimodal_projector',
              requiredFor: ['audio'],
              hfRevision: 'main',
              remoteFileName: audioProjector.fileName,
              downloadUrl: audioProjector.downloadUrl,
              sizeBytes: audioProjector.size,
              installState: 'remote',
            },
            {
              id: visionProjector.id,
              kind: 'multimodal_projector',
              requiredFor: ['image'],
              hfRevision: 'main',
              remoteFileName: visionProjector.fileName,
              downloadUrl: visionProjector.downloadUrl,
              sizeBytes: visionProjector.size,
              installState: 'remote',
            },
          ],
        }}
        {...buildModelCardHandlers()}
        isActive={false}
      />,
    );

    expect(screen.getByText('Q4_K_M - 1.20 GB')).toBeTruthy();
    expect(screen.getByText('models.audio.badge')).toBeTruthy();
    expect(screen.queryByText('models.vision.badge')).toBeNull();
  });

  it('includes matched projector bytes in the displayed vision model size', () => {
    const screen = render(
      <ModelCard
        model={{
          ...buildModel(ModelAccessState.PUBLIC),
          size: 3_800_000_000,
          gguf: {
            sizeLabel: 'Q4_K_M',
          },
          chatModalities: ['text', 'vision'],
          artifactRole: 'primary_chat_model',
          projectorCandidates: [{
            id: 'projector-org-model-main-mmproj-model-f16.gguf',
            ownerModelId: 'org/model',
            repoId: 'org/model',
            fileName: 'mmproj-model-f16.gguf',
            downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-model-f16.gguf',
            size: 200_000_000,
            lifecycleStatus: 'available',
            matchStatus: 'matched',
          }],
        }}
        {...buildModelCardHandlers()}
        isActive={false}
      />,
    );

    expect(screen.getByText('Q4_K_M - 4.00 GB')).toBeTruthy();
  });

  it('rerenders when the selected projector id changes the displayed size', () => {
    const createVisionModel = (selectedProjectorId: string): ModelMetadata => ({
      ...buildModel(ModelAccessState.PUBLIC),
      size: 3_800_000_000,
      gguf: {
        sizeLabel: 'Q4_K_M',
      },
      chatModalities: ['text', 'vision'],
      artifactRole: 'primary_chat_model',
      selectedProjectorId,
      projectorCandidates: [
        {
          id: 'projector-small',
          ownerModelId: 'org/model',
          repoId: 'org/model',
          fileName: 'mmproj-small.gguf',
          downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-small.gguf',
          size: 100_000_000,
          lifecycleStatus: 'available',
          matchStatus: 'matched',
        },
        {
          id: 'projector-large',
          ownerModelId: 'org/model',
          repoId: 'org/model',
          fileName: 'mmproj-large.gguf',
          downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-large.gguf',
          size: 300_000_000,
          lifecycleStatus: 'available',
          matchStatus: 'matched',
        },
      ],
    });
    const handlers = buildModelCardHandlers();
    const screen = render(
      <ModelCard
        model={createVisionModel('projector-small')}
        {...handlers}
        isActive={false}
      />,
    );

    expect(screen.getByText('Q4_K_M - 3.90 GB')).toBeTruthy();

    screen.rerender(
      <ModelCard
        model={createVisionModel('projector-large')}
        {...handlers}
        isActive={false}
      />,
    );

    expect(screen.queryByText('Q4_K_M - 3.90 GB')).toBeNull();
    expect(screen.getByText('Q4_K_M - 4.10 GB')).toBeTruthy();
  });

  it('uses active variant projector bytes and rerenders when projector size changes', () => {
    const createVisionModel = (projectorSize: number): ModelMetadata => ({
      ...buildModel(ModelAccessState.PUBLIC),
      size: 3_800_000_000,
      activeVariantId: 'model.Q4_K_M.gguf',
      chatModalities: ['text', 'vision'],
      artifactRole: 'primary_chat_model',
      variants: [{
        variantId: 'model.Q4_K_M.gguf',
        fileName: 'model.Q4_K_M.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 3_800_000_000,
        projectorCandidates: [{
          id: 'projector-org-model-main-mmproj-model-f16.gguf',
          ownerModelId: 'org/model',
          ownerVariantId: 'model.Q4_K_M.gguf',
          repoId: 'org/model',
          fileName: 'mmproj-model-f16.gguf',
          downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-model-f16.gguf',
          size: projectorSize,
          lifecycleStatus: 'available',
          matchStatus: 'matched',
        }],
      }],
    });

    const handlers = buildModelCardHandlers();
    const screen = render(
      <ModelCard
        model={createVisionModel(100_000_000)}
        {...handlers}
        isActive={false}
      />,
    );

    expect(screen.getByText('Q4_K_M - 3.90 GB')).toBeTruthy();

    screen.rerender(
      <ModelCard
        model={createVisionModel(200_000_000)}
        {...handlers}
        isActive={false}
      />,
    );

    expect(screen.queryByText('Q4_K_M - 3.90 GB')).toBeNull();
    expect(screen.getByText('Q4_K_M - 4.00 GB')).toBeTruthy();
  });

  it('ignores a stale selected projector id from another variant when displaying active variant size', () => {
    const screen = render(
      <ModelCard
        model={{
          ...buildModel(ModelAccessState.PUBLIC),
          size: 3_800_000_000,
          activeVariantId: 'model.Q4_K_M.gguf',
          resolvedFileName: 'model.Q4_K_M.gguf',
          selectedProjectorId: 'projector-q8',
          chatModalities: ['text', 'vision'],
          artifactRole: 'primary_chat_model',
          variants: [
            {
              variantId: 'model.Q4_K_M.gguf',
              fileName: 'model.Q4_K_M.gguf',
              quantizationLabel: 'Q4_K_M',
              size: 3_800_000_000,
            },
            {
              variantId: 'model.Q8_0.gguf',
              fileName: 'model.Q8_0.gguf',
              quantizationLabel: 'Q8_0',
              size: 7_200_000_000,
            },
          ],
          projectorCandidates: [
            {
              id: 'projector-q4',
              ownerModelId: 'org/model',
              ownerVariantId: 'model.Q4_K_M.gguf',
              repoId: 'org/model',
              fileName: 'mmproj-q4.gguf',
              downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-q4.gguf',
              size: 200_000_000,
              lifecycleStatus: 'available',
              matchStatus: 'matched',
            },
            {
              id: 'projector-q8',
              ownerModelId: 'org/model',
              ownerVariantId: 'model.Q8_0.gguf',
              repoId: 'org/model',
              fileName: 'mmproj-q8.gguf',
              downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-q8.gguf',
              size: 500_000_000,
              lifecycleStatus: 'available',
              matchStatus: 'user_selected',
            },
          ],
        }}
        {...buildModelCardHandlers()}
        isActive={false}
      />,
    );

    expect(screen.getByText('Q4_K_M - 4.00 GB')).toBeTruthy();
    expect(screen.queryByText('Q4_K_M - 4.30 GB')).toBeNull();
  });

  it('rerenders when only selected projector runtime progress changes', () => {
    const createVisionDownloadModel = (projectorProgress: number): ModelMetadata => ({
      ...buildModel(ModelAccessState.PUBLIC),
      lifecycleStatus: LifecycleStatus.DOWNLOADING,
      downloadProgress: 1,
      chatModalities: ['text', 'vision'],
      artifactRole: 'primary_chat_model',
      selectedProjectorId: 'projector-org-model-main-mmproj-model-f16.gguf',
      projectorCandidates: [{
        id: 'projector-org-model-main-mmproj-model-f16.gguf',
        ownerModelId: 'org/model',
        repoId: 'org/model',
        fileName: 'mmproj-model-f16.gguf',
        downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-model-f16.gguf',
        sha256: 'projector-sha',
        size: 200_000_000,
        localPath: '/models/mmproj-model-f16.gguf.partial',
        resumeData: 'resume-token',
        downloadProgress: projectorProgress,
        lifecycleStatus: 'downloading',
        matchStatus: 'matched',
        matchReason: 'selected projector',
      }],
    });

    const handlers = buildModelCardHandlers();
    const screen = render(
      <ModelCard
        model={createVisionDownloadModel(0.25)}
        {...handlers}
        isActive={false}
      />,
    );

    expect(screen.getByText('models.multimodal.projectorDownloading')).toBeTruthy();
    expect(screen.getByText('25%')).toBeTruthy();

    screen.rerender(
      <ModelCard
        model={createVisionDownloadModel(0.5)}
        {...handlers}
        isActive={false}
      />,
    );

    expect(screen.queryByText('25%')).toBeNull();
    expect(screen.getByText('50%')).toBeTruthy();
  });

  it('passes updated model resume data after a token-only rerender', () => {
    const createPausedModel = (resumeData: string): ModelMetadata => ({
      ...buildModel(ModelAccessState.PUBLIC),
      lifecycleStatus: LifecycleStatus.PAUSED,
      downloadProgress: 0.5,
      resumeData,
    });
    const handlers = buildModelCardHandlers();
    const screen = render(
      <ModelCard
        model={createPausedModel('resume-token-old')}
        {...handlers}
        isActive={false}
      />,
    );

    screen.rerender(
      <ModelCard
        model={createPausedModel('resume-token-new')}
        {...handlers}
        isActive={false}
      />,
    );

    fireEvent.press(screen.getByText('models.resume'));

    expect(handlers.onDownload).toHaveBeenCalledWith(expect.objectContaining({
      resumeData: 'resume-token-new',
    }));
  });

  it('passes updated projector resume data after a token-only rerender', () => {
    const createDownloadedVisionModel = (projectorResumeData: string): ModelMetadata => ({
      ...buildModel(ModelAccessState.PUBLIC),
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      chatModalities: ['text', 'vision'],
      artifactRole: 'primary_chat_model',
      selectedProjectorId: 'projector-org-model-main-mmproj-model-f16.gguf',
      projectorCandidates: [{
        id: 'projector-org-model-main-mmproj-model-f16.gguf',
        ownerModelId: 'org/model',
        repoId: 'org/model',
        fileName: 'mmproj-model-f16.gguf',
        downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-model-f16.gguf',
        sha256: 'projector-sha',
        size: 200_000_000,
        resumeData: projectorResumeData,
        downloadProgress: 0.5,
        lifecycleStatus: 'paused',
        matchStatus: 'matched',
      }],
    });
    const handlers = buildModelCardHandlers();
    const screen = render(
      <ModelCard
        model={createDownloadedVisionModel('projector-resume-old')}
        {...handlers}
        isActive={false}
      />,
    );

    screen.rerender(
      <ModelCard
        model={createDownloadedVisionModel('projector-resume-new')}
        {...handlers}
        isActive={false}
      />,
    );

    fireEvent.press(screen.getByTestId('model-projector-resume-org/model'));

    expect(handlers.onDownload).toHaveBeenCalledWith(expect.objectContaining({
      projectorCandidates: [expect.objectContaining({
        resumeData: 'projector-resume-new',
      })],
    }));
  });

  it('rerenders when projector ownership changes active variant compatibility', () => {
    const createDownloadedVisionModel = (ownerVariantId: string): ModelMetadata => ({
      ...buildModel(ModelAccessState.PUBLIC),
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      activeVariantId: 'model-q4',
      resolvedFileName: 'model-q4.gguf',
      chatModalities: ['text', 'vision'],
      artifactRole: 'primary_chat_model',
      selectedProjectorId: 'projector-org-model-main-mmproj-model-f16.gguf',
      projectorCandidates: [{
        id: 'projector-org-model-main-mmproj-model-f16.gguf',
        ownerModelId: 'org/model',
        ownerVariantId,
        repoId: 'org/model',
        fileName: 'mmproj-model-f16.gguf',
        downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-model-f16.gguf',
        sha256: 'projector-sha',
        size: 200_000_000,
        lifecycleStatus: 'available',
        matchStatus: 'matched',
      }],
    });
    const handlers = buildModelCardHandlers();
    const screen = render(
      <ModelCard
        model={createDownloadedVisionModel('model-q4')}
        {...handlers}
        isActive={false}
      />,
    );

    expect(screen.getByTestId('model-projector-download-org/model')).toBeTruthy();

    screen.rerender(
      <ModelCard
        model={createDownloadedVisionModel('model-q8')}
        {...handlers}
        isActive={false}
      />,
    );

    expect(screen.queryByTestId('model-projector-download-org/model')).toBeNull();
  });

  it('does not render a vision badge for projector companion artifacts', () => {
    render(
      <ModelCard
        model={{
          ...buildModel(ModelAccessState.PUBLIC),
          chatModalities: ['vision'],
          artifactRole: 'projector_companion',
        }}
        {...buildModelCardHandlers()}
        isActive={false}
      />,
    );

    expect(
      mockScreenBadge.mock.calls.some(([props]) => props.children === 'models.vision.badge'),
    ).toBe(false);
  });

  it('does not let multimodal readiness reconstruct vision capability without a projector path', () => {
    const handlers = buildModelCardHandlers();
    const createModel = (ready: boolean): ModelMetadata => ({
      ...buildModel(ModelAccessState.PUBLIC),
      multimodalReadiness: ready
        ? {
            modelId: 'org/model',
            variantId: 'model.Q4_K_M.gguf',
            status: 'ready',
            projectorId: 'projector-q4',
            support: ['vision'],
            checkedAt: 2,
          }
        : {
            modelId: 'org/model',
            variantId: 'model.Q4_K_M.gguf',
            status: 'text_only',
            support: [],
            checkedAt: 1,
          },
    });
    const screen = render(
      <ModelCard
        model={createModel(false)}
        {...handlers}
        isActive={false}
      />,
    );

    expect(screen.queryByText('models.vision.badge')).toBeNull();

    screen.rerender(
      <ModelCard
        model={createModel(true)}
        {...handlers}
        isActive={false}
      />,
    );

    expect(screen.queryByText('models.vision.badge')).toBeNull();
  });

  it('renders the active quantization memory badge on the model card row', () => {
    const screen = render(
      <ModelCard
        model={{
          ...buildModel(ModelAccessState.PUBLIC),
          size: 3_800_000_000,
          fitsInRam: false,
          memoryFitDecision: 'borderline',
          gguf: {
            sizeLabel: 'Q4_K_M',
            totalBytes: 3_800_000_000,
          },
        }}
        onOpenDetails={jest.fn()}
        onDownload={jest.fn()}
        onConfigureToken={jest.fn()}
        onOpenModelPage={jest.fn()}
        onLoad={jest.fn()}
        onOpenSettings={jest.fn()}
        onUnload={jest.fn()}
        onDelete={jest.fn()}
        onCancel={jest.fn()}
        onChat={jest.fn()}
        isActive={false}
      />,
    );

    expect(screen.queryByText('models.quantizationLabel')).toBeNull();
    expect(screen.getByText('Q4_K_M - 3.80 GB')).toBeTruthy();
    expect(
      mockScreenBadge.mock.calls.some(([props]) => props.tone === 'warning' && props.children === 'models.ramBorderline'),
    ).toBe(true);
  });

  it('keeps RAM warning visible when quantization metadata is unavailable', () => {
    const screen = render(
      <ModelCard
        model={{
          ...buildModel(ModelAccessState.PUBLIC),
          size: 3_800_000_000,
          fitsInRam: false,
          memoryFitDecision: 'likely_oom',
        }}
        {...buildModelCardHandlers()}
        isActive={false}
      />,
    );

    expect(screen.queryByText('models.quantizationLabel')).toBeNull();
    expect(
      mockScreenBadge.mock.calls.some(([props]) => props.tone === 'error' && props.children === 'models.ramLikelyOom'),
    ).toBe(true);
  });

  it('does not render a separate quantization badge for downloaded models', () => {
    const screen = render(
      <ModelCard
        model={{
          ...buildModel(ModelAccessState.PUBLIC),
          lifecycleStatus: LifecycleStatus.DOWNLOADED,
          size: 3_800_000_000,
          gguf: {
            sizeLabel: 'Q4_K_M',
          },
        }}
        onOpenDetails={jest.fn()}
        onDownload={jest.fn()}
        onConfigureToken={jest.fn()}
        onOpenModelPage={jest.fn()}
        onLoad={jest.fn()}
        onOpenSettings={jest.fn()}
        onUnload={jest.fn()}
        onDelete={jest.fn()}
        onCancel={jest.fn()}
        onChat={jest.fn()}
        isActive={false}
      />,
    );

    expect(screen.getByText('Q4_K_M - 3.80 GB')).toBeTruthy();
    expect(screen.queryByText('models.quantizationLabel')).toBeNull();
    expect(
      mockScreenBadge.mock.calls.some(([props]) => props.tone === 'neutral' && props.children === 'Q4_K_M'),
    ).toBe(false);
  });

  it('renders a quantization and size row when GGUF metadata is complete', () => {
    const screen = render(
      <ModelCard
        model={{
          ...buildModel(ModelAccessState.PUBLIC),
          size: 3_800_000_000,
          gguf: {
            sizeLabel: 'Q4_K_M',
          },
        }}
        onOpenDetails={jest.fn()}
        onDownload={jest.fn()}
        onConfigureToken={jest.fn()}
        onOpenModelPage={jest.fn()}
        onLoad={jest.fn()}
        onOpenSettings={jest.fn()}
        onUnload={jest.fn()}
        onDelete={jest.fn()}
        onCancel={jest.fn()}
        onChat={jest.fn()}
        isActive={false}
      />,
    );

    expect(screen.queryByText('models.quantizationLabel')).toBeNull();
    expect(screen.getByText('Q4_K_M - 3.80 GB')).toBeTruthy();
    expect(screen.queryByText('chevron-right')).toBeNull();
  });

  it('hides the quantization row when GGUF size metadata is missing', () => {
    const screen = render(
      <ModelCard
        model={{
          ...buildModel(ModelAccessState.PUBLIC),
          size: 3_800_000_000,
        }}
        onOpenDetails={jest.fn()}
        onDownload={jest.fn()}
        onConfigureToken={jest.fn()}
        onOpenModelPage={jest.fn()}
        onLoad={jest.fn()}
        onOpenSettings={jest.fn()}
        onUnload={jest.fn()}
        onDelete={jest.fn()}
        onCancel={jest.fn()}
        onChat={jest.fn()}
        isActive={false}
      />,
    );

    expect(screen.queryByText('models.quantizationLabel')).toBeNull();
    expect(screen.queryByText('Q4_K_M - 3.80 GB')).toBeNull();
    expect(
      mockScreenBadge.mock.calls.some(([props]) => {
        const children = Array.isArray(props.children) ? props.children.join('') : String(props.children);
        return children.includes('models.sizeLabel') && children.includes('3.80 GB');
      }),
    ).toBe(true);
  });

  it('does not show a chevron when variants exist but no selector handler is wired', () => {
    const screen = render(
      <ModelCard
        model={{
          ...buildModel(ModelAccessState.PUBLIC),
          size: 3_800_000_000,
          gguf: {
            sizeLabel: 'Q4_K_M',
          },
          variants: [
            { variantId: 'q4', fileName: 'model.Q4_K_M.gguf', quantizationLabel: 'Q4_K_M', size: 3_800_000_000 },
            { variantId: 'q6', fileName: 'model.Q6_K.gguf', quantizationLabel: 'Q6_K', size: 4_100_000_000 },
          ],
        }}
        onOpenDetails={jest.fn()}
        onDownload={jest.fn()}
        onConfigureToken={jest.fn()}
        onOpenModelPage={jest.fn()}
        onLoad={jest.fn()}
        onOpenSettings={jest.fn()}
        onUnload={jest.fn()}
        onDelete={jest.fn()}
        onCancel={jest.fn()}
        onChat={jest.fn()}
        isActive={false}
      />,
    );

    expect(screen.queryByText('chevron-right')).toBeNull();
    const selectorRow = screen.getByTestId('model-variant-selector-org/model');
    expect(selectorRow.props.accessibilityLabel).toBe('models.variantSelectorAccessibilityLabel:Model:Q4_K_M - 3.80 GB');
    expect(selectorRow.props.accessibilityHint).toBe('models.variantSelectorReadOnlyAccessibilityHint');
  });

  it('opens the variant selector when multiple variants are available', () => {
    const onOpenVariantSelector = jest.fn();
    const screen = render(
      <ModelCard
        model={{
          ...buildModel(ModelAccessState.PUBLIC),
          size: 3_800_000_000,
          resolvedFileName: 'model.Q4_K_M.gguf',
          activeVariantId: 'model.Q4_K_M.gguf',
          gguf: {
            sizeLabel: 'Q4_K_M',
          },
          variants: [
            { variantId: 'model.Q4_K_M.gguf', fileName: 'model.Q4_K_M.gguf', quantizationLabel: 'Q4_K_M', size: 3_800_000_000 },
            { variantId: 'model.Q8_0.gguf', fileName: 'model.Q8_0.gguf', quantizationLabel: 'Q8_0', size: 7_200_000_000 },
          ],
        }}
        onOpenDetails={jest.fn()}
        onDownload={jest.fn()}
        onConfigureToken={jest.fn()}
        onOpenVariantSelector={onOpenVariantSelector}
        onOpenModelPage={jest.fn()}
        onLoad={jest.fn()}
        onOpenSettings={jest.fn()}
        onUnload={jest.fn()}
        onDelete={jest.fn()}
        onCancel={jest.fn()}
        onChat={jest.fn()}
        isActive={false}
      />,
    );

    const selectorRow = screen.getByTestId('model-variant-selector-org/model');
    expect(selectorRow.props.accessibilityLabel).toBe('models.variantSelectorAccessibilityLabel:Model:Q4_K_M - 3.80 GB');
    expect(selectorRow.props.accessibilityHint).toBe('models.variantSelectorAccessibilityHint');
    expect(mockT).toHaveBeenCalledWith('models.variantSelectorAccessibilityLabel', {
      modelName: 'Model',
      value: 'Q4_K_M - 3.80 GB',
    });

    fireEvent.press(selectorRow);

    expect(screen.getByText('chevron-right')).toBeTruthy();
    expect(onOpenVariantSelector).toHaveBeenCalledWith('org/model');
  });

  it.each([
    LifecycleStatus.PAUSED,
    LifecycleStatus.FAILED,
  ])('keeps the variant selector read-only for %s models', (lifecycleStatus) => {
    const onOpenVariantSelector = jest.fn();
    const screen = render(
      <ModelCard
        model={{
          ...buildModel(ModelAccessState.PUBLIC),
          lifecycleStatus,
          size: 3_800_000_000,
          resolvedFileName: 'model.Q4_K_M.gguf',
          activeVariantId: 'model.Q4_K_M.gguf',
          gguf: {
            sizeLabel: 'Q4_K_M',
          },
          variants: [
            { variantId: 'model.Q4_K_M.gguf', fileName: 'model.Q4_K_M.gguf', quantizationLabel: 'Q4_K_M', size: 3_800_000_000 },
            { variantId: 'model.Q8_0.gguf', fileName: 'model.Q8_0.gguf', quantizationLabel: 'Q8_0', size: 7_200_000_000 },
          ],
        }}
        {...buildModelCardHandlers({ onOpenVariantSelector })}
        isActive={false}
      />,
    );

    const selectorRow = screen.getByTestId('model-variant-selector-org/model');
    expect(selectorRow.props.accessibilityHint).toBe('models.variantSelectorReadOnlyAccessibilityHint');

    fireEvent.press(selectorRow);
    expect(screen.queryByText('chevron-right')).toBeNull();
    expect(onOpenVariantSelector).not.toHaveBeenCalled();
  });

  it('keeps the variant selector available when the active variant size is unknown', () => {
    const onOpenVariantSelector = jest.fn();
    const screen = render(
      <ModelCard
        model={{
          ...buildModel(ModelAccessState.PUBLIC),
          size: null,
          resolvedFileName: 'model.Q4_K_M.gguf',
          activeVariantId: 'model.Q4_K_M.gguf',
          variants: [
            { variantId: 'model.Q4_K_M.gguf', fileName: 'model.Q4_K_M.gguf', quantizationLabel: 'Q4_K_M', size: null },
            { variantId: 'model.Q8_0.gguf', fileName: 'model.Q8_0.gguf', quantizationLabel: 'Q8_0', size: 7_200_000_000 },
          ],
        }}
        {...buildModelCardHandlers({ onOpenVariantSelector })}
        isActive={false}
      />,
    );

    expect(screen.getByText('Q4_K_M - models.sizeUnknown')).toBeTruthy();
    expect(screen.queryByText('models.sizeUnknownBadge')).toBeNull();

    fireEvent.press(screen.getByTestId('model-variant-selector-org/model'));
    expect(onOpenVariantSelector).toHaveBeenCalledWith('org/model');
  });

  it('rerenders when catalog refresh changes active variant metadata without changing variant count', () => {
    const handlers = buildModelCardHandlers({ onOpenVariantSelector: jest.fn() });
    const baseModel = {
      ...buildModel(ModelAccessState.PUBLIC),
      size: 3_800_000_000,
      resolvedFileName: 'model.Q4_K_M.gguf',
      activeVariantId: 'model.Q4_K_M.gguf',
      variants: [
        { variantId: 'model.Q4_K_M.gguf', fileName: 'model.Q4_K_M.gguf', quantizationLabel: 'Q4_K_M', size: 3_800_000_000 },
        { variantId: 'model.Q8_0.gguf', fileName: 'model.Q8_0.gguf', quantizationLabel: 'Q8_0', size: 7_200_000_000 },
      ],
    } satisfies ModelMetadata;
    const screen = render(
      <ModelCard
        model={baseModel}
        {...handlers}
        isActive={false}
      />,
    );

    expect(screen.getByText('Q4_K_M - 3.80 GB')).toBeTruthy();

    screen.rerender(
      <ModelCard
        model={{
          ...baseModel,
          variants: [
            { variantId: 'model.Q4_K_M.gguf', fileName: 'model.Q4_K_M.gguf', quantizationLabel: 'Q4_K_M', size: 4_100_000_000 },
            { variantId: 'model.Q8_0.gguf', fileName: 'model.Q8_0.gguf', quantizationLabel: 'Q8_0', size: 7_200_000_000 },
          ],
        }}
        {...handlers}
        isActive={false}
      />,
    );

    expect(screen.queryByText('Q4_K_M - 3.80 GB')).toBeNull();
    expect(screen.getByText('Q4_K_M - 4.10 GB')).toBeTruthy();
  });
});
