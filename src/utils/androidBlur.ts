import React, { type RefObject } from 'react';
import type { BlurTint } from 'expo-blur';
import { Platform } from 'react-native';
import type { View } from 'react-native';
import type { ThemeAppearance } from './themeTokens';

export type AndroidBlurTargetRef = RefObject<View | null>;

interface AndroidBlurTargetRegistration {
  target: AndroidBlurTargetRef | null;
}

let activeAndroidBlurTarget: AndroidBlurTargetRef | null = null;
const activeAndroidBlurTargetStack: AndroidBlurTargetRegistration[] = [];
const activeAndroidBlurTargetListeners = new Set<() => void>();

function emitActiveAndroidBlurTargetChange() {
  activeAndroidBlurTargetListeners.forEach((listener) => listener());
}

function syncActiveAndroidBlurTarget() {
  const nextRegistration = activeAndroidBlurTargetStack[activeAndroidBlurTargetStack.length - 1];
  const nextTarget = nextRegistration?.target ?? null;

  if (activeAndroidBlurTarget === nextTarget) {
    return;
  }

  activeAndroidBlurTarget = nextTarget;
  emitActiveAndroidBlurTargetChange();
}

function subscribeActiveAndroidBlurTarget(listener: () => void) {
  activeAndroidBlurTargetListeners.add(listener);

  return () => {
    activeAndroidBlurTargetListeners.delete(listener);
  };
}

function getActiveAndroidBlurTargetSnapshot() {
  return activeAndroidBlurTarget;
}

export function setActiveAndroidBlurTarget(target: AndroidBlurTargetRef | null) {
  const registration: AndroidBlurTargetRegistration = { target };
  activeAndroidBlurTargetStack.push(registration);
  syncActiveAndroidBlurTarget();

  return () => {
    const registrationIndex = activeAndroidBlurTargetStack.indexOf(registration);

    if (registrationIndex !== -1) {
      activeAndroidBlurTargetStack.splice(registrationIndex, 1);
      syncActiveAndroidBlurTarget();
    }
  };
}

export function useActiveAndroidBlurTarget() {
  return React.useSyncExternalStore(
    subscribeActiveAndroidBlurTarget,
    getActiveAndroidBlurTargetSnapshot,
    getActiveAndroidBlurTargetSnapshot,
  );
}

export function getAndroidSdkVersion() {
  if (Platform.OS !== 'android') {
    return undefined;
  }

  const version = Platform.Version;
  const parsedVersion = typeof version === 'string'
    ? Number.parseInt(version, 10)
    : version;

  return Number.isFinite(parsedVersion) ? parsedVersion : undefined;
}

export function isAndroidBlurFallbackRequired() {
  const sdkVersion = getAndroidSdkVersion();

  return Platform.OS === 'android' && (sdkVersion === undefined || sdkVersion < 31 || !isAndroidNativeGlassBlurEnabled());
}

export function isAndroidNativeGlassBlurEnabled() {
  // Central kill switch for Android's target-based native blur path.
  return true;
}

export function getGlassBlurTint(tint: BlurTint): BlurTint {
  if (Platform.OS !== 'android') {
    return tint;
  }

  return tint === 'dark' || tint === 'systemUltraThinMaterialDark'
    ? 'dark'
    : 'default';
}

export function getAndroidBlurProps(
  appearance: ThemeAppearance,
  blurTarget?: AndroidBlurTargetRef | null,
) {
  if (Platform.OS !== 'android' || appearance.surfaceKind !== 'glass' || isAndroidBlurFallbackRequired() || !blurTarget) {
    return {};
  }

  return {
    blurMethod: 'dimezisBlurViewSdk31Plus' as const,
    blurReductionFactor: appearance.effects.blurReductionFactor,
    blurTarget,
  };
}
