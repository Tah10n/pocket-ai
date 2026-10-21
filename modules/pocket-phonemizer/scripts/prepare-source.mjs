// SPDX-License-Identifier: MIT
// The complete pinned upstream archive is retained for offline builds and Corresponding Source.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, lstatSync, readdirSync, readlinkSync, openSync, closeSync, unlinkSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const source = path.join(root, 'generated/source/espeak-ng');
export const commit = '69bfd1efde0236654ccc117a28d04aef27673a30';
export const archiveSha = '0d36c8e81e972805d343e2b93d77baf3b57dd6c7a18a12df6782c80fe9f11d15';
export const sourceManifestSha = 'd0ea2b537beb0d765bb91400d2c045bcc2be01c682c79083bef73a35cec1143c';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true, ...options });
  if (result.error || result.status !== 0) throw new Error('phonemizer_build_failed');
}
export const offlineDeps = `# Modified for Pocket AI 2026-10-21: deterministic offline phonemizer-only build.
# Optional audio libraries are deliberately disabled; no host auto-detection or downloads.
set(THREADS_PREFER_PTHREAD_FLAG ON)
find_package(Threads REQUIRED)
if(CMAKE_USE_PTHREADS_INIT)
  set(HAVE_PTHREAD ON)
endif()
foreach(feature MBROLA LIBSONIC LIBPCAUDIO KLATT SPEECHPLAYER ASYNC)
  set(USE_\${feature} OFF CACHE BOOL "Pinned phonemizer-only build" FORCE)
endforeach()
set(HAVE_MBROLA OFF)
set(HAVE_LIBSONIC OFF)
set(HAVE_LIBPCAUDIO OFF)
`;
export function verifySource() {
  const bytes = readFileSync(path.join(root, 'vendor/source-manifest.json'));
  if (sha(bytes) !== sourceManifestSha) throw new Error('source_manifest_mismatch');
  const manifest = JSON.parse(bytes), expected = new Set(manifest.files.map(x => x.path));
  for (const file of manifest.files) {
    const full = path.join(source, file.path), stat = lstatSync(full);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.bytes || sha(readFileSync(full)) !== file.sha256) throw new Error('prepared_source_mismatch');
  }
  const legacy = new Map(manifest.optionalLegacyLinks.map(x => [x.path, x.target]));
  const visit = (dir, prefix = '') => {
    for (const name of readdirSync(dir)) {
      const rel = prefix + name, full = path.join(dir, name), stat = lstatSync(full);
      if (stat.isDirectory() && !stat.isSymbolicLink()) visit(full, rel + '/');
      else if (legacy.has(rel)) {
        if (!stat.isSymbolicLink() || readlinkSync(full) !== legacy.get(rel)) throw new Error('legacy_source_link_mismatch');
        const resolved = path.resolve(path.dirname(full), readlinkSync(full));
        if (!resolved.startsWith(source + path.sep)) throw new Error('legacy_source_link_escape');
      } else if (!expected.has(rel) && rel !== '.pocket-source.json') throw new Error('unexpected_prepared_source');
    }
  };
  visit(source);
}
function prepareSourceLocked() {
  const archive = path.join(root, 'vendor/espeak-ng-source.tar.gz');
  if (sha(readFileSync(archive)) !== archiveSha) throw new Error('source_identity_mismatch');
  const receipt = path.join(source, '.pocket-source.json');
  if (existsSync(receipt)) {
    const value = JSON.parse(readFileSync(receipt, 'utf8'));
    if (value.archiveSha !== archiveSha || value.patchSha !== sha(offlineDeps)
      || readFileSync(path.join(source, 'cmake/deps.cmake'), 'utf8') !== offlineDeps) throw new Error('prepared_source_mismatch');
    verifySource(); return source;
  }
  if (existsSync(source)) throw new Error('unattested_source_directory');
  const staging = path.join(root, 'generated/source/staging');
  if (existsSync(staging)) throw new Error('incomplete_source_staging');
  mkdirSync(staging, { recursive: true });
  // Hash-verified upstream archive has a single immutable root; CMake never fetches dependencies.
  run(process.env.CMAKE ?? 'cmake', ['-E', 'tar', 'xzf', archive], { cwd: staging });
  const extracted = path.join(staging, 'espeak-ng-' + commit);
  const deps = path.join(extracted, 'cmake/deps.cmake');
  const expectedDeps = '312539333dd476d726ddea0a4886d191eb7ac3b53a41a47419f34643cea7af92';
  if (sha(readFileSync(deps)) !== expectedDeps) throw new Error('offline_patch_source_mismatch');
  writeFileSync(deps, offlineDeps);
  writeFileSync(path.join(extracted, '.pocket-source.json'), JSON.stringify({ archiveSha, patchSha: sha(offlineDeps) }) + '\n');
  renameSync(extracted, source);
  rmdirSync(staging);
  verifySource(); return source;
}
// ABI configurations may start concurrently. Only one process may materialize source.
// Never steal an uncertain stale lock: interrupted callers leave a bounded, inspectable failure.
export function prepareSource() {
  mkdirSync(path.dirname(source), { recursive: true });
  const lock = path.join(root, 'generated/source.prepare.lock');
  const started = Date.now(); let handle;
  while (handle === undefined) {
    try { handle = openSync(lock, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() - started >= 120000) throw new Error('phonemizer_source_preparation_busy');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  try {
    writeFileSync(handle, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n');
    return prepareSourceLocked();
  } finally { closeSync(handle); unlinkSync(lock); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareSource(); console.log('Pinned eSpeak source prepared (offline).');
}
