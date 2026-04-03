import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
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

