import { isValidLocalFileName, safeJoinModelPath } from '../../src/utils/safeFilePath';

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
    expect(safeJoinModelPath('document://models/', '../escape.gguf')).toBeNull();
  });
});
