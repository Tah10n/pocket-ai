#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const manifest = require('./llama-hexagon-sdk-manifest.json');

const INCLUDE_DIRECTORIES = ['incs', 'ipc/fastrpc/rpcmem/inc', 'utils/examples'];
const SAFE_ERROR = 'Pinned Hexagon host SDK verification/setup failed; check the SDK pin, required files, Python availability, and network access.';

function requiresHexagonSdk(abi) {
  if (!['x86_64', 'arm64-v8a', 'universal'].includes(abi)) throw new Error('Unsupported Android SDK target ABI.');
  return abi !== 'x86_64';
}

function requiredFilesDigest(files) {
  const rows = [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    .map(file => `${file.path}\0${file.size}\0${file.sha256}\n`).join('');
  return crypto.createHash('sha256').update(rows).digest('hex');
}

function validateManifest(pin) {
  const seen = new Set();
  for (const file of pin.files) {
    if (!file.path.startsWith(`${pin.version}/`) || /[\\:\0]/u.test(file.path)
      || file.path.split('/').some(part => !part || part === '.' || part === '..')
      || seen.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 0
      || !/^[a-f0-9]{64}$/u.test(file.sha256)) throw new Error('Invalid SDK file manifest.');
    seen.add(file.path);
  }
  if (!seen.size || requiredFilesDigest(pin.files) !== pin.requiredFilesDigest) throw new Error('SDK manifest digest mismatch.');
}

function assertRegularPath(root, relative) {
  let current = root;
  if (!fs.lstatSync(current).isDirectory() || fs.lstatSync(current).isSymbolicLink()) throw new Error('SDK root must be a real directory.');
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error('SDK file path must not contain links or special files.');
    }
  }
  return current;
}

function verifySubset(root, pin = manifest) {
  validateManifest(pin);
  const relativeFiles = new Set(pin.files.map(file => file.path.slice(pin.version.length + 1)));
  for (const file of pin.files) {
    const absolute = assertRegularPath(root, file.path.slice(pin.version.length + 1));
    const stat = fs.statSync(absolute);
    if (stat.size !== file.size
      || crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex') !== file.sha256) {
      throw new Error('SDK required file content differs from the pinned archive.');
    }
  }
  // Full SDK installs are accepted only if their include search paths contain
  // exactly the pinned files. Extra headers can change compiler include resolution.
  function visit(relative) {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) return;
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error('SDK include directories must not contain links.');
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute)) visit(`${relative}/${name}`);
    } else if (!stat.isFile() || !relativeFiles.has(relative)) {
      throw new Error('Unexpected file in pinned SDK include directories.');
    }
  }
  for (const directory of INCLUDE_DIRECTORIES) visit(directory);
  return { version: pin.version, archiveSha256: pin.archiveSha256, requiredFilesDigest: pin.requiredFilesDigest };
}

function resolveSdkRoot(projectRoot, options, pin = manifest) {
  const env = options.env || process.env;
  const explicitRoot = options.sdkRoot || env.HEXAGON_SDK_ROOT;
  if (!explicitRoot && env.HEXAGON_TOOLS_ROOT) throw new Error('HEXAGON_TOOLS_ROOT requires a verified SDK root.');
  const root = path.resolve(explicitRoot || path.join(projectRoot, 'node_modules', '.cache', 'pocket-ai-android', 'hexagon-sdk', pin.version));
  const toolsRoot = path.join(root, 'tools', 'HEXAGON_Tools', pin.toolsVersion);
  if (env.HEXAGON_TOOLS_ROOT && path.resolve(env.HEXAGON_TOOLS_ROOT) !== toolsRoot) {
    throw new Error('HEXAGON_TOOLS_ROOT does not match the pinned SDK root.');
  }
  return { root, toolsRoot, external: Boolean(explicitRoot) };
}

function verifySdk(projectRoot, options, pin) {
  if (!requiresHexagonSdk(options.abi || 'universal')) return { status: 'not_required', env: {}, identity: null };
  const { root, toolsRoot } = resolveSdkRoot(projectRoot, options, pin);
  const identity = verifySubset(root, pin);
  return { status: 'verified', env: { HEXAGON_SDK_ROOT: root, HEXAGON_TOOLS_ROOT: toolsRoot }, identity };
}

function archiveVerifier(pin) {
  let bytes = 0;
  const hash = crypto.createHash('sha256');
  return new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > pin.archiveBytes) return callback(new Error('SDK archive exceeds pinned size.'));
      hash.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      callback(bytes !== pin.archiveBytes || hash.digest('hex') !== pin.archiveSha256
        ? new Error('SDK archive size or SHA-256 mismatch.') : null);
    },
  });
}

async function verifyArchive(archivePath, pin = manifest, signal) {
  const sink = new Transform({ transform(_chunk, _encoding, callback) { callback(); } });
  await pipeline(fs.createReadStream(archivePath), archiveVerifier(pin), sink, { signal });
}

function openDownload(url, signal, redirects = 0) {
  if (redirects > 5 || new URL(url).protocol !== 'https:') return Promise.reject(new Error('Invalid SDK download redirect.'));
  return new Promise((resolve, reject) => {
    const request = https.get(url, { signal }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (!response.headers.location) return reject(new Error('SDK download redirect has no location.'));
        resolve(openDownload(new URL(response.headers.location, url).href, signal, redirects + 1));
      } else if (response.statusCode !== 200) {
        response.resume();
        reject(new Error('SDK download did not return HTTP 200.'));
      } else resolve(response);
    });
    request.setTimeout(30000, () => request.destroy(new Error('SDK download stalled.')));
    request.once('error', reject);
  });
}

async function downloadArchive(destination, pin = manifest, options = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = setTimeout(abort, options.timeoutMs || 15 * 60 * 1000);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    const response = await (options.openDownload || openDownload)(pin.sourceUrl, controller.signal);
    await pipeline(response, archiveVerifier(pin), fs.createWriteStream(destination, { flags: 'wx' }), { signal: controller.signal });
  } catch (error) {
    // destination is a freshly allocated task-owned path, never a caller archive.
    fs.rmSync(destination, { force: true });
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}

// tarfile only reads members. Never use extract()/extractall(): only explicitly
// whitelisted regular bytes are copied into the newly allocated staging directory.
const EXTRACT_PYTHON = String.raw`
import hashlib, json, os, pathlib, sys, tarfile
archive, destination, manifest_path = sys.argv[1:]
with open(manifest_path, encoding='utf-8') as f:
    pin = json.load(f)
expected = {entry['path']: entry for entry in pin['files']}
seen = set()
root = pathlib.Path(destination).resolve()
with tarfile.open(archive, mode='r|xz') as source:
    for member in source:
        name = member.name
        parts = name.rstrip('/').split('/')
        if not name or name.startswith('/') or '\\' in name or ':' in name or any(p in ('', '.', '..') for p in parts):
            raise ValueError('Unsafe SDK archive path')
        if name not in expected:
            continue
        entry = expected[name]
        if name in seen or not member.isfile() or member.issparse() or member.size != entry['size']:
            raise ValueError('Unsafe SDK archive member')
        target = root.joinpath(*parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256()
        written = 0
        with source.extractfile(member) as src, open(target, 'xb') as out:
            while True:
                chunk = src.read(65536)
                if not chunk:
                    break
                written += len(chunk)
                if written > entry['size']:
                    raise ValueError('SDK member exceeds pinned size')
                digest.update(chunk)
                out.write(chunk)
        if written != entry['size'] or digest.hexdigest() != entry['sha256']:
            raise ValueError('SDK member hash mismatch')
        seen.add(name)
if seen != set(expected):
    raise ValueError('SDK archive is missing required files')
`;

function runPython(args, options = {}) {
  return new Promise((resolve, reject) => {
    const env = options.env || process.env;
    const child = spawn(env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), args, {
      env, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true, shell: false,
    });
    if (child.pid) {
      if (options.onProcess) options.onProcess(child.pid);
      else process.stderr.write(`[llama-hexagon-sdk] extractor PID ${child.pid}\n`);
    }
    let aborted = false;
    const abort = () => { aborted = true; child.kill(); };
    const timer = setTimeout(abort, options.timeoutMs || 15 * 60 * 1000);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    let spawnError;
    child.once('error', error => { spawnError = error; });
    child.once('close', code => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (spawnError || aborted || code !== 0) reject(new Error('SDK archive extraction failed or was cancelled.'));
      else resolve();
    });
  });
}

async function extractArchive(archivePath, destination, pin, options = {}) {
  validateManifest(pin);
  const manifestPath = path.join(destination, 'extraction-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(pin), { flag: 'wx' });
  try {
    await runPython(['-c', EXTRACT_PYTHON, archivePath, destination, manifestPath], options);
  } finally {
    fs.rmSync(manifestPath, { force: true });
  }
}

async function setupSdk(projectRoot, options, pin) {
  if (!requiresHexagonSdk(options.abi || 'universal')) return { status: 'not_required', env: {}, identity: null };
  const { root, external } = resolveSdkRoot(projectRoot, options, pin);
  // Never repair or replace an unverified caller installation or drifted cache.
  if (external || fs.existsSync(root)) return verifySdk(projectRoot, options, pin);
  const parent = path.dirname(root);
  fs.mkdirSync(parent, { recursive: true });
  const lock = path.join(parent, '.setup-lock');
  fs.mkdirSync(lock); // Fail closed if another process owns SDK setup.
  let work;
  try {
    if (fs.existsSync(root)) return verifySdk(projectRoot, options, pin);
    work = fs.mkdtempSync(path.join(parent, '.setup-'));
    const archivePath = options.archivePath || path.join(work, 'archive.tar.xz');
    if (options.archivePath) await verifyArchive(archivePath, pin, options.signal);
    else await downloadArchive(archivePath, pin, options);
    await extractArchive(archivePath, work, pin, options);
    const stagedRoot = path.join(work, pin.version);
    verifySubset(stagedRoot, pin);
    fs.renameSync(stagedRoot, root);
    return verifySdk(projectRoot, options, pin);
  } finally {
    if (work) fs.rmSync(work, { recursive: true, force: true });
    fs.rmdirSync(lock);
  }
}

function verifyLlamaHexagonSdk(projectRoot, options = {}) {
  return verifySdk(projectRoot, options, manifest);
}

async function withSetupCancellation(options, work, processRef = process) {
  const controller = options.signal ? null : new AbortController();
  const signal = options.signal || controller.signal;
  const abort = () => controller.abort();
  if (controller) {
    processRef.once('SIGINT', abort);
    processRef.once('SIGTERM', abort);
  }
  try {
    if (signal.aborted) throw new Error('SDK setup cancelled.');
    const result = await work({ ...options, signal });
    if (signal.aborted) throw new Error('SDK setup cancelled.');
    return result;
  } finally {
    if (controller) {
      processRef.removeListener('SIGINT', abort);
      processRef.removeListener('SIGTERM', abort);
    }
  }
}

function setupLlamaHexagonSdk(projectRoot, options = {}) {
  return withSetupCancellation(options, config => setupSdk(projectRoot, config, manifest));
}

async function main(argv, dependencies = {}) {
  const [command, flag, abi] = argv;
  if (argv.length !== 3 || !['setup', 'verify'].includes(command) || flag !== '--abi') throw new Error('Invalid SDK command.');
  const processRef = dependencies.processRef || process;
  const options = { abi, onProcess: pid => processRef.stderr.write(`[llama-hexagon-sdk] extractor PID ${pid}\n`) };
  const root = path.resolve(__dirname, '..');
  const result = await withSetupCancellation(options, config => command === 'setup'
    ? (dependencies.setup || setupLlamaHexagonSdk)(root, config) : verifyLlamaHexagonSdk(root, config), processRef);
  processRef.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(() => { process.stderr.write(`${SAFE_ERROR}\n`); process.exitCode = 1; });
}

module.exports = {
  setupLlamaHexagonSdk, verifyLlamaHexagonSdk, requiresHexagonSdk, manifest,
  _internal: { setupSdk, verifySdk, requiredFilesDigest, validateManifest, verifySubset, verifyArchive, downloadArchive, extractArchive, runPython, main, SAFE_ERROR },
};
