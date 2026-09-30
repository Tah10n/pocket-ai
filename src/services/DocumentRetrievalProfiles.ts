import { normalizeSha256Digest } from '../utils/sha256';

export type RetrievalProfileRole = 'embedding' | 'reranker';

export type RetrievalSpecialTokens = Readonly<{
  bosId: number;
  eosId: number;
  separatorId: number;
  addBos: boolean;
  addEos: boolean;
  addSeparator: boolean;
  /** loadPrompt re-tokenizes the formatted input with automatic BOS/EOS. */
  nativeOuterOverhead: number;
}>;

/** Verified artifact metadata and preprocessing, not native acceptance evidence. */
export interface VerifiedRetrievalProfile {
  readonly id: string;
  readonly role: RetrievalProfileRole;
  readonly modelRepository: string;
  readonly modelFilename: string;
  readonly modelSha256: string;
  readonly modelRevision: string;
  readonly modelBytes: number;
  readonly upstreamRepository: string;
  readonly upstreamRevision: string;
  readonly license: 'MIT' | 'Apache-2.0';
  readonly contextTokens: number;
  readonly maxInputTokens: number;
  readonly modelContextTokens: number;
  readonly pooling: 'mean' | 'rank';
  /** 2 = L2 vectors; 0 = raw rank scores, NOT native embd_normalize=0. */
  readonly normalization: 2 | 0;
  readonly queryPrefix: string;
  readonly documentPrefix: string;
  readonly dimensions?: number;
  readonly languages: readonly string[];
  readonly tokenizerFamily: 'xlm-roberta';
  readonly ggufTokenizer: 't5';
  readonly specialTokens: RetrievalSpecialTokens;
  /** Total overhead relative to separately tokenized query/document text. */
  readonly specialTokenOverhead: number;
  readonly runtimeContract: string;
}

const RUNTIME_CONTRACT = 'llama.rn/0.13.0-rc.3/nonparallel-retrieval-v1';
const languages = Object.freeze(['en', 'ru']);

export const VERIFIED_RETRIEVAL_PROFILES: readonly VerifiedRetrievalProfile[] = Object.freeze([
  Object.freeze({
    id: 'multilingual-e5-small-q8_0',
    role: 'embedding' as const,
    modelRepository: 'TwinSunsLLC/multilingual-e5-small-gguf',
    modelFilename: 'multilingual-e5-small-q8_0.gguf',
    modelSha256: 'e011debc1208e31bf7b6aebee2d9fc8bd2ca11694a77ed66ac9d0c9d0a877c93',
    modelRevision: 'b6cac9615d4ecce28d7f22539b7322d695fc2886',
    modelBytes: 132439008,
    upstreamRepository: 'intfloat/multilingual-e5-small',
    upstreamRevision: '614241f622f53c4eeff9890bdc4f31cfecc418b3',
    license: 'MIT' as const,
    contextTokens: 512,
    // The actual converted artifact declares 511, despite the card's 512.
    maxInputTokens: 511,
    modelContextTokens: 511,
    pooling: 'mean' as const,
    normalization: 2 as const,
    queryPrefix: 'query: ',
    documentPrefix: 'passage: ',
    dimensions: 384,
    languages,
    tokenizerFamily: 'xlm-roberta' as const,
    ggufTokenizer: 't5' as const,
    specialTokens: Object.freeze({
      bosId: 0, eosId: 2, separatorId: 2,
      addBos: true, addEos: true, addSeparator: true,
      nativeOuterOverhead: 2,
    }),
    specialTokenOverhead: 2,
    runtimeContract: RUNTIME_CONTRACT,
  }),
  Object.freeze({
    id: 'bge-reranker-v2-m3-q4_k_m',
    role: 'reranker' as const,
    modelRepository: 'gpustack/bge-reranker-v2-m3-GGUF',
    modelFilename: 'bge-reranker-v2-m3-Q4_K_M.gguf',
    modelSha256: 'e186a244ed455b4ab66ec64339ce7427a6ae13f5c0b5e544de96e50f0f8b3673',
    modelRevision: '3093af03b1a635e67b084b1d8c03c5f5e020fd05',
    modelBytes: 438376864,
    upstreamRepository: 'BAAI/bge-reranker-v2-m3',
    upstreamRevision: '953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e',
    license: 'Apache-2.0' as const,
    contextTokens: 512,
    maxInputTokens: 511,
    modelContextTokens: 8192,
    pooling: 'rank' as const,
    normalization: 0 as const,
    queryPrefix: '',
    documentPrefix: '',
    languages,
    tokenizerFamily: 'xlm-roberta' as const,
    ggufTokenizer: 't5' as const,
    specialTokens: Object.freeze({
      bosId: 0, eosId: 2, separatorId: 2,
      // This artifact omits add_sep_token; native UGM defaults it to false.
      addBos: true, addEos: true, addSeparator: false,
      nativeOuterOverhead: 2,
    }),
    specialTokenOverhead: 5,
    runtimeContract: RUNTIME_CONTRACT,
  }),
]);

/** Filename, family, and equal dimensions never establish compatibility. */
export function getVerifiedRetrievalProfile(
  role: RetrievalProfileRole,
  sha256: string | null | undefined,
): VerifiedRetrievalProfile | null {
  const digest = normalizeSha256Digest(sha256);
  return digest
    ? VERIFIED_RETRIEVAL_PROFILES.find((profile) => profile.role === role && profile.modelSha256 === digest) ?? null
    : null;
}

/** The caller adds the actual source-patch identity to its index fingerprint. */
export function getRetrievalProfileFingerprint(profile: VerifiedRetrievalProfile): string {
  return JSON.stringify([
    profile.role, profile.modelSha256, profile.modelRevision, profile.modelBytes,
    profile.upstreamRevision, profile.tokenizerFamily, profile.ggufTokenizer,
    profile.pooling, profile.normalization, profile.queryPrefix, profile.documentPrefix,
    profile.dimensions ?? null, profile.contextTokens, profile.maxInputTokens,
    profile.specialTokens, profile.runtimeContract,
  ]);
}

/** Mirror rn-common.hpp, then detokenize and tokenize this result natively. */
export function formatRetrievalRerankTokens(
  profile: VerifiedRetrievalProfile,
  queryTokens: readonly number[],
  documentTokens: readonly number[],
): number[] {
  if (profile.role !== 'reranker') throw new Error('retrieval_profile_role');
  if (queryTokens.length + documentTokens.length + profile.specialTokenOverhead > profile.maxInputTokens
    || [...queryTokens, ...documentTokens].some((token) => !Number.isSafeInteger(token) || token < 0)) {
    throw new Error('retrieval_token_limit');
  }
  const special = profile.specialTokens;
  return [
    ...(special.addBos ? [special.bosId] : []),
    ...queryTokens,
    ...(special.addEos ? [special.eosId] : []),
    ...(special.addSeparator ? [special.separatorId] : []),
    ...documentTokens,
    ...(special.addEos ? [special.eosId] : []),
  ];
}

/** Count the actual input to loadPrompt, including its automatic specials. */
export function getRetrievalInputTokenCount(profile: VerifiedRetrievalProfile, nativeTokenCount: number): number {
  const count = nativeTokenCount + profile.specialTokens.nativeOuterOverhead;
  if (!Number.isSafeInteger(nativeTokenCount) || nativeTokenCount < 0
    || count > profile.maxInputTokens || count >= profile.contextTokens) {
    throw new Error('retrieval_token_limit');
  }
  return count;
}
