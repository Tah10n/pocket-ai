import React from 'react';
import { render } from '@testing-library/react-native';
import { EngineStatus, type EngineState } from '../../../src/types/models';

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

let mockSafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => mockSafeAreaInsets,
}));

const {
  MODEL_WARMUP_BANNER_BOTTOM_GAP,
  ModelWarmupBanner,
} = require('../../../src/components/ui/ModelWarmupBanner');

function createEngineState(overrides: Partial<EngineState> = {}): EngineState {
  return {
    status: EngineStatus.INITIALIZING,
    loadProgress: 0.42,
    ...overrides,
  };
}

describe('ModelWarmupBanner', () => {
  beforeEach(() => {
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

    expect(screen.getByText('chat.warmingUp 42%')).toBeTruthy();
    expect(screen.getByTestId('model-warmup-progress-track').props.className).toContain('h-4');
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
      expect(StyleSheet.flatten(nativeInset.toJSON()?.props.style).bottom)
        .toBe(18 + MODEL_WARMUP_BANNER_BOTTOM_GAP);

      const tabOffset = render(
        <ModelWarmupBanner engineState={createEngineState()} bottomOffset={74} />,
      );
      expect(StyleSheet.flatten(tabOffset.toJSON()?.props.style).bottom)
        .toBe(74 + MODEL_WARMUP_BANNER_BOTTOM_GAP);
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, get: () => originalPlatform });
    }
  });
});
