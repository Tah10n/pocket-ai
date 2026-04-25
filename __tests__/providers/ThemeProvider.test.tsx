import React from 'react';
import * as ReactNative from 'react-native';
import { Pressable, Text } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { ThemeProvider, useTheme } from '../../src/providers/ThemeProvider';
import { getSettings, subscribeSettings, updateSettings } from '../../src/services/SettingsStore';

const mockSetColorScheme = jest.fn();
let settingsListener: ((settings: any) => void) | null = null;

jest.mock('nativewind', () => ({
  useColorScheme: () => ({
    setColorScheme: mockSetColorScheme,
  }),
}));

jest.mock('../../src/services/SettingsStore', () => ({
  getSettings: jest.fn(),
  subscribeSettings: jest.fn(),
  updateSettings: jest.fn(),
}));

function ThemeProbe() {
  const { mode, themeId, resolvedMode, colors, appearance, navigationTheme, setTheme, setThemeId } = useTheme();

  return (
    <>
      <Text testID="theme-mode">{mode}</Text>
      <Text testID="theme-id">{themeId}</Text>
      <Text testID="resolved-mode">{resolvedMode}</Text>
      <Text testID="primary-color">{colors.primary}</Text>
      <Text testID="card-surface">{colors.cardBackground}</Text>
      <Text testID="surface-kind">{appearance.surfaceKind}</Text>
      <Text testID="navigation-card">{navigationTheme.colors.card}</Text>
      <Pressable testID="set-system" onPress={() => setTheme('system')}>
        <Text>System</Text>
      </Pressable>
      <Pressable testID="set-glass" onPress={() => setThemeId('glass')}>
        <Text>Glass</Text>
      </Pressable>
    </>
  );
}

const mockGetSettings = getSettings as jest.MockedFunction<typeof getSettings>;
const mockSubscribeSettings = subscribeSettings as jest.MockedFunction<typeof subscribeSettings>;
const mockUpdateSettings = updateSettings as jest.MockedFunction<typeof updateSettings>;

describe('ThemeProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSetColorScheme.mockReset();
    settingsListener = null;
    mockSubscribeSettings.mockImplementation((listener: any) => {
      settingsListener = listener;
      return jest.fn();
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keeps system theme as a persisted mode while resolving from the device theme', () => {
    mockGetSettings.mockReturnValue({
      theme: 'system',
      themeId: 'default',
    } as any);
    jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue('dark');

    const { getByTestId } = render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );

    expect(getByTestId('theme-mode').props.children).toBe('system');
    expect(getByTestId('theme-id').props.children).toBe('default');
    expect(getByTestId('resolved-mode').props.children).toBe('dark');
    expect(getByTestId('primary-color').props.children).toBe('#1f7aff');
    expect(getByTestId('navigation-card').props.children).toBe('rgba(21, 33, 52, 0.94)');
    expect(mockSetColorScheme).toHaveBeenCalledWith('system');
    expect(mockUpdateSettings).not.toHaveBeenCalled();
  });

  it('allows switching back to system mode from an explicit theme', () => {
    mockGetSettings.mockReturnValue({
      theme: 'light',
      themeId: 'default',
    } as any);
    jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue('dark');

    const { getByTestId } = render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );

    fireEvent.press(getByTestId('set-system'));

    expect(mockUpdateSettings).toHaveBeenCalledWith({ theme: 'system' });
  });

  it('reacts to settings updates that happen outside the provider', () => {
    mockGetSettings.mockReturnValue({
      theme: 'dark',
      themeId: 'default',
    } as any);
    jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue('light');

    const { getByTestId } = render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );

    act(() => {
      settingsListener?.({
        theme: 'system',
        themeId: 'glass',
      });
    });

    expect(getByTestId('theme-mode').props.children).toBe('system');
    expect(getByTestId('theme-id').props.children).toBe('glass');
    expect(getByTestId('resolved-mode').props.children).toBe('light');
    expect(getByTestId('surface-kind').props.children).toBe('glass');
    expect(getByTestId('card-surface').props.children).toBe('rgba(255, 255, 255, 0.42)');
  });

  it('persists visual theme id separately from color mode', () => {
    mockGetSettings.mockReturnValue({
      theme: 'dark',
      themeId: 'default',
    } as any);
    jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue('light');

    const { getByTestId } = render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );

    fireEvent.press(getByTestId('set-glass'));

    expect(mockUpdateSettings).toHaveBeenCalledWith({ themeId: 'glass' });
    expect(getByTestId('theme-id').props.children).toBe('glass');
    expect(getByTestId('surface-kind').props.children).toBe('glass');
  });
});
