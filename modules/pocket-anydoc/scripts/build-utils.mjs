import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const RUST_ROOT = join(MODULE_ROOT, 'rust');
export const RUST_MANIFEST = join(RUST_ROOT, 'Cargo.toml');
export const RUST_TOOLCHAIN_FILE = join(RUST_ROOT, 'rust-toolchain.toml');
export const PUBLIC_HEADER = join(MODULE_ROOT, 'include', 'pocket_anydoc.h');
export const ANDROID_ABIS = Object.freeze(['arm64-v8a', 'x86_64']);
export const ANDROID_TARGETS = Object.freeze(['aarch64-linux-android', 'x86_64-linux-android']);
export const IOS_TARGETS = Object.freeze(['aarch64-apple-ios', 'aarch64-apple-ios-sim', 'x86_64-apple-ios']);
export const ANDROID_API_LEVEL = 24;
export const ANDROID_NDK_VERSION = '27.1.12297006';
export const CARGO_NDK_VERSION = '4.1.2';
export const IOS_DEPLOYMENT_TARGET = '15.1';

const GENERATED_SEGMENTS = new Set(['.git', 'build', 'target', 'generated', 'node_modules']);

export function redactBuildOutput(value) {
  return String(value)
    .replace(/file:\/{3}[^\r\n]*/giu, '<absolute-path>')
    .replace(/\\\\[^\\\r\n]+\\[^\r\n]*/gu, '<absolute-path>')
    .replace(/(^|[^A-Za-z0-9+.-])[A-Za-z]:[\\/][^\r\n]*/gmu, '$1<absolute-path>')
    .replace(/(^|[\s:=("'])\/(?!\/)[^\r\n]*/gmu, '$1<absolute-path>');
}

export function fail(message) {
  const error = new Error(`[pocket-anydoc] ${redactBuildOutput(message)}`);
  // These scripts are invoked directly by Gradle/EAS. Avoid Node's default
  // absolute source-path stack trace for intentional, user-facing failures.
  error.stack = error.toString();
  throw error;
}

export function ensureFile(path, description = path) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    fail(`Missing ${description}: ${path}`);
  }
}

export function ensureDirectory(path, description = path) {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    fail(`Missing ${description}: ${path}`);
  }
}

export function ensureInside(parent, candidate, description = 'path') {
  const parentPath = resolve(parent);
  const candidatePath = resolve(candidate);
  const prefix = `${parentPath}${sep}`;
  if (candidatePath !== parentPath && !candidatePath.startsWith(prefix)) {
    fail(`Refusing ${description} outside ${parentPath}: ${candidatePath}`);
  }
  return candidatePath;
}

export function removeGenerated(path) {
  const target = ensureInside(MODULE_ROOT, path, 'generated cleanup');
  const relativeTarget = relative(MODULE_ROOT, target).split(sep);
  if (!relativeTarget.some((segment) => segment === 'build' || segment === 'generated')) {
    fail(`Refusing cleanup of non-generated path: ${target}`);
  }
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
  }
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? MODULE_ROOT,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
    stdio: 'pipe',
    windowsHide: true,
  });
  const tool = basename(command) || 'tool';
  if (result.error) {
    fail(`Unable to run ${tool}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    fail(`${tool} failed with status ${result.status ?? 'unknown'}${detail ? `\n${detail}` : ''}`);
  }
  if (!options.capture) {
    const stdout = redactBuildOutput(result.stdout ?? '');
    const stderr = redactBuildOutput(result.stderr ?? '');
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  }
  return options.capture ? (result.stdout ?? '').trim() : '';
}

export function isExactCargoNdkVersion(output, expected = CARGO_NDK_VERSION) {
  const match = String(output).match(/^cargo-ndk\s+([0-9]+\.[0-9]+\.[0-9]+)\s*$/u);
  return match?.[1] === expected;
}

export function commandExists(command, args = ['--version']) {
  const result = spawnSync(command, args, {
    cwd: MODULE_ROOT,
    env: process.env,
    encoding: 'utf8',
    shell: false,
    stdio: 'pipe',
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}

export function readPinnedToolchain() {
  ensureFile(RUST_TOOLCHAIN_FILE, 'rust-toolchain.toml');
  const source = readFileSync(RUST_TOOLCHAIN_FILE, 'utf8');
  const match = source.match(/^\s*channel\s*=\s*["']([^"']+)["']/mu);
  if (!match || !/^1\.\d+\.\d+(?:-[A-Za-z0-9._-]+)?$/u.test(match[1])) {
    fail('rust-toolchain.toml must pin an exact stable channel such as 1.97.1.');
  }
  return match[1];
}

function collectFiles(root, output) {
  if (!existsSync(root)) {
    return;
  }
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink()) {
    fail(`Symlinks are not valid deterministic build inputs: ${root}`);
  }
  if (rootStat.isFile()) {
    output.push(root);
    return;
  }
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (GENERATED_SEGMENTS.has(entry.name)) {
      continue;
    }
    collectFiles(join(root, entry.name), output);
  }
}

export function hashInputs(paths, metadata = {}) {
  const files = [];
  for (const path of paths) {
    collectFiles(path, files);
  }
  const hash = createHash('sha256');
  hash.update(`${JSON.stringify(metadata, Object.keys(metadata).sort())}\n`);
  for (const file of files.sort()) {
    const canonical = realpathSync(file);
    if (!isAbsolute(canonical)) {
      fail(`Build input did not resolve to an absolute path: ${file}`);
    }
    hash.update(`${relative(MODULE_ROOT, file).replaceAll('\\', '/')}\0`);
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function sha256File(path) {
  ensureFile(path);
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function readFingerprint(path) {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  if (existsSync(path)) {
    rmSync(path, { force: true });
  }
  renameSync(temporary, path);
}

export function requiredRustInputs() {
  return [
    RUST_TOOLCHAIN_FILE,
    join(RUST_ROOT, 'Cargo.toml'),
    join(RUST_ROOT, 'Cargo.lock'),
    join(RUST_ROOT, 'build.rs'),
    join(RUST_ROOT, 'src'),
    join(RUST_ROOT, 'vendor'),
    join(RUST_ROOT, 'UPSTREAM.json'),
    join(RUST_ROOT, 'UPSTREAM.md'),
    PUBLIC_HEADER,
    fileURLToPath(import.meta.url),
  ];
}
