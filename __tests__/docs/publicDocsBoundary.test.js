const fs = require('fs');
const path = require('path');

const appRoot = path.resolve(__dirname, '..', '..');

const markdownFiles = [
  path.join(appRoot, 'README.md'),
  path.join(appRoot, 'CONTRIBUTING.md'),
  ...fs.readdirSync(path.join(appRoot, 'docs'))
    .filter((fileName) => fileName.endsWith('.md'))
    .map((fileName) => path.join(appRoot, 'docs', fileName)),
];

const privateReferencePatterns = [
  { pattern: /\bspecs[\\/]/i, label: 'private specs directory' },
  { pattern: /\.agents[\\/]/i, label: 'private agent skills directory' },
  { pattern: /\.specify[\\/]/i, label: 'private Spec Kit directory' },
  { pattern: /\bWORKFLOW\.md\b/, label: 'private workflow file' },
  { pattern: /\bAGENTS\.md\b/, label: 'private agent entrypoint' },
  { pattern: /\bC:\\Users\\/i, label: 'absolute Windows user path' },
  { pattern: /\bAntigravity[\\/]pocket_ai\b/i, label: 'private workspace path' },
  { pattern: /\bDownloads[\\/]pocket-ai-multimodal-codex-plan\.md\b/i, label: 'private downloaded plan path' },
];

const publicRootPathPatterns = [
  { pattern: /\]\(app\/(?:README\.md|docs\/|src\/|app\.json|package\.json)/i, label: 'markdown link with local app/ prefix' },
  { pattern: /`app\/(?:README\.md|docs\/|src\/|app\.json|package\.json)/i, label: 'inline path with local app/ prefix' },
];

function toPublicPath(filePath) {
  return path.relative(appRoot, filePath).replace(/\\/g, '/');
}

function walkMarkdownLinks(content) {
  const links = [];
  const markdownLinkPattern = /!?\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match;
  while ((match = markdownLinkPattern.exec(content)) !== null) {
    links.push(match[1]);
  }

  return links;
}

function isExternalOrAnchorLink(href) {
  return /^(?:https?:|mailto:|tel:)/i.test(href) || href.startsWith('#');
}

function resolveMarkdownHref(filePath, href) {
  const withoutFragment = href.split('#')[0].split('?')[0];
  if (!withoutFragment) {
    return null;
  }

  const decoded = decodeURIComponent(withoutFragment);
  if (decoded.startsWith('/')) {
    return path.resolve(appRoot, decoded.slice(1));
  }

  return path.resolve(path.dirname(filePath), decoded);
}

describe('public Markdown docs boundary', () => {
  it('does not expose private-root paths or local app/ prefixes', () => {
    const violations = [];

    for (const filePath of markdownFiles) {
      const content = fs.readFileSync(filePath, 'utf8');
      const publicPath = toPublicPath(filePath);

      for (const { pattern, label } of [...privateReferencePatterns, ...publicRootPathPatterns]) {
        if (pattern.test(content)) {
          violations.push(`${publicPath}: ${label}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps relative Markdown links inside the public app root and pointing at existing files', () => {
    const violations = [];

    for (const filePath of markdownFiles) {
      const content = fs.readFileSync(filePath, 'utf8');
      const publicPath = toPublicPath(filePath);

      for (const href of walkMarkdownLinks(content)) {
        if (isExternalOrAnchorLink(href)) {
          continue;
        }

        const resolvedPath = resolveMarkdownHref(filePath, href);
        if (!resolvedPath) {
          continue;
        }

        const relativeToAppRoot = path.relative(appRoot, resolvedPath);
        if (relativeToAppRoot.startsWith('..') || path.isAbsolute(relativeToAppRoot)) {
          violations.push(`${publicPath}: ${href} escapes public root`);
          continue;
        }

        if (!fs.existsSync(resolvedPath)) {
          violations.push(`${publicPath}: ${href} does not resolve to a public file`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
