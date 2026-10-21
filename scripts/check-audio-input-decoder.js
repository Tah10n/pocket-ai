// Compile the exact guarded audio decoder with the pinned real miniaudio.
// No model, device, decoder mock or source-string-only acceptance.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { SOURCE_PATCHES, hashSource } = require('../patches/llama-rn-0.13.0-rc.3');
const relative = 'cpp/tools/mtmd/mtmd-helper.cpp';
const miniaudioRelative = 'cpp/tools/mtmd/miniaudio/miniaudio.h';
const miniaudioSha256 = 'ac7af4de748b7e26b777f37e01cee313a308a7296a3eb080e2906b320cc55c89';
function nativeFixture(source, header) {
  const start = source.indexOf('static bool decode_audio_from_buf(');
  const end = source.indexOf('} // namespace audio_helpers', start);
  if (start < 0 || end < start) throw new Error('Audio decoder extraction boundary missing.');
  return fs.readFileSync(path.join(__dirname, '../__tests__/fixtures/audio-input-decoder-main.cpp'), 'utf8')
    .replace('// MINIAUDIO_HEADER', () => '#include ' + JSON.stringify(header.replace(/\\/gu, '/')))
    .replace('// AUDIO_DECODER', () => source.slice(start, end));
}
function run(llamaRoot = path.join(__dirname, '../node_modules/llama.rn'), fixtures = []) {
  const source = fs.readFileSync(path.join(llamaRoot, relative), 'utf8').replace(/\r\n/gu, '\n');
  const patch = SOURCE_PATCHES.find(item => item.source === relative);
  if (![patch?.beforeSha256, patch?.afterSha256, ...(patch?.intermediates || []).map(item => item.sha256)].includes(hashSource(source))) {
    throw new Error('Unknown audio decoder input fingerprint.');
  }
  const header = path.resolve(llamaRoot, miniaudioRelative);
  if (hashSource(fs.readFileSync(header, 'utf8')) !== miniaudioSha256) throw new Error('Unknown miniaudio fingerprint.');
  if (fixtures.length > 3) throw new Error('At most three external fixtures are allowed.');
  for (const file of fixtures) {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size < 1 || stat.size > 25 * 1024 * 1024) throw new Error('External fixture size/type is invalid.');
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-audio-decoder-'));
  const compiler = process.env.CXX || (process.platform === 'win32' ? 'cl' : 'c++');
  const msvc = /(^|[/\\])cl(?:\.exe)?$/iu.test(compiler);
  const output = path.join(temp, process.platform === 'win32' ? 'decode.exe' : 'decode');
  const sourcePath = path.join(temp, 'decode.cpp');
  const invoke = (executable, args) => {
    const result = spawnSync(executable, args, { cwd: temp, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error || result.status !== 0) throw new Error('Audio native regression failed (' + result.status + '): ' + (result.error?.message || 'see output'));
  };
  try {
    fs.writeFileSync(sourcePath, nativeFixture(source, header));
    invoke(compiler, msvc ? ['/nologo', '/EHsc', '/std:c++17', '/Od', sourcePath, '/Fe:' + output]
      : ['-std=c++17', '-O0', sourcePath, '-o', output, '-lpthread', '-ldl', '-lm']);
    invoke(output, fixtures.map(file => path.resolve(file)));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
if (require.main === module) run(process.argv[2], process.argv.slice(3));
module.exports = { nativeFixture, run };
