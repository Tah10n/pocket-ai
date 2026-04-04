import type { MMKV } from 'react-native-mmkv';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

type MmkvModule = typeof import('react-native-mmkv');

const IS_WEB = typeof window !== 'undefined' && Platform.OS === 'web';
const IS_TESTING = process.env.NODE_ENV === 'test';
const fallbackStores = new Map<string, Map<string, string>>();
const warnedFallbackStores = new Set<string>();

export type StorageTier = 'private' | 'cache' | 'ephemeral';
export type StorageImplementation = 'mmkv' | 'memory';
export type StorageFallbackReason =
    | 'unsupported_environment'
    | 'mmkv_init_failed'
    | 'encryption_not_initialized'
    | 'encryption_unavailable';

type StorageHealthEntry = {
    implementation: StorageImplementation;
    reason?: StorageFallbackReason;
    errorMessage?: string;
};

const storageHealthById = new Map<string, StorageHealthEntry>();

export type StorageFallbackReport = {
    storeIds: string[];
    reasons: Record<string, StorageFallbackReason>;
};

const PRIVATE_STORAGE_ENCRYPTION_KEY_ID = 'pocket-ai-private-mmkv-key-v1';
const PRIVATE_STORAGE_MIGRATION_VERSION_ID = 'pocket-ai-private-mmkv-migration-version';
const PRIVATE_STORAGE_MIGRATION_VERSION = 1;
const PRIVATE_STORAGE_ENCRYPTION_TYPE = 'AES-256' as const;

const PRIVATE_STORAGE_INSTANCE_IDS = [
    'global-app-storage',
    'pocket-ai-settings',
    'pocket-ai-presets',
    'models-registry',
] as const;

type PrivateStorageEncryptionState = 'uninitialized' | 'ready' | 'unavailable';

let privateEncryptionState: PrivateStorageEncryptionState = 'uninitialized';
let privateEncryptionKey: string | null = null;
let privateEncryptionInitPromise: Promise<void> | null = null;

export function getStorageFallbackReport(): StorageFallbackReport | null {
    const storeIds: string[] = [];
    const reasons: Record<string, StorageFallbackReason> = {};

    for (const [storeId, entry] of storageHealthById.entries()) {
        if (entry.implementation !== 'memory') {
            continue;
        }

        if (entry.reason === 'unsupported_environment') {
            continue;
        }

        storeIds.push(storeId);
        reasons[storeId] = entry.reason ?? 'mmkv_init_failed';
    }

    if (storeIds.length === 0) {
        return null;
    }

    storeIds.sort((left, right) => left.localeCompare(right));
    return { storeIds, reasons };
}

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

function resolveTieredStoreId(tier: StorageTier, id?: string): string {
    const normalizedTier = tier ?? 'cache';
    const normalizedId = id ?? '__default__';
    return `${normalizedTier}:${normalizedId}`;
}

type CryptoLike = { getRandomValues: (array: Uint8Array) => void };

function getCrypto(): CryptoLike | null {
    const cryptoObject = (globalThis as unknown as { crypto?: unknown }).crypto;
    if (
        cryptoObject
        && typeof cryptoObject === 'object'
        && typeof (cryptoObject as { getRandomValues?: unknown }).getRandomValues === 'function'
    ) {
        return cryptoObject as CryptoLike;
    }

    return null;
}

function requireExpoCrypto(): { getRandomBytesAsync: (byteCount: number) => Promise<Uint8Array> } | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const module = require('expo-crypto') as { getRandomBytesAsync?: unknown };
        if (typeof module.getRandomBytesAsync !== 'function') {
            return null;
        }

        return module as { getRandomBytesAsync: (byteCount: number) => Promise<Uint8Array> };
    } catch {
        return null;
    }
}

async function getSecureRandomBytes(byteCount: number): Promise<Uint8Array> {
    const cryptoObject = getCrypto();
    if (cryptoObject) {
        const bytes = new Uint8Array(byteCount);
        cryptoObject.getRandomValues(bytes);
        return bytes;
    }

    const expoCrypto = requireExpoCrypto();
    if (expoCrypto) {
        return expoCrypto.getRandomBytesAsync(byteCount);
    }

    throw new Error('Secure random bytes generator is unavailable');
}

function base64UrlEncode(bytes: Uint8Array): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let output = '';

    for (let index = 0; index < bytes.length; index += 3) {
        const byte1 = bytes[index];
        const hasByte2 = index + 1 < bytes.length;
        const hasByte3 = index + 2 < bytes.length;
        const byte2 = hasByte2 ? bytes[index + 1] : 0;
        const byte3 = hasByte3 ? bytes[index + 2] : 0;

        const triplet = (byte1 << 16) | (byte2 << 8) | byte3;
        output += alphabet[(triplet >> 18) & 63];
        output += alphabet[(triplet >> 12) & 63];
        if (hasByte2) {
            output += alphabet[(triplet >> 6) & 63];
        }
        if (hasByte3) {
            output += alphabet[triplet & 63];
        }
    }

    return output;
}

const PRIVATE_STORAGE_ENCRYPTION_KEY_BYTE_LENGTH = 32;
// `react-native-mmkv` caps AES-256 encryption keys at 32 bytes. SecureStore stores the key as a string,
// so we generate a fixed-length 32-byte ASCII key via base64url encoding of 24 random bytes.
const PRIVATE_STORAGE_ENCRYPTION_KEY_RANDOM_BYTES = 24;

async function generatePrivateStorageEncryptionKey(): Promise<string> {
    const bytes = await getSecureRandomBytes(PRIVATE_STORAGE_ENCRYPTION_KEY_RANDOM_BYTES);
    const key = base64UrlEncode(bytes);
    if (key.length !== PRIVATE_STORAGE_ENCRYPTION_KEY_BYTE_LENGTH) {
        throw new Error('Generated encryption key length mismatch');
    }

    return key;
}

async function isSecureStoreAvailable(): Promise<boolean> {
    try {
        return await SecureStore.isAvailableAsync();
    } catch {
        return false;
    }
}

function requireMmkvModule(): MmkvModule {
    // Lazily require MMKV so the app can still boot if NitroModules/MMKV native code isn't available.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('react-native-mmkv') as MmkvModule;
}

function encryptMmkvInstance(id: string, encryptionKeyValue: string): void {
    const mmkvModule = requireMmkvModule();
    const createMMKV = mmkvModule.createMMKV;
    const deleteMMKV = mmkvModule.deleteMMKV;

    try {
        const store = createMMKV({ id });
        if (!store.isEncrypted) {
            const keys = store.getAllKeys();
            const snapshot = new Map<string, string | undefined>(keys.map((key) => [key, store.getString(key)]));

            store.encrypt(encryptionKeyValue, PRIVATE_STORAGE_ENCRYPTION_TYPE);

            for (const [key, value] of snapshot.entries()) {
                const storedValue = store.getString(key);
                if (storedValue !== value) {
                    throw new Error(`Encrypted value mismatch for key "${key}"`);
                }
            }
        }

        return;
    } catch (error) {
        // If the store was already encrypted (and can't be opened without a key),
        // try opening it with the configured key. If that still fails, reset it.
        try {
            const store = createMMKV({
                id,
                encryptionKey: encryptionKeyValue,
                encryptionType: PRIVATE_STORAGE_ENCRYPTION_TYPE,
            });

            if (!store.isEncrypted) {
                store.encrypt(encryptionKeyValue, PRIVATE_STORAGE_ENCRYPTION_TYPE);
            }

            return;
        } catch (openError) {
            try {
                deleteMMKV(id);
            } catch {
                // ignore
            }

            const store = createMMKV({
                id,
                encryptionKey: encryptionKeyValue,
                encryptionType: PRIVATE_STORAGE_ENCRYPTION_TYPE,
            });

            if (!store.isEncrypted) {
                store.encrypt(encryptionKeyValue, PRIVATE_STORAGE_ENCRYPTION_TYPE);
            }

            if (!IS_TESTING) {
                console.warn(`[Storage] Reset encrypted MMKV store after open failure (id: ${id})`, {
                    error: error instanceof Error ? error.message : String(error),
                    openError: openError instanceof Error ? openError.message : String(openError),
                });
            }
        }
    }
}

async function runPrivateStorageMigrations(encryptionKeyValue: string): Promise<void> {
    const versionRaw = await SecureStore.getItemAsync(PRIVATE_STORAGE_MIGRATION_VERSION_ID);
    const currentVersion = versionRaw ? Number(versionRaw) : 0;
    const normalizedVersion = Number.isFinite(currentVersion) ? Math.max(0, Math.floor(currentVersion)) : 0;

    if (normalizedVersion >= PRIVATE_STORAGE_MIGRATION_VERSION) {
        return;
    }

    for (const storeId of PRIVATE_STORAGE_INSTANCE_IDS) {
        encryptMmkvInstance(storeId, encryptionKeyValue);
    }

    await SecureStore.setItemAsync(PRIVATE_STORAGE_MIGRATION_VERSION_ID, String(PRIVATE_STORAGE_MIGRATION_VERSION));
}

export async function initializePrivateStorageEncryption(): Promise<void> {
    if (IS_WEB || IS_TESTING) {
        privateEncryptionState = 'unavailable';
        privateEncryptionKey = null;
        return;
    }

    if (privateEncryptionState !== 'uninitialized') {
        return;
    }

    if (privateEncryptionInitPromise) {
        return privateEncryptionInitPromise;
    }

    privateEncryptionInitPromise = (async () => {
        if (!await isSecureStoreAvailable()) {
            privateEncryptionState = 'unavailable';
            privateEncryptionKey = null;
            return;
        }

        let key = await SecureStore.getItemAsync(PRIVATE_STORAGE_ENCRYPTION_KEY_ID);
        key = typeof key === 'string' ? key.trim() : null;
        if (!key || key.length !== PRIVATE_STORAGE_ENCRYPTION_KEY_BYTE_LENGTH) {
            try {
                key = await generatePrivateStorageEncryptionKey();
                await SecureStore.setItemAsync(PRIVATE_STORAGE_ENCRYPTION_KEY_ID, key);
            } catch (error) {
                privateEncryptionState = 'unavailable';
                privateEncryptionKey = null;
                if (!IS_TESTING) {
                    console.warn('[Storage] Failed to generate private storage encryption key; disabling encrypted storage.', error);
                }
                return;
            }
        }

        privateEncryptionKey = key;

        try {
            await runPrivateStorageMigrations(key);
        } catch {
            privateEncryptionState = 'unavailable';
            privateEncryptionKey = null;
            if (!IS_TESTING) {
                console.warn('[Storage] Private storage migrations failed; disabling encrypted storage for this session.');
            }
            return;
        }

        privateEncryptionState = 'ready';
    })();

    return privateEncryptionInitPromise;
}

export function isPrivateStorageEncryptionReady(): boolean {
    return privateEncryptionState === 'ready' && typeof privateEncryptionKey === 'string' && privateEncryptionKey.length > 0;
}

function getPrivateStorageEncryptionConfig(): { encryptionKey: string; encryptionType: typeof PRIVATE_STORAGE_ENCRYPTION_TYPE } | null {
    return isPrivateStorageEncryptionReady() && privateEncryptionKey
        ? { encryptionKey: privateEncryptionKey, encryptionType: PRIVATE_STORAGE_ENCRYPTION_TYPE }
        : null;
}

export function createStorage(
    id?: string,
    options?: { tier?: StorageTier },
): MMKV {
    const tier: StorageTier = options?.tier ?? 'cache';
    const trimmedId = typeof id === 'string' ? id.trim() : '';
    const normalizedId = trimmedId.length > 0 ? trimmedId : undefined;
    const logId = normalizedId ?? 'default';
    const healthKey = resolveTieredStoreId(tier, logId);
    try {
        if (IS_WEB || IS_TESTING) {
            throw new Error('MMKV is not supported on web or during testing');
        }

        if (tier === 'ephemeral') {
            throw new Error('Ephemeral storage requested');
        }

        const mmkvModule = requireMmkvModule();
        const createMMKV = mmkvModule.createMMKV;

        if (tier === 'private') {
            const config = getPrivateStorageEncryptionConfig();
            if (!config) {
                throw new Error(
                    privateEncryptionState === 'unavailable'
                        ? 'Private storage encryption is unavailable'
                        : 'Private storage encryption is not initialized',
                );
            }

            if (!normalizedId) {
                throw new Error('Private MMKV instances require an explicit id');
            }

            storageHealthById.set(healthKey, { implementation: 'mmkv' });
            return createMMKV({
                id: normalizedId,
                encryptionKey: config.encryptionKey,
                encryptionType: config.encryptionType,
            });
        }

        storageHealthById.set(healthKey, { implementation: 'mmkv' });
        return normalizedId ? createMMKV({ id: normalizedId }) : createMMKV();
    } catch (e) {
        const reason: StorageFallbackReason =
            IS_WEB || IS_TESTING
                ? 'unsupported_environment'
                : tier === 'private' && privateEncryptionState === 'unavailable'
                    ? 'encryption_unavailable'
                    : tier === 'private' && privateEncryptionState !== 'ready'
                        ? 'encryption_not_initialized'
                        : tier === 'ephemeral'
                            ? 'unsupported_environment'
                            : 'mmkv_init_failed';

        storageHealthById.set(healthKey, {
            implementation: 'memory',
            reason,
            errorMessage: e instanceof Error ? e.message : String(e),
        });

        if (!IS_TESTING && tier !== 'ephemeral' && !warnedFallbackStores.has(healthKey)) {
            warnedFallbackStores.add(healthKey);
            console.warn(
                `[MMKV Fallback] Failed to create MMKV instance (tier: ${tier}, id: ${logId}). Using in-memory fallback. Error:`,
                e,
            );
        }

        const map = getFallbackStore(resolveTieredStoreId(tier, normalizedId));
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
