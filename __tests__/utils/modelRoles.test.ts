import { normalizePersistedModelMetadata } from '../../src/services/ModelMetadataNormalizer';
import { buildModelMetadataFromPayload, transformHFResponse } from '../../src/services/ModelCatalogTransformer';
import { sanitizeCatalogModelRuntimeState } from '../../src/services/ModelCatalogCacheStore';
import { extractReadmeData } from '../../src/services/ModelReadmeParser';
import { getModelFileIdentity, getModelRoleEvidence, isChatModelEligible, normalizeModelRoleEvidence } from '../../src/utils/modelRoles';
import { mergeModelWithRuntimeState } from '../../src/utils/modelRuntimeState';
import { applyModelVariantSelection } from '../../src/utils/modelVariants';
import type { ModelMetadata } from '../../src/types/models';
import type { ModelRoleValidation } from '../../src/types/modelRoles';

const sha = 'a'.repeat(64);
function model(overrides: Partial<ModelMetadata> = {}): ModelMetadata {
  return normalizePersistedModelMetadata({
    id: 'org/model', resolvedFileName: 'model.gguf', hfRevision: 'revision1',
    downloadUrl: 'https://huggingface.co/org/model/resolve/revision1/model.gguf',
    size: 1024, sha256: sha, ...overrides,
  });
}
function checked(subject: ModelMetadata): ModelRoleValidation {
  return { role: 'embedding', operation: 'embedding', status: 'passed', runtimeVersion: '0.13.0-rc.3',
    checkedAt: 100, fileIdentity: getModelFileIdentity(subject) };
}

describe('model purposes across catalog and persistence', () => {
  it.each(['adapter_model.gguf', 'adapters/lora.gguf', 'codec.Q8_0.gguf', 'vocoder-f16.gguf'])
    ('keeps companion %s out of standalone catalog variants and new chat selection', (fileName) => {
      const companion = { rfilename: fileName, size: 64 * 1024 * 1024 };
      const onlyCompanion = transformHFResponse([{ id: 'org/resources', tags: ['gguf'], siblings: [companion] }], null, null);
      expect(onlyCompanion).toEqual([]);
      const mixed = transformHFResponse([{ id: 'org/mixed', siblings: [companion,
        { rfilename: 'chat.Q4_K_M.gguf', size: 128 * 1024 * 1024 }] }], null, null);
      expect(mixed).toHaveLength(1);
      expect(mixed[0].variants?.map(variant => variant.fileName)).toEqual(['chat.Q4_K_M.gguf']);
      expect(isChatModelEligible(model({ resolvedFileName: fileName }))).toBe(false);
    });

  it('does not classify full models with LoRA training names as adapter files', () => {
    expect(isChatModelEligible(model({ resolvedFileName: 'mistral-lora-merged-Q4_K_M.gguf' }))).toBe(true);
    expect(isChatModelEligible(model({ resolvedFileName: 'unknown-specialized.gguf' }))).toBe(true);
  });

  it('keeps legacy and unknown models chat eligible without claiming a role', () => {
    expect(getModelRoleEvidence(model())).toEqual([]);
    expect(isChatModelEligible(model())).toBe(true);
  });

  it.each(['feature-extraction', 'sentence-similarity', 'text-ranking', 'text-to-speech', 'text-to-audio'])
    ('excludes declared specialized %s models from ordinary chat after normalization', (pipeline_tag) => {
      const models = transformHFResponse([{ id: 'org/model', pipeline_tag,
        siblings: [{ rfilename: 'model.gguf', size: 24 * 1024 * 1024, lfs: { sha256: sha } }] }], null, null);
      expect(models).toHaveLength(1);
      const restored = normalizePersistedModelMetadata(JSON.parse(JSON.stringify(models[0])));
      expect(isChatModelEligible(restored)).toBe(false);
      expect(restored.roleValidation).toBeUndefined();
    });

  it('does not turn audio input into speech synthesis', () => {
    const subject = model({ chatModalities: ['audio'], tags: ['audio', 'audio-text-to-text'] });
    expect(getModelRoleEvidence(subject).some((entry) => entry.role === 'tts')).toBe(false);
  });

  it.each([[1, 'embedding'], [4, 'reranker']] as const)
    ('uses an explicit GGUF pooling head %s as declared %s purpose without native claims', (pooling, role) => {
      const subject = model({ gguf: { 'general.architecture': 'bert', 'bert.pooling_type': pooling } });
      expect(getModelRoleEvidence(subject)).toContainEqual(expect.objectContaining({
        role, source: 'gguf_metadata', confidence: 'declared',
      }));
      expect(isChatModelEligible(subject)).toBe(false);
      expect(subject.roleValidation).toBeUndefined();
    });

  it('keeps heuristics and manual assignment unverified and permits multipurpose models', () => {
    const heuristic = model({ roleEvidence: [{ role: 'tts', source: 'manual', confidence: 'declared' }] });
    expect(heuristic.roleEvidence?.[0].confidence).toBe('inferred');
    expect(isChatModelEligible(heuristic)).toBe(true);
    expect(isChatModelEligible(model({ roleEvidence: [
      { role: 'embedding', source: 'pipeline_tag', confidence: 'declared' },
      { role: 'chat', source: 'model_card', confidence: 'declared' },
    ] }))).toBe(true);
    expect(normalizeModelRoleEvidence([{ role: 'all', source: 'tag', confidence: 'declared' }])).toBeUndefined();
  });

  it('preserves variant-specific purposes and honors them over repository purpose', () => {
    const restored = model({ roleEvidence: [{ role: 'chat', source: 'pipeline_tag', confidence: 'declared' }],
      activeVariantId: 'model.gguf', variants: [{ variantId: 'model.gguf', fileName: 'model.gguf',
        quantizationLabel: 'F16', size: 1024,
        roleEvidence: [{ role: 'embedding', source: 'gguf_metadata', confidence: 'declared',
          fileIdentity: getModelFileIdentity(model()) }] }] });
    expect(isChatModelEligible(restored)).toBe(false);
  });

  it('round-trips catalog purpose and restores native checks from the registry runtime on refresh', () => {
    const local = model({ roleEvidence: [{ role: 'embedding', source: 'pipeline_tag', confidence: 'declared' }] });
    local.roleValidation = [checked(local)];
    const cached = sanitizeCatalogModelRuntimeState(local);
    expect(cached.roleEvidence).toEqual(local.roleEvidence);
    expect(cached.roleValidation).toBeUndefined();
    const hydrated = normalizePersistedModelMetadata(JSON.parse(JSON.stringify(local)));
    const refreshed = mergeModelWithRuntimeState(cached, { localModel: hydrated });
    expect(refreshed.roleValidation).toEqual(local.roleValidation);
    expect(isChatModelEligible(refreshed)).toBe(false);
  });

  it.each([
    { sha256: 'b'.repeat(64) }, { hfRevision: 'revision2' },
    { downloadUrl: 'https://huggingface.co/other/model/resolve/revision1/model.gguf' },
    { resolvedFileName: 'other.gguf' }, { size: 2048 },
  ])('invalidates native results when file identity changes: %j', (change) => {
    const original = model();
    const restored = model({ roleValidation: [checked(original)], ...change });
    expect(restored.roleValidation).toBeUndefined();
    expect(mergeModelWithRuntimeState(restored, { localModel: { ...original, roleValidation: [checked(original)] } }).roleValidation).toBeUndefined();
  });

  it('invalidates native readiness on a selected variant change', () => {
    const subject = model({ variants: [
      { variantId: 'model.gguf', fileName: 'model.gguf', size: 1024, quantizationLabel: 'F16', sha256: sha },
      { variantId: 'other.gguf', fileName: 'other.gguf', size: 2048, quantizationLabel: 'F32', sha256: 'b'.repeat(64) },
    ] });
    subject.roleValidation = [checked(subject)];
    expect(applyModelVariantSelection(subject, 'other.gguf').roleValidation).toBeUndefined();
  });

  it('does not carry a GGUF pooling declaration to another variant', () => {
    const subject = model({ gguf: { 'general.architecture': 'bert', 'bert.pooling_type': 1 }, variants: [
      { variantId: 'model.gguf', fileName: 'model.gguf', size: 1024, quantizationLabel: 'F16' },
      { variantId: 'other.gguf', fileName: 'other.gguf', size: 2048, quantizationLabel: 'F32' },
    ] });
    expect(isChatModelEligible(subject)).toBe(false);
    expect(getModelRoleEvidence(applyModelVariantSelection(subject, 'other.gguf'))).toEqual([]);
  });

  it('retains local purpose on a catalog detail refresh without purpose metadata', () => {
    const fallback = model({ roleEvidence: [{ role: 'embedding', source: 'manual', confidence: 'inferred' }] });
    const result = buildModelMetadataFromPayload({ id: fallback.id, sha: 'revision1',
      siblings: [{ rfilename: 'model.gguf', size: 1024, lfs: { sha256: sha } }] }, null, null, fallback);
    expect(result.roleEvidence).toEqual(fallback.roleEvidence);
  });

  it('replaces stale declarations from the same source on refresh rather than inventing multipurpose support', () => {
    const fallback = model({ roleEvidence: [{ role: 'chat', source: 'pipeline_tag', confidence: 'declared' }] });
    const result = buildModelMetadataFromPayload({ id: fallback.id, pipeline_tag: 'feature-extraction',
      siblings: [{ rfilename: 'model.gguf', size: 24 * 1024 * 1024 }] }, null, null, fallback);
    expect(isChatModelEligible(result)).toBe(false);
    expect(result.roleEvidence?.filter((entry) => entry.source === 'pipeline_tag').map((entry) => entry.role))
      .toEqual(['embedding']);
  });

  it('extracts purpose declared in model card front matter', () => {
    expect(extractReadmeData('---\npipeline_tag: feature-extraction\n---\nA model').cardData?.pipeline_tag)
      .toBe('feature-extraction');
  });
});
