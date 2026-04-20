import React from 'react';
import { render, within } from '@testing-library/react-native';

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
    Box: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
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

const { ListPickerSheetContent } = require('../../src/components/ui/ListPickerSheet');

describe('ListPickerSheet', () => {
  it('applies the shared active-row treatment', () => {
    const { getByTestId } = render(
      React.createElement(ListPickerSheetContent, {
        title: 'Title',
        subtitle: 'Subtitle',
        onClose: jest.fn(),
        items: [
          {
            key: 'selected',
            title: 'Selected row',
            description: 'Selected description',
            selected: true,
            testID: 'selected-row',
          },
          {
            key: 'idle',
            title: 'Idle row',
            description: 'Idle description',
            testID: 'idle-row',
          },
        ],
      }),
    );

    expect(getByTestId('selected-row').props.className).toContain('border-primary-500/30 bg-primary-500/10');
    expect(within(getByTestId('selected-row')).getByText('common.active')).toBeTruthy();
    expect(getByTestId('idle-row').props.className).not.toContain('border-primary-500/30 bg-primary-500/10');
  });

  it('renders the shared centered empty state structure', () => {
    const { getByTestId, getByText } = render(
      React.createElement(ListPickerSheetContent, {
        title: 'Title',
        onClose: jest.fn(),
        items: [],
        emptyState: {
          title: 'Nothing here yet',
          description: 'Add an item to see it in this list.',
          testID: 'empty-state',
        },
      }),
    );

    expect(getByTestId('empty-state').props.className).toContain('items-center justify-center');
    expect(getByText('Nothing here yet')).toBeTruthy();
    expect(getByText('Add an item to see it in this list.')).toBeTruthy();
  });

  it('does not show a chevron for read-only rows without an onPress handler', () => {
    const { getByTestId, queryByText } = render(
      React.createElement(ListPickerSheetContent, {
        title: 'Title',
        onClose: jest.fn(),
        items: [
          {
            key: 'readonly',
            title: 'Read only row',
            description: 'Static value',
            testID: 'readonly-row',
          },
        ],
      }),
    );

    expect(getByTestId('readonly-row')).toBeTruthy();
    expect(queryByText('chevron-right')).toBeNull();
  });
});
