import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { StyleSheet, Text, View } from 'react-native';
import { resolveTheme } from '../../src/design-system/themes/resolver';
import { createMaterialEnvironment } from '../../src/design-system/materials/environment';
import {
  HeaderActionButton,
  ScreenAndroidContentBlurTarget,
  ScreenCard,
  ScreenContent,
  ScreenHeaderShell,
  ScreenIconButton,
  ScreenModalOverlay,
  ScreenRoot,
  ScreenSegmentedControl,
  ScreenSheet,
  ScreenSurface,
} from '../../src/components/ui/ScreenShell';

let mockSafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };
let mockThemeContext: any;
let mockEnvironment = createMaterialEnvironment('web');
const mockMaterialSymbols = jest.fn(({ name, ...props }: any) => (
  <Text {...props}>{name}</Text>
));

jest.mock('react-native-css-interop', () => ({
  createInteropElement: jest.requireActual<typeof import('react')>('react').createElement,
}));

jest.mock('@/components/ui/box', () => {
  const mockReact = jest.requireActual<typeof import('react')>('react');
  const { View: MockView } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Box: ({ children, ...props }: any) => mockReact.createElement(MockView, props, children),
  };
});

jest.mock('@/components/ui/input', () => {
  const mockReact = jest.requireActual<typeof import('react')>('react');
  const { View: MockView } = jest.requireActual<typeof import('react-native')>('react-native');
  const { TextInput } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Input: ({ children, ...props }: any) => mockReact.createElement(MockView, props, children),
    InputField: (props: any) => mockReact.createElement(TextInput, props),
  };
});

jest.mock('@/components/ui/pressable', () => {
  const mockReact = jest.requireActual<typeof import('react')>('react');
  const { Pressable: MockPressable } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Pressable: ({ children, ...props }: any) => mockReact.createElement(MockPressable, props, children),
  };
});

jest.mock('@/components/ui/text', () => {
  const mockReact = jest.requireActual<typeof import('react')>('react');
  const { Text: MockText } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Text: ({ children, ...props }: any) => mockReact.createElement(MockText, props, children),
    composeTextRole: (_role: string, className = '') => className,
  };
});

jest.mock('../../src/components/ui/MaterialSymbols', () => ({
  MaterialSymbols: (props: any) => mockMaterialSymbols(props),
}));

jest.mock('../../src/design-system/materials/Surface', () => {
  const mockReact = jest.requireActual<typeof import('react')>('react');
  const { Pressable: MockPressable, View: MockView } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Surface: ({ children, material, shape, ...props }: any) => (
      mockReact.createElement(MockView, { ...props, material, shape }, children)
    ),
    PressableSurface: ({ children, material, shape, ...props }: any) => (
      mockReact.createElement(MockPressable, { ...props, material, shape }, children)
    ),
  };
});

jest.mock('../../src/design-system/materials/EffectSurface', () => {
  const mockReact = jest.requireActual<typeof import('react')>('react');
  const { Pressable: MockPressable, View: MockView } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    EffectSurface: ({ children, material, shape, ...props }: any) => (
      mockReact.createElement(MockView, { ...props, material, shape }, children)
    ),
    EffectPressableSurface: ({ children, material, shape, ...props }: any) => (
      mockReact.createElement(MockPressable, { ...props, material, shape }, children)
    ),
  };
});

jest.mock('../../src/design-system/materials/ScreenBackgroundDecoration', () => {
  const mockReact = jest.requireActual<typeof import('react')>('react');
  const { View: MockView } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    ScreenBackgroundDecoration: (props: any) => mockReact.createElement(MockView, {
      testID: props.dim ? 'screen-decoration-dim' : 'screen-decoration',
      ...props,
    }),
  };
});

jest.mock('../../src/design-system/materials/MaterialEnvironmentProvider', () => ({
  useMaterialEnvironment: () => mockEnvironment,
}));

jest.mock('../../src/providers/ThemeProvider', () => ({
  useTheme: () => mockThemeContext,
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => mockSafeAreaInsets,
}));

jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useIsFocused: () => true,
}));

jest.mock('expo-blur', () => {
  const mockReact = jest.requireActual<typeof import('react')>('react');
  const { View: MockView } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    BlurTargetView: mockReact.forwardRef(({ children, ...props }: any, ref: any) => (
      <MockView ref={ref} {...props}>{children}</MockView>
    )),
  };
});

describe('ScreenShell semantic material contracts', () => {
  beforeEach(() => {
    const resolvedTheme = resolveTheme('default', 'light');
    mockSafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };
    mockEnvironment = createMaterialEnvironment('web');
    mockThemeContext = {
      colors: resolvedTheme.colors,
      resolvedMode: 'light',
      resolvedTheme,
      themeId: 'default',
    };
    mockMaterialSymbols.mockClear();
  });

  it('keeps the default root plain and applies its resolved canvas color', () => {
    const screen = render(<ScreenRoot testID="root">content</ScreenRoot>);

    expect(screen.getByTestId('root').props.className).toContain('flex-1');
    expect(StyleSheet.flatten(screen.getByTestId('root').props.style)).toMatchObject({
      backgroundColor: mockThemeContext.colors.background,
    });
    expect(screen.queryByTestId('screen-decoration')).toBeNull();
    expect(screen.queryByTestId('screen-material-scene-blur-target')).toBeNull();
  });

  it('owns aurora decoration and Android sample targets at the screen boundary', () => {
    const resolvedTheme = resolveTheme('glass', 'light');
    mockThemeContext = { colors: resolvedTheme.colors, resolvedMode: 'light', resolvedTheme, themeId: 'glass' };
    mockEnvironment = createMaterialEnvironment('android', {
      androidSdkVersion: 34,
      androidTargetBlurSupported: true,
      blurViewAvailable: true,
      transparencyState: 'allowed',
    });

    const screen = render(<ScreenRoot testID="root"><Text>scene</Text></ScreenRoot>);

    expect(screen.getByTestId('screen-decoration')).toBeTruthy();
    expect(screen.getByTestId('screen-decoration-dim')).toBeTruthy();
    expect(screen.getByTestId('screen-material-blur-target')).toBeTruthy();
    expect(screen.getByTestId('screen-material-scene-blur-target').findByProps({ children: 'scene' })).toBeTruthy();
  });

  it('records the complete Android Liquid Glass scene from the ScreenRoot boundary', () => {
    const resolvedTheme = resolveTheme('glass', 'light');
    mockThemeContext = { colors: resolvedTheme.colors, resolvedMode: 'light', resolvedTheme, themeId: 'glass' };
    mockEnvironment = createMaterialEnvironment('android', {
      androidSdkVersion: 34,
      androidLiquidGlassAvailable: true,
      androidTargetBlurSupported: true,
      blurViewAvailable: true,
      transparencyState: 'allowed',
    });

    const screen = render(<ScreenRoot testID="root"><Text>recorded scene content</Text></ScreenRoot>);

    const provider = screen.getByTestId('screen-material-liquid-glass-scene');
    expect(provider.props.active).toBe(true);
    expect(provider.findByProps({ children: 'recorded scene content' })).toBeTruthy();
    expect(provider.findByProps({ testID: 'screen-decoration' })).toBeTruthy();
    expect(provider.findByProps({ testID: 'screen-decoration-dim' })).toBeTruthy();
    expect(screen.queryByTestId('screen-material-blur-target')).toBeNull();
    expect(screen.queryByTestId('screen-material-scene-blur-target')).toBeNull();
  });

  it('maps content cards to dense raised or inset material variants', () => {
    const screen = render(
      <>
        <ScreenCard testID="raised" tone="warning">raised</ScreenCard>
        <ScreenCard testID="inset" variant="inset">inset</ScreenCard>
      </>,
    );

    expect(screen.getByTestId('raised').props).toMatchObject({
      material: { role: 'content', variant: 'raised', tone: 'warning' },
      shape: 'lg',
    });
    expect(screen.getByTestId('inset').props).toMatchObject({
      material: { role: 'content', variant: 'inset', tone: 'neutral' },
      shape: 'md',
    });
  });

  it('maps header, sheet, and modal boundaries to semantic chrome and overlay recipes', () => {
    mockSafeAreaInsets = { top: 24, right: 0, bottom: 18, left: 0 };
    const screen = render(
      <>
        <ScreenHeaderShell testID="header">header</ScreenHeaderShell>
        <ScreenSheet testID="sheet">sheet</ScreenSheet>
        <ScreenModalOverlay testID="overlay">overlay</ScreenModalOverlay>
      </>,
    );

    const headerMaterial = screen.UNSAFE_getAllByType(View).find(
      (node: any) => node.props.material?.variant === 'header',
    );
    expect(headerMaterial?.props).toMatchObject({
      material: { role: 'chrome', variant: 'header' },
      shape: 'none',
    });
    expect(screen.getByTestId('sheet').props).toMatchObject({
      material: { role: 'chrome', variant: 'sheet' },
      shape: 'sheet',
    });
    expect(screen.getByTestId('overlay').props).toMatchObject({
      material: { role: 'overlay', variant: 'scrim' },
      shape: 'none',
    });
    expect(StyleSheet.flatten(screen.getByTestId('sheet').children[0].props.style)).toMatchObject({
      paddingBottom: expect.any(Number),
    });
  });

  it('applies safe-area and caller bottom insets without coupling them to a theme', () => {
    mockSafeAreaInsets = { top: 0, right: 0, bottom: 18, left: 0 };
    const screen = render(
      <ScreenContent testID="content" includeBottomSafeArea extraBottomInset={12}>content</ScreenContent>,
    );

    expect(StyleSheet.flatten(screen.getByTestId('content').props.style).paddingBottom).toBeGreaterThan(30);
  });

  it('publishes a measured floating header inset to content inside the screen root', () => {
    const resolvedTheme = resolveTheme('glass', 'light');
    mockThemeContext = { colors: resolvedTheme.colors, resolvedMode: 'light', resolvedTheme, themeId: 'glass' };
    const screen = render(
      <ScreenRoot>
        <ScreenHeaderShell testID="header">header</ScreenHeaderShell>
        <ScreenContent testID="content">content</ScreenContent>
      </ScreenRoot>,
    );
    let layoutNode: any = screen.getByTestId('header');

    while (layoutNode && typeof layoutNode.props.onLayout !== 'function') {
      layoutNode = layoutNode.parent;
    }

    expect(layoutNode).toBeTruthy();
    fireEvent(layoutNode, 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 124 } },
    });

    expect(StyleSheet.flatten(screen.getByTestId('content').props.style)).toMatchObject({
      paddingTop: 124,
    });
  });

  it('exposes selected state and semantic foregrounds for segmented controls', () => {
    const onChange = jest.fn();
    const screen = render(
      <ScreenSegmentedControl
        testID="segments"
        activeKey="second"
        onChange={onChange}
        options={[
          { key: 'first', label: 'First', testID: 'first' },
          { key: 'second', label: 'Second', testID: 'second' },
        ]}
      />,
    );

    expect(screen.getByTestId('segments').props.material).toEqual({ role: 'control', variant: 'inline', tone: 'neutral' });
    expect(screen.getByTestId('first').props.material).toBeNull();
    expect(screen.getByTestId('second').props.accessibilityState).toEqual({ selected: true, disabled: false });
    expect(screen.getByText('Second').props.colorRole).toBe('onAccent');
    fireEvent.press(screen.getByText('First').parent as any);
    expect(onChange).toHaveBeenCalledWith('first');
  });

  it('keeps generic screen surfaces transparent until a caller opts into material', () => {
    const screen = render(
      <>
        <ScreenSurface testID="plain">plain</ScreenSurface>
        <ScreenSurface testID="explicit" material={{ role: 'content', variant: 'inset' }}>explicit</ScreenSurface>
      </>,
    );

    expect(screen.getByTestId('plain').props.material).toBeUndefined();
    expect(screen.getByTestId('explicit').props.material).toEqual({ role: 'content', variant: 'inset' });
  });

  it('keeps shared icon controls accessible while materializing their tone', () => {
    const onPress = jest.fn();
    const screen = render(
      <>
        <HeaderActionButton testID="header-action" iconName="close" accessibilityLabel="Close" onPress={onPress} />
        <ScreenIconButton testID="danger-action" iconName="delete" accessibilityLabel="Delete" tone="danger" onPress={onPress} />
      </>,
    );

    expect(screen.getByTestId('header-action').props).toMatchObject({
      accessibilityLabel: 'Close',
      accessibilityRole: 'button',
      material: { role: 'control', variant: 'floating', tone: 'neutral' },
      shape: 'full',
    });
    expect(screen.getByTestId('danger-action').props.material).toEqual({ role: 'control', variant: 'inline', tone: 'error' });
    expect(mockMaterialSymbols).toHaveBeenCalledWith(expect.objectContaining({ name: 'delete', colorRole: 'danger' }));
  });

  it('fails closed to a normal view until Android target blur is supported', () => {
    const targetRef = React.createRef<View>();
    const fallback = render(
      <ScreenAndroidContentBlurTarget testID="target" blurTargetRef={targetRef}>content</ScreenAndroidContentBlurTarget>,
    );
    expect(fallback.getByTestId('target').props.collapsable).toBeUndefined();

    fallback.unmount();
    const resolvedTheme = resolveTheme('glass', 'light');
    mockThemeContext = { colors: resolvedTheme.colors, resolvedMode: 'light', resolvedTheme, themeId: 'glass' };
    mockEnvironment = createMaterialEnvironment('android', {
      androidSdkVersion: 34,
      androidTargetBlurSupported: true,
      blurViewAvailable: true,
      transparencyState: 'allowed',
    });
    const supported = render(
      <ScreenAndroidContentBlurTarget testID="target" blurTargetRef={targetRef}>content</ScreenAndroidContentBlurTarget>,
    );
    expect(supported.getByTestId('target').props.collapsable).toBe(false);
  });
});
