const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  DOCUMENT_QA_FIXTURES,
  fixtureRoot,
} = require('../../scripts/document-qa-fixtures');

const appRoot = path.resolve(__dirname, '..', '..');
const binaryFixtureExtensions = new Set([
  '.7z', '.bmp', '.bz2', '.doc', '.docm', '.docx', '.epub', '.gif', '.gz',
  '.jpeg', '.jpg', '.odp', '.ods', '.odt', '.pdf', '.png', '.pot', '.potm',
  '.potx', '.pps', '.ppsm', '.ppsx', '.ppt', '.pptm', '.pptx', '.rar', '.rtf',
  '.tar', '.tif', '.tiff', '.webp', '.xls', '.xlsb', '.xlsm', '.xlsx', '.xz',
  '.zip',
]);

function runGit(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: options.cwd || appRoot,
    encoding: options.encoding === undefined ? 'utf8' : options.encoding,
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${String(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout;
}

function toGitPath(absolutePath, gitRoot) {
  return path.relative(gitRoot, absolutePath).split(path.sep).join('/');
}

function checkoutBytes(absolutePath, gitRoot) {
  const gitPath = toGitPath(absolutePath, gitRoot);
  const objectId = runGit(['rev-parse', `:${gitPath}`]).trim();
  return runGit(
    ['cat-file', '--filters', `--path=${gitPath}`, objectId],
    { encoding: null },
  );
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function findManifestFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return findManifestFiles(absolutePath);
    }
    return entry.isFile() && entry.name === 'manifest.json' ? [absolutePath] : [];
  });
}

describe('document QA fixture checkout reproducibility', () => {
  const gitRoot = runGit(['rev-parse', '--show-toplevel']).trim();

  it('reproduces the JavaScript fixture manifest from clean-checkout bytes', () => {
    const checkedPaths = new Set();
    for (const definition of DOCUMENT_QA_FIXTURES) {
      const absolutePath = path.resolve(fixtureRoot, ...definition.relativePath.split('/'));
      if (checkedPaths.has(absolutePath)) {
        continue;
      }
      checkedPaths.add(absolutePath);

      const bytes = checkoutBytes(absolutePath, gitRoot);
      expect(bytes).toHaveLength(definition.bytes);
      expect(sha256(bytes)).toBe(definition.sha256);
      expect(fs.readFileSync(absolutePath)).toEqual(bytes);
    }
  });

  it('reproduces every corpus manifest from clean-checkout bytes', () => {
    for (const manifestPath of findManifestFiles(fixtureRoot)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      for (const definition of manifest.files) {
        const absolutePath = path.resolve(path.dirname(manifestPath), definition.file);
        const bytes = checkoutBytes(absolutePath, gitRoot);
        expect(bytes).toHaveLength(definition.bytes);
        expect(sha256(bytes)).toBe(definition.sha256);
      }
    }
  });

  it('marks every binary corpus format as non-text, non-diffable, and non-mergeable', () => {
    const checkedExtensions = new Set();
    const corpusPaths = DOCUMENT_QA_FIXTURES.map((definition) => (
      path.resolve(fixtureRoot, ...definition.relativePath.split('/'))
    ));
    for (const manifestPath of findManifestFiles(fixtureRoot)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      corpusPaths.push(...manifest.files.map((definition) => (
        path.resolve(path.dirname(manifestPath), definition.file)
      )));
    }

    for (const absolutePath of corpusPaths) {
      const extension = path.extname(absolutePath).toLowerCase();
      if (!binaryFixtureExtensions.has(extension) || checkedExtensions.has(extension)) {
        continue;
      }
      checkedExtensions.add(extension);
      const gitPath = toGitPath(absolutePath, gitRoot);
      const attributes = runGit(
        ['check-attr', 'text', 'diff', 'merge', '--', gitPath],
        { cwd: gitRoot },
      );
      expect(attributes).toContain(`${gitPath}: text: unset`);
      expect(attributes).toContain(`${gitPath}: diff: unset`);
      expect(attributes).toContain(`${gitPath}: merge: unset`);
    }

    expect(checkedExtensions).toEqual(new Set([
      '.doc', '.docm', '.docx', '.epub', '.jpg', '.odp', '.ods', '.odt',
      '.pdf', '.png', '.ppt', '.pptx', '.rtf', '.xls', '.xlsb', '.xlsm',
      '.xlsx',
    ]));
  });
});
