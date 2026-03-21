import React from 'react';
import * as ReactNative from 'react-native';
import { Pressable, Text } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { ThemeProvider, useTheme } from '../../src/providers/ThemeProvider';
import { getSettings, updateSettings } from '../../src/services/SettingsStore';

const mockSetColorScheme = jest.fn();

jest.mock('nativewind', () => ({
  useColorScheme: () => ({
    setColorScheme: mockSetColorScheme,
  }),
}));

jest.mock('../../src/services/SettingsStore', () => ({
  getSettings: jest.fn(),
  updateSettings: jest.fn(),
}));

function ThemeProbe() {
  const { mode, resolvedMode, setTheme } = useTheme();

  return (
    <>
      <Text testID="theme-mode">{mode}</Text>
      <Text testID="resolved-mode">{resolvedMode}</Text>
      <Pressable testID="set-system" onPress={() => setTheme('system')}>
        <Text>System</Text>
      </Pressable>
    </>
  );
}

const mockGetSettings = getSettings as jest.MockedFunction<typeof getSettings>;
const mockUpdateSettings = updateSettings as jest.MockedFunction<typeof updateSettings>;

describe('ThemeProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSetColorScheme.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keeps system theme as a persisted mode while resolving from the device theme', () => {
    mockGetSettings.mockReturnValue({
      theme: 'system',
    } as any);
    jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue('dark');

    const { getByTestId } = render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );

    expect(getByTestId('theme-mode').props.children).toBe('system');
    expect(getByTestId('resolved-mode').props.children).toBe('dark');
    expect(mockSetColorScheme).toHaveBeenCalledWith('system');
    expect(mockUpdateSettings).not.toHaveBeenCalled();
  });

  it('allows switching back to system mode from an explicit theme', () => {
    mockGetSettings.mockReturnValue({
      theme: 'light',
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
});
