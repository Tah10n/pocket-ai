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

const { PresetSelectorSheet } = require('../../src/components/ui/PresetSelectorSheet');

describe('PresetSelectorSheet', () => {
  it('renders an explicit default option and clears the preset when selected', () => {
    const onClose = jest.fn();
    const onSelectPreset = jest.fn();

    const { getByText } = render(
      React.createElement(PresetSelectorSheet, {
        visible: true,
        activePresetId: 'preset-1',
        onClose,
        onSelectPreset,
      }),
    );

    fireEvent.press(getByText('common.default'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelectPreset).toHaveBeenCalledWith(null);
  });
});
