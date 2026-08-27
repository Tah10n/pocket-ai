const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { run } = require('../../scripts/verify-native-config');

function createProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-ai-native-config-'));
  fs.mkdirSync(path.join(root, 'ios', 'pocketai'), { recursive: true });
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
  fs.writeFileSync(path.join(root, 'ios', 'pocketai', 'Info.plist'), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist><dict>',
    '<key>CFBundleIdentifier</key><string>com.github.tah10n.pocketai</string>',
    '<key>CFBundleVersion</key><string>1</string>',
    '</dict></plist>',
  ].join(''));
  fs.writeFileSync(path.join(root, 'ios', 'Podfile.properties.json'), JSON.stringify({
    'expo.jsEngine': 'hermes',
  }));
  fs.writeFileSync(
    path.join(root, 'ios', 'pocketai', 'pocketai.entitlements'),
    [
      '<?xml version="1.0"?><plist><dict>',
      '<key>com.apple.developer.kernel.extended-virtual-addressing</key><true/>',
      '<key>com.apple.developer.kernel.increased-memory-limit</key><true/>',
      '</dict></plist>',
    ].join(''),
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

  it('rejects global iOS framework linkage in source and generated config', () => {
    const root = createProject();
    try {
      fs.writeFileSync(path.join(root, 'app.json'), JSON.stringify({
        expo: {
          ios: { infoPlist: {} },
          plugins: [['expo-build-properties', { ios: { useFrameworks: 'static' } }]],
        },
      }));
      expect(() => run([], root)).toThrow(/dependency cycle/);

      fs.writeFileSync(path.join(root, 'app.json'), JSON.stringify({ expo: { ios: { infoPlist: {} } } }));
      fs.writeFileSync(path.join(root, 'ios', 'Podfile.properties.json'), JSON.stringify({
        'ios.useFrameworks': 'static',
      }));
      expect(() => run(['--require-ios'], root)).toThrow(/global use_frameworks/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
