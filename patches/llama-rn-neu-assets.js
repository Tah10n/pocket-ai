/* global __dirname */
'use strict';
// Remove upstream Neu reference payloads from every executable package entry and
// their embedded source maps. No restricted transcript/code array is copied here.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const VERSION = '0.13.0-rc.3';
const FILES = [
  {
    "source": "src/tts-voices.ts",
    "beforeSha256": "301390d3f2b2f2b45a8fdd69dace45e082ab2edb289aed19b99e07a2d9bbb4b1",
    "afterSha256": "4a69030e8b59f459d6703ebfd5f9ab25fc4e4f39d3a49ff27329e94d77bc2fef"
  },
  {
    "source": "lib/module/tts-voices.js",
    "beforeSha256": "a0e7c6efdc9a04c4fded2fe6f8486330b191ef8fb82d215550d92f6bed6a5652",
    "afterSha256": "2b67dab7dee2e0e75e143bd0c60b13d3fbaead71493c27d95e67822863b27fda"
  },
  {
    "source": "lib/commonjs/tts-voices.js",
    "beforeSha256": "8260a39fc90c7a89d1e08c0400587b86c51bd0c779a622e2f6da3b0cbc825151",
    "afterSha256": "61dd4484aee05123c9ea9b635307e54bf0e8780ec90ea4d0a34e22f1bd6f21ec"
  },
  {
    "source": "lib/module/tts-voices.js.map",
    "beforeSha256": "39001cc938327a01d0d6773cc8413a26e1d87efff757f65689e470112707a957",
    "afterSha256": "ee518f1a9d9feaa4bda61b75287a14ab3c21740c8d0cc876b33e83d69a0c6303"
  },
  {
    "source": "lib/commonjs/tts-voices.js.map",
    "beforeSha256": "8e075e9eecf7f09f9e1c9772ca3d0a9604da2e83d168ad45d4af53005c975b4c",
    "afterSha256": "ee518f1a9d9feaa4bda61b75287a14ab3c21740c8d0cc876b33e83d69a0c6303"
  }
];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function sanitizeSource(source, isMap = false) {
  if (isMap) return JSON.stringify({ version: 3, file: 'tts-voices.js', names: [], sourceRoot: '', sources: [], sourcesContent: [], mappings: '' }) + '\n';
  const remove = (pattern, replacement) => {
    const matches = source.match(new RegExp(pattern.source, 'g'));
    if (!matches || matches.length !== 1) throw new Error('Neu asset sanitation anchor mismatch');
    source = source.replace(pattern, replacement);
  };
  remove(/\/\/ prettier-ignore\nconst NEUTTS_DAVE[\s\S]*?(?=\/\/ Voice tables)/, '');
  remove(/\/\/ Voice tables[\s\S]*?(?=const VOICE_TABLES)/, '// Voice tables contain only the retained legacy Oute reference.\n');
  remove(/  neutts: \{\n[\s\S]*?\n  \},?\n/, '');
  if (/NEUTTS_/.test(source)) throw new Error('Neu asset sanitation incomplete');
  return source;
}
function sanitizeLlamaNeuAssets(appRoot = path.resolve(__dirname, '..'), { check = false } = {}) {
  const root = path.join(appRoot, 'node_modules', 'llama.rn');
  const manifest = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(appRoot, 'package-lock.json'), 'utf8'));
  const installed = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (manifest.dependencies?.['llama.rn'] !== VERSION || lock.packages?.['node_modules/llama.rn']?.version !== VERSION || installed.version !== VERSION) {
    throw new Error('Neu asset sanitation requires exact pinned llama.rn');
  }
  const writes = [];
  for (const item of FILES) {
    const filename = path.join(root, item.source);
    const bytes = fs.readFileSync(filename);
    const identity = hash(bytes);
    if (identity === item.afterSha256) continue;
    if (identity !== item.beforeSha256) throw new Error('Neu asset source fingerprint mismatch: ' + item.source);
    if (check) throw new Error('Neu asset sanitation missing; run postinstall');
    const output = sanitizeSource(bytes.toString('utf8'), item.source.endsWith('.map'));
    if (hash(output) !== item.afterSha256) throw new Error('Neu asset output fingerprint mismatch');
    writes.push({ filename, output, sha256: item.afterSha256 });
  }
  // Every input/output is checked before the first mutation. A partial I/O failure
  // remains recognizable as a mix of exact original and exact sanitized files.
  for (const item of writes) {
    fs.writeFileSync(item.filename, item.output);
    if (hash(fs.readFileSync(item.filename)) !== item.sha256) throw new Error('Neu asset write verification failed');
  }
  return { status: writes.length ? 'applied' : 'already-applied', sources: Object.fromEntries(FILES.map(x => [x.source, x.afterSha256])) };
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some(x => x !== '--check')) throw new Error('Only --check supported');
  console.log(JSON.stringify(sanitizeLlamaNeuAssets(undefined, { check: args.includes('--check') })));
}
module.exports = { VERSION, FILES, hash, sanitizeSource, sanitizeLlamaNeuAssets };
