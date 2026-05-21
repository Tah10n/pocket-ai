import React from 'react';
import { render, within } from '@testing-library/react-native';
import { FlatList, StyleSheet } from 'react-native';

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

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

const { ListPickerSheetContent } = require('../../src/components/ui/ListPickerSheet');
const { StaticThemeProvider } = require('../../src/providers/ThemeProvider');
const { screenLayoutMetrics, screenLayoutTokens } = require('../../src/utils/themeTokens');

describe('ListPickerSheet', () => {
  it('uses the default sheet height like model controls', () => {
    const { getByTestId } = render(
      React.createElement(ListPickerSheetContent, {
        testID: 'picker-sheet',
        title: 'Title',
        onClose: jest.fn(),
        items: [],
      }),
    );

    expect(getByTestId('picker-sheet').props.className).toContain(screenLayoutTokens.sheetMaxHeightDefaultClassName);
    expect(getByTestId('picker-sheet').props.className).not.toContain(screenLayoutTokens.sheetMaxHeightCompactClassName);
  });

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

  it('keeps light glass picker lists bounded inside the frosted sheet', () => {
    const { UNSAFE_getByType, getByTestId } = render(
      React.createElement(StaticThemeProvider, { themeId: 'glass', resolvedMode: 'light' },
        React.createElement(ListPickerSheetContent, {
          testID: 'picker-sheet',
          title: 'Choose GGUF file',
          onClose: jest.fn(),
          items: Array.from({ length: 24 }, (_, index) => ({
            key: `q${index}`,
            title: `Q${index}_K_M - 3.80 GB`,
            testID: `variant-${index}`,
          })),
        }),
      ),
    );

    const sheetClassName = getByTestId('picker-sheet').props.className;
    const pickerListContainerStyle = StyleSheet.flatten(getByTestId('picker-sheet-list-container').props.style);
    const pickerList = UNSAFE_getByType(FlatList);
    const pickerListStyle = StyleSheet.flatten(pickerList.props.style);
    const pickerListContentStyle = StyleSheet.flatten(pickerList.props.contentContainerStyle);

    expect(sheetClassName).toContain('relative overflow-hidden');
    expect(sheetClassName).toContain('bg-background-0/15');
    expect(pickerListContainerStyle).toMatchObject({
      alignSelf: 'stretch',
      backgroundColor: 'transparent',
      minHeight: 0,
      flexShrink: 1,
    });
    expect(pickerListContainerStyle.maxHeight).toBeGreaterThanOrEqual(240);
    expect(pickerList.props.bounces).toBe(false);
    expect(pickerList.props.endFillColor).toBe('transparent');
    expect(pickerList.props.overScrollMode).toBe('never');
    expect(pickerListStyle).toMatchObject({
      backgroundColor: 'transparent',
      flexGrow: 0,
      flexShrink: 1,
      minHeight: 0,
    });
    expect(pickerListContentStyle).toMatchObject({
      backgroundColor: 'transparent',
      paddingBottom: screenLayoutMetrics.sheetBottomInset,
    });
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
