import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';
import { HuggingFaceTokenScreen } from '../../src/ui/screens/HuggingFaceTokenScreen';
import { HUGGING_FACE_TOKEN_SETTINGS_URL } from '../../src/services/ModelCatalogService';

const mockRouter = {
  back: jest.fn(),
  canGoBack: jest.fn(() => true),
  replace: jest.fn(),
};

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
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

jest.mock('../../src/components/ui/input', () => {
  const mockReact = require('react');
  const { TextInput, View } = require('react-native');
  return {
    Input: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
    InputField: ({ ...props }: any) => mockReact.createElement(TextInput, props),
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
  joinClassNames: (...values: Array<string | undefined | false>) => values.filter(Boolean).join(' '),
  ScreenHeaderShell: ({ children }: any) => children,
  ScreenContent: ({ children }: any) => children,
  ScreenStack: ({ children }: any) => children,
  ScreenCard: ({ children }: any) => children,
  ScreenSheet: ({ children }: any) => children,
  ScreenTextField: ({ label, helperText, ...props }: any) => {
    const mockReact = require('react');
    const { TextInput, Text, View } = require('react-native');
    return mockReact.createElement(
      View,
      null,
      label ? mockReact.createElement(Text, null, label) : null,
      mockReact.createElement(TextInput, props),
      helperText ? mockReact.createElement(Text, null, helperText) : null,
    );
  },
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

jest.mock('../../src/components/ui/text', () => {
  const mockReact = require('react');
  const { Text } = require('react-native');
  return {
    Text: ({ children, ...props }: any) => mockReact.createElement(Text, props, children),
    composeTextRole: (...classNames: Array<string | undefined>) => classNames.filter(Boolean).join(' '),
  };
});

jest.mock('../../src/services/HuggingFaceTokenService', () => ({
  huggingFaceTokenService: {
    getCachedState: jest.fn(() => ({ hasToken: false, updatedAt: 0 })),
    subscribe: jest.fn(() => jest.fn()),
    refreshState: jest.fn().mockResolvedValue({ hasToken: false, updatedAt: 0 }),
    saveToken: jest.fn(),
    clearToken: jest.fn(),
  },
}));

jest.mock('../../src/services/ModelCatalogService', () => ({
  HUGGING_FACE_TOKEN_SETTINGS_URL: 'https://huggingface.co/settings/tokens',
}));

describe('HuggingFaceTokenScreen', () => {
  let openUrlSpy: jest.SpiedFunction<typeof Linking.openURL>;

  beforeEach(() => {
    jest.clearAllMocks();
    openUrlSpy = jest.spyOn(Linking, 'openURL').mockResolvedValueOnce(undefined as never);
  });

  afterEach(() => {
    openUrlSpy.mockRestore();
  });

  it('opens the Hugging Face token settings page from the helper CTA', async () => {
    const screen = render(<HuggingFaceTokenScreen />);

    expect(screen.getByText('settings.huggingFaceTokenEducationTitle')).toBeTruthy();

    fireEvent.press(screen.getByText('settings.huggingFaceTokenGetToken'));

    await waitFor(() => {
      expect(Linking.openURL).toHaveBeenCalledWith(HUGGING_FACE_TOKEN_SETTINGS_URL);
    });
  });
});
