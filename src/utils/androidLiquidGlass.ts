import { Platform } from 'react-native';

export type AndroidGlassRenderer =
  | 'android-liquid-glass'
  | 'android-frosted-blur'
  | 'dense';

export type AndroidBackdropTargetState = 'pending' | 'ready' | 'detached';

export interface AndroidGlassCapabilityInput {
  apiLevel?: number;
  effectsEnabled?: boolean;
  nativeRendererAvailable?: boolean;
  platform?: typeof Platform.OS;
  rendererFailed?: boolean;
}

export interface AndroidGlassCapability {
  renderer: AndroidGlassRenderer;
  targetState: AndroidBackdropTargetState;
}

export function getAndroidLiquidGlassSurfaceParameters({
  mode,
  interactive,
  disabled = false,
}: {
  mode: 'light' | 'dark';
  interactive: boolean;
  disabled?: boolean;
}) {
  return {
    dark: mode === 'dark',
    interactive: interactive && !disabled,
  };
}

export function resolveAndroidGlassCapability({
  apiLevel,
  effectsEnabled = true,
  nativeRendererAvailable = true,
  platform = Platform.OS,
  rendererFailed = false,
}: AndroidGlassCapabilityInput): AndroidGlassCapability {
  if (platform !== 'android' || !effectsEnabled || !apiLevel || apiLevel < 33) {
    return { renderer: 'dense', targetState: 'detached' };
  }
  if (apiLevel >= 33 && nativeRendererAvailable && !rendererFailed) {
    return { renderer: 'android-liquid-glass', targetState: 'pending' };
  }
  return { renderer: 'dense', targetState: 'detached' };
}

export function withAndroidBackdropTargetState(
  capability: AndroidGlassCapability,
  targetState: AndroidBackdropTargetState,
): AndroidGlassCapability {
  if (targetState !== 'ready') {
    return { renderer: targetState === 'pending' ? capability.renderer : 'dense', targetState };
  }
  return { ...capability, targetState };
}
