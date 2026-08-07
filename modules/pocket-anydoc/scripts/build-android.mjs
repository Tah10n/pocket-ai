import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ANDROID_ABIS,
  ANDROID_API_LEVEL,
  ANDROID_NDK_VERSION,
  CARGO_NDK_VERSION,
  MODULE_ROOT,
  PUBLIC_HEADER,
  RUST_MANIFEST,
  RUST_ROOT,
  commandExists,
  ensureDirectory,
  ensureFile,
  fail,
  hashInputs,
  isExactCargoNdkVersion,
  readFingerprint,
  readPinnedToolchain,
  removeGenerated,
  requiredRustInputs,
  run,
  sha256File,
  writeJsonAtomic,
} from './build-utils.mjs';

const OUTPUT_ROOT = join(MODULE_ROOT, 'android', 'build', 'generated', 'pocketAnyDoc');
const JNI_LIBS_ROOT = join(OUTPUT_ROOT, 'jniLibs');
const FINGERPRINT_FILE = join(OUTPUT_ROOT, 'fingerprint.json');
const LIBRARY_NAME = 'libpocket_anydoc.so';
const PAGE_SIZE_LINK_FLAGS = '-C link-arg=-Wl,-z,max-page-size=16384 -C link-arg=-Wl,-z,common-page-size=16384';

function resolveNdkRoot() {
  const appRoot = resolve(MODULE_ROOT, '..', '..');
  const localProperties = join(appRoot, 'android', 'local.properties');
  let localSdk = null;
  if (existsSync(localProperties) && statSync(localProperties).isFile()) {
    const sdkMatch = readFileSync(localProperties, 'utf8').match(/^sdk\.dir=(.+)$/mu);
    if (sdkMatch) {
      localSdk = sdkMatch[1]
        .replaceAll('\\:', ':')
        .replaceAll('\\\\', '\\')
        .trim();
    }
  }
  const candidates = [
    process.env.ANDROID_NDK_HOME,
    process.env.ANDROID_NDK_ROOT,
    process.env.ANDROID_HOME ? join(process.env.ANDROID_HOME, 'ndk', ANDROID_NDK_VERSION) : null,
    process.env.ANDROID_SDK_ROOT ? join(process.env.ANDROID_SDK_ROOT, 'ndk', ANDROID_NDK_VERSION) : null,
    localSdk ? join(localSdk, 'ndk', ANDROID_NDK_VERSION) : null,
  ].filter(Boolean);
  const resolved = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isDirectory());
  if (!resolved) {
    fail(`Android NDK ${ANDROID_NDK_VERSION} was not found. Set ANDROID_NDK_HOME or install the pinned NDK.`);
  }
  const sourceProperties = join(resolved, 'source.properties');
  ensureFile(sourceProperties, 'Android NDK source.properties');
  const versionText = readFileSync(sourceProperties, 'utf8');
  const revision = versionText.match(/^\s*Pkg\.Revision\s*=\s*([^\s]+)\s*$/mu)?.[1];
  if (revision !== ANDROID_NDK_VERSION) {
    fail(`The configured Android NDK must be exactly ${ANDROID_NDK_VERSION}.`);
  }
  return resolved;
}

function resolveNdkTool(ndkRoot, tool) {
  const prebuiltRoot = join(ndkRoot, 'toolchains', 'llvm', 'prebuilt');
  ensureDirectory(prebuiltRoot, 'NDK LLVM prebuilt toolchain');
  const hosts = readdirSync(prebuiltRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (hosts.length !== 1) {
    fail(`Expected one NDK host toolchain under ${prebuiltRoot}, found: ${hosts.join(', ')}`);
  }
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const path = join(prebuiltRoot, hosts[0], 'bin', `${tool}${suffix}`);
  ensureFile(path, `NDK ${tool}`);
  return path;
}

function expectedLibraries() {
  return Object.fromEntries(ANDROID_ABIS.map((abi) => [abi, join(JNI_LIBS_ROOT, abi, LIBRARY_NAME)]));
}

function validateArtifactLayout() {
  ensureDirectory(JNI_LIBS_ROOT, 'generated Android jniLibs');
  const presentAbis = readdirSync(JNI_LIBS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (JSON.stringify(presentAbis) !== JSON.stringify([...ANDROID_ABIS].sort())) {
    fail(`Expected only ${ANDROID_ABIS.join(', ')} under generated jniLibs, found ${presentAbis.join(', ')}.`);
  }
  for (const [abi, library] of Object.entries(expectedLibraries())) {
    ensureFile(library, `${abi} ${LIBRARY_NAME}`);
    const unexpected = readdirSync(join(JNI_LIBS_ROOT, abi)).filter((name) => name !== LIBRARY_NAME);
    if (unexpected.length > 0) {
      fail(`Unexpected generated artifacts for ${abi}: ${unexpected.join(', ')}`);
    }
  }
}

function validatePageAlignment(readElf, library) {
  const programHeaders = run(readElf, ['-lW', library], { capture: true });
  const loadAlignments = programHeaders
    .split(/\r?\n/u)
    .filter((line) => /^\s*LOAD\s/u.test(line))
    .map((line) => line.trim().split(/\s+/u).at(-1))
    .map((value) => Number.parseInt(value, 16));
  if (loadAlignments.length === 0 || loadAlignments.some((alignment) => !Number.isFinite(alignment) || alignment < 16_384)) {
    fail(`${relative(MODULE_ROOT, library)} is not linked with 16 KiB-compatible LOAD alignment.`);
  }
}

function removeKnownCargoNdkDependencyArtifacts(readElf) {
  for (const [abi, library] of Object.entries(expectedLibraries())) {
    ensureFile(library, `${abi} ${LIBRARY_NAME}`);
    const dynamicSection = run(readElf, ['-dW', library], { capture: true });
    const dependencies = readdirSync(join(JNI_LIBS_ROOT, abi))
      .filter((name) => /^libpdf_inspector-[0-9A-Fa-f]+\.so$/u.test(name));
    for (const dependency of dependencies) {
      if (dynamicSection.includes(dependency)) {
        fail(`${LIBRARY_NAME} unexpectedly links the cargo-ndk dependency artifact ${dependency}.`);
      }
      unlinkSync(join(JNI_LIBS_ROOT, abi, dependency));
    }
  }
}

ensureFile(RUST_MANIFEST, 'Rust Cargo.toml');
ensureFile(join(RUST_ROOT, 'Cargo.lock'), 'Rust Cargo.lock');
ensureFile(PUBLIC_HEADER, 'public C ABI header');
if (!commandExists('cargo', ['ndk', '--version'])) {
  fail(`cargo-ndk ${CARGO_NDK_VERSION} is required. Run anydoc:setup first.`);
}
const cargoNdkVersion = run('cargo', ['ndk', '--version'], { capture: true });
if (!isExactCargoNdkVersion(cargoNdkVersion)) {
  fail(`cargo-ndk must be exactly ${CARGO_NDK_VERSION}. Run anydoc:setup.`);
}

const toolchain = readPinnedToolchain();
const ndkRoot = resolveNdkRoot();
const llvmStrip = resolveNdkTool(ndkRoot, 'llvm-strip');
const llvmReadElf = resolveNdkTool(ndkRoot, 'llvm-readelf');
const metadata = {
  androidAbis: ANDROID_ABIS,
  androidApiLevel: ANDROID_API_LEVEL,
  cargo: run('cargo', [`+${toolchain}`, '--version'], { capture: true }),
  cargoNdk: cargoNdkVersion,
  ndkVersion: ANDROID_NDK_VERSION,
  profile: 'release',
  rustc: run('rustc', [`+${toolchain}`, '--version', '--verbose'], { capture: true }),
  rustflags: PAGE_SIZE_LINK_FLAGS,
  toolchain,
};
const fingerprint = hashInputs([...requiredRustInputs(), fileURLToPath(import.meta.url)], metadata);
const previous = readFingerprint(FINGERPRINT_FILE);

if (previous?.fingerprint === fingerprint) {
  try {
    validateArtifactLayout();
    const checksumsMatch = Object.entries(expectedLibraries()).every(([abi, path]) => previous.artifacts?.[abi]?.sha256 === sha256File(path));
    if (checksumsMatch) {
      for (const library of Object.values(expectedLibraries())) {
        validatePageAlignment(llvmReadElf, library);
      }
      console.log(`[pocket-anydoc] Android native artifacts are current (${fingerprint.slice(0, 12)}).`);
      process.exit(0);
    }
  } catch {
    // A stale or malformed generated directory is rebuilt below.
  }
}

removeGenerated(OUTPUT_ROOT);
mkdirSync(JNI_LIBS_ROOT, { recursive: true });
run('cargo', [
  `+${toolchain}`,
  'ndk',
  '-t', 'arm64-v8a',
  '-t', 'x86_64',
  '--platform', String(ANDROID_API_LEVEL),
  '-o', JNI_LIBS_ROOT,
  'build',
  '--manifest-path', RUST_MANIFEST,
  '--locked',
  '--release',
  '--lib',
], {
  // cargo-ndk resolves package metadata before forwarding the trailing Cargo
  // arguments, so its process cwd must be the pinned Rust package root.
  cwd: RUST_ROOT,
  env: {
    ANDROID_NDK_HOME: ndkRoot,
    CARGO_PROFILE_RELEASE_STRIP: 'symbols',
    RUSTFLAGS: PAGE_SIZE_LINK_FLAGS,
  },
});

removeKnownCargoNdkDependencyArtifacts(llvmReadElf);
validateArtifactLayout();
const artifacts = {};
for (const [abi, library] of Object.entries(expectedLibraries())) {
  run(llvmStrip, ['--strip-unneeded', library]);
  validatePageAlignment(llvmReadElf, library);
  artifacts[abi] = {
    file: `${abi}/${basename(library)}`,
    sha256: sha256File(library),
  };
}
writeJsonAtomic(FINGERPRINT_FILE, { fingerprint, metadata, artifacts });
console.log(`[pocket-anydoc] Android native artifacts built (${fingerprint.slice(0, 12)}).`);
