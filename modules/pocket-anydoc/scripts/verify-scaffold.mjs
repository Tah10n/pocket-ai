import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ANDROID_ABIS,
  ANDROID_API_LEVEL,
  ANDROID_NDK_VERSION,
  CARGO_NDK_VERSION,
  IOS_DEPLOYMENT_TARGET,
  MODULE_ROOT,
  ensureFile,
  fail,
  isExactCargoNdkVersion,
  redactBuildOutput,
  run,
} from './build-utils.mjs';

function read(relativePath) {
  const path = join(MODULE_ROOT, relativePath);
  ensureFile(path, relativePath);
  return readFileSync(path, 'utf8');
}

function requireText(source, expected, description) {
  if (!source.includes(expected)) {
    fail(`${description} is missing ${JSON.stringify(expected)}.`);
  }
}

const config = JSON.parse(read('expo-module.config.json'));
if (JSON.stringify(config.platforms) !== JSON.stringify(['apple', 'android'])) {
  fail('expo-module.config.json must enable only apple and android.');
}
if (config.apple?.modules?.[0] !== 'PocketAnyDocModule') {
  fail('Apple module registration must be PocketAnyDocModule.');
}
if (config.android?.modules?.[0] !== 'com.github.tah10n.pocketanydoc.PocketAnyDocModule') {
  fail('Android module registration is inconsistent.');
}

const packageJson = JSON.parse(read('package.json'));
for (const script of ['anydoc:setup', 'anydoc:build:android', 'anydoc:build:ios', 'eas-build-pre-install']) {
  if (typeof packageJson.scripts?.[script] !== 'string') {
    fail(`package.json is missing ${script}.`);
  }
}

const gradle = read('android/build.gradle');
requireText(gradle, `ndkVersion '${ANDROID_NDK_VERSION}'`, 'Android Gradle config');
requireText(gradle, `minSdk ${ANDROID_API_LEVEL}`, 'Android Gradle config');
requireText(gradle, "versionName '0.0.1'", 'Android library version');
for (const abi of ANDROID_ABIS) {
  requireText(gradle, `'${abi}'`, 'Android ABI filter');
}
requireText(gradle, 'buildPocketAnyDocRust', 'Android Gradle lifecycle');
requireText(gradle, 'verifyPocketAnyDocReleaseArtifacts', 'Android release packaging verification');
requireText(gradle, 'stripReleaseDebugSymbols', 'Android release symbol verification');
requireText(gradle, "'libpocket_anydoc_jni.so'", 'Android JNI artifact contract');
requireText(gradle, "'-DANDROID_STL=c++_static'", 'Android static C++ runtime linkage');
for (const section of ['symtab', 'strtab', 'gnu_debugdata', 'gnu_debuglink']) {
  requireText(gradle, section, 'Android release symbol verification');
}

const cmake = read('android/src/main/cpp/CMakeLists.txt');
const jni = read('android/src/main/cpp/pocket_anydoc_jni.cpp');
const header = read('include/pocket_anydoc.h');
requireText(cmake, '-Wl,-z,max-page-size=16384', 'Android JNI linker flags');
requireText(cmake, 'libpocket_anydoc.so', 'Android CMake import');
requireText(cmake, 'add_library(pocket_anydoc_jni SHARED', 'Android JNI shared library');
if (cmake.includes('Missing ${POCKET_ANYDOC_LIBRARY}')) {
  fail('Android CMake errors must not expose the generated library absolute path.');
}
requireText(jni, 'PocketAnyDocJni_materializeAsset', 'Android materialize JNI export');
requireText(jni, 'pocket_anydoc_materialize_asset', 'Android materialize C ABI call');
requireText(header, 'pocket_anydoc_materialize_asset(', 'Public materialize C ABI');

const kotlin = read('android/src/main/java/com/github/tah10n/pocketanydoc/PocketAnyDocModule.kt');
const swift = read('ios/PocketAnyDocModule.swift');
if ((kotlin.match(/promise\.resolve\(requestFailure\(it\)\)/gu) ?? []).length !== 1) {
  fail('Android invalid heavy-request handling must resolve its promise exactly once.');
}
if (!/catch \{\s*promise\.resolve\(requestFailure\(error\)\)\s*return\s*\}/u.test(swift)) {
  fail('iOS invalid heavy-request handling must resolve its promise exactly once and return.');
}
for (const method of ['getCapabilities', 'getVersion', 'prepareDocument', 'selectContext', 'materializeAsset', 'cancel', 'release']) {
  requireText(kotlin, `\"${method}\"`, 'Android Expo module');
  requireText(swift, `\"${method}\"`, 'iOS Expo module');
}
for (const expected of ['ThreadPoolExecutor(', 'LinkedBlockingDeque<Runnable>', 'drainPendingJobsLocked()', 'generation.get() != submittedGeneration']) {
  requireText(kotlin, expected, 'Android bounded lifecycle queue');
}
for (const expected of [
  'MATERIALIZE_REQUEST_KEYS = setOf("requestId", "handle", "assetId")',
  'pocket-anydoc-assets',
  'destinationPath',
  'privateRoot',
  'OsConstants.O_NOFOLLOW',
  'retainedApplicationContext',
  'cleanupAllAssets()',
  'cleanupAssetsForRequest(requestId)',
  'cleanupAssetsForHandle(handle)',
  '"localUri" to Uri.fromFile(canonicalDestination).toString()',
  'expectedMetadata.byteLength',
  'expectedMetadata.sha256',
  'expectedMetadata.width',
  'expectedMetadata.height',
]) {
  requireText(kotlin, expected, 'Android private asset materialization');
}
for (const expected of ['requestRetirement()', 'drainPendingJobsLocked()', 'pendingJobs.removeValue', 'currentInvalidationEnvelope(']) {
  requireText(swift, expected, 'iOS retirement lifecycle');
}
for (const expected of [
  'materializeRequestKeys = Set(["requestId", "handle", "assetId"])',
  'pocket-anydoc-assets',
  'destinationPath',
  'privateRoot',
  'O_NOFOLLOW',
  'CryptoKit',
  'cleanupAllAssets()',
  'cleanupAssets(forRequestId: requestId)',
  'cleanupAssets(forHandle: handle)',
  '"localUri": canonicalDestination.absoluteString',
  'expectedMetadata.byteLength',
  'expectedMetadata.sha256',
  'expectedMetadata.width',
  'expectedMetadata.height',
]) {
  requireText(swift, expected, 'iOS private asset materialization');
}
for (const expected of ['cancelledCount', 'releasedCount']) {
  requireText(kotlin, expected, 'Android lifecycle response envelope');
  requireText(swift, expected, 'iOS lifecycle response envelope');
}
requireText(swift, 'import CoreFoundation', 'iOS numeric type validation');
if (!/private func requiredBoundedInteger\([^)]*\) throws -> Int \{\s*guard\s+let number = value as\? NSNumber,\s+CFGetTypeID\(number\) != CFBooleanGetTypeID\(\)\s+else \{/u.test(swift)) {
  fail('iOS bounded integer validation must reject CFBoolean before numeric conversion.');
}
requireText(kotlin, 'val number = value as? Number', 'Android numeric type validation');
requireText(kotlin, 'chat-attachments', 'Android private attachment root');
requireText(swift, 'chat-attachments', 'iOS private attachment root');

const podspec = read('ios/PocketAnyDoc.podspec');
const iosBridgeHeader = read('ios/PocketAnyDocBridge.h');
requireText(podspec, `:ios => '${IOS_DEPLOYMENT_TARGET}'`, 'iOS deployment target');
requireText(podspec, 'PocketAnyDoc.xcframework', 'iOS XCFramework linkage');
const sourceFiles = podspec.match(/s\.source_files\s*=\s*\[([\s\S]*?)\]/u)?.[1] ?? '';
if (
  sourceFiles.includes('*')
  || sourceFiles.includes('..')
  || (sourceFiles.match(/PocketAnyDocBridge\.h/gu) ?? []).length !== 1
) {
  fail('The podspec source_files list must contain exactly one in-root public wrapper header and no generated-file glob.');
}
if (
  !podspec.includes("s.public_header_files = 'PocketAnyDocBridge.h'")
  || !podspec.includes("s.header_mappings_dir = '.'")
  || podspec.includes("'../include/pocket_anydoc.h'")
) {
  fail('CocoaPods file patterns must remain inside the ios pod root.');
}
requireText(podspec, "'DEFINES_MODULE' => 'YES'", 'iOS generated module map');
requireText(podspec, '${PODS_TARGET_SRCROOT}/../include', 'iOS canonical ABI header search path');
requireText(iosBridgeHeader, '#include <pocket_anydoc.h>', 'iOS public C ABI wrapper');
if (/pocket_anydoc_(?:engine|prepare|select|materialize|cancel|release|buffer)/u.test(iosBridgeHeader)) {
  fail('The iOS public wrapper must not duplicate C ABI declarations.');
}
if (podspec.includes('prepare_command')) {
  fail('The podspec must not run a prepare_command. Build through the EAS/local wrapper instead.');
}

const androidBuild = read('scripts/build-android.mjs');
const androidGradle = read('android/build.gradle');
requireText(androidBuild, `CARGO_NDK_VERSION`, `cargo-ndk ${CARGO_NDK_VERSION} pin`);
requireText(androidBuild, 'isExactCargoNdkVersion(cargoNdkVersion)', 'Android exact cargo-ndk check');
requireText(androidBuild, 'cwd: RUST_ROOT', 'cargo-ndk Rust package working directory');
requireText(androidGradle, 'Long.decode', 'NDK hexadecimal ELF alignment parser');
requireText(androidBuild, "'--lib'", 'Android host-runner exclusion');
const setup = read('scripts/setup.mjs');
requireText(setup, 'isExactCargoNdkVersion(cargoNdkVersion)', 'Setup exact cargo-ndk check');
const iosBuild = read('scripts/build-ios.mjs');
requireText(iosBuild, 'xcodebuild', 'iOS deterministic build wrapper');
requireText(iosBuild, 'IPHONEOS_DEPLOYMENT_TARGET: IOS_DEPLOYMENT_TARGET', 'iOS device Rust deployment target');
requireText(iosBuild, 'IPHONESIMULATOR_DEPLOYMENT_TARGET: IOS_DEPLOYMENT_TARGET', 'iOS simulator Rust deployment target');

const typescript = read('src/index.ts');
requireText(typescript, 'materializeAsset(request: PocketAnydocMaterializeAssetRequest)', 'TypeScript materialize bridge');

if (!isExactCargoNdkVersion(`cargo-ndk ${CARGO_NDK_VERSION}`)) {
  fail('The exact cargo-ndk parser rejected the pinned version.');
}
for (const invalid of [
  `cargo-ndk ${CARGO_NDK_VERSION}0`,
  `prefix cargo-ndk ${CARGO_NDK_VERSION}`,
  `cargo-ndk ${CARGO_NDK_VERSION} extra`,
]) {
  if (isExactCargoNdkVersion(invalid)) {
    fail('The exact cargo-ndk parser accepted non-exact output.');
  }
}

for (const privateOutput of [
  'Missing C:\\Users\\private-user\\workspace\\artifact.so. Run a command.',
  'Missing /Users/private-user/workspace/artifact.a. Run a command.',
  'Missing file:///Users/private-user/workspace/artifact.a.',
]) {
  const redacted = redactBuildOutput(privateOutput);
  if (redacted.includes('private-user') || !redacted.includes('<absolute-path>')) {
    fail('Build-output redaction did not remove an absolute private path.');
  }
}
if (redactBuildOutput('Install from https://rustup.rs and retry.') !== 'Install from https://rustup.rs and retry.') {
  fail('Build-output redaction must preserve non-file HTTPS URLs.');
}

let redactedFailure = '';
let redactedFailureStack = '';
try {
  run(process.execPath, [
    '-e',
    'process.stderr.write("failed at C:\\\\Users\\\\private-user\\\\workspace\\\\artifact.so"); process.exit(7);',
    'secret-command-argument',
  ]);
} catch (error) {
  redactedFailure = String(error instanceof Error ? error.message : error);
  redactedFailureStack = String(error instanceof Error ? error.stack : error);
}
if (
  !redactedFailure.includes('status 7')
  || redactedFailure.includes('private-user')
  || redactedFailure.includes('secret-command-argument')
  || redactedFailureStack.includes('private-user')
  || redactedFailureStack.includes(MODULE_ROOT)
) {
  fail('Failed-command reporting must redact private paths and omit the full command.');
}

const gitignore = read('.gitignore');
for (const generatedPath of ['/rust/target/', '/ios/generated/', '/android/.cxx/', '/android/build/']) {
  requireText(gitignore, generatedPath, 'PocketAnyDoc generated-artifact ignore rules');
}

console.log('[pocket-anydoc] Native module scaffold verification passed.');
