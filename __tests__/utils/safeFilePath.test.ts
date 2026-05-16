import { fileUriToNativePath, isValidLocalFileName, safeJoinModelPath } from '../../src/utils/safeFilePath';

describe('safeFilePath', () => {
  it.each([
    ['model.gguf', true],
    ['', false],
    [' model.gguf', false],
    ['model.gguf ', false],
    ['.', false],
    ['..', false],
    ['nested/model.gguf', false],
    ['nested\\model.gguf', false],
    ['model..gguf', false],
    [`model\0.gguf`, false],
  ])('validates %p as %p', (fileName, expected) => {
    expect(isValidLocalFileName(fileName)).toBe(expected);
  });

  it('joins only safe local file names onto the models directory', () => {
    expect(safeJoinModelPath('document://models/', 'model.gguf')).toBe('document://models/model.gguf');
    expect(safeJoinModelPath('document://models', 'model.gguf')).toBe('document://models/model.gguf');
    expect(safeJoinModelPath('document://models/', '../escape.gguf')).toBeNull();
  });

  it('converts file uris to native paths without decoding path separators', () => {
    expect(fileUriToNativePath('file:///data/user/0/Pocket%20AI/models/model.gguf'))
      .toBe('/data/user/0/Pocket AI/models/model.gguf');
    expect(fileUriToNativePath('file:///data/user/0/app/models/model%2Fescape.gguf'))
      .toBe('/data/user/0/app/models/model%2Fescape.gguf');
    expect(fileUriToNativePath('file:///data/user/0/app/models/model%5Cescape.gguf'))
      .toBe('/data/user/0/app/models/model%5Cescape.gguf');
  });
});
