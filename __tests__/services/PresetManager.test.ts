import { presetManager } from '../../src/services/PresetManager';
import {
    getModelLoadParametersForModel,
    getGenerationParametersForModel,
    getSettings,
    resetAllParametersForModel,
    resetModelLoadParametersForModel,
    resetGenerationParametersForModel,
    updateModelLoadParametersForModel,
    updateGenerationParametersForModel,
    updateSettings,
} from '../../src/services/SettingsStore';

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
        expect(presets.length).toBeGreaterThanOrEqual(10);
        expect(presets.some(p => p.name === 'Helpful Assistant')).toBe(true);
        expect(presets.some(p => p.name === 'Code Expert')).toBe(true);
        expect(presets.some(p => p.name === 'Study Tutor')).toBe(true);
        expect(presets.some(p => p.name === 'Product Manager')).toBe(true);
    });

    it('adds a custom preset', () => {
        const preset = presetManager.addPreset('My Preset', 'You are a joker.');
        expect(preset.isBuiltIn).toBe(false);
        const all = presetManager.getPresets();
        expect(all.some(p => p.id === preset.id)).toBe(true);
    });

    it('allows deleting default seeded presets', () => {
        presetManager.deletePreset('code-expert');
        expect(presetManager.getPreset('code-expert')).toBeUndefined();
    });

    it('allows editing default seeded presets', () => {
        const updated = presetManager.updatePreset('helpful-assistant', {
            name: 'Helpful Assistant Custom',
            systemPrompt: 'You are a customized default preset.',
        });

        expect(updated.isBuiltIn).toBe(false);
        expect(updated.name).toBe('Helpful Assistant Custom');
        expect(updated.systemPrompt).toBe('You are a customized default preset.');
    });

    it('normalizes legacy built-in flags without resurrecting deleted defaults', () => {
        const legacyPreset = {
            id: 'helpful-assistant',
            name: 'Helpful Assistant',
            systemPrompt: 'Legacy preset',
            isBuiltIn: true,
        };

        (presetManager as any).savePresets([legacyPreset]);

        const normalized = presetManager.getPresets();
        expect(normalized).toHaveLength(1);
        expect(normalized[0].isBuiltIn).toBe(false);
        expect(normalized[0].id).toBe('helpful-assistant');
    });
});

describe('SettingsStore', () => {
    it('returns default settings when no settings exist', () => {
        const settings = getSettings();
        expect(settings.temperature).toBe(0.7);
        expect(settings.topP).toBe(0.9);
        expect(settings.maxTokens).toBe(512);
        expect(settings.reasoningEnabled).toBe(false);
    });

    it('updates settings partially', () => {
        const updated = updateSettings({ temperature: 1.0 });
        expect(updated.temperature).toBe(1.0);
        expect(updated.topP).toBe(0.9); // unchanged
    });

    it('stores model generation parameters independently per model', () => {
        updateSettings({ temperature: 0.6, topP: 0.85, maxTokens: 1024, modelParamsByModelId: {} });
        updateGenerationParametersForModel('author/model-a', { temperature: 1.2, maxTokens: 1536 });
        updateGenerationParametersForModel('author/model-b', { topP: 0.4 });

        expect(getGenerationParametersForModel('author/model-a')).toEqual({
            temperature: 1.2,
            topP: 0.85,
            topK: 40,
            minP: 0.05,
            repetitionPenalty: 1,
            maxTokens: 1536,
            reasoningEnabled: false,
        });
        expect(getGenerationParametersForModel('author/model-b')).toEqual({
            temperature: 0.6,
            topP: 0.4,
            topK: 40,
            minP: 0.05,
            repetitionPenalty: 1,
            maxTokens: 1024,
            reasoningEnabled: false,
        });
        expect(getSettings().modelParamsByModelId).toEqual({
            'author/model-a': {
                temperature: 1.2,
                topP: 0.85,
                topK: 40,
                minP: 0.05,
                repetitionPenalty: 1,
                maxTokens: 1536,
                reasoningEnabled: false,
            },
            'author/model-b': {
                temperature: 0.6,
                topP: 0.4,
                topK: 40,
                minP: 0.05,
                repetitionPenalty: 1,
                maxTokens: 1024,
                reasoningEnabled: false,
            },
        });
    });

    it('resets model generation parameters back to the defaults', () => {
        updateSettings({ temperature: 0.7, topP: 0.9, maxTokens: 2048, modelParamsByModelId: {} });
        updateGenerationParametersForModel('author/model-a', {
            temperature: 1.4,
            topP: 0.35,
            maxTokens: 512,
        });

        const reset = resetGenerationParametersForModel('author/model-a');

        expect(reset.temperature).toBe(0.7);
        expect(reset.topP).toBe(0.9);
        expect(reset.maxTokens).toBe(2048);
        expect(getGenerationParametersForModel('author/model-a')).toEqual({
            temperature: 0.7,
            topP: 0.9,
            topK: 40,
            minP: 0.05,
            repetitionPenalty: 1,
            maxTokens: 2048,
            reasoningEnabled: false,
        });
        expect(getSettings().modelParamsByModelId).toEqual({});
    });

    it('stores reasoning preference independently per model', () => {
        updateSettings({ reasoningEnabled: false, maxTokens: 512, modelParamsByModelId: {} });
        updateGenerationParametersForModel('author/model-a', { reasoningEnabled: true });

        expect(getGenerationParametersForModel('author/model-a')).toEqual({
            temperature: 0.7,
            topP: 0.9,
            topK: 40,
            minP: 0.05,
            repetitionPenalty: 1,
            maxTokens: 512,
            reasoningEnabled: true,
        });
        expect(getGenerationParametersForModel('author/model-b')).toEqual({
            temperature: 0.7,
            topP: 0.9,
            topK: 40,
            minP: 0.05,
            repetitionPenalty: 1,
            maxTokens: 512,
            reasoningEnabled: false,
        });
    });

    it('stores model load parameters independently per model', () => {
        updateSettings({ modelLoadParamsByModelId: {} });
        updateModelLoadParametersForModel('author/model-a', { contextSize: 4096, gpuLayers: 18 });
        updateModelLoadParametersForModel('author/model-b', { gpuLayers: 4 });

        expect(getModelLoadParametersForModel('author/model-a')).toEqual({
            contextSize: 4096,
            gpuLayers: 18,
        });
        expect(getModelLoadParametersForModel('author/model-b')).toEqual({
            contextSize: 4096,
            gpuLayers: 4,
        });
    });

    it('resets model load parameters back to defaults', () => {
        updateSettings({ modelLoadParamsByModelId: {} });
        updateModelLoadParametersForModel('author/model-a', { contextSize: 6144, gpuLayers: 24 });

        resetModelLoadParametersForModel('author/model-a');

        expect(getModelLoadParametersForModel('author/model-a')).toEqual({
            contextSize: 4096,
            gpuLayers: null,
        });
        expect(getSettings().modelLoadParamsByModelId).toEqual({});
    });

    it('clears all persisted per-model settings when a model is removed', () => {
        updateSettings({
            temperature: 0.6,
            topP: 0.85,
            maxTokens: 1024,
            modelParamsByModelId: {},
            modelLoadParamsByModelId: {},
        });
        updateGenerationParametersForModel('author/model-a', {
            temperature: 1.1,
            maxTokens: 512,
        });
        updateModelLoadParametersForModel('author/model-a', {
            contextSize: 8192,
            gpuLayers: 18,
        });
        updateGenerationParametersForModel('author/model-b', {
            topP: 0.4,
        });
        updateModelLoadParametersForModel('author/model-b', {
            contextSize: 6144,
            gpuLayers: 4,
        });

        resetAllParametersForModel('author/model-a');

        expect(getGenerationParametersForModel('author/model-a')).toEqual({
            temperature: 0.6,
            topP: 0.85,
            topK: 40,
            minP: 0.05,
            repetitionPenalty: 1,
            maxTokens: 1024,
            reasoningEnabled: false,
        });
        expect(getModelLoadParametersForModel('author/model-a')).toEqual({
            contextSize: 4096,
            gpuLayers: null,
        });
        expect(getSettings().modelParamsByModelId).toEqual({
            'author/model-b': {
                temperature: 0.6,
                topP: 0.4,
                topK: 40,
                minP: 0.05,
                repetitionPenalty: 1,
                maxTokens: 1024,
                reasoningEnabled: false,
            },
        });
        expect(getSettings().modelLoadParamsByModelId).toEqual({
            'author/model-b': {
                contextSize: 6144,
                gpuLayers: 4,
            },
        });
    });
});
