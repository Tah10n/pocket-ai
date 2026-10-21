// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { root, archiveSha, sourceManifestSha } from './prepare-source.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const lock = JSON.parse(readFileSync(path.join(root, 'upstream-lock.json')));
const bytes = readFileSync(path.join(root, 'assets/data-manifest.json'));
if (sha(bytes) !== lock.data.sha256 || sha(readFileSync(path.join(root, 'vendor/espeak-ng-source.tar.gz'))) !== archiveSha
  || sha(readFileSync(path.join(root, 'vendor/source-manifest.json'))) !== sourceManifestSha) throw new Error('phonemizer_identity_mismatch');
const manifest = JSON.parse(bytes), expected = new Set(manifest.files.map(x => x.path));
const assets = path.join(root, 'assets/espeak-ng-data');
for (const file of manifest.files) {
  if (!/^[a-zA-Z0-9_!+ ./-]+$/.test(file.path) || file.path.split('/').includes('..')) throw new Error('data_path_invalid');
  const full = path.join(assets, file.path), stat = lstatSync(full);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.bytes || sha(readFileSync(full)) !== file.sha256) throw new Error('phonemizer_data_mismatch');
}
function visit(dir, prefix = '') {
  for (const name of readdirSync(dir)) {
    const rel = prefix + name, stat = lstatSync(path.join(dir,name));
    if (stat.isDirectory() && !stat.isSymbolicLink()) visit(path.join(dir,name), rel + '/');
    else if (!expected.has(rel) || !stat.isFile() || stat.isSymbolicLink()) throw new Error('unexpected_phonemizer_data');
  }
}
visit(assets);
const macro = [...readFileSync(path.join(root,'cpp/data-identity.h'),'utf8').matchAll(/^#define POCKET_PHONEMIZER_MANIFEST_SHA256 "([a-f0-9]{64})"$/gm)];
if (macro.length !== 1 || macro[0][1] !== lock.data.sha256) throw new Error('compiled_data_identity_mismatch');
console.log('Pinned phonemizer source archive, data and compiled identity verified.');
