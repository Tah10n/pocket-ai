import type { MMKV } from 'react-native-mmkv';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

type MmkvModule = typeof import('react-native-mmkv');

function getRuntimeEnvValue(key: string): string | undefined {
    return (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[key];
}

function getRuntimeNodeEnv(): string | undefined {
    return getRuntimeEnvValue('NODE_ENV');
}

const IS_WEB = typeof window !== 'undefined' && Platform.OS === 'web';
const RUNTIME_NODE_ENV = getRuntimeNodeEnv();
const IS_TESTING = RUNTIME_NODE_ENV === 'test'
    || (RUNTIME_NODE_ENV !== 'production'
        && (typeof getRuntimeEnvValue('JEST_WORKER_ID') === 'string' || getRuntimeEnvValue('EXPO_OS') === 'web'));
const fallbackStores = new Map<string, Map<string, string>>();
const warnedFallbackStores = new Set<string>();

export type StorageTier = 'private' | 'cache' | 'ephemeral';
export type StorageImplementation = 'mmkv' | 'memory';
export type StorageFallbackReason =
    | 'unsupported_environment'
    | 'mmkv_init_failed'
    | 'encryption_not_initialized'
    | 'encryption_unavailable';

export type PrivateStorageBlockReason =
    | 'encryption_not_initialized'
    | 'encryption_initializing'
    | 'encryption_unavailable'
    | 'secure_key_unavailable'
    | 'migration_failed'
    | 'encrypted_open_failed'
    | 'reset_failed'
    | 'unknown';

export type StorageRecoveryAction = 'retry' | 'reset_private_storage' | 'none';

export type PrivateStorageHealthSnapshot = {
    status: 'unknown' | 'initializing' | 'ready' | 'blocked' | 'resetting';
    reason?: PrivateStorageBlockReason;
    retryable: boolean;
    requiresExplicitReset: boolean;
    messageKey?: string;
    lastUpdatedAt: number;
};

const PRIVATE_STORAGE_MESSAGE_KEYS: Record<PrivateStorageBlockReason, string> = {
    encryption_not_initialized: 'storage.private.encryptionNotInitialized',
    encryption_initializing: 'storage.private.encryptionInitializing',
    encryption_unavailable: 'storage.private.encryptionUnavailable',
    secure_key_unavailable: 'storage.private.secureKeyUnavailable',
    migration_failed: 'storage.private.migrationFailed',
    encrypted_open_failed: 'storage.private.encryptedOpenFailed',
    reset_failed: 'storage.private.resetFailed',
    unknown: 'storage.private.unknown',
};

function getRecoveryAction(snapshot: PrivateStorageHealthSnapshot): StorageRecoveryAction {
    if (snapshot.requiresExplicitReset) {
        return 'reset_private_storage';
    }

    return snapshot.retryable ? 'retry' : 'none';
}

export class PrivateStorageUnavailableError extends Error {
    readonly reason: PrivateStorageBlockReason;
    readonly recoveryAction: StorageRecoveryAction;
    readonly health: PrivateStorageHealthSnapshot;

    constructor(reason: PrivateStorageBlockReason, health: PrivateStorageHealthSnapshot) {
        super(`Private storage is unavailable (${reason})`);
        this.name = 'PrivateStorageUnavailableError';
        Object.setPrototypeOf(this, PrivateStorageUnavailableError.prototype);
        this.reason = reason;
        this.health = { ...health };
        this.recoveryAction = getRecoveryAction(health);
    }
}

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
    'pocket-ai-last-good-profiles',
    'pocket-ai-autotune',
] as const;

type PrivateStorageEncryptionState = 'uninitialized' | 'ready' | 'unavailable';

let privateEncryptionState: PrivateStorageEncryptionState = 'uninitialized';
let privateEncryptionKey: string | null = null;
let privateEncryptionInitPromise: Promise<PrivateStorageHealthSnapshot> | null = null;
let privateStorageResetPromise: Promise<PrivateStorageHealthSnapshot> | null = null;
let privateStorageHealth: PrivateStorageHealthSnapshot = {
    status: 'unknown',
    retryable: true,
    requiresExplicitReset: false,
    lastUpdatedAt: Date.now(),
};

function snapshotPrivateStorageHealth(): PrivateStorageHealthSnapshot {
    return { ...privateStorageHealth };
}

function setPrivateStorageHealth(
    status: PrivateStorageHealthSnapshot['status'],
    reason?: PrivateStorageBlockReason,
    overrides?: Partial<Pick<PrivateStorageHealthSnapshot, 'retryable' | 'requiresExplicitReset'>>,
): PrivateStorageHealthSnapshot {
    const retryable = overrides?.retryable ?? (status === 'blocked');
    const requiresExplicitReset = overrides?.requiresExplicitReset ?? false;

    privateStorageHealth = {
        status,
        ...(reason ? { reason, messageKey: PRIVATE_STORAGE_MESSAGE_KEYS[reason] } : {}),
        retryable,
        requiresExplicitReset,
        lastUpdatedAt: Date.now(),
    };

    return snapshotPrivateStorageHealth();
}

function blockPrivateStorage(
    reason: PrivateStorageBlockReason,
    options?: Partial<Pick<PrivateStorageHealthSnapshot, 'retryable' | 'requiresExplicitReset'>>,
): PrivateStorageHealthSnapshot {
    privateEncryptionState = 'unavailable';
    privateEncryptionKey = null;
    return setPrivateStorageHealth('blocked', reason, {
        retryable: options?.retryable ?? true,
        requiresExplicitReset: options?.requiresExplicitReset ?? false,
    });
}

function throwPrivateStorageUnavailable(reason: PrivateStorageBlockReason, health?: PrivateStorageHealthSnapshot): never {
    throw new PrivateStorageUnavailableError(reason, health ?? blockPrivateStorage(reason));
}

export function getPrivateStorageHealthSnapshot(): PrivateStorageHealthSnapshot {
    return snapshotPrivateStorageHealth();
}

export function isPrivateStorageWritable(): boolean {
    if (IS_WEB || IS_TESTING) {
        return true;
    }

    return privateStorageHealth.status === 'ready'
        && privateEncryptionState === 'ready'
        && typeof privateEncryptionKey === 'string'
        && privateEncryptionKey.length > 0;
}

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
    } catch {
        // If the store was already encrypted (and can't be opened without a key),
        // try opening it with the configured key. If that still fails, block private
        // storage and wait for an explicit user-confirmed reset instead of deleting data.
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
        } catch {
            const health = blockPrivateStorage('encrypted_open_failed', {
                retryable: true,
                requiresExplicitReset: true,
            });
            throw new PrivateStorageUnavailableError('encrypted_open_failed', health);
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

export async function initializePrivateStorageEncryption(): Promise<PrivateStorageHealthSnapshot> {
    return initializePrivateStorageEncryptionInternal(false);
}

async function initializePrivateStorageEncryptionInternal(
    ignoreResetPromise: boolean,
): Promise<PrivateStorageHealthSnapshot> {
    if (IS_WEB || IS_TESTING) {
        privateEncryptionState = 'unavailable';
        privateEncryptionKey = null;
        return setPrivateStorageHealth('ready', undefined, {
            retryable: false,
            requiresExplicitReset: false,
        });
    }

    if (!ignoreResetPromise && privateStorageResetPromise) {
        return privateStorageResetPromise;
    }

    if (isPrivateStorageWritable()) {
        return snapshotPrivateStorageHealth();
    }

    if (privateStorageHealth.status === 'blocked' && privateEncryptionState !== 'uninitialized') {
        return snapshotPrivateStorageHealth();
    }

    if (privateEncryptionInitPromise) {
        return privateEncryptionInitPromise;
    }

    privateEncryptionInitPromise = (async () => {
        setPrivateStorageHealth('initializing', 'encryption_initializing', {
            retryable: false,
            requiresExplicitReset: false,
        });

        if (!await isSecureStoreAvailable()) {
            return blockPrivateStorage('secure_key_unavailable');
        }

        let key: string | null = null;
        try {
            key = await SecureStore.getItemAsync(PRIVATE_STORAGE_ENCRYPTION_KEY_ID);
            key = typeof key === 'string' ? key.trim() : null;
            if (!key || key.length !== PRIVATE_STORAGE_ENCRYPTION_KEY_BYTE_LENGTH) {
                key = await generatePrivateStorageEncryptionKey();
                await SecureStore.setItemAsync(PRIVATE_STORAGE_ENCRYPTION_KEY_ID, key);
            }
        } catch {
            if (!IS_TESTING) {
                console.warn('[Storage] Failed to prepare private storage encryption key; private storage is blocked.');
            }
            return blockPrivateStorage('secure_key_unavailable');
        }

        privateEncryptionState = 'ready';
        privateEncryptionKey = key;

        try {
            await runPrivateStorageMigrations(key);
        } catch (error) {
            if (error instanceof PrivateStorageUnavailableError) {
                return snapshotPrivateStorageHealth();
            }

            if (!IS_TESTING) {
                console.warn('[Storage] Private storage migrations failed; private storage is blocked.');
            }
            return blockPrivateStorage('migration_failed');
        }

        privateEncryptionState = 'ready';
        return setPrivateStorageHealth('ready', undefined, {
            retryable: false,
            requiresExplicitReset: false,
        });
    })().finally(() => {
        privateEncryptionInitPromise = null;
    });

    return privateEncryptionInitPromise;
}

export function isPrivateStorageEncryptionReady(): boolean {
    return isPrivateStorageWritable();
}

export async function retryPrivateStorageInitialization(): Promise<PrivateStorageHealthSnapshot> {
    if (privateStorageResetPromise) {
        return privateStorageResetPromise;
    }

    if (privateEncryptionInitPromise) {
        return privateEncryptionInitPromise;
    }

    privateEncryptionState = 'uninitialized';
    privateEncryptionKey = null;
    privateEncryptionInitPromise = null;

    return initializePrivateStorageEncryption();
}

export async function resetPrivateAppStorageAfterConfirmation(): Promise<PrivateStorageHealthSnapshot> {
    if (privateStorageResetPromise) {
        return privateStorageResetPromise;
    }

    privateStorageResetPromise = (async () => {
        if (privateEncryptionInitPromise) {
            await privateEncryptionInitPromise.catch(() => snapshotPrivateStorageHealth());
        }

        setPrivateStorageHealth('resetting', undefined, {
            retryable: false,
            requiresExplicitReset: false,
        });

        try {
            if (!IS_WEB && !IS_TESTING) {
                const { deleteMMKV } = requireMmkvModule();
                for (const storeId of PRIVATE_STORAGE_INSTANCE_IDS) {
                    deleteMMKV(storeId);
                }
            }

            try {
                await SecureStore.deleteItemAsync(PRIVATE_STORAGE_ENCRYPTION_KEY_ID);
                await SecureStore.deleteItemAsync(PRIVATE_STORAGE_MIGRATION_VERSION_ID);
            } catch {
                // SecureStore cleanup may be unavailable in unsupported environments; initialization will re-check below.
            }

            privateEncryptionState = 'uninitialized';
            privateEncryptionKey = null;
            privateEncryptionInitPromise = null;

            return initializePrivateStorageEncryptionInternal(true);
        } catch {
            return blockPrivateStorage('reset_failed', {
                retryable: true,
                requiresExplicitReset: true,
            });
        }
    })().finally(() => {
        privateStorageResetPromise = null;
    });

    return privateStorageResetPromise;
}

function getPrivateStorageEncryptionConfig(): { encryptionKey: string; encryptionType: typeof PRIVATE_STORAGE_ENCRYPTION_TYPE } | null {
    return isPrivateStorageEncryptionReady() && privateEncryptionKey
        ? { encryptionKey: privateEncryptionKey, encryptionType: PRIVATE_STORAGE_ENCRYPTION_TYPE }
        : null;
}

function createNativePrivateStorage(normalizedId: string | undefined, healthKey: string): MMKV {
    if (privateStorageResetPromise || privateStorageHealth.status === 'resetting') {
        throwPrivateStorageUnavailable('unknown', snapshotPrivateStorageHealth());
    }

    if (privateEncryptionInitPromise || privateStorageHealth.status === 'initializing') {
        throwPrivateStorageUnavailable('encryption_initializing', snapshotPrivateStorageHealth());
    }

    const config = getPrivateStorageEncryptionConfig();
    if (!config) {
        if (privateStorageHealth.status === 'blocked' && privateStorageHealth.reason) {
            throwPrivateStorageUnavailable(privateStorageHealth.reason, snapshotPrivateStorageHealth());
        }

        throwPrivateStorageUnavailable('encryption_not_initialized', blockPrivateStorage('encryption_not_initialized'));
    }

    if (!normalizedId) {
        throw new Error('Private MMKV instances require an explicit id');
    }

    try {
        const { createMMKV } = requireMmkvModule();
        storageHealthById.set(healthKey, { implementation: 'mmkv' });
        return createMMKV({
            id: normalizedId,
            encryptionKey: config.encryptionKey,
            encryptionType: config.encryptionType,
        });
    } catch {
        const health = blockPrivateStorage('encrypted_open_failed', {
            retryable: true,
            requiresExplicitReset: true,
        });
        throw new PrivateStorageUnavailableError('encrypted_open_failed', health);
    }
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

    if (!IS_WEB && !IS_TESTING && tier === 'private') {
        return createNativePrivateStorage(normalizedId, healthKey);
    }

    try {
        if (IS_WEB || IS_TESTING) {
            throw new Error('MMKV is not supported on web or during testing');
        }

        if (tier === 'ephemeral') {
            throw new Error('Ephemeral storage requested');
        }

        const mmkvModule = requireMmkvModule();
        const createMMKV = mmkvModule.createMMKV;

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
