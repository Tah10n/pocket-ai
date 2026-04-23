import React from 'react';
import { render } from '@testing-library/react-native';
import { ChatHeader } from '../../src/components/ui/ChatHeader';

const reactI18nextMock = jest.requireMock('react-i18next') as {
  __setTranslationOverride: (key: string, value: string, nextLanguage?: string) => void;
  __resetTranslations: () => void;
};

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

const mockHeaderActionButton = jest.fn(({ children, ...props }: any) => {
  const mockReact = require('react');
  const { Pressable } = require('react-native');
  return mockReact.createElement(Pressable, props, children);
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
    joinClassNames: (...values: Array<string | undefined | false>) => values.filter(Boolean).join(' '),
    ScreenHeaderShell: ({ children }: any) => mockReact.createElement(View, null, children),
    ScreenChip: (props: any) => mockScreenChip(props),
    HeaderActionButton: (props: any) => mockHeaderActionButton(props),
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
    mockHeaderActionButton.mockClear();
    reactI18nextMock.__resetTranslations();
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

  it('supports a selectable preview state for the model chip without forcing a tap handler', () => {
    const modelLabel = 'Qwen 3 4B';
    const { getByTestId } = render(
      <ChatHeader
        title="Hi"
        modelLabel={modelLabel}
        modelSelectable
      />,
    );

    expect(getByTestId(`screen-chip-${modelLabel}`).props.trailingIconName).toBe('keyboard-arrow-down');
    expect(getByTestId(`screen-chip-${modelLabel}`).props.onPress).toBeUndefined();
  });

  it('renders the unavailable model chip with warning presentation', () => {
    const modelLabel = 'chat.modelUnavailable';
    const { getByTestId } = render(
      <ChatHeader
        title="Hi"
        modelLabel={modelLabel}
      />,
    );

    expect(getByTestId(`screen-chip-${modelLabel}`).props.tone).toBe('warning');
    expect(getByTestId(`screen-chip-${modelLabel}`).props.leadingIconName).toBe('warning');
    expect(getByTestId(`screen-chip-${modelLabel}`).props.textClassName).toContain('text-warning-700');
  });

  it.each([
    ['neutral', 'text-typography-500'],
    ['accent', 'text-primary-600'],
    ['warning', 'text-warning-700'],
  ] as const)('renders %s status styling', (tone, expectedClassName) => {
    const { getByText } = render(
      <ChatHeader
        title="Hi"
        statusLabel="Ready"
        statusTone={tone}
      />,
    );

    expect(getByText('Ready').props.className).toContain(expectedClassName);
  });

  it('shows status without pill row when only a status is provided', () => {
    const { getByText, queryByTestId } = render(
      <ChatHeader
        title="Hi"
        statusLabel="Ready"
      />,
    );

    expect(getByText('Ready')).toBeTruthy();
    expect(queryByTestId('chat-header-pill-row')).toBeNull();
  });

  it('omits the pills and status section entirely when nothing supplemental is provided', () => {
    const { queryByTestId, queryByText } = render(
      <ChatHeader title="Hi" />,
    );

    expect(queryByTestId('chat-header-pill-row')).toBeNull();
    expect(queryByText('Ready')).toBeNull();
  });

  it('renders only the preset pill when no model label is provided', () => {
    const { getByTestId, queryByTestId } = render(
      <ChatHeader
        title="Hi"
        presetLabel="Helpful Assistant"
        onOpenPresetSelector={jest.fn()}
      />,
    );

    expect(getByTestId('screen-chip-Helpful Assistant')).toBeTruthy();
    expect(queryByTestId('screen-chip-Qwen 3 4B')).toBeNull();
  });

  it('renders the model controls action only when a handler is provided', () => {
    const { rerender } = render(
      <ChatHeader
        title="Hi"
        onOpenModelControls={jest.fn()}
      />,
    );

    expect(mockHeaderActionButton.mock.calls.some(
      ([props]) => props.accessibilityLabel === 'chat.headerModelControlsAccessibilityLabel',
    )).toBe(true);

    mockHeaderActionButton.mockClear();

    rerender(
      <ChatHeader title="Hi" />,
    );

    expect(mockHeaderActionButton.mock.calls.some(
      ([props]) => props.accessibilityLabel === 'chat.headerModelControlsAccessibilityLabel',
    )).toBe(false);
  });

  it('applies disabled states to the available header actions', () => {
    render(
      <ChatHeader
        title="Hi"
        presetLabel="Helpful Assistant"
        modelLabel="Qwen 3 4B"
        onStartNewChat={jest.fn()}
        canStartNewChat={false}
        onOpenPresetSelector={jest.fn()}
        canOpenPresetSelector={false}
        onOpenModelSelector={jest.fn()}
        canOpenModelSelector={false}
        onOpenModelControls={jest.fn()}
        canOpenModelControls={false}
      />,
    );

    const newChatButtonProps = mockHeaderActionButton.mock.calls.find(
      ([props]) => props.accessibilityLabel === 'chat.headerNewChatAccessibilityLabel',
    )?.[0];
    const modelControlsButtonProps = mockHeaderActionButton.mock.calls.find(
      ([props]) => props.accessibilityLabel === 'chat.headerModelControlsAccessibilityLabel',
    )?.[0];
    const presetChipProps = mockScreenChip.mock.calls.find(
      ([props]) => props.label === 'Helpful Assistant',
    )?.[0];
    const modelChipProps = mockScreenChip.mock.calls.find(
      ([props]) => props.label === 'Qwen 3 4B',
    )?.[0];

    expect(newChatButtonProps?.disabled).toBe(true);
    expect(modelControlsButtonProps?.disabled).toBe(true);
    expect(presetChipProps?.disabled).toBe(true);
    expect(modelChipProps?.disabled).toBe(true);
  });

  it('hides the new chat action when no handler is provided', () => {
    render(
      <ChatHeader title="Hi" />,
    );

    expect(mockHeaderActionButton.mock.calls.some(
      ([props]) => props.accessibilityLabel === 'chat.headerNewChatAccessibilityLabel',
    )).toBe(false);
  });
});
