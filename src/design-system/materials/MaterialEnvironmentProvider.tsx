import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';
import {
  isGlassEffectAPIAvailable,
  isLiquidGlassAvailable,
} from 'expo-glass-effect';
import type {
  MaterialEnvironment,
  MaterialPlatform,
  TransparencyState,
} from './contract';
import {
  createMaterialEnvironment,
  FAIL_CLOSED_MATERIAL_ENVIRONMENT,
  parseAndroidSdkVersion,
} from './environment';

const MaterialEnvironmentContext = createContext<MaterialEnvironment>(
  FAIL_CLOSED_MATERIAL_ENVIRONMENT,
);

export function MaterialEnvironmentProvider({
  children,
  environment,
}: {
  readonly children: React.ReactNode;
  readonly environment: MaterialEnvironment;
}) {
  return (
    <MaterialEnvironmentContext.Provider value={environment}>
      {children}
    </MaterialEnvironmentContext.Provider>
  );
}

function getRuntimePlatform(): MaterialPlatform {
  if (Platform.OS === 'ios' || Platform.OS === 'android') {
    return Platform.OS;
  }

  return 'web';
}

function safelyCheckAvailability(check: () => boolean): boolean {
  try {
    return check() === true;
  } catch {
    return false;
  }
}

function getRuntimeCapabilities(platform: MaterialPlatform) {
  if (platform === 'android') {
    const androidSdkVersion = parseAndroidSdkVersion(Platform.Version);

    return {
      androidSdkVersion,
      androidTargetBlurSupported: (androidSdkVersion ?? 0) >= 31,
      blurViewAvailable: true,
      liquidGlassApiAvailable: false,
      liquidGlassComponentAvailable: false,
    } as const;
  }

  if (platform !== 'ios') {
    return {
      androidTargetBlurSupported: false,
      blurViewAvailable: false,
      liquidGlassApiAvailable: false,
      liquidGlassComponentAvailable: false,
    } as const;
  }

  // Keep the checks independent: either native capability can be missing on
  // partially supported iOS 26 builds, and both must pass before GlassView mounts.
  const liquidGlassComponentAvailable = safelyCheckAvailability(isLiquidGlassAvailable);
  const liquidGlassApiAvailable = safelyCheckAvailability(isGlassEffectAPIAvailable);

  return {
    androidTargetBlurSupported: false,
    blurViewAvailable: true,
    liquidGlassApiAvailable,
    liquidGlassComponentAvailable,
  } as const;
}

export function RuntimeMaterialEnvironmentProvider({
  children,
}: {
  readonly children: React.ReactNode;
}) {
  const platform = getRuntimePlatform();
  const capabilities = useMemo(
    () => getRuntimeCapabilities(platform),
    [platform],
  );
  const [transparencyState, setTransparencyState] = useState<TransparencyState>(
    platform === 'ios' ? 'unknown' : 'allowed',
  );

  useEffect(() => {
    if (platform !== 'ios') {
      return undefined;
    }

    let isMounted = true;
    let hasReceivedRuntimeEvent = false;
    let subscription: { remove: () => void } | undefined;
    const updateTransparency = (isReduced: boolean) => {
      if (isMounted) {
        setTransparencyState(isReduced ? 'reduced' : 'allowed');
      }
    };
    const handleRuntimeTransparencyChange = (isReduced: boolean) => {
      hasReceivedRuntimeEvent = true;
      updateTransparency(isReduced);
    };

    try {
      subscription = AccessibilityInfo.addEventListener(
        'reduceTransparencyChanged',
        handleRuntimeTransparencyChange,
      );
    } catch {
      // The initial query can still resolve; otherwise the provider stays fail closed.
    }

    try {
      void AccessibilityInfo.isReduceTransparencyEnabled()
        .then((isReduced) => {
          if (!hasReceivedRuntimeEvent) {
            updateTransparency(isReduced);
          }
        })
        .catch(() => undefined);
    } catch {
      // Keep the initial unknown state so effect surfaces fail closed.
    }

    return () => {
      isMounted = false;
      subscription?.remove();
    };
  }, [platform]);

  const environment = useMemo(
    () => createMaterialEnvironment(platform, {
      ...capabilities,
      transparencyState,
    }),
    [capabilities, platform, transparencyState],
  );

  return (
    <MaterialEnvironmentContext.Provider value={environment}>
      {children}
    </MaterialEnvironmentContext.Provider>
  );
}

export function useMaterialEnvironment(): MaterialEnvironment {
  return useContext(MaterialEnvironmentContext);
}
