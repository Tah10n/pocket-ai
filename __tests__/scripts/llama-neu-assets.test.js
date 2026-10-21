/* global __dirname, it, expect */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { FILES, VERSION, hash, sanitizeSource, sanitizeLlamaNeuAssets } = require('../../patches/llama-rn-neu-assets');
const appRoot = path.resolve(__dirname, '../..');
const installed = path.join(appRoot, 'node_modules/llama.rn');

function temporaryApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-neu-assets-test-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { 'llama.rn': VERSION } }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/llama.rn': { version: VERSION } } }));
  const pkg = path.join(root, 'node_modules/llama.rn'); fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version: VERSION }));
  for (const item of FILES) { const file = path.join(pkg, item.source); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.copyFileSync(path.join(installed, item.source), file); }
  return { root, pkg };
}
function load(source) { const exports = {}; vm.runInNewContext(source, { exports }); return exports; }
it('sanitizes all locked executable entries and embedded source maps, preserves legacy Oute and is idempotent', () => {
  const { root, pkg } = temporaryApp();
  try {
    const before = load(fs.readFileSync(path.join(pkg, 'lib/commonjs/tts-voices.js'), 'utf8')).lookupVoice('outetts', 'default', 'en-us');
    sanitizeLlamaNeuAssets(root);
    expect(sanitizeLlamaNeuAssets(root, { check: true }).status).toBe('already-applied');
    expect(sanitizeLlamaNeuAssets(root).status).toBe('already-applied');
    for (const item of FILES) {
      const bytes = fs.readFileSync(path.join(pkg, item.source)); expect(hash(bytes)).toBe(item.afterSha256);
      expect(bytes.toString()).not.toMatch(/NEUTTS_(?:JO|DAVE|GRETA|JULIETTE)/);
      if (item.source.endsWith('.map')) expect(JSON.parse(bytes)).toMatchObject({ sources: [], sourcesContent: [] });
    }
    const after = load(fs.readFileSync(path.join(pkg, 'lib/commonjs/tts-voices.js'), 'utf8'));
    expect(after.lookupVoice('outetts', 'default', 'en-us')).toEqual(before);
    expect(after.listVoices('neutts', 'en-us')).toEqual([]);
    expect(after.lookupVoice('neutts', 'jo', 'en-us')).toBeNull();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
it('rejects any changed later source before mutating earlier files', () => {
  const { root, pkg } = temporaryApp();
  try {
    const earlier = path.join(pkg, FILES[0].source); const original = fs.readFileSync(earlier);
    fs.appendFileSync(path.join(pkg, FILES.at(-1).source), '\nchanged');
    expect(() => sanitizeLlamaNeuAssets(root)).toThrow('fingerprint mismatch');
    expect(fs.readFileSync(earlier)).toEqual(original);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
it('fails closed on version drift and incomplete transform anchors', () => {
  const { root, pkg } = temporaryApp();
  try {
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version: '0.13.0' }));
    expect(() => sanitizeLlamaNeuAssets(root)).toThrow('exact pinned');
    expect(() => sanitizeSource('const NEUTTS_JO = {};')).toThrow('anchor mismatch');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});