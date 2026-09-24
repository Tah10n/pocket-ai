const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sync: globSync } = require('glob');
const {
  AFTER, AFTER_SHA256, BEFORE, BEFORE_SHA256, BUILD_FILES, SOURCE, VERSION,
  hashSource, patchLlamaBridge, SOURCE_PATCHES, PARAMS_SOURCE, PARAMS_AFTER_SHA256, applyReplacements,
  CLOCK_SOURCE, CLOCK_BEFORE_SHA256, CLOCK_AFTER_SHA256, CLOCK_BEFORE, CLOCK_AFTER, CLOCK_PREVIOUS_SHA256, CLOCK_PRIVACY_REPLACEMENTS,
  GRAMMAR_SOURCE, GRAMMAR_BEFORE_SHA256, GRAMMAR_AFTER_SHA256,
  COMPLETION_SOURCE, COMPLETION_AFTER_SHA256, SAMPLING_SOURCE, SAMPLING_AFTER_SHA256,
} = require('../../patches/llama-rn-0.13.0-rc.3');
const { copyLlamaPatchSources } = require('../fixtures/llama-native-patch');
const { collectPrebuildInputState } = require('../../scripts/android-build-provenance');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

describe('pinned serial sampling and template clock corrections', () => {
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

  it('validates every source before mutation and resumes an earlier probability-only installation', () => {
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

  it('passes the request clock to the actual Jinja context with exactly one core assignment', () => {
    const clockPath = path.join(root, 'node_modules/llama.rn', CLOCK_SOURCE);
    const original = fs.readFileSync(clockPath, 'utf8');
    expect(hashSource(original)).toBe(CLOCK_BEFORE_SHA256);
    patchLlamaBridge(root);
    const patched = fs.readFileSync(clockPath, 'utf8');
    expect(hashSource(patched)).toBe(CLOCK_AFTER_SHA256);
    let restored = patched;
    for (const [before, after] of [...CLOCK_PRIVACY_REPLACEMENTS].reverse()) restored = restored.replace(after, before);
    expect(restored.replace(CLOCK_AFTER, CLOCK_BEFORE)).toBe(original);
    expect(patched.split(CLOCK_AFTER)).toHaveLength(2);
    expect(patched.indexOf(CLOCK_AFTER)).toBeLessThan(patched.indexOf('jinja::global_from_json(ctx, inp, inputs.mark_input)'));
    const read = (file) => fs.readFileSync(path.join(root, 'node_modules/llama.rn', file), 'utf8');
    expect(read('cpp/common/jinja/runtime.h')).toContain('current_time = parent.current_time');
    expect(read('cpp/common/jinja/value.cpp')).toContain('std::localtime(&args.ctx.current_time)');
    expect(read('cpp/rn-llama.cpp')).toContain('inputs.now = std::chrono::system_clock::from_time_t(timestamp)');
    expect(patched).toContain('params.now                   = inputs.now');
  });

  it('preflights clock source before writing either earlier bridge source', () => {
    const clockPath = path.join(root, 'node_modules/llama.rn', CLOCK_SOURCE);
    fs.appendFileSync(clockPath, '\n// clock source drift\n');
    expect(() => patchLlamaBridge(root)).toThrow(/fingerprint mismatch/);
    for (const patch of SOURCE_PATCHES.slice(0, 2)) {
      expect(hashSource(fs.readFileSync(path.join(root, 'node_modules/llama.rn', patch.source), 'utf8'))).toBe(patch.beforeSha256);
    }
  });

  it('adds the core fix to an already-corrected bridge installation without changing bridge bytes', () => {
    const bridgeBytes = SOURCE_PATCHES.slice(0, 2).map((patch) => {
      const file = path.join(root, 'node_modules/llama.rn', patch.source);
      const text = applyReplacements(fs.readFileSync(file, 'utf8'), patch.replacements);
      fs.writeFileSync(file, text);
      return text;
    });
    expect(patchLlamaBridge(root).status).toBe('applied');
    SOURCE_PATCHES.slice(0, 2).forEach((patch, index) => {
      expect(fs.readFileSync(path.join(root, 'node_modules/llama.rn', patch.source), 'utf8')).toBe(bridgeBytes[index]);
    });
    expect(patchLlamaBridge(root, { check: true }).sources[CLOCK_SOURCE]).toBe(CLOCK_AFTER_SHA256);
    const cmake = fs.readFileSync(path.join(root, 'node_modules/llama.rn/android/src/main/rnllama/CMakeLists.txt'), 'utf8');
    expect(cmake).toContain('file(GLOB COMMON_FILES CONFIGURE_DEPENDS ${RNLLAMA_LIB_DIR}/common/*.cpp)');
    expect(cmake).toContain('${COMMON_FILES}');
  });

  it('clears the released completion owner before the next initialization can throw', () => {
    patchLlamaBridge(root);
    const source = fs.readFileSync(path.join(root, 'node_modules/llama.rn', COMPLETION_SOURCE), 'utf8');
    expect(hashSource(source)).toBe(COMPLETION_AFTER_SHA256);
    const init = source.slice(source.indexOf('bool llama_rn_context_completion::initSampling()'));
    expect(init).toMatch(/common_sampler_free\(ctx_sampling\);\s+ctx_sampling = nullptr;\s+\}\s+ctx_sampling = common_sampler_init/u);
  });

  it('owns partially initialized samplers until successful aggregate construction', () => {
    patchLlamaBridge(root);
    const read = (file) => fs.readFileSync(path.join(root, 'node_modules/llama.rn', file), 'utf8');
    const source = read(SAMPLING_SOURCE);
    expect(hashSource(source)).toBe(SAMPLING_AFTER_SHA256);
    const init = source.slice(source.indexOf('struct common_sampler * common_sampler_init('), source.indexOf('void common_sampler_free('));
    const guard = init.slice(init.indexOf('struct sampler_init_guard'), init.indexOf('} guard { grmr, rbudget, chain, samplers };'));
    expect(guard).toMatch(/if \(released\) \{\s+return;/u);
    expect(guard).toMatch(/for \(auto \* smpl : pending\) \{\s+llama_sampler_free\(smpl\);/u);
    for (const owned of ['grmr', 'rbudget', 'chain']) expect(guard).toContain(`llama_sampler_free(${owned});`);
    expect(init.indexOf('} guard {')).toBeLessThan(init.indexOf('chain = llama_sampler_chain_init(lparams)'));
    expect(init.indexOf('samplers.reserve(params.samplers.size() + 3)')).toBeLessThan(init.indexOf('throw std::runtime_error("failed to parse grammar")'));
    expect(init.indexOf('} guard {')).toBeLessThan(init.indexOf('llama_sampler_accept(grmr, token)'));
    // A chain owns only entries whose insertion returned successfully. Pending entries
    // remain owned by the guard if chain insertion or result construction throws.
    expect(init).toMatch(/for \(auto \* & smpl : samplers\) \{\s+llama_sampler_chain_add\(chain, smpl\);\s+smpl = nullptr;/u);
    expect(init).toMatch(/auto \* result = new common_sampler \{[\s\S]*?\};\s+guard.released = true;\s+return result;/u);
    expect(init.split('guard.released = true')).toHaveLength(2);
    const sampler = read('cpp/llama-sampler.cpp');
    expect(sampler).toMatch(/void llama_sampler_free\(struct llama_sampler \* smpl\) \{\s+if \(smpl == nullptr\) \{\s+return;/u);
    expect(sampler).toMatch(/p->samplers.push_back\(\{\s+\/\* .is_backend = \*\/ false,\s+\/\* .ptr        = \*\/ smpl,/u);
  });

  it('keeps sampler initialization diagnostics free of grammar, prompt and token payloads', () => {
    patchLlamaBridge(root);
    const source = fs.readFileSync(path.join(root, 'node_modules/llama.rn', SAMPLING_SOURCE), 'utf8');
    const init = source.slice(source.indexOf('struct common_sampler * common_sampler_init('), source.indexOf('void common_sampler_free('));
    const logs = init.match(/LOG_(?:DBG|ERR|WRN)\([\s\S]*?\);/gu);
    expect(logs).toHaveLength(6);
    for (const log of logs) {
      expect(log).toMatch(/, __func__\);$/u);
      expect(log).not.toMatch(/c_str\(|tokens\[|, token|%d|Generation prompt/u);
      expect(log.match(/%s/gu)).toHaveLength(1);
    }
    expect(init).toContain('grammar sampler rejected generation prefill');
    expect(init).toContain('throw e;');
  });

  it('preflights sampler drift before writing any other source and upgrades the earlier three fixes', () => {
    const last = SOURCE_PATCHES.find((patch) => patch.source === SAMPLING_SOURCE);
    const file = path.join(root, 'node_modules/llama.rn', last.source);
    const original = fs.readFileSync(file, 'utf8');
    fs.appendFileSync(file, '\n// unexpected sampler ownership drift\n');
    expect(() => patchLlamaBridge(root)).toThrow(/fingerprint mismatch/);
    for (const patch of SOURCE_PATCHES.filter((entry) => entry !== last)) {
      expect(hashSource(fs.readFileSync(path.join(root, 'node_modules/llama.rn', patch.source), 'utf8'))).toBe(patch.beforeSha256);
    }
    fs.writeFileSync(file, original);
    const previous = SOURCE_PATCHES.slice(0, 3).map((patch) => {
      const target = path.join(root, 'node_modules/llama.rn', patch.source);
      const text = applyReplacements(fs.readFileSync(target, 'utf8'), patch.replacements);
      fs.writeFileSync(target, text);
      return [target, text];
    });
    expect(patchLlamaBridge(root).status).toBe('applied');
    for (const [target, text] of previous) expect(fs.readFileSync(target, 'utf8')).toBe(text);
    expect(patchLlamaBridge(root, { check: true }).sources[SAMPLING_SOURCE]).toBe(SAMPLING_AFTER_SHA256);
  });

  it('removes grammar parser exception/input and lazy trigger payloads without changing print utilities', () => {
    const file = path.join(root, 'node_modules/llama.rn', GRAMMAR_SOURCE);
    const original = fs.readFileSync(file, 'utf8');
    expect(hashSource(original)).toBe(GRAMMAR_BEFORE_SHA256);
    patchLlamaBridge(root);
    const source = fs.readFileSync(file, 'utf8');
    expect(hashSource(source)).toBe(GRAMMAR_AFTER_SHA256);
    const parser = source.slice(0, source.indexOf('void llama_grammar_parser::print(FILE * file)'));
    expect(parser).toContain('fprintf(stderr, "%s: grammar parsing failed\\n", __func__);');
    expect(parser).not.toContain('err.what()');
    const trigger = source.slice(source.indexOf('void llama_grammar_accept_impl('));
    const logs = trigger.match(/LLAMA_LOG_DEBUG\([^;]*?\);/gu);
    expect(logs).toHaveLength(3);
    for (const log of logs) expect(log).not.toMatch(/%[sdu]|c_str\(|, token|constrained_str/u);
    expect(trigger).not.toContain('auto constrained_str =');
    const print = text => text.slice(text.indexOf('void llama_grammar_parser::print(FILE * file)'), text.indexOf('void llama_grammar_accept_impl('));
    expect(print(source)).toBe(print(original));
  });

  it('preflights sixth-source drift before changing any of the five earlier sources', () => {
    fs.appendFileSync(path.join(root, 'node_modules/llama.rn', GRAMMAR_SOURCE), '\n// drift\n');
    expect(() => patchLlamaBridge(root)).toThrow(/fingerprint mismatch/);
    for (const patch of SOURCE_PATCHES.slice(0, 5)) {
      expect(hashSource(fs.readFileSync(path.join(root, 'node_modules/llama.rn', patch.source), 'utf8'))).toBe(patch.beforeSha256);
    }
  });

  it('migrates only the exact clock-only core fingerprint and strips active formatter payload diagnostics', () => {
    const file = path.join(root, 'node_modules/llama.rn', CLOCK_SOURCE);
    const old = fs.readFileSync(file, 'utf8').replace(CLOCK_BEFORE, CLOCK_AFTER);
    expect(hashSource(old)).toBe(CLOCK_PREVIOUS_SHA256);
    patchLlamaBridge(root);
    fs.writeFileSync(file, old);
    expect(() => patchLlamaBridge(root, { check: true })).toThrow(/patch is missing/);
    expect(fs.readFileSync(file, 'utf8')).toBe(old);
    patchLlamaBridge(root);
    const source = fs.readFileSync(file, 'utf8');
    expect(hashSource(source)).toBe(CLOCK_AFTER_SHA256);
    for (const [before, after] of CLOCK_PRIVACY_REPLACEMENTS) {
      expect(source).not.toContain(before);
      expect(source).toContain(after);
    }
    // Undocumented intermediate states still fail closed.
    fs.writeFileSync(file, old + '\n// drift\n');
    expect(() => patchLlamaBridge(root)).toThrow(/fingerprint mismatch/);
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

  it('keeps internal headers available without exporting duplicate framework outputs', () => {
    const originalPodspec = fs.readFileSync(path.join(root, 'node_modules/llama.rn/llama-rn.podspec'), 'utf8');
    patchLlamaBridge(root);
    const packageRoot = path.resolve(__dirname, '../../node_modules/llama.rn');
    const podspec = fs.readFileSync(path.join(root, 'node_modules/llama.rn/llama-rn.podspec'), 'utf8');
    expect(podspec.split('  else')[1].split('  end')[0]).toBe(originalPodspec.split('  else')[1].split('  end')[0]);
    const sourceBranch = podspec.split('if ENV["RNLLAMA_BUILD_FROM_SOURCE"] == "1"')[1].split('  else')[0];
    const patterns = [...sourceBranch.match(/s\.source_files = ([^\n]+)/u)[1].matchAll(/"([^"]+)"/gu)].map(match => match[1]);
    const selected = patterns.flatMap(pattern => globSync(pattern, { cwd: packageRoot })).map(file => file.replace(/\\/gu, '/'));
    expect(selected.filter(file => /\.(?:h|hpp)$/u.test(file))).toEqual(['ios/RNLlama.h']);
    for (const source of ['ios/RNLlama.mm', 'cpp/jsi/RNLlamaJSI.cpp', 'cpp/common/chat.cpp', 'cpp/common/sampling.cpp', 'cpp/ggml-metal/ggml-metal-device.m', 'cpp/ggml-metal/ggml-metal-embed-argsort.s']) {
      expect(selected).toContain(source);
    }
    // Simulate the installed framework slices without downloading binary archives.
    const fixturePackage = path.join(root, 'node_modules/llama.rn');
    for (const relative of ['ios/RNLlama.h', 'ios/rnllama.xcframework/ios-arm64/rnllama.framework/Headers/common.h', 'ios/rnllama.xcframework/ios-arm64_x86_64-simulator/rnllama.framework/Headers/common.h']) {
      const file = path.join(fixturePackage, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '// header\n');
    }
    const fixtureHeaders = patterns.flatMap(pattern => globSync(pattern, { cwd: fixturePackage })).filter(file => /\.h$/u.test(file));
    expect(fixtureHeaders.map(file => file.replace(/\\/gu, '/'))).toEqual(['ios/RNLlama.h']);
    const preserved = podspec.match(/s\.preserve_paths = "([^"]+)"/u)[1];
    const headers = globSync(preserved, { cwd: packageRoot }).map(file => file.replace(/\\/gu, '/'));
    for (const header of ['cpp/common/common.h', 'cpp/ggml-cpu/common.h', 'cpp/jsi/RNLlamaJSI.h', 'cpp/nlohmann/json.hpp']) expect(headers).toContain(header);
    const searchPaths = [...sourceBranch.matchAll(/header_search_paths << '"\$[({]PODS_TARGET_SRCROOT[)}]\/([^"]+)"'/gu)].map(match => match[1]);
    expect(searchPaths).toEqual(['cpp', 'cpp/common', 'cpp/hash', 'cpp/nlohmann', 'cpp/ggml-cpu', 'cpp/codec/include', 'cpp/codec/common', 'cpp/tools/mtmd']);
    expect(podspec).toContain('-DLM_GGML_USE_METAL -DLM_GGML_METAL_EMBED_LIBRARY=1');
    const assembly = fs.readFileSync(path.join(packageRoot, 'cpp/ggml-metal/ggml-metal-embed-argsort.s'), 'utf8');
    expect(assembly).toContain('_lm_ggml_metallib_argsort_start:');
    expect(assembly).toContain('_lm_ggml_metallib_argsort_end:');
    expect(assembly).toContain('.byte ');
    expect(assembly).not.toContain('.incbin');
  });

  it('rejects podspec drift before writing any native correction', () => {
    const before = fs.readFileSync(sourcePath);
    fs.appendFileSync(path.join(root, 'node_modules/llama.rn/llama-rn.podspec'), '\n# unexpected change\n');
    expect(() => patchLlamaBridge(root)).toThrow(/fingerprint mismatch: llama-rn\.podspec/u);
    expect(fs.readFileSync(sourcePath)).toEqual(before);
  });

  it.each(['cpp/common/jinja/value.cpp', 'cpp/common/jinja/caps.cpp', 'cpp/jsi/JSINativeHeaders.h'])('resolves the common JSON API relative to %s, independent of dependency header maps', (relative) => {
    patchLlamaBridge(root);
    const source = fs.readFileSync(path.join(root, 'node_modules/llama.rn', relative), 'utf8');
    expect(source).not.toContain('#include "json.h"');
    const include = relative.startsWith('cpp/jsi/') ? '../common/json.h' : '../json.h';
    expect(source).toContain(`#include "${include}"`);
    if (relative.startsWith('cpp/jsi/')) expect(source).toContain('#include <rnllama/json.h>');
    const installed = path.resolve(__dirname, '../../node_modules/llama.rn');
    const header = path.resolve(installed, path.dirname(relative), include);
    expect(header).toBe(path.join(installed, 'cpp/common/json.h'));
    expect(fs.readFileSync(header, 'utf8')).toContain('class common_json');
    if (!relative.startsWith('cpp/jsi/')) expect(source).toContain('common_json');
  });

  it.each(['cpp/common/jinja/value.cpp', 'cpp/common/jinja/caps.cpp', 'cpp/jsi/JSINativeHeaders.h'])('rejects drift in %s before any write', (relative) => {
    const before = fs.readFileSync(sourcePath);
    fs.appendFileSync(path.join(root, 'node_modules/llama.rn', relative), '\n// unexpected source change\n');
    expect(() => patchLlamaBridge(root)).toThrow(/fingerprint mismatch/u);
    expect(fs.readFileSync(sourcePath)).toEqual(before);
  });

  it('adds source-build quote directories without changing prebuilt includes', () => {
    patchLlamaBridge(root);
    const podspec = fs.readFileSync(path.join(root, 'node_modules/llama.rn/llama-rn.podspec'), 'utf8');
    const branch = podspec.split('if ENV["RNLLAMA_BUILD_FROM_SOURCE"] == "1"')[1].split('  else');
    expect(branch[0]).toContain('header_search_paths.drop(1).each do |include_path|\n      base_compiler_flags += " -iquote #{include_path}"\n    end');
    expect(branch[1]).not.toContain('-iquote');
    expect(podspec).toContain("header_search_paths = ['$(inherited)']");
    expect(branch[0].indexOf('cpp/tools/mtmd')).toBeLessThan(branch[0].indexOf('header_search_paths.drop(1)'));
  });

  it('upgrades the exact earlier podspec correction without changing native source bytes', () => {
    patchLlamaBridge(root);
    const patch = SOURCE_PATCHES.find(entry => entry.source === 'llama-rn.podspec');
    const file = path.join(root, 'node_modules/llama.rn', patch.source);
    let previous = fs.readFileSync(file, 'utf8');
    for (const [before, after] of patch.intermediates[0].replacements) previous = previous.replace(after, before);
    expect(hashSource(previous)).toBe(patch.intermediates[0].sha256);
    fs.writeFileSync(file, previous);
    const native = fs.readFileSync(sourcePath);
    expect(() => patchLlamaBridge(root, { check: true })).toThrow(/patch is missing/u);
    expect(patchLlamaBridge(root).status).toBe('applied');
    expect(hashSource(fs.readFileSync(file, 'utf8'))).toBe(patch.afterSha256);
    expect(fs.readFileSync(sourcePath)).toEqual(native);
  });

  it('normalizes the known intermediate podspec when copying pristine test fixtures', () => {
    const patch = SOURCE_PATCHES.find(entry => entry.source === 'llama-rn.podspec');
    const original = fs.readFileSync(path.join(root, 'node_modules/llama.rn', patch.source), 'utf8');
    let intermediate = applyReplacements(original, patch.replacements);
    for (const [before, after] of patch.intermediates[0].replacements) intermediate = intermediate.replace(after, before);
    const installed = path.resolve(__dirname, '../../node_modules/llama.rn', patch.source);
    const read = fs.readFileSync;
    const spy = jest.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => path.resolve(String(file)) === installed ? intermediate : read(file, ...args));
    try {
      copyLlamaPatchSources(root, { pristine: true });
      expect(hashSource(read(path.join(root, 'node_modules/llama.rn', patch.source), 'utf8'))).toBe(patch.beforeSha256);
    } finally {
      spy.mockRestore();
    }
  });

  const commonConsumers = ['cpp/rn-completion.h', 'cpp/rn-llama.h', 'cpp/rn-slot-manager.h', 'cpp/rn-slot.h', 'cpp/rn-tts.cpp', 'cpp/jsi/JSINativeHeaders.h'];
  it.each(commonConsumers)('resolves the runtime common API locally in %s', (relative) => {
    patchLlamaBridge(root);
    const source = fs.readFileSync(path.join(root, 'node_modules/llama.rn', relative), 'utf8');
    const include = relative.startsWith('cpp/jsi/') ? '../common/common.h' : 'common/common.h';
    expect(source).not.toContain('#include "common.h"');
    expect(source).toContain(`#include "${include}"`);
    const installed = path.resolve(__dirname, '../../node_modules/llama.rn');
    expect(path.resolve(installed, path.dirname(relative), include)).toBe(path.join(installed, 'cpp/common/common.h'));
    expect(fs.readFileSync(path.join(installed, 'cpp/common/common.h'), 'utf8')).toContain('struct common_params');
    if (relative.startsWith('cpp/jsi/')) expect(source).toContain('#include <rnllama/common.h>');
  });

  it.each(commonConsumers)('rejects common consumer drift before any write: %s', (relative) => {
    const before = fs.readFileSync(sourcePath);
    fs.appendFileSync(path.join(root, 'node_modules/llama.rn', relative), '\n// drift\n');
    expect(() => patchLlamaBridge(root)).toThrow(/fingerprint mismatch/u);
    expect(fs.readFileSync(sourcePath)).toEqual(before);
  });

  it('upgrades the exact earlier JSI JSON correction and preserves framework imports', () => {
    const patch = SOURCE_PATCHES.find(entry => entry.source === 'cpp/jsi/JSINativeHeaders.h');
    const file = path.join(root, 'node_modules/llama.rn', patch.source);
    const pristine = fs.readFileSync(file, 'utf8');
    const previous = pristine.replace('#include "json.h"', '#include "../common/json.h"');
    expect(hashSource(previous)).toBe(patch.intermediates[0].sha256);
    fs.writeFileSync(file, previous);
    expect(patchLlamaBridge(root).status).toBe('applied');
    expect(hashSource(fs.readFileSync(file, 'utf8'))).toBe(patch.afterSha256);
    expect(patchLlamaBridge(root).status).toBe('already-applied');
    const installed = path.resolve(__dirname, '../../node_modules/llama.rn', patch.source);
    const read = fs.readFileSync;
    const spy = jest.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => path.resolve(String(file)) === installed ? previous : read(file, ...args));
    try {
      copyLlamaPatchSources(root, { pristine: true });
      expect(read(file, 'utf8')).toBe(pristine);
    } finally {
      spy.mockRestore();
    }
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
