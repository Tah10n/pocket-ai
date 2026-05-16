import {
  getCandidateModelDownloadFileNames,
  getLegacyModelDownloadFileName,
  getModelDownloadFileName,
  sanitizeModelFileSegment,
} from '../../src/utils/modelFiles';

describe('modelFiles', () => {
  it('uses the short repo label when building the download file name', () => {
    const fileName = getModelDownloadFileName({
      id: 'author/model-q4',
      resolvedFileName: 'weights/model-Q4_K_M.GGUF',
      hfRevision: 'main',
    });

    expect(fileName).toMatch(/^model-q4-main-[a-z0-9]+\.gguf$/);
  });

  it('returns both the hashed file name and the legacy fallback file name', () => {
    const fileName = getModelDownloadFileName({
      id: 'author/model-q4',
      resolvedFileName: 'model.gguf',
      hfRevision: 'main',
    });
    const candidates = getCandidateModelDownloadFileNames({
      id: 'author/model-q4',
      resolvedFileName: 'model.gguf',
      hfRevision: 'main',
    });

    expect(candidates).toEqual(expect.arrayContaining([
      fileName,
      getLegacyModelDownloadFileName('author/model-q4'),
    ]));
    expect(candidates[0]).toBe(fileName);
  });

  it('keeps valid classic legacy filenames with dots as candidates', () => {
    const candidates = getCandidateModelDownloadFileNames({
      id: 'Qwen/Qwen2.5-0.5B',
      resolvedFileName: 'model.gguf',
      hfRevision: 'main',
    });

    expect(getLegacyModelDownloadFileName('Qwen/Qwen2.5-0.5B')).toBe('Qwen_Qwen2.5-0.5B.gguf');
    expect(candidates).toContain('Qwen_Qwen2.5-0.5B.gguf');
  });

  it('falls back to sanitized default segments and gguf extension when metadata is unusable', () => {
    const fileName = getModelDownloadFileName({
      id: '///',
      resolvedFileName: undefined,
      hfRevision: '   ',
    });

    expect(fileName).toMatch(/^model-main-[a-z0-9]+\.gguf$/);
  });

  it('sanitizes generated and legacy filenames into safe single path segments', () => {
    expect(sanitizeModelFileSegment('../bad model', 'model')).toBe('bad_model');

    const legacyName = getLegacyModelDownloadFileName('author/../../bad model');
    expect(legacyName).toMatch(/^author_bad_model-[a-z0-9]+\.gguf$/);
    expect(getCandidateModelDownloadFileNames({
      id: 'author/../../bad model',
      resolvedFileName: '../../bad.gguf',
      hfRevision: '../main',
    })).toEqual(expect.arrayContaining([legacyName]));
    expect(getCandidateModelDownloadFileNames({
      id: 'author/../../bad model',
      resolvedFileName: '../../bad.gguf',
      hfRevision: '../main',
    })).not.toContain('author_.._.._bad model.gguf');
  });
});
