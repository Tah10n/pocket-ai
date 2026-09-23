const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  AFTER, AFTER_SHA256, BEFORE, BEFORE_SHA256, BUILD_FILES, SOURCE, VERSION,
  hashSource, patchLlamaBridge, SOURCE_PATCHES, PARAMS_SOURCE, PARAMS_AFTER_SHA256, applyReplacements,
} = require('../../patches/llama-rn-0.13.0-rc.3');
const { copyLlamaPatchSources } = require('../fixtures/llama-native-patch');
const { collectPrebuildInputState } = require('../../scripts/android-build-provenance');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

describe('pinned serial probability reset patch', () => {
  let root;
  let sourcePath;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-llama-patch-'));
    sourcePath = path.join(root, 'node_modules/llama.rn', SOURCE);
    const dependencies = { 'llama.rn': VERSION };
    writeJson(path.join(root, 'package.json'), { dependencies });
    writeJson(path.join(root, 'package-lock.json'), {
      packages: { '': { dependencies }, 'node_modules/llama.rn': { version: VERSION } },
    });
    writeJson(path.join(root, 'node_modules/llama.rn/package.json'), { version: VERSION });
    copyLlamaPatchSources(root, { pristine: true });
  });
  afterEach(() => {
    // Only the exact temporary directory allocated by this test is removed.
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('makes precisely one native reset after rewind and is idempotent', () => {
    const original = fs.readFileSync(sourcePath, 'utf8');
    expect(hashSource(original)).toBe(BEFORE_SHA256);
    expect(patchLlamaBridge(root)).toEqual({ status: 'applied', sources: Object.fromEntries(SOURCE_PATCHES.map((p) => [p.source, p.afterSha256])) });
    const patched = fs.readFileSync(sourcePath, 'utf8');
    expect(patched.replace(AFTER, BEFORE)).toBe(original);
    expect(patched).toContain(`throwIfContextBusy(ctx);\n${AFTER}\n                parseCompletionParams`);
    expect(patchLlamaBridge(root)).toEqual({ status: 'already-applied', sources: Object.fromEntries(SOURCE_PATCHES.map((p) => [p.source, p.afterSha256])) });
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(patched);
    expect(patchLlamaBridge(root, { check: true }).sources[SOURCE]).toBe(AFTER_SHA256);
  });

  it('fails read-only verification for a pristine installation without modifying it', () => {
    const original = fs.readFileSync(sourcePath);
    expect(() => patchLlamaBridge(root, { check: true })).toThrow(/bridge patch is missing/);
    expect(fs.readFileSync(sourcePath)).toEqual(original);
  });

  it('accepts CRLF with exact normalized fingerprints and preserves line endings', () => {
    fs.writeFileSync(sourcePath, fs.readFileSync(sourcePath, 'utf8').replace(/\n/gu, '\r\n'));
    patchLlamaBridge(root);
    const patched = fs.readFileSync(sourcePath, 'utf8');
    expect(hashSource(patched)).toBe(AFTER_SHA256);
    expect(patched.replace(/\r\n/gu, '')).not.toContain('\n');
  });

  it.each(['original', 'applied'])('fails closed on drift in %s source without overwriting it', (state) => {
    if (state === 'applied') patchLlamaBridge(root);
    fs.appendFileSync(sourcePath, '\n// unexpected upstream change\n');
    const drifted = fs.readFileSync(sourcePath);
    expect(() => patchLlamaBridge(root)).toThrow(/fingerprint mismatch/);
    expect(fs.readFileSync(sourcePath)).toEqual(drifted);
  });

  it.each(['manifest', 'installed', 'lock-root', 'lock-package'])('rejects a wrong %s version before mutation', (target) => {
    const file = path.join(root, target === 'manifest' ? 'package.json'
      : target === 'installed' ? 'node_modules/llama.rn/package.json' : 'package-lock.json');
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (target === 'manifest') json.dependencies['llama.rn'] = `^${VERSION}`;
    else if (target === 'installed') json.version = '0.13.0-rc.4';
    else if (target === 'lock-root') json.packages[''].dependencies['llama.rn'] = '0.13.0-rc.4';
    else json.packages['node_modules/llama.rn'].version = '0.13.0-rc.4';
    writeJson(file, json);
    expect(() => patchLlamaBridge(root)).toThrow(/requires exactly llama.rn/);
    expect(hashSource(fs.readFileSync(sourcePath, 'utf8'))).toBe(BEFORE_SHA256);
  });

  it.each(Object.keys(BUILD_FILES))('rejects changed native inclusion or layout contract: %s', (file) => {
    fs.appendFileSync(path.join(root, 'node_modules/llama.rn', file), '\n// drift\n');
    expect(() => patchLlamaBridge(root)).toThrow(/build-source contract drift/);
    expect(hashSource(fs.readFileSync(sourcePath, 'utf8'))).toBe(BEFORE_SHA256);
  });

  it('patches the actual numeric bridge with checked tokens, last-wins entries and unique EOG overrides', () => {
    patchLlamaBridge(root);
    const params = fs.readFileSync(path.join(root, 'node_modules/llama.rn', PARAMS_SOURCE), 'utf8');
    expect(hashSource(params)).toBe(PARAMS_AFTER_SHA256);
    expect(params).not.toMatch(/sparams\.logit_bias\[/u);
    expect(params).toContain('std::trunc(token) != token || token < 0');
    expect(params).toContain('token >= llama_vocab_n_tokens(vocab)');
    expect(params).toContain('!std::isfinite(bias)');
    expect(params).toContain('existing->bias = static_cast<float>(bias)');
    expect(params).toContain('existing->bias = eog.bias');
    expect(params).toContain('sparams.logit_bias.push_back(eog)');
    expect(params).toContain('getPropertyAsBool(runtime, params, "ignore_eos", false)');
    expect(params.indexOf('token >= llama_vocab_n_tokens(vocab)')).toBeLessThan(params.indexOf('const llama_token tok = static_cast<llama_token>(token)'));
  });

  it('validates both sources before mutation and resumes an earlier probability-only installation', () => {
    const paramsPath = path.join(root, 'node_modules/llama.rn', PARAMS_SOURCE);
    const paramsOriginal = fs.readFileSync(paramsPath, 'utf8');
    fs.appendFileSync(paramsPath, '\n// unexpected drift\n');
    expect(() => patchLlamaBridge(root)).toThrow(/fingerprint mismatch/);
    expect(hashSource(fs.readFileSync(sourcePath, 'utf8'))).toBe(BEFORE_SHA256);
    fs.writeFileSync(paramsPath, paramsOriginal);
    const probabilityPatch = SOURCE_PATCHES[0];
    fs.writeFileSync(sourcePath, applyReplacements(fs.readFileSync(sourcePath, 'utf8'), probabilityPatch.replacements));
    expect(patchLlamaBridge(root).status).toBe('applied');
    expect(patchLlamaBridge(root, { check: true }).sources[PARAMS_SOURCE]).toBe(PARAMS_AFTER_SHA256);
  });

  it('targets the JSI source compiled with prebuilt cores on Android and iOS', () => {
    const read = (file) => fs.readFileSync(path.join(root, 'node_modules/llama.rn', file), 'utf8');
    const cmake = read('android/src/main/CMakeLists.txt');
    expect(cmake).toMatch(/set\(JNI_SOURCE_FILES[\s\S]*?\$\{CMAKE_SOURCE_DIR\}\/\.\.\/\.\.\/\.\.\/cpp\/jsi\/RNLlamaJSI\.cpp/u);
    expect(cmake).toContain('cpp/jsi/JSIParams.cpp');
    expect(cmake).toMatch(/add_library\(\s*\$\{jni_name\}\s*SHARED\s*\$\{JNI_SOURCE_FILES\}/u);
    const podspec = read('llama-rn.podspec');
    expect(podspec).toContain('s.source_files = "ios/*.{h,m,mm}", "cpp/jsi/**/*.{h,cpp}"');
    expect(podspec).toContain('s.vendored_frameworks = "ios/rnllama.xcframework"');
    expect(podspec).toContain('s.source_files = "ios/**/*.{h,m,mm}", "cpp/**/*.{h,cpp,hpp,c,m,mm,s}"');
  });

  it('is installed by the package hook and participates in existing native provenance', () => {
    const projectRoot = path.resolve(__dirname, '../..');
    const relative = 'patches/llama-rn-0.13.0-rc.3.js';
    const packageConfig = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    expect(packageConfig.scripts.postinstall).toBe(`node ./${relative}`);
    fs.mkdirSync(path.join(root, 'patches'));
    fs.copyFileSync(path.join(projectRoot, relative), path.join(root, relative));
    const before = collectPrebuildInputState(root);
    fs.appendFileSync(path.join(root, relative), '\n// changed patch contract\n');
    const after = collectPrebuildInputState(root);
    expect(after.digest).not.toBe(before.digest);
    expect(before.entries.some((entry) => entry.path === relative)).toBe(true);
  });
});
