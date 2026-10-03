import * as FileSystem from 'expo-file-system/legacy';
import * as RNFS from 'react-native-fs';
import { getAppStorage, type AppStorageFacade } from '../store/storage';
import { assertPrivateStorageWritable } from './storage';
import { normalizeSha256Digest } from '../utils/sha256';
import { fileUriToNativePath } from '../utils/safeFilePath';

export const REFERENCE_VOICE_LIMITS = Object.freeze({
  voices: 4, sourceBytes: 2 * 1024 * 1024, totalSourceBytes: 8 * 1024 * 1024,
  durationMs: 8_000, transcriptCharacters: 240, nameCharacters: 60, shardCharacters: 64 * 1024,
});
const PREFIX = 'reference-voices-v1:';
const SELECTION_KEY = `${PREFIX}selection`;
const ID = /^[a-z0-9-]{1,80}$/u;
const MIME_EXTENSIONS = { 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a' } as const;

export type ReferenceVoiceErrorCode = 'consent_required' | 'quota_exceeded' | 'invalid_source'
  | 'source_changed' | 'voice_missing' | 'cancelled' | 'storage_failed';
export class ReferenceVoiceError extends Error {
  constructor(readonly code: ReferenceVoiceErrorCode) { super(code); this.name = 'ReferenceVoiceError'; }
}
export interface ReferenceVoice {
  readonly id: string;
  readonly name: string;
  readonly sourceSha256: string;
  readonly sourceBytes: number;
  readonly durationMs: number;
  readonly sourceMimeType: keyof typeof MIME_EXTENSIONS;
  readonly createdAt: number;
  readonly consentRecordedAt: number;
  readonly language?: string;
  readonly refText?: string;
}
interface VoiceManifest { version: 1; voice: ReferenceVoice; generation: string; shards: number; base64Characters: number }
export interface ReferenceVoiceStoreState { readonly voices: readonly ReferenceVoice[]; readonly selectedVoiceId: string | null }
export interface SaveReferenceVoice {
  sourceUri: string;
  sourceSha256: string;
  durationMs: number;
  sourceMimeType: ReferenceVoice['sourceMimeType'];
  name: string;
  consent: boolean;
  language?: string;
  refText?: string;
}
export interface ReferenceVoiceLease {
  readonly voice: ReferenceVoice;
  isCurrent(): boolean;
  materialize(): Promise<{ uri: string; release(): Promise<void> }>;
  release(): Promise<void>;
}
export interface TemporaryReferenceSource {
  readonly uri: string;
  readonly sourceSha256: string;
  readonly durationMs: number;
  readonly sourceMimeType: ReferenceVoice['sourceMimeType'];
  isCurrent(): boolean;
  release(): Promise<void>;
}
interface OwnedLease { readonly drained: Promise<void>; invalidate(): void; releaseTemporary?: () => Promise<void> }

function parseManifest(raw: string | undefined, id: string): VoiceManifest | null {
  if (!raw || raw.length > 4096) return null;
  try {
    const value = JSON.parse(raw) as VoiceManifest;
    const voice = value.voice;
    if (value.version !== 1 || !voice || voice.id !== id || !ID.test(id)
      || !ID.test(value.generation) || typeof voice.name !== 'string' || !voice.name.trim()
      || voice.name.length > REFERENCE_VOICE_LIMITS.nameCharacters
      || normalizeSha256Digest(voice.sourceSha256) !== voice.sourceSha256
      || !Number.isSafeInteger(voice.sourceBytes) || voice.sourceBytes < 1 || voice.sourceBytes > REFERENCE_VOICE_LIMITS.sourceBytes
      || !Number.isFinite(voice.durationMs) || voice.durationMs <= 0 || voice.durationMs > REFERENCE_VOICE_LIMITS.durationMs
      || !Object.hasOwn(MIME_EXTENSIONS, voice.sourceMimeType)
      || !Number.isSafeInteger(voice.createdAt) || voice.createdAt < 0
      || !Number.isSafeInteger(voice.consentRecordedAt) || voice.consentRecordedAt < 0
      || (voice.language !== undefined && (typeof voice.language !== 'string' || !voice.language || voice.language.length > 32))
      || (voice.refText !== undefined && (typeof voice.refText !== 'string' || voice.refText.length > REFERENCE_VOICE_LIMITS.transcriptCharacters))
      || value.base64Characters !== 4 * Math.ceil(voice.sourceBytes / 3)
      || value.shards !== Math.ceil(value.base64Characters / REFERENCE_VOICE_LIMITS.shardCharacters)) return null;
    // Read a whitelist. Native handles, PCM, arbitrary paths and extra properties never survive hydration.
    return { version: 1, generation: value.generation, shards: value.shards, base64Characters: value.base64Characters,
      voice: { id, name: voice.name, sourceSha256: voice.sourceSha256, sourceBytes: voice.sourceBytes,
        durationMs: voice.durationMs, sourceMimeType: voice.sourceMimeType, createdAt: voice.createdAt,
        consentRecordedAt: voice.consentRecordedAt,
        ...(voice.language === undefined ? {} : { language: voice.language }),
        ...(voice.refText === undefined ? {} : { refText: voice.refText }) } };
  } catch { return null; }
}
const readyKey = (id: string) => `${PREFIX}${id}:ready`;
const shardKey = (id: string, generation: string, shard: number) => `${PREFIX}${id}:${generation}:${shard}`;
const yieldControl = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const sourceDirectory = () => FileSystem.cacheDirectory ? `${FileSystem.cacheDirectory.replace(/\/?$/u, '/')}audio-reference/` : null;

/** Bounded original samples in the existing encrypted private store; no native objects are persisted. */
export class ReferenceVoiceStore {
  private state: ReferenceVoiceStoreState = { voices: [], selectedVoiceId: null };
  private readonly listeners = new Set<() => void>();
  private readonly leases = new Map<string, Set<OwnedLease>>();
  private readonly deleted = new Set<string>();
  private epoch = 0;
  private sequence = 0;
  private activeSave = false;
  private activeSaveDrain: Promise<void> | null = null;
  private cleanupBlocked = false;
  constructor(private readonly storageProvider: () => AppStorageFacade = getAppStorage) {}
  getState = (): ReferenceVoiceStoreState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private publish(state: ReferenceVoiceStoreState): void {
    this.state = state;
    for (const listener of this.listeners) { try { listener(); } catch { /* View failures cannot block cleanup. */ } }
  }
  private manifests(storage: AppStorageFacade): VoiceManifest[] {
    const records: VoiceManifest[] = [];
    for (const key of storage.getAllKeys().filter(key => key.startsWith(PREFIX) && key.endsWith(':ready'))) {
      const id = key.slice(PREFIX.length, -':ready'.length);
      const manifest = parseManifest(storage.getString(key), id);
      if (manifest && !this.deleted.has(id)) records.push(manifest);
    }
    if (records.length > REFERENCE_VOICE_LIMITS.voices
      || records.reduce((bytes, entry) => bytes + entry.voice.sourceBytes, 0) > REFERENCE_VOICE_LIMITS.totalSourceBytes) {
      throw new ReferenceVoiceError('quota_exceeded');
    }
    return records;
  }
  /** Opening saved voices restores metadata only and starts no audio/native work. */
  hydrate(): void {
    assertPrivateStorageWritable();
    const storage = this.storageProvider();
    const voices = this.manifests(storage).map(entry => entry.voice);
    const selected = storage.getString(SELECTION_KEY);
    if (!this.activeSave) {
      const retained = new Set<string>();
      for (const manifest of this.manifests(storage)) {
        retained.add(readyKey(manifest.voice.id));
        for (let shard = 0; shard < manifest.shards; shard++) retained.add(shardKey(manifest.voice.id, manifest.generation, shard));
      }
      for (const key of storage.getAllKeys()) {
        if (!key.startsWith(PREFIX) || key === SELECTION_KEY || retained.has(key)) continue;
        // An invalidated consumer can still be draining native work and reading its source.
        if (Array.from(this.leases.keys()).some(id => key.startsWith(`${PREFIX}${id}:`))) continue;
        storage.remove(key);
      }
      if (selected && !voices.some(voice => voice.id === selected)) storage.remove(SELECTION_KEY);
    }
    this.publish({ voices, selectedVoiceId: voices.some(voice => voice.id === selected) ? selected! : null });
  }
  select(id: string | null): void {
    assertPrivateStorageWritable();
    if (id !== null && !this.state.voices.some(voice => voice.id === id && !this.deleted.has(id))) {
      throw new ReferenceVoiceError('voice_missing');
    }
    const storage = this.storageProvider();
    if (id === null) storage.remove(SELECTION_KEY); else storage.set(SELECTION_KEY, id);
    this.publish({ ...this.state, selectedVoiceId: id });
  }
  /** Explicit sample selection only: copy a borrowed picker/recorder source into a short plaintext cache lease. */
  async retainTemporarySource(input: Pick<SaveReferenceVoice, 'sourceUri' | 'sourceSha256' | 'sourceMimeType' | 'durationMs'>,
    options: { signal?: AbortSignal; assertCurrent?: () => void } = {}): Promise<TemporaryReferenceSource> {
    assertPrivateStorageWritable();
    if (this.cleanupBlocked || Array.from(this.leases.keys()).some(id => id.startsWith('voice-tmp-'))) {
      throw new ReferenceVoiceError('storage_failed');
    }
    const digest = normalizeSha256Digest(input.sourceSha256);
    const directory = sourceDirectory();
    if (!digest || !directory || !Object.hasOwn(MIME_EXTENSIONS, input.sourceMimeType)
      || !Number.isFinite(input.durationMs) || input.durationMs <= 0 || input.durationMs > REFERENCE_VOICE_LIMITS.durationMs) {
      throw new ReferenceVoiceError('invalid_source');
    }
    const epoch = this.epoch;
    const id = `voice-tmp-${Date.now().toString(36)}-${(++this.sequence).toString(36)}`;
    const uri = `${directory}ref-${id}.${MIME_EXTENSIONS[input.sourceMimeType]}`;
    let invalidated = false;
    let released = false;
    let copyIssued = false;
    let finishDrain!: () => void;
    let work: Promise<void> | null = null;
    let releaseWork: Promise<void> | null = null;
    const isCurrent = () => !invalidated && !released && epoch === this.epoch && !options.signal?.aborted;
    const check = () => { assertPrivateStorageWritable(); options.assertCurrent?.(); if (!isCurrent()) throw new ReferenceVoiceError('cancelled'); };
    const owned: OwnedLease = { drained: new Promise(resolve => { finishDrain = resolve; }), invalidate: () => { invalidated = true; },
      releaseTemporary: () => release() };
    const owners = new Set([owned]);
    this.leases.set(id, owners);
    const release = (): Promise<void> => {
      invalidated = true;
      if (released) return Promise.resolve();
      if (releaseWork) return releaseWork;
      const operation = (async () => {
        try { await work; } catch { /* Clean any owned partial copy. */ }
        if (copyIssued) {
          await FileSystem.deleteAsync(uri, { idempotent: true });
          if ((await FileSystem.getInfoAsync(uri)).exists) throw new ReferenceVoiceError('storage_failed');
        }
        released = true;
        this.leases.delete(id);
        finishDrain();
      })();
      releaseWork = operation;
      void operation.catch(() => { if (releaseWork === operation) releaseWork = null; });
      return operation;
    };
    work = (async () => {
      check();
      const info = await FileSystem.getInfoAsync(input.sourceUri);
      check();
      if (!info.exists || info.isDirectory || !info.size || info.size > REFERENCE_VOICE_LIMITS.sourceBytes) {
        throw new ReferenceVoiceError('invalid_source');
      }
      await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
      check();
      copyIssued = true;
      await FileSystem.copyAsync({ from: input.sourceUri, to: uri });
      check();
      const copied = await FileSystem.getInfoAsync(uri);
      if (!copied.exists || copied.isDirectory || copied.size !== info.size
        || normalizeSha256Digest(await RNFS.hash(fileUriToNativePath(uri), 'sha256')) !== digest) {
        throw new ReferenceVoiceError('source_changed');
      }
      check();
    })();
    try {
      await work;
      return { uri, sourceSha256: digest, durationMs: input.durationMs, sourceMimeType: input.sourceMimeType, isCurrent, release };
    } catch (error) {
      await release();
      throw error;
    }
  }
  async save(input: SaveReferenceVoice, options: { signal?: AbortSignal; assertCurrent?: () => void } = {}): Promise<ReferenceVoice> {
    if (!input.consent) throw new ReferenceVoiceError('consent_required');
    if (this.activeSave) throw new ReferenceVoiceError('storage_failed');
    const name = input.name.trim();
    const digest = normalizeSha256Digest(input.sourceSha256);
    if (!name || name.length > REFERENCE_VOICE_LIMITS.nameCharacters || !digest
      || !Number.isFinite(input.durationMs) || input.durationMs <= 0 || input.durationMs > REFERENCE_VOICE_LIMITS.durationMs
      || !Object.hasOwn(MIME_EXTENSIONS, input.sourceMimeType)
      || (input.language !== undefined && (!input.language || input.language.length > 32))
      || (input.refText !== undefined && input.refText.length > REFERENCE_VOICE_LIMITS.transcriptCharacters)) {
      throw new ReferenceVoiceError('invalid_source');
    }
    const epoch = this.epoch;
    const check = () => {
      assertPrivateStorageWritable();
      options.assertCurrent?.();
      if (options.signal?.aborted || epoch !== this.epoch) throw new ReferenceVoiceError('cancelled');
    };
    check();
    const storage = this.storageProvider();
    this.activeSave = true;
    let finishSave!: () => void;
    this.activeSaveDrain = new Promise(resolve => { finishSave = resolve; });
    const id = `voice-${Date.now().toString(36)}-${(++this.sequence).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const generation = `source-${this.sequence.toString(36)}`;
    const written: string[] = [];
    let committed = false;
    try {
      const info = await FileSystem.getInfoAsync(input.sourceUri);
      check();
      if (!info.exists || info.isDirectory || !Number.isSafeInteger(info.size) || info.size < 1
        || info.size > REFERENCE_VOICE_LIMITS.sourceBytes) throw new ReferenceVoiceError('invalid_source');
      const existing = this.manifests(storage);
      if (existing.length >= REFERENCE_VOICE_LIMITS.voices
        || existing.reduce((sum, entry) => sum + entry.voice.sourceBytes, 0) + info.size > REFERENCE_VOICE_LIMITS.totalSourceBytes) {
        throw new ReferenceVoiceError('quota_exceeded');
      }
      if (normalizeSha256Digest(await RNFS.hash(fileUriToNativePath(input.sourceUri), 'sha256')) !== digest) {
        throw new ReferenceVoiceError('source_changed');
      }
      check();
      const encoded = await FileSystem.readAsStringAsync(input.sourceUri, { encoding: FileSystem.EncodingType.Base64 });
      check();
      if (encoded.length !== 4 * Math.ceil(info.size / 3) || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) {
        throw new ReferenceVoiceError('invalid_source');
      }
      // Revalidate bytes after reading: the immutable digest binds preprocessing and saved source.
      if (normalizeSha256Digest(await RNFS.hash(fileUriToNativePath(input.sourceUri), 'sha256')) !== digest) {
        throw new ReferenceVoiceError('source_changed');
      }
      check();
      for (let offset = 0; offset < encoded.length; offset += REFERENCE_VOICE_LIMITS.shardCharacters) {
        check();
        const key = shardKey(id, generation, written.length);
        written.push(key);
        storage.set(key, encoded.slice(offset, offset + REFERENCE_VOICE_LIMITS.shardCharacters));
        await yieldControl();
      }
      check();
      const now = Date.now();
      const voice: ReferenceVoice = { id, name, sourceSha256: digest, sourceBytes: info.size, durationMs: input.durationMs,
        sourceMimeType: input.sourceMimeType, createdAt: now, consentRecordedAt: now,
        ...(input.language === undefined ? {} : { language: input.language }),
        ...(input.refText === undefined ? {} : { refText: input.refText }) };
      const manifest: VoiceManifest = { version: 1, voice, generation, shards: written.length, base64Characters: encoded.length };
      storage.set(readyKey(id), JSON.stringify(manifest));
      check();
      this.hydrate();
      committed = true;
      return voice;
    } finally {
      if (!committed) {
        for (const key of [...written, readyKey(id)]) { try { storage.remove(key); } catch { /* Unpublished data stays unreadable. */ } }
      }
      this.activeSave = false;
      this.activeSaveDrain = null;
      finishSave();
    }
  }
  acquire(id: string): ReferenceVoiceLease {
    assertPrivateStorageWritable();
    if (this.cleanupBlocked) throw new ReferenceVoiceError('storage_failed');
    const storage = this.storageProvider();
    const manifest = ID.test(id) ? parseManifest(storage.getString(readyKey(id)), id) : null;
    if (!manifest || this.deleted.has(id)) throw new ReferenceVoiceError('voice_missing');
    const epoch = this.epoch;
    let invalidated = false;
    let released = false;
    let uri: string | null = null;
    let work: Promise<{ uri: string; release(): Promise<void> }> | null = null;
    let releaseWork: Promise<void> | null = null;
    let finishDrain!: () => void;
    const owned: OwnedLease = { drained: new Promise(resolve => { finishDrain = resolve; }), invalidate: () => { invalidated = true; } };
    const owners = this.leases.get(id) ?? new Set<OwnedLease>();
    owners.add(owned);
    this.leases.set(id, owners);
    const isCurrent = () => !released && !invalidated && epoch === this.epoch && !this.deleted.has(id);
    const check = () => { if (!isCurrent()) throw new ReferenceVoiceError('cancelled'); assertPrivateStorageWritable(); };
    const release = (): Promise<void> => {
      if (released) return Promise.resolve();
      invalidated = true;
      if (releaseWork) return releaseWork;
      const operation = (async () => {
        try { await work; } catch { /* A partial materialization is still owned below. */ }
        if (uri) {
          await FileSystem.deleteAsync(uri, { idempotent: true });
          if ((await FileSystem.getInfoAsync(uri)).exists) throw new ReferenceVoiceError('storage_failed');
          uri = null;
        }
        released = true;
        owners.delete(owned);
        if (!owners.size) this.leases.delete(id);
        finishDrain();
      })();
      releaseWork = operation;
      void operation.catch(() => { if (releaseWork === operation) releaseWork = null; });
      return operation;
    };
    const materialize = (): Promise<{ uri: string; release(): Promise<void> }> => {
      if (work) return work;
      work = (async () => {
        check();
        const parts: string[] = [];
        for (let shard = 0; shard < manifest.shards; shard++) {
          check();
          const raw = storage.getString(shardKey(id, manifest.generation, shard));
          if (!raw || raw.length > REFERENCE_VOICE_LIMITS.shardCharacters || !/^[A-Za-z0-9+/]*={0,2}$/u.test(raw)) {
            throw new ReferenceVoiceError('invalid_source');
          }
          parts.push(raw);
          await yieldControl();
        }
        check();
        const encoded = parts.join('');
        if (encoded.length !== manifest.base64Characters) throw new ReferenceVoiceError('invalid_source');
        const directory = sourceDirectory();
        if (!directory) throw new ReferenceVoiceError('storage_failed');
        await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
        check();
        uri = `${directory}ref-${id}-${(++this.sequence).toString(36)}.${MIME_EXTENSIONS[manifest.voice.sourceMimeType]}`;
        await FileSystem.writeAsStringAsync(uri, encoded, { encoding: FileSystem.EncodingType.Base64 });
        check();
        const info = await FileSystem.getInfoAsync(uri);
        if (!info.exists || info.isDirectory || info.size !== manifest.voice.sourceBytes
          || normalizeSha256Digest(await RNFS.hash(fileUriToNativePath(uri), 'sha256')) !== manifest.voice.sourceSha256) {
          throw new ReferenceVoiceError('source_changed');
        }
        check();
        return { uri, release };
      })();
      return work;
    };
    return { voice: manifest.voice, isCurrent, materialize, release };
  }
  async delete(id: string): Promise<void> {
    if (!ID.test(id)) throw new ReferenceVoiceError('voice_missing');
    assertPrivateStorageWritable();
    this.deleted.add(id); // Invalidate before notifying active consumers and waiting for real native drain.
    for (const owner of this.leases.get(id) ?? []) owner.invalidate();
    const storage = this.storageProvider();
    if (this.state.selectedVoiceId === id || storage.getString(SELECTION_KEY) === id) storage.remove(SELECTION_KEY);
    this.publish({ voices: this.state.voices.filter(voice => voice.id !== id),
      selectedVoiceId: this.state.selectedVoiceId === id ? null : this.state.selectedVoiceId });
    await Promise.all(Array.from(this.leases.get(id) ?? [], lease => lease.drained));
    assertPrivateStorageWritable();
    for (const key of storage.getAllKeys()) if (key.startsWith(`${PREFIX}${id}:`)) storage.remove(key);
    this.deleted.delete(id);
    // The sample was copied into encrypted data; a borrowed chat/picker source is never deleted.
  }
  invalidate(): void {
    ++this.epoch;
    for (const owners of this.leases.values()) for (const owner of owners) owner.invalidate();
    this.publish({ voices: [], selectedVoiceId: null });
  }
  /** Release temporary copies only after the caller confirms recorder/TTS/preview consumers have stopped. */
  async drainForPrivateReset(consumersDrained: Promise<unknown> = Promise.resolve()): Promise<void> {
    await Promise.all([consumersDrained, this.activeSaveDrain]);
    await Promise.all(Array.from(this.leases.values()).flatMap(owners => Array.from(owners,
      owner => owner.releaseTemporary?.())));
    await Promise.all(Array.from(this.leases.values()).flatMap(owners => Array.from(owners, owner => owner.drained)));
  }
  resetRuntime(): void { this.invalidate(); this.deleted.clear(); }
  async cleanupCold(): Promise<void> {
    if (this.leases.size) throw new ReferenceVoiceError('storage_failed');
    this.cleanupBlocked = true;
    const directory = sourceDirectory();
    if (!directory) throw new ReferenceVoiceError('storage_failed');
    if (!(await FileSystem.getInfoAsync(directory)).exists) { this.cleanupBlocked = false; return; }
    for (const name of await FileSystem.readDirectoryAsync(directory)) {
      if (!/^ref-voice-[a-z0-9-]+\.(?:wav|mp3|m4a)$/u.test(name)) throw new ReferenceVoiceError('storage_failed');
      const uri = `${directory}${name}`;
      const info = await FileSystem.getInfoAsync(uri);
      if (info.isDirectory) throw new ReferenceVoiceError('storage_failed');
      await FileSystem.deleteAsync(uri, { idempotent: true });
      if ((await FileSystem.getInfoAsync(uri)).exists) throw new ReferenceVoiceError('storage_failed');
    }
    this.cleanupBlocked = false;
  }
}
export const referenceVoiceStore = new ReferenceVoiceStore();
