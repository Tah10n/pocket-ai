const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createAutolinkingOptionsLoader } = require('expo-modules-autolinking/build/commands/autolinkingOptions');

const { run, assertExpoAudioNativePatch, assertSourceConfig, inspectComposedAudioPermissions,
  assertComposedAudioPermissions } = require('../../scripts/verify-native-config');
const { copyLlamaPatchSources } = require('../fixtures/llama-native-patch');
const { patches: audioPatches, VERSION: audioVersion } = require('../../patches/expo-audio-55.0.18');

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
    '<key>NSMicrophoneUsageDescription</key><string>Record only after tapping Record.</string>',
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
    '<uses-permission android:name="android.permission.RECORD_AUDIO" />',
    '<application>',
    '<service android:name="com.asterinet.react.bgactions.RNBackgroundActionsTask" android:foregroundServiceType="dataSync" />',
    '</application>',
    '</manifest>',
  ].join(''));
  return root;
}

function addGuardedAudio(root) {
  const packageFile = path.join(root, 'package.json');
  const packageConfig = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  packageConfig.dependencies['expo-audio'] = audioVersion;
  packageConfig.dependencies['expo-asset'] = '55.0.20';
  packageConfig.expo = { autolinking: { buildFromSource: ['expo-audio'] } };
  writeJson(packageFile, packageConfig);
  const configFile = path.join(root, 'app.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  config.expo.plugins.push(['expo-audio', { microphonePermission: 'Record only after tapping Record.', recordAudioAndroid: true,
    enableBackgroundRecording: false, enableBackgroundPlayback: false }]);
  writeJson(configFile, config);
  const lockFile = path.join(root, 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  lock.packages[''].dependencies['expo-audio'] = audioVersion;
  lock.packages['node_modules/expo-audio'] = { version: audioVersion };
  lock.packages[''].dependencies['expo-asset'] = '55.0.20';
  lock.packages['node_modules/expo-asset'] = { version: '55.0.20' };
  writeJson(path.join(root, 'node_modules/expo-asset/package.json'), { name: 'expo-asset', version: '55.0.20' });
  writeJson(lockFile, lock);
  const packageRoot = path.join(root, 'node_modules/expo-audio');
  writeJson(path.join(packageRoot, 'package.json'), { version: audioVersion });
  for (const patch of audioPatches) {
    const source = fs.readFileSync(path.resolve(__dirname, '../../node_modules/expo-audio', patch.file), 'utf8');
    const hash = crypto.createHash('sha256').update(source.replace(/\r\n/gu, '\n')).digest('hex');
    if (hash !== patch.after) throw new Error(`Unknown installed audio fixture: ${patch.file}`);
    const target = path.join(packageRoot, patch.file);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, source);
  }
  return packageRoot;
}

describe('native configuration contract', () => {
  const currentExpoConfig = () => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../app.json'), 'utf8')).expo;
  const recordingUsage = config => config.plugins.find(entry => Array.isArray(entry) && entry[0] === 'expo-audio')[1].microphonePermission;
  const imagePickerOptions = config => config.plugins.find(entry => Array.isArray(entry) && entry[0] === 'expo-image-picker')[1];

  it('composes the actual configured installed plugins into Android and iOS explicit recording permissions without native writes', async () => {
    const config = currentExpoConfig();
    const nativeFiles = ['android/app/src/main/AndroidManifest.xml', 'app.json'].map(file => path.resolve(__dirname, '../..', file));
    const before = nativeFiles.map(file => fs.existsSync(file) ? fs.readFileSync(file) : null);
    const result = await assertComposedAudioPermissions(config);
    const permissions = result.androidManifest.manifest['uses-permission'];
    expect(permissions.filter(permission => permission.$['android:name'] === 'android.permission.RECORD_AUDIO'))
      .toEqual([{ $: { 'android:name': 'android.permission.RECORD_AUDIO' } }]);
    expect(result.iosInfoPlist.NSMicrophoneUsageDescription).toBe(recordingUsage(config));
    expect(result.iosInfoPlist.NSCameraUsageDescription).toBeUndefined();
    expect(permissions.find(permission => permission.$['android:name'] === 'android.permission.CAMERA').$['tools:node']).toBe('remove');
    expect(nativeFiles.map(file => fs.existsSync(file) ? fs.readFileSync(file) : null)).toEqual(before);
  });

  it('reproduces the real image-picker false override blocking RECORD_AUDIO despite expo-audio and declared permission', async () => {
    const config = currentExpoConfig();
    imagePickerOptions(config).microphonePermission = false;
    expect(config.android.permissions).toContain('RECORD_AUDIO');
    const result = await inspectComposedAudioPermissions(config);
    expect(result.androidManifest.manifest['uses-permission'].find(permission => permission.$['android:name'] === 'android.permission.RECORD_AUDIO'))
      .toEqual({ $: { 'android:name': 'android.permission.RECORD_AUDIO', 'tools:node': 'remove' } });
    await expect(assertComposedAudioPermissions(config)).rejects.toThrow(/Composed Expo permission mods/);
  });

  it.each([false, true])('preserves both permission outputs with matching strings independent of image-picker/audio registration order (reversed=%s)', async reverse => {
    const config = currentExpoConfig();
    imagePickerOptions(config).microphonePermission = recordingUsage(config);
    if (reverse) {
      const audio = config.plugins.findIndex(entry => Array.isArray(entry) && entry[0] === 'expo-audio');
      const picker = config.plugins.findIndex(entry => Array.isArray(entry) && entry[0] === 'expo-image-picker');
      [config.plugins[audio], config.plugins[picker]] = [config.plugins[picker], config.plugins[audio]];
    }
    await expect(assertComposedAudioPermissions(config)).resolves.toEqual(expect.objectContaining({
      iosInfoPlist: expect.objectContaining({ NSMicrophoneUsageDescription: recordingUsage(config) }),
    }));
  });

  it('also reproduces iOS key deletion when the false image-picker mod runs after the audio mod', async () => {
    const config = currentExpoConfig();
    imagePickerOptions(config).microphonePermission = false;
    const audio = config.plugins.findIndex(entry => Array.isArray(entry) && entry[0] === 'expo-audio');
    const picker = config.plugins.findIndex(entry => Array.isArray(entry) && entry[0] === 'expo-image-picker');
    [config.plugins[audio], config.plugins[picker]] = [config.plugins[picker], config.plugins[audio]];
    const result = await inspectComposedAudioPermissions(config);
    expect(result.iosInfoPlist.NSMicrophoneUsageDescription).toBeUndefined();
  });

  it('rejects conflicting image-picker microphone options during source preflight before prebuild', () => {
    const root = createProject();
    try {
      addGuardedAudio(root);
      const file = path.join(root, 'app.json');
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      config.expo.plugins.push(['expo-image-picker', { microphonePermission: false, cameraPermission: false }]);
      writeJson(file, config);
      expect(() => assertSourceConfig(root)).toThrow(/image-picker.*false blocks recording globally/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['RECORD_AUDIO', 'android.permission.RECORD_AUDIO'])('rejects explicit Android source blocker %s', permission => {
    const root = createProject();
    try {
      addGuardedAudio(root);
      const file = path.join(root, 'app.json');
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      config.expo.android = { blockedPermissions: [permission] };
      writeJson(file, config);
      expect(() => assertSourceConfig(root)).toThrow(/recording cannot be blocked/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    ['global source list', { buildFromSource: ['expo-audio', 'expo-file-system'] }],
    ['platform source lists', { android: { buildFromSource: ['expo-audio', 'expo-file-system'] },
      ios: { buildFromSource: ['expo-audio'] } }],
    ['Apple object takes precedence over ios', { buildFromSource: ['expo-audio'],
      android: { exclude: ['expo-camera'] }, apple: { exclude: ['expo-camera'] }, ios: { buildFromSource: [] } }],
  ])('accepts %s using the installed SDK resolver and preserves other source configuration', async (_label, autolinking) => {
    const root = createProject();
    try {
      addGuardedAudio(root);
      const file = path.join(root, 'package.json');
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      config.expo.autolinking = autolinking;
      writeJson(file, config);
      const before = fs.readFileSync(file, 'utf8');
      const loader = createAutolinkingOptionsLoader({ projectRoot: root });
      for (const platform of ['android', 'apple']) {
        const options = await loader.getPlatformOptions(platform);
        expect(options.buildFromSource).toContain('expo-audio');
        expect(options.exclude).not.toContain('expo-audio');
      }
      expect(() => run(['--require-ios', '--require-android'], root)).not.toThrow();
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
      expect(fs.readFileSync(path.join(root, 'android', 'gradle.properties'), 'utf8')).toContain('rnllamaBuildFromSource=true');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    ['missing admission', {}, 'android', undefined],
    ['misnested Android admission', { android: { autolinking: { buildFromSource: ['expo-audio'] } } }, 'android', undefined],
    ['Android override removes audio', { buildFromSource: ['expo-audio'], android: { buildFromSource: [] } }, 'android', []],
    ['Android string is ignored', { buildFromSource: ['expo-audio'], android: { buildFromSource: 'expo-audio' } }, 'android', undefined],
    ['broad regex only', { buildFromSource: ['expo-.*'] }, 'android', ['expo-.*']],
    ['wrong literal package', { buildFromSource: ['expo-audio-other'] }, 'android', ['expo-audio-other']],
    ['Apple override removes audio', { buildFromSource: ['expo-audio'], apple: { buildFromSource: ['expo-file-system'] } }, 'apple', ['expo-file-system']],
    ['ios fallback removes audio', { buildFromSource: ['expo-audio'], ios: { buildFromSource: [] } }, 'apple', []],
    ['Apple object prevents ios fallback', { apple: {}, ios: { buildFromSource: ['expo-audio'] }, android: { buildFromSource: ['expo-audio'] } }, 'apple', undefined],
    ['malformed source list', { buildFromSource: ['expo-audio', 123] }, 'android', ['expo-audio']],
  ])('rejects %s despite exact patched sources and version receipts', async (_label, autolinking, platform, resolved) => {
    const root = createProject();
    try {
      addGuardedAudio(root);
      const file = path.join(root, 'package.json');
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      config.expo.autolinking = autolinking;
      writeJson(file, config);
      const options = await createAutolinkingOptionsLoader({ projectRoot: root }).getPlatformOptions(platform);
      expect(options.buildFromSource).toEqual(resolved);
      expect(() => assertExpoAudioNativePatch(root)).toThrow(/expo-audio.*autolinked from source/);
      expect(() => run([], root)).toThrow(/expo-audio.*autolinked from source/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['android', 'apple', 'ios'])('rejects %s exclusion even when patched audio is admitted from source', async platform => {
    const root = createProject();
    try {
      addGuardedAudio(root);
      const file = path.join(root, 'package.json');
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      config.expo.autolinking[platform] = { exclude: ['expo-audio'] };
      writeJson(file, config);
      const effectivePlatform = platform === 'ios' ? 'apple' : platform;
      const options = await createAutolinkingOptionsLoader({ projectRoot: root }).getPlatformOptions(effectivePlatform);
      expect(options.buildFromSource).toContain('expo-audio');
      expect(options.exclude).toContain('expo-audio');
      expect(() => run([], root)).toThrow(/expo-audio.*autolinked from source/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('still rejects prebuilt llama core with correctly source-admitted patched audio', () => {
    const root = createProject();
    try {
      addGuardedAudio(root);
      fs.writeFileSync(path.join(root, 'android', 'gradle.properties'),
        'org.gradle.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=1024m\nrnllamaBuildFromSource=false\n');
      expect(() => run(['--require-android'], root)).toThrow(/corrected llama.rn core from source/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('verifies guarded audio types and both native implementations without mutating any installed source', () => {
    const root = createProject();
    try {
      const audioRoot = addGuardedAudio(root);
      const files = audioPatches.map(patch => path.join(audioRoot, patch.file));
      const before = files.map(file => fs.readFileSync(file, 'utf8'));
      expect(() => run(['--require-ios', '--require-android'], root)).not.toThrow();
      expect(files.map(file => fs.readFileSync(file, 'utf8'))).toEqual(before);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    ['manifest', '57.0.18'], ['manifest', '^55.0.20'], ['manifest', undefined],
    ['lock-root', '57.0.18'], ['lock-root', undefined],
    ['lock-package', '57.0.18'], ['lock-package', undefined],
    ['installed', '57.0.18'], ['installed', undefined],
  ])('rejects incompatible or missing %s expo-asset %s despite a compatible nested Expo package', (identity, version) => {
    const root = createProject();
    try {
      const audioRoot = addGuardedAudio(root);
      const assetFile = path.join(root, 'node_modules/expo-asset/package.json');
      writeJson(path.join(root, 'node_modules/expo/node_modules/expo-asset/package.json'),
        { name: 'expo-asset', version: '55.0.20' });
      const lockFile = path.join(root, 'package-lock.json');
      const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      lock.packages['node_modules/expo/node_modules/expo-asset'] = { version: '55.0.20' };
      if (identity === 'lock-root') {
        if (version === undefined) delete lock.packages[''].dependencies['expo-asset'];
        else lock.packages[''].dependencies['expo-asset'] = version;
      }
      if (identity === 'lock-package') {
        if (version === undefined) delete lock.packages['node_modules/expo-asset'];
        else lock.packages['node_modules/expo-asset'].version = version;
      }
      writeJson(lockFile, lock);
      if (identity === 'manifest') {
        const file = path.join(root, 'package.json');
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (version === undefined) delete manifest.dependencies['expo-asset'];
        else manifest.dependencies['expo-asset'] = version;
        writeJson(file, manifest);
      }
      if (identity === 'installed') {
        if (version === undefined) fs.unlinkSync(assetFile);
        else writeJson(assetFile, { name: 'expo-asset', version });
      }
      const audioBefore = audioPatches.map(patch => fs.readFileSync(path.join(audioRoot, patch.file), 'utf8'));
      expect(() => assertExpoAudioNativePatch(root)).toThrow(/expo-asset.*(?:compatible exact version|missing)/);
      expect(() => run(['--require-ios', '--require-android'], root)).toThrow(/expo-asset.*(?:compatible exact version|missing)/);
      expect(audioPatches.map(patch => fs.readFileSync(path.join(audioRoot, patch.file), 'utf8'))).toEqual(audioBefore);
      if (identity === 'installed' && version !== undefined) {
        expect(JSON.parse(fs.readFileSync(assetFile, 'utf8')).version).toBe(version);
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects native audio source drift even when versions and explicit-recording permissions are correct', () => {
    const root = createProject();
    try {
      const audioRoot = addGuardedAudio(root);
      const target = path.join(audioRoot, audioPatches[audioPatches.length - 1].file);
      fs.appendFileSync(target, '\n// changed native implementation\n');
      const before = fs.readFileSync(target, 'utf8');
      expect(() => run([], root)).toThrow(/expo-audio.*patch is missing or changed/);
      expect(fs.readFileSync(target, 'utf8')).toBe(before);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['manifest', 'lock-root', 'lock-package', 'installed'])('rejects mismatched guarded expo-audio %s identity', identity => {
    const root = createProject();
    try {
      addGuardedAudio(root);
      const file = path.join(root, identity === 'manifest' ? 'package.json'
        : identity === 'installed' ? 'node_modules/expo-audio/package.json' : 'package-lock.json');
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (identity === 'manifest') value.dependencies['expo-audio'] = '^55.0.18';
      if (identity === 'installed') value.version = '55.0.19';
      if (identity === 'lock-root') value.packages[''].dependencies['expo-audio'] = '55.0.19';
      if (identity === 'lock-package') value.packages['node_modules/expo-audio'].version = '55.0.19';
      writeJson(file, value);
      expect(() => assertExpoAudioNativePatch(root)).toThrow(/expo-audio.*match the guarded exact version/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

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
        '<manifest><uses-permission android:name="android.permission.RECORD_AUDIO" /><application /></manifest>',
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
