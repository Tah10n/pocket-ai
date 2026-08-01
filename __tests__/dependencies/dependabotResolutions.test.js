const MarkdownIt = require('markdown-it');
const packageJson = require('../../package.json');
const packageLock = require('../../package-lock.json');

function resolvedVersions(packageName) {
  const packageSuffix = `node_modules/${packageName}`;

  return [
    ...new Set(
      Object.entries(packageLock.packages)
        .filter(([packagePath]) => packagePath === packageSuffix || packagePath.endsWith(`/${packageSuffix}`))
        .map(([, packageMetadata]) => packageMetadata.version),
    ),
  ].sort();
}

describe('Dependabot resolution contract', () => {
  it('keeps every remediated transitive package on the reviewed secure versions', () => {
    expect(resolvedVersions('@babel/core')).toEqual(['7.29.6']);
    expect(resolvedVersions('brace-expansion')).toEqual(['1.1.17', '5.0.8']);
    expect(resolvedVersions('js-yaml')).toEqual(['3.15.0', '4.3.0']);
    expect(resolvedVersions('linkify-it')).toEqual(['5.0.2']);
    expect(resolvedVersions('markdown-it')).toEqual(['14.3.0']);
    expect(resolvedVersions('postcss')).toEqual(['8.5.23']);
  });

  it('keeps incompatible major versions scoped instead of forcing global overrides', () => {
    expect(packageJson.overrides['minimatch@3.1.5']).toEqual({
      'brace-expansion': '1.1.17',
    });
    expect(packageJson.overrides['minimatch@10.2.5']).toEqual({
      'brace-expansion': '5.0.8',
    });
    expect(packageJson.overrides['js-yaml@3.14.2']).toBe('3.15.0');
    expect(packageJson.overrides['js-yaml@4.1.1']).toBe('4.3.0');
    expect(packageJson.overrides.uuid).toBeUndefined();
  });

  it('keeps quote- and URL-heavy model output bounded through markdown linkification', () => {
    const parser = new MarkdownIt({ linkify: true, typographer: true });
    const quoteHeavyMarkdown = 'https://example.com/"model output" '.repeat(40_000);
    const startedAt = Date.now();

    const rendered = parser.render(quoteHeavyMarkdown);

    expect(rendered).toContain('model output');
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  });
});
