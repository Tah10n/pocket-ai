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
const HAS_JEST_GLOBAL = typeof (globalThis as unknown as { jest?: unknown }).jest !== 'undefined'
    || typeof (globalThis as unknown as { expect?: unknown }).expect !== 'undefined';
const IS_TESTING = RUNTIME_NODE_ENV === 'test'
    || (RUNTIME_NODE_ENV !== 'production'
        && (HAS_JEST_GLOBAL || typeof getRuntimeEnvValue('JEST_WORKER_ID') === 'string' || getRuntimeEnvValue('EXPO_OS') === 'web'));
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

class PrivateStorageMigrationFailedError extends PrivateStorageUnavailableError {
    readonly retainInProgressMarker: boolean;

    constructor(health: PrivateStorageHealthSnapshot, retainInProgressMarker: boolean) {
        super('migration_failed', health);
        this.name = 'PrivateStorageMigrationFailedError';
        Object.setPrototypeOf(this, PrivateStorageMigrationFailedError.prototype);
        this.retainInProgressMarker = retainInProgressMarker;
    }
}

class PrivateStorageKeyedRecoveryRequiredError extends Error {
    readonly expectedKeys?: readonly string[];

    constructor(expectedKeys?: readonly string[]) {
        super('Private storage requires keyed recovery');
        this.name = 'PrivateStorageKeyedRecoveryRequiredError';
        Object.setPrototypeOf(this, PrivateStorageKeyedRecoveryRequiredError.prototype);
        this.expectedKeys = expectedKeys ? [...expectedKeys] : undefined;
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
const PRIVATE_STORAGE_MIGRATION_IN_PROGRESS_ID = 'pocket-ai-private-mmkv-migration-in-progress';
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

type PrivateStorageInstanceId = (typeof PRIVATE_STORAGE_INSTANCE_IDS)[number];

type PrivateStorageMigrationMarkerPhase = 'pre_encrypt' | 'encrypting' | 'encrypted_verified' | 'reset_required';
type RecoverablePrivateStorageMigrationMarkerPhase = PrivateStorageMigrationMarkerPhase | 'legacy';

type PrivateStorageMigrationMarker =
    | { kind: 'none' }
    | { kind: 'invalid'; raw: string }
    | {
        kind: 'valid';
        storeId: PrivateStorageInstanceId;
        phase: RecoverablePrivateStorageMigrationMarkerPhase;
        legacy: boolean;
    };

const PRIVATE_STORAGE_MIGRATION_MARKER_SCHEMA_VERSION = 1;

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

export function assertPrivateStorageWritable(
    fallbackReason: PrivateStorageBlockReason = 'encryption_not_initialized',
): void {
    if (isPrivateStorageWritable()) {
        return;
    }

    const health = snapshotPrivateStorageHealth();
    const reason =
        health.status === 'blocked' && health.reason
            ? health.reason
            : health.status === 'initializing'
                ? 'encryption_initializing'
                : health.status === 'resetting'
                    ? 'unknown'
                    : fallbackReason;

    if (health.status === 'unknown') {
        throw new PrivateStorageUnavailableError(reason, blockPrivateStorage(reason));
    }

    throw new PrivateStorageUnavailableError(reason, health);
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

function clearPrivateStorageRuntimeCaches(): void {
    for (const storeId of PRIVATE_STORAGE_INSTANCE_IDS) {
        const healthKey = resolveTieredStoreId('private', storeId);
        fallbackStores.delete(healthKey);
        storageHealthById.delete(healthKey);
        warnedFallbackStores.delete(healthKey);
    }
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

type MmkvWithOptionalBuffer = MMKV & {
    getBuffer?: (key: string) => ArrayBuffer | undefined;
};

type TypedMigrationValue =
    | { kind: 'string'; value: string }
    | { kind: 'number'; value: number }
    | { kind: 'boolean'; value: boolean }
    | { kind: 'binary'; value: ArrayBuffer };

type TypedMigrationSnapshot = TypedMigrationValue & {
    key: string;
};

function throwPrivateStorageMigrationFailed(
    options: { retainInProgressMarker?: boolean; requiresExplicitReset?: boolean } = {},
): never {
    const health = blockPrivateStorage('migration_failed', {
        retryable: true,
        requiresExplicitReset: options.requiresExplicitReset ?? false,
    });
    throw new PrivateStorageMigrationFailedError(health, options.retainInProgressMarker ?? false);
}

function throwPrivateStorageKeyedRecoveryRequired(expectedKeys?: readonly string[]): never {
    throw new PrivateStorageKeyedRecoveryRequiredError(expectedKeys);
}

function isPrivateStorageInstanceId(value: string): value is PrivateStorageInstanceId {
    return (PRIVATE_STORAGE_INSTANCE_IDS as readonly string[]).includes(value);
}

function isPrivateStorageMigrationMarkerPhase(value: unknown): value is PrivateStorageMigrationMarkerPhase {
    return value === 'pre_encrypt'
        || value === 'encrypting'
        || value === 'encrypted_verified'
        || value === 'reset_required';
}

function parsePrivateStorageMigrationMarker(raw: string | null): PrivateStorageMigrationMarker {
    if (raw === null) {
        return { kind: 'none' };
    }

    const trimmed = raw.trim();
    if (isPrivateStorageInstanceId(trimmed)) {
        return { kind: 'valid', storeId: trimmed, phase: 'legacy', legacy: true };
    }

    try {
        const parsed = JSON.parse(trimmed) as {
            schemaVersion?: unknown;
            storeId?: unknown;
            phase?: unknown;
        };

        if (
            parsed
            && typeof parsed === 'object'
            && parsed.schemaVersion === PRIVATE_STORAGE_MIGRATION_MARKER_SCHEMA_VERSION
            && typeof parsed.storeId === 'string'
            && isPrivateStorageInstanceId(parsed.storeId)
            && isPrivateStorageMigrationMarkerPhase(parsed.phase)
        ) {
            return {
                kind: 'valid',
                storeId: parsed.storeId,
                phase: parsed.phase,
                legacy: false,
            };
        }
    } catch {
        // Fall through to an invalid marker. A malformed in-progress marker is unsafe to ignore.
    }

    return { kind: 'invalid', raw };
}

async function readPrivateStorageMigrationMarker(): Promise<PrivateStorageMigrationMarker> {
    try {
        return parsePrivateStorageMigrationMarker(
            await SecureStore.getItemAsync(PRIVATE_STORAGE_MIGRATION_IN_PROGRESS_ID),
        );
    } catch {
        throwPrivateStorageMigrationFailed({
            retainInProgressMarker: true,
            requiresExplicitReset: false,
        });
    }
}

function serializePrivateStorageMigrationMarker(
    storeId: PrivateStorageInstanceId,
    phase: PrivateStorageMigrationMarkerPhase,
): string {
    return JSON.stringify({
        schemaVersion: PRIVATE_STORAGE_MIGRATION_MARKER_SCHEMA_VERSION,
        storeId,
        phase,
    });
}

async function writePrivateStorageMigrationMarker(
    storeId: PrivateStorageInstanceId,
    phase: PrivateStorageMigrationMarkerPhase,
): Promise<void> {
    await SecureStore.setItemAsync(
        PRIVATE_STORAGE_MIGRATION_IN_PROGRESS_ID,
        serializePrivateStorageMigrationMarker(storeId, phase),
    );
}

function copyArrayBuffer(value: ArrayBuffer): ArrayBuffer {
    const source = new Uint8Array(value);
    const copy = new Uint8Array(source.length);
    copy.set(source);
    return copy.buffer;
}

function readBufferValue(store: MMKV, key: string): ArrayBuffer | undefined {
    const getBuffer = (store as MmkvWithOptionalBuffer).getBuffer;
    return typeof getBuffer === 'function' ? getBuffer.call(store, key) : undefined;
}

function readTypedMigrationValue(
    store: MMKV,
    key: string,
    options: { recoverableReadFailure?: boolean } = {},
): TypedMigrationValue {
    const matches: TypedMigrationValue[] = [];

    try {
        const stringValue = store.getString(key);
        if (stringValue !== undefined) {
            matches.push({ kind: 'string', value: stringValue });
        }

        const numberValue = store.getNumber(key);
        if (numberValue !== undefined) {
            matches.push({ kind: 'number', value: numberValue });
        }

        const booleanValue = store.getBoolean(key);
        if (booleanValue !== undefined) {
            matches.push({ kind: 'boolean', value: booleanValue });
        }

        const bufferValue = readBufferValue(store, key);
        if (bufferValue !== undefined) {
            matches.push({ kind: 'binary', value: copyArrayBuffer(bufferValue) });
        }
    } catch {
        if (options.recoverableReadFailure) {
            throwPrivateStorageKeyedRecoveryRequired();
        }

        throwPrivateStorageMigrationFailed();
    }

    if (matches.length !== 1) {
        throwPrivateStorageMigrationFailed();
    }

    return matches[0];
}

function captureTypedMigrationSnapshot(
    store: MMKV,
    options: { recoverableReadFailure?: boolean } = {},
): TypedMigrationSnapshot[] {
    let keys: string[] | null = null;

    try {
        keys = store.getAllKeys();
        return keys.map((key) => ({
            key,
            ...readTypedMigrationValue(store, key, options),
        }));
    } catch (error) {
        if (error instanceof PrivateStorageKeyedRecoveryRequiredError) {
            if (keys && options.recoverableReadFailure) {
                throwPrivateStorageKeyedRecoveryRequired(keys);
            }

            throw error;
        }

        if (error instanceof PrivateStorageUnavailableError) {
            throw error;
        }

        if (options.recoverableReadFailure) {
            throwPrivateStorageKeyedRecoveryRequired(keys ?? undefined);
        }

        throwPrivateStorageMigrationFailed();
    }
}

function verifyExpectedTypedMigrationKeys(store: MMKV, expectedKeys?: readonly string[]): void {
    if (!expectedKeys || expectedKeys.length === 0) {
        return;
    }

    try {
        const actualKeys = new Set(store.getAllKeys());
        if (expectedKeys.some((key) => !actualKeys.has(key))) {
            throwPrivateStorageMigrationFailed();
        }
    } catch (error) {
        if (error instanceof PrivateStorageUnavailableError) {
            throw error;
        }

        throwPrivateStorageMigrationFailed();
    }
}

function migrationValuesMatch(expected: TypedMigrationValue, actual: TypedMigrationValue): boolean {
    if (expected.kind !== actual.kind) {
        return false;
    }

    switch (expected.kind) {
        case 'string':
            return actual.kind === 'string' && actual.value === expected.value;
        case 'number':
            return actual.kind === 'number' && Object.is(actual.value, expected.value);
        case 'boolean':
            return actual.kind === 'boolean' && actual.value === expected.value;
        case 'binary': {
            if (actual.kind !== 'binary' || actual.value.byteLength !== expected.value.byteLength) {
                return false;
            }

            const expectedBytes = new Uint8Array(expected.value);
            const actualBytes = new Uint8Array(actual.value);
            return expectedBytes.every((byte, index) => byte === actualBytes[index]);
        }
    }
}

function verifyTypedMigrationSnapshot(store: MMKV, snapshot: TypedMigrationSnapshot[]): void {
    for (const expected of snapshot) {
        const actual = readTypedMigrationValue(store, expected.key);
        if (!migrationValuesMatch(expected, actual)) {
            throwPrivateStorageMigrationFailed();
        }
    }
}

function writeTypedMigrationValue(store: MMKV, entry: TypedMigrationSnapshot): void {
    if (entry.kind === 'binary') {
        store.set(entry.key, copyArrayBuffer(entry.value));
        return;
    }

    store.set(entry.key, entry.value);
}

function restoreTypedMigrationSnapshot(store: MMKV, snapshot: TypedMigrationSnapshot[]): boolean {
    try {
        for (const entry of snapshot) {
            writeTypedMigrationValue(store, entry);
        }
        verifyTypedMigrationSnapshot(store, snapshot);
        return true;
    } catch {
        // Best-effort restore only. The caller still fails closed with a sanitized migration error.
        return false;
    }
}

type WritePrivateStorageMigrationPhase = (phase: PrivateStorageMigrationMarkerPhase) => Promise<void>;

async function encryptOpenedMmkvStore(
    store: MMKV,
    encryptionKeyValue: string,
    writeMigrationPhase?: WritePrivateStorageMigrationPhase,
    options: { allowKeyedRecoveryOnReadFailure?: boolean } = {},
): Promise<void> {
    if (store.isEncrypted) {
        if (options.allowKeyedRecoveryOnReadFailure) {
            try {
                throwPrivateStorageKeyedRecoveryRequired(store.getAllKeys());
            } catch (error) {
                if (error instanceof PrivateStorageKeyedRecoveryRequiredError) {
                    throw error;
                }

                throwPrivateStorageKeyedRecoveryRequired();
            }
        }

        captureTypedMigrationSnapshot(store);
        return;
    }

    const snapshot = captureTypedMigrationSnapshot(store, {
        recoverableReadFailure: options.allowKeyedRecoveryOnReadFailure,
    });
    let didStartEncrypt = false;
    let didVerifyEncrypted = false;

    try {
        await writeMigrationPhase?.('pre_encrypt');
        await writeMigrationPhase?.('encrypting');
        didStartEncrypt = true;
        store.encrypt(encryptionKeyValue, PRIVATE_STORAGE_ENCRYPTION_TYPE);
        verifyTypedMigrationSnapshot(store, snapshot);
        didVerifyEncrypted = true;
        await writeMigrationPhase?.('encrypted_verified');
    } catch (error) {
        if (error instanceof PrivateStorageKeyedRecoveryRequiredError) {
            throw error;
        }

        if (didVerifyEncrypted) {
            const didClearMarker = await clearPrivateStorageMigrationInProgressMarker();
            throwPrivateStorageMigrationFailed({
                retainInProgressMarker: !didClearMarker,
                requiresExplicitReset: !didClearMarker,
            });
        }

        if (didStartEncrypt) {
            const didRestore = restoreTypedMigrationSnapshot(store, snapshot);
            if (!didRestore) {
                try {
                    await writeMigrationPhase?.('reset_required');
                } catch {
                    // Keep the sanitized reset-required health in memory even if durable marker update fails.
                }
            }

            throwPrivateStorageMigrationFailed({
                retainInProgressMarker: !didRestore,
                requiresExplicitReset: !didRestore,
            });
        }

        if (error instanceof PrivateStorageUnavailableError) {
            throw error;
        }

        throwPrivateStorageMigrationFailed();
    }
}

async function encryptMmkvInstance(
    id: PrivateStorageInstanceId,
    encryptionKeyValue: string,
    writeMigrationPhase?: WritePrivateStorageMigrationPhase,
): Promise<void> {
    const mmkvModule = requireMmkvModule();
    const createMMKV = mmkvModule.createMMKV;
    let keyedRecoveryExpectedKeys: readonly string[] | undefined;
    let shouldRequireEncryptedKeyedStore = false;

    try {
        const store = createMMKV({ id });
        await encryptOpenedMmkvStore(store, encryptionKeyValue, writeMigrationPhase, {
            allowKeyedRecoveryOnReadFailure: true,
        });
        return;
    } catch (error) {
        if (error instanceof PrivateStorageKeyedRecoveryRequiredError) {
            keyedRecoveryExpectedKeys = error.expectedKeys;
            shouldRequireEncryptedKeyedStore = !error.expectedKeys;
        }

        if (error instanceof PrivateStorageUnavailableError) {
            throw error;
        }

        if (!(error instanceof PrivateStorageKeyedRecoveryRequiredError)) {
            shouldRequireEncryptedKeyedStore = true;
        }

        // If the store was already encrypted (and can't be opened without a key),
        // try opening it with the configured key. If that still fails, block private
        // storage and wait for an explicit user-confirmed reset instead of deleting data.
        try {
            const store = createMMKV({
                id,
                encryptionKey: encryptionKeyValue,
                encryptionType: PRIVATE_STORAGE_ENCRYPTION_TYPE,
            });

            if (shouldRequireEncryptedKeyedStore && !keyedRecoveryExpectedKeys) {
                throwPrivateStorageMigrationFailed();
            }

            if (shouldRequireEncryptedKeyedStore && !store.isEncrypted) {
                throwPrivateStorageMigrationFailed();
            }

            verifyExpectedTypedMigrationKeys(store, keyedRecoveryExpectedKeys);
            await encryptOpenedMmkvStore(store, encryptionKeyValue, writeMigrationPhase);
            verifyExpectedTypedMigrationKeys(store, keyedRecoveryExpectedKeys);
            return;
        } catch (encryptedOpenError) {
            if (encryptedOpenError instanceof PrivateStorageUnavailableError) {
                throw encryptedOpenError;
            }

            const health = blockPrivateStorage('encrypted_open_failed', {
                retryable: true,
                requiresExplicitReset: true,
            });
            throw new PrivateStorageUnavailableError('encrypted_open_failed', health);
        }
    }
}

async function recoverPrivateStorageMigrationMarker(
    marker: PrivateStorageMigrationMarker,
    encryptionKeyValue: string,
): Promise<void> {
    if (marker.kind === 'none') {
        return;
    }

    if (
        marker.kind === 'invalid'
        || marker.phase === 'legacy'
        || marker.phase === 'encrypting'
        || marker.phase === 'reset_required'
    ) {
        throwPrivateStorageMigrationFailed({
            retainInProgressMarker: true,
            requiresExplicitReset: true,
        });
    }

    try {
        await encryptMmkvInstance(marker.storeId, encryptionKeyValue, (phase) => (
            writePrivateStorageMigrationMarker(marker.storeId, phase)
        ));
    } catch (error) {
        if (error instanceof PrivateStorageMigrationFailedError && !error.retainInProgressMarker) {
            const didClearMarker = await clearPrivateStorageMigrationInProgressMarker();
            if (!didClearMarker) {
                throwPrivateStorageMigrationFailed({
                    retainInProgressMarker: true,
                    requiresExplicitReset: false,
                });
            }
        }

        throw error;
    }

    const didClearMarker = await clearPrivateStorageMigrationInProgressMarker();
    if (!didClearMarker) {
        throwPrivateStorageMigrationFailed({
            retainInProgressMarker: true,
            requiresExplicitReset: false,
        });
    }
}

async function runPrivateStorageMigrations(encryptionKeyValue: string): Promise<void> {
    await recoverPrivateStorageMigrationMarker(
        await readPrivateStorageMigrationMarker(),
        encryptionKeyValue,
    );

    const versionRaw = await SecureStore.getItemAsync(PRIVATE_STORAGE_MIGRATION_VERSION_ID);
    const currentVersion = versionRaw ? Number(versionRaw) : 0;
    const normalizedVersion = Number.isFinite(currentVersion) ? Math.max(0, Math.floor(currentVersion)) : 0;

    if (normalizedVersion >= PRIVATE_STORAGE_MIGRATION_VERSION) {
        return;
    }

    for (const storeId of PRIVATE_STORAGE_INSTANCE_IDS) {
        let wroteInProgressMarker = false;

        try {
            await encryptMmkvInstance(storeId, encryptionKeyValue, async (phase) => {
                await writePrivateStorageMigrationMarker(storeId, phase);
                wroteInProgressMarker = true;
            });

            if (wroteInProgressMarker) {
                const didClearMarker = await clearPrivateStorageMigrationInProgressMarker();
                if (!didClearMarker) {
                    throwPrivateStorageMigrationFailed({
                        retainInProgressMarker: true,
                        requiresExplicitReset: false,
                    });
                }
            }
        } catch (error) {
            const shouldRetainMarker = error instanceof PrivateStorageMigrationFailedError
                && error.retainInProgressMarker;

            if (wroteInProgressMarker && !shouldRetainMarker) {
                const didClearMarker = await clearPrivateStorageMigrationInProgressMarker();
                if (!didClearMarker) {
                    throwPrivateStorageMigrationFailed({
                        retainInProgressMarker: true,
                        requiresExplicitReset: false,
                    });
                }
            }

            throw error;
        }
    }

    await SecureStore.setItemAsync(PRIVATE_STORAGE_MIGRATION_VERSION_ID, String(PRIVATE_STORAGE_MIGRATION_VERSION));
}

async function clearPrivateStorageMigrationInProgressMarker(): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            await SecureStore.deleteItemAsync(PRIVATE_STORAGE_MIGRATION_IN_PROGRESS_ID);
            return true;
        } catch {
            // Retry once; callers decide whether the remaining marker is fatal.
        }
    }

    return false;
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

        clearPrivateStorageRuntimeCaches();

        try {
            if (!IS_WEB && !IS_TESTING) {
                const { deleteMMKV } = requireMmkvModule();
                for (const storeId of PRIVATE_STORAGE_INSTANCE_IDS) {
                    deleteMMKV(storeId);
                }
            }

            try {
                await SecureStore.deleteItemAsync(PRIVATE_STORAGE_ENCRYPTION_KEY_ID);
            } catch {
                // SecureStore cleanup may be unavailable in unsupported environments; initialization will re-check below.
            }
            try {
                await SecureStore.deleteItemAsync(PRIVATE_STORAGE_MIGRATION_VERSION_ID);
            } catch {
                // SecureStore cleanup may be unavailable in unsupported environments; initialization will re-check below.
            }
            try {
                await SecureStore.deleteItemAsync(PRIVATE_STORAGE_MIGRATION_IN_PROGRESS_ID);
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
