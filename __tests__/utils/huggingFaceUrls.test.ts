import {
  DEFAULT_HF_REVISION,
  buildHuggingFaceResolveUrl,
  buildHuggingFaceTreeUrl,
  getHuggingFaceModelUrl,
  isHuggingFaceUrl,
  normalizeHuggingFaceRevision,
  resolveHuggingFaceRevision,
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
  });
});

