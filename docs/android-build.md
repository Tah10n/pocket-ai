# Android Build and Current-Head QA

This guide covers deterministic Android release builds, upload signing, and the
provenance-aware APK path used by high-assurance device QA.

For general development setup, see the main [README](../README.md). For the complete
release flow, see the [Release Checklist](./release-checklist.md).

## Prerequisites

- Install dependencies from the committed lockfile with `npm ci`.
- Install a supported JDK and the Android SDK.
- Set `ANDROID_HOME` or `ANDROID_SDK_ROOT`, or provide `android/local.properties` with
  `sdk.dir=...`.

The repository-owned build and Android QA scripts manage Expo prebuild. They run the
equivalent of this clean command when the generated native project is absent or stale:

```bash
npx expo prebuild --clean --platform android --no-install
```

A prebuild is reusable only when all of these still match:

- the build variant;
- content hashes for Expo/config inputs, plugins, patches, assets, and dependency metadata;
- a private-input HMAC for relevant environment and local signing/configuration state;
- the content hash of the generated `android/` project, excluding generated build outputs.

The shared active prebuild stamp prevents a debug native project from being reused for a
release build, or the reverse. Missing, malformed, cross-variant, input-mismatched, or
native-output-mismatched stamps trigger clean regeneration. Inputs are checked again after
prebuild, and a variant history stamp is written before the shared active stamp.

Pocket AI relies on native modules and Expo config plugins, including `llama.rn`, background
actions, Android QA release guards, and native memory/app-cache metrics. The system-metrics
plugin currently supports Kotlin `MainApplication` files. A project that switches that
generated entry point to Java must adapt the registration step before prebuild can inject
the `SystemMetrics` package.

## Upload signing

Create a local upload-signing config in `keystore.properties` at the project root, or
provide the equivalent `POCKET_AI_UPLOAD_*` environment variables:

```text
storeFile=keystores/pocket-ai-upload.jks
storePassword=your-store-password
keyAlias=pocketai
keyPassword=your-key-password
```

The `storeFile` path is resolved from the project root. Keep both the properties file and
keystore outside version control. Provenance and script-owned command log lines record only
bounded signing state and fingerprints; they do not publish credentials or the keystore
path. Expo, Gradle, and plugin processes write raw inherited output, so review that output
before sharing it.

## Build the production bundle

```bash
npm run build:android:production
```

Use an explicit Gradle clean only when diagnosing generated or Gradle output state:

```bash
npm run build:android:production:clean
```

The production command:

1. forces `NODE_ENV=production` and rejects QA evidence flags in a shipping build;
2. verifies or cleanly regenerates the native project;
3. resolves `expo.version` and `expo.android.versionCode` from `app.json`;
4. runs the repository-owned `app:bundleRelease` contract;
5. verifies the AAB contains exactly the supported ABIs and required native libraries;
6. fingerprints the finished artifact and writes its provenance atomically;
7. reserves the next Android `versionCode` in `app.json` only after every prior step succeeds.

The supported release task spellings are deliberately narrow:

- `app:bundleRelease` or `:app:bundleRelease` for the production AAB;
- `app:assembleRelease` or `:app:assembleRelease` for a release APK without an automatic
  `versionCode` bump.

Other task topology is rejected. Raw Gradle attempts to replace the repository-owned
version, ABI, signing, build-root, user-home, init-script, or argument-file contracts are
also rejected. Use `--version-code` and `--version-name` for the supported recovery path:

```bash
npm run build:android:production -- --version-code 20 --version-name 1.6.1
```

Pass `--no-bump` only when the current upload code must not be reserved automatically.
Android `versionCode` must be a positive integer no greater than `2100000000`. For the
default auto-bumping bundle task, a build at that limit fails before mutating `app.json`;
an intentional final-code bundle must use `--no-bump`. The assemble-only APK task does not
reserve another code.

## Hermetic Gradle execution

Provenance-aware builds use a repository-local, isolated `GRADLE_USER_HOME` and always add:

```text
--rerun-tasks --no-build-cache --no-configuration-cache
```

This makes the artifact transaction independent of a developer's ordinary Gradle caches
and prevents an old task output from being accepted as current evidence. External Gradle
init scripts, argument files, JVM code-loading channels, injected Android properties, and
non-canonical architecture overrides fail closed.

The build manifest hashes repository inputs by content, including the embedded JavaScript
bundle inputs for release builds. It excludes generated Android intermediates such as
`build/`, `.gradle/`, `.cxx/`, `.kotlin/`, and `.externalNativeBuild/`, while still hashing
repository-owned native sources. The manifest also binds normalized toolchain versions,
effective public build configuration, Git `HEAD`, tree and dirty identity, and a private
HMAC of non-public local inputs. Inputs are recomputed after Gradle; any change during the
build invalidates and removes the transaction outputs.

## Artifacts and native-library contract

The production bundle and its manifest are written to:

```text
android/app/build/outputs/bundle/release/app-release.aab
artifacts/android-release/build-provenance-release-universal.json
```

The provenance JSON includes the artifact-relative path, size, SHA-256, build digest,
normalized toolchain identity, Git identity, and verified packaged ABIs. It does not contain
signing passwords, prompt content, model paths, or raw local paths.

Universal Android artifacts must contain exactly:

- `arm64-v8a`
- `x86_64`

For each ABI, both APK and AAB verification requires:

- `libreactnative.so`
- `librnllama.so`
- `librnllama_jni.so`

A missing library, unexpected ABI, missing artifact, or provenance mismatch fails the build
transaction. A failed transaction does not leave an apparently valid artifact/provenance
pair and does not reserve the next upload code.

## Current-head release APK QA

The branch-regeneration pack is the strongest current-head Android check:

```bash
npm run android:scenarios:branch-regeneration -- --serial <device-serial> --fail-on-skip
```

Use `--emulator` instead of `--serial` for an emulator. Do not add `--skip-build` or
`--preserve-running-app`: this pack requires a current-input, provenance-verified release
APK whose JavaScript bundle is embedded in the APK.

The runner creates separate build and install records, then binds the scenario report to:

- the exact Git `HEAD`, tree and dirty digest;
- the recomputed build-input digest;
- release variant and packaged ABI set;
- APK size and SHA-256;
- selected device serial, package identity, version metadata, and installed APK fingerprint;
- the ABI selected for the device from the ABIs actually packaged.

The chain is validated before the first destructive step and again after the pack. A stale,
tampered, cross-device, cross-package, cross-variant, or incomplete record fails rather than
silently reusing the install.

For this pack, QA-only accessibility and generation-control markers are enabled in the
verified release-QA build. The Android release guard rejects those markers in a shipping
build, and the production build records `androidQaEvidence: false`.

See the [Release Checklist](./release-checklist.md#destructive-branch-regeneration-pack) for
the required fixture and the exact 15 ordered steps.

## QA evidence and privacy

Android scenario evidence is written beneath:

```text
artifacts/android-scenarios/latest-report.json
artifacts/android-scenarios/build-provenance-latest.json
artifacts/android-scenarios/branch-regeneration/
```

Each destructive step captures screenshots, raw UI hierarchy XML, and app/system-scoped log
evidence. The screenshots and XML preserve visible fixture text and are not sanitized; use
only synthetic, non-sensitive messages, model labels, and attachment names, then inspect
those artifacts manually before sharing them. Log collectors are owned by the runner and
filter the app stream by the exact app UID; the system stream accepts only the package's
ActivityManager ANR surface. Raw collector files stay in task-private cache storage and are
removed after use. Published logs and JSON reports are recursively bounded and sanitized
for credentials, prompt-like assignments, local paths, and unsupported external artifact
paths before fatal-pattern checks and report publication.

## Troubleshooting

If the Android SDK cannot be found, set `ANDROID_HOME`/`ANDROID_SDK_ROOT` or add
`sdk.dir=...` to `android/local.properties`. If provenance reports stale inputs, retry the
repository command without manually editing its stamp files; the command will perform a
clean prebuild when required. If a device install fails for insufficient storage, free
space or uninstall the existing package and rerun so build/install provenance can be
re-established.
