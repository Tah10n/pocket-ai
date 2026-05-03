import {
  isEligibleGgufEntry,
  isProjectorFileName,
  selectTreeEntryForModel,
  selectPreferredGgufEntry,
} from '../../src/services/ModelCatalogFileSelector';

describe('ModelCatalogFileSelector', () => {
  const largeFileSize = 512 * 1024 * 1024;

  it.each([
    'model.mmproj.gguf',
    'model-mm_projector.gguf',
    'clip-projector.Q4_K_M.gguf',
    'clip_projector.fp16.gguf',
  ])('treats %s as a projector file', (fileName) => {
    expect(isProjectorFileName(fileName)).toBe(true);
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

  it('does not reject text GGUF names that only contain projector as a normal word', () => {
    const textModel = { rfilename: 'projector-series.Q4_K_M.gguf', size: largeFileSize };

    expect(isProjectorFileName(textModel.rfilename)).toBe(false);
    expect(isEligibleGgufEntry(textModel)).toBe(true);
  });
});
