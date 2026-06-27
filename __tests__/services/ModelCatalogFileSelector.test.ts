import {
  buildCatalogModelVariants,
  CATALOG_SEARCH_VARIANT_LIMIT,
  getProjectorCompanionEntries,
  getFileSize,
  hasProjectorCompanionEntries,
  isEligibleGgufEntry,
  isCatalogSummarySupported,
  isProjectorFileName,
  isUnsupportedMtpFileName,
  limitModelVariants,
  selectTreeEntryForModel,
  selectPreferredGgufEntry,
} from '../../src/services/ModelCatalogFileSelector';
import {
  projectorFileName,
  projectorSibling,
  visionModelFileName,
  visionModelSibling,
} from '../fixtures/multimodalCatalogFixtures';

describe('ModelCatalogFileSelector', () => {
  const largeFileSize = 512 * 1024 * 1024;

  it.each([
    'model.mmproj.gguf',
    'model-mm_projector.gguf',
    'subdir/mmproj-model.gguf',
    'clip-projector.Q4_K_M.gguf',
    'clip_projector.fp16.gguf',
  ])('treats %s as a projector file', (fileName) => {
    expect(isProjectorFileName(fileName)).toBe(true);
    expect(isEligibleGgufEntry({ rfilename: fileName, size: largeFileSize })).toBe(false);
  });

  it.each([
    'mmproj-config.json',
    'clip_projector.txt',
    'model.mmproj.safetensors',
  ])('does not treat non-GGUF projector-like sibling %s as a projector companion', (fileName) => {
    const entries = [
      { rfilename: fileName, size: 10_000 },
      { rfilename: 'model.Q4_K_M.gguf', size: largeFileSize },
    ];

    expect(isProjectorFileName(fileName)).toBe(false);
    expect(getProjectorCompanionEntries(entries)).toEqual([]);
    expect(selectPreferredGgufEntry(entries)?.rfilename).toBe('model.Q4_K_M.gguf');
  });

  it.each([
    'model.MTP.Q4_K_M.gguf',
    'model.NextN.Q4_K_M.gguf',
    'subdir/model.multi-token-prediction.Q4_K_M.gguf',
  ])('treats %s as an unsupported MTP file', (fileName) => {
    expect(isUnsupportedMtpFileName(fileName)).toBe(true);
    expect(isEligibleGgufEntry({ rfilename: fileName, size: largeFileSize })).toBe(false);
  });

  it('selects the language model GGUF instead of an mmproj candidate', () => {
    const selected = selectPreferredGgufEntry([
      { rfilename: 'model.mmproj.gguf', size: largeFileSize },
      { rfilename: 'model.Q4_K_M.gguf', size: largeFileSize },
      { rfilename: 'model.Q8_0.gguf', size: largeFileSize },
    ]);

    expect(selected?.rfilename).toBe('model.Q4_K_M.gguf');
  });

  it('classifies projector companions without offering them as chat variants', () => {
    const entries = [
      projectorSibling,
      visionModelSibling,
    ];

    expect(hasProjectorCompanionEntries(entries)).toBe(true);
    expect(getProjectorCompanionEntries(entries).map((entry) => entry.rfilename)).toEqual([projectorFileName]);
    const variants = buildCatalogModelVariants(entries);
    expect(variants).toHaveLength(1);
    expect(variants[0]).toEqual(expect.objectContaining({
      fileName: visionModelFileName,
    }));
    expect(variants[0]).not.toHaveProperty('artifactRole', 'projector_companion');
  });

  it('keeps GGUF vision-chat catalog summaries eligible even when the pipeline is image-text-to-text', () => {
    expect(isCatalogSummarySupported({
      id: 'test-org/vision-chat-model',
      pipeline_tag: 'image-text-to-text',
      siblings: [
        projectorSibling,
        visionModelSibling,
      ],
    })).toBe(true);
  });

  it('keeps GGUF vision-chat catalog summaries eligible when the vision task is only a tag', () => {
    expect(isCatalogSummarySupported({
      id: 'test-org/tagged-vision-chat-model',
      tags: ['gguf', 'image-text-to-text'],
      siblings: [
        { rfilename: 'model.Q4_K_M.gguf', size: largeFileSize },
      ],
    })).toBe(true);
  });

  it.each([
    'audio-text-to-text',
    'automatic-speech-recognition',
    'video-text-to-text',
  ])('keeps GGUF multimodal chat catalog summaries eligible for %s', (pipelineTag) => {
    expect(isCatalogSummarySupported({
      id: `test-org/${pipelineTag}-model`,
      pipeline_tag: pipelineTag,
      tags: ['gguf'],
      siblings: [
        { rfilename: 'model.Q4_K_M.gguf', size: largeFileSize },
      ],
    })).toBe(true);
  });

  it('still excludes GGUF catalog summaries with non-vision unsupported tags', () => {
    expect(isCatalogSummarySupported({
      id: 'test-org/audio-model',
      tags: ['gguf', 'text-to-audio'],
      siblings: [
        { rfilename: 'model.Q4_K_M.gguf', size: largeFileSize },
      ],
    })).toBe(false);
  });

  it('selects the supported text GGUF instead of an MTP candidate', () => {
    const selected = selectPreferredGgufEntry([
      { rfilename: 'model.NextN.Q4_K_M.gguf', size: largeFileSize },
      { rfilename: 'model.Q5_K_M.gguf', size: largeFileSize },
    ]);

    expect(selected?.rfilename).toBe('model.Q5_K_M.gguf');
  });

  it('uses the documented catalog ranking instead of the first GGUF entry', () => {
    const selected = selectPreferredGgufEntry([
      { rfilename: 'model.Q8_0.gguf', size: largeFileSize },
      { rfilename: 'model.Q5_K_M.gguf', size: largeFileSize },
      { rfilename: 'model.Q4_K_S.gguf', size: largeFileSize },
    ]);

    expect(selected?.rfilename).toBe('model.Q4_K_S.gguf');
  });

  it('ranks i-quants ahead of full-precision files when no preferred K-quant is available', () => {
    const entries = [
      { rfilename: 'model.F16.gguf', size: 16_000_000_000 },
      { rfilename: 'model.IQ2_XS.gguf', size: 2_500_000_000 },
      { rfilename: 'model.IQ4_XS.gguf', size: 3_500_000_000 },
    ];

    const selected = selectPreferredGgufEntry(entries);
    const variants = buildCatalogModelVariants(entries);

    expect(selected?.rfilename).toBe('model.IQ4_XS.gguf');
    expect(variants.map((variant) => variant.quantizationLabel)).toEqual([
      'IQ4_XS',
      'IQ2_XS',
      'F16',
    ]);
  });

  it('labels FP16 and FP32 full-precision variants explicitly', () => {
    const variants = buildCatalogModelVariants([
      { rfilename: 'model.fp16.gguf', size: 16_000_000_000 },
      { rfilename: 'model.fp32.gguf', size: 32_000_000_000 },
    ]);

    expect(variants.map((variant) => variant.quantizationLabel)).toEqual(['FP16', 'FP32']);
  });

  it('builds sorted text-model variants with file identity and SHA metadata', () => {
    const variants = buildCatalogModelVariants([
      { rfilename: 'model.mmproj.gguf', size: largeFileSize },
      { rfilename: 'model.MTP.Q4_K_M.gguf', size: largeFileSize },
      { rfilename: 'model.Q8_0.gguf', size: 8_000_000_000, lfs: { sha256: 'a'.repeat(64) } },
      { rfilename: 'model.Q4_K_M.gguf', size: 4_000_000_000, lfs: { sha256: 'b'.repeat(64) } },
    ]);

    expect(variants).toEqual([
      {
        variantId: 'model.Q4_K_M.gguf',
        fileName: 'model.Q4_K_M.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 4_000_000_000,
        sha256: 'b'.repeat(64),
      },
      {
        variantId: 'model.Q8_0.gguf',
        fileName: 'model.Q8_0.gguf',
        quantizationLabel: 'Q8_0',
        size: 8_000_000_000,
        sha256: 'a'.repeat(64),
      },
    ]);
  });

  it('treats explicit zero-size metadata as known invalid instead of missing', () => {
    const zeroSizeEntry = { rfilename: 'model.Q4_K_M.gguf', size: 0 };

    expect(getFileSize(zeroSizeEntry)).toBe(0);
    expect(isEligibleGgufEntry(zeroSizeEntry)).toBe(false);
    expect(buildCatalogModelVariants([zeroSizeEntry])).toEqual([]);
  });

  it('caps search variants while preserving an explicitly selected file outside the top ranks', () => {
    const preferredEntries = Array.from({ length: CATALOG_SEARCH_VARIANT_LIMIT + 2 }, (_value, index) => ({
      rfilename: `model-${String(index).padStart(2, '0')}.Q4_K_M.gguf`,
      size: (index + 1) * largeFileSize,
    }));
    const pinnedFileName = 'model-pinned.Q8_0.gguf';

    const variants = buildCatalogModelVariants([
      ...preferredEntries,
      { rfilename: pinnedFileName, size: 16_000_000_000 },
    ], {
      limit: CATALOG_SEARCH_VARIANT_LIMIT,
      includeFileNames: [pinnedFileName],
    });

    expect(variants).toHaveLength(CATALOG_SEARCH_VARIANT_LIMIT);
    expect(variants.some((variant) => variant.fileName === pinnedFileName)).toBe(true);
    expect(variants[0].fileName).toBe('model-00.Q4_K_M.gguf');
  });

  it('keeps variant limits even when many local variants are present', () => {
    const activeFileName = 'model-active.Q8_0.gguf';
    const variants = Array.from({ length: CATALOG_SEARCH_VARIANT_LIMIT + 4 }, (_value, index) => ({
      variantId: `local-${String(index).padStart(2, '0')}.Q4_K_M.gguf`,
      fileName: `local-${String(index).padStart(2, '0')}.Q4_K_M.gguf`,
      quantizationLabel: 'Q4_K_M',
      size: (index + 1) * largeFileSize,
      isLocal: true,
    }));
    variants.push({
      variantId: activeFileName,
      fileName: activeFileName,
      quantizationLabel: 'Q8_0',
      size: 16_000_000_000,
      isLocal: true,
    });

    const capped = limitModelVariants(variants, {
      limit: CATALOG_SEARCH_VARIANT_LIMIT,
      includeFileNames: [activeFileName],
    });

    expect(capped).toHaveLength(CATALOG_SEARCH_VARIANT_LIMIT);
    expect(capped?.some((variant) => variant.fileName === activeFileName)).toBe(true);
  });

  it('ignores an exact resolved projector filename during tree revalidation', () => {
    const selected = selectTreeEntryForModel(
      {
        id: 'org/model',
        name: 'model',
        downloadUrl: 'https://example.com/model.mmproj.gguf',
        resolvedFileName: 'model.mmproj.gguf',
        requiresTreeProbe: false,
      } as any,
      [
        { path: 'model.mmproj.gguf', size: largeFileSize },
        { path: 'model.Q4_K_M.gguf', size: largeFileSize },
      ],
    );

    expect(selected?.path).toBe('model.Q4_K_M.gguf');
  });

  it('honors an explicit resolved text filename even when a tree probe is still required', () => {
    const selected = selectTreeEntryForModel(
      {
        id: 'org/model',
        name: 'model',
        downloadUrl: 'https://example.com/model.Q8_0.gguf',
        resolvedFileName: 'model.Q8_0.gguf',
        requiresTreeProbe: true,
      } as any,
      [
        { path: 'model.Q4_K_M.gguf', size: largeFileSize },
        { path: 'model.Q8_0.gguf', size: largeFileSize },
      ],
    );

    expect(selected?.path).toBe('model.Q8_0.gguf');
  });

  it('does not reject text GGUF names that only contain projector as a normal word', () => {
    const textModel = { rfilename: 'subdir/projector-series.Q4_K_M.gguf', size: largeFileSize };

    expect(isProjectorFileName(textModel.rfilename)).toBe(false);
    expect(isEligibleGgufEntry(textModel)).toBe(true);
  });
});
