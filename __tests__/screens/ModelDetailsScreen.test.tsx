import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { Linking } from 'react-native';
import { ModelDetailsScreen } from '../../src/ui/screens/ModelDetailsScreen';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';

const mockRouter = {
  back: jest.fn(),
  canGoBack: jest.fn(() => true),
  push: jest.fn(),
  replace: jest.fn(),
};

const mockDetailModel: ModelMetadata = {
  id: 'org/model',
  name: 'Model',
  author: 'org',
  size: 1024,
  downloadUrl: 'https://huggingface.co/org/model/resolve/main/model.gguf',
  fitsInRam: true,
  accessState: ModelAccessState.PUBLIC,
  isGated: false,
  isPrivate: false,
  lifecycleStatus: LifecycleStatus.AVAILABLE,
  downloadProgress: 0,
  downloads: 1200,
  likes: 88,
  tags: ['gguf', 'chat'],
  description: 'A compact GGUF model.',
  modelType: 'llama',
  architectures: ['LlamaForCausalLM'],
  baseModels: ['meta-llama/Llama-3.1-8B-Instruct'],
  license: 'llama3.1',
  languages: ['en', 'de'],
  datasets: ['ultrachat_200k'],
  quantizedBy: 'bartowski',
  modelCreator: 'Meta',
};

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({ modelId: 'org/model' }),
}));

jest.mock('../../src/components/ui/box', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return {
    Box: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
  };
});

jest.mock('../../src/components/ui/button', () => {
  const mockReact = require('react');
  const { Pressable, Text } = require('react-native');
  return {
    Button: ({ children, onPress, disabled, ...props }: any) =>
      mockReact.createElement(Pressable, { onPress, disabled, ...props }, children),
    ButtonText: ({ children, ...props }: any) => mockReact.createElement(Text, props, children),
  };
});

jest.mock('../../src/components/ui/MaterialSymbols', () => {
  const mockReact = require('react');
  const { Text } = require('react-native');
  return {
    MaterialSymbols: ({ name }: any) => mockReact.createElement(Text, null, name),
  };
});

jest.mock('../../src/components/ui/pressable', () => {
  const mockReact = require('react');
  const { Pressable } = require('react-native');
  return {
    Pressable: ({ children, ...props }: any) => mockReact.createElement(Pressable, props, children),
  };
});

jest.mock('../../src/components/ui/ScreenShell', () => ({
  ScreenHeaderShell: ({ children }: any) => children,
  ScreenContent: ({ children }: any) => children,
  ScreenStack: ({ children }: any) => children,
  ScreenCard: ({ children }: any) => children,
  ScreenSheet: ({ children }: any) => children,
  HeaderBackButton: ({ children, ...props }: any) => {
    const mockReact = require('react');
    const { Pressable, Text } = require('react-native');
    return mockReact.createElement(Pressable, props, children ?? mockReact.createElement(Text, null, 'back'));
  },
  HeaderActionPlaceholder: () => {
    const mockReact = require('react');
    const { View } = require('react-native');
    return mockReact.createElement(View, null);
  },
  HeaderTitleBlock: ({ title, subtitle }: any) => {
    const mockReact = require('react');
    const { Text, View } = require('react-native');
    return mockReact.createElement(
      View,
      null,
      mockReact.createElement(Text, null, title),
      subtitle ? mockReact.createElement(Text, null, subtitle) : null,
    );
  },
}));

jest.mock('../../src/components/ui/scroll-view', () => {
  const mockReact = require('react');
  const { ScrollView } = require('react-native');
  return {
    ScrollView: ({ children, ...props }: any) => mockReact.createElement(ScrollView, props, children),
  };
});

jest.mock('../../src/components/ui/spinner', () => ({
  Spinner: () => null,
}));

jest.mock('../../src/components/ui/text', () => {
  const mockReact = require('react');
  const { Text } = require('react-native');
  return {
    Text: ({ children, ...props }: any) => mockReact.createElement(Text, props, children),
    composeTextRole: (...classNames: Array<string | undefined>) => classNames.filter(Boolean).join(' '),
  };
});

jest.mock('../../src/services/ModelCatalogService', () => ({
  getHuggingFaceModelUrl: (modelId: string) => `https://huggingface.co/${modelId}`,
  getModelCatalogErrorMessage: jest.fn(() => 'Could not load'),
  modelCatalogService: {
    getCachedModel: jest.fn(() => mockDetailModel),
    getModelDetails: jest.fn().mockResolvedValue(mockDetailModel),
  },
}));

describe('ModelDetailsScreen', () => {
  let openUrlSpy: jest.SpiedFunction<typeof Linking.openURL>;

  beforeEach(() => {
    jest.clearAllMocks();
    openUrlSpy = jest.spyOn(Linking, 'openURL').mockResolvedValueOnce(undefined as never);
  });

  afterEach(() => {
    openUrlSpy.mockRestore();
  });

  it('opens the Hugging Face model page from the details flow', async () => {
    const screen = render(<ModelDetailsScreen />);

    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.press(screen.getByText('models.openOnHuggingFace'));

    expect(Linking.openURL).toHaveBeenCalledWith('https://huggingface.co/org/model');
  });

  it('offers token setup from the details flow for auth-required models', async () => {
    const authRequiredModel: ModelMetadata = {
      ...mockDetailModel,
      accessState: ModelAccessState.AUTH_REQUIRED,
      isGated: true,
    };
    const { modelCatalogService } = jest.requireMock('../../src/services/ModelCatalogService');
    modelCatalogService.getCachedModel.mockReturnValue(authRequiredModel);
    modelCatalogService.getModelDetails.mockResolvedValue(authRequiredModel);

    const screen = render(<ModelDetailsScreen />);

    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.press(screen.getByText('models.setToken'));

    expect(mockRouter.push).toHaveBeenCalledWith('/huggingface-token');
  });

  it('keeps access-denied recovery on Hugging Face instead of showing token setup again', async () => {
    const accessDeniedModel: ModelMetadata = {
      ...mockDetailModel,
      accessState: ModelAccessState.ACCESS_DENIED,
      isGated: true,
    };
    const { modelCatalogService } = jest.requireMock('../../src/services/ModelCatalogService');
    modelCatalogService.getCachedModel.mockReturnValue(accessDeniedModel);
    modelCatalogService.getModelDetails.mockResolvedValue(accessDeniedModel);

    const screen = render(<ModelDetailsScreen />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByText('models.setToken')).toBeNull();

    fireEvent.press(screen.getByText('models.openOnHuggingFace'));

    expect(Linking.openURL).toHaveBeenCalledWith('https://huggingface.co/org/model');
    expect(mockRouter.push).not.toHaveBeenCalledWith('/huggingface-token');
  });

  it('renders enriched metadata fields when the model exposes them', async () => {
    const screen = render(<ModelDetailsScreen />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText('models.metadataLabel')).toBeTruthy();
    expect(screen.getByText('llama')).toBeTruthy();
    expect(screen.getByText('LlamaForCausalLM')).toBeTruthy();
    expect(screen.getByText('meta-llama/Llama-3.1-8B-Instruct')).toBeTruthy();
    expect(screen.getByText('llama3.1')).toBeTruthy();
    expect(screen.getByText('en, de')).toBeTruthy();
    expect(screen.getByText('ultrachat_200k')).toBeTruthy();
    expect(screen.getByText('bartowski')).toBeTruthy();
    expect(screen.getByText('Meta')).toBeTruthy();
  });

  it('hides the metadata section when no metadata fields are available', async () => {
    const metadataFreeModel: ModelMetadata = {
      ...mockDetailModel,
      modelType: undefined,
      architectures: undefined,
      baseModels: undefined,
      license: undefined,
      languages: undefined,
      datasets: undefined,
      quantizedBy: undefined,
      modelCreator: undefined,
    };
    const { modelCatalogService } = jest.requireMock('../../src/services/ModelCatalogService');
    modelCatalogService.getCachedModel.mockReturnValue(metadataFreeModel);
    modelCatalogService.getModelDetails.mockResolvedValue(metadataFreeModel);

    const screen = render(<ModelDetailsScreen />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByText('models.metadataLabel')).toBeNull();
  });
});
