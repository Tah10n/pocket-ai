// Compile exact pinned DAC decode functions against an observable graph boundary.
// Does not load a model or claim real backend timing, pool size or audio parity.
// CXX=cl in a Windows developer shell, or CXX=c++ on other hosts.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { SOURCE_PATCHES, hashSource } = require('../patches/llama-rn-0.13.0-rc.3');
const relative = 'cpp/codec/src/models/dac.cpp';
const pristineSha256 = 'ce9268f76217400269cef5277591b25bd94e3e7fc66d52ca7cfe0f75ee8c528d';

function nativeFixture(source) {
  const extract = (name) => {
    const start = source.indexOf(`enum codec_status ${name}(`);
    const end = source.indexOf('\n}', start);
    if (start < 0 || end < start) throw new Error('DAC native extraction boundary missing: ' + name);
    return source.slice(start, end + 2);
  };
  return fs.readFileSync(path.join(__dirname, '../__tests__/fixtures/dac-decode-threads-main.cpp'), 'utf8')
    .replace('// DAC_TOKEN_GRAPH', () => extract('codec_dac_decode_tokens_graph'))
    .replace('// DAC_LATENT_DECODE', () => extract('codec_dac_decode_latent'))
    .replace('// DAC_TOKEN_DECODE', () => extract('codec_dac_decode'));
}

function run(llamaRoot = path.join(__dirname, '../node_modules/llama.rn')) {
  const source = fs.readFileSync(path.join(llamaRoot, relative), 'utf8').replace(/\r\n/gu, '\n');
  const patch = SOURCE_PATCHES.find(item => item.source === relative);
  if (![pristineSha256, patch?.afterSha256].includes(hashSource(source))) {
    throw new Error('Unknown DAC native test input fingerprint.');
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-dac-threads-'));
  const compiler = process.env.CXX || (process.platform === 'win32' ? 'cl' : 'c++');
  const msvc = /(^|[/\\])cl(?:\.exe)?$/iu.test(compiler);
  const output = path.join(temp, process.platform === 'win32' ? 'decode.exe' : 'decode');
  const sourcePath = path.join(temp, 'decode.cpp');
  const invoke = (executable, args) => {
    const result = spawnSync(executable, args, { cwd: temp, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0) {
      throw new Error(`DAC native regression failed (${result.status}): ${result.error?.message || ''}\n${result.stdout || ''}${result.stderr || ''}`);
    }
    if (result.stdout) process.stdout.write(result.stdout);
  };
  try {
    fs.writeFileSync(sourcePath, nativeFixture(source));
    invoke(compiler, msvc ? ['/nologo', '/EHsc', '/std:c++17', '/Od', sourcePath, '/Fe:' + output]
      : ['-std=c++17', '-O0', sourcePath, '-o', output]);
    invoke(output, []);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  if (process.argv.length > 3) throw new Error('Expected at most one explicit llama source root.');
  run(process.argv[2]);
}
module.exports = { nativeFixture, run };
