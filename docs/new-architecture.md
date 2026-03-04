# React Native New Architecture

This document outlines the setup, build process, and module-specific notes for running the Pocket AI application with React Native's New Architecture (Fabric and TurboModules).

## Architecture Overview

The application is now running on the New Architecture, which provides:
- Synchronous layout rendering (Fabric)
- Lazy native module initialization (TurboModules)
- Better performance and interoperability with Native code

## Build Process & Environment Setup

To ensure stable builds with the New Architecture, follow these guidelines:

### Android
The New Architecture is enabled via `newArchEnabled=true` in `android/gradle.properties`.

To clean the build environment and rebuild:
```bash
cd android
./gradlew clean
cd ..
npm run android
```

### iOS
The New Architecture is enabled via the `RCT_NEW_ARCH_ENABLED=1` flag during Pod installation.

To clean the build environment and rebuild:
```bash
cd ios
rm -rf Pods
rm -rf build
pod install
cd ..
npm run ios
```

## Native Modules Attention

Several foundational native modules require specific attention when running with the New Architecture:

### 1. `react-native-mmkv`
- **Version**: `4.x+`
- **Notes**: MMKV v4 is a significant rewrite utilizing `react-native-nitro-modules` for ultra-fast C++ based synchronous access.
- **Migration Note**: `new MMKV()` is highly discouraged or removed. Always use the provided `createMMKV({ id: ... })` factory method for instantiation. Check `storage.ts` for the updated implementation.

### 2. `react-native-nitro-modules`
- **Notes**: This is a supporting framework required by the new MMKV and potentially other high-performance native modules. Ensure its version stays aligned with React Native and MMKV requirements.

### 3. `llama.rn` (LLM Engine)
- **Notes**: This custom native integration provides local LLM inference. It relies heavily on JSI and native threads. If memory crashes or JSI errors occur during context generation or model loading, verify that the module's C++ bindings are fully compatible with the active React Native version's TurboModule interop layer.

### 4. `react-native-reanimated` & `react-native-screens`
- **Notes**: Both libraries have deep integration with Fabric. Always keep them updated. React Navigation depends heavily on `react-native-screens` performing synchronous layout under the New Architecture.

## Troubleshooting

- **Build Failures After Branch Switching**: If you switch from an old architecture branch to a new one, aggressively clean node_modules and native caches.
- **"Module not found" in Native**: If a library claims a TurboModule is missing, ensure it has been linked properly, and for iOS, ensure `RCT_NEW_ARCH_ENABLED=1` was present during `pod install`.
