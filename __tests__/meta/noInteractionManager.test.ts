import fs from 'fs';
import path from 'path';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const BANNED_IDENTIFIER = /\bInteractionManager\b/;

function collectFiles(root: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(absolutePath));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      continue;
    }

    results.push(absolutePath);
  }

  return results;
}

describe('Deprecated React Native APIs', () => {
  it('does not reference InteractionManager in runtime code', () => {
    const appRoot = path.resolve(__dirname, '..', '..');
    const rootsToScan = [
      path.join(appRoot, 'src'),
      path.join(appRoot, 'app'),
      path.join(appRoot, 'plugins'),
    ];

    const offenders: string[] = [];
    for (const root of rootsToScan) {
      if (!fs.existsSync(root)) {
        continue;
      }

      for (const filePath of collectFiles(root)) {
        const content = fs.readFileSync(filePath, 'utf8');
        if (BANNED_IDENTIFIER.test(content)) {
          offenders.push(path.relative(appRoot, filePath));
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

