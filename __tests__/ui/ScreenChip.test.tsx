import React from 'react';
import { render } from '@testing-library/react-native';
import { ScreenChip } from '../../src/components/ui/ScreenShell';

jest.mock('../../src/components/ui/MaterialSymbols', () => {
  const mockReact = require('react');
  const { Text } = require('react-native');
  return {
    MaterialSymbols: ({ name }: any) => mockReact.createElement(Text, null, name),
  };
});

describe('ScreenChip', () => {
  it('keeps the label content-sized instead of forcing it to fill the row', () => {
    const label = 'Helpful Assistant';
    const { getByTestId, getByText } = render(
      <ScreenChip
        testID="screen-chip"
        label={label}
        onPress={jest.fn()}
      />,
    );

    expect(getByTestId('screen-chip').props.className).not.toContain('flex-1');
    expect(getByText(label).props.className).toContain('shrink');
    expect(getByText(label).props.className).not.toContain('flex-1');
  });
});
