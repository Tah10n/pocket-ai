import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

jest.mock('react-native-css-interop', () => {
  const mockReact = require('react');

  return {
    createInteropElement: mockReact.createElement,
  };
});

jest.mock('@/components/ui/box', () => {
  const mockReact = require('react');
  const { View } = require('react-native');

  return {
    Box: ({ children }: any) => mockReact.createElement(View, null, children),
  };
});

jest.mock('@/components/ui/pressable', () => {
  const mockReact = require('react');
  const { Pressable } = require('react-native');

  return {
    Pressable: ({ children, ...props }: any) => mockReact.createElement(Pressable, props, children),
  };
});

jest.mock('@/components/ui/scroll-view', () => {
  const mockReact = require('react');
  const { ScrollView } = require('react-native');

  return {
    ScrollView: ({ children, ...props }: any) => mockReact.createElement(ScrollView, props, children),
  };
});

jest.mock('@/components/ui/text', () => {
  const mockReact = require('react');
  const { Text } = require('react-native');

  return {
    Text: ({ children, ...props }: any) => mockReact.createElement(Text, props, children),
    composeTextRole: (_role: string, className = '') => className,
  };
});

jest.mock('../../src/components/ui/MaterialSymbols', () => ({
  MaterialSymbols: () => null,
}));

jest.mock('../../src/services/PresetManager', () => ({
  presetManager: {
    getPresets: jest.fn(() => [
      {
        id: 'preset-1',
        name: 'Helpful Assistant',
        systemPrompt: 'Be concise.',
        isBuiltIn: false,
      },
      {
        id: 'preset-2',
        name: 'Research Analyst',
        systemPrompt: 'Organize findings clearly.',
        isBuiltIn: false,
      },
    ]),
  },
}));

jest.mock('../../src/components/ui/button', () => {
  const mockReact = require('react');
  const { Pressable, Text } = require('react-native');

  return {
    Button: ({ children, onPress, ...props }: any) => mockReact.createElement(Pressable, { onPress, ...props }, children),
    ButtonText: ({ children, ...props }: any) => mockReact.createElement(Text, props, children),
  };
});

const { PresetSelectorSheet } = require('../../src/components/ui/PresetSelectorSheet');
const { presetManager } = require('../../src/services/PresetManager');

describe('PresetSelectorSheet', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders an explicit default option and clears the preset when selected', () => {
    const onClose = jest.fn();
    const onSelectPreset = jest.fn();

    const { getByTestId } = render(
      React.createElement(PresetSelectorSheet, {
        visible: true,
        activePresetId: 'preset-1',
        onClose,
        onSelectPreset,
      }),
    );

    fireEvent.press(getByTestId('preset-option-default'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelectPreset).toHaveBeenCalledWith(null);
  });

  it('selects a custom preset and closes the sheet', () => {
    const onClose = jest.fn();
    const onSelectPreset = jest.fn();

    const { getByTestId } = render(
      React.createElement(PresetSelectorSheet, {
        visible: true,
        activePresetId: null,
        onClose,
        onSelectPreset,
      }),
    );

    fireEvent.press(getByTestId('preset-option-preset-1'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelectPreset).toHaveBeenCalledWith('preset-1');
  });

  it('shows the manage presets action only when provided and closes before opening it', () => {
    const callOrder: string[] = [];
    const onClose = jest.fn(() => {
      callOrder.push('close');
    });
    const onSelectPreset = jest.fn();
    const onManagePresets = jest.fn(() => {
      callOrder.push('manage');
    });

    const withManage = render(
      React.createElement(PresetSelectorSheet, {
        visible: true,
        activePresetId: null,
        onClose,
        onSelectPreset,
        onManagePresets,
      }),
    );

    fireEvent.press(withManage.getByText('chat.presetSelector.manage'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onManagePresets).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['close', 'manage']);

    withManage.unmount();

    const withoutManage = render(
      React.createElement(PresetSelectorSheet, {
        visible: true,
        activePresetId: null,
        onClose,
        onSelectPreset,
      }),
    );

    expect(withoutManage.queryByText('chat.presetSelector.manage')).toBeNull();
  });

  it('does not load presets until the sheet becomes visible', () => {
    const onClose = jest.fn();
    const onSelectPreset = jest.fn();

    render(
      React.createElement(PresetSelectorSheet, {
        visible: false,
        activePresetId: null,
        onClose,
        onSelectPreset,
      }),
    );

    expect(presetManager.getPresets).not.toHaveBeenCalled();
  });
});
