import React from 'react';
import { render, type RenderOptions } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

export type SafeAreaMetrics = {
  frame: { x: number; y: number; width: number; height: number };
  insets: { top: number; left: number; right: number; bottom: number };
};

const defaultMetrics: SafeAreaMetrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

export function renderWithSafeArea(
  ui: React.ReactElement,
  options?: RenderOptions & { metrics?: SafeAreaMetrics },
) {
  const { metrics, ...renderOptions } = options ?? {};
  return render(
    <SafeAreaProvider initialMetrics={metrics ?? defaultMetrics as any}>
      {ui}
    </SafeAreaProvider>,
    renderOptions,
  );
}
