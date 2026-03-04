import { presetManager } from '../../src/services/PresetManager';
import { getSettings, updateSettings } from '../../src/services/SettingsStore';

jest.mock('react-native-mmkv', () => {
    const store: Record<string, string> = {};
    return {
        MMKV: jest.fn().mockImplementation(() => ({
            getString: jest.fn((key: string) => store[key]),
            set: jest.fn((key: string, value: string) => { store[key] = value; }),
            delete: jest.fn((key: string) => { delete store[key]; }),
        })),
    };
});

describe('PresetManager', () => {
    it('returns default presets on first access', () => {
        const presets = presetManager.getPresets();
        expect(presets.length).toBeGreaterThanOrEqual(4);
        expect(presets.some(p => p.name === 'Helpful Assistant')).toBe(true);
        expect(presets.some(p => p.name === 'Code Expert')).toBe(true);
    });

    it('adds a custom preset', () => {
        const preset = presetManager.addPreset('My Preset', 'You are a joker.');
        expect(preset.isBuiltIn).toBe(false);
        const all = presetManager.getPresets();
        expect(all.some(p => p.id === preset.id)).toBe(true);
    });

    it('prevents deleting built-in presets', () => {
        const builtIn = presetManager.getPresets().find(p => p.isBuiltIn);
        expect(() => presetManager.deletePreset(builtIn!.id)).toThrow('Cannot delete built-in presets');
    });
});

describe('SettingsStore', () => {
    it('returns default settings when no settings exist', () => {
        const settings = getSettings();
        expect(settings.temperature).toBe(0.7);
        expect(settings.topP).toBe(0.9);
        expect(settings.maxTokens).toBe(2048);
    });

    it('updates settings partially', () => {
        const updated = updateSettings({ temperature: 1.0 });
        expect(updated.temperature).toBe(1.0);
        expect(updated.topP).toBe(0.9); // unchanged
    });
});
