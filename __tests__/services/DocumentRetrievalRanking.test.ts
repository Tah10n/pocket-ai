jest.mock('../../src/store/storage', () => ({ getAppStorage: jest.fn() }));

import {
  distributeDocumentCandidates, fuseDocumentCandidates, mapDocumentRerankResults,
  semanticDocumentCandidates, splitDocumentEmbeddingChunk, type DocumentRetrievalCandidate,
} from '../../src/services/DocumentRetrievalRanking';
import type { DocumentContextChunk } from '../../src/services/DocumentContextService';
import { DocumentRetrievalError } from '../../src/types/documentRetrieval';

function candidate(attachmentId: string, index: number, text = `Source ${attachmentId} ${index}`): DocumentRetrievalCandidate {
  return { attachmentId, chunk: { index, text, kind: 'paragraph', heading: 'Section', pageNumber: index + 1 } };
}

function tokenizer() {
  return { tokenize: jest.fn(async (text: string) => ({
    tokens: Array.from(text, (_, index) => index), has_media: false,
    bitmap_hashes: [], chunk_pos: [], chunk_pos_media: [],
  })) };
}

const options = () => ({ prefix: 'doc: ', specialTokens: 2, tokenLimit: 18, check: jest.fn() });

describe('DocumentRetrievalRanking', () => {
  it('keeps a semantic paraphrase with no query word overlap and preserves its real locators', () => {
    const semantic = semanticDocumentCandidates([1, 0], [{ attachmentId: 'manual', rows: [
      { chunk: { index: 7, text: 'Automobiles need regular maintenance.', kind: 'paragraph', pageNumber: 9,
        sourceStart: 120, sourceEnd: 156 }, start: 0, end: 36, vector: [1, 0] },
      { chunk: { index: 8, text: 'Orchids require water.', kind: 'paragraph', pageNumber: 10 }, start: 0, end: 21, vector: [0, 1] },
    ] }]);
    expect(semantic[0]).toMatchObject({ attachmentId: 'manual', chunk: { index: 7, pageNumber: 9, sourceStart: 120, sourceEnd: 156 } });
    const queryWords = new Set('car servicing'.split(' '));
    expect(semantic[0].chunk.text.toLowerCase().split(/\W+/u).some(word => queryWords.has(word))).toBe(false);
    expect(semantic[0].chunk).not.toHaveProperty('slideNumber');
  });

  it('retains an exact lexical identifier and fuses ranks without adding incompatible scores', () => {
    const exact = candidate('codes', 0, 'Failure code ERR_42 needs a restart.');
    const shared = candidate('guide', 1, 'Device recovery instructions.');
    const paraphrase = candidate('manual', 2, 'A cold boot resolves the stalled unit.');
    const fused = fuseDocumentCandidates([exact, shared], [shared, paraphrase]);
    expect(fused).toEqual([shared, exact, paraphrase]);
    expect(fuseDocumentCandidates([exact, exact, shared], [shared, paraphrase])).toEqual([shared, exact, paraphrase]);
  });

  it('coalesces overlapping embedding subchunks using the best vector match per original structural chunk', () => {
    const semantic = semanticDocumentCandidates([1, 0], [{ attachmentId: 'manual', rows: [
      { chunk: { index: 3, text: 'weak overlapping part', sheetName: 'Sheet A' }, start: 0, end: 21, vector: [0, 1] },
      { chunk: { index: 3, text: 'strong overlapping part', sheetName: 'Sheet A' }, start: 10, end: 33, vector: [1, 0] },
      { chunk: { index: 4, text: 'different source', slideNumber: 4 }, start: 0, end: 16, vector: [0.6, 0.8] },
    ] }]);
    expect(semantic).toHaveLength(2);
    expect(semantic[0]).toMatchObject({ start: 10, end: 33, chunk: { index: 3, text: 'strong overlapping part', sheetName: 'Sheet A' } });
    expect(semantic[1].chunk.slideNumber).toBe(4);
  });

  it('passes the actually scored semantic subchunk to rerank when its lexical parent has the same source ID', () => {
    const parent = candidate('manual', 3, 'Whole structural chunk with many unrelated paragraphs.');
    const semantic = { ...parent, start: 12, end: 28, chunk: { ...parent.chunk, text: 'Relevant snippet', sourceStart: 112, sourceEnd: 128 } };
    expect(fuseDocumentCandidates([parent], [semantic])).toEqual([semantic]);
  });

  it.each([[], [NaN, 0], [0, 0], [0.5, 0.5]].map(vector => [vector]))('rejects invalid query or document vector %j', (vector) => {
    expect(() => semanticDocumentCandidates(vector, [])).toThrow(DocumentRetrievalError);
    expect(() => semanticDocumentCandidates([1, 0], [{ attachmentId: 'manual', rows: [
      { chunk: { index: 0, text: 'source' }, start: 0, end: 6, vector },
    ] }])).toThrow(DocumentRetrievalError);
  });

  it('rejects document vectors whose dimension differs from a valid query', () => {
    expect(() => semanticDocumentCandidates([1, 0], [{ attachmentId: 'manual', rows: [
      { chunk: { index: 0, text: 'source' }, start: 0, end: 6, vector: [1] },
    ] }])).toThrow(DocumentRetrievalError);
  });

  it('maps unsorted native reranker indexes to the original candidates and sorts their finite scores', () => {
    const candidates = [candidate('a', 7), candidate('b', 3), candidate('c', 11)];
    const ranked = mapDocumentRerankResults(candidates, [{ index: 2, score: 0.2 }, { index: 0, score: -0.5 }, { index: 1, score: 1.5 }]);
    expect(ranked).toEqual([candidates[1], candidates[2], candidates[0]]);
    expect(ranked[0].chunk.pageNumber).toBe(4);
    expect(mapDocumentRerankResults(candidates, [{ index: 2, score: 1 }, { index: 1, score: 1 }, { index: 0, score: 1 }])).toEqual(candidates);
  });

  it.each([
    ['missing', [{ index: 0, score: 1 }]],
    ['duplicate', [{ index: 0, score: 1 }, { index: 0, score: 2 }]],
    ['out of range', [{ index: 0, score: 1 }, { index: 2, score: 2 }]],
    ['fractional index', [{ index: 0, score: 1 }, { index: 0.5, score: 2 }]],
    ['NaN score', [{ index: 0, score: 1 }, { index: 1, score: NaN }]],
    ['infinite score', [{ index: 0, score: 1 }, { index: 1, score: Infinity }]],
  ])('rejects %s reranker output without losing the original locator mapping', (_name, results) => {
    expect(() => mapDocumentRerankResults([candidate('a', 0), candidate('b', 1)], results))
      .toThrow(expect.objectContaining({ code: 'invalid_ranking' }));
  });

  it('reserves one candidate per document and applies the shared candidate ceiling', () => {
    const ranked = [candidate('a', 0), candidate('a', 1), candidate('a', 0), candidate('b', 0), candidate('c', 0)];
    expect(distributeDocumentCandidates(ranked, 3)).toEqual([ranked[0], ranked[3], ranked[4]]);
    expect(distributeDocumentCandidates(ranked, 0)).toEqual([]);
    expect(fuseDocumentCandidates(Array.from({ length: 40 }, (_, index) => candidate('a', index)), [])).toHaveLength(16);
  });

  it('uses the real tokenizer contract with document prefix and reserved service tokens before splitting', async () => {
    const context = tokenizer();
    const chunk: DocumentContextChunk = { index: 4, text: 'The car needs service. 😀 Repeat regularly.', kind: 'paragraph',
      heading: 'Maintenance', pageNumber: 3, sourceStart: 200, sourceEnd: 242 };
    chunk.sourceEnd = chunk.sourceStart! + chunk.text.length;
    const profile = options();
    const first = await splitDocumentEmbeddingChunk(context, chunk, profile);
    const second = await splitDocumentEmbeddingChunk(context, chunk, profile);
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(1);
    expect(first.map(part => part.chunk.text).join('')).toBe(chunk.text);
    let offset = 0;
    for (const part of first) {
      expect(part.start).toBe(offset);
      expect(part.end - part.start).toBe(part.chunk.text.length);
      expect(part.chunk).toMatchObject({ index: 4, heading: 'Maintenance', pageNumber: 3,
        sourceStart: 200 + part.start, sourceEnd: 200 + part.end });
      expect(Array.from(profile.prefix + part.chunk.text).length + profile.specialTokens).toBeLessThanOrEqual(profile.tokenLimit);
      expect(part.chunk.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
      offset = part.end;
    }
    expect(context.tokenize.mock.calls.every(([text]) => text.startsWith(profile.prefix))).toBe(true);
    expect(profile.check).toHaveBeenCalled();
  });

  it('does not invent source offsets for native structural chunks that have no real range', async () => {
    const parts = await splitDocumentEmbeddingChunk(tokenizer(), { index: 1, text: 'A long native paragraph about automobiles.', kind: 'paragraph', slideNumber: 2 }, options());
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every(part => !('sourceStart' in part.chunk) && !('sourceEnd' in part.chunk) && part.chunk.slideNumber === 2)).toBe(true);
  });

  it.each(['code', 'table', 'list', 'sheet'] as const)('reports an oversized atomic %s without sending silently truncated data', async (kind) => {
    const context = tokenizer();
    await expect(splitDocumentEmbeddingChunk(context, { index: 0, text: 'x'.repeat(100), kind }, options()))
      .rejects.toMatchObject({ code: 'input_too_large' });
    expect(context.tokenize).toHaveBeenCalledTimes(1);
  });

  it('rejects impossible single-codepoint input and malformed tokenizer outputs', async () => {
    await expect(splitDocumentEmbeddingChunk(tokenizer(), { index: 0, text: '😀', kind: 'paragraph' }, {
      ...options(), tokenLimit: 7,
    })).rejects.toMatchObject({ code: 'input_too_large' });
    const context = { tokenize: jest.fn(async () => ({ tokens: [NaN], has_media: false,
      bitmap_hashes: [], chunk_pos: [], chunk_pos_media: [],
    })) };
    await expect(splitDocumentEmbeddingChunk(context, { index: 0, text: 'text', kind: 'paragraph' }, options()))
      .rejects.toMatchObject({ code: 'input_too_large' });
  });

  it('observes cancellation after an unfinished native tokenizer call and creates no pieces', async () => {
    let settle!: () => void;
    let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const context = { tokenize: jest.fn(async () => {
      started();
      await new Promise<void>(resolve => { settle = resolve; });
      return { tokens: [1], has_media: false, bitmap_hashes: [], chunk_pos: [], chunk_pos_media: [] };
    }) };
    let cancelled = false;
    const operation = splitDocumentEmbeddingChunk(context, { index: 0, text: 'source' }, {
      ...options(), check: () => { if (cancelled) throw new DocumentRetrievalError('cancelled'); },
    });
    const rejection = expect(operation).rejects.toMatchObject({ code: 'cancelled' });
    await began;
    cancelled = true;
    settle();
    await rejection;
    expect(context.tokenize).toHaveBeenCalledTimes(1);
  });
});
