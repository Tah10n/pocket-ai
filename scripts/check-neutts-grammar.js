// Lightweight host regression: compile the actual installed parser, grammar sampler and grammar builder.
// Run in a developer shell: CXX=clang++ node scripts/check-neutts-grammar.js
// Windows: a Visual Studio developer shell with CXX=cl is also supported.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { SOURCE_PATCHES, BUILD_FILES, hashSource } = require('../patches/llama-rn-0.13.0-rc.3');
const root = path.resolve(__dirname, '..');
const cpp = path.join(root, 'node_modules/llama.rn/cpp');
function pinned(relative) {
  const source = fs.readFileSync(path.join(root, 'node_modules/llama.rn', relative), 'utf8').replace(/\r\n/gu, '\n');
  const patch = SOURCE_PATCHES.find(item => item.source === relative);
  const known = patch ? [patch.beforeSha256, patch.afterSha256, ...(patch.intermediates || []).map(item => item.sha256)] : [BUILD_FILES[relative]];
  if (!known.includes(hashSource(source))) {
    throw new Error('Unknown grammar test input fingerprint: ' + relative);
  }
  return source;
}
const parser = pinned('cpp/llama-grammar.cpp');
const sampler = pinned('cpp/llama-sampler.cpp');
const samplerStart = sampler.indexOf('struct llama_sampler_grammar {');
const samplerEnd = sampler.indexOf('// Fwd declare to break reset --> init_impl');
if (samplerStart < 0 || samplerEnd <= samplerStart) throw new Error('Native grammar sampler extraction boundary missing');
const grammarSampler = sampler.slice(samplerStart, samplerEnd);
const builder = pinned('cpp/rn-tts.cpp').match(/static std::string build_neutts_dynamic_grammar\(\) \{[\s\S]*?\n\}/u)?.[0];
if (!builder) throw new Error('Native Neu grammar builder missing');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-neu-grammar-'));
function run(executable, args) {
  const result = spawnSync(executable, args, { cwd: temp, encoding: 'utf8', timeout: 60000, windowsHide: true });
  console.log(JSON.stringify({ purpose: 'native-grammar-regression', pid: result.pid, executable: path.basename(executable), status: result.status, signal: result.signal }));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Native grammar regression command failed: ' + result.status);
}
try {
  const source = path.join(temp, 'grammar.cpp');
  const output = path.join(temp, process.platform === 'win32' ? 'grammar.exe' : 'grammar');
  fs.writeFileSync(source, parser + '\n' + grammarSampler + '\n' + builder + '\n' + fs.readFileSync(path.join(root, '__tests__/fixtures/neutts-grammar-main.cpp'), 'utf8'));
  const compiler = process.env.CXX || (process.platform === 'win32' ? 'cl' : 'c++');
  run(compiler, /(^|[/\\])cl(?:\.exe)?$/iu.test(compiler)
    ? ['/nologo', '/EHsc', '/std:c++17', '/Od', '/I' + cpp, source, '/Fe:' + output]
    : ['-std=c++17', '-O0', '-I', cpp, source, '-o', output]);
  run(output, []);
} finally {
  // Exact uniquely allocated test directory only; includes compiler object/executable.
  fs.rmSync(temp, { recursive: true, force: true });
}
