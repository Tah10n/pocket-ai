import React from 'react';
import { render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

jest.mock('nativewind', () => ({
  cssInterop: (Component: any) => Component,
}));

jest.mock('../../../src/providers/ThemeProvider', () => ({
  useTheme: () => ({
    colors: { background: '#fff', headerBlurTint: 'light' },
    resolvedMode: 'light',
    themeId: 'glass',
  }),
}));

const { InputField } = require('../../../src/components/ui/input');

describe('InputField', () => {
  it('disables the Android default underline by default', () => {
    const { getByTestId } = render(
      <InputField testID="input-field" value="" onChangeText={jest.fn()} />,
    );

    expect(getByTestId('input-field').props.underlineColorAndroid).toBe('transparent');
  });

  it('keeps the native text field transparent inside glass shells', () => {
    const { getByTestId } = render(
      <InputField testID="input-field" value="" onChangeText={jest.fn()} />,
    );
    const input = getByTestId('input-field');

    expect(input.props.className).toContain('bg-transparent');
    expect(input.props.className).toContain('dark:bg-transparent');
    expect(StyleSheet.flatten(input.props.style)).toMatchObject({
      backgroundColor: 'transparent',
    });
  });
});
