import type { MMKV } from 'react-native-mmkv';
import { assertPrivateStorageWritable, createStorage } from './storage';

let storageInstance: MMKV | null = null;

export function invalidatePresetStorageForPrivateReset(): void {
    storageInstance = null;
}

function getPresetStorage(): MMKV {
    if (storageInstance) {
        assertPrivateStorageWritable();
        return storageInstance;
    }

    const created = createStorage('pocket-ai-presets', { tier: 'private' });
    storageInstance = created;
    return created;
}

export interface SystemPromptPreset {
    id: string;
    name: string;
    systemPrompt: string;
    isBuiltIn: boolean;
}

const PRESETS_KEY = 'system_prompt_presets';
const PRESETS_CORRUPT_PREFIX = `${PRESETS_KEY}_corrupt_`;
const PRESET_SCHEMA_VERSION = 2;
const MAX_PRESET_ID_LENGTH = 128;
const MAX_PRESET_NAME_LENGTH = 120;
const MAX_SYSTEM_PROMPT_LENGTH = 12000;

type StoredPresetPayload = {
    schemaVersion: typeof PRESET_SCHEMA_VERSION;
    presets: SystemPromptPreset[];
};

type PresetReadResult = {
    presets: SystemPromptPreset[];
    shouldPersist: boolean;
    corruptRaw?: string;
};

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

function clonePreset(preset: SystemPromptPreset): SystemPromptPreset {
    return { ...preset };
}

function clonePresets(presets: SystemPromptPreset[]): SystemPromptPreset[] {
    return presets.map(clonePreset);
}

function getDefaultPresets(): SystemPromptPreset[] {
    return clonePresets(DEFAULT_PRESETS);
}

function encodePresetPayload(presets: SystemPromptPreset[]): string {
    const payload: StoredPresetPayload = {
        schemaVersion: PRESET_SCHEMA_VERSION,
        presets,
    };
    return JSON.stringify(payload);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizePresetText(value: unknown, maxLength: number): string | null {
    if (typeof value !== 'string') {
        return null;
    }

    const normalized = value.trim();
    if (!normalized || normalized.length > maxLength) {
        return null;
    }

    return normalized;
}

function generatePresetIdCandidate(): string {
    try {
        const cryptoObject = globalThis.crypto as { randomUUID?: () => string } | undefined;
        const uuid = cryptoObject?.randomUUID?.();
        if (uuid) {
            return `preset-${uuid}`;
        }
    } catch {
        // fall through to Expo/fallback entropy
    }

    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const expoCrypto = require('expo-crypto') as { randomUUID?: () => string };
        const uuid = expoCrypto.randomUUID?.();
        if (uuid) {
            return `preset-${uuid}`;
        }
    } catch {
        // fall through to non-crypto fallback
    }

    return `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function createPresetId(existingIds: Set<string>): string {
    for (let attempt = 0; attempt < 10; attempt += 1) {
        const base = generatePresetIdCandidate();
        const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
        if (!existingIds.has(candidate)) {
            existingIds.add(candidate);
            return candidate;
        }
    }

    let fallbackCounter = 0;
    let candidate = '';
    do {
        fallbackCounter += 1;
        candidate = `preset-${Date.now().toString(36)}-${fallbackCounter.toString(36)}`;
    } while (existingIds.has(candidate));

    existingIds.add(candidate);
    return candidate;
}

function sanitizePresetArray(rawPresets: unknown[]): { presets: SystemPromptPreset[]; didChange: boolean } {
    let didChange = false;
    const seenIds = new Set<string>();
    const presets: SystemPromptPreset[] = [];

    for (const rawPreset of rawPresets) {
        if (!isRecord(rawPreset)) {
            didChange = true;
            continue;
        }

        const rawId = normalizePresetText(rawPreset.id, MAX_PRESET_ID_LENGTH);
        const name = normalizePresetText(rawPreset.name, MAX_PRESET_NAME_LENGTH);
        const systemPrompt = normalizePresetText(rawPreset.systemPrompt, MAX_SYSTEM_PROMPT_LENGTH);

        if (!rawId || !name || !systemPrompt) {
            didChange = true;
            continue;
        }

        const id = seenIds.has(rawId) ? createPresetId(seenIds) : rawId;
        if (id !== rawId) {
            didChange = true;
        }
        seenIds.add(id);

        const preset: SystemPromptPreset = {
            id,
            name,
            systemPrompt,
            isBuiltIn: false,
        };

        if (
            rawPreset.id !== id ||
            rawPreset.name !== name ||
            rawPreset.systemPrompt !== systemPrompt ||
            rawPreset.isBuiltIn !== false
        ) {
            didChange = true;
        }

        presets.push(preset);
    }

    return { presets, didChange };
}

function decodePresetPayload(raw: string): PresetReadResult {
    let parsed: unknown;

    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        console.warn('[PresetManager] Corrupted preset JSON payload, restoring starter presets.', error);
        return {
            presets: getDefaultPresets(),
            shouldPersist: true,
            corruptRaw: raw,
        };
    }

    const rawPresets = Array.isArray(parsed)
        ? parsed
        : isRecord(parsed) && Array.isArray(parsed.presets)
            ? parsed.presets
            : null;

    if (!rawPresets) {
        console.warn('[PresetManager] Invalid preset payload shape, restoring starter presets.');
        return {
            presets: getDefaultPresets(),
            shouldPersist: true,
            corruptRaw: raw,
        };
    }

    const sanitized = sanitizePresetArray(rawPresets);
    const isCurrentSchema =
        isRecord(parsed) &&
        parsed.schemaVersion === PRESET_SCHEMA_VERSION &&
        Array.isArray(parsed.presets);

    if (rawPresets.length > 0 && sanitized.presets.length === 0) {
        console.warn('[PresetManager] Preset payload contained no valid entries, restoring starter presets.');
        return {
            presets: getDefaultPresets(),
            shouldPersist: true,
            corruptRaw: raw,
        };
    }

    return {
        presets: sanitized.presets,
        shouldPersist: !isCurrentSchema || sanitized.didChange,
    };
}

let corruptPresetCounter = 0;

function quarantineCorruptPresetPayload(storage: MMKV, raw: string): void {
    corruptPresetCounter += 1;
    const quarantineKey = `${PRESETS_CORRUPT_PREFIX}${Date.now().toString(36)}_${corruptPresetCounter.toString(36)}`;
    storage.set(quarantineKey, raw);
}

class PresetManager {
    getPresets(): SystemPromptPreset[] {
        const storage = getPresetStorage();
        const raw = storage.getString(PRESETS_KEY);
        if (!raw) {
            const presets = getDefaultPresets();
            this.savePresets(presets);
            return presets;
        }

        const decoded = decodePresetPayload(raw);

        if (decoded.corruptRaw) {
            quarantineCorruptPresetPayload(storage, decoded.corruptRaw);
        }

        if (decoded.shouldPersist) {
            this.savePresets(decoded.presets);
        }

        return clonePresets(decoded.presets);
    }

    getPreset(id: string): SystemPromptPreset | undefined {
        return this.getPresets().find(p => p.id === id);
    }

    addPreset(name: string, systemPrompt: string): SystemPromptPreset {
        const presets = this.getPresets();
        const existingIds = new Set(presets.map((preset) => preset.id));
        const preset: SystemPromptPreset = {
            id: createPresetId(existingIds),
            name,
            systemPrompt,
            isBuiltIn: false,
        };
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
        getPresetStorage().set(PRESETS_KEY, encodePresetPayload(clonePresets(presets)));
    }
}

export const presetManager = new PresetManager();
