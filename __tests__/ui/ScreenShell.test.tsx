import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { StyleSheet, Text, View } from 'react-native';
import { resolveTheme } from '../../src/design-system/themes/resolver';
import { createMaterialEnvironment } from '../../src/design-system/materials/environment';
import {
  HeaderActionButton,
  ScreenAndroidContentBlurTarget,
  ScreenBadge,
  ScreenCard,
  ScreenContent,
  ScreenHeaderShell,
  ScreenIconButton,
  ScreenModalOverlay,
  ScreenRoot,
  ScreenSegmentedControl,
  ScreenSheet,
  ScreenSurface,
  useAndroidLiquidGlassSceneRefresh,
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

    function SceneRefreshControl() {
      const requestSceneRefresh = useAndroidLiquidGlassSceneRefresh();
      return <Text testID="request-scene-refresh" onPress={requestSceneRefresh}>recorded scene content</Text>;
    }

    const screen = render(<ScreenRoot testID="root"><SceneRefreshControl /></ScreenRoot>);

    const provider = screen.getByTestId('screen-material-liquid-glass-scene');
    expect(provider.props.active).toBe(true);
    expect(provider.props.sceneRevision).toBe('glass-light-0');
    expect(provider.findByProps({ children: 'recorded scene content' })).toBeTruthy();
    expect(provider.findByProps({ testID: 'screen-decoration' })).toBeTruthy();
    expect(provider.findByProps({ testID: 'screen-decoration-dim' })).toBeTruthy();
    expect(screen.queryByTestId('screen-material-blur-target')).toBeNull();
    expect(screen.queryByTestId('screen-material-scene-blur-target')).toBeNull();

    fireEvent.press(screen.getByTestId('request-scene-refresh'));
    expect(screen.getByTestId('screen-material-liquid-glass-scene').props.sceneRevision)
      .toBe('glass-light-1');

    const darkTheme = resolveTheme('glass', 'dark');
    mockThemeContext = { colors: darkTheme.colors, resolvedMode: 'dark', resolvedTheme: darkTheme, themeId: 'glass' };
    screen.rerender(<ScreenRoot testID="root"><SceneRefreshControl /></ScreenRoot>);
    expect(screen.getByTestId('screen-material-liquid-glass-scene').props.sceneRevision).toBe('glass-dark-1');
  });

  it.each([
    ['native Android Liquid Glass', createMaterialEnvironment('android', {
      androidSdkVersion: 34,
      androidLiquidGlassAvailable: true,
      androidTargetBlurSupported: true,
      blurViewAvailable: true,
      transparencyState: 'allowed',
    })],
    ['legacy Android blur', createMaterialEnvironment('android', {
      androidSdkVersion: 32,
      androidTargetBlurSupported: true,
      blurViewAvailable: true,
      transparencyState: 'allowed',
    })],
    ['Android without blur', createMaterialEnvironment('android', {
      androidSdkVersion: 30,
      transparencyState: 'allowed',
    })],
    ['web', createMaterialEnvironment('web')],
  ])('keeps the stateful screen subtree mounted while switching Standard and Glass on %s', (_label, environment) => {
    const defaultTheme = resolveTheme('default', 'light');
    const glassTheme = resolveTheme('glass', 'light');
    mockEnvironment = environment;
    mockThemeContext = {
      colors: defaultTheme.colors,
      resolvedMode: 'light',
      resolvedTheme: defaultTheme,
      themeId: 'default',
    };
    const unmount = jest.fn();
    function StatefulScreen() {
      const [draft, setDraft] = React.useState('draft');
      React.useEffect(() => () => unmount(), []);
      return <Text testID="stateful-draft" onPress={() => setDraft('preserved')}>{draft}</Text>;
    }
    const renderRoot = () => <ScreenRoot><StatefulScreen /></ScreenRoot>;
    const screen = render(renderRoot());

    fireEvent.press(screen.getByTestId('stateful-draft'));
    expect(screen.getByTestId('stateful-draft').props.children).toBe('preserved');

    mockThemeContext = {
      colors: glassTheme.colors,
      resolvedMode: 'light',
      resolvedTheme: glassTheme,
      themeId: 'glass',
    };
    screen.rerender(renderRoot());
    expect(screen.getByTestId('stateful-draft').props.children).toBe('preserved');

    mockThemeContext = {
      colors: defaultTheme.colors,
      resolvedMode: 'light',
      resolvedTheme: defaultTheme,
      themeId: 'default',
    };
    screen.rerender(renderRoot());
    expect(screen.getByTestId('stateful-draft').props.children).toBe('preserved');
    expect(unmount).not.toHaveBeenCalled();
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

  it('exposes a labelled badge as one semantic text element', () => {
    const screen = render(
      <ScreenBadge accessibilityLabel="Vision supported" iconName="visibility" testID="vision-badge">
        Vision
      </ScreenBadge>,
    );

    expect(screen.getByLabelText('Vision supported')).toBe(screen.getByTestId('vision-badge'));
    expect(screen.getByTestId('vision-badge').props).toMatchObject({
      accessible: true,
      accessibilityRole: 'text',
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

  it('adds semantic top spacing after a measured floating header', () => {
    const resolvedTheme = resolveTheme('glass', 'light');
    mockThemeContext = { colors: resolvedTheme.colors, resolvedMode: 'light', resolvedTheme, themeId: 'glass' };
    const screen = render(
      <ScreenRoot>
        <ScreenHeaderShell testID="header">header</ScreenHeaderShell>
        <ScreenContent testID="content" topSpacing="default">content</ScreenContent>
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
      paddingTop: 140,
    });
  });

  it('keeps semantic top spacing when the header participates in layout', () => {
    const screen = render(
      <ScreenContent testID="content" topSpacing="default">content</ScreenContent>,
    );

    expect(StyleSheet.flatten(screen.getByTestId('content').props.style)).toMatchObject({
      paddingTop: 16,
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

  it('supports compact embedded segmented controls inside effect chrome', () => {
    const screen = render(
      <ScreenSegmentedControl
        testID="compact-segments"
        activeKey="first"
        density="compact"
        embedded
        onChange={jest.fn()}
        options={[
          { key: 'first', label: 'First', testID: 'compact-first' },
          { key: 'second', label: 'Second' },
        ]}
      />,
    );

    expect(screen.getByTestId('compact-segments').props.material).toBeNull();
    expect(StyleSheet.flatten(screen.getByTestId('compact-segments').props.style)).toMatchObject({
      padding: 4,
    });
    expect(StyleSheet.flatten(screen.getByTestId('compact-first').props.style)).toMatchObject({
      paddingHorizontal: 10,
    });
    expect(StyleSheet.flatten(screen.getByTestId('compact-first').props.style)).not.toHaveProperty('minHeight');
    expect(StyleSheet.flatten(screen.getByTestId('compact-first').props.style)).not.toHaveProperty('paddingVertical');
    expect(screen.getByTestId('compact-first').props.hitSlop).toBe(8);
    expect(screen.getByText('First').props).toMatchObject({
      adjustsFontSizeToFit: true,
      minimumFontScale: 0.85,
      numberOfLines: 1,
    });
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
      hitSlop: 8,
      material: { role: 'control', variant: 'floating', tone: 'neutral' },
      shape: 'full',
    });
    expect(screen.getByTestId('header-action').props.className).toContain('h-10 w-10');
    expect(mockMaterialSymbols).toHaveBeenCalledWith(expect.objectContaining({
      name: 'close',
      size: 20,
    }));
    expect(screen.getByTestId('danger-action').props.material).toEqual({ role: 'control', variant: 'inline', tone: 'error' });
    expect(mockMaterialSymbols).toHaveBeenCalledWith(expect.objectContaining({ name: 'delete', colorRole: 'danger' }));
  });

  it.each([
    { apiLevel: 34, nativeAvailable: true, targetSupported: true, themeId: 'glass', expectedBlurTarget: false },
    { apiLevel: 34, nativeAvailable: false, targetSupported: true, themeId: 'glass', expectedBlurTarget: true },
    { apiLevel: 34, nativeAvailable: true, targetSupported: true, themeId: 'default', expectedBlurTarget: false },
    { apiLevel: 32, nativeAvailable: false, targetSupported: true, themeId: 'glass', expectedBlurTarget: true },
    { apiLevel: 32, nativeAvailable: false, targetSupported: true, themeId: 'default', expectedBlurTarget: true },
    { apiLevel: 30, nativeAvailable: false, targetSupported: false, themeId: 'glass', expectedBlurTarget: false },
  ])('selects the content blur target for Android renderer capabilities %#', ({
    apiLevel,
    nativeAvailable,
    targetSupported,
    themeId,
    expectedBlurTarget,
  }) => {
    const targetRef = React.createRef<View>();
    const resolvedTheme = resolveTheme(themeId as 'default' | 'glass', 'light');
    mockThemeContext = { colors: resolvedTheme.colors, resolvedMode: 'light', resolvedTheme, themeId };
    mockEnvironment = createMaterialEnvironment('android', {
      androidSdkVersion: apiLevel,
      androidLiquidGlassAvailable: nativeAvailable,
      androidTargetBlurSupported: targetSupported,
      blurViewAvailable: true,
      transparencyState: 'allowed',
    });
    const screen = render(
      <ScreenAndroidContentBlurTarget testID="target" blurTargetRef={targetRef}>content</ScreenAndroidContentBlurTarget>,
    );
    expect(screen.getByTestId('target').props.collapsable).toBe(
      expectedBlurTarget ? false : undefined,
    );
  });

  it('mounts API 33+ targets for a current blur-only theme without affecting native Glass', () => {
    const targetRef = React.createRef<View>();
    const denseTheme = resolveTheme('default', 'light');
    const liquidTheme = resolveTheme('glass', 'light');
    const floatingControl = liquidTheme.materials.control.floating.neutral;
    const blurOnlyTheme = {
      ...denseTheme,
      materials: {
        ...denseTheme.materials,
        control: {
          ...denseTheme.materials.control,
          floating: {
            neutral: {
              ...floatingControl,
              preferredByPlatform: {
                ...floatingControl.preferredByPlatform,
                android: floatingControl.platformFallbackByPlatform!.android!,
              },
            },
          },
        },
      },
    };
    mockThemeContext = {
      colors: blurOnlyTheme.colors,
      resolvedMode: 'light',
      resolvedTheme: blurOnlyTheme,
      themeId: 'future-blur-only',
    };
    mockEnvironment = createMaterialEnvironment('android', {
      androidSdkVersion: 34,
      androidLiquidGlassAvailable: true,
      androidTargetBlurSupported: true,
      transparencyState: 'allowed',
    });

    const contentTargetScreen = render(
      <ScreenAndroidContentBlurTarget testID="target" blurTargetRef={targetRef}>
        content
      </ScreenAndroidContentBlurTarget>,
    );

    expect(contentTargetScreen.getByTestId('target').props.collapsable).toBe(false);
    contentTargetScreen.unmount();

    const rootScreen = render(<ScreenRoot>content</ScreenRoot>);
    expect(rootScreen.getByTestId('screen-material-blur-target')).toBeTruthy();
    expect(rootScreen.getByTestId('screen-material-scene-blur-target')).toBeTruthy();
  });
});
