import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IOS_DEPLOYMENT_TARGET,
  IOS_TARGETS,
  MODULE_ROOT,
  PUBLIC_HEADER,
  RUST_MANIFEST,
  RUST_ROOT,
  ensureFile,
  fail,
  hashInputs,
  readFingerprint,
  readPinnedToolchain,
  removeGenerated,
  requiredRustInputs,
  run,
  sha256File,
  writeJsonAtomic,
} from './build-utils.mjs';

const GENERATED_ROOT = join(MODULE_ROOT, 'ios', 'generated');
const XCFRAMEWORK = join(GENERATED_ROOT, 'PocketAnyDoc.xcframework');
const FINGERPRINT_FILE = join(GENERATED_ROOT, 'fingerprint.json');
const TEMP_XCFRAMEWORK = join(GENERATED_ROOT, `.PocketAnyDoc.tmp-${process.pid}.xcframework`);
const BUILD_ROOT = join(MODULE_ROOT, 'ios', 'build', 'pocketAnyDoc');
const LIBRARY_NAME = 'libpocket_anydoc.a';

function findStaticLibraries(root) {
  if (!existsSync(root)) {
    return [];
  }
  const result = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.name === LIBRARY_NAME) {
        result.push(path);
      }
    }
  };
  visit(root);
  return result.sort();
}

function artifactChecksums(root) {
  return Object.fromEntries(findStaticLibraries(root).map((path) => [relative(root, path).replaceAll('\\', '/'), sha256File(path)]));
}

if (process.platform !== 'darwin') {
  fail('iOS XCFramework builds require macOS with Xcode.');
}
ensureFile(RUST_MANIFEST, 'Rust Cargo.toml');
ensureFile(join(RUST_ROOT, 'Cargo.lock'), 'Rust Cargo.lock');
ensureFile(PUBLIC_HEADER, 'public C ABI header');

const toolchain = readPinnedToolchain();
const metadata = {
  cargo: run('cargo', [`+${toolchain}`, '--version'], { capture: true }),
  deploymentTarget: IOS_DEPLOYMENT_TARGET,
  profile: 'release',
  rustc: run('rustc', [`+${toolchain}`, '--version', '--verbose'], { capture: true }),
  targets: IOS_TARGETS,
  toolchain,
  xcode: run('xcodebuild', ['-version'], { capture: true }),
};
const fingerprint = hashInputs([...requiredRustInputs(), fileURLToPath(import.meta.url)], metadata);
const previous = readFingerprint(FINGERPRINT_FILE);
if (previous?.fingerprint === fingerprint && existsSync(XCFRAMEWORK)) {
  const currentChecksums = artifactChecksums(XCFRAMEWORK);
  if (Object.keys(currentChecksums).length === 2 && JSON.stringify(currentChecksums) === JSON.stringify(previous.artifacts)) {
    console.log(`[pocket-anydoc] iOS XCFramework is current (${fingerprint.slice(0, 12)}).`);
    process.exit(0);
  }
}

const cargoEnvironment = {
  CARGO_PROFILE_RELEASE_LTO: 'thin',
  IPHONEOS_DEPLOYMENT_TARGET: IOS_DEPLOYMENT_TARGET,
  IPHONESIMULATOR_DEPLOYMENT_TARGET: IOS_DEPLOYMENT_TARGET,
};
for (const target of IOS_TARGETS) {
  run('cargo', [
    `+${toolchain}`,
    'build',
    '--manifest-path', RUST_MANIFEST,
    '--target', target,
    '--locked',
    '--release',
    '--lib',
  ], { env: cargoEnvironment });
}

const deviceLibrary = join(RUST_ROOT, 'target', 'aarch64-apple-ios', 'release', LIBRARY_NAME);
const simulatorArmLibrary = join(RUST_ROOT, 'target', 'aarch64-apple-ios-sim', 'release', LIBRARY_NAME);
const simulatorIntelLibrary = join(RUST_ROOT, 'target', 'x86_64-apple-ios', 'release', LIBRARY_NAME);
for (const library of [deviceLibrary, simulatorArmLibrary, simulatorIntelLibrary]) {
  ensureFile(library, 'iOS Rust static library');
}

removeGenerated(BUILD_ROOT);
mkdirSync(BUILD_ROOT, { recursive: true });
const simulatorUniversalLibrary = join(BUILD_ROOT, LIBRARY_NAME);
run('xcrun', ['lipo', simulatorArmLibrary, simulatorIntelLibrary, '-create', '-output', simulatorUniversalLibrary]);
run('xcrun', ['lipo', simulatorUniversalLibrary, '-verify_arch', 'arm64', 'x86_64']);

mkdirSync(GENERATED_ROOT, { recursive: true });
removeGenerated(TEMP_XCFRAMEWORK);
run('xcodebuild', [
  '-create-xcframework',
  '-library', deviceLibrary,
  '-headers', join(MODULE_ROOT, 'include'),
  '-library', simulatorUniversalLibrary,
  '-headers', join(MODULE_ROOT, 'include'),
  '-output', TEMP_XCFRAMEWORK,
]);
removeGenerated(XCFRAMEWORK);
renameSync(TEMP_XCFRAMEWORK, XCFRAMEWORK);

const artifacts = artifactChecksums(XCFRAMEWORK);
if (Object.keys(artifacts).length !== 2) {
  fail(`Expected device and simulator ${LIBRARY_NAME} slices in ${XCFRAMEWORK}.`);
}
writeJsonAtomic(FINGERPRINT_FILE, { fingerprint, metadata, artifacts });
console.log(`[pocket-anydoc] iOS XCFramework built (${fingerprint.slice(0, 12)}).`);
