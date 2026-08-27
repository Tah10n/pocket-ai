const fs = require('fs');
const path = require('path');

describe('PocketAnyDoc iOS source contracts', () => {
  const sourcePath = path.join(
    __dirname,
    '..',
    '..',
    'modules',
    'pocket-anydoc',
    'ios',
    'PocketAnyDocModule.swift'
  );

  it('returns every native response from the engine gate closure', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    for (const nativeCall of [
      'pocket_anydoc_prepare',
      'pocket_anydoc_select_context',
      'pocket_anydoc_materialize_asset',
    ]) {
      expect(source).toMatch(
        new RegExp(`return try invoke\\(bytes\\) \\{ pointer, length in\\r?\\n\\s+${nativeCall}\\(`)
      );
    }
  });
});
