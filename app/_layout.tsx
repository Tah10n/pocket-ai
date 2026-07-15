import { ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import * as SystemUI from 'expo-system-ui';
import { Alert, Platform, useColorScheme as useSystemColorScheme } from 'react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import 'react-native-reanimated';
import { useTranslation } from 'react-i18next';

import {
  StaticThemeProvider as StaticAppThemeProvider,
  ThemeProvider as CustomThemeProvider,
  useTheme,
} from '../src/providers/ThemeProvider';
import { useMotionPreferences } from '../src/hooks/useDeviceMetrics';
import { usePerformanceNavigationTrace } from '../src/hooks/usePerformanceNavigationTrace';
import { hardwareListenerService } from '../src/services/HardwareListenerService';
import {
  bootstrapAppBackground,
  bootstrapAppCritical,
  scheduleModelCatalogCacheHydrationAfterFirstFrame,
} from '../src/services/AppBootstrap';
import { performanceMonitor } from '../src/services/PerformanceMonitor';
import {
  getPrivateStorageHealthSnapshot,
  getStorageFallbackReport,
  retryPrivateStorageInitialization,
  type PrivateStorageHealthSnapshot,
} from '../src/services/storage';
import { resetPrivateAppStorageAndRuntimeStateAfterConfirmation } from '../src/services/PrivateStorageRecovery';
import { notificationService } from '../src/services/NotificationService';
import { useBootstrapStore, type BootstrapCriticalOutcome } from '../src/store/bootstrapStore';
import { StorageRecoveryScreen, type StorageRecoveryBusyState } from '../src/ui/screens/StorageRecoveryScreen';
import { createNavigationTheme, getThemeColors, type ResolvedThemeMode } from '../src/utils/themeTokens';
import '../src/i18n';
import '../global.css';

performanceMonitor.mark('startup.jsBundleLoaded');

let hasMarkedFirstRootRender = false;

function patchExpoKeepAwake() {
  if (!__DEV__) return;

  const globalAny = globalThis as unknown as { __pocketAiExpoKeepAwakePatched?: boolean };
  if (globalAny.__pocketAiExpoKeepAwakePatched) return;
  globalAny.__pocketAiExpoKeepAwakePatched = true;

  try {
    // expo-doctor discourages depending on expo-modules-core directly.
    // Patch the public JS API instead.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const expoKeepAwake = require('expo-keep-awake') as {
      activateKeepAwake?: (...args: any[]) => Promise<void> | void;
      deactivateKeepAwake?: (...args: any[]) => Promise<void> | void;
    };

    const wrap = (method: 'activateKeepAwake' | 'deactivateKeepAwake') => {
      const original = expoKeepAwake?.[method];
      if (typeof original !== 'function') {
        return;
      }

      expoKeepAwake[method] = async (...args: any[]) => {
        try {
          return await original.apply(expoKeepAwake, args);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          if (/current activity.*no longer available/i.test(message)) {
            return;
          }
          throw e;
        }
      };
    };

    wrap('activateKeepAwake');
    wrap('deactivateKeepAwake');
  } catch (e) {
    console.warn('[RootLayout] Failed to patch ExpoKeepAwake', e);
  }
}

function patchCssInteropUpgradeWarningCrash() {
  if (!__DEV__) return;

  const globalAny = globalThis as unknown as { __pocketAiCssInteropPatched?: boolean };
  if (globalAny.__pocketAiCssInteropPatched) return;
  globalAny.__pocketAiCssInteropPatched = true;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const renderComponentModule = require('react-native-css-interop/dist/runtime/native/render-component') as {
      renderComponent?: (...args: any[]) => any;
    };

    if (typeof renderComponentModule.renderComponent !== 'function') return;

    const originalRenderComponent = renderComponentModule.renderComponent;
    renderComponentModule.renderComponent = (...args: any[]) => {
      try {
        return originalRenderComponent(...args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const sharedState = args[1] as { canUpgradeWarn?: boolean } | undefined;

        // react-native-css-interop can crash while stringifying React Navigation
        // proxy props for a dev-only upgrade warning. Retry once without warning.
        if (
          sharedState?.canUpgradeWarn &&
          /Couldn't find a navigation context/i.test(message)
        ) {
          sharedState.canUpgradeWarn = false;
          return originalRenderComponent(...args);
        }

        throw error;
      }
    };
  } catch (error) {
    console.warn('[RootLayout] Failed to patch react-native-css-interop warning crash', error);
  }
}

function patchDeprecatedReactNativeSafeAreaView() {
  if (!__DEV__) return;

  const globalAny = globalThis as unknown as { __pocketAiSafeAreaViewPatched?: boolean };
  if (globalAny.__pocketAiSafeAreaViewPatched) return;
  globalAny.__pocketAiSafeAreaViewPatched = true;

  try {
    // Some upstream dev-time views still access react-native's deprecated
    // SafeAreaView export. Redirect them to react-native-safe-area-context.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const reactNative = require('react-native') as Record<string, unknown>;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const safeAreaContext = require('react-native-safe-area-context') as {
      SafeAreaView?: unknown;
    };

    const descriptor = Object.getOwnPropertyDescriptor(reactNative, 'SafeAreaView');
    if (!descriptor?.get || !descriptor.configurable) return;

    const replacement = safeAreaContext.SafeAreaView;
    if (!replacement) return;

    Object.defineProperty(reactNative, 'SafeAreaView', {
      configurable: true,
      enumerable: descriptor.enumerable ?? true,
      get() {
        return replacement;
      },
    });
  } catch (error) {
    console.warn('[RootLayout] Failed to patch deprecated SafeAreaView access', error);
  }
}

patchExpoKeepAwake();
patchCssInteropUpgradeWarningCrash();
patchDeprecatedReactNativeSafeAreaView();

// Prevent the splash screen from auto-hiding before we are ready.
SplashScreen.preventAutoHideAsync().catch((e) => console.warn('[SplashScreen] preventAutoHideAsync failed', e));

export const unstable_settings = {
  anchor: '(tabs)',
};

type RootCriticalBootstrapResult = {
  outcome: BootstrapCriticalOutcome;
  storageHealth: PrivateStorageHealthSnapshot | null;
  errorMessage: string | null;
};

async function runCriticalBootstrapFromRoot(): Promise<RootCriticalBootstrapResult> {
  let criticalOutcome: BootstrapCriticalOutcome = 'success';
  let criticalStorageHealth: PrivateStorageHealthSnapshot | null = null;
  let criticalErrorMessage: string | null = null;

  try {
    const result = await bootstrapAppCritical();
    criticalOutcome = result.outcome;
    criticalStorageHealth = result.outcome === 'storage_blocked' ? result.storageHealth : null;
  } catch (e) {
    criticalOutcome = 'error';
    criticalErrorMessage = e instanceof Error ? e.message : String(e);
    console.warn('[RootLayout] Error during preparation:', e);
  }

  useBootstrapStore.getState().setCriticalOutcome(criticalOutcome, criticalStorageHealth);

  return {
    outcome: criticalOutcome,
    storageHealth: criticalStorageHealth,
    errorMessage: criticalErrorMessage,
  };
}

function startBackgroundBootstrapFromRoot(): void {
  useBootstrapStore.getState().setBackgroundState('running');
  useBootstrapStore.getState().setBackgroundError(null);

  void bootstrapAppBackground()
    .then((backgroundResult) => {
      if (backgroundResult.outcome === 'storage_blocked') {
        useBootstrapStore.getState().setCriticalOutcome('storage_blocked', backgroundResult.storageHealth);
        useBootstrapStore.getState().setBackgroundState('blocked');
        return;
      }

      useBootstrapStore.getState().setBackgroundState('done');
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      useBootstrapStore.getState().setBackgroundError(message);
      useBootstrapStore.getState().setBackgroundState('error');
    });
}

export default function RootLayout() {
  const [isReady, setIsReady] = useState(false);
  const criticalOutcome = useBootstrapStore((state) => state.criticalOutcome);

  if (!hasMarkedFirstRootRender) {
    hasMarkedFirstRootRender = true;
    performanceMonitor.mark('startup.firstRootRender');
  }

  useEffect(() => {
    hardwareListenerService.start();
    return () => hardwareListenerService.stop();
  }, []);

  useEffect(() => {
    if (!isReady || criticalOutcome === 'storage_blocked') {
      return;
    }

    scheduleModelCatalogCacheHydrationAfterFirstFrame();
  }, [criticalOutcome, isReady]);

  useEffect(() => {
    async function prepare() {
      const span = performanceMonitor.startSpan('root.prepare');
      performanceMonitor.mark('root.prepare.start');
      let criticalResult: RootCriticalBootstrapResult = {
        outcome: 'success',
        storageHealth: null,
        errorMessage: null,
      };
      try {
        criticalResult = await runCriticalBootstrapFromRoot();
      } finally {
        setIsReady(true);
        performanceMonitor.mark('root.ready');
        await SplashScreen.hideAsync().catch((e) => console.warn('[SplashScreen] hideAsync failed', e));
        performanceMonitor.mark('root.splashHidden');
        span.end({
          outcome: criticalResult.outcome,
          error: criticalResult.errorMessage ?? undefined,
        });
      }

      if (criticalResult.outcome !== 'storage_blocked') {
        startBackgroundBootstrapFromRoot();
      }
    }

    prepare().catch((e) => console.warn('[RootLayout] prepare failed', e));
  }, []);

  if (!isReady) {
    return null;
  }

  if (criticalOutcome === 'storage_blocked') {
    return <StorageBlockedRootNavigator />;
  }

  return (
    <CustomThemeProvider>
      <RootNavigator />
    </CustomThemeProvider>
  );
}

function useStorageRecoveryActions() {
  const [recoveryBusy, setRecoveryBusy] = useState<StorageRecoveryBusyState>(false);

  const runStorageRecovery = useCallback(async (action: Exclude<StorageRecoveryBusyState, boolean>) => {
    setRecoveryBusy(action);

    try {
      const recoveryHealth = action === 'reset'
        ? await resetPrivateAppStorageAndRuntimeStateAfterConfirmation()
        : await retryPrivateStorageInitialization();

      if (recoveryHealth.status === 'blocked') {
        useBootstrapStore.getState().setCriticalOutcome('storage_blocked', recoveryHealth);
        return;
      }

      const criticalResult = await runCriticalBootstrapFromRoot();
      if (criticalResult.outcome !== 'storage_blocked') {
        startBackgroundBootstrapFromRoot();
      }
    } catch (error) {
      console.warn(`[RootNavigator] Failed to ${action} private storage`, error);
      useBootstrapStore.getState().setCriticalOutcome('storage_blocked', getPrivateStorageHealthSnapshot());
    } finally {
      setRecoveryBusy(false);
    }
  }, []);

  return {
    recoveryBusy,
    handleStorageRetry: useCallback(() => runStorageRecovery('retry'), [runStorageRecovery]),
    handleStorageReset: useCallback(() => runStorageRecovery('reset'), [runStorageRecovery]),
  };
}

function StorageBlockedRootNavigator() {
  const systemScheme = useSystemColorScheme();
  const resolvedMode: ResolvedThemeMode = systemScheme === 'dark' ? 'dark' : 'light';
  const colors = useMemo(() => getThemeColors(resolvedMode), [resolvedMode]);
  const navigationTheme = useMemo(() => createNavigationTheme(resolvedMode), [resolvedMode]);
  const criticalStorageHealth = useBootstrapStore((state) => state.criticalStorageHealth);
  const { recoveryBusy, handleStorageReset, handleStorageRetry } = useStorageRecoveryActions();

  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(colors.background).catch((error) => {
      if (__DEV__) {
        console.warn('[StorageBlockedRootNavigator] Failed to set root background color', error);
      }
    });
  }, [colors.background]);

  return (
    <StaticAppThemeProvider resolvedMode={resolvedMode}>
      <ThemeProvider value={navigationTheme}>
        <StorageRecoveryScreen
          health={criticalStorageHealth ?? getPrivateStorageHealthSnapshot()}
          busy={recoveryBusy}
          onRetry={handleStorageRetry}
          onReset={handleStorageReset}
        />
        <StatusBar style={colors.statusBarStyle} />
      </ThemeProvider>
    </StaticAppThemeProvider>
  );
}

function RootNavigator() {
  const { colors, navigationTheme } = useTheme();
  const { t } = useTranslation();
  const motion = useMotionPreferences();
  const criticalOutcome = useBootstrapStore((state) => state.criticalOutcome);
  const criticalStorageHealth = useBootstrapStore((state) => state.criticalStorageHealth);
  const { recoveryBusy, handleStorageReset, handleStorageRetry } = useStorageRecoveryActions();

  usePerformanceNavigationTrace();

  useEffect(() => {
    if (criticalOutcome === 'storage_blocked') {
      return;
    }

    if (Platform.OS === 'web') {
      return;
    }

    void notificationService.initialize();
  }, [criticalOutcome]);

  useEffect(() => {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      return;
    }

    if (Platform.OS === 'web') {
      return;
    }

    if (criticalOutcome === 'storage_blocked') {
      return;
    }

    const fallbackReport = getStorageFallbackReport();
    if (!fallbackReport) {
      return;
    }

    const globalAny = globalThis as unknown as { __pocketAiStorageFallbackAlertShown?: boolean };
    if (globalAny.__pocketAiStorageFallbackAlertShown) {
      return;
    }
    globalAny.__pocketAiStorageFallbackAlertShown = true;

    console.error('[Storage] Persistent storage is unavailable; using in-memory fallback.', fallbackReport);
    Alert.alert(t('common.storageDegradedTitle'), t('common.storageDegradedMessage'));
  }, [criticalOutcome, t]);

  useEffect(() => {
    // Keep native root view background in sync with the app theme.
    // Prevents light flashes/stripes during native navigation transitions in dark mode.
    void SystemUI.setBackgroundColorAsync(colors.background).catch((error) => {
      if (__DEV__) {
        console.warn('[RootNavigator] Failed to set root background color', error);
      }
    });
  }, [colors.background]);

  if (criticalOutcome === 'storage_blocked') {
    return (
      <ThemeProvider value={navigationTheme}>
        <StorageRecoveryScreen
          health={criticalStorageHealth ?? getPrivateStorageHealthSnapshot()}
          busy={recoveryBusy}
          onRetry={handleStorageRetry}
          onReset={handleStorageReset}
        />
        <StatusBar style={colors.statusBarStyle} />
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider value={navigationTheme}>
      <Stack
        screenOptions={{
          animation: motion.motionPreset === 'full' ? 'default' : 'none',
          contentStyle: {
            backgroundColor: colors.background,
          },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="conversations" options={{ headerShown: false }} />
        <Stack.Screen name="presets" options={{ headerShown: false }} />
        <Stack.Screen name="storage" options={{ headerShown: false }} />
        <Stack.Screen name="legal" options={{ headerShown: false }} />
        <Stack.Screen name="huggingface-token" options={{ headerShown: false }} />
        <Stack.Screen name="model-details" options={{ headerShown: false }} />
        <Stack.Screen name="performance" options={{ headerShown: false }} />
        <Stack.Screen
          name="modal"
          options={{
            presentation: 'modal',
            title: t('common.more'),
            animation: motion.motionPreset === 'full' ? 'fade' : 'none',
          }}
        />
      </Stack>
      <StatusBar style={colors.statusBarStyle} />
    </ThemeProvider>
  );
}
