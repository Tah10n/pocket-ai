# iOS Release Build

This guide covers building and distributing Pocket AI for iOS via Xcode.

For general development setup, see the main [README](../README.md).

## Prerequisites

- macOS with Xcode installed (latest stable recommended)
- An [Apple Developer](https://developer.apple.com/) account enrolled in the Apple Developer Program
- CocoaPods (`sudo gem install cocoapods` or via Homebrew)

## Generate the native project

If the `ios/` directory is missing, generate it once:

```bash
npx expo prebuild --platform ios
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

## Archive and distribute

### Via Xcode

1. Select **Product > Scheme > pocketai** and set the destination to **Any iOS Device (arm64)**.
2. Run **Product > Archive**.
3. When the archive completes, the Organizer window opens. Select the archive and click **Distribute App**.
4. Choose **App Store Connect** for TestFlight / App Store, or **Ad Hoc** / **Development** for direct installs.
5. Follow the signing and upload prompts.

### Via command line

Build the archive:

```bash
xcodebuild -workspace ios/pocketai.xcworkspace \
  -scheme pocketai \
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

### Upload to App Store Connect

After exporting, upload the IPA with:

```bash
xcrun altool --upload-app -f build/pocketai.ipa -t ios -u "you@example.com" -p "@keychain:AC_PASSWORD"
```

Or use **Transporter** (available on the Mac App Store) for a graphical upload flow.

## Versioning

- `expo.version` in `app.json` is used as the iOS `CFBundleShortVersionString` (user-visible version).
- iOS does not use `expo.android.versionCode`. The `CFBundleVersion` (build number) is managed by Xcode or can be set in `ios/pocketai/Info.plist`.
- Bump the build number before each TestFlight or App Store upload — App Store Connect rejects duplicate build numbers for the same version.

## Native plugins

The Expo config plugin `withIosSystemMetrics` injects a native Objective-C module (`SystemMetrics.m`) into the Xcode project during prebuild. This module provides real-time device memory snapshots used by the RAM-fit subsystem. It is added automatically — no manual Xcode configuration is needed.

## Troubleshooting

- **Pod install fails**: Delete `ios/Pods` and `ios/Podfile.lock`, then re-run `pod install`.
- **Signing errors**: Verify your Apple Developer team is selected in Xcode and provisioning profiles are up to date.
- **New Architecture issues**: See [New Architecture Notes](new-architecture.md) for known native-module caveats.
- **Rebuild from scratch**: Delete the entire `ios/` directory and re-run `npx expo prebuild --platform ios && cd ios && pod install`.
