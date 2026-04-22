import {
  getCandidateModelDownloadFileNames,
  getLegacyModelDownloadFileName,
  getModelDownloadFileName,
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

  it('falls back to sanitized default segments and gguf extension when metadata is unusable', () => {
    const fileName = getModelDownloadFileName({
      id: '///',
      resolvedFileName: undefined,
      hfRevision: '   ',
    });

    expect(fileName).toMatch(/^model-main-[a-z0-9]+\.gguf$/);
  });
});
