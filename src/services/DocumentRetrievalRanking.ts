import type { LlamaContext } from 'llama.rn';
import type { DocumentContextChunk } from './DocumentContextService';
import { validateDocumentVector, type DocumentIndexRow } from './DocumentIndexStore';
import { DOCUMENT_RETRIEVAL_LIMITS as LIMITS, DocumentRetrievalError } from '../types/documentRetrieval';

export interface DocumentRetrievalCandidate {
  attachmentId: string;
  chunk: DocumentContextChunk;
  /** Position in the original structural chunk; never invented source-file offsets. */
  start?: number;
  end?: number;
}

const key = (candidate: DocumentRetrievalCandidate) => `${candidate.attachmentId}\u0000${candidate.chunk.index}`;

/** Rank fusion combines ordinal positions, never incompatible lexical/cosine/raw rank scores. */
export function fuseDocumentCandidates(
  lexical: readonly DocumentRetrievalCandidate[], semantic: readonly DocumentRetrievalCandidate[],
): DocumentRetrievalCandidate[] {
  const fused = new Map<string, { candidate: DocumentRetrievalCandidate; score: number; order: number }>();
  for (const list of [lexical, semantic]) {
    const seen = new Set<string>();
    list.slice(0, LIMITS.candidateCount).forEach((candidate, position) => {
      const id = key(candidate);
      if (seen.has(id)) return;
      seen.add(id);
      const existing = fused.get(id);
      if (existing) {
        existing.score += 1 / (60 + position + 1);
        // Semantic ranks refer to the actual scored subchunk, not its oversized lexical parent.
        if (candidate.start !== undefined) existing.candidate = candidate;
      }
      else fused.set(id, { candidate, score: 1 / (60 + position + 1), order: fused.size });
    });
  }
  return [...fused.values()].sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, LIMITS.candidateCount).map(value => value.candidate);
}

export function semanticDocumentCandidates(
  queryVector: readonly number[], documents: readonly { attachmentId: string; rows: readonly DocumentIndexRow[] }[],
): DocumentRetrievalCandidate[] {
  const query = validateDocumentVector(queryVector);
  const best = new Map<string, { candidate: DocumentRetrievalCandidate; score: number; order: number }>();
  for (const document of documents) {
    for (const row of document.rows) {
      const vector = validateDocumentVector(row.vector, query.length);
      const score = vector.reduce((sum, value, index) => sum + value * query[index], 0);
      if (!Number.isFinite(score)) throw new DocumentRetrievalError('invalid_vector');
      const candidate = { attachmentId: document.attachmentId, chunk: row.chunk, start: row.start, end: row.end };
      const id = key(candidate);
      const existing = best.get(id);
      // One best subchunk per structural chunk keeps overlapping snippets from duplicating a source.
      if (!existing || score > existing.score) best.set(id, { candidate, score, order: existing?.order ?? best.size });
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, LIMITS.candidateCount).map(value => value.candidate);
}

/** Validate native IDs against the original candidate list before applying any native ordering. */
export function mapDocumentRerankResults(
  candidates: readonly DocumentRetrievalCandidate[], results: readonly { index: number; score: number }[],
): DocumentRetrievalCandidate[] {
  if (results.length !== candidates.length) throw new DocumentRetrievalError('invalid_ranking');
  const seen = new Set<number>();
  const ranked = results.map(result => {
    if (!Number.isSafeInteger(result.index) || result.index < 0 || result.index >= candidates.length
      || seen.has(result.index) || !Number.isFinite(result.score)) throw new DocumentRetrievalError('invalid_ranking');
    // rc.3 serial rerank represents a failed pair with a finite sentinel, not an exception.
    if (result.score === -1_000_000) throw new DocumentRetrievalError('invalid_ranking');
    seen.add(result.index);
    return { candidate: candidates[result.index], index: result.index, score: result.score };
  });
  return ranked.sort((a, b) => b.score - a.score || a.index - b.index).map(result => result.candidate);
}

/** Reserve one source per document before spending remaining slots in relevance order. */
export function distributeDocumentCandidates(
  candidates: readonly DocumentRetrievalCandidate[], limit: number,
): DocumentRetrievalCandidate[] {
  const budget = Math.max(0, Math.min(LIMITS.candidateCount, Math.floor(limit)));
  const chosen = new Set<string>();
  const firstByDocument = new Map<string, DocumentRetrievalCandidate>();
  for (const candidate of candidates) if (!firstByDocument.has(candidate.attachmentId)) firstByDocument.set(candidate.attachmentId, candidate);
  const selected: DocumentRetrievalCandidate[] = [];
  for (const candidate of [...firstByDocument.values(), ...candidates]) {
    if (selected.length >= budget) break;
    if (chosen.has(key(candidate))) continue;
    chosen.add(key(candidate));
    selected.push(candidate);
  }
  return selected;
}

/** Every piece is checked with the loaded embedding tokenizer and required prefix/specials. */
export async function splitDocumentEmbeddingChunk(
  context: Pick<LlamaContext, 'tokenize'>, chunk: DocumentContextChunk,
  options: { prefix: string; specialTokens: number; tokenLimit: number; check: () => void },
): Promise<Omit<DocumentIndexRow, 'vector'>[]> {
  if (typeof chunk.text !== 'string' || !chunk.text.length || chunk.text.length > LIMITS.structuralChunkCharacters) {
    throw new DocumentRetrievalError('quota_exceeded');
  }
  const fits = async (text: string) => {
    options.check();
    if (text.length > LIMITS.subchunkCharacters) return false;
    const result = await context.tokenize(options.prefix + text);
    options.check();
    if (!Array.isArray(result.tokens) || result.tokens.some(token => !Number.isSafeInteger(token) || token < 0)) {
      throw new DocumentRetrievalError('input_too_large');
    }
    return result.tokens.length + options.specialTokens <= options.tokenLimit;
  };
  if (await fits(chunk.text)) return [{ chunk, start: 0, end: chunk.text.length }];
  if (['code', 'table', 'list', 'sheet'].includes(chunk.kind ?? '')) throw new DocumentRetrievalError('input_too_large');
  const result: Omit<DocumentIndexRow, 'vector'>[] = [];
  let start = 0;
  while (start < chunk.text.length) {
    options.check();
    const points = Array.from(chunk.text.slice(start));
    let low = 1;
    let high = points.length;
    let best = 0;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (await fits(points.slice(0, middle).join(''))) { best = middle; low = middle + 1; }
      else high = middle - 1;
    }
    if (!best) throw new DocumentRetrievalError('input_too_large');
    // Prefer a nearby prose boundary; actual tokenizer checks still authorize the chosen text.
    let text = points.slice(0, best).join('');
    if (best < points.length) {
      const boundary = Math.max(text.lastIndexOf('\n'), text.lastIndexOf(' '));
      if (boundary >= text.length / 2) text = text.slice(0, boundary + 1);
    }
    if (!text.length || !await fits(text)) throw new DocumentRetrievalError('input_too_large');
    const end = start + text.length;
    const hasRealRange = chunk.sourceStart !== undefined && chunk.sourceEnd !== undefined
      && chunk.sourceEnd - chunk.sourceStart === chunk.text.length;
    const { sourceStart: _sourceStart, sourceEnd: _sourceEnd, ...source } = chunk;
    result.push({ chunk: { ...source, text,
      ...(hasRealRange ? { sourceStart: chunk.sourceStart! + start, sourceEnd: chunk.sourceStart! + end } : {}),
    }, start, end });
    if (result.length > LIMITS.subchunks) throw new DocumentRetrievalError('quota_exceeded');
    start = end;
  }
  return result;
}
