import React from 'react';
import { render } from '@testing-library/react-native';
import { StyleSheet, View } from 'react-native';
import {
  ScreenActionPill,
  ScreenCard,
  ScreenInlineInput,
  ScreenSegmentedControl,
  ScreenSheet,
  ScreenTextField,
} from '../../src/components/ui/ScreenShell';
import { createMaterialEnvironment } from '../../src/design-system/materials/environment';
import { resolveTheme } from '../../src/design-system/themes/resolver';
import { bottomTabBarMetrics, createBottomTabBarStyle } from '../../src/utils/tabBarLayout';

const mockResolvedTheme = resolveTheme('default', 'light');
const mockMaterialEnvironment = createMaterialEnvironment('web');

jest.mock('nativewind', () => ({
  cssInterop: (component: unknown) => component,
}));

jest.mock('@/components/ui/box', () => {
  const mockReact = jest.requireActual<typeof import('react')>('react');
  const { View: MockView } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Box: ({ children, ...props }: React.ComponentProps<typeof MockView>) => (
      mockReact.createElement(MockView, props, children)
    ),
  };
});

jest.mock('@/components/ui/pressable', () => {
  const mockReact = jest.requireActual<typeof import('react')>('react');
  const { Pressable: MockPressable } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Pressable: (props: React.ComponentProps<typeof MockPressable>) => (
      mockReact.createElement(MockPressable, props)
    ),
  };
});

jest.mock('@/components/ui/text', () => {
  const mockReact = jest.requireActual<typeof import('react')>('react');
  const { Text: MockText } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Text: ({ children, ...props }: React.ComponentProps<typeof MockText>) => (
      mockReact.createElement(MockText, props, children)
    ),
    composeTextRole: (_role: string, className = '') => className,
  };
});

jest.mock('../../src/components/ui/MaterialSymbols', () => {
  const mockReact = jest.requireActual<typeof import('react')>('react');
  const { Text: MockText } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    MaterialSymbols: ({ name }: { name: string }) => mockReact.createElement(MockText, null, name),
  };
});

jest.mock('../../src/providers/ThemeProvider', () => ({
  useTheme: () => ({
    colors: mockResolvedTheme.colors,
    resolvedMode: mockResolvedTheme.mode,
    resolvedTheme: mockResolvedTheme,
    themeId: mockResolvedTheme.id,
  }),
}));

jest.mock('../../src/design-system/materials/MaterialEnvironmentProvider', () => ({
  useMaterialEnvironment: () => mockMaterialEnvironment,
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useIsFocused: () => true,
}));

jest.mock('expo-blur', () => {
  const mockReact = jest.requireActual<typeof import('react')>('react');
  const { View: MockView } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    BlurTargetView: mockReact.forwardRef<View, React.ComponentProps<typeof MockView>>(
      ({ children, ...props }, ref) => mockReact.createElement(MockView, { ...props, ref }, children),
    ),
    BlurView: ({ children, ...props }: React.ComponentProps<typeof MockView>) => (
      mockReact.createElement(MockView, props, children)
    ),
  };
});

jest.mock('expo-glass-effect', () => {
  const mockReact = jest.requireActual<typeof import('react')>('react');
  const { View: MockView } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    GlassView: ({ children, ...props }: React.ComponentProps<typeof MockView>) => (
      mockReact.createElement(MockView, props, children)
    ),
  };
});

describe('screen host geometry contracts', () => {
  it.each([
    ['sm', 16, 32, 12, 4],
    ['md', 9999, 36, 12, 6],
    ['lg', 9999, 48, 16, 12],
  ] as const)('preserves the %s action pill geometry', (size, borderRadius, minHeight, paddingHorizontal, paddingVertical) => {
    const screen = render(
      <ScreenActionPill testID="pill" size={size}>Label</ScreenActionPill>,
    );

    expect(StyleSheet.flatten(screen.getByTestId('pill').props.style)).toMatchObject({
      borderRadius,
      minHeight,
      paddingHorizontal,
      paddingVertical,
    });
  });

  it.each([
    ['compact', 44, 12, 16],
    ['default', 48, 14, 16],
    ['prominent', 56, 16, 28],
    ['multiline', 160, 0, 28],
    ['prominentMultiline', 320, 0, 28],
  ] as const)('preserves the %s text-field shell geometry', (size, minHeight, paddingHorizontal, borderRadius) => {
    const screen = render(
      <ScreenTextField
        fieldTestID="field-shell"
        testID="field-input"
        size={size}
        placeholder="Value"
      />,
    );

    expect(StyleSheet.flatten(screen.getByTestId('field-shell').props.style)).toMatchObject({
      minHeight,
      paddingHorizontal,
      borderRadius,
    });
  });

  it.each([
    ['search', 12, 16],
    ['composer', 14, 9999],
  ] as const)('keeps the %s inline input exactly 40px high', (variant, paddingHorizontal, borderRadius) => {
    const screen = render(
      <ScreenInlineInput
        containerTestID="inline-shell"
        testID="inline-input"
        variant={variant}
        placeholder="Value"
      />,
    );

    expect(StyleSheet.flatten(screen.getByTestId('inline-shell').props.style)).toMatchObject({
      height: 40,
      paddingHorizontal,
      borderRadius,
    });
    expect(StyleSheet.flatten(screen.getByTestId('inline-shell').props.style).minHeight).toBeUndefined();
  });

  it('keeps segmented geometry while leaving inactive items unpainted', () => {
    const renderControl = (activeKey: string) => (
      <ScreenSegmentedControl
        testID="segments"
        activeKey={activeKey}
        onChange={jest.fn()}
        options={[
          { key: 'inactive', label: 'Inactive', testID: 'inactive' },
          { key: 'active', label: 'Active', testID: 'active' },
        ]}
      />
    );
    const screen = render(renderControl('active'));
    const inactiveHost = screen.getByTestId('inactive');
    const inactiveStyle = StyleSheet.flatten(screen.getByTestId('inactive').props.style);

    expect(StyleSheet.flatten(screen.getByTestId('segments').props.style)).toMatchObject({ padding: 4 });
    expect(inactiveStyle).toMatchObject({ minHeight: 36, paddingHorizontal: 12, paddingVertical: 6 });
    expect(inactiveStyle.backgroundColor).toBeUndefined();
    expect(inactiveStyle.borderWidth).toBeUndefined();
    expect(StyleSheet.flatten(screen.getByTestId('active').props.style)).toMatchObject({
      minHeight: 36,
      borderRadius: 9999,
    });

    screen.rerender(renderControl('inactive'));
    expect(screen.getByTestId('inactive')).toBe(inactiveHost);
  });

  it('preserves card and sheet radii at their final native hosts', () => {
    const screen = render(
      <>
        <ScreenCard testID="card">Card</ScreenCard>
        <ScreenSheet testID="sheet">Sheet</ScreenSheet>
      </>,
    );

    expect(StyleSheet.flatten(screen.getByTestId('card').props.style).borderRadius).toBe(20);
    expect(StyleSheet.flatten(screen.getByTestId('sheet').props.style)).toMatchObject({
      borderTopLeftRadius: 32,
      borderTopRightRadius: 32,
      borderBottomLeftRadius: 0,
      borderBottomRightRadius: 0,
    });
  });

  it('locks the bottom tab bar metrics used by the navigation host', () => {
    expect(bottomTabBarMetrics).toMatchObject({
      height: 74,
      floatingHeight: 76,
      floatingHorizontalInset: 14,
      floatingBottomGap: 10,
      floatingRadius: 34,
    });
    expect(createBottomTabBarStyle(mockResolvedTheme.colors, 0, 'android', 'floating')).toMatchObject({
      height: 76,
      left: 14,
      right: 14,
      bottom: 10,
      borderRadius: 34,
      paddingTop: 6,
      paddingBottom: 10,
    });
  });
});
