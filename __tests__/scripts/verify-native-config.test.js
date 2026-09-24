const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { run } = require('../../scripts/verify-native-config');
const { copyLlamaPatchSources } = require('../fixtures/llama-native-patch');

const { PODFILE_PREFIX, HEXAGON_GUARD } = require('../../plugins/withLlamaSourceBuild')._internal;

const llamaVersion = '0.13.0-rc.3';
const llamaDependencies = { 'llama.rn': llamaVersion };

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function createLlamaArtifacts(root) {
  writeJson(path.join(root, 'package-lock.json'), {
    packages: {
      '': { dependencies: llamaDependencies },
      'node_modules/llama.rn': { version: llamaVersion },
    },
  });
  const llamaRoot = path.join(root, 'node_modules', 'llama.rn');
  writeJson(path.join(llamaRoot, 'package.json'), { version: llamaVersion });
  copyLlamaPatchSources(root);
  const artifacts = [
    { name: 'android-jni-libs', relativePath: 'android/src/main/jniLibs', sha256: 'a'.repeat(64) },
    { name: 'ios-xcframework', relativePath: 'ios/rnllama.xcframework', sha256: 'b'.repeat(64) },
  ].map((artifact) => ({ ...artifact, markerPath: `${artifact.relativePath}/.llama-rn.sha256` }));
  writeJson(path.join(llamaRoot, 'install/native-artifacts.json'), { artifacts });
  for (const artifact of artifacts) {
    const marker = path.join(llamaRoot, artifact.markerPath);
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, `${artifact.sha256}\n`);
  }
  for (const relativePath of [
    'android/src/main/jniLibs/arm64-v8a/librnllama.so',
    'android/src/main/jniLibs/x86_64/librnllama.so',
    'ios/rnllama.xcframework/Info.plist',
    'ios/rnllama.xcframework/ios-arm64/rnllama.framework/rnllama',
    'ios/rnllama.xcframework/ios-arm64_x86_64-simulator/rnllama.framework/rnllama',
  ]) {
    const file = path.join(llamaRoot, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'fixture payload');
  }
}

function createProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-ai-native-config-'));
  fs.mkdirSync(path.join(root, 'ios', 'pocketai'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ios', 'PocketAI'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ios', 'PocketAI.xcodeproj'), { recursive: true });
  fs.mkdirSync(path.join(root, 'android', 'app', 'src', 'main'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'android', 'gradle.properties'),
    'org.gradle.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=1024m\nrnllamaBuildFromSource=true\n',
  );
  fs.writeFileSync(path.join(root, 'android', 'build.gradle'), HEXAGON_GUARD);
  fs.writeFileSync(path.join(root, 'ios', 'Podfile'), PODFILE_PREFIX + "require 'expo/scripts/autolinking'\n");
  fs.writeFileSync(path.join(root, 'app.json'), JSON.stringify({
    expo: {
      updates: { enabled: false },
      ios: { infoPlist: {} },
      plugins: ['./plugins/withLlamaSourceBuild', ['expo-build-properties', { android: { buildArchs: ['arm64-v8a', 'x86_64'] } }]],
    },
  }));
  fs.writeFileSync(path.join(root, 'eas.json'), JSON.stringify({
    cli: { appVersionSource: 'remote' },
    build: { production: { autoIncrement: true } },
  }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true, dependencies: llamaDependencies }));
  createLlamaArtifacts(root);
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
  fs.writeFileSync(
    path.join(root, 'ios', 'PocketAI', 'AppDelegate.swift'),
    [
      'import Foundation',
      'private func excludePocketAiModelDirectoryFromBackup() {}',
      '@main',
      'public class AppDelegate: ExpoAppDelegate {}',
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
  it('rejects an unpatched installed wrapper even when vendor artifact receipts match', () => {
    const root = createProject();
    try {
      copyLlamaPatchSources(root, { pristine: true });
      expect(() => run([], root)).toThrow(/bridge patch is missing/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

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

      fs.writeFileSync(appConfigPath, JSON.stringify({ expo: { updates: { enabled: false }, ios: { infoPlist: {} }, plugins: ['./plugins/withLlamaSourceBuild'] } }));
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

  it('rejects the generated Android project when native Release metaspace is undersized', () => {
    const root = createProject();
    try {
      fs.writeFileSync(
        path.join(root, 'android', 'gradle.properties'),
        'org.gradle.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=512m\nrnllamaBuildFromSource=true\n',
      );

      expect(() => run(['--require-android'], root)).toThrow(/reserve 1024 MiB of Metaspace/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['', 'rnllamaBuildFromSource=false\n', 'rnllamaBuildFromSource=true\nrnllamaBuildFromSource=false\n'])('rejects an uncorrected Android core configuration: %j', flag => {
    const root = createProject();
    try {
      fs.writeFileSync(path.join(root, 'android', 'gradle.properties'),
        'org.gradle.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=1024m\n' + flag);
      expect(() => run(['--require-android'], root)).toThrow(/corrected llama.rn core from source/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['', PODFILE_PREFIX + "ENV['RNLLAMA_BUILD_FROM_SOURCE'] = '0'\n"])('rejects an uncorrected iOS core configuration: %j', podfile => {
    const root = createProject();
    try {
      fs.writeFileSync(path.join(root, 'ios', 'Podfile'), podfile);
      expect(() => run(['--require-ios'], root)).toThrow(/core from source|Conflicting/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects source configuration without the corrected core build plugin', () => {
    const root = createProject();
    try {
      const file = path.join(root, 'app.json');
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      config.expo.plugins = [];
      writeJson(file, config);
      expect(() => run([], root)).toThrow(/source-build Expo plugin/);
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

  it('rejects a backup exclusion helper scoped inside a trailing generated delegate class', () => {
    const root = createProject();
    try {
      fs.writeFileSync(
        path.join(root, 'ios', 'PocketAI', 'AppDelegate.swift'),
        [
          'import Foundation',
          '@main',
          'public class AppDelegate: ExpoAppDelegate {',
          '  func application() { excludePocketAiModelDirectoryFromBackup() }',
          '}',
          'class ReactNativeDelegate {',
          '  private func excludePocketAiModelDirectoryFromBackup() {}',
          '}',
        ].join('\n'),
      );

      expect(() => run(['--require-ios'], root)).toThrow(/file scope before AppDelegate/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an empty app-level codegen source directory that creates an iOS build cycle', () => {
    const root = createProject();
    try {
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
        private: true,
        dependencies: llamaDependencies,
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

  it.each([undefined, true])('rejects updates.enabled=%s to prevent JS-only runtime upgrades', (enabled) => {
    const root = createProject();
    try {
      writeJson(path.join(root, 'app.json'), { expo: { updates: { enabled } } });
      expect(() => run([], root)).toThrow(/new native binary/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['manifest', 'lock-root', 'lock-package', 'installed'])('rejects mismatched llama.rn %s identity', (target) => {
    const root = createProject();
    try {
      if (target === 'manifest') {
        writeJson(path.join(root, 'package.json'), { dependencies: { 'llama.rn': `^${llamaVersion}` } });
      } else if (target === 'installed') {
        writeJson(path.join(root, 'node_modules/llama.rn/package.json'), { version: '0.12.9' });
      } else {
        const file = path.join(root, 'package-lock.json');
        const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (target === 'lock-root') lock.packages[''].dependencies['llama.rn'] = '0.12.9';
        else lock.packages['node_modules/llama.rn'].version = '0.12.9';
        writeJson(file, lock);
      }
      expect(() => run([], root)).toThrow(/match one exact version/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['android/src/main/jniLibs', 'ios/rnllama.xcframework'])('rejects stale %s download receipts', (directory) => {
    const root = createProject();
    try {
      fs.writeFileSync(path.join(root, 'node_modules/llama.rn', directory, '.llama-rn.sha256'), 'c'.repeat(64));
      expect(() => run([], root)).toThrow(/Stale llama.rn.*receipt/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    'android/src/main/jniLibs/x86_64/librnllama.so',
    'ios/rnllama.xcframework/ios-arm64/rnllama.framework/rnllama',
  ])('rejects missing native payload despite a matching receipt: %s', (payload) => {
    const root = createProject();
    try {
      fs.unlinkSync(path.join(root, 'node_modules/llama.rn', payload));
      expect(() => run([], root)).toThrow(/Missing llama.rn.*payload/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an unconfigured upstream artifact manifest', () => {
    const root = createProject();
    try {
      writeJson(path.join(root, 'node_modules/llama.rn/install/native-artifacts.json'), { artifacts: [] });
      expect(() => run([], root)).toThrow(/Invalid llama.rn native artifact manifest/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
