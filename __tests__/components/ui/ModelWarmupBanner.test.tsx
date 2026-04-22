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

const { ModelWarmupBanner } = require('../../../src/components/ui/ModelWarmupBanner');

function createEngineState(overrides: Partial<EngineState> = {}): EngineState {
  return {
    status: EngineStatus.INITIALIZING,
    loadProgress: 0.42,
    ...overrides,
  };
}

describe('ModelWarmupBanner', () => {
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
});
