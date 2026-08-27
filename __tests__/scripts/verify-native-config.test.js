const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { run } = require('../../scripts/verify-native-config');

function createProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-ai-native-config-'));
  fs.mkdirSync(path.join(root, 'ios', 'pocketai'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ios', 'PocketAI.xcodeproj'), { recursive: true });
  fs.mkdirSync(path.join(root, 'android', 'app', 'src', 'main'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app.json'), JSON.stringify({
    expo: {
      ios: { infoPlist: {} },
      plugins: [['expo-build-properties', { android: { buildArchs: ['arm64-v8a', 'x86_64'] } }]],
    },
  }));
  fs.writeFileSync(path.join(root, 'eas.json'), JSON.stringify({
    cli: { appVersionSource: 'remote' },
    build: { production: { autoIncrement: true } },
  }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true }));
  fs.writeFileSync(path.join(root, 'ios', 'pocketai', 'Info.plist'), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist><dict>',
    '<key>CFBundleIdentifier</key><string>com.github.tah10n.pocketai</string>',
    '<key>CFBundleVersion</key><string>1</string>',
    '</dict></plist>',
  ].join(''));
  fs.writeFileSync(
    path.join(root, 'ios', 'pocketai', 'pocketai.entitlements'),
    [
      '<?xml version="1.0"?><plist><dict>',
      '<key>com.apple.developer.kernel.extended-virtual-addressing</key><true/>',
      '<key>com.apple.developer.kernel.increased-memory-limit</key><true/>',
      '</dict></plist>',
    ].join(''),
  );
  fs.writeFileSync(
    path.join(root, 'ios', 'PocketAI.xcodeproj', 'project.pbxproj'),
    [
      'path = "en.lproj/InfoPlist.strings";',
      'path = "ru.lproj/InfoPlist.strings";',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), [
    '<manifest>',
    '<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />',
    '<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />',
    '<application>',
    '<service android:name="com.asterinet.react.bgactions.RNBackgroundActionsTask" android:foregroundServiceType="dataSync" />',
    '</application>',
    '</manifest>',
  ].join(''));
  return root;
}

describe('native configuration contract', () => {
  it('accepts the generated iOS and Android release contract', () => {
    const root = createProject();
    try {
      expect(() => run(['--require-ios', '--require-android'], root)).not.toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects unsupported iOS processing and a permission-gated Android service contract', () => {
    const root = createProject();
    try {
      const appConfigPath = path.join(root, 'app.json');
      fs.writeFileSync(appConfigPath, JSON.stringify({
        expo: { ios: { infoPlist: { UIBackgroundModes: ['processing'] } } },
      }));
      expect(() => run([], root)).toThrow(/BGTaskScheduler/);

      fs.writeFileSync(appConfigPath, JSON.stringify({ expo: { ios: { infoPlist: {} } } }));
      fs.writeFileSync(
        path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
        '<manifest><application /></manifest>',
      );
      expect(() => run(['--require-android'], root)).toThrow(/FOREGROUND_SERVICE/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an iOS release project when llama.rn memory entitlements were not generated', () => {
    const root = createProject();
    try {
      fs.writeFileSync(
        path.join(root, 'ios', 'pocketai', 'pocketai.entitlements'),
        '<?xml version="1.0"?><plist><dict></dict></plist>',
      );

      expect(() => run(['--require-ios'], root)).toThrow(/extended-virtual-addressing/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects collapsed localized InfoPlist.strings Xcode paths', () => {
    const root = createProject();
    try {
      fs.writeFileSync(
        path.join(root, 'ios', 'PocketAI.xcodeproj', 'project.pbxproj'),
        'path = InfoPlist.strings;',
      );

      expect(() => run(['--require-ios'], root)).toThrow(/missing en\.lproj\/InfoPlist\.strings/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an empty app-level codegen source directory that creates an iOS build cycle', () => {
    const root = createProject();
    try {
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
        private: true,
        codegenConfig: {
          name: 'RNAppSpec',
          type: 'all',
          jsSrcsDir: 'src',
        },
      }));
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src', 'ordinary.ts'), 'export const value = 1;');
      expect(() => run([], root)).toThrow(/must not declare an empty jsSrcsDir/);

      fs.writeFileSync(path.join(root, 'src', 'NativePocketAI.ts'), 'export default {};');
      expect(() => run([], root)).not.toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
