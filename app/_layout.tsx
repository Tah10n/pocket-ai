import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import 'react-native-reanimated';

import { ThemeProvider as CustomThemeProvider, useTheme } from '../src/providers/ThemeProvider';
import { hardwareListenerService } from '../src/services/HardwareListenerService';
import { bootstrapApp } from '../src/services/AppBootstrap';
import '../src/i18n';
import '../global.css';

function patchExpoKeepAwake() {
  if (!__DEV__) return;

  const globalAny = globalThis as unknown as { __pocketAiExpoKeepAwakePatched?: boolean };
  if (globalAny.__pocketAiExpoKeepAwakePatched) return;
  globalAny.__pocketAiExpoKeepAwakePatched = true;

  try {
    const expoKeepAwake = requireOptionalNativeModule<any>('ExpoKeepAwake');
    if (!expoKeepAwake) return;

    const wrap = (method: 'activate' | 'deactivate') => {
      const original = expoKeepAwake?.[method];
      if (typeof original !== 'function') return;

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

    wrap('activate');
    wrap('deactivate');
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

patchExpoKeepAwake();
patchCssInteropUpgradeWarningCrash();

// Prevent the splash screen from auto-hiding before we are ready.
SplashScreen.preventAutoHideAsync().catch((e) => console.warn('[SplashScreen] preventAutoHideAsync failed', e));

export const unstable_settings = {
  anchor: '(tabs)',
};

export default function RootLayout() {
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    hardwareListenerService.start();
    return () => hardwareListenerService.stop();
  }, []);

  useEffect(() => {
    async function prepare() {
      try {
        await bootstrapApp();
      } catch (e) {
        console.warn('[RootLayout] Error during preparation:', e);
      } finally {
        setIsReady(true);
        await SplashScreen.hideAsync().catch((e) => console.warn('[SplashScreen] hideAsync failed', e));
      }
    }

    prepare().catch((e) => console.warn('[RootLayout] prepare failed', e));
  }, []);

  if (!isReady) {
    return null;
  }

  return (
    <CustomThemeProvider>
      <RootNavigator />
    </CustomThemeProvider>
  );
}

function RootNavigator() {
  const { resolvedMode } = useTheme();

  return (
    <ThemeProvider value={resolvedMode === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="conversations" options={{ headerShown: false }} />
        <Stack.Screen name="presets" options={{ headerShown: false }} />
        <Stack.Screen name="storage" options={{ headerShown: false }} />
        <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
      </Stack>
      <StatusBar style="auto" />
    </ThemeProvider>
  );
}
