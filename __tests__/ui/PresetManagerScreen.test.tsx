import React from 'react';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import { DeviceEventEmitter, KeyboardAvoidingView, Platform, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { PresetManagerScreen } from '../../src/ui/screens/PresetManagerScreen';
import { presetManager } from '../../src/services/PresetManager';
import { getSettings, updateSettings } from '../../src/services/SettingsStore';

const mockBack = jest.fn();
const mockReplace = jest.fn();
let mockCanGoBack = true;

jest.mock('expo-router', () => ({
  useRouter: () => ({
    back: mockBack,
    replace: mockReplace,
    canGoBack: () => mockCanGoBack,
  }),
}));

jest.mock('@shopify/flash-list', () => {
  const mockReact = require('react');
  const { View } = require('react-native');

  return {
    FlashList: ({ data, renderItem, keyExtractor }: any) =>
      mockReact.createElement(
        View,
        null,
        (data ?? []).map((item: any, index: number) =>
          mockReact.createElement(
            mockReact.Fragment,
            { key: keyExtractor ? keyExtractor(item, index) : index },
            renderItem({ item, index }),
          ),
        ),
      ),
  };
});

jest.mock('../../src/services/PresetManager', () => ({
  presetManager: {
    getPresets: jest.fn(),
    addPreset: jest.fn(),
    updatePreset: jest.fn(),
    deletePreset: jest.fn(),
  },
}));

jest.mock('../../src/services/SettingsStore', () => ({
  getSettings: jest.fn(),
  subscribeSettings: jest.fn(() => jest.fn()),
  updateSettings: jest.fn(),
}));

jest.mock('../../src/components/ui/MaterialSymbols', () => {
  const mockReact = require('react');
  const { Text } = require('react-native');

  return {
    MaterialSymbols: ({ name }: any) => mockReact.createElement(Text, null, name),
  };
});

const mockPresetManager = presetManager as jest.Mocked<typeof presetManager>;
const mockGetSettings = getSettings as jest.MockedFunction<typeof getSettings>;
const mockUpdateSettings = updateSettings as jest.MockedFunction<typeof updateSettings>;

async function renderScreen() {
  const result = render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <PresetManagerScreen />
    </SafeAreaProvider>,
  );

  await act(async () => {
    await Promise.resolve();
  });

  return result;
}

describe('PresetManagerScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCanGoBack = true;

    mockGetSettings.mockReturnValue({ activePresetId: null } as any);
    mockPresetManager.getPresets.mockReturnValue([
      { id: 'preset-1', name: 'Preset 1', systemPrompt: 'Prompt 1', isBuiltIn: false },
    ] as any);
    mockPresetManager.addPreset.mockReturnValue({
      id: 'preset-new',
      name: 'My Preset',
      systemPrompt: 'Be concise.',
      isBuiltIn: false,
    } as any);
    mockPresetManager.updatePreset.mockImplementation((_id, updates) => ({
      id: 'preset-1',
      name: updates.name,
      systemPrompt: updates.systemPrompt,
      isBuiltIn: false,
    }) as any);
  });

  it('keeps the preset list separated from the header', async () => {
    const screen = await renderScreen();

    expect(StyleSheet.flatten(screen.getByTestId('preset-manager-content').props.style)).toMatchObject({
      paddingTop: 16,
    });
  });

  it('navigates back when possible', async () => {
    const { getByTestId } = await renderScreen();

    fireEvent.press(getByTestId('preset-manager-back-button'));

    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('replaces the route when there is no back stack', async () => {
    mockCanGoBack = false;
    const { getByTestId } = await renderScreen();

    fireEvent.press(getByTestId('preset-manager-back-button'));

    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/settings');
  });

  it('creates and activates a new preset from the editor modal', async () => {
    const { getByTestId } = await renderScreen();

    fireEvent.press(getByTestId('preset-manager-add-preset'));

    fireEvent.changeText(getByTestId('preset-editor-name'), 'My Preset');
    fireEvent.changeText(getByTestId('preset-editor-prompt'), 'Be concise.');

    await act(async () => {
      fireEvent.press(getByTestId('preset-editor-save'));
      await Promise.resolve();
    });

    expect(mockPresetManager.addPreset).toHaveBeenCalledWith('My Preset', 'Be concise.');
    expect(mockUpdateSettings).toHaveBeenCalledWith({ activePresetId: 'preset-new' });
  });

  it('resizes the Android editor form and footer together while the keyboard is open', async () => {
    const platform = jest.replaceProperty(Platform, 'OS', 'android');
    const screen = await renderScreen();
    try {
      fireEvent.press(screen.getByTestId('preset-manager-add-preset'));
      const boundary = screen.UNSAFE_getByType(KeyboardAvoidingView);
      expect(boundary.props.behavior).toBe('height');
      expect(within(boundary).getByTestId('preset-editor-content')).toBeTruthy();
      expect(within(boundary).getByTestId('preset-editor-save')).toBeTruthy();
      expect(within(boundary).getByTestId('preset-editor-cancel')).toBeTruthy();
      expect(screen.getByTestId('preset-editor-scroll').props.keyboardShouldPersistTaps).toBe('handled');
      expect(screen.getByTestId('preset-editor-scroll').props.keyboardDismissMode).toBe('on-drag');

      await act(async () => {
        fireEvent(screen.getByTestId('preset-editor-keyboard-boundary'), 'layout', {
          persist: jest.fn(),
          nativeEvent: { layout: { x: 0, y: 64, width: 390, height: 780 } },
        });
        DeviceEventEmitter.emit('keyboardDidShow', {
          duration: 0,
          endCoordinates: { screenX: 0, screenY: 544, width: 390, height: 300 },
        });
      });
      expect(StyleSheet.flatten(screen.getByTestId('preset-editor-keyboard-boundary').props.style))
        .toMatchObject({ height: 480, flex: 0 });

      await act(async () => {
        fireEvent(screen.getByTestId('preset-editor-keyboard-boundary'), 'layout', {
          persist: jest.fn(),
          nativeEvent: { layout: { x: 0, y: 64, width: 390, height: 480 } },
        });
        DeviceEventEmitter.emit('keyboardDidHide', {
          duration: 0,
          endCoordinates: { screenX: 0, screenY: 844, width: 390, height: 0 },
        });
      });
      expect(StyleSheet.flatten(screen.getByTestId('preset-editor-keyboard-boundary').props.style))
        .toMatchObject({ flex: 1 });
      expect(StyleSheet.flatten(screen.getByTestId('preset-editor-keyboard-boundary').props.style).height)
        .toBeUndefined();
      fireEvent.press(screen.getByTestId('preset-editor-cancel'));
      expect(screen.queryByTestId('preset-editor-save')).toBeNull();
      expect(mockPresetManager.addPreset).not.toHaveBeenCalled();
    } finally {
      screen.unmount();
      platform.restore();
    }
  });

  it('keeps iOS keyboard padding and the footer safe area without a duplicate header inset', async () => {
    const platform = jest.replaceProperty(Platform, 'OS', 'ios');
    const screen = await renderScreen();
    try {
      fireEvent.press(screen.getByTestId('preset-manager-add-preset'));
      expect(screen.UNSAFE_getByType(KeyboardAvoidingView).props.behavior).toBe('padding');
      expect(screen.getByTestId('preset-editor-scroll').props.keyboardDismissMode).toBe('interactive');
      const footer = screen.UNSAFE_getAllByType(require('../../src/components/ui/ScreenShell').ScreenContent)
        .find((node) => node.props.testID === 'preset-editor-footer');
      expect(footer?.props.includeBottomSafeArea).toBe(true);
      expect(footer?.props.respectFloatingHeader).toBe(false);
    } finally {
      screen.unmount();
      platform.restore();
    }
  });

  it('edits presets when selecting an existing card', async () => {
    const { getByTestId } = await renderScreen();

    fireEvent.press(getByTestId('preset-card-preset-1'));

    fireEvent.changeText(getByTestId('preset-editor-name'), 'Preset 1 Updated');
    fireEvent.changeText(getByTestId('preset-editor-prompt'), 'Updated prompt');

    await act(async () => {
      fireEvent.press(getByTestId('preset-editor-save'));
      await Promise.resolve();
    });

    expect(mockPresetManager.updatePreset).toHaveBeenCalledWith('preset-1', {
      name: 'Preset 1 Updated',
      systemPrompt: 'Updated prompt',
    });
  });
});

