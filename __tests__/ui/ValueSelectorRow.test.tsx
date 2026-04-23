import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { Pressable } from 'react-native';
import { ValueSelectorRow } from '../../src/components/ui/ValueSelectorRow';

jest.mock('../../src/components/ui/box', () => {
  const mockReact = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  return {
    Box: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
  };
});

jest.mock('../../src/components/ui/text', () => {
  const mockReact = jest.requireActual('react');
  const { Text } = jest.requireActual('react-native');
  return {
    Text: ({ children, ...props }: any) => mockReact.createElement(Text, props, children),
    composeTextRole: (_role: string, className = '') => className,
  };
});

jest.mock('../../src/components/ui/pressable', () => {
  const mockReact = jest.requireActual('react');
  const { Pressable } = jest.requireActual('react-native');
  return {
    Pressable: ({ children, ...props }: any) => mockReact.createElement(Pressable, props, children),
  };
});

jest.mock('../../src/components/ui/MaterialSymbols', () => {
  const mockReact = jest.requireActual('react');
  const { Text } = jest.requireActual('react-native');
  return {
    MaterialSymbols: ({ name, ...props }: any) => mockReact.createElement(Text, props, name),
  };
});

describe('ValueSelectorRow', () => {
  it('renders a non-interactive selector row without a chevron by default', () => {
    const onPress = jest.fn();
    const screen = render(
      <ValueSelectorRow
        label="models.quantizationLabel"
        value="Q4_K_M + 3.80 GB"
        testID="value-selector-row"
      />,
    );

    expect(screen.getByText('models.quantizationLabel')).toBeTruthy();
    expect(screen.getByText('Q4_K_M + 3.80 GB')).toBeTruthy();
    fireEvent.press(screen.getByTestId('value-selector-row'));
    expect(onPress).not.toHaveBeenCalled();
    expect(screen.queryByText('chevron-right')).toBeNull();
  });

  it('shows a chevron and handles presses when configured as interactive', () => {
    const onPress = jest.fn();
    const screen = render(
      <ValueSelectorRow
        label="models.quantizationLabel"
        value="Q4_K_M + 3.80 GB"
        onPress={onPress}
        showChevron
        testID="value-selector-row"
      />,
    );

    expect(screen.getByText('chevron-right')).toBeTruthy();
    fireEvent.press(screen.getByTestId('value-selector-row'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('renders disabled rows with muted opacity and no press handling', () => {
    const onPress = jest.fn();
    const screen = render(
      <ValueSelectorRow
        label="models.quantizationLabel"
        value="Q4_K_M + 3.80 GB"
        onPress={onPress}
        disabled
        testID="value-selector-row"
      />,
    );

    const row = screen.getByTestId('value-selector-row');
    expect(row.props.className).toContain('opacity-60');
    expect(row.props.onPress).toBeUndefined();
    expect(row.props.accessibilityRole).toBeUndefined();
    expect(() => screen.UNSAFE_getByType(Pressable)).toThrow();
    expect(onPress).not.toHaveBeenCalled();
  });
});
