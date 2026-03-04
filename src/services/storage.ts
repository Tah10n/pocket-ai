import { MMKV, createMMKV } from 'react-native-mmkv';
import { Platform } from 'react-native';

const IS_WEB = typeof window !== 'undefined' && Platform.OS === 'web';
const IS_TESTING = process.env.NODE_ENV === 'test';

export function createStorage(id?: string): MMKV {
    try {
        if (IS_WEB || IS_TESTING) {
            throw new Error('MMKV is not supported on web or during testing');
        }
        return id ? createMMKV({ id }) : createMMKV();
    } catch (e) {
        console.warn(`[MMKV Fallback] Failed to create MMKV instance (id: ${id || 'default'}). Using in-memory fallback. Error:`, e);
        const map = new Map<string, string>();
        return {
            set: (key: string, value: string | number | boolean) => map.set(key, String(value)),
            getString: (key: string) => map.get(key),
            getNumber: (key: string) => Number(map.get(key)),
            getBoolean: (key: string) => map.get(key) === 'true',
            delete: (key: string) => map.delete(key),
            clearAll: () => map.clear(),
            contains: (key: string) => map.has(key),
            getAllKeys: () => Array.from(map.keys()),
            recrypt: () => { },
        } as unknown as MMKV;
    }
}
