import {
  DEFAULT_DOCUMENT_RETRIEVAL_SETTINGS, documentIndexFingerprint, sanitizeDocumentRetrievalSettings,
  type DocumentIndexIdentity,
} from '../../src/types/documentRetrieval';

describe('Document retrieval legacy settings', () => {
  it.each([undefined, null, {}, false, 'hybrid', { mode: 'semantic', rerank: 1 }, { mode: 'lexical', rerank: 'true' }])
  ('keeps missing or invalid legacy settings lexical with neural work off: %j', value => {
    expect(sanitizeDocumentRetrievalSettings(value)).toEqual(DEFAULT_DOCUMENT_RETRIEVAL_SETTINGS);
  });

  it('allows explicit rerank with lexical candidates independently of embedding mode', () => {
    expect(sanitizeDocumentRetrievalSettings({ rerank: true })).toEqual({ mode: 'lexical', rerank: true });
    expect(sanitizeDocumentRetrievalSettings({ mode: 'hybrid', rerank: false })).toEqual({ mode: 'hybrid', rerank: false });
  });

  it('copies the sanitized settings so edits cannot alter defaults or input snapshots', () => {
    const input = { mode: 'hybrid' as const, rerank: true };
    const output = sanitizeDocumentRetrievalSettings(input);
    output.rerank = false;
    expect(input.rerank).toBe(true);
    expect(DEFAULT_DOCUMENT_RETRIEVAL_SETTINGS).toEqual({ mode: 'lexical', rerank: false });
  });

  it('keeps same-dimension profiles distinct when model, prefixes or runtime change', () => {
    const identity: DocumentIndexIdentity = {
      documentSha256: 'a'.repeat(64), extractionIdentity: 'extract-v1', chunkingVersion: 'chunk-v1',
      preprocessingVersion: 'pre-v1', modelSha256: 'b'.repeat(64), modelRevision: 'revision', modelBytes: 128,
      tokenizerIdentity: 'tokenizer', pooling: 'mean', normalization: 2, queryPrefix: '', documentPrefix: '',
      dimensions: 2, vectorFormat: 'float32', runtimeIdentity: 'runtime-patch',
    };
    for (const change of [{ modelSha256: 'c'.repeat(64) }, { queryPrefix: 'query: ' }, { documentPrefix: 'passage: ' },
      { runtimeIdentity: 'another-patch' }, { tokenizerIdentity: 'another-tokenizer' }]) {
      expect(documentIndexFingerprint({ ...identity, ...change })).not.toBe(documentIndexFingerprint(identity));
    }
  });
});
