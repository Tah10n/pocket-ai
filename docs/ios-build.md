# iOS Release Build

This guide covers building and distributing Pocket AI for iOS via Xcode.

For general development setup, see the main [README](../README.md).

## Prerequisites

- macOS with Xcode 26 or newer installed (Expo SDK 55 requires Xcode 26)
- An [Apple Developer](https://developer.apple.com/) account enrolled in the Apple Developer Program
- CocoaPods (`sudo gem install cocoapods` or via Homebrew)
- Rust through `rustup`; the repository pins Rust 1.97.1 and the device, Apple Silicon
  simulator, and Intel simulator targets used by the local document module

Build the deterministic static XCFramework before CocoaPods evaluates the local pod:

```bash
npm run anydoc:setup -- --platform=ios
npm run anydoc:verify
npm run anydoc:build:ios
```

The output contains separate device and universal simulator slices. Its fingerprint covers
the lockfile, vendored parser sources, C ABI, exact Rust/Xcode versions, deployment target,
and output hashes. Do not commit `ios/generated/` or add the library manually to Xcode.
EAS invokes the same setup and build through `eas-build-pre-install`, before `pod install`.

## Generate the native project

After the XCFramework exists, generate the native project from tracked Expo inputs:

```bash
NODE_ENV=production EAS_BUILD_PROFILE=production npx expo prebuild --clean --platform ios --no-install
```

Then install CocoaPods dependencies:

```bash
cd ios && pod install && cd ..
```

Re-run `pod install` after adding or upgrading any native dependency.

## Development build

Start Metro and run on a connected device or simulator:

```bash
npm start
npm run ios
```

To target a specific simulator:

```bash
npm run ios -- --simulator="iPhone 16"
```

## Signing configuration

Xcode manages signing through the project settings:

1. Open `ios/pocketai.xcworkspace` in Xcode.
2. Select the **pocketai** target.
3. In **Signing & Capabilities**, choose your team and let Xcode manage provisioning automatically, or configure manual profiles if your organization requires it.

The bundle identifier is `com.github.tah10n.pocketai` (set in `app.json`).

## Store build via EAS

Production App Store uploads must come from the remote-versioned EAS production profile:

```bash
npm run build:ios:eas:production
```

Use `npm run build:all:eas:production` when preparing Android and iOS together. The EAS
build reserves the next remote `CFBundleVersion`; a local archive does not.

## Local archive for QA

The following Xcode paths are useful for local signing, archive, and export diagnostics.
Their artifacts must not be uploaded while `eas.json` uses the remote app version source.

### Via Xcode

1. Select **Product > Scheme > PocketAI** and set the destination to **Any iOS Device (arm64)**.
2. Run **Product > Archive**.
3. When the archive completes, the Organizer window opens. Select the archive and click **Distribute App**.
4. Choose **Ad Hoc** / **Development** for direct QA installs, or export locally for archive inspection.
5. Follow the signing and upload prompts.

### Via command line

Build the archive:

```bash
xcodebuild -workspace ios/pocketai.xcworkspace \
  -scheme PocketAI \
  -configuration Release \
  -archivePath build/pocketai.xcarchive \
  archive
```

Export an IPA for App Store upload:

```bash
xcodebuild -exportArchive \
  -archivePath build/pocketai.xcarchive \
  -exportOptionsPlist ios/ExportOptions.plist \
  -exportPath build/
```

Create `ios/ExportOptions.plist` with your distribution settings if it does not exist. A minimal App Store example:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store</string>
  <key>teamID</key>
  <string>YOUR_TEAM_ID</string>
</dict>
</plist>
```

## Versioning

- `expo.version` in `app.json` is used as the iOS `CFBundleShortVersionString` (user-visible version).
- EAS production builds use the remote version source and `autoIncrement: true`; EAS is the source of truth for both iOS `CFBundleVersion` and Android `versionCode` store builds.
- Before the first production build after this migration, run `eas build:version:set` once for each platform and initialize it from the latest build already accepted by App Store Connect and Google Play. Do not guess these values from source control.
- `eas build:version:sync` only copies the current remote value into local config for diagnostics. It does not reserve a new build number and does not make a local archive store-upload eligible.
- App Store Connect rejects duplicate build numbers for the same version.

## Native plugins

Expo config plugins inject app-owned Objective-C native modules into the Xcode project during prebuild:

- `withIosSystemMetrics` adds `SystemMetrics.m` for real-time device memory snapshots used by the RAM-fit subsystem.

These modules are added automatically — no manual Xcode configuration is needed after running `npx expo prebuild --platform ios`.

## Troubleshooting

- **Pod install fails**: Delete `ios/Pods` and `ios/Podfile.lock`, then re-run `pod install`.
- **Signing errors**: Verify your Apple Developer team is selected in Xcode and provisioning profiles are up to date.
- **New Architecture issues**: See [New Architecture Notes](new-architecture.md) for known native-module caveats.
- **Rebuild from scratch**: Delete the entire `ios/` directory and re-run `npx expo prebuild --platform ios && cd ios && pod install`.
