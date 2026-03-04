import { createStorage } from './storage';

const storage = createStorage('pocket-ai-presets');

export interface SystemPromptPreset {
    id: string;
    name: string;
    systemPrompt: string;
    isBuiltIn: boolean;
}

const PRESETS_KEY = 'system_prompt_presets';

const DEFAULT_PRESETS: SystemPromptPreset[] = [
    {
        id: 'helpful-assistant',
        name: 'Helpful Assistant',
        systemPrompt: 'You are a helpful, harmless, and honest AI assistant. Provide clear, concise answers.',
        isBuiltIn: true,
    },
    {
        id: 'code-expert',
        name: 'Code Expert',
        systemPrompt: 'You are an expert programmer. Write clean, efficient code with clear explanations. Use best practices and modern patterns.',
        isBuiltIn: true,
    },
    {
        id: 'translator',
        name: 'Translator',
        systemPrompt: 'You are a professional translator. Translate text accurately while preserving the original tone and meaning. Ask for the target language if not specified.',
        isBuiltIn: true,
    },
    {
        id: 'creative-writer',
        name: 'Creative Writer',
        systemPrompt: 'You are a creative writer. Help with stories, poems, scripts, and other creative text. Be imaginative and engaging.',
        isBuiltIn: true,
    },
];

class PresetManager {
    getPresets(): SystemPromptPreset[] {
        const raw = storage.getString(PRESETS_KEY);
        if (!raw) {
            // Initialize with defaults
            this.savePresets(DEFAULT_PRESETS);
            return [...DEFAULT_PRESETS];
        }
        return JSON.parse(raw);
    }

    getPreset(id: string): SystemPromptPreset | undefined {
        return this.getPresets().find(p => p.id === id);
    }

    addPreset(name: string, systemPrompt: string): SystemPromptPreset {
        const preset: SystemPromptPreset = {
            id: Date.now().toString(),
            name,
            systemPrompt,
            isBuiltIn: false,
        };
        const presets = this.getPresets();
        presets.push(preset);
        this.savePresets(presets);
        return preset;
    }

    updatePreset(id: string, updates: Partial<Pick<SystemPromptPreset, 'name' | 'systemPrompt'>>) {
        const presets = this.getPresets();
        const index = presets.findIndex(p => p.id === id);
        if (index === -1) throw new Error(`Preset ${id} not found`);
        if (presets[index].isBuiltIn) throw new Error('Cannot modify built-in presets');

        presets[index] = { ...presets[index], ...updates };
        this.savePresets(presets);
        return presets[index];
    }

    deletePreset(id: string) {
        const presets = this.getPresets();
        const preset = presets.find(p => p.id === id);
        if (!preset) throw new Error(`Preset ${id} not found`);
        if (preset.isBuiltIn) throw new Error('Cannot delete built-in presets');

        this.savePresets(presets.filter(p => p.id !== id));
    }

    private savePresets(presets: SystemPromptPreset[]) {
        storage.set(PRESETS_KEY, JSON.stringify(presets));
    }
}

export const presetManager = new PresetManager();
