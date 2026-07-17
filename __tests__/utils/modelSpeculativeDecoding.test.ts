import {
  buildEmbeddedMtpConfig,
  canRecalculateMemoryFitWithoutOptionalMtpDraft,
  getConfiguredMtpDraftArtifact,
  getSelectedMtpDraftArtifact,
  hasMtpMetadata,
  isExplicitMtpDraftFileName,
  isMtpGgufFileName,
  normalizeModelSpeculativeDecodingConfig,
  resolveEffectiveSpeculativeDecoding,
  resolveSpeculativeDecodingWithEnabledOverride,
  resolveMtpMaxDraftTokens,
} from '../../src/utils/modelSpeculativeDecoding';

describe('modelSpeculativeDecoding', () => {
  it('distinguishes embedded MTP GGUFs from explicit draft companions', () => {
    expect(isMtpGgufFileName('qwen.NextN.Q4_K_M.gguf')).toBe(true);
    expect(isExplicitMtpDraftFileName('qwen.NextN.Q4_K_M.gguf')).toBe(false);
    expect(isExplicitMtpDraftFileName('MTP/gemma-4-12b-it-MTP-Q8_0.gguf')).toBe(true);
    expect(isExplicitMtpDraftFileName('mtp-gemma-4-12b-it-Q8_0.gguf')).toBe(true);
  });

  it('recognizes common MTP metadata shapes', () => {
    expect(hasMtpMetadata({ nextn_predict_layers: 1 })).toBe(true);
    expect(hasMtpMetadata({ text_config: { 'model.mtp.block_count': '2' } })).toBe(true);
    expect(hasMtpMetadata({ nextn_predict_layers: 0 })).toBe(false);
  });

  it('uses a conservative draft-token limit for low-bit quants', () => {
    expect(resolveMtpMaxDraftTokens('model.Q4_K_M.gguf')).toBe(1);
    expect(resolveMtpMaxDraftTokens('model.Q8_0.gguf')).toBe(3);
    expect(buildEmbeddedMtpConfig('model.Q4_K_M.gguf')).toEqual({
      type: 'mtp',
      mode: 'embedded',
      enabled: true,
      maxDraftTokens: 1,
    });
  });

  it('bounds persisted draft-token limits and rejects incomplete draft configs', () => {
    expect(normalizeModelSpeculativeDecodingConfig({
      type: 'mtp',
      mode: 'draft_model',
      enabled: true,
      maxDraftTokens: 99,
      draftArtifactId: 'draft-a',
    })).toEqual({
      type: 'mtp',
      mode: 'draft_model',
      enabled: true,
      maxDraftTokens: 8,
      draftArtifactId: 'draft-a',
    });
    expect(normalizeModelSpeculativeDecodingConfig({
      type: 'mtp',
      mode: 'draft_model',
      maxDraftTokens: 3,
    })).toBeUndefined();
  });

  it('keeps the legacy default only when persisted enabled is absent and fails malformed values closed', () => {
    expect(normalizeModelSpeculativeDecodingConfig({
      type: 'mtp',
      mode: 'embedded',
      maxDraftTokens: 3,
    })).toEqual({
      type: 'mtp',
      mode: 'embedded',
      enabled: true,
      maxDraftTokens: 3,
    });
    expect(normalizeModelSpeculativeDecodingConfig({
      type: 'mtp',
      mode: 'embedded',
      enabled: 'false',
      maxDraftTokens: 3,
    })).toEqual({
      type: 'mtp',
      mode: 'embedded',
      enabled: false,
      maxDraftTokens: 3,
    });
    expect(normalizeModelSpeculativeDecodingConfig({
      type: 'mtp',
      mode: 'embedded',
      enabled: 0,
      maxDraftTokens: 3,
    })).toEqual({
      type: 'mtp',
      mode: 'embedded',
      enabled: false,
      maxDraftTokens: 3,
    });

    const artifact = {
      id: 'draft-malformed-enabled',
      kind: 'speculative_draft' as const,
      requiredFor: ['text' as const],
      remoteFileName: 'MTP/gemma-MTP.gguf',
      downloadUrl: 'https://example.com/MTP/gemma-MTP.gguf',
      sizeBytes: 100,
      installState: 'installed' as const,
    };
    const normalizedDraftConfig = normalizeModelSpeculativeDecodingConfig({
      type: 'mtp',
      mode: 'draft_model',
      enabled: 'false',
      maxDraftTokens: 3,
      draftArtifactId: artifact.id,
    });
    expect(normalizedDraftConfig).toEqual(expect.objectContaining({ enabled: false }));
    expect(getSelectedMtpDraftArtifact({
      artifacts: [artifact],
      speculativeDecoding: normalizedDraftConfig,
    })).toBeUndefined();
  });

  it('keeps a configured draft visible while excluding a disabled draft from runtime selection', () => {
    const artifact = {
      id: 'draft-a',
      kind: 'speculative_draft' as const,
      requiredFor: ['text' as const],
      remoteFileName: 'MTP/gemma-MTP.gguf',
      downloadUrl: 'https://example.com/gemma-MTP.gguf',
      sizeBytes: 100,
      installState: 'installed' as const,
    };
    const model = {
      artifacts: [artifact],
      speculativeDecoding: {
        type: 'mtp' as const,
        mode: 'draft_model' as const,
        enabled: false,
        maxDraftTokens: 3,
        draftArtifactId: artifact.id,
      },
    };

    expect(getConfiguredMtpDraftArtifact(model)).toBe(artifact);
    expect(getSelectedMtpDraftArtifact(model)).toBeUndefined();
    expect(getSelectedMtpDraftArtifact(model, true)).toBe(artifact);
    expect(canRecalculateMemoryFitWithoutOptionalMtpDraft(model)).toBe(false);
    expect(canRecalculateMemoryFitWithoutOptionalMtpDraft(model, true)).toBe(true);

    const catalogEnabledModel = {
      ...model,
      speculativeDecoding: {
        ...model.speculativeDecoding,
        enabled: true,
      },
    };
    expect(getSelectedMtpDraftArtifact(catalogEnabledModel, false)).toBeUndefined();
    expect(canRecalculateMemoryFitWithoutOptionalMtpDraft(catalogEnabledModel, false)).toBe(true);
  });

  it('recovers MTP capability from one canonical draft artifact when derived config is missing', () => {
    const artifact = {
      id: 'draft-a',
      kind: 'speculative_draft' as const,
      requiredFor: ['text' as const],
      remoteFileName: 'MTP/gemma-MTP-Q8_0.gguf',
      downloadUrl: 'https://example.com/gemma-MTP-Q8_0.gguf',
      sizeBytes: 100,
      localPath: '/models/gemma-MTP-Q8_0.gguf',
      installState: 'installed' as const,
    };
    const model = {
      activeVariantId: 'main-q4',
      variants: [{
        variantId: 'main-q4',
        fileName: 'gemma-Q4_K_M.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 1_000,
      }],
      artifacts: [artifact],
    };

    expect(resolveEffectiveSpeculativeDecoding(model)).toEqual({
      type: 'mtp',
      mode: 'draft_model',
      enabled: true,
      maxDraftTokens: 3,
      draftArtifactId: artifact.id,
    });
    expect(getConfiguredMtpDraftArtifact(model)).toBe(artifact);
  });

  it('does not guess an MTP companion when multiple drafts lack an explicit association', () => {
    const makeDraft = (id: string) => ({
      id,
      kind: 'speculative_draft' as const,
      requiredFor: ['text' as const],
      remoteFileName: `MTP/${id}.gguf`,
      downloadUrl: `https://example.com/${id}.gguf`,
      sizeBytes: 100,
      installState: 'installed' as const,
    });

    expect(resolveEffectiveSpeculativeDecoding({
      artifacts: [makeDraft('draft-a'), makeDraft('draft-b')],
    })).toBeUndefined();
  });

  it('applies a per-model enabled override without mutating catalog metadata', () => {
    const model = {
      speculativeDecoding: {
        type: 'mtp' as const,
        mode: 'embedded' as const,
        enabled: true,
        maxDraftTokens: 3,
      },
    };

    expect(resolveSpeculativeDecodingWithEnabledOverride(model, false)).toEqual({
      ...model.speculativeDecoding,
      enabled: false,
    });
    expect(model.speculativeDecoding.enabled).toBe(true);
  });
});
