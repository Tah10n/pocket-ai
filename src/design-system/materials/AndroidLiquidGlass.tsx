import React from 'react';
import { Platform, processColor, type ViewProps } from 'react-native';
import { cssInterop } from 'nativewind';
import { Box } from '../../components/ui/box';
import { resolveAndroidGlassCapability } from '../../utils/androidLiquidGlass';

interface ProviderProps extends ViewProps {
  active?: boolean;
}

interface SurfaceProps extends ViewProps {
  cornerRadius: number;
  cornerRadiusTopLeft?: number;
  cornerRadiusTopRight?: number;
  cornerRadiusBottomRight?: number;
  cornerRadiusBottomLeft?: number;
  dark: boolean;
  tintColor?: string;
  tintOpacity?: number;
  fallbackColor?: string;
  fallbackOpacity?: number;
  fallbackBorderColor?: string;
  fallbackBorderOpacity?: number;
  fallbackBorderWidth?: number;
  effectsEnabled?: boolean;
  interactive?: boolean;
  pressed?: boolean;
}

type NativeSurfaceProps = Omit<SurfaceProps, 'cornerRadius' | 'tintColor' | 'fallbackColor' | 'fallbackBorderColor'> & {
  cornerRadiusTopLeft: number;
  cornerRadiusTopRight: number;
  cornerRadiusBottomRight: number;
  cornerRadiusBottomLeft: number;
  tintColor?: number;
  fallbackColor?: number;
  fallbackBorderColor?: number;
};

type NativeCaptureExclusionProps = ViewProps;

let NativeProvider: React.ComponentType<ProviderProps> | null | undefined;
let NativeSurface: React.ComponentType<NativeSurfaceProps> | null | undefined;
let NativeCaptureExclusion: React.ComponentType<NativeCaptureExclusionProps> | null | undefined;

export function __setAndroidLiquidGlassNativeViewsForTests(
  provider: React.ComponentType<ProviderProps> | null | undefined,
  surface: React.ComponentType<NativeSurfaceProps> | null | undefined,
  exclusion: React.ComponentType<NativeCaptureExclusionProps> | null | undefined = null,
) {
  NativeProvider = provider;
  NativeSurface = surface;
  NativeCaptureExclusion = exclusion;
}

function resolveNativeViews() {
  if (
    NativeProvider !== undefined
    && NativeSurface !== undefined
    && NativeCaptureExclusion !== undefined
  ) return;
  try {
    // Resolve lazily so iOS, web, and Jest never initialize the Android-only native module.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { requireNativeViewManager } = require('expo-modules-core') as {
      requireNativeViewManager: <P>(moduleName: string, viewName?: string) => React.ComponentType<P>;
    };
    NativeProvider = cssInterop(
      requireNativeViewManager<ProviderProps>('PocketLiquidGlass', 'PocketLiquidGlassBackdropProvider'),
      { className: 'style' },
    );
    NativeSurface = cssInterop(
      requireNativeViewManager<NativeSurfaceProps>('PocketLiquidGlass', 'PocketLiquidGlassSurface'),
      { className: 'style' },
    );
    NativeCaptureExclusion = cssInterop(
      requireNativeViewManager<NativeCaptureExclusionProps>('PocketLiquidGlass', 'PocketLiquidGlassCaptureExclusion'),
      { className: 'style' },
    );
  } catch {
    NativeProvider = null;
    NativeSurface = null;
    NativeCaptureExclusion = null;
  }
}

export function canUseAndroidLiquidGlass() {
  if (Platform.OS !== 'android') return false;
  const apiLevel = typeof Platform.Version === 'number'
    ? Platform.Version
    : Number.parseInt(String(Platform.Version), 10);
  // Do not resolve the Expo view manager on API 24-32. This keeps Android's
  // class verifier away from the API 33 renderer before capability is known.
  if (!Number.isFinite(apiLevel) || apiLevel < 33) return false;
  resolveNativeViews();
  return resolveAndroidGlassCapability({
    apiLevel,
    nativeRendererAvailable: Boolean(NativeProvider && NativeSurface),
  }).renderer === 'android-liquid-glass';
}

export function AndroidLiquidGlassBackdropProvider({ children, ...props }: ProviderProps) {
  if (!canUseAndroidLiquidGlass() || !NativeProvider) {
    return <Box {...props}>{children}</Box>;
  }
  return <NativeProvider {...props}>{children}</NativeProvider>;
}

export function AndroidLiquidGlassSurface({
  children,
  cornerRadius,
  cornerRadiusTopLeft = cornerRadius,
  cornerRadiusTopRight = cornerRadius,
  cornerRadiusBottomRight = cornerRadius,
  cornerRadiusBottomLeft = cornerRadius,
  dark,
  tintColor = '#3b82f6',
  tintOpacity = 0,
  fallbackColor = 'transparent',
  fallbackOpacity = 1,
  fallbackBorderColor = 'transparent',
  fallbackBorderOpacity = 1,
  fallbackBorderWidth = 0,
  effectsEnabled = true,
  interactive = false,
  pressed = false,
  ...props
}: SurfaceProps) {
  if (!canUseAndroidLiquidGlass() || !NativeSurface) {
    return <Box {...props}>{children}</Box>;
  }
  const processedTintColor = processColor(tintColor);
  const processedFallbackColor = processColor(fallbackColor);
  const processedFallbackBorderColor = processColor(fallbackBorderColor);
  return (
    <NativeSurface
      {...props}
      cornerRadiusTopLeft={cornerRadiusTopLeft}
      cornerRadiusTopRight={cornerRadiusTopRight}
      cornerRadiusBottomRight={cornerRadiusBottomRight}
      cornerRadiusBottomLeft={cornerRadiusBottomLeft}
      dark={dark}
      tintColor={typeof processedTintColor === 'number' ? processedTintColor : undefined}
      tintOpacity={tintOpacity}
      fallbackColor={typeof processedFallbackColor === 'number' ? processedFallbackColor : undefined}
      fallbackOpacity={fallbackOpacity}
      fallbackBorderColor={typeof processedFallbackBorderColor === 'number'
        ? processedFallbackBorderColor
        : undefined}
      fallbackBorderOpacity={fallbackBorderOpacity}
      fallbackBorderWidth={fallbackBorderWidth}
      effectsEnabled={effectsEnabled}
      interactive={interactive}
      pressed={pressed}
    >
      {children}
    </NativeSurface>
  );
}

export function AndroidLiquidGlassCaptureExclusion({ children, ...props }: NativeCaptureExclusionProps) {
  if (!canUseAndroidLiquidGlass() || !NativeCaptureExclusion) {
    return <Box {...props}>{children}</Box>;
  }

  return (
    <NativeCaptureExclusion {...props}>{children}</NativeCaptureExclusion>
  );
}
