/**
 * Helpers to reset global Jest mocks that carry state between tests.
 */

export function resetI18nMock(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const i18n = require('react-i18next') as { __resetTranslations?: () => void };
    i18n.__resetTranslations?.();
  } catch {
    // ignore
  }
}

export function resetSecureStoreMock(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const secureStore = require('expo-secure-store') as { __resetMock?: () => void };
    secureStore.__resetMock?.();
  } catch {
    // ignore
  }
}

export function resetAccessibilityInfoMock(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const AccessibilityInfo = require('react-native/Libraries/Components/AccessibilityInfo/AccessibilityInfo') as {
      __resetAccessibilityState?: () => void;
    };
    AccessibilityInfo.__resetAccessibilityState?.();
  } catch {
    // ignore
  }
}

export function resetNativewindColorScheme(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nativewind = require('nativewind') as { __setColorScheme?: (next: string) => void };
    nativewind.__setColorScheme?.('light');
  } catch {
    // ignore
  }
}

export function resetGlobalTestState(): void {
  resetI18nMock();
  resetSecureStoreMock();
  resetAccessibilityInfoMock();
  resetNativewindColorScheme();
}
