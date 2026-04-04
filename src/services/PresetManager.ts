import type { MMKV } from 'react-native-mmkv';
import { createStorage } from './storage';

let storageInstance: MMKV | null = null;

function getPresetStorage(): MMKV {
    if (!storageInstance) {
        storageInstance = createStorage('pocket-ai-presets', { tier: 'private' });
    }

    return storageInstance;
}

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
        isBuiltIn: false,
    },
    {
        id: 'code-expert',
        name: 'Code Expert',
        systemPrompt: 'You are an expert programmer. Write clean, efficient code with clear explanations. Use best practices and modern patterns.',
        isBuiltIn: false,
    },
    {
        id: 'translator',
        name: 'Translator',
        systemPrompt: 'You are a professional translator. Translate text accurately while preserving the original tone and meaning. Ask for the target language if not specified.',
        isBuiltIn: false,
    },
    {
        id: 'creative-writer',
        name: 'Creative Writer',
        systemPrompt: 'You are a creative writer. Help with stories, poems, scripts, and other creative text. Be imaginative and engaging.',
        isBuiltIn: false,
    },
    {
        id: 'study-tutor',
        name: 'Study Tutor',
        systemPrompt: 'You are a patient tutor. Explain concepts step by step, adapt to the learner level, and include short examples or practice questions when helpful.',
        isBuiltIn: false,
    },
    {
        id: 'research-analyst',
        name: 'Research Analyst',
        systemPrompt: 'You are a careful research analyst. Organize findings clearly, separate facts from assumptions, highlight tradeoffs, and call out uncertainty when evidence is limited.',
        isBuiltIn: false,
    },
    {
        id: 'product-manager',
        name: 'Product Manager',
        systemPrompt: 'You are a pragmatic product manager. Clarify goals, identify user needs, compare options, surface risks, and recommend the smallest effective next step.',
        isBuiltIn: false,
    },
    {
        id: 'summarizer',
        name: 'Summarizer',
        systemPrompt: 'You are an expert summarizer. Turn long content into crisp, well-structured summaries with the key points, decisions, and open questions.',
        isBuiltIn: false,
    },
    {
        id: 'brainstorm-partner',
        name: 'Brainstorm Partner',
        systemPrompt: 'You are a creative brainstorming partner. Generate multiple distinct ideas, vary the approaches, and balance originality with practical execution.',
        isBuiltIn: false,
    },
    {
        id: 'data-analyst',
        name: 'Data Analyst',
        systemPrompt: 'You are a data analyst. Interpret tables, metrics, and trends carefully, explain your reasoning, and suggest concrete follow-up analyses when appropriate.',
        isBuiltIn: false,
    },
];

function normalizeStoredPresets(storedPresets: SystemPromptPreset[]): SystemPromptPreset[] {
    let didChange = false;

    const normalized = storedPresets.map((preset) => {
        if (preset.isBuiltIn) {
            didChange = true;
            return { ...preset, isBuiltIn: false };
        }

        return preset;
    });

    return didChange ? normalized : storedPresets;
}

class PresetManager {
    getPresets(): SystemPromptPreset[] {
        const raw = getPresetStorage().getString(PRESETS_KEY);
        if (!raw) {
            // Initialize with defaults
            this.savePresets(DEFAULT_PRESETS);
            return [...DEFAULT_PRESETS];
        }

        const parsed = JSON.parse(raw) as SystemPromptPreset[];
        const normalized = normalizeStoredPresets(parsed);

        if (normalized !== parsed) {
            this.savePresets(normalized);
        }

        return normalized;
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

        presets[index] = { ...presets[index], ...updates };
        this.savePresets(presets);
        return presets[index];
    }

    deletePreset(id: string) {
        const presets = this.getPresets();
        const preset = presets.find(p => p.id === id);
        if (!preset) throw new Error(`Preset ${id} not found`);

        this.savePresets(presets.filter(p => p.id !== id));
    }

    private savePresets(presets: SystemPromptPreset[]) {
        getPresetStorage().set(PRESETS_KEY, JSON.stringify(presets));
    }
}

export const presetManager = new PresetManager();
