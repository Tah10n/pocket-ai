import {
  getCandidateModelDownloadFileNames,
  getCandidateCompanionArtifactDownloadFileNames,
  getCompanionArtifactDownloadFileName,
  getCandidateProjectorDownloadFileNames,
  getLegacyModelDownloadFileName,
  getModelDownloadFileName,
  getProjectorDownloadFileName,
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

  it('keeps previous generated filenames with dotted repo labels as candidates', () => {
    const fileName = getModelDownloadFileName({
      id: 'Qwen/Qwen2.5-0.5B',
      resolvedFileName: 'weights/model-Q4_K_M.GGUF',
      hfRevision: 'main',
    });
    const candidates = getCandidateModelDownloadFileNames({
      id: 'Qwen/Qwen2.5-0.5B',
      resolvedFileName: 'weights/model-Q4_K_M.GGUF',
      hfRevision: 'main',
    });

    expect(fileName).toMatch(/^Qwen2_5-0_5B-main-[a-z0-9]+\.gguf$/);
    expect(candidates[0]).toBe(fileName);
    expect(candidates).toEqual(expect.arrayContaining([
      expect.stringMatching(/^Qwen2\.5-0\.5B-main-[a-z0-9]+\.gguf$/),
    ]));
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

  it('builds collision-resistant projector file names with the legacy projector filename as a candidate', () => {
    const projector = {
      id: 'author/model::main::mmproj-model.gguf',
      ownerModelId: 'author/model',
      repoId: 'author/model',
      fileName: 'mmproj-model.gguf',
      hfRevision: 'main',
    };
    const otherProjector = {
      ...projector,
      id: 'other/model::main::mmproj-model.gguf',
      ownerModelId: 'other/model',
      repoId: 'other/model',
    };
    const fileName = getProjectorDownloadFileName(projector);

    expect(fileName).toMatch(/^model-mmproj-model-main-[a-z0-9]+\.gguf$/);
    expect(getProjectorDownloadFileName(otherProjector)).not.toBe(fileName);
    expect(getCandidateProjectorDownloadFileNames(projector)).toEqual([
      fileName,
      'mmproj-model.gguf',
    ]);
  });

  it('builds a safe collision-resistant filename for a nested Gemma MTP companion', () => {
    const artifact = {
      id: 'mtp-draft-a',
      remoteFileName: 'MTP/gemma-4-12b-it-MTP-Q8_0.gguf',
      hfRevision: 'revision-a',
      localPath: '../unsafe.gguf',
    };
    const fileName = getCompanionArtifactDownloadFileName('unsloth/gemma-4-12b-it-GGUF', artifact);

    expect(fileName).toMatch(/^gemma-4-12b-it-GGUF-gemma-4-12b-it-MTP-Q8_0-revision-a-[a-z0-9]+\.gguf$/);
    expect(getCandidateCompanionArtifactDownloadFileNames('unsloth/gemma-4-12b-it-GGUF', artifact)).toEqual([
      fileName,
    ]);
  });
});
