import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import 'react-native-reanimated';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { ThemeProvider as CustomThemeProvider } from '../src/providers/ThemeProvider';
import '../src/i18n';

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

patchExpoKeepAwake();

// Prevent the splash screen from auto-hiding before we are ready.
SplashScreen.preventAutoHideAsync().catch((e) => console.warn('[SplashScreen] preventAutoHideAsync failed', e));

export const unstable_settings = {
  anchor: '(tabs)',
};

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    async function prepare() {
      try {
        // Any async initialization can go here
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
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <Stack>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
        </Stack>
        <StatusBar style="auto" />
      </ThemeProvider>
    </CustomThemeProvider>
  );
}
