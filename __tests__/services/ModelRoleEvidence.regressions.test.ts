import { buildModelMetadataFromPayload, transformHFResponse } from '../../src/services/ModelCatalogTransformer';
import { normalizePersistedModelMetadata } from '../../src/services/ModelMetadataNormalizer';
import { sanitizeCatalogModelRuntimeState } from '../../src/services/ModelCatalogCacheStore';
import { getModelFileIdentity, getModelRoleEvidence, isChatModelEligible, mergeModelRoleEvidence } from '../../src/utils/modelRoles';
import { applyModelVariantSelection } from '../../src/utils/modelVariants';
import { mergeModelWithRuntimeState } from '../../src/utils/modelRuntimeState';
import type { HuggingFaceModelSummary } from '../../src/types/huggingFace';
import type { ModelMetadata } from '../../src/types/models';
import type { ModelRoleEvidence } from '../../src/types/modelRoles';

const sha = 'a'.repeat(64);
const payload: HuggingFaceModelSummary = {
  id: 'org/mixed', sha: 'revision1', siblings: [
    { rfilename: 'embedding.Q4_K_M.gguf', size: 32 * 1024 * 1024, lfs: { sha256: sha } },
    { rfilename: 'chat.Q8_0.gguf', size: 64 * 1024 * 1024, lfs: { sha256: 'b'.repeat(64) } },
  ],
};
const restore = (value: ModelMetadata) => normalizePersistedModelMetadata(JSON.parse(JSON.stringify(value)));
const catalog = () => transformHFResponse([payload], null, null)[0];
const chat = (value: ModelMetadata) => applyModelVariantSelection(restore(value), 'chat.Q8_0.gguf');

describe('file role evidence through catalog boundaries', () => {
  it('scopes catalog filename evidence before hydration and drops it on a chat variant', () => {
    const first = catalog();
    expect(first.resolvedFileName).toBe('embedding.Q4_K_M.gguf');
    expect(first.roleEvidence).toContainEqual(expect.objectContaining({
      source: 'filename', role: 'embedding', fileIdentity: getModelFileIdentity(first),
    }));
    expect(getModelRoleEvidence(chat(first))).toEqual([]);
  });

  it.each([
    { 'general.architecture': 'bert', 'bert.pooling_type': 1 },
    { 'general.architecture': 'bert', 'bert.pooling_type': 4 },
    { 'general.task': 'embedding' },
    { 'general.task': 'reranking' },
  ])('scopes detail GGUF declarations and does not transfer them to another file: %j', (gguf) => {
    const first = buildModelMetadataFromPayload(payload, null, null, { ...catalog(), gguf });
    expect(first.roleEvidence).toContainEqual(expect.objectContaining({
      source: 'gguf_metadata', confidence: 'declared', fileIdentity: getModelFileIdentity(first),
    }));
    expect(isChatModelEligible(first)).toBe(false);
    expect(getModelRoleEvidence(chat(first))).toEqual([]);
    expect(isChatModelEligible(chat(first))).toBe(true);
  });

  it('drops raw GGUF purpose when selecting replacement bytes at the same variant path', () => {
    const old = { ...catalog(), gguf: { 'general.task': 'embedding' } };
    const replaced = applyModelVariantSelection({ ...old, variants: old.variants!.map((variant) => ({
      ...variant, sha256: 'c'.repeat(64),
    })) }, old.activeVariantId!);
    expect(replaced.sha256).toBe('c'.repeat(64));
    expect(getModelRoleEvidence(replaced).filter((entry) => entry.source === 'gguf_metadata')).toEqual([]);
  });

  it('drops legacy unscoped file evidence at hydration without assigning the current file identity', () => {
    const current = chat(catalog());
    const restored = restore({ ...current, roleEvidence: [
      { source: 'filename', role: 'embedding', confidence: 'inferred', value: 'embedding.Q4_K_M.gguf' },
      { source: 'gguf_metadata', role: 'reranker', confidence: 'declared', value: 'bert.pooling_type=4' },
    ] });
    expect(restored.roleEvidence).toBeUndefined();
    expect(getModelRoleEvidence(restored)).toEqual([]);
    expect(isChatModelEligible(restored)).toBe(true);
  });

  it('does not let earlier unscoped evidence suppress newly scoped evidence in a merge', () => {
    const scoped: ModelRoleEvidence = { source: 'gguf_metadata', role: 'embedding', confidence: 'declared',
      fileIdentity: getModelFileIdentity(catalog()) };
    expect(mergeModelRoleEvidence([{ source: 'gguf_metadata', role: 'reranker', confidence: 'declared' }], [scoped]))
      .toEqual([scoped]);
  });

  it('does not rebind legacy raw GGUF declarations while hydrating unscoped evidence', () => {
    const current = chat(catalog());
    const legacy: ModelMetadata = { ...current, gguf: { 'general.task': 'embedding' }, roleEvidence: [
      { source: 'gguf_metadata', role: 'embedding', confidence: 'declared', value: 'embedding' },
    ] };
    const restored = restore(legacy);
    expect(getModelRoleEvidence(restored)).toEqual([]);
    expect(getModelRoleEvidence(restore(sanitizeCatalogModelRuntimeState(restored)))).toEqual([]);
    expect(getModelRoleEvidence(buildModelMetadataFromPayload(payload, null, null, legacy))).toEqual([]);
  });

  it.each([
    { sha256: 'c'.repeat(64) }, { hfRevision: 'revision2' }, { size: 128 * 1024 * 1024 },
  ])('does not re-infer stale raw GGUF declarations during hydration after identity changes: %j', (change) => {
    const old = buildModelMetadataFromPayload(payload, null, null,
      { ...catalog(), gguf: { 'general.task': 'embedding' } });
    const restored = restore({ ...old, ...change });
    expect(getModelRoleEvidence(restored).filter((entry) => entry.source === 'gguf_metadata')).toEqual([]);
    expect(getModelRoleEvidence(restore(restored)).filter((entry) => entry.source === 'gguf_metadata')).toEqual([]);
  });

  it('does not resurrect invalidated declarations through refresh, runtime merge, cache, or persistence', () => {
    const old = buildModelMetadataFromPayload(payload, null, null,
      { ...catalog(), gguf: { 'general.task': 'embedding' } });
    const selected = chat(old);
    const refreshed = buildModelMetadataFromPayload(payload, null, null, selected);
    const merged = mergeModelWithRuntimeState(refreshed, { localModel: selected,
      queuedItem: { ...selected, roleEvidence: old.roleEvidence } });
    expect(merged.roleEvidence).toBeUndefined();
    const cached = sanitizeCatalogModelRuntimeState(merged);
    expect(getModelRoleEvidence(restore(cached))).toEqual([]);
    expect(isChatModelEligible(restore(cached))).toBe(true);
  });

  it.each(['localModel', 'queuedItem'] as const)
    ('does not rebind raw GGUF purpose when %s supplies a previously unknown SHA', (source) => {
      const unsignedPayload = { id: payload.id, sha: payload.sha, siblings: [
        { rfilename: 'neutral.Q4_K_M.gguf', size: 32 * 1024 * 1024 },
      ] };
      const listed = transformHFResponse([unsignedPayload], null, null)[0];
      const original = buildModelMetadataFromPayload(unsignedPayload, null, null,
        { ...listed, gguf: { 'general.task': 'embedding' } });
      expect(original.sha256).toBeUndefined();
      expect(isChatModelEligible(original)).toBe(false);
      const identified = restore({ ...original, sha256: sha });
      const merged = mergeModelWithRuntimeState(original, { [source]: identified });
      expect(merged.sha256).toBe(sha);
      expect(getModelFileIdentity(merged)).not.toBe(getModelFileIdentity(original));
      expect(getModelRoleEvidence(merged)).toEqual([]);
      expect(getModelRoleEvidence(restore(sanitizeCatalogModelRuntimeState(merged)))).toEqual([]);
    });

  it.each(['sha', 'revision'] as const)('invalidates old GGUF evidence and metadata on a detail %s change', (change) => {
    const old = buildModelMetadataFromPayload(payload, null, null,
      { ...catalog(), gguf: { 'general.task': 'embedding' } });
    const refreshed = buildModelMetadataFromPayload({ ...payload,
      ...(change === 'revision' ? { sha: 'revision2' } : { siblings: payload.siblings!.map((file) => ({
        ...file, lfs: { sha256: 'c'.repeat(64) },
      })) }),
    }, null, null, old);
    expect(getModelFileIdentity(refreshed)).not.toBe(getModelFileIdentity(old));
    expect(getModelRoleEvidence(restore(sanitizeCatalogModelRuntimeState(refreshed)))
      .filter((entry) => entry.source === 'gguf_metadata')).toEqual([]);
  });

  it('keeps repository model-card, pipeline, and manual purposes across variant and persistence changes', () => {
    const first = transformHFResponse([{ ...payload, pipeline_tag: 'feature-extraction',
      cardData: { pipeline_tag: 'text-ranking' } }], null, null)[0];
    first.roleEvidence!.push({ source: 'manual', role: 'tts', confidence: 'inferred' });
    const selected = restore(sanitizeCatalogModelRuntimeState(chat(first)));
    expect(getModelRoleEvidence(selected)).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'pipeline_tag', role: 'embedding', confidence: 'declared' }),
      expect.objectContaining({ source: 'model_card', role: 'reranker', confidence: 'declared' }),
      expect.objectContaining({ source: 'manual', role: 'tts', confidence: 'inferred' }),
    ]));
    expect(isChatModelEligible(selected)).toBe(false);
  });
});
