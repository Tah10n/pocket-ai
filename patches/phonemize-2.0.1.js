'use strict';

// The pinned English CJS entry uses each JSON namespace only through
// resolveJson(namespace), which reads .default. Creating tens of thousands of
// unused named getters adds synchronous cold-start work on Hermes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const VERSION = '2.0.1';
const ENTRY = 'dist/index.cjs';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const patches = [
  {
    file: 'dist/core.cjs',
    before: '2abd509b777c4732499fbacfef981531bf4cc906b6717e5a92fe04ebd80f5a21',
    after: '20112e73a4075aab25e3265208a0432b52b8cebb9a5ce7085196420fe18f5a7c',
    original: 'function _interopNamespaceDefault(t){var a=Object.create(null);return t&&Object.keys(t).forEach(function(o){if(o!==`default`){var s=Object.getOwnPropertyDescriptor(t,o);Object.defineProperty(a,o,s.get?s:{enumerable:!0,get:function(){return t[o]}})}}),a.default=t,Object.freeze(a)}',
    replacement: 'function _interopNamespaceDefault(t){var a=Object.create(null);return a.default=t,Object.freeze(a)}',
  },
  {
    file: 'dist/en-g2p.cjs',
    before: 'd1a0fd6dea916500fa564424630c5f2b4fbef603d1381f579e21942a39cbea0f',
    after: '5016735a415ee2dfec3cfeaa6a53e9f6d83a195d3a5d79b9db6daed7ad02a6b4',
    original: 'function _interopNamespaceDefault(t){var p=Object.create(null);return t&&Object.keys(t).forEach(function(m){if(m!==`default`){var h=Object.getOwnPropertyDescriptor(t,m);Object.defineProperty(p,m,h.get?h:{enumerable:!0,get:function(){return t[m]}})}}),p.default=t,Object.freeze(p)}',
    replacement: 'function _interopNamespaceDefault(t){var p=Object.create(null);return p.default=t,Object.freeze(p)}',
  },
];
// Pin every other file in the English runtime fanout: the default-only wrapper
// is safe for these exact consumers and preserves every raw dictionary byte.
const unchangedFiles = [
  ['package.json', '6029b38c7923759b9f677028acf2820288bb3668e8d03b7bb2be86cb604ab698'],
  [ENTRY, '9e7b76a4a6676538e0a2a5a0e788ca94f4eb196554deb17409fb7881659accb1'],
  ['dist/utils-Dq_eIfdp.cjs', '35bf267ff46601a85effd73f469b8f790183afc7bef86956485b5ec7eafa3bc6'],
  ['dist/anyascii.json', 'ecc2c9398952b62a969a4618ed29b91fd07d0ea286458d3332e086c7594e534e'],
  ['dist/en/exceptions.json', '153a0f265b6acdd5e6130c7acc52c68fd75e106976aab1b7e28f28998a03dc06'],
  ['dist/en/initialisms.json', '8ea01b1edb144e954b32e04d0a60813c6e9dd4054d2153e87010a374f0897ba5'],
  ['dist/en/homographs.json', 'e43cad348b3b27f97c0356000b43257cd11c32179f17d6451dda1acaa6f8d348'],
  ['dist/en/compound-parts.json', '5d4d64219597af910069dad0e3b8df9f80b3ebc5edcb13943c572dac8de50728'],
].map(([file, sha256]) => ({ file, sha256 }));

function inspect(projectRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  // Minimal provenance/config test projects may not use the phonemizer.
  if (!manifest.dependencies?.phonemize) return null;
  const lock = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'));
  const packageRoot = path.join(projectRoot, 'node_modules', 'phonemize');
  const installed = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (manifest.dependencies.phonemize !== VERSION || lock.packages?.['']?.dependencies?.phonemize !== VERSION
    || lock.packages?.['node_modules/phonemize']?.version !== VERSION || installed.version !== VERSION) {
    throw new Error(`phonemize manifest, lockfile and installed package must match ${VERSION}; run npm ci.`);
  }
  const read = file => {
    const target = path.join(packageRoot, file);
    if (!fs.lstatSync(target).isFile()) throw new Error(`phonemize patch requires a regular file: ${file}`);
    return fs.readFileSync(target);
  };
  const files = unchangedFiles.map(file => {
    const bytes = read(file.file);
    if (hash(bytes) !== file.sha256) throw new Error(`phonemize unchanged source hash mismatch: ${file.file}`);
    return { path: file.file, size: bytes.length, sha256: file.sha256 };
  });
  // Validate all inputs before any write, including a partly applied known patch.
  const plan = patches.map(patch => {
    const bytes = read(patch.file);
    const digest = hash(bytes);
    if (digest === patch.after) return { ...patch, bytes, changed: false };
    if (digest !== patch.before) throw new Error(`phonemize patch source hash mismatch: ${patch.file}`);
    const text = bytes.toString('utf8');
    if (text.split(patch.original).length - 1 !== 1) throw new Error(`phonemize patch anchor mismatch: ${patch.file}`);
    const updated = Buffer.from(text.replace(patch.original, patch.replacement));
    if (hash(updated) !== patch.after) throw new Error(`phonemize patch result hash mismatch: ${patch.file}`);
    return { ...patch, bytes: updated, changed: true };
  });
  return { packageRoot, plan, files };
}

function applyPhonemizePatch(projectRoot = path.resolve(__dirname, '..'), options = {}) {
  const prepared = inspect(projectRoot);
  if (!prepared) return null;
  if (options.check && prepared.plan.some(item => item.changed)) {
    throw new Error('phonemize English JSON namespace patch is missing; run npm ci with postinstall enabled.');
  }
  if (!options.check) for (const item of prepared.plan) {
    if (item.changed) fs.writeFileSync(path.join(prepared.packageRoot, item.file), item.bytes);
  }
  return {
    version: VERSION, entry: ENTRY,
    files: [...prepared.files, ...prepared.plan.map(item => ({ path: item.file, size: item.bytes.length, sha256: item.after }))],
  };
}

module.exports = { applyPhonemizePatch, patches, unchangedFiles, VERSION, ENTRY };
if (require.main === module) {
  applyPhonemizePatch(undefined, { check: process.argv.includes('--check') });
  process.stdout.write(`phonemize ${VERSION} English JSON namespace patch verified\n`);
}
