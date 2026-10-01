/** Missing legacy fields deliberately retain the original lexical document path. */
export interface DocumentRetrievalSettings {
  mode: 'lexical' | 'hybrid';
  rerank: boolean;
}

export const DEFAULT_DOCUMENT_RETRIEVAL_SETTINGS: Readonly<DocumentRetrievalSettings> = {
  mode: 'lexical', rerank: false,
};

export function sanitizeDocumentRetrievalSettings(value: unknown): DocumentRetrievalSettings {
  const settings = value && typeof value === 'object'
    ? value as Partial<DocumentRetrievalSettings> : undefined;
  return { mode: settings?.mode === 'hybrid' ? 'hybrid' : 'lexical', rerank: settings?.rerank === true };
}

export type DocumentRetrievalIssue = 'model_unavailable' | 'profile_unverified' | 'index_not_ready'
  | 'index_stale' | 'quota_exceeded' | 'input_too_large' | 'invalid_vector'
  | 'invalid_ranking' | 'native_failed' | 'cancelled' | 'ownership_changed' | 'restore_failed' | 'cache_write_failed';

export interface DocumentIndexCacheFailure {
  attachmentId: string;
  reason: 'quota_exceeded' | 'cache_write_failed';
}

export interface DocumentIndexPublicationResult {
  publishedAttachmentIds: string[];
  cacheFailures: DocumentIndexCacheFailure[];
}

export class DocumentRetrievalError extends Error {
  constructor(readonly code: DocumentRetrievalIssue) {
    super(code);
    this.name = 'DocumentRetrievalError';
  }
}

/** Derived document data is private, including these compatibility identities. */
export interface DocumentIndexIdentity {
  documentSha256: string;
  extractionIdentity: string;
  chunkingVersion: string;
  preprocessingVersion: string;
  modelSha256: string;
  modelRevision: string;
  modelBytes: number;
  tokenizerIdentity: string;
  pooling: 'mean' | 'cls' | 'last';
  normalization: 2;
  queryPrefix: string;
  documentPrefix: string;
  dimensions: number;
  vectorFormat: 'float32';
  runtimeIdentity: string;
}

export function documentIndexFingerprint(identity: DocumentIndexIdentity): string {
  return JSON.stringify([
    identity.documentSha256, identity.extractionIdentity, identity.chunkingVersion,
    identity.preprocessingVersion, identity.modelSha256, identity.modelRevision, identity.modelBytes,
    identity.tokenizerIdentity, identity.pooling, identity.normalization,
    identity.queryPrefix, identity.documentPrefix, identity.dimensions, identity.vectorFormat,
    identity.runtimeIdentity,
  ]);
}

export const DOCUMENT_RETRIEVAL_LIMITS = Object.freeze({
  documents: 4,
  structuralChunks: 2048,
  subchunks: 2048,
  dimensions: 4096,
  indexBytes: 8 * 1024 * 1024,
  cacheBytes: 32 * 1024 * 1024,
  shardRows: 8,
  shardBytes: 512 * 1024,
  candidateCount: 16,
  rerankCandidates: 8,
  subchunkCharacters: 4000,
  structuralChunkCharacters: 64000,
});
