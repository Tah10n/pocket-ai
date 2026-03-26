import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { LegalScreen } from '../../src/ui/screens/LegalScreen';

const mockBack = jest.fn();
const mockReplace = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({
    back: mockBack,
    replace: mockReplace,
    canGoBack: () => true,
  }),
}));

jest.mock('../../src/providers/ThemeProvider', () => ({
  useTheme: () => ({
    resolvedMode: 'light',
    colors: {
      background: '#f6f6f8',
      surface: '#ffffff',
      text: '#0f172a',
      textSecondary: '#64748b',
      primary: '#3211d4',
      border: '#e2e8f0',
      error: '#ef4444',
      warning: '#f59e0b',
      success: '#10b981',
      inputBackground: '#ffffff',
    },
  }),
}));

jest.mock('../../src/components/ui/MaterialSymbols', () => {
  const mockReact = require('react');
  const { Text } = require('react-native');

  return {
    MaterialSymbols: ({ name }: any) => mockReact.createElement(Text, null, name),
  };
});

describe('LegalScreen', () => {
  beforeEach(() => {
    mockBack.mockReset();
    mockReplace.mockReset();
  });

  it('renders all disclosure sections', () => {
    const { getByText, getByTestId } = render(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, left: 0, right: 0, bottom: 0 },
        }}
      >
        <LegalScreen />
      </SafeAreaProvider>,
    );

    expect(getByText('legal.title')).toBeTruthy();
    expect(getByText('legal.introTitle')).toBeTruthy();
    expect(getByTestId('legal-section-on-device')).toBeTruthy();
    expect(getByTestId('legal-section-network')).toBeTruthy();
    expect(getByTestId('legal-section-storage')).toBeTruthy();
    expect(getByTestId('legal-section-downloads')).toBeTruthy();
    expect(getByTestId('legal-section-resources')).toBeTruthy();
    expect(getByTestId('legal-section-controls')).toBeTruthy();
  });

  it('navigates back when the header button is pressed', () => {
    const { getByTestId } = render(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, left: 0, right: 0, bottom: 0 },
        }}
      >
        <LegalScreen />
      </SafeAreaProvider>,
    );

    fireEvent.press(getByTestId('legal-back-button'));

    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
