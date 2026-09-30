import type { LlamaContext } from 'llama.rn';
import { getAuxiliarySelection, validateAuxiliaryFile, claimNativePooledEmbeddingDimension } from './AuxiliaryModelService';
import {
  getVerifiedRetrievalProfile, getRetrievalProfileFingerprint, getRetrievalInputTokenCount,
  formatRetrievalRerankTokens, type VerifiedRetrievalProfile, type RetrievalProfileRole,
} from './DocumentRetrievalProfiles';
import { getModelFileIdentity } from '../utils/modelRoles';
import { safeJoinModelPath, fileUriToNativePath } from '../utils/safeFilePath';
import { getModelsDir } from './FileSystemSetup';
import { registry } from './LocalStorageRegistry';
import { getSystemMemorySnapshot } from './SystemMetricsService';
import { resolveConservativeAvailableMemoryBudget } from '../memory/budget';
import { isPrivateStorageWritable } from './storage';
import { runWithIdleModelDownloads } from './ModelDownloadManager';
import { llmEngineService, type AuxiliaryContextSequence, type AuxiliaryContextRequest } from './LLMEngineService';
import { getLlamaBuildInfo } from './LlamaRuntimeAdapter';
import { DOCUMENT_RETRIEVAL_LIMITS as LIMITS, DocumentRetrievalError } from '../types/documentRetrieval';
import { validateDocumentVector } from './DocumentIndexStore';

// Identifies the guarded source patch shipped with this implementation, not package BuildInfo alone.
export const DOCUMENT_RETRIEVAL_SOURCE_PATCH_SHA256 = '5093423b44e29c70a6757c61a59bfa986af7f7909b8e63c9333359bda1253cf4';

export interface RetrievalRuntimeBinding {
  modelId: string;
  fileIdentity: string;
  profile: VerifiedRetrievalProfile;
  request: AuxiliaryContextRequest;
  isSelectionCurrent: () => boolean;
}

export interface RetrievalRuntimeOptions {
  signal?: AbortSignal;
  runOwner?: symbol;
  assertCurrent: () => void;
  /** Excludes Stop but retains chat, permissions, file identity and private-storage ownership. */
  assertSelectionCurrent?: () => void;
  onRestored?: (receipt: { previousContextIdentity: string; restoredContextIdentity: string; modelId: string }) => void;
  /** Bounded QA observation: no text, vectors, user paths or scores. */
  onNativeOperation?: (event: { operation: 'embedding' | 'rerank'; phase: 'started' | 'settled'; kind?: 'query' | 'document'; inputCount?: number; indices?: readonly number[] }) => void;
}

/** Includes actual production batches, retained document/index buffers and restoration headroom. */
export function estimateRetrievalWorkingBytes(profile: VerifiedRetrievalProfile): number {
  const hiddenDimensions = profile.dimensions ?? 1024;
  return profile.modelBytes * 2 + 256 * 1024 * 1024
    + profile.contextTokens * hiddenDimensions * 4 * 32
    + LIMITS.cacheBytes + 16 * 1024 * 1024;
}

export function resolveRetrievalRuntimeBinding(
  role: RetrievalProfileRole, options: RetrievalRuntimeOptions, preparation = false,
): RetrievalRuntimeBinding {
  options.assertCurrent();
  const model = getAuxiliarySelection(role);
  if (!model) throw new DocumentRetrievalError('model_unavailable');
  const profile = getVerifiedRetrievalProfile(role, model.sha256);
  if (!profile || profile.modelBytes !== model.size) throw new DocumentRetrievalError('profile_unverified');
  const uri = model.localPath && getModelsDir() ? safeJoinModelPath(getModelsDir()!, model.localPath) : null;
  if (!uri) throw new DocumentRetrievalError('model_unavailable');
  const fileIdentity = getModelFileIdentity(model);
  const assertSelectionCurrent = () => {
    (options.assertSelectionCurrent ?? options.assertCurrent)();
    const live = getAuxiliarySelection(role);
    const installed = registry.getModel(model.id);
    if (!isPrivateStorageWritable() || !live || getModelFileIdentity(live) !== fileIdentity
      || !installed || getModelFileIdentity(installed) !== fileIdentity || installed.localPath !== model.localPath) {
      throw new DocumentRetrievalError('ownership_changed');
    }
  };
  const assertCurrent = () => {
    assertSelectionCurrent();
    options.assertCurrent();
    if (options.signal?.aborted) throw new DocumentRetrievalError('cancelled');
  };
  return {
    modelId: model.id, fileIdentity, profile,
    isSelectionCurrent: () => { try { assertSelectionCurrent(); return true; } catch { return false; } },
    request: {
      modelId: model.id, signal: options.signal,
      isCurrent: () => { try { assertCurrent(); return true; } catch { return false; } },
      nativeDrainTimeoutMs: preparation ? 600_000 : 30_000,
      initParams: {
        model: fileUriToNativePath(uri), n_ctx: profile.contextTokens,
        n_batch: profile.contextTokens, n_ubatch: profile.contextTokens,
        n_gpu_layers: 0, embedding: true, pooling_type: profile.pooling,
        ...(role === 'embedding' ? { embd_normalize: 2 } : { embd_normalize: -1 }),
        ctx_shift: false, use_mmap: true, use_mlock: false,
        n_parallel: 1, state_cache_budget_mb: 0, state_cache_max_checkpoints: 8,
      },
      beforeInit: async () => {
        assertCurrent();
        await validateAuxiliaryFile(model);
        assertCurrent();
        const snapshot = await getSystemMemorySnapshot();
        assertCurrent();
        const budget = snapshot ? resolveConservativeAvailableMemoryBudget(snapshot, { strictFreeCap: true }) : null;
        if (budget === null || snapshot?.lowMemory || budget < estimateRetrievalWorkingBytes(profile)) {
          throw new DocumentRetrievalError('model_unavailable');
        }
      },
    },
  };
}

export function getDocumentRetrievalRuntimeIdentity(profile: VerifiedRetrievalProfile): string {
  return JSON.stringify([getRetrievalProfileFingerprint(profile), getLlamaBuildInfo(), DOCUMENT_RETRIEVAL_SOURCE_PATCH_SHA256]);
}

export async function runDocumentRetrievalRuntime<T>(
  bindings: readonly RetrievalRuntimeBinding[], options: RetrievalRuntimeOptions,
  operation: (sequence: AuxiliaryContextSequence, assertRuntimeCurrent: () => void) => Promise<T>,
): Promise<T> {
  options.assertCurrent();
  // The same model-file mutation lease spans integrity checks, native work, release and restored A.
  return runWithIdleModelDownloads(async () => {
    const callbackDrains = new Set<Promise<unknown>>();
    let sequenceOpen = true;
    let phaseFailure: { error: unknown } | undefined;
    const assertRuntimeCurrent = () => {
      if (!sequenceOpen || phaseFailure) {
        throw phaseFailure?.error ?? new DocumentRetrievalError('native_failed');
      }
    };
    try {
      return await llmEngineService.runWithAuxiliarySequence({
        signal: options.signal, runOwner: options.runOwner, onRestored: options.onRestored,
        isSelectionCurrent: () => {
          try {
            (options.assertSelectionCurrent ?? options.assertCurrent)();
            return isPrivateStorageWritable() && bindings.every(binding => binding.isSelectionCurrent());
          } catch { return false; }
        },
        isCurrent: () => {
          try {
            options.assertCurrent();
            return !options.signal?.aborted && isPrivateStorageWritable() && bindings.every(binding => binding.request.isCurrent());
          } catch { return false; }
        },
      }, sequence => operation({
        withContext: async <R>(request: AuxiliaryContextRequest, callback: (context: LlamaContext) => Promise<R>): Promise<R> => {
          assertRuntimeCurrent();
          try {
            return await sequence.withContext(request, context => {
              // The engine's watchdog may reject its phase while this exact callback
              // still owns tokenizer/native work and opaque document resources.
              const drain = Promise.resolve().then(() => {
                assertRuntimeCurrent();
                return callback(context);
              });
              callbackDrains.add(drain);
              void drain.then(() => callbackDrains.delete(drain), () => callbackDrains.delete(drain));
              return drain;
            });
          } catch (error) {
            phaseFailure ??= { error };
            throw error;
          }
        },
      }, assertRuntimeCurrent));
    } finally {
      sequenceOpen = false;
      // Never use a deadline as proof that document handles or model files are free.
      // Engine quarantine retains native ownership; this barrier retains the outer leases.
      for (const drain of callbackDrains) {
        try { await drain; } catch { /* Preserve the original phase/restoration failure. */ }
      }
    }
  });
}

export function assertRetrievalContextProfile(context: LlamaContext, profile: VerifiedRetrievalProfile): void {
  const metadata = context.model.metadata;
  if (!metadata || !('tokenizer.ggml.model' in metadata) || metadata['tokenizer.ggml.model'] !== profile.ggufTokenizer
    || (profile.dimensions !== undefined && context.model.nEmbd !== profile.dimensions)) {
    throw new DocumentRetrievalError('profile_unverified');
  }
}

export async function embedDocumentRetrievalText(
  context: LlamaContext, profile: VerifiedRetrievalProfile, text: string,
  kind: 'query' | 'document', check: () => void,
  observe?: RetrievalRuntimeOptions['onNativeOperation'],
): Promise<number[]> {
  check();
  assertRetrievalContextProfile(context, profile);
  if (profile.pooling !== 'mean' || profile.normalization !== 2) throw new DocumentRetrievalError('profile_unverified');
  const input = (kind === 'query' ? profile.queryPrefix : profile.documentPrefix) + text;
  const tokens = await context.tokenize(input);
  check();
  try { getRetrievalInputTokenCount(profile, tokens.tokens.length); } catch { throw new DocumentRetrievalError('input_too_large'); }
  claimNativePooledEmbeddingDimension(context.model.nEmbd);
  observe?.({ operation: 'embedding', phase: 'started', kind, inputCount: 1 });
  const result = await context.embedding(input, { embd_normalize: 2 }).finally(() => {
    observe?.({ operation: 'embedding', phase: 'settled', kind, inputCount: 1 });
  });
  check();
  return validateDocumentVector(result.embedding, profile.dimensions);
}

export async function validateDocumentRerankPair(
  context: LlamaContext, profile: VerifiedRetrievalProfile, query: string, document: string, check: () => void,
): Promise<void> {
  check();
  assertRetrievalContextProfile(context, profile);
  const queryTokens = await context.tokenize(profile.queryPrefix + query);
  check();
  const documentTokens = await context.tokenize(profile.documentPrefix + document);
  check();
  try {
    const nativeTokens = formatRetrievalRerankTokens(profile, queryTokens.tokens, documentTokens.tokens);
    const formatted = await context.detokenize(nativeTokens);
    check();
    const retokenized = await context.tokenize(formatted);
    check();
    getRetrievalInputTokenCount(profile, retokenized.tokens.length);
  } catch (error) {
    check();
    if (error instanceof DocumentRetrievalError) throw error;
    throw new DocumentRetrievalError('input_too_large');
  }
}
