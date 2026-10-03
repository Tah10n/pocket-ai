import * as FileSystem from 'expo-file-system/legacy';
import * as RNFS from 'react-native-fs';
import type { AppStorageFacade } from '../../src/store/storage';
import { ReferenceVoiceStore, REFERENCE_VOICE_LIMITS, type SaveReferenceVoice } from '../../src/services/ReferenceVoiceStore';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function privateStore() {
  const data = new Map<string, string>();
  const storage = {
    set: jest.fn((key: string, value: string | boolean | number | ArrayBuffer) => data.set(key, String(value))),
    getString: jest.fn((key: string) => data.get(key)), getAllKeys: jest.fn(() => [...data.keys()]),
    remove: jest.fn((key: string) => data.delete(key)), clearAll: jest.fn(() => data.clear()),
    contains: jest.fn((key: string) => data.has(key)), getBoolean: jest.fn(), getNumber: jest.fn(),
  } satisfies AppStorageFacade;
  return { data, storage };
}
const sample: SaveReferenceVoice = { sourceUri: 'test-cache/sample.wav', sourceSha256: 'a'.repeat(64),
  sourceMimeType: 'audio/wav', durationMs: 1_000, name: 'My sample', consent: true };

beforeEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
  jest.mocked(FileSystem.getInfoAsync).mockResolvedValue({ exists: true, uri: sample.sourceUri, size: 3, isDirectory: false, modificationTime: 1 });
  jest.mocked(FileSystem.readAsStringAsync).mockResolvedValue('YWJj');
  jest.mocked(FileSystem.writeAsStringAsync).mockResolvedValue(undefined);
  jest.mocked(FileSystem.makeDirectoryAsync).mockResolvedValue(undefined);
  jest.mocked(FileSystem.deleteAsync).mockResolvedValue(undefined);
  jest.mocked(RNFS.hash).mockResolvedValue(sample.sourceSha256);
});

it('stores bounded original bytes only in private shards and cold-hydrates a selection without native work', async () => {
  const { data, storage } = privateStore();
  const store = new ReferenceVoiceStore(() => storage);
  const voice = await store.save(sample);
  store.select(voice.id);
  expect(data.size).toBe(3);
  expect([...data.keys()].every(key => key.startsWith('reference-voices-v1:'))).toBe(true);
  expect([...data.values()].join('')).not.toContain(sample.sourceUri);
  expect(storage.set.mock.calls.some(([, value]) => typeof value === 'string' && value.includes('nativeHandle'))).toBe(false);
  const restarted = new ReferenceVoiceStore(() => storage);
  restarted.hydrate();
  expect(restarted.getState()).toEqual({ voices: [voice], selectedVoiceId: voice.id });
  expect(FileSystem.writeAsStringAsync).not.toHaveBeenCalled();
});

it('requires consent and rejects size/duration before reading a source', async () => {
  const { storage } = privateStore();
  const store = new ReferenceVoiceStore(() => storage);
  await expect(store.save({ ...sample, consent: false })).rejects.toMatchObject({ code: 'consent_required' });
  await expect(store.save({ ...sample, durationMs: REFERENCE_VOICE_LIMITS.durationMs + 1 })).rejects.toMatchObject({ code: 'invalid_source' });
  jest.mocked(FileSystem.getInfoAsync).mockResolvedValue({ exists: true, uri: sample.sourceUri, size: REFERENCE_VOICE_LIMITS.sourceBytes + 1, isDirectory: false, modificationTime: 1 });
  await expect(store.save(sample)).rejects.toMatchObject({ code: 'invalid_source' });
  expect(FileSystem.readAsStringAsync).not.toHaveBeenCalled();
  expect(storage.set).not.toHaveBeenCalled();
});

it('binds saved source to the preparation digest and never deletes the borrowed source', async () => {
  const { storage } = privateStore();
  const store = new ReferenceVoiceStore(() => storage);
  jest.mocked(RNFS.hash).mockResolvedValueOnce('b'.repeat(64));
  await expect(store.save(sample)).rejects.toMatchObject({ code: 'source_changed' });
  const voice = await store.save(sample);
  await store.delete(voice.id);
  expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(sample.sourceUri, expect.anything());
  expect(storage.getAllKeys()).toEqual([]);
});

it('clears selection immediately but retains source until the actual active reference lease drains', async () => {
  const { data, storage } = privateStore();
  const store = new ReferenceVoiceStore(() => storage);
  const voice = await store.save(sample);
  store.select(voice.id);
  const lease = store.acquire(voice.id);
  const deletion = store.delete(voice.id);
  let finished = false;
  void deletion.then(() => { finished = true; });
  expect(store.getState().selectedVoiceId).toBeNull();
  expect(lease.isCurrent()).toBe(false);
  expect(data.has(`reference-voices-v1:${voice.id}:ready`)).toBe(true);
  await Promise.resolve();
  expect(finished).toBe(false);
  await lease.release();
  await deletion;
  expect(data.size).toBe(0);
  await expect(lease.materialize()).rejects.toMatchObject({ code: 'cancelled' });
});

it('waits for a late materialization write and removes its plaintext before releasing deletion', async () => {
  const { storage } = privateStore();
  const store = new ReferenceVoiceStore(() => storage);
  const voice = await store.save(sample);
  const lease = store.acquire(voice.id);
  const write = deferred<void>();
  let writtenUri = '';
  jest.mocked(FileSystem.writeAsStringAsync).mockImplementation(async uri => { writtenUri = uri; await write.promise; });
  const materialization = lease.materialize();
  const failure = expect(materialization).rejects.toMatchObject({ code: 'cancelled' });
  while (!writtenUri) await new Promise(resolve => setTimeout(resolve, 0));
  const deletion = store.delete(voice.id);
  const release = lease.release();
  expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(writtenUri, expect.anything());
  write.resolve();
  jest.mocked(FileSystem.getInfoAsync).mockImplementation(async uri => uri === writtenUri
    ? { exists: false, uri, isDirectory: false } : { exists: true, uri, size: 3, isDirectory: false, modificationTime: 1 });
  await failure;
  await release;
  await deletion;
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith(writtenUri, { idempotent: true });
});

it('private reset invalidates a late save and drains it without publishing a resurrected record', async () => {
  const { data, storage } = privateStore();
  const store = new ReferenceVoiceStore(() => storage);
  const read = deferred<string>();
  jest.mocked(FileSystem.readAsStringAsync).mockReturnValueOnce(read.promise);
  const save = store.save(sample);
  const rejection = expect(save).rejects.toMatchObject({ code: 'cancelled' });
  while (!jest.mocked(FileSystem.readAsStringAsync).mock.calls.length) await Promise.resolve();
  store.invalidate();
  let drained = false;
  const drain = store.drainForPrivateReset().then(() => { drained = true; });
  await Promise.resolve();
  expect(drained).toBe(false);
  read.resolve('YWJj');
  await rejection;
  await drain;
  expect(data.size).toBe(0);
  expect(store.getState().voices).toEqual([]);
});

it('recovers uncommitted shards on cold open and enforces the saved voice quota', async () => {
  const { data, storage } = privateStore();
  const store = new ReferenceVoiceStore(() => storage);
  data.set('reference-voices-v1:abandoned:source:0', 'sensitive uncommitted source');
  data.set('unrelated-private-history', 'keep');
  store.hydrate();
  expect(data.has('reference-voices-v1:abandoned:source:0')).toBe(false);
  for (let index = 0; index < REFERENCE_VOICE_LIMITS.voices; index++) await store.save({ ...sample, name: `Voice ${index}` });
  await expect(store.save(sample)).rejects.toMatchObject({ code: 'quota_exceeded' });
  expect(data.get('unrelated-private-history')).toBe('keep');
});

it('keeps references temporary until explicit Save and deletes only its own plaintext copy', async () => {
  const { data, storage } = privateStore();
  const store = new ReferenceVoiceStore(() => storage);
  const reference = await store.retainTemporarySource(sample);
  expect(data.size).toBe(0);
  expect(reference.isCurrent()).toBe(true);
  expect(FileSystem.copyAsync).toHaveBeenCalledWith({ from: sample.sourceUri, to: reference.uri });
  jest.mocked(FileSystem.getInfoAsync).mockResolvedValue({ exists: false, uri: reference.uri, isDirectory: false });
  await reference.release();
  expect(reference.isCurrent()).toBe(false);
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith(reference.uri, { idempotent: true });
  expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(sample.sourceUri, expect.anything());
});

it('private reset waits for a late temporary-source copy then cleans it without exposing a ready reference', async () => {
  const { storage } = privateStore();
  const store = new ReferenceVoiceStore(() => storage);
  const copy = deferred<void>();
  let destination = '';
  jest.mocked(FileSystem.copyAsync).mockImplementation(async options => { destination = options.to; await copy.promise; });
  const selected = store.retainTemporarySource(sample);
  const rejected = expect(selected).rejects.toMatchObject({ code: 'cancelled' });
  while (!destination) await Promise.resolve();
  store.invalidate();
  let drained = false;
  const drain = store.drainForPrivateReset().then(() => { drained = true; });
  await Promise.resolve();
  expect(drained).toBe(false);
  jest.mocked(FileSystem.getInfoAsync).mockResolvedValue({ exists: false, uri: destination, isDirectory: false });
  copy.resolve();
  await rejected;
  await drain;
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith(destination, { idempotent: true });
});

it('private reset releases a retained temporary sample only after native consumers confirm drain', async () => {
  const { storage } = privateStore();
  const store = new ReferenceVoiceStore(() => storage);
  const reference = await store.retainTemporarySource(sample);
  const consumers = deferred<void>();
  store.invalidate();
  jest.mocked(FileSystem.getInfoAsync).mockResolvedValue({ exists: false, uri: reference.uri, isDirectory: false });
  const drain = store.drainForPrivateReset(consumers.promise);
  await Promise.resolve();
  expect(reference.isCurrent()).toBe(false);
  expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(reference.uri, expect.anything());
  consumers.resolve();
  await drain;
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith(reference.uri, { idempotent: true });
  await reference.release(); // The mounted UI's later cleanup is idempotent.
});
