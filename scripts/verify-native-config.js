const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { patchLlamaBridge } = require('../patches/llama-rn-0.13.0-rc.3');
const { patches: audioPatches, VERSION: audioVersion } = require('../patches/expo-audio-55.0.18');

const { HEXAGON_GUARD, assertPodfileSourceBuild } = require('../plugins/withLlamaSourceBuild')._internal;
const projectRoot = path.resolve(__dirname, '..');

function readText(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} is missing: ${path.relative(projectRoot, filePath)}`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

function findAppCodegenSpecs(root, jsSrcsDir) {
  const sourceRoot = path.resolve(root, jsSrcsDir);
  if (!fs.existsSync(sourceRoot)) {
    return [];
  }

  const directories = [sourceRoot];
  const specs = [];
  while (directories.length > 0) {
    const directory = directories.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name !== '__mocks__') {
          directories.push(path.join(directory, entry.name));
        }
        continue;
      }
      if (/^(?:Native.*|.*NativeComponent)\.(?:js|ts)$/u.test(entry.name)) {
        specs.push(path.join(directory, entry.name));
      }
    }
  }
  return specs;
}

/** Source admission is preflight configuration proof; a built binary still needs native verification. */
function assertExpoAudioSourceBuild(packageConfig) {
  // SDK 55 merges global options with one platform object. Platform arrays replace the global
  // array, and Apple falls back to ios only when no apple object is present.
  const isObject = value => value != null && typeof value === 'object';
  const autolinking = isObject(packageConfig.expo?.autolinking) ? packageConfig.expo.autolinking : {};
  for (const platform of ['android', 'apple']) {
    const platformOptions = isObject(autolinking[platform]) ? autolinking[platform]
      : platform === 'apple' && isObject(autolinking.ios) ? autolinking.ios : {};
    const effective = { ...autolinking, ...platformOptions };
    if (!Array.isArray(effective.buildFromSource)
      || !effective.buildFromSource.every(pattern => typeof pattern === 'string')
      || !effective.buildFromSource.includes('expo-audio')
      || (Array.isArray(effective.exclude) && effective.exclude.includes('expo-audio'))) {
      throw new Error(`Patched expo-audio must remain autolinked from source: effective ${platform} buildFromSource must include the exact expo-audio entry without excluding it.`);
    }
  }
}

function assertSourceConfig(root = projectRoot) {
  const appConfig = JSON.parse(readText(path.join(root, 'app.json'), 'Expo app config'));
  const easConfig = JSON.parse(readText(path.join(root, 'eas.json'), 'EAS config'));
  const packageConfig = JSON.parse(readText(path.join(root, 'package.json'), 'Package config'));
  const backgroundModes = appConfig.expo?.ios?.infoPlist?.UIBackgroundModes ?? [];

  if (packageConfig.dependencies?.['expo-audio']) {
    const plugin = appConfig.expo?.plugins?.find(entry => Array.isArray(entry) && entry[0] === 'expo-audio');
    const options = plugin?.[1];
    if (packageConfig.dependencies['expo-audio'] !== '55.0.18' || !options
      || typeof options.microphonePermission !== 'string' || !options.microphonePermission.trim() || options.recordAudioAndroid !== true
      || options.enableBackgroundRecording !== false || options.enableBackgroundPlayback !== false
      || backgroundModes.includes('audio')) {
      throw new Error('Local audio requires the pinned explicit-recording plugin with microphone permission and without background audio.');
    }
    assertExpoAudioSourceBuild(packageConfig);
  }

  if (backgroundModes.includes('processing')) {
    throw new Error('UIBackgroundModes=processing requires a real BGTaskScheduler implementation and is forbidden.');
  }
  if (appConfig.expo?.updates?.enabled !== false) {
    throw new Error('Expo updates must remain explicitly disabled: llama.rn upgrades require a new native binary.');
  }
  if (!appConfig.expo?.plugins?.some(plugin => plugin === './plugins/withLlamaSourceBuild')) {
    throw new Error('Pinned llama.rn core corrections require the source-build Expo plugin.');
  }
  const appCodegenSourceDir = packageConfig.codegenConfig?.jsSrcsDir;
  if (appCodegenSourceDir && findAppCodegenSpecs(root, appCodegenSourceDir).length === 0) {
    throw new Error(
      'App codegenConfig must not declare an empty jsSrcsDir; ReactCodegen can infer a dependency on the generated iOS project and create a Release build cycle.',
    );
  }
  if (easConfig.cli?.appVersionSource !== 'remote') {
    throw new Error('EAS production builds must use the remote app version source.');
  }
  if (easConfig.build?.production?.autoIncrement !== true) {
    throw new Error('EAS production builds must auto-increment developer-facing build versions.');
  }
}

function assertLlamaNativeArtifacts(root = projectRoot) {
  const packageConfig = JSON.parse(readText(path.join(root, 'package.json'), 'Package config'));
  const lock = JSON.parse(readText(path.join(root, 'package-lock.json'), 'Package lock'));
  const llamaRoot = path.join(root, 'node_modules', 'llama.rn');
  const installed = JSON.parse(readText(path.join(llamaRoot, 'package.json'), 'Installed llama.rn package'));
  const version = packageConfig.dependencies?.['llama.rn'];
  if (typeof version !== 'string'
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)
    || lock.packages?.['']?.dependencies?.['llama.rn'] !== version
    || lock.packages?.['node_modules/llama.rn']?.version !== version
    || installed.version !== version) {
    throw new Error('llama.rn manifest, lockfile and installed package must match one exact version; run npm ci.');
  }
  const manifest = JSON.parse(readText(
    path.join(llamaRoot, 'install', 'native-artifacts.json'), 'llama.rn native artifact manifest',
  ));
  const expectedArtifacts = [
    {
      name: 'android-jni-libs',
      relativePath: 'android/src/main/jniLibs',
      files: ['arm64-v8a/librnllama.so', 'x86_64/librnllama.so'],
    },
    {
      name: 'ios-xcframework',
      relativePath: 'ios/rnllama.xcframework',
      files: [
        'Info.plist',
        'ios-arm64/rnllama.framework/rnllama',
        'ios-arm64_x86_64-simulator/rnllama.framework/rnllama',
      ],
    },
  ];
  for (const expected of expectedArtifacts) {
    const entries = Array.isArray(manifest.artifacts)
      ? manifest.artifacts.filter((artifact) => artifact?.name === expected.name)
      : [];
    const artifact = entries[0];
    if (entries.length !== 1
      || artifact.relativePath !== expected.relativePath
      || artifact.markerPath !== `${expected.relativePath}/.llama-rn.sha256`
      || typeof artifact.sha256 !== 'string'
      || !/^[\da-f]{64}$/iu.test(artifact.sha256)) {
      throw new Error(`Invalid llama.rn native artifact manifest for ${expected.name}.`);
    }
    // The upstream downloader verifies the archive before writing this receipt.
    // A matching receipt is installation evidence, not a binary checksum or smoke test.
    const marker = readText(path.join(llamaRoot, artifact.markerPath), `llama.rn ${expected.name} receipt`).trim();
    if (marker !== artifact.sha256) {
      throw new Error(`Stale llama.rn ${expected.name} receipt; run npm ci with postinstall enabled.`);
    }
    for (const file of expected.files) {
      const payload = path.join(llamaRoot, expected.relativePath, file);
      const stat = fs.existsSync(payload) ? fs.statSync(payload) : null;
      if (!stat?.isFile() || stat.size === 0) {
        throw new Error(`Missing llama.rn ${expected.name} payload ${file}; run npm ci with postinstall enabled.`);
      }
    }
  }
}

/** Read-only proof that the installed playback sources include the guarded disposal/resume patch. */
function assertExpoAudioNativePatch(root = projectRoot) {
  const manifest = JSON.parse(readText(path.join(root, 'package.json'), 'Package config'));
  if (!manifest.dependencies?.['expo-audio']) return;
  const lock = JSON.parse(readText(path.join(root, 'package-lock.json'), 'Package lock'));
  const packageRoot = path.join(root, 'node_modules', 'expo-audio');
  const installed = JSON.parse(readText(path.join(packageRoot, 'package.json'), 'Installed expo-audio package'));
  if (manifest.dependencies['expo-audio'] !== audioVersion
    || lock.packages?.['']?.dependencies?.['expo-audio'] !== audioVersion
    || lock.packages?.['node_modules/expo-audio']?.version !== audioVersion || installed.version !== audioVersion) {
    throw new Error('expo-audio manifest, lockfile and installed package must match the guarded exact version; run npm ci.');
  }
  // expo-audio's wildcard asset peer must not pull a newer native module into Expo 55.
  // Check the hoisted package that autolinking sees; a compatible nested Expo copy is insufficient.
  const assetVersion = '55.0.20';
  const asset = JSON.parse(readText(path.join(root, 'node_modules', 'expo-asset', 'package.json'), 'Top-level installed expo-asset package'));
  if (manifest.dependencies['expo-asset'] !== assetVersion
    || lock.packages?.['']?.dependencies?.['expo-asset'] !== assetVersion
    || lock.packages?.['node_modules/expo-asset']?.version !== assetVersion || asset.version !== assetVersion) {
    throw new Error('expo-asset manifest, lockfile and top-level installed package must match the Expo 55 compatible exact version 55.0.20; run npm ci.');
  }
  assertExpoAudioSourceBuild(manifest);
  for (const patch of audioPatches) {
    const source = readText(path.join(packageRoot, patch.file), `Patched expo-audio ${patch.file}`).replace(/\r\n/gu, '\n');
    if (crypto.createHash('sha256').update(source).digest('hex') !== patch.after) {
      throw new Error(`expo-audio speech disposal/resume patch is missing or changed: ${patch.file}; run npm ci with postinstall enabled.`);
    }
  }
}

function assertIosGeneratedConfig(root = projectRoot) {
  const podfile = readText(path.join(root, 'ios', 'Podfile'), 'Generated iOS Podfile').replace(/\r\n/gu, '\n');
  assertPodfileSourceBuild(podfile);
  const plist = readText(path.join(root, 'ios', 'pocketai', 'Info.plist'), 'Generated iOS Info.plist');
  const entitlements = readText(
    path.join(root, 'ios', 'pocketai', 'pocketai.entitlements'),
    'Generated iOS entitlements',
  );
  const xcodeProject = readText(
    path.join(root, 'ios', 'PocketAI.xcodeproj', 'project.pbxproj'),
    'Generated iOS Xcode project',
  );
  const appDelegate = readText(
    path.join(root, 'ios', 'PocketAI', 'AppDelegate.swift'),
    'Generated iOS AppDelegate',
  );

  if (/UIBackgroundModes[\s\S]{0,500}<string>processing<\/string>/u.test(plist)) {
    throw new Error('Generated Info.plist still declares unsupported background processing.');
  }
  if (!/<key>NSMicrophoneUsageDescription<\/key>\s*<string>[^<]+<\/string>/u.test(plist)
    || /<key>UIBackgroundModes<\/key>\s*<array>[\s\S]*?<string>audio<\/string>[\s\S]*?<\/array>/u.test(plist)) {
    throw new Error('Generated Info.plist must include explicit microphone usage and forbid background audio.');
  }
  if (!/<key>CFBundleIdentifier<\/key>/u.test(plist)) {
    throw new Error('Generated Info.plist is missing CFBundleIdentifier.');
  }
  if (!/<key>CFBundleVersion<\/key>\s*<string>[^<]+<\/string>/u.test(plist)) {
    throw new Error('Generated Info.plist is missing a non-empty CFBundleVersion.');
  }
  if (!/^\s*<\?xml[\s\S]+<plist[\s\S]+<dict>[\s\S]*<\/dict>[\s\S]*<\/plist>\s*$/u.test(entitlements)) {
    throw new Error('Generated iOS entitlements are not a complete plist dictionary.');
  }
  for (const entitlement of [
    'com.apple.developer.kernel.extended-virtual-addressing',
    'com.apple.developer.kernel.increased-memory-limit',
  ]) {
    const entitlementPattern = new RegExp(`<key>${entitlement.replaceAll('.', '\\.')}</key>\\s*<true\\s*\\/>`, 'u');
    if (!entitlementPattern.test(entitlements)) {
      throw new Error(`Generated iOS entitlements are missing ${entitlement}=true.`);
    }
  }
  for (const locale of ['en', 'ru']) {
    const localizedInfoPlistPattern = new RegExp(
      `path = "?${locale}\\.lproj/InfoPlist\\.strings"?;`,
      'u',
    );
    if (!localizedInfoPlistPattern.test(xcodeProject)) {
      throw new Error(`Generated iOS Xcode project is missing ${locale}.lproj/InfoPlist.strings.`);
    }
  }
  if (/path = "?InfoPlist\.strings"?;/u.test(xcodeProject)) {
    throw new Error('Generated iOS Xcode project collapses localized InfoPlist.strings to a missing shared path.');
  }
  const appDelegateDeclarationIndex = appDelegate.search(/^(?:@main\s*\n)?(?:public\s+)?class\s+AppDelegate\b/mu);
  const backupHelperIndex = appDelegate.indexOf('private func excludePocketAiModelDirectoryFromBackup()');
  if (appDelegateDeclarationIndex < 0 || backupHelperIndex < 0 || backupHelperIndex > appDelegateDeclarationIndex) {
    throw new Error('Generated iOS AppDelegate must declare the backup exclusion helper at file scope before AppDelegate.');
  }
}

function assertAndroidGeneratedConfig(root = projectRoot) {
  const gradleProperties = readText(
    path.join(root, 'android', 'gradle.properties'),
    'Generated Android Gradle properties',
  );
  const manifest = readText(
    path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
    'Generated Android manifest',
  );
  const grantedPermissions = [...manifest.matchAll(/<uses-permission\b[^>]*>/gu)]
    .filter(match => !/tools:node="remove"/u.test(match[0])).map(match => match[0]);
  if (!grantedPermissions.some(permission => /android\.permission\.RECORD_AUDIO/u.test(permission))
    || grantedPermissions.some(permission => /android\.permission\.(?:FOREGROUND_SERVICE_MEDIA_PLAYBACK|FOREGROUND_SERVICE_MICROPHONE)/u.test(permission))
    || [...manifest.matchAll(/<service\b[^>]*>/gu)].some(match => !/tools:node="remove"/u.test(match[0])
      && /expo\.modules\.audio\.service\.(?:AudioForegroundService|AudioRecordingService|AudioControlsService)/u.test(match[0]))) {
    throw new Error('Generated Android manifest must grant explicit recording and forbid background audio services.');
  }

  for (const permission of [
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
  ]) {
    if (!manifest.includes(`android:name="${permission}"`)) {
      throw new Error(`Generated Android manifest is missing ${permission}.`);
    }
  }
  const service = manifest.match(/<service\b[^>]*RNBackgroundActionsTask[^>]*>/u)?.[0] ?? '';
  if (!service || !/android:foregroundServiceType="dataSync"/u.test(service)) {
    throw new Error('RNBackgroundActionsTask must declare foregroundServiceType=dataSync.');
  }
  const projectBuildGradle = readText(path.join(root, 'android', 'build.gradle'), 'Generated Android build.gradle').replace(/\r\n/gu, '\n');
  if (!projectBuildGradle.includes(HEXAGON_GUARD)) throw new Error('Android must verify the pinned llama.rn host SDK before building.');
  const sourceBuildFlags = gradleProperties.split(/\r?\n/u).filter(line => /^\s*rnllamaBuildFromSource\s*=/u.test(line));
  if (sourceBuildFlags.length !== 1 || !/^\s*rnllamaBuildFromSource\s*=\s*true\s*$/u.test(sourceBuildFlags[0])) {
    throw new Error('Android must compile the corrected llama.rn core from source.');
  }
  if (!/^org\.gradle\.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=1024m$/mu.test(gradleProperties)) {
    throw new Error(
      'Generated Android Gradle properties must reserve 1024 MiB of Metaspace for the native Release pack.',
    );
  }
}

function run(argv = process.argv.slice(2), root = projectRoot) {
  const requireIos = argv.includes('--require-ios');
  const requireAndroid = argv.includes('--require-android');
  assertSourceConfig(root);
  assertLlamaNativeArtifacts(root);
  patchLlamaBridge(root, { check: true });
  assertExpoAudioNativePatch(root);

  if (requireIos || fs.existsSync(path.join(root, 'ios'))) {
    assertIosGeneratedConfig(root);
  }
  if (requireAndroid || fs.existsSync(path.join(root, 'android'))) {
    assertAndroidGeneratedConfig(root);
  }
}

if (require.main === module) {
  run();
  console.log('Native configuration contract verified.');
}

module.exports = {
  assertAndroidGeneratedConfig,
  assertIosGeneratedConfig,
  assertLlamaNativeArtifacts,
  assertExpoAudioNativePatch,
  assertSourceConfig,
  run,
};
