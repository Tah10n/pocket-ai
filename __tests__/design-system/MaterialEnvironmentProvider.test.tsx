import React from 'react';
import { act, render, waitFor } from '@testing-library/react-native';
import { AccessibilityInfo, Platform, Text } from 'react-native';
import {
  MaterialEnvironmentProvider,
  RuntimeMaterialEnvironmentProvider,
  useMaterialEnvironment,
} from '../../src/design-system/materials/MaterialEnvironmentProvider';
import { createMaterialEnvironment } from '../../src/design-system/materials/environment';

const glassEffectMock = jest.requireMock('expo-glass-effect') as {
  isGlassEffectAPIAvailable: jest.Mock<boolean, []>;
  isLiquidGlassAvailable: jest.Mock<boolean, []>;
};

function EnvironmentProbe() {
  const environment = useMaterialEnvironment();

  return (
    <Text testID="material-environment">
      {[
        environment.platform,
        environment.transparencyState,
        environment.liquidGlassComponentAvailable,
        environment.liquidGlassApiAvailable,
      ].join(':')}
    </Text>
  );
}

function AndroidEnvironmentProbe() {
  const environment = useMaterialEnvironment();

  return (
    <Text testID="android-material-environment">
      {[
        environment.platform,
        environment.androidSdkVersion ?? 'unknown',
        environment.blurViewAvailable,
        environment.androidTargetBlurSupported,
        environment.transparencyState,
      ].join(':')}
    </Text>
  );
}

describe('MaterialEnvironmentProvider', () => {
  const originalPlatform = Platform.OS;
  const originalPlatformVersion = Platform.Version;
  const originalReduceTransparencyQuery = AccessibilityInfo.isReduceTransparencyEnabled;
  const originalAccessibilityListener = AccessibilityInfo.addEventListener;
  const reduceTransparencyQueryMock = jest.fn<Promise<boolean>, []>();
  const accessibilityListenerMock = jest.fn();

  beforeEach(() => {
    glassEffectMock.isGlassEffectAPIAvailable.mockReset().mockReturnValue(false);
    glassEffectMock.isLiquidGlassAvailable.mockReset().mockReturnValue(false);
    reduceTransparencyQueryMock.mockReset().mockResolvedValue(false);
    accessibilityListenerMock.mockReset().mockReturnValue({ remove: jest.fn() });
    Object.defineProperty(AccessibilityInfo, 'isReduceTransparencyEnabled', {
      configurable: true,
      value: reduceTransparencyQueryMock,
    });
    Object.defineProperty(AccessibilityInfo, 'addEventListener', {
      configurable: true,
      value: accessibilityListenerMock,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    Object.defineProperty(Platform, 'OS', {
      configurable: true,
      get: () => originalPlatform,
    });
    Object.defineProperty(Platform, 'Version', {
      configurable: true,
      get: () => originalPlatformVersion,
    });
    Object.defineProperty(AccessibilityInfo, 'isReduceTransparencyEnabled', {
      configurable: true,
      value: originalReduceTransparencyQuery,
    });
    Object.defineProperty(AccessibilityInfo, 'addEventListener', {
      configurable: true,
      value: originalAccessibilityListener,
    });
  });

  it('fails closed before a runtime provider supplies capabilities', () => {
    const screen = render(<EnvironmentProbe />);

    expect(screen.getByTestId('material-environment').props.children).toBe('web:unknown:false:false');
  });

  it('injects a deterministic environment without reading global Platform state', () => {
    const environment = createMaterialEnvironment('ios', {
      blurViewAvailable: true,
      liquidGlassApiAvailable: true,
      liquidGlassComponentAvailable: true,
      transparencyState: 'allowed',
    });
    const screen = render(
      <MaterialEnvironmentProvider environment={environment}>
        <EnvironmentProbe />
      </MaterialEnvironmentProvider>,
    );

    expect(screen.getByTestId('material-environment').props.children).toBe('ios:allowed:true:true');
  });

  it.each([
    { expected: 'android:34:true:true:allowed', version: 34 },
    { expected: 'android:30:true:false:allowed', version: '30' },
    { expected: 'android:unknown:true:false:allowed', version: 'preview' },
    { expected: 'android:unknown:true:false:allowed', version: '31-preview' },
    { expected: 'android:unknown:true:false:allowed', version: '31.5' },
    { expected: 'android:unknown:true:false:allowed', version: 31.5 },
  ])('derives the Android target-blur capability from SDK $version', ({ expected, version }) => {
    Object.defineProperty(Platform, 'OS', {
      configurable: true,
      get: () => 'android',
    });
    Object.defineProperty(Platform, 'Version', {
      configurable: true,
      get: () => version,
    });

    const screen = render(
      <RuntimeMaterialEnvironmentProvider>
        <AndroidEnvironmentProbe />
      </RuntimeMaterialEnvironmentProvider>,
    );

    expect(screen.getByTestId('android-material-environment').props.children).toBe(expected);
    expect(glassEffectMock.isLiquidGlassAvailable).not.toHaveBeenCalled();
    expect(glassEffectMock.isGlassEffectAPIAvailable).not.toHaveBeenCalled();
    expect(reduceTransparencyQueryMock).not.toHaveBeenCalled();
    expect(accessibilityListenerMock).not.toHaveBeenCalled();
  });

  it('fails closed until the iOS transparency query resolves and reacts to later changes', async () => {
    Object.defineProperty(Platform, 'OS', {
      configurable: true,
      get: () => 'ios',
    });
    glassEffectMock.isLiquidGlassAvailable.mockReturnValue(true);
    glassEffectMock.isGlassEffectAPIAvailable.mockReturnValue(true);

    let resolveTransparency: ((isReduced: boolean) => void) | undefined;
    const transparencyPromise = new Promise<boolean>((resolve) => {
      resolveTransparency = resolve;
    });
    let transparencyListener: ((isReduced: boolean) => void) | undefined;
    const remove = jest.fn();
    reduceTransparencyQueryMock.mockReturnValue(transparencyPromise);
    accessibilityListenerMock.mockImplementation(
      (eventName: string, listener: (isReduced: boolean) => void) => {
        if (eventName === 'reduceTransparencyChanged') {
          transparencyListener = listener;
        }
        return { remove };
      },
    );

    const screen = render(
      <RuntimeMaterialEnvironmentProvider>
        <EnvironmentProbe />
      </RuntimeMaterialEnvironmentProvider>,
    );

    expect(screen.getByTestId('material-environment').props.children).toBe('ios:unknown:true:true');
    expect(glassEffectMock.isLiquidGlassAvailable).toHaveBeenCalledTimes(1);
    expect(glassEffectMock.isGlassEffectAPIAvailable).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveTransparency?.(false);
      await transparencyPromise;
    });
    await waitFor(() => expect(
      screen.getByTestId('material-environment').props.children,
    ).toBe('ios:allowed:true:true'));

    act(() => {
      transparencyListener?.(true);
    });
    expect(screen.getByTestId('material-environment').props.children).toBe('ios:reduced:true:true');

    screen.unmount();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('checks both native capabilities independently and stays fail closed on query failure', async () => {
    Object.defineProperty(Platform, 'OS', {
      configurable: true,
      get: () => 'ios',
    });
    glassEffectMock.isLiquidGlassAvailable.mockImplementation(() => {
      throw new Error('component unavailable');
    });
    glassEffectMock.isGlassEffectAPIAvailable.mockReturnValue(true);
    reduceTransparencyQueryMock.mockRejectedValue(new Error('accessibility unavailable'));

    const screen = render(
      <RuntimeMaterialEnvironmentProvider>
        <EnvironmentProbe />
      </RuntimeMaterialEnvironmentProvider>,
    );

    expect(screen.getByTestId('material-environment').props.children).toBe('ios:unknown:false:true');
    expect(glassEffectMock.isLiquidGlassAvailable).toHaveBeenCalledTimes(1);
    expect(glassEffectMock.isGlassEffectAPIAvailable).toHaveBeenCalledTimes(1);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('material-environment').props.children).toContain('ios:unknown');
  });

  it('does not let a stale initial query overwrite a newer transparency event', async () => {
    Object.defineProperty(Platform, 'OS', {
      configurable: true,
      get: () => 'ios',
    });
    glassEffectMock.isLiquidGlassAvailable.mockReturnValue(true);
    glassEffectMock.isGlassEffectAPIAvailable.mockReturnValue(true);

    let resolveTransparency: ((isReduced: boolean) => void) | undefined;
    const transparencyPromise = new Promise<boolean>((resolve) => {
      resolveTransparency = resolve;
    });
    let transparencyListener: ((isReduced: boolean) => void) | undefined;
    reduceTransparencyQueryMock.mockReturnValue(transparencyPromise);
    accessibilityListenerMock.mockImplementation(
      (eventName: string, listener: (isReduced: boolean) => void) => {
        if (eventName === 'reduceTransparencyChanged') {
          transparencyListener = listener;
        }
        return { remove: jest.fn() };
      },
    );

    const screen = render(
      <RuntimeMaterialEnvironmentProvider>
        <EnvironmentProbe />
      </RuntimeMaterialEnvironmentProvider>,
    );

    act(() => {
      transparencyListener?.(true);
    });
    expect(screen.getByTestId('material-environment').props.children).toBe('ios:reduced:true:true');

    await act(async () => {
      resolveTransparency?.(false);
      await transparencyPromise;
    });
    expect(screen.getByTestId('material-environment').props.children).toBe('ios:reduced:true:true');
  });
});
