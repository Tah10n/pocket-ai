import {
  DEFAULT_HF_REVISION,
  buildHuggingFaceResolveUrl,
  buildHuggingFaceTreeUrl,
  getHuggingFaceModelUrl,
  hasHuggingFaceHostname,
  isHuggingFaceUrl,
  normalizeHuggingFaceFilePath,
  normalizeHuggingFaceRevision,
  resolveHuggingFaceResolveIdentity,
  resolveHuggingFaceRevision,
  resolveRemoteFilePathFromDownloadUrl,
  resolveRemoteProjectorIdentity,
} from '../../src/utils/huggingFaceUrls';

describe('huggingFaceUrls', () => {
  it('normalizes and resolves revisions', () => {
    expect(normalizeHuggingFaceRevision(null)).toBeUndefined();
    expect(normalizeHuggingFaceRevision('  ')).toBeUndefined();
    expect(normalizeHuggingFaceRevision(' main ')).toBe('main');
    expect(resolveHuggingFaceRevision(undefined)).toBe(DEFAULT_HF_REVISION);
    expect(resolveHuggingFaceRevision(' dev ')).toBe('dev');
  });

  it('builds model and api urls with encoded segments', () => {
    expect(getHuggingFaceModelUrl('org/model')).toBe('https://huggingface.co/org/model');
    expect(getHuggingFaceModelUrl('org/My Model')).toBe('https://huggingface.co/org/My%20Model');
  });

  it('builds resolve and tree urls', () => {
    expect(buildHuggingFaceResolveUrl('org/model', 'weights/model.Q4_K_M.gguf', 'main')).toBe(
      'https://huggingface.co/org/model/resolve/main/weights/model.Q4_K_M.gguf',
    );

    expect(buildHuggingFaceResolveUrl('org/model', 'weights/my file.gguf', 'dev branch')).toBe(
      'https://huggingface.co/org/model/resolve/dev%20branch/weights/my%20file.gguf',
    );

    expect(buildHuggingFaceTreeUrl('org/model', null)).toBe(
      'https://huggingface.co/api/models/org/model/tree/main?recursive=true',
    );
  });

  it('detects Hugging Face urls and rejects impostors', () => {
    expect(isHuggingFaceUrl('https://huggingface.co/org/model')).toBe(true);
    expect(isHuggingFaceUrl('https://cdn-lfs.huggingface.co/org/model/resolve/main/model.gguf')).toBe(true);
    expect(isHuggingFaceUrl('https://hf.co/org/model')).toBe(true);
    expect(isHuggingFaceUrl('https://HUGGINGFACE.CO/org/model')).toBe(true);

    expect(isHuggingFaceUrl('http://huggingface.co/org/model')).toBe(false);
    expect(isHuggingFaceUrl('https://huggingface.co.evil.com/org/model')).toBe(false);
    expect(isHuggingFaceUrl('not-a-url')).toBe(false);
    expect(hasHuggingFaceHostname('http://huggingface.co/org/model')).toBe(true);
    expect(hasHuggingFaceHostname('http://hf.co/org/model')).toBe(true);
    expect(hasHuggingFaceHostname('https://huggingface.co./org/model')).toBe(true);
    expect(hasHuggingFaceHostname('https://hf.co./org/model')).toBe(true);
    expect(hasHuggingFaceHostname('https://huggingface.co.evil.com/org/model')).toBe(false);
  });

  it('resolves an exact nested remote identity while stripping query and fragment data', () => {
    const url = 'https://hf.co/Org/Model/resolve/rev%2Fone/Projectors/Audio%20Plus/MMProj-A.GGUF?download=1#ignored';

    expect(resolveHuggingFaceResolveIdentity(url)).toEqual({
      repoId: 'Org/Model',
      revision: 'rev/one',
      filePath: 'Projectors/Audio Plus/MMProj-A.GGUF',
    });
    expect(resolveRemoteProjectorIdentity({
      repoId: 'Org/Model',
      revision: 'rev/one',
      filePath: 'Projectors\\Audio Plus//MMProj-A.GGUF',
      downloadUrl: url,
    })).toEqual({
      repoId: 'Org/Model',
      revision: 'rev/one',
      filePath: 'Projectors/Audio Plus/MMProj-A.GGUF',
    });
  });

  it.each([
    'http://huggingface.co/org/model/resolve/main/mmproj.gguf',
    'https://huggingface.co.evil.example/org/model/resolve/main/mmproj.gguf',
    'https://user@huggingface.co/org/model/resolve/main/mmproj.gguf',
    'https://huggingface.co:444/org/model/resolve/main/mmproj.gguf',
    'https://huggingface.co/org/model/raw/main/mmproj.gguf',
    'https://huggingface.co/org/model/resolve/main/',
    'https://huggingface.co/org/model/resolve/main/a/../mmproj.gguf',
    'https://huggingface.co/org/model/resolve/main/a/%2E%2E/mmproj.gguf',
    'https://huggingface.co/org/model/resolve/main/a%2Fmmproj.gguf',
    'https://huggingface.co/org/model/resolve/main/%E0%A4%A',
    'https://huggingface.co./org/model/resolve/main/mmproj.gguf',
    'https://hf.co./org/model/resolve/main/mmproj.gguf',
    String.raw`https://huggingface.co\@evil.com/org/repo/resolve/main/file.gguf`,
    String.raw`https:\\huggingface.co\org\model\resolve\main\mmproj.gguf`,
    'https://hugging\u0009face.co/org/model/resolve/main/mmproj.gguf',
    'https://hugging\u000dface.co/org/model/resolve/main/mmproj.gguf',
    'https://hugging\u000aface.co/org/model/resolve/main/mmproj.gguf',
  ])('rejects an unsafe or malformed resolve URL: %s', (url) => {
    expect(resolveHuggingFaceResolveIdentity(url)).toBeNull();
  });

  it('rejects candidate fields that disagree with their URL identity', () => {
    const downloadUrl = buildHuggingFaceResolveUrl('org/model', 'audio/MMProj.GGUF', 'main');

    expect(resolveRemoteProjectorIdentity({
      repoId: 'other/model',
      revision: 'main',
      filePath: 'audio/MMProj.GGUF',
      downloadUrl,
    })).toBeNull();
    expect(resolveRemoteProjectorIdentity({
      repoId: 'org/model',
      revision: 'dev',
      filePath: 'audio/MMProj.GGUF',
      downloadUrl,
    })).toBeNull();
    expect(resolveRemoteProjectorIdentity({
      repoId: 'org/model',
      revision: 'main',
      filePath: 'vision/MMProj.GGUF',
      downloadUrl,
    })).toBeNull();
  });

  it('resolves an exact ordinary HTTP mirror path and rejects unsafe mirror URLs', () => {
    expect(resolveRemoteFilePathFromDownloadUrl(
      'http://mirror.example/Projectors/Audio%20Plus/MMProj-A.GGUF?download=1#ignored',
    )).toBe('Projectors/Audio Plus/MMProj-A.GGUF');

    for (const url of [
      'not a url',
      'file:///Projectors/MMProj.GGUF',
      'https://user@mirror.example/Projectors/MMProj.GGUF',
      'https://mirror.example/Projectors/../MMProj.GGUF',
      'https://mirror.example/Projectors/%2E%2E/MMProj.GGUF',
      String.raw`https://mirror.example\@evil.com/Projectors/MMProj.GGUF`,
    ]) {
      expect(resolveRemoteFilePathFromDownloadUrl(url)).toBeNull();
    }
  });

  it.each(['', '.', '..', '/absolute/mmproj.gguf', 'C:\\private\\mmproj.gguf', 'a/../mmproj.gguf'])(
    'rejects a non-repository-relative file path: %s',
    (filePath) => {
      expect(normalizeHuggingFaceFilePath(filePath)).toBeNull();
    },
  );
});

