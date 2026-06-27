import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { FlatList, StyleSheet } from 'react-native';
import { ListPickerSheetContent } from '../../../src/components/ui/ListPickerSheet';
import { screenLayoutMetrics } from '../../../src/utils/themeTokens';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

jest.mock('@/components/ui/box', () => ({
  Box: ({ children, ...props }: any) => {
    const mockReact = require('react');
    const { View } = require('react-native');
    return mockReact.createElement(View, props, children);
  },
}));

jest.mock('@/components/ui/pressable', () => ({
  Pressable: ({ children, ...props }: any) => {
    const mockReact = require('react');
    const { Pressable } = require('react-native');
    return mockReact.createElement(Pressable, props, children);
  },
}));

jest.mock('@/components/ui/text', () => ({
  Text: ({ children, ...props }: any) => {
    const mockReact = require('react');
    const { Text } = require('react-native');
    return mockReact.createElement(Text, props, children);
  },
}));

jest.mock('../../../src/components/ui/MaterialSymbols', () => ({
  MaterialSymbols: ({ name }: any) => {
    const mockReact = require('react');
    const { Text } = require('react-native');
    return mockReact.createElement(Text, null, name);
  },
}));

jest.mock('@/components/ui/ScreenShell', () => ({
  joinClassNames: (...values: Array<string | undefined | false>) => values.filter(Boolean).join(' '),
  ScreenBadge: ({ children, iconName, ...props }: any) => {
    const mockReact = require('react');
    const { Text, View } = require('react-native');
    return mockReact.createElement(
      View,
      props,
      iconName ? mockReact.createElement(Text, null, iconName) : null,
      mockReact.createElement(Text, null, children),
    );
  },
  ScreenCard: ({ children, ...props }: any) => {
    const mockReact = require('react');
    const { View } = require('react-native');
    return mockReact.createElement(View, props, children);
  },
  ScreenIconButton: ({ onPress, accessibilityLabel }: any) => {
    const mockReact = require('react');
    const { Pressable } = require('react-native');
    return mockReact.createElement(Pressable, { onPress, accessibilityLabel });
  },
  ScreenIconTile: ({ iconName, ...props }: any) => {
    const mockReact = require('react');
    const { Text, View } = require('react-native');
    return mockReact.createElement(View, props, mockReact.createElement(Text, null, iconName));
  },
  ScreenModalOverlay: ({ children }: any) => {
    const mockReact = require('react');
    const { View } = require('react-native');
    return mockReact.createElement(View, null, children);
  },
  ScreenPressableCard: ({ children, onPress, ...props }: any) => {
    const mockReact = require('react');
    const { Pressable } = require('react-native');
    return mockReact.createElement(Pressable, { onPress, ...props }, children);
  },
  ScreenSheet: ({ children, ...props }: any) => {
    const mockReact = require('react');
    const { View } = require('react-native');
    return mockReact.createElement(View, props, children);
  },
  useScreenAppearance: () => ({
    classNames: {
      selectedInsetCardClassName: 'selected',
    },
  }),
}));

describe('ListPickerSheetContent', () => {
  it('keeps selected rows pressable with selected accessibility state', () => {
    render(
      <ListPickerSheetContent
        title="Pick one"
        onClose={jest.fn()}
        items={[
          {
            key: 'selected',
            title: 'Selected item',
            selected: true,
            onPress: jest.fn(),
            testID: 'selected-row',
            accessibilityHint: 'Keeps the selected item and closes the picker.',
          },
        ]}
      />,
    );

    const selectedRow = screen.getByTestId('selected-row');
    expect(selectedRow.props.accessibilityRole).toBe('button');
    expect(selectedRow.props.accessibilityState).toEqual({
      selected: true,
      disabled: false,
    });
    expect(selectedRow.props.accessibilityHint).toBe('Keeps the selected item and closes the picker.');
  });

  it('keeps disabled action rows exposed as disabled buttons', () => {
    const onPress = jest.fn();

    render(
      <ListPickerSheetContent
        title="Pick one"
        onClose={jest.fn()}
        items={[
          {
            key: 'disabled-action',
            title: 'Disabled action',
            description: 'Unavailable right now.',
            disabled: true,
            onPress,
            iconName: 'image',
            testID: 'disabled-action-row',
            accessibilityLabel: 'Disabled action label',
            accessibilityHint: 'Unavailable right now.',
          },
        ]}
      />,
    );

    const disabledRow = screen.getByTestId('disabled-action-row');
    expect(disabledRow.props.accessibilityRole).toBe('button');
    expect(disabledRow.props.accessibilityState).toEqual({
      selected: false,
      disabled: true,
    });
    expect(disabledRow.props.accessibilityHint).toBe('Unavailable right now.');
    expect(screen.getByText('image')).toBeTruthy();
  });

  it('centers single-line row icons with their labels without changing multi-line rows', () => {
    render(
      <ListPickerSheetContent
        title="Add attachment"
        onClose={jest.fn()}
        items={[
          {
            key: 'single-line',
            title: 'Attach image',
            iconName: 'image',
            onPress: jest.fn(),
            testID: 'single-line-row',
          },
          {
            key: 'with-description',
            title: 'Attach audio',
            description: 'Unavailable right now.',
            iconName: 'graphic-eq',
            onPress: jest.fn(),
            testID: 'described-row',
          },
        ]}
      />,
    );

    const singleLineIcon = screen.getByTestId('single-line-row-leading-icon');
    expect(singleLineIcon.props.className).toContain('self-center');
    expect(singleLineIcon.props.className).not.toContain('mt-0.5');
    expect(screen.getByTestId('single-line-row-content').props.className).toContain('items-center');
    expect(screen.getByTestId('single-line-row-body').props.className).toContain('items-center');

    const describedIcon = screen.getByTestId('described-row-leading-icon');
    expect(describedIcon.props.className).toContain('mt-0.5');
    expect(describedIcon.props.className).not.toContain('self-center');
    expect(screen.getByTestId('described-row-content').props.className).toContain('items-start');
    expect(screen.getByTestId('described-row-body').props.className).toContain('items-start');
  });

  it('renders supporting text inside picker rows', () => {
    render(
      <ListPickerSheetContent
        title="Pick one"
        onClose={jest.fn()}
        items={[
          {
            key: 'q4',
            title: 'Q4_K_M - 4.00 GB',
            supportingText: 'models.ramFitYes',
            testID: 'q4-row',
          },
        ]}
      />,
    );

    expect(screen.getByText('models.ramFitYes')).toBeTruthy();
  });

  it('renders row badges with shared badge styling', () => {
    render(
      <ListPickerSheetContent
        title="Pick one"
        onClose={jest.fn()}
        items={[
          {
            key: 'q8',
            title: 'Q8_0 - 8.00 GB',
            badges: [{
              key: 'memory-fit',
              label: 'models.ramLikelyOom',
              tone: 'error',
              iconName: 'warning',
              testID: 'q8-memory-fit-badge',
            }],
            testID: 'q8-row',
          },
        ]}
      />,
    );

    const badge = screen.getByTestId('q8-memory-fit-badge');
    expect(badge.props.tone).toBe('error');
    expect(badge.props.size).toBe('micro');
    expect(screen.getByText('warning')).toBeTruthy();
    expect(screen.getByText('models.ramLikelyOom')).toBeTruthy();
  });

  it('passes the Android blur target through to the frosted glass sheet', () => {
    const androidBlurTargetRef = React.createRef<any>();

    render(
      <ListPickerSheetContent
        testID="picker-sheet"
        title="Pick one"
        onClose={jest.fn()}
        androidContentBlurTargetRef={androidBlurTargetRef}
        items={[
          {
            key: 'q8',
            title: 'Q8_0 - 8.00 GB',
            testID: 'q8-row',
          },
        ]}
      />,
    );

    expect(screen.getByTestId('picker-sheet').props.androidBlurTargetRef).toBe(androidBlurTargetRef);
  });

  it('bounds non-empty lists so long picker contents scroll inside the sheet', () => {
    const items = Array.from({ length: 30 }, (_, index) => ({
      key: `item-${index}`,
      title: `Item ${index}`,
      testID: `item-${index}`,
    }));

    const { UNSAFE_getByType } = render(
      <ListPickerSheetContent
        testID="picker-sheet"
        title="Pick one"
        onClose={jest.fn()}
        items={items}
      />,
    );

    const pickerList = UNSAFE_getByType(FlatList);
    const pickerListContainer = screen.getByTestId('picker-sheet-list-container');

    expect(screen.getByTestId('picker-sheet').props.className).toContain('min-h-0');
    expect(pickerListContainer.props.className).toContain('min-h-0');
    const pickerListContainerStyle = StyleSheet.flatten(pickerListContainer.props.style);
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
    expect(StyleSheet.flatten(pickerList.props.style)).toMatchObject({
      backgroundColor: 'transparent',
      flexGrow: 0,
      minHeight: 0,
      flexShrink: 1,
    });
    expect(StyleSheet.flatten(pickerList.props.contentContainerStyle)).toMatchObject({
      backgroundColor: 'transparent',
      paddingBottom: screenLayoutMetrics.sheetBottomInset,
    });
  });
});
