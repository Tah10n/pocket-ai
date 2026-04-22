import { getShortModelLabel } from '../../src/utils/modelLabel';

describe('getShortModelLabel', () => {
  it('returns the final segment of a model id', () => {
    expect(getShortModelLabel('author/model-q4')).toBe('model-q4');
  });

  it('ignores trailing slashes', () => {
    expect(getShortModelLabel('author/model-q4/')).toBe('model-q4');
  });

  it('returns an empty string for missing or blank identifiers', () => {
    expect(getShortModelLabel('   ')).toBe('');
    expect(getShortModelLabel(undefined as unknown as string)).toBe('');
  });
});
