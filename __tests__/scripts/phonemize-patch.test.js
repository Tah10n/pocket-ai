/** @jest-environment node */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { parse } = require('@babel/parser');
const { applyPhonemizePatch, patches, unchangedFiles, VERSION, ENTRY } = require('../../patches/phonemize-2.0.1');
const { collectBuildProvenance } = require('../../scripts/android-build-provenance');

const projectRoot = path.resolve(__dirname, '../..');
const installed = path.join(projectRoot, 'node_modules/phonemize');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const packageAt = root => path.join(root, 'node_modules/phonemize');
let root;

function copyEnglishFixture(destination) {
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, 'package.json'), JSON.stringify({ dependencies: { phonemize: VERSION } }));
  fs.writeFileSync(path.join(destination, 'package-lock.json'), JSON.stringify({ packages: {
    '': { dependencies: { phonemize: VERSION } }, 'node_modules/phonemize': { version: VERSION },
  } }));
  // Only the actual English CJS fanout (~2.6 MB), with no other dependencies.
  for (const file of [...unchangedFiles, ...patches]) {
    let bytes = fs.readFileSync(path.join(installed, file.file));
    if (file.before && sha(bytes) === file.after) {
      const text = bytes.toString('utf8');
      expect(text.split(file.replacement).length - 1).toBe(1);
      bytes = Buffer.from(text.replace(file.replacement, file.original));
    }
    expect(sha(bytes)).toBe(file.before || file.sha256);
    const target = path.join(packageAt(destination), file.file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
}
// Compare complete-file identities without Jest expanding millions of Buffer
// byte properties. Failures stay bounded and never dump dictionary contents.
const contents = () => [...unchangedFiles, ...patches].map(file => sha(fs.readFileSync(path.join(packageAt(root), file.file))));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-phonemize-patch-'));
  copyEnglishFixture(root);
});
afterEach(() => {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('pocket-phonemize-patch-')
    || fs.lstatSync(resolved).isSymbolicLink()) throw new Error('Unsafe phonemizer fixture cleanup target');
  fs.rmSync(resolved, { recursive: true, force: true });
  expect(fs.existsSync(resolved)).toBe(false);
});

it('replaces only the two pinned wrappers, preserves every other byte and is idempotent', () => {
  const before = contents();
  const identity = applyPhonemizePatch(root);
  expect(identity).toEqual(expect.objectContaining({ version: VERSION, entry: ENTRY }));
  for (const patch of patches) {
    const output = fs.readFileSync(path.join(packageAt(root), patch.file), 'utf8');
    expect(sha(output)).toBe(patch.after);
    expect(output.split(patch.replacement).length - 1).toBe(1);
    expect(sha(output.replace(patch.replacement, patch.original))).toBe(patch.before);
  }
  expect(contents().slice(0, unchangedFiles.length)).toEqual(before.slice(0, unchangedFiles.length));
  const applied = contents();
  expect(applyPhonemizePatch(root)).toEqual(identity);
  expect(applyPhonemizePatch(root, { check: true })).toEqual(identity);
  expect(contents()).toEqual(applied);
});

it.each(['manifest', 'lock-root', 'lock-package', 'installed'])('rejects changed %s version before any writes', target => {
  const file = target === 'installed' ? path.join(packageAt(root), 'package.json')
    : path.join(root, target === 'manifest' ? 'package.json' : 'package-lock.json');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (target === 'manifest') value.dependencies.phonemize = '^2.0.1';
  if (target === 'lock-root') value.packages[''].dependencies.phonemize = '2.0.2';
  if (target === 'lock-package') value.packages['node_modules/phonemize'].version = '2.0.2';
  if (target === 'installed') value.version = '2.0.2';
  fs.writeFileSync(file, JSON.stringify(value));
  const before = contents();
  expect(() => applyPhonemizePatch(root)).toThrow(/must match 2.0.1/);
  expect(contents()).toEqual(before);
});

it.each([...patches, ...unchangedFiles].map(file => file.file))('rejects drift in %s before any writes', file => {
  fs.appendFileSync(path.join(packageAt(root), file), ' ');
  const before = contents();
  expect(() => applyPhonemizePatch(root)).toThrow(/source hash mismatch/);
  expect(contents()).toEqual(before);
});

it('can finish a known partial patch while check mode remains read-only', () => {
  const first = patches[0];
  const target = path.join(packageAt(root), first.file);
  fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace(first.original, first.replacement));
  const before = contents();
  expect(() => applyPhonemizePatch(root, { check: true })).toThrow(/patch is missing/);
  expect(contents()).toEqual(before);
  applyPhonemizePatch(root);
  expect(() => applyPhonemizePatch(root, { check: true })).not.toThrow();
});

it('keeps default raw JSON identity, null prototype and freeze without enumerating dictionary keys', () => {
  for (const patch of patches) {
    let enumerations = 0;
    let descriptors = 0;
    const raw = new Proxy({ word: ['wɝd'], other: 'value' }, {
      ownKeys(target) { enumerations += 1; return Reflect.ownKeys(target); },
      getOwnPropertyDescriptor(target, key) { descriptors += 1; return Reflect.getOwnPropertyDescriptor(target, key); },
    });
    const original = vm.runInNewContext(`(${patch.original})`)(raw);
    expect(enumerations).toBeGreaterThan(0);
    expect(descriptors).toBeGreaterThan(0);
    enumerations = 0; descriptors = 0;
    const optimized = vm.runInNewContext(`(${patch.replacement})`)(raw);
    expect(optimized.default).toBe(original.default);
    expect(optimized.default).toBe(raw);
    expect(Object.getPrototypeOf(optimized)).toBeNull();
    expect(Object.isFrozen(optimized)).toBe(true);
    expect(Object.keys(optimized)).toEqual(['default']);
    expect(enumerations).toBe(0); expect(descriptors).toBe(0);
  }
});

it('preserves actual English IPA, preprocessing and isolated custom dictionaries across cold module copies', () => {
  const baseline = path.join(root, 'baseline');
  copyEnglishFixture(baseline);
  const before = require(path.join(packageAt(baseline), ENTRY));
  applyPhonemizePatch(root);
  const after = require(path.join(packageAt(root), ENTRY));
  const options = { language: 'en-us', anyAscii: false };
  const corpus = [
    'Hello world!', 'The quiet river flows beside the old bridge.',
    'I read the record while they record the address.', 'Dr. Smith paid $12.50 on July 4, 2025.',
    "NASA can't stop the well-known robot's work.", 'Queue, chocolate, judge, church: extraordinary!',
    'Flibberquux walks quickly; he is walking and will walk.', 'Café naïve résumé — déjà vu.',
  ];
  expect(before.toIPA(corpus[0], options)).toBe('həˈɫoʊ wɝɫd!');
  for (const text of corpus) {
    const expected = before.toIPA(text, options);
    expect(expected.length).toBeGreaterThan(0);
    expect(after.toIPA(text, options)).toBe(expected);
    expect(after.toARPABET(text, options)).toBe(before.toARPABET(text, options));
    expect(after.phonemize(text, { ...options, returnArray: true })).toEqual(before.phonemize(text, { ...options, returnArray: true }));
  }
  const { EnglishG2P } = require(path.join(packageAt(root), 'dist/en-g2p.cjs'));
  const first = after.createPhonemizer({ processors: [new EnglishG2P()], language: 'en-us' });
  const second = after.createPhonemizer({ processors: [new EnglishG2P()], language: 'en-us' });
  const defaultPronunciation = second.toIPA('hello', options);
  first.addPronunciation('hello', 'test', 'en-us');
  expect(first.toIPA('hello', options)).not.toBe(defaultPronunciation);
  expect(second.toIPA('hello', options)).toBe(defaultPronunciation);
  expect(after.toIPA('hello', options)).toBe(before.toIPA('hello', options));
});

function evaluateBuildPatchStatement(file, functionName) {
  const source = fs.readFileSync(path.join(projectRoot, 'scripts', file), 'utf8');
  const ast = parse(source, { sourceType: 'script' });
  const body = functionName ? ast.program.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === functionName).body.body
    : ast.program.body;
  const index = body.findIndex(node => source.slice(node.start, node.end).startsWith('require("../patches/phonemize-2.0.1").applyPhonemizePatch('));
  expect(index).toBeGreaterThanOrEqual(0);
  // The actual setup statement must precede SDK/build/device work.
  const nextWork = body.findIndex(node => /(?:resolveAndroidTools\(\)|const sdkSetup =)/.test(source.slice(node.start, node.end)));
  expect(index).toBeLessThan(nextWork);
  const statement = body[index];
  vm.runInNewContext(source.slice(statement.start, statement.end), {
    projectRoot: root, require: request => {
      expect(request).toBe('../patches/phonemize-2.0.1');
      return { applyPhonemizePatch };
    },
  });
}

it.each([['android-smoke.js', 'main'], ['build-android-release.js', null]])('applies the real %s setup statement before build/device work', (file, name) => {
  expect(() => applyPhonemizePatch(root, { check: true })).toThrow(/patch is missing/);
  evaluateBuildPatchStatement(file, name);
  expect(() => applyPhonemizePatch(root, { check: true })).not.toThrow();
});

it('binds actual patched CJS and unchanged data to Android provenance and refuses drift', () => {
  fs.writeFileSync(path.join(root, 'app.json'), '{"expo":{}}');
  const options = { variant: 'release', abi: 'x86_64', env: {}, git: { headSha: 'fixture' }, toolchains: {},
    userGradlePropertiesPath: path.join(root, 'absent.properties') };
  const collect = () => collectBuildProvenance(root, options);
  expect(collect).toThrow(/patch is missing/);
  const identity = applyPhonemizePatch(root);
  const first = collect();
  expect(first.phonemize).toEqual(identity);
  expect(JSON.stringify(first.phonemize)).not.toContain(root);
  expect(first.phonemize.files).toHaveLength(10);
  fs.appendFileSync(path.join(packageAt(root), patches[1].file), ' ');
  expect(collect).toThrow(/source hash mismatch/);
});

it('uses the actual native-config run consumer to reject missing/drifted patches without mutation', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'scripts/verify-native-config.js'), 'utf8');
  const ast = parse(source, { sourceType: 'script' });
  const node = ast.program.body.find(item => item.type === 'FunctionDeclaration' && item.id.name === 'run');
  // Other native prerequisites are independent of this fixture; execute the
  // real run body with only those unrelated checks stubbed, never the patch.
  const run = vm.runInNewContext(`(${source.slice(node.start, node.end)})`, {
    projectRoot: root, process: { argv: [] }, fs: { existsSync: () => false }, path,
    assertSourceConfig: () => {}, assertLlamaNativeArtifacts: () => {}, patchLlamaBridge: () => {},
    assertExpoAudioNativePatch: () => {}, applyPhonemizePatch,
  });
  const before = contents();
  expect(() => run([], root)).toThrow(/patch is missing/);
  expect(contents()).toEqual(before);
  applyPhonemizePatch(root);
  expect(() => run([], root)).not.toThrow();
  fs.appendFileSync(path.join(packageAt(root), 'dist/en/exceptions.json'), ' ');
  const drifted = contents();
  expect(() => run([], root)).toThrow(/source hash mismatch/);
  expect(contents()).toEqual(drifted);
});

it('registers the guarded patch after the accepted install hooks and retains lazy deadlines', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  expect(manifest.scripts.postinstall).toBe('node ./patches/llama-rn-0.13.0-rc.3.js && node ./patches/expo-audio-55.0.18.js && node ./patches/phonemize-2.0.1.js');
  const service = fs.readFileSync(path.join(projectRoot, 'src/services/TtsPhonemizer.ts'), 'utf8');
  expect(service).toContain('LOCAL_PHONEMIZER_MODULE_INIT_DEADLINE_MS = 2000');
  expect(service).toContain('LOCAL_PHONEMIZER_DEADLINE_MS = 1000');
  expect(service.indexOf("require('phonemize')")).toBeGreaterThan(service.indexOf('const started = Date.now()'));
});
