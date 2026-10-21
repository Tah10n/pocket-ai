// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { root, source, commit, archiveSha, sourceManifestSha, prepareSource, run } from './prepare-source.mjs';
if (!process.argv.includes('--write')) throw new Error('Explicit --write is required to regenerate pinned data.');
prepareSource();
const build = path.join(root, 'generated/host-build');
const cmake = process.env.CMAKE ?? 'cmake';
const platform = process.platform === 'win32' ? ['-G', 'Visual Studio 17 2022', '-A', 'x64'] : [];
run(cmake, ['-S', source, '-B', build, ...platform, '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF',
  '-DENABLE_TESTS=OFF', '-DBUILD_TESTING=OFF', '-DCOMPILE_INTONATIONS=ON', ...['MBROLA','LIBSONIC','LIBPCAUDIO','KLATT','SPEECHPLAYER','ASYNC'].map(x=>'-DUSE_'+x+'=OFF')]);
run(cmake, ['--build', build, '--config', 'Release', '--target', 'data', '--parallel', '4']);
const generated = path.join(build, 'espeak-ng-data');
const assets = path.join(root, 'assets');
const output = path.join(assets, 'espeak-ng-data');
if (existsSync(output)) throw new Error('Data destination exists; verify and preserve its identity before replacement.');
mkdirSync(assets, { recursive: true });
cpSync(generated, output, { recursive: true, errorOnExist: true, force: false });
const files = [];
function visit(dir, prefix = '') {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name), relative = prefix + name, stat = lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error('unexpected_data_link');
    if (stat.isDirectory()) visit(full, relative + '/');
    else if (stat.isFile()) files.push({ path: relative, bytes: stat.size, sha256: createHash('sha256').update(readFileSync(full)).digest('hex') });
    else throw new Error('unexpected_data_entry');
  }
}
visit(output);
if (files.length < 100 || files.length > 2000 || files.reduce((n,f)=>n+f.bytes,0) > 64*1024*1024) throw new Error('data_generation_bounds');
const identity = createHash('sha256').update(JSON.stringify(files)).digest('hex');
const manifest = JSON.stringify({ schemaVersion: 1, sourceCommit: commit, sourceArchiveSha256: archiveSha,
  buildOptions: { async: false, mbrola: false, sonic: false, pcaudio: false, klatt: false, speechplayer: false }, identity, files }, null, 2) + '\n';
writeFileSync(path.join(assets, 'data-manifest.json'), manifest);
const digest = createHash('sha256').update(manifest).digest('hex');
mkdirSync(path.join(root, 'cpp'), { recursive: true });
writeFileSync(path.join(root, 'cpp/data-identity.h'), '// Generated from the same-source data manifest; SPDX-License-Identifier: MIT\n#pragma once\n#define POCKET_PHONEMIZER_MANIFEST_SHA256 "' + digest + '"\n');
writeFileSync(path.join(root, 'upstream-lock.json'), JSON.stringify({ schemaVersion: 1, source: { repository: 'https://github.com/espeak-ng/espeak-ng', revision: commit, archive: 'vendor/espeak-ng-source.tar.gz', bytes: 18493532, sha256: archiveSha, preparedManifestSha256: sourceManifestSha, offlineDependencyPatch: 'scripts/prepare-source.mjs' }, data: { manifest: 'assets/data-manifest.json', sha256: digest, identity }, license: 'GPL-3.0-or-later' }, null, 2) + '\n');
console.log(JSON.stringify({status:'same_source_data_generated', files:files.length, bytes:files.reduce((n,f)=>n+f.bytes,0), identity, manifestSha256:digest}));
