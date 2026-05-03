# Android Release Build

This guide covers building a signed Android App Bundle for Google Play.

For general development setup, see the main [README](../README.md).

## Prerequisites

If the `android/` project is missing, generate it once first:

```bash
npx expo prebuild --platform android
```

Pocket AI relies on native modules and Expo config plugins (for example: `llama.rn`, background actions, and native system-metrics diagnostics). If you change any plugin configuration in `app.json`, re-run prebuild.

The Android system-metrics plugin currently supports Kotlin `MainApplication` files only. Projects that switch the generated Android entry point to Java need to adapt the plugin registration step before prebuild can inject the `SystemMetrics` package.

If Gradle fails with "SDK location not found", make sure the Android SDK is installed and either:

- set `ANDROID_HOME` / `ANDROID_SDK_ROOT`, or
- create `android/local.properties` with `sdk.dir=...` (for example `sdk.dir=C:/Users/<you>/AppData/Local/Android/Sdk` on Windows)

## Upload signing

Create a local upload-signing config for Google Play in `keystore.properties` at the app root, or provide the same values with environment variables:

```text
storeFile=keystores/pocket-ai-upload.jks
storePassword=your-store-password
keyAlias=pocketai
keyPassword=your-key-password
```

The `storeFile` path is resolved from the project root. For example, `keystores/pocket-ai-upload.jks` points to `./keystores/pocket-ai-upload.jks`.

## Build the bundle

```bash
npm run build:android:production
```

The build script uses:

- `expo.version` from `app.json` as the Android `versionName`
- `expo.android.versionCode` from `app.json` as the next Play upload code

After a successful production build, the script automatically reserves the next `expo.android.versionCode` in `app.json` so the following upload gets a fresh Play version code without EAS.

Override the values only if you need to recover from a failed or custom release flow:

```bash
npm run build:android:production -- --version-code 2 --version-name 1.0.1
```

The generated Android App Bundle is written to `android/app/build/outputs/bundle/release/app-release.aab`.
