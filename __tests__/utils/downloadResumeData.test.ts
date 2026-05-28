import { normalizeDownloadResumeData } from '../../src/utils/downloadResumeData';

describe('normalizeDownloadResumeData', () => {
  it('extracts only opaque native resumeData from legacy Expo snapshots', () => {
    const normalized = normalizeDownloadResumeData(JSON.stringify({
      url: 'https://example.com/model.gguf',
      fileUri: 'file:///model.gguf',
      options: { headers: { Authorization: 'Bearer secret' } },
      resumeData: 'native-resume-token',
    }));

    expect(normalized).toBe('native-resume-token');
  });

  it('drops snapshots without resumeData and strings containing auth material', () => {
    expect(normalizeDownloadResumeData(JSON.stringify({ url: 'https://example.com/model.gguf' }))).toBeUndefined();
    expect(normalizeDownloadResumeData('Authorization: Bearer secret')).toBeUndefined();
    expect(normalizeDownloadResumeData({ resumeData: 'Bearer secret' })).toBeUndefined();
  });
});
