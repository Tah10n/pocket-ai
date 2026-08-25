import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { StyleSheet, View } from 'react-native';
import {
  AndroidBlurBoundaryProvider,
  AndroidBlurSampleTargetProvider,
  type AndroidBlurBoundary,
  type AndroidBlurSampleTarget,
} from '../../src/design-system/materials/AndroidBlurTargetContext';
import {
  EffectPressableSurface,
  EffectSurface,
} from '../../src/design-system/materials/EffectSurface';
import { MaterialEnvironmentProvider } from '../../src/design-system/materials/MaterialEnvironmentProvider';
import { createMaterialEnvironment } from '../../src/design-system/materials/environment';
import { withMaterialPaintOpacity } from '../../src/design-system/materials/style';
import { resolveTheme } from '../../src/design-system/themes/resolver';

let mockResolvedTheme = resolveTheme('glass', 'light');

jest.mock('@/components/ui/box', () => {
  const mockReact = jest.requireActual('react');
  const { View: MockView } = jest.requireActual('react-native');

  return {
    Box: ({ children, ...props }: any) => mockReact.createElement(MockView, props, children),
  };
});

jest.mock('@/components/ui/pressable', () => {
  const mockReact = jest.requireActual('react');
  const { View: MockView } = jest.requireActual('react-native');

  return {
    Pressable: ({ children, ...props }: any) => mockReact.createElement(MockView, props, children),
  };
});

jest.mock('expo-blur', () => {
  const mockReact = jest.requireActual('react');
  const { View: MockView } = jest.requireActual('react-native');

  return {
    BlurView: ({ children, ...props }: any) => mockReact.createElement(MockView, props, children),
  };
});

jest.mock('expo-glass-effect', () => {
  const mockReact = jest.requireActual('react');
  const { View: MockView } = jest.requireActual('react-native');

  return {
    GlassContainer: ({ children, ...props }: any) => mockReact.createElement(MockView, props, children),
    GlassView: ({ children, ...props }: any) => mockReact.createElement(MockView, props, children),
    isGlassEffectAPIAvailable: jest.fn(() => false),
    isLiquidGlassAvailable: jest.fn(() => false),
  };
});

jest.mock('../../src/design-system/materials/AndroidLiquidGlass', () => {
  const mockReact = jest.requireActual('react');
  const { View: MockView } = jest.requireActual('react-native');
  return {
    AndroidLiquidGlassCaptureExclusion: ({ children, ...props }: any) => mockReact.createElement(
      MockView,
      { ...props, androidLiquidGlassCaptureExclusion: true },
      children,
    ),
    AndroidLiquidGlassSurface: ({ children, ...props }: any) => mockReact.createElement(MockView, props, children),
    canUseAndroidLiquidGlass: jest.fn(() => false),
  };
});

jest.mock('../../src/providers/ThemeProvider', () => ({
  useTheme: () => ({ resolvedTheme: mockResolvedTheme }),
}));

function createTarget(ownerId: symbol): {
  readonly boundary: AndroidBlurBoundary;
  readonly sample: AndroidBlurSampleTarget;
} {
  const targetRef = { current: null };

  return {
    boundary: { id: ownerId, targetRef },
    sample: { ownerId, ready: true, targetRef },
  };
}

describe('EffectSurface', () => {
  beforeEach(() => {
    mockResolvedTheme = resolveTheme('glass', 'light');
  });

  it('fails closed to a dense recipe before runtime capabilities are known', () => {
    const screen = render(
      <EffectSurface
        testID="unknown-effect-surface"
        material={{ role: 'chrome', variant: 'header' }}
      />,
    );
    const surface = screen.getByTestId('unknown-effect-surface');

    expect(StyleSheet.flatten(surface.props.style)).toMatchObject({
      backgroundColor: mockResolvedTheme.colors.surfaceOverlay,
      borderWidth: 1,
    });
    expect(screen.UNSAFE_getAllByType(View).some((node: any) => (
      Object.prototype.hasOwnProperty.call(node.props, 'intensity')
    ))).toBe(false);
  });

  it('renders guarded native Liquid Glass with the resolved app color scheme', () => {
    mockResolvedTheme = resolveTheme('glass', 'dark');
    const environment = createMaterialEnvironment('ios', {
      blurViewAvailable: true,
      liquidGlassApiAvailable: true,
      liquidGlassComponentAvailable: true,
      transparencyState: 'allowed',
    });
    const screen = render(
      <MaterialEnvironmentProvider environment={environment}>
        <EffectSurface material={{ role: 'chrome', variant: 'header' }} />
      </MaterialEnvironmentProvider>,
    );
    const glassLayer = screen.UNSAFE_getAllByType(View).find((node: any) => (
      Object.prototype.hasOwnProperty.call(node.props, 'glassEffectStyle')
    ));

    expect(glassLayer?.props.glassEffectStyle).toBe('regular');
    expect(glassLayer?.props.colorScheme).toBe('dark');
    expect(glassLayer?.props.isInteractive).toBe(false);
    expect(glassLayer?.props.tintColor).toBe(withMaterialPaintOpacity(
      mockResolvedTheme.colors.surface,
      0.28,
    ));
    expect(screen.UNSAFE_getAllByType(View).some((node: any) => (
      Object.prototype.hasOwnProperty.call(node.props, 'intensity')
    ))).toBe(false);
  });

  it.each([
    { liquidGlassApiAvailable: false, liquidGlassComponentAvailable: true },
    { liquidGlassApiAvailable: true, liquidGlassComponentAvailable: false },
  ])('uses legacy iOS BlurView when a native Liquid Glass guard is unavailable', (guards) => {
    const environment = createMaterialEnvironment('ios', {
      blurViewAvailable: true,
      ...guards,
      transparencyState: 'allowed',
    });
    const screen = render(
      <MaterialEnvironmentProvider environment={environment}>
        <EffectSurface material={{ role: 'chrome', variant: 'header' }} />
      </MaterialEnvironmentProvider>,
    );
    const blurLayer = screen.UNSAFE_getAllByType(View).find((node: any) => (
      Object.prototype.hasOwnProperty.call(node.props, 'intensity')
    ));

    expect(blurLayer).toBeTruthy();
    expect(blurLayer?.props.blurMethod).toBeUndefined();
    expect(blurLayer?.props.blurTarget).toBeUndefined();
    expect(screen.UNSAFE_getAllByType(View).some((node: any) => (
      Object.prototype.hasOwnProperty.call(node.props, 'glassEffectStyle')
    ))).toBe(false);
  });

  it('uses a dense accessibility fallback instead of any live iOS effect', () => {
    const environment = createMaterialEnvironment('ios', {
      blurViewAvailable: true,
      liquidGlassApiAvailable: true,
      liquidGlassComponentAvailable: true,
      transparencyState: 'reduced',
    });
    const screen = render(
      <MaterialEnvironmentProvider environment={environment}>
        <EffectSurface
          testID="reduced-transparency-surface"
          material={{ role: 'chrome', variant: 'header' }}
        />
      </MaterialEnvironmentProvider>,
    );

    expect(StyleSheet.flatten(
      screen.getByTestId('reduced-transparency-surface').props.style,
    )).toMatchObject({
      backgroundColor: mockResolvedTheme.colors.surfaceOverlay,
      borderWidth: 1,
    });
    expect(screen.UNSAFE_getAllByType(View).some((node: any) => (
      Object.prototype.hasOwnProperty.call(node.props, 'intensity')
      || Object.prototype.hasOwnProperty.call(node.props, 'glassEffectStyle')
    ))).toBe(false);
  });

  it('enables hit-tested native interaction only on an actual pressable control', () => {
    const onPress = jest.fn();
    const environment = createMaterialEnvironment('ios', {
      blurViewAvailable: true,
      liquidGlassApiAvailable: true,
      liquidGlassComponentAvailable: true,
      transparencyState: 'allowed',
    });
    const screen = render(
      <MaterialEnvironmentProvider environment={environment}>
        <EffectPressableSurface
          testID="native-glass-control"
          material={{ role: 'control', variant: 'floating' }}
          accessibilityLabel="Native glass action"
          accessibilityRole="button"
          onPress={onPress}
          style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1 })}
        >
          control
        </EffectPressableSurface>
      </MaterialEnvironmentProvider>,
    );
    const glassLayer = screen.UNSAFE_getAllByType(View).find((node: any) => (
      Object.prototype.hasOwnProperty.call(node.props, 'glassEffectStyle')
    ));

    expect(glassLayer?.props.glassEffectStyle).toBe('regular');
    expect(glassLayer?.props.pointerEvents).toBe('auto');
    expect(glassLayer?.props.isInteractive).toBe(true);
    const control = screen.getByTestId('native-glass-control');
    expect(control.props.accessibilityLabel).toBe('Native glass action');
    expect(control.props.accessibilityRole).toBe('button');
    expect(StyleSheet.flatten(control.props.style({ pressed: true }))).toMatchObject({
      borderRadius: 16,
      opacity: 0.8,
    });
    fireEvent.press(control);
    expect(onPress).toHaveBeenCalledTimes(1);

    screen.rerender(
      <MaterialEnvironmentProvider environment={environment}>
        <EffectPressableSurface
          disabled
          testID="native-glass-control"
          material={{ role: 'control', variant: 'floating' }}
          onPress={onPress}
        >
          control
        </EffectPressableSurface>
      </MaterialEnvironmentProvider>,
    );
    const disabledGlassLayer = screen.UNSAFE_getAllByType(View).find((node: any) => (
      Object.prototype.hasOwnProperty.call(node.props, 'glassEffectStyle')
    ));

    expect(disabledGlassLayer?.props.pointerEvents).toBe('none');
    expect(disabledGlassLayer?.props.isInteractive).toBe(false);
    expect(screen.getByTestId('native-glass-control').props.disabled).toBe(true);
  });

  it('uses an external Android sample target on SDK 31+', () => {
    const target = createTarget(Symbol('background'));
    const sceneBoundary = createTarget(Symbol('scene')).boundary;
    const environment = createMaterialEnvironment('android', {
      androidSdkVersion: 34,
      androidTargetBlurSupported: true,
      blurViewAvailable: true,
      transparencyState: 'allowed',
    });
    const screen = render(
      <MaterialEnvironmentProvider environment={environment}>
        <AndroidBlurSampleTargetProvider target={target.sample}>
          <AndroidBlurBoundaryProvider boundary={sceneBoundary}>
            <EffectSurface material={{ role: 'chrome', variant: 'header' }} />
          </AndroidBlurBoundaryProvider>
        </AndroidBlurSampleTargetProvider>
      </MaterialEnvironmentProvider>,
    );
    const blurLayer = screen.UNSAFE_getAllByType(View).find((node: any) => (
      node.props.blurMethod === 'dimezisBlurViewSdk31Plus'
    ));

    expect(blurLayer?.props.blurTarget).toBe(target.sample.targetRef);
    expect(blurLayer?.props.blurReductionFactor).toBeGreaterThan(1);
  });

  it('passes semantic fallback paint and exact shape to the Android native renderer', () => {
    const environment = createMaterialEnvironment('android', {
      androidSdkVersion: 33,
      androidLiquidGlassAvailable: true,
      androidTargetBlurSupported: true,
      transparencyState: 'allowed',
    });
    const screen = render(
      <MaterialEnvironmentProvider environment={environment}>
        <EffectSurface material={{ role: 'overlay', variant: 'popover', tone: 'warning' }} shape="sheet" />
      </MaterialEnvironmentProvider>,
    );
    const nativeLayer = screen.UNSAFE_getAllByType(View).find((node: any) => (
      Object.prototype.hasOwnProperty.call(node.props, 'fallbackColor')
    ));
    expect(nativeLayer?.props).toMatchObject({
      cornerRadiusTopLeft: 32,
      cornerRadiusTopRight: 32,
      cornerRadiusBottomLeft: 0,
      cornerRadiusBottomRight: 0,
      fallbackColor: mockResolvedTheme.colors.warningSurface,
      fallbackBorderColor: mockResolvedTheme.colors.borderSubtle,
      fallbackBorderWidth: 1,
      tintOpacity: 0.34,
    });
    const captureBoundary = screen.UNSAFE_getAllByType(View).find((node: any) => (
      node.props.androidLiquidGlassCaptureExclusion === true
    ));
    expect(captureBoundary?.props).toMatchObject({
      collapsable: false,
      pointerEvents: 'box-none',
    });
    expect(StyleSheet.flatten(captureBoundary?.props.style)).not.toMatchObject({
      display: 'contents',
    });
  });

  it('keeps Android pressable layout and hitbox styling on the real pressable host', () => {
    const onPress = jest.fn();
    const environment = createMaterialEnvironment('android', {
      androidSdkVersion: 34,
      androidLiquidGlassAvailable: true,
      transparencyState: 'allowed',
    });
    const screen = render(
      <MaterialEnvironmentProvider environment={environment}>
        <EffectPressableSurface
          testID="android-glass-control"
          className="flex-1 m-2 absolute w-3/4 flex-row items-center justify-center gap-2"
          material={{ role: 'control', variant: 'floating' }}
          onPress={onPress}
          style={({ pressed }) => ({
            flex: 1,
            left: 10,
            margin: 8,
            opacity: pressed ? 0.4 : 1,
            position: 'absolute',
            width: '75%',
          })}
        >
          <View testID="control-icon" />
          <View testID="control-label" />
        </EffectPressableSurface>
      </MaterialEnvironmentProvider>,
    );
    const control = screen.getByTestId('android-glass-control');
    const captureBoundaries = screen.UNSAFE_getAllByType(View).filter((node: any) => (
      node.props.androidLiquidGlassCaptureExclusion === true
    ));

    expect(control.props.className).toBe('flex-1 m-2 absolute w-3/4 flex-row items-center justify-center gap-2');
    expect(StyleSheet.flatten(control.props.style({ pressed: true }))).toMatchObject({
      borderRadius: 16,
      borderColor: 'transparent',
      borderWidth: 1,
      elevation: 10,
      flex: 1,
      left: 10,
      margin: 8,
      opacity: 0.4,
      position: 'absolute',
      width: '75%',
    });
    expect(captureBoundaries).toHaveLength(3);
    expect(captureBoundaries.every((boundary: any) => boundary.props.className === undefined)).toBe(true);
    expect(StyleSheet.flatten(captureBoundaries[0].props.style)).toMatchObject({
      bottom: -1,
      elevation: 0,
      left: -1,
      right: -1,
      shadowColor: 'transparent',
      shadowOpacity: 0,
      shadowRadius: 0,
      top: -1,
      zIndex: 0,
    });
    expect(captureBoundaries.slice(1).every((boundary: any) => (
      StyleSheet.flatten(boundary.props.style).zIndex === 1
    ))).toBe(true);
    expect(captureBoundaries[1].findByProps({ testID: 'control-icon' })).toBeTruthy();
    expect(captureBoundaries[2].findByProps({ testID: 'control-label' })).toBeTruthy();
    fireEvent.press(control);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('uses a ready explicit Android target for sibling composer chrome', () => {
    const explicitTargetRef = { current: {} } as React.RefObject<View | null>;
    const environment = createMaterialEnvironment('android', {
      androidSdkVersion: 34,
      androidTargetBlurSupported: true,
      blurViewAvailable: true,
      transparencyState: 'allowed',
    });
    const screen = render(
      <MaterialEnvironmentProvider environment={environment}>
        <EffectSurface
          androidBlurTargetRef={explicitTargetRef}
          material={{ role: 'chrome', variant: 'composer' }}
        />
      </MaterialEnvironmentProvider>,
    );
    const blurLayer = screen.UNSAFE_getAllByType(View).find((node: any) => (
      node.props.blurMethod === 'dimezisBlurViewSdk31Plus'
    ));

    expect(blurLayer?.props.blurTarget).toBe(explicitTargetRef);
  });

  it('fails closed while an Android sample target is pending', () => {
    const target = createTarget(Symbol('pending'));
    const environment = createMaterialEnvironment('android', {
      androidSdkVersion: 34,
      androidTargetBlurSupported: true,
      blurViewAvailable: true,
      transparencyState: 'allowed',
    });
    const screen = render(
      <MaterialEnvironmentProvider environment={environment}>
        <AndroidBlurSampleTargetProvider target={{ ...target.sample, ready: false }}>
          <EffectSurface material={{ role: 'chrome', variant: 'header' }} />
        </AndroidBlurSampleTargetProvider>
      </MaterialEnvironmentProvider>,
    );

    expect(screen.UNSAFE_getAllByType(View).some((node: any) => (
      Object.prototype.hasOwnProperty.call(node.props, 'intensity')
    ))).toBe(false);
  });

  it('fails closed when the Android sample target owns an ancestor boundary', () => {
    const ownedTarget = createTarget(Symbol('content'));
    const environment = createMaterialEnvironment('android', {
      androidSdkVersion: 34,
      androidTargetBlurSupported: true,
      blurViewAvailable: true,
      transparencyState: 'allowed',
    });
    const screen = render(
      <MaterialEnvironmentProvider environment={environment}>
        <AndroidBlurSampleTargetProvider target={ownedTarget.sample}>
          <AndroidBlurBoundaryProvider boundary={ownedTarget.boundary}>
            <EffectSurface material={{ role: 'chrome', variant: 'header' }} />
          </AndroidBlurBoundaryProvider>
        </AndroidBlurSampleTargetProvider>
      </MaterialEnvironmentProvider>,
    );

    expect(screen.UNSAFE_getAllByType(View).some((node: any) => (
      Object.prototype.hasOwnProperty.call(node.props, 'intensity')
    ))).toBe(false);
  });
});
