import React from 'react';
import { render } from '@testing-library/react-native';
import { ChatHeader } from '../../src/components/ui/ChatHeader';

const mockScreenChip = jest.fn(({ label, ...props }: any) => {
  const mockReact = require('react');
  const { Pressable, Text } = require('react-native');
  return mockReact.createElement(
    Pressable,
    {
      ...props,
      testID: props.testID ?? `screen-chip-${label}`,
    },
    mockReact.createElement(Text, { numberOfLines: 1, className: props.textClassName }, label),
  );
});

jest.mock('react-native-css-interop', () => {
  const mockReact = require('react');
  return {
    createInteropElement: mockReact.createElement,
  };
});

jest.mock('../../src/components/ui/ScreenShell', () => {
  const mockReact = require('react');
  const { Pressable, Text, View } = require('react-native');
  return {
    ScreenHeaderShell: ({ children }: any) => mockReact.createElement(View, null, children),
    ScreenChip: (props: any) => mockScreenChip(props),
    HeaderActionButton: ({ children, ...props }: any) => mockReact.createElement(Pressable, props, children),
    HeaderActionPlaceholder: () => mockReact.createElement(View, null),
    HeaderBackButton: ({ accessibilityLabel, ...props }: any) =>
      mockReact.createElement(Pressable, { accessibilityLabel, ...props }, mockReact.createElement(Text, null, 'back')),
  };
});

jest.mock('../../src/components/ui/MaterialSymbols', () => {
  const mockReact = require('react');
  const { Text } = require('react-native');
  return {
    MaterialSymbols: ({ name }: any) => mockReact.createElement(Text, null, name),
  };
});

jest.mock('@/components/ui/box', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return {
    Box: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
  };
});

jest.mock('@/components/ui/text', () => {
  const mockReact = require('react');
  const { Text } = require('react-native');
  return {
    Text: ({ children, ...props }: any) => mockReact.createElement(Text, props, children),
    composeTextRole: (...classNames: Array<string | undefined>) => classNames.filter(Boolean).join(' '),
  };
});

jest.mock('@/components/ui/pressable', () => {
  const mockReact = require('react');
  const { Pressable } = require('react-native');
  return {
    Pressable: ({ children, ...props }: any) => mockReact.createElement(Pressable, props, children),
  };
});

describe('ChatHeader', () => {
  beforeEach(() => {
    mockScreenChip.mockClear();
  });

  it('truncates the model label to a single line to keep the header compact', () => {
    const modelLabel = 'Qwen3.5-4B-Claude-4.6-Opus-Reasoning-Distilled-v2-GGUF';
    const { getByText } = render(
      <ChatHeader
        title="Hi"
        presetLabel="Helpful Assistant"
        modelLabel={modelLabel}
        onOpenPresetSelector={jest.fn()}
      />,
    );

    expect(getByText(modelLabel).props.numberOfLines).toBe(1);
  });

  it('keeps preset and model pills on one row without stretching them evenly', () => {
    const modelLabel = 'Qwen 3 4B';
    const presetLabel = 'Helpful Assistant';
    const { getByTestId } = render(
      <ChatHeader
        title="Hi"
        presetLabel={presetLabel}
        modelLabel={modelLabel}
        onOpenPresetSelector={jest.fn()}
      />,
    );

    expect(getByTestId('chat-header-pill-row').props.className).not.toContain('flex-wrap');
    expect(getByTestId(`screen-chip-${presetLabel}`).props.className).not.toContain('flex-1');
    expect(getByTestId(`screen-chip-${modelLabel}`).props.className).not.toContain('flex-1');
    expect(getByTestId(`screen-chip-${presetLabel}`).props.textClassName).toBeUndefined();
    expect(getByTestId(`screen-chip-${modelLabel}`).props.textClassName).not.toContain('flex-initial');
    expect(getByTestId(`screen-chip-${modelLabel}`).props.textClassName).not.toContain('flex-1');
  });
});
