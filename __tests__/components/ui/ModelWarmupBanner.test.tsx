import React from 'react';
import { render } from '@testing-library/react-native';
import { EngineStatus, type EngineState } from '../../../src/types/models';

let mockThemeContext: any;

jest.mock('react-native-css-interop', () => {
  const mockReact = require('react');
  return {
    createInteropElement: mockReact.createElement,
  };
});

jest.mock('../../../src/components/ui/box', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return {
    Box: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
  };
});

jest.mock('../../../src/components/ui/spinner', () => ({
  Spinner: (props: any) => {
    const mockReact = require('react');
    const { Text } = require('react-native');
    return mockReact.createElement(Text, props, 'spinner');
  },
}));

jest.mock('../../../src/components/ui/text', () => {
  const mockReact = require('react');
  const { Text } = require('react-native');
  return {
    Text: ({ children, ...props }: any) => mockReact.createElement(Text, props, children),
  };
});

jest.mock('../../../src/providers/ThemeProvider', () => ({
  useTheme: () => mockThemeContext,
}));

jest.mock('expo-blur', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return {
    BlurTargetView: mockReact.forwardRef(({ children, ...props }: any, ref: any) => mockReact.createElement(View, { ...props, ref }, children)),
    BlurView: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
  };
});

jest.mock('expo-linear-gradient', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return {
    LinearGradient: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
  };
});

let mockSafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => mockSafeAreaInsets,
}));

const {
  MODEL_WARMUP_BANNER_BOTTOM_GAP,
  ModelWarmupBanner,
} = require('../../../src/components/ui/ModelWarmupBanner');
const { ScreenAndroidContentBlurTarget, ScreenRoot } = require('../../../src/components/ui/ScreenShell');

function createEngineState(overrides: Partial<EngineState> = {}): EngineState {
  return {
    status: EngineStatus.INITIALIZING,
    loadProgress: 0.42,
    ...overrides,
  };
}

describe('ModelWarmupBanner', () => {
  beforeEach(() => {
    const { DEFAULT_THEME_ID, getThemeAppearance, getThemeColors } = require('../../../src/utils/themeTokens');
    mockThemeContext = {
      appearance: getThemeAppearance(DEFAULT_THEME_ID, 'light'),
      colors: getThemeColors('light'),
      resolvedMode: 'light',
      themeId: DEFAULT_THEME_ID,
    };
    mockSafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  });

  it('does not render when the engine is not initializing', () => {
    const screen = render(
      <ModelWarmupBanner engineState={createEngineState({ status: EngineStatus.READY })} />,
    );

    expect(screen.toJSON()).toBeNull();
  });

  it('renders percentage progress from fractional load values', () => {
    const screen = render(
      <ModelWarmupBanner engineState={createEngineState({ loadProgress: 0.42 })} />,
    );

    expect(screen.getByTestId('model-warmup-banner-container').props.className).toContain('items-center');
    expect(screen.getByTestId('model-warmup-banner').props.className).toContain('max-w-lg');
    expect(screen.getByText('chat.warmingUp 42%')).toBeTruthy();
    expect(screen.getByTestId('model-warmup-progress-track').props.className).toContain('h-4');
    expect(screen.getByTestId('model-warmup-progress-fill').props.className).toContain('bg-primary-500');
    expect(screen.getByTestId('model-warmup-progress-fill').props.className).not.toContain('bg-warning-500');
    expect(screen.getByTestId('model-warmup-progress-fill').props.style).toEqual({ width: '42%' });
  });

  it('clamps direct percentages and falls back to zero for non-finite progress', () => {
    const directPercent = render(
      <ModelWarmupBanner engineState={createEngineState({ loadProgress: 42 })} />,
    );
    expect(directPercent.getByText('chat.warmingUp 42%')).toBeTruthy();

    const nonFinite = render(
      <ModelWarmupBanner engineState={createEngineState({ loadProgress: Number.POSITIVE_INFINITY })} />,
    );
    expect(nonFinite.getByText('chat.warmingUp 0%')).toBeTruthy();
  });

  it('positions above the native bottom inset or provided tab bar offset', () => {
    const { Platform, StyleSheet } = require('react-native');
    const originalPlatform = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' });
    mockSafeAreaInsets = { top: 0, right: 0, bottom: 18, left: 0 };

    try {
      const nativeInset = render(
        <ModelWarmupBanner engineState={createEngineState()} />,
      );
      expect(StyleSheet.flatten(nativeInset.getByTestId('model-warmup-banner-container').props.style).bottom)
        .toBe(18 + MODEL_WARMUP_BANNER_BOTTOM_GAP);

      const tabOffset = render(
        <ModelWarmupBanner engineState={createEngineState()} bottomOffset={74} />,
      );
      expect(StyleSheet.flatten(tabOffset.getByTestId('model-warmup-banner-container').props.style).bottom)
        .toBe(74 + MODEL_WARMUP_BANNER_BOTTOM_GAP);
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, get: () => originalPlatform });
    }
  });

  it('forces native Android glass blur over the loading overlay', () => {
    const { Platform } = require('react-native');
    const { getThemeAppearance, getThemeColors } = require('../../../src/utils/themeTokens');
    const originalPlatform = Platform.OS;
    const originalVersion = Platform.Version;
    const appearance = getThemeAppearance('glass', 'light');
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' });
    Object.defineProperty(Platform, 'Version', { configurable: true, get: () => 34 });
    mockThemeContext = {
      appearance,
      colors: getThemeColors('light', 'glass'),
      resolvedMode: 'light',
      themeId: 'glass',
    };
    const contentBlurTargetRef = React.createRef<any>();

    try {
      const { UNSAFE_getAllByType, getByTestId } = render(
        <ScreenRoot>
          <ScreenAndroidContentBlurTarget
            blurTargetRef={contentBlurTargetRef}
            testID="warmup-content-blur-target"
            style={{ flex: 1 }}
          >
            <ModelWarmupBanner engineState={createEngineState({ status: EngineStatus.READY })} />
          </ScreenAndroidContentBlurTarget>
          <ModelWarmupBanner
            androidContentBlurTargetRef={contentBlurTargetRef}
            engineState={createEngineState({ loadProgress: 0.42 })}
          />
        </ScreenRoot>,
      );

      expect(() => getByTestId('warmup-content-blur-target').findByProps({ testID: 'model-warmup-banner' })).toThrow();

      const { View } = require('react-native');
      const nativeBlurLayers = UNSAFE_getAllByType(View).filter((node: any) => (
        node.props.intensity === appearance.effects.surfaceBlurIntensity
        && node.props.blurMethod === 'dimezisBlurViewSdk31Plus'
        && node.props.blurTarget === contentBlurTargetRef
      ));

      expect(nativeBlurLayers.length).toBeGreaterThanOrEqual(1);
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, get: () => originalPlatform });
      Object.defineProperty(Platform, 'Version', { configurable: true, get: () => originalVersion });
    }
  });

  it('does not force Android native blur without an explicit content target', () => {
    const { Platform } = require('react-native');
    const { getThemeAppearance, getThemeColors } = require('../../../src/utils/themeTokens');
    const originalPlatform = Platform.OS;
    const originalVersion = Platform.Version;
    const appearance = getThemeAppearance('glass', 'light');
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' });
    Object.defineProperty(Platform, 'Version', { configurable: true, get: () => 34 });
    mockThemeContext = {
      appearance,
      colors: getThemeColors('light', 'glass'),
      resolvedMode: 'light',
      themeId: 'glass',
    };

    try {
      const { UNSAFE_getAllByType } = render(
        <ScreenRoot>
          <ModelWarmupBanner engineState={createEngineState({ loadProgress: 0.42 })} />
        </ScreenRoot>,
      );

      const { View } = require('react-native');
      expect(UNSAFE_getAllByType(View).some((node: any) => (
        node.props.blurMethod === 'dimezisBlurViewSdk31Plus'
      ))).toBe(false);
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, get: () => originalPlatform });
      Object.defineProperty(Platform, 'Version', { configurable: true, get: () => originalVersion });
    }
  });
});
