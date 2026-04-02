import type { MMKV } from 'react-native-mmkv';
import { Platform } from 'react-native';

type MmkvModule = typeof import('react-native-mmkv');

const IS_WEB = typeof window !== 'undefined' && Platform.OS === 'web';
const IS_TESTING = process.env.NODE_ENV === 'test';
const fallbackStores = new Map<string, Map<string, string>>();
const warnedFallbackStores = new Set<string>();

function getFallbackStore(id?: string): Map<string, string> {
    const storeId = id ?? '__default__';
    const existing = fallbackStores.get(storeId);
    if (existing) {
        return existing;
    }

    const created = new Map<string, string>();
    fallbackStores.set(storeId, created);
    return created;
}

export function createStorage(id?: string): MMKV {
    const logId = id || 'default';
    try {
        if (IS_WEB || IS_TESTING) {
            throw new Error('MMKV is not supported on web or during testing');
        }

        // Lazily require MMKV so the app can still boot if NitroModules/MMKV native code isn't available.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mmkvModule = require('react-native-mmkv') as MmkvModule;
        const createMMKV = mmkvModule.createMMKV;

        return id ? createMMKV({ id }) : createMMKV();
    } catch (e) {
        if (!IS_TESTING && !warnedFallbackStores.has(logId)) {
            warnedFallbackStores.add(logId);
            console.warn(
                `[MMKV Fallback] Failed to create MMKV instance (id: ${logId}). Using in-memory fallback. Error:`,
                e,
            );
        }

        const map = getFallbackStore(id);
        return {
            set: (key: string, value: string | number | boolean) => {
                map.set(key, String(value));
            },
            getString: (key: string) => map.get(key),
            getNumber: (key: string) => {
                const raw = map.get(key);
                if (raw === undefined) {
                    return undefined;
                }

                const parsed = Number(raw);
                return Number.isFinite(parsed) ? parsed : undefined;
            },
            getBoolean: (key: string) => {
                const raw = map.get(key);
                if (raw === undefined) {
                    return undefined;
                }

                if (raw === 'true') {
                    return true;
                }

                if (raw === 'false') {
                    return false;
                }

                return undefined;
            },
            remove: (key: string) => map.delete(key),
            clearAll: () => map.clear(),
            contains: (key: string) => map.has(key),
            getAllKeys: () => Array.from(map.keys()),
            recrypt: () => { },
        } as unknown as MMKV;
    }
}
