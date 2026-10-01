import { getAppStorage, type AppStorageFacade } from '../store/storage';
import type { DocumentContextChunk } from './DocumentContextService';
import {
  DOCUMENT_RETRIEVAL_LIMITS as LIMITS, DocumentRetrievalError,
  documentIndexFingerprint, type DocumentIndexIdentity,
} from '../types/documentRetrieval';
import { utf8Bytes } from './LocalToolLimits';
import { isPrivateStorageWritable, PrivateStorageUnavailableError } from './storage';

export interface DocumentIndexRow {
  /** Index stays the original structural index; start/end refer to its UTF-16 text. */
  chunk: DocumentContextChunk;
  start: number;
  end: number;
  vector: number[];
}

export interface PrivateDocumentIndex {
  identity: DocumentIndexIdentity;
  rows: DocumentIndexRow[];
}

interface IndexManifest {
  version: 1;
  scope: string;
  job: string;
  identity: DocumentIndexIdentity;
  fingerprint: string;
  rowCount: number;
  shards: number;
  bytes: number;
}

const PREFIX = 'document-retrieval-v1:';
const SHA256 = /^[0-9a-f]{64}$/u;
const yieldControl = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function scopeKey(threadId: string, attachmentId: string): string {
  if (!threadId || !attachmentId || threadId.length > 256 || attachmentId.length > 256) {
    throw new DocumentRetrievalError('ownership_changed');
  }
  return `${PREFIX}${encodeURIComponent(threadId)}:${encodeURIComponent(attachmentId)}:`;
}

function hasCommittedOwner(scope: string, owners: ReadonlyMap<string, ReadonlySet<string>>): boolean {
  const parts = scope.slice(PREFIX.length, -1).split(':');
  if (parts.length !== 2) return false;
  try {
    const [threadId, attachmentId] = parts.map(part => decodeURIComponent(part));
    return scopeKey(threadId, attachmentId) === scope && owners.get(threadId)?.has(attachmentId) === true;
  } catch { return false; }
}

export function validateDocumentVector(vector: readonly number[], dimensions?: number): number[] {
  if (!Array.isArray(vector) || !vector.length || vector.length > LIMITS.dimensions
    || (dimensions !== undefined && vector.length !== dimensions)) {
    throw new DocumentRetrievalError('invalid_vector');
  }
  let normSquared = 0;
  const values = vector.map(value => {
    const normalized = Math.fround(value);
    if (typeof value !== 'number' || !Number.isFinite(normalized)) {
      throw new DocumentRetrievalError('invalid_vector');
    }
    normSquared += normalized * normalized;
    return normalized;
  });
  // This store's only metric is cosine on explicitly L2-normalized pooled output.
  if (!Number.isFinite(normSquared) || Math.abs(normSquared - 1) > 0.02) {
    throw new DocumentRetrievalError('invalid_vector');
  }
  return values;
}

function validateIdentity(identity: DocumentIndexIdentity): void {
  if (!identity || !SHA256.test(identity.documentSha256) || !SHA256.test(identity.modelSha256)
    || !Number.isSafeInteger(identity.dimensions) || identity.dimensions < 1 || identity.dimensions > LIMITS.dimensions
    || !Number.isSafeInteger(identity.modelBytes) || identity.modelBytes < 1
    || !['mean', 'cls', 'last'].includes(identity.pooling) || identity.normalization !== 2
    || identity.vectorFormat !== 'float32'
    || [identity.extractionIdentity, identity.chunkingVersion, identity.preprocessingVersion,
      identity.modelRevision, identity.tokenizerIdentity, identity.queryPrefix, identity.documentPrefix,
      identity.runtimeIdentity].some(value => typeof value !== 'string' || value.length > 4096)) {
    throw new DocumentRetrievalError('index_stale');
  }
}

function validateRow(row: DocumentIndexRow, dimensions: number): DocumentIndexRow {
  const chunk = row?.chunk;
  if (!chunk || typeof chunk.text !== 'string' || !chunk.text.length || chunk.text.length > LIMITS.subchunkCharacters
    || !Number.isSafeInteger(chunk.index) || chunk.index < 0 || chunk.index >= LIMITS.structuralChunks
    || !Number.isSafeInteger(row.start) || row.start < 0 || !Number.isSafeInteger(row.end)
    || row.end <= row.start || row.end - row.start !== chunk.text.length
    || row.end > LIMITS.structuralChunkCharacters
    || (chunk.kind !== undefined && !['code', 'heading', 'list', 'paragraph', 'sheet', 'slide', 'table', 'unknown'].includes(chunk.kind))
    || ((chunk.sourceStart === undefined) !== (chunk.sourceEnd === undefined))
    || (chunk.sourceStart !== undefined && chunk.sourceEnd !== undefined
      && chunk.sourceEnd - chunk.sourceStart !== chunk.text.length)
    || (chunk.heading !== undefined && (typeof chunk.heading !== 'string' || chunk.heading.length > 4000))
    || (chunk.sheetName !== undefined && (typeof chunk.sheetName !== 'string' || chunk.sheetName.length > 512))
    || (chunk.assetIds !== undefined && (!Array.isArray(chunk.assetIds) || chunk.assetIds.length > 128
      || chunk.assetIds.some(value => !Number.isSafeInteger(value) || value < 0)))
    || [chunk.pageNumber, chunk.slideNumber, chunk.sourceStart, chunk.sourceEnd].some(
      value => value !== undefined && (!Number.isSafeInteger(value) || value < 0),
    )) {
    throw new DocumentRetrievalError('index_stale');
  }
  const safeChunk: DocumentContextChunk = {
    index: chunk.index, text: chunk.text,
    ...(chunk.kind === undefined ? {} : { kind: chunk.kind }),
    ...(chunk.heading === undefined ? {} : { heading: chunk.heading }),
    ...(chunk.pageNumber === undefined ? {} : { pageNumber: chunk.pageNumber }),
    ...(chunk.slideNumber === undefined ? {} : { slideNumber: chunk.slideNumber }),
    ...(chunk.sheetName === undefined ? {} : { sheetName: chunk.sheetName }),
    ...(chunk.assetIds === undefined ? {} : { assetIds: [...chunk.assetIds] }),
    ...(chunk.sourceStart === undefined ? {} : { sourceStart: chunk.sourceStart }),
    ...(chunk.sourceEnd === undefined ? {} : { sourceEnd: chunk.sourceEnd }),
  };
  return { chunk: safeChunk, start: row.start, end: row.end, vector: validateDocumentVector(row.vector, dimensions) };
}

function isManifest(value: unknown, scope: string): value is IndexManifest {
  if (!value || typeof value !== 'object') return false;
  const manifest = value as IndexManifest;
  return manifest.version === 1 && manifest.scope === scope
    && typeof manifest.job === 'string' && /^[a-z0-9-]{1,80}$/u.test(manifest.job)
    && typeof manifest.fingerprint === 'string' && manifest.fingerprint.length <= 32768
    && Number.isSafeInteger(manifest.rowCount) && manifest.rowCount > 0 && manifest.rowCount <= LIMITS.subchunks
    && Number.isSafeInteger(manifest.shards) && manifest.shards > 0 && manifest.shards <= LIMITS.subchunks
    && Number.isSafeInteger(manifest.bytes) && manifest.bytes > 0 && manifest.bytes <= LIMITS.indexBytes;
}

/** Small encrypted MMKV shards; only the final manifest makes a generation readable. */
export class DocumentIndexStore {
  private epochs = new Map<string, number>();
  private globalEpoch = 0;
  private activeWrite = false;
  private sequence = 0;

  constructor(private readonly storageProvider: () => AppStorageFacade = getAppStorage) {}

  private assertCurrent(scope: string, epoch: number, globalEpoch: number, check: () => void): void {
    check();
    if (globalEpoch !== this.globalEpoch || epoch !== (this.epochs.get(scope) ?? 0)) {
      throw new DocumentRetrievalError('ownership_changed');
    }
  }

  /** Only a failed derived-record write can become an ordinary cache failure. */
  private writeRecord(storage: AppStorageFacade, key: string, value: string, check: () => void): void {
    try { storage.set(key, value); } catch (error) {
      check();
      if (error instanceof PrivateStorageUnavailableError || error instanceof DocumentRetrievalError) throw error;
      if (!isPrivateStorageWritable()) throw new DocumentRetrievalError('ownership_changed');
      throw new DocumentRetrievalError('cache_write_failed');
    }
  }

  /** Startup additionally purges ready generations whose committed document owner disappeared. */
  public reconcile(committedOwners?: ReadonlyMap<string, ReadonlySet<string>>): void {
    if (this.activeWrite) return;
    const storage = this.storageProvider();
    const keys = storage.getAllKeys().filter(key => key.startsWith(PREFIX));
    const retained = new Set<string>();
    for (const key of keys.filter(value => value.endsWith('ready'))) {
      const scope = key.slice(0, -'ready'.length);
      const manifest = this.readManifest(storage, scope);
      if (manifest && (!committedOwners || hasCommittedOwner(scope, committedOwners))) {
        retained.add(key);
        for (let shard = 0; shard < manifest.shards; shard++) retained.add(`${scope}${manifest.job}:${shard}`);
      }
    }
    for (const key of keys) if (!retained.has(key)) storage.remove(key);
  }

  private readManifest(storage: AppStorageFacade, scope: string): IndexManifest | null {
    const raw = storage.getString(`${scope}ready`);
    if (!raw || utf8Bytes(raw) > 65536) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isManifest(parsed, scope)) return null;
      validateIdentity(parsed.identity);
      return parsed.fingerprint === documentIndexFingerprint(parsed.identity) ? parsed : null;
    } catch { return null; }
  }

  public async read(
    threadId: string, attachmentId: string, identity: DocumentIndexIdentity, check: () => void,
  ): Promise<PrivateDocumentIndex | null> {
    check();
    validateIdentity(identity);
    const scope = scopeKey(threadId, attachmentId);
    const epoch = this.epochs.get(scope) ?? 0;
    const globalEpoch = this.globalEpoch;
    const storage = this.storageProvider();
    const manifest = this.readManifest(storage, scope);
    if (!manifest || manifest.fingerprint !== documentIndexFingerprint(identity)) return null;
    let bytes = 0;
    const rows: DocumentIndexRow[] = [];
    const seen = new Set<string>();
    try {
      for (let shard = 0; shard < manifest.shards; shard++) {
        this.assertCurrent(scope, epoch, globalEpoch, check);
        const raw = storage.getString(`${scope}${manifest.job}:${shard}`);
        if (!raw || utf8Bytes(raw) > LIMITS.shardBytes) throw new DocumentRetrievalError('index_stale');
        bytes += utf8Bytes(raw);
        if (bytes > LIMITS.indexBytes) throw new DocumentRetrievalError('quota_exceeded');
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed) || !parsed.length || parsed.length > LIMITS.shardRows
          || rows.length + parsed.length > manifest.rowCount) throw new DocumentRetrievalError('index_stale');
        for (const value of parsed) {
          const row = validateRow(value, identity.dimensions);
          const id = `${row.chunk.index}:${row.start}:${row.end}`;
          if (seen.has(id)) throw new DocumentRetrievalError('index_stale');
          seen.add(id);
          rows.push(row);
        }
        await yieldControl();
      }
      this.assertCurrent(scope, epoch, globalEpoch, check);
      if (bytes !== manifest.bytes || rows.length !== manifest.rowCount) throw new DocumentRetrievalError('index_stale');
      return { identity, rows };
    } catch (error) {
      // Cancellation/ownership loss is not corruption and must not destroy a restored branch.
      this.assertCurrent(scope, epoch, globalEpoch, check);
      if (storage.getString(`${scope}ready`) === JSON.stringify(manifest)) this.remove(threadId, attachmentId);
      if (error instanceof DocumentRetrievalError && error.code === 'quota_exceeded') throw error;
      return null;
    }
  }

  public async publish(
    threadId: string, attachmentId: string, index: PrivateDocumentIndex, check: () => void,
  ): Promise<void> {
    check();
    validateIdentity(index.identity);
    if (this.activeWrite) throw new DocumentRetrievalError('native_failed');
    if (!index.rows.length || index.rows.length > LIMITS.subchunks
      // Estimate backing buffers before making another copy/serialization of vectors.
      || index.rows.length * index.identity.dimensions * 8 > LIMITS.indexBytes) {
      throw new DocumentRetrievalError('quota_exceeded');
    }
    const scope = scopeKey(threadId, attachmentId);
    const epoch = this.epochs.get(scope) ?? 0;
    const globalEpoch = this.globalEpoch;
    const storage = this.storageProvider();
    this.reconcile();
    this.activeWrite = true;
    const job = `${Date.now().toString(36)}-${(++this.sequence).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const written: string[] = [];
    let committed = false;
    let previousReady: string | undefined;
    let proposedReady: string | undefined;
    try {
      const manifests = storage.getAllKeys().filter(key => key.startsWith(PREFIX) && key.endsWith('ready'));
      if (!manifests.includes(`${scope}ready`) && manifests.length >= LIMITS.documents) {
        throw new DocumentRetrievalError('quota_exceeded');
      }
      const oldManifest = this.readManifest(storage, scope);
      previousReady = storage.getString(`${scope}ready`);
      const otherBytes = manifests.reduce((sum, key) => {
        const existing = this.readManifest(storage, key.slice(0, -'ready'.length));
        return sum + (existing?.bytes ?? 0);
      }, 0);
      let bytes = 0;
      const seen = new Set<string>();
      for (let offset = 0; offset < index.rows.length; offset += LIMITS.shardRows) {
        this.assertCurrent(scope, epoch, globalEpoch, check);
        const shard = index.rows.slice(offset, offset + LIMITS.shardRows).map(row => {
          const safe = validateRow(row, index.identity.dimensions);
          const id = `${safe.chunk.index}:${safe.start}:${safe.end}`;
          if (seen.has(id)) throw new DocumentRetrievalError('index_stale');
          seen.add(id);
          return safe;
        });
        const raw = JSON.stringify(shard);
        const shardBytes = utf8Bytes(raw);
        bytes += shardBytes;
        // During replacement the old generation remains readable and counts toward the peak.
        if (shardBytes > LIMITS.shardBytes || bytes > LIMITS.indexBytes || bytes + otherBytes > LIMITS.cacheBytes) {
          throw new DocumentRetrievalError('quota_exceeded');
        }
        const key = `${scope}${job}:${written.length}`;
        written.push(key);
        this.writeRecord(storage, key, raw, () => this.assertCurrent(scope, epoch, globalEpoch, check));
        await yieldControl();
      }
      this.assertCurrent(scope, epoch, globalEpoch, check);
      const manifest: IndexManifest = { version: 1, scope, job, identity: index.identity,
        fingerprint: documentIndexFingerprint(index.identity), rowCount: index.rows.length, shards: written.length, bytes };
      proposedReady = JSON.stringify(manifest);
      this.writeRecord(storage, `${scope}ready`, proposedReady, () => this.assertCurrent(scope, epoch, globalEpoch, check));
      this.assertCurrent(scope, epoch, globalEpoch, check);
      committed = true;
      if (oldManifest) for (let shard = 0; shard < oldManifest.shards; shard++) {
        try { storage.remove(`${scope}${oldManifest.job}:${shard}`); } catch {
          // The new manifest is already atomic; the next reconciliation retries orphan cleanup.
        }
      }
    } catch (error) {
      // A facade can throw after changing the ready record. Undo only our own generation.
      if (proposedReady && storage.getString(`${scope}ready`) === proposedReady) {
        try {
          if (previousReady === undefined) storage.remove(`${scope}ready`);
          else storage.set(`${scope}ready`, previousReady);
        } catch (rollbackError) {
          // A thrown write may itself have completed the rollback; verify before continuing.
          if (storage.getString(`${scope}ready`) !== previousReady) {
            if (rollbackError instanceof PrivateStorageUnavailableError) throw rollbackError;
            throw new DocumentRetrievalError('ownership_changed');
          }
        }
      }
      throw error;
    } finally {
      try {
        if (!committed) for (const key of written) {
          try { storage.remove(key); } catch {
            // Unpublished shards stay unreadable; reconciliation retries cleanup.
          }
        }
      } finally { this.activeWrite = false; }
    }
  }

  public remove(threadId: string, attachmentId: string): void {
    const scope = scopeKey(threadId, attachmentId);
    this.epochs.set(scope, (this.epochs.get(scope) ?? 0) + 1);
    if (this.epochs.size > 64) {
      // A bounded tombstone table can conservatively invalidate active readers/writers.
      this.globalEpoch++;
      this.epochs.clear();
    }
    const storage = this.storageProvider();
    for (const key of storage.getAllKeys()) if (key.startsWith(scope)) storage.remove(key);
  }

  public retain(threadId: string, attachmentIds: ReadonlySet<string>): void {
    const prefix = `${PREFIX}${encodeURIComponent(threadId)}:`;
    const storage = this.storageProvider();
    const scopes = new Set(storage.getAllKeys().filter(key => key.startsWith(prefix)).flatMap(key => {
      const suffix = key.slice(prefix.length);
      const end = suffix.indexOf(':');
      try { return end > 0 ? [decodeURIComponent(suffix.slice(0, end))] : []; } catch { return []; }
    }));
    for (const id of scopes) if (!attachmentIds.has(id)) this.remove(threadId, id);
  }

  /** Metadata only: UI never copies vectors or document text into its state. */
  public inspect(threadId: string, attachmentId: string): DocumentIndexIdentity | null {
    return this.readManifest(this.storageProvider(), scopeKey(threadId, attachmentId))?.identity ?? null;
  }

  /** Invalidate in-flight publication synchronously even if encrypted storage is blocked. */
  public invalidate(): void { this.globalEpoch++; }

  public clear(): void {
    this.invalidate();
    const storage = this.storageProvider();
    for (const key of storage.getAllKeys()) if (key.startsWith(PREFIX)) storage.remove(key);
    this.epochs.clear();
  }
}

export const documentIndexStore = new DocumentIndexStore();
