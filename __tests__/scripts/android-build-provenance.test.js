const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  ANDROID_PROVENANCE_GRADLE_EXECUTION_ARGS,
  ANDROID_REQUIRED_NATIVE_LIBRARIES_BY_ABI,
  ANDROID_UNIVERSAL_ABIS,
  BUILD_PROVENANCE_SCHEMA_VERSION,
  assertAndroidReleaseArtifactCreated,
  assertAndroidBuildOverrideContract,
  buildAndroidCleanPrebuildArgs,
  collectAndroidNativeProjectState,
  collectAndroidEffectiveBuildContext,
  collectAndroidPrivateBuildReuseDigest,
  collectBuildProvenance,
  collectContentHashEntries,
  collectPrebuildInputState,
  createAndroidShippingBuildEnvironment,
  createIsolatedAndroidBuildEnvironment,
  createFileContentFingerprint,
  findGradleProjectPropertyOverride,
  formatAndroidGradleCommandForLog,
  hashCanonicalJson,
  inspectAndroidArtifactNativeEntries,
  isExcludedAndroidBuildInput,
  parseGradleProjectProperties,
  parseGradleSystemProperties,
  parseGradleSystemProjectProperties,
  parseJavaProperties,
  prepareAndroidReleaseArtifactOutput,
  readGradleWrapperVersion,
  readJavaVersion,
  redactCommandArgsForLog,
  resolveAndroidGradleWrapperInvocation,
  resolveAndroidReleaseTaskContract,
  resolveBuildStampPath,
  resolveExpoCliInvocation,
  resolvePrebuildStampPaths,
  runAndroidReleaseArtifactTransaction,
  shouldRunPrebuild,
  withAndroidProvenanceGradleExecutionArgs,
} = require('../../scripts/android-build-provenance');

function createProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-ai-android-provenance-'));
  fs.mkdirSync(path.join(projectRoot, 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'android', 'gradle', 'wrapper'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'app.json'), '{"expo":{}}');
  fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"fixture"}');
  fs.writeFileSync(path.join(projectRoot, 'plugins', 'withFixture.js'), 'module.exports = {}');
  fs.writeFileSync(
    path.join(projectRoot, 'android', 'gradle', 'wrapper', 'gradle-wrapper.properties'),
    'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14.3-bin.zip\n',
  );
  return projectRoot;
}

const toolchains = {
  node: 'v24.0.0',
  java: 'openjdk version "17.0.14"',
  gradleWrapper: { distributionType: 'bin', version: '8.14.3' },
};
const git = {
  headSha: 'head-1',
  treeSha: 'tree-1',
  dirty: false,
  dirtyDigest: 'dirty-1',
  dirtyEntryCount: 0,
};

describe('Android build content provenance', () => {
  it('ignores mtime changes but detects equal-size content replacements', () => {
    const projectRoot = createProject();
    const inputPath = path.join(projectRoot, 'plugins', 'withFixture.js');

    try {
      const first = collectContentHashEntries(projectRoot, ['plugins']);
      const originalStats = fs.statSync(inputPath);
      fs.utimesSync(inputPath, new Date(originalStats.atimeMs + 60_000), new Date(originalStats.mtimeMs + 60_000));
      const touched = collectContentHashEntries(projectRoot, ['plugins']);
      expect(touched).toEqual(first);

      fs.writeFileSync(inputPath, 'module.exports = 42');
      fs.utimesSync(inputPath, originalStats.atime, originalStats.mtime);
      const replaced = collectContentHashEntries(projectRoot, ['plugins']);
      expect(replaced[0].size).toBe(first[0].size);
      expect(replaced[0].sha256).not.toBe(first[0].sha256);
    } finally {
      fs.rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it('invalidates prebuild provenance when a native config asset changes without size or mtime changes', () => {
    const projectRoot = createProject();
    const imageRoot = path.join(projectRoot, 'assets', 'images');
    const iconPath = path.join(imageRoot, 'icon.png');
    fs.mkdirSync(imageRoot, { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, 'app.json'),
      JSON.stringify({ expo: { icon: './assets/images/icon.png' } }),
    );
    fs.writeFileSync(iconPath, 'icon-one');

    try {
      const first = collectPrebuildInputState(projectRoot, { variant: 'debug' });
      const originalStats = fs.statSync(iconPath);
      fs.writeFileSync(iconPath, 'icon-two');
      fs.utimesSync(iconPath, originalStats.atime, originalStats.mtime);
      const replaced = collectPrebuildInputState(projectRoot, { variant: 'debug' });

      const firstIcon = first.entries.find((entry) => entry.path === 'assets/images/icon.png');
      const replacedIcon = replaced.entries.find((entry) => entry.path === 'assets/images/icon.png');
      expect(firstIcon).toBeDefined();
      expect(replacedIcon).toBeDefined();
      expect(replacedIcon.size).toBe(firstIcon.size);
      expect(replacedIcon.sha256).not.toBe(firstIcon.sha256);
      expect(replaced.digest).not.toBe(first.digest);
    } finally {
      fs.rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it('excludes Gradle, Kotlin, and native intermediates without hiding tracked Android source', () => {
    const projectRoot = createProject();
    const trackedNativeSourcePath = path.join(
      projectRoot,
      'android',
      'app',
      'src',
      'main',
      'cpp',
      'CMakeLists.txt',
    );
    const generatedPaths = [
      path.join(projectRoot, 'android', '.kotlin', 'sessions', 'kotlin-compiler-1.bin'),
      path.join(projectRoot, 'android', 'app', '.cxx', 'Debug', 'x86_64', 'build.ninja'),
      path.join(projectRoot, 'android', 'app', '.externalNativeBuild', 'cmake', 'metadata.json'),
      path.join(projectRoot, 'android', 'feature', '.cxx', 'Debug', 'arm64-v8a', 'build.ninja'),
    ];
    fs.mkdirSync(path.dirname(trackedNativeSourcePath), { recursive: true });
    fs.writeFileSync(trackedNativeSourcePath, 'add_library(pocket_ai SHARED one.cpp)');

    const collect = () => collectBuildProvenance(projectRoot, {
      abi: 'x86_64',
      env: {},
      git,
      toolchains,
      variant: 'debug',
    });

    try {
      const beforeIntermediates = collect();
      for (const generatedPath of generatedPaths) {
        fs.mkdirSync(path.dirname(generatedPath), { recursive: true });
        fs.writeFileSync(generatedPath, `generated-${path.basename(generatedPath)}`);
      }
      const afterIntermediates = collect();

      expect(afterIntermediates.digest).toBe(beforeIntermediates.digest);
      expect(afterIntermediates.entries.some((entry) => (
        entry.path.includes('/.cxx/')
        || entry.path.includes('/.externalNativeBuild/')
        || entry.path.startsWith('android/.kotlin/')
      ))).toBe(false);
      expect(isExcludedAndroidBuildInput('android/.kotlin/sessions/state.bin')).toBe(true);
      expect(isExcludedAndroidBuildInput('android/app/.cxx/Debug/build.ninja')).toBe(true);
      expect(isExcludedAndroidBuildInput('android/app/.externalNativeBuild/cmake/state.json')).toBe(true);
      expect(isExcludedAndroidBuildInput('android/app/src/main/cpp/CMakeLists.txt')).toBe(false);

      fs.writeFileSync(trackedNativeSourcePath, 'add_library(pocket_ai SHARED two.cpp)');
      expect(collect().digest).not.toBe(afterIntermediates.digest);
    } finally {
      fs.rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it('binds an active prebuild stamp to the actual CNG output bytes', () => {
    const projectRoot = createProject();
    const nativeSourcePath = path.join(projectRoot, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
    const generatedIntermediatePath = path.join(projectRoot, 'android', 'app', 'build', 'generated', 'state.bin');
    fs.mkdirSync(path.dirname(nativeSourcePath), { recursive: true });
    fs.writeFileSync(nativeSourcePath, '<manifest package="com.pocketai.one" />');

    try {
      const initial = collectAndroidNativeProjectState(projectRoot);
      fs.mkdirSync(path.dirname(generatedIntermediatePath), { recursive: true });
      fs.writeFileSync(generatedIntermediatePath, 'gradle-intermediate');
      expect(collectAndroidNativeProjectState(projectRoot).digest).toBe(initial.digest);

      fs.writeFileSync(nativeSourcePath, '<manifest package="com.pocketai.two" />');
      expect(collectAndroidNativeProjectState(projectRoot).digest).not.toBe(initial.digest);
    } finally {
      fs.rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it('hashes Expo env files as prebuild and embedded-bundle inputs without exposing values', () => {
    const projectRoot = createProject();
    const envPath = path.join(projectRoot, '.env.production.local');
    fs.writeFileSync(envPath, 'EXPO_PUBLIC_FIXTURE=first-secret-value\n');

    try {
      const firstPrebuild = collectPrebuildInputState(projectRoot, { variant: 'release' });
      const firstBuild = collectBuildProvenance(projectRoot, {
        variant: 'release',
        toolchains,
        git,
      });
      fs.writeFileSync(envPath, 'EXPO_PUBLIC_FIXTURE=other-secret-value\n');
      const nextPrebuild = collectPrebuildInputState(projectRoot, { variant: 'release' });
      const nextBuild = collectBuildProvenance(projectRoot, {
        variant: 'release',
        toolchains,
        git,
      });

      expect(nextPrebuild.digest).not.toBe(firstPrebuild.digest);
      expect(nextBuild.digest).not.toBe(firstBuild.digest);
      expect(JSON.stringify(nextBuild)).not.toContain('other-secret-value');
    } finally {
      fs.rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it('binds arbitrary Expo modes, dotenv controls, and expanded system dependencies privately', () => {
    const projectRoot = createProject();
    const hmacKeyPath = path.join(projectRoot, 'private-cache', 'reuse-hmac.key');
    const stagingEnvPath = path.join(projectRoot, '.env.staging');
    fs.writeFileSync(
      stagingEnvPath,
      'EXPO_PUBLIC_ENDPOINT=${API_HOST}\nEXPO_PUBLIC_CHANNEL=staging-one\n',
    );

    try {
      const first = collectAndroidPrivateBuildReuseDigest(projectRoot, {
        hmacKeyPath,
        env: { NODE_ENV: 'staging', API_HOST: 'https://one.example' },
      });
      const changedExpansionDependency = collectAndroidPrivateBuildReuseDigest(projectRoot, {
        hmacKeyPath,
        env: { NODE_ENV: 'staging', API_HOST: 'https://two.example' },
      });
      fs.writeFileSync(
        stagingEnvPath,
        'EXPO_PUBLIC_ENDPOINT=${API_HOST}\nEXPO_PUBLIC_CHANNEL=staging-two\n',
      );
      const changedArbitraryModeFile = collectAndroidPrivateBuildReuseDigest(projectRoot, {
        hmacKeyPath,
        env: { NODE_ENV: 'staging', API_HOST: 'https://two.example' },
      });
      const dotenvDisabled = collectAndroidPrivateBuildReuseDigest(projectRoot, {
        hmacKeyPath,
        env: {
          NODE_ENV: 'staging',
          API_HOST: 'https://two.example',
          EXPO_NO_DOTENV: '1',
        },
      });
      const clientEnvDisabled = collectAndroidPrivateBuildReuseDigest(projectRoot, {
        hmacKeyPath,
        env: {
          NODE_ENV: 'staging',
          API_HOST: 'https://two.example',
          EXPO_NO_CLIENT_ENV_VARS: '1',
        },
      });

      expect(changedExpansionDependency).not.toBe(first);
      expect(changedArbitraryModeFile).not.toBe(changedExpansionDependency);
      expect(dotenvDisabled).not.toBe(changedArbitraryModeFile);
      expect(clientEnvDisabled).not.toBe(changedArbitraryModeFile);
    } finally {
      fs.rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it('binds the manifest digest to variant, ABI, toolchains, git state, and embedded sources', () => {
    const projectRoot = createProject();
    fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'src', 'fixture.ts'), 'export const value = 1;');
    fs.writeFileSync(path.join(projectRoot, 'tsconfig.json'), '{"compilerOptions":{}}');

    try {
      const debug = collectBuildProvenance(projectRoot, {
        variant: 'debug',
        abi: 'x86_64',
        toolchains,
        git,
      });
      const release = collectBuildProvenance(projectRoot, {
        variant: 'release',
        abi: 'x86_64',
        toolchains,
        git,
      });
      const arm = collectBuildProvenance(projectRoot, {
        variant: 'debug',
        abi: 'arm64-v8a',
        toolchains,
        git,
      });

      expect(debug.schemaVersion).toBe(BUILD_PROVENANCE_SCHEMA_VERSION);
      expect(debug.entries.some((entry) => entry.path === 'src/fixture.ts')).toBe(false);
      expect(release.entries.some((entry) => entry.path === 'src/fixture.ts')).toBe(true);
      expect(release.entries.some((entry) => entry.path === 'tsconfig.json')).toBe(true);
      expect(new Set([debug.digest, release.digest, arm.digest])).toHaveProperty('size', 3);

      fs.writeFileSync(path.join(projectRoot, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
      const changedTypeScriptConfig = collectBuildProvenance(projectRoot, {
        variant: 'release',
        abi: 'x86_64',
        toolchains,
        git,
      });
      expect(changedTypeScriptConfig.digest).not.toBe(release.digest);
    } finally {
      fs.rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it('invalidates build provenance for effective Gradle version and plugin environment changes', () => {
    const projectRoot = createProject();

    try {
      const firstContext = collectAndroidEffectiveBuildContext(projectRoot, {
        variant: 'release',
        env: {
          NODE_ENV: 'production',
          POCKET_AI_ALLOW_DEBUG_RELEASE_SIGNING: 'true',
          POCKET_AI_VERSION_CODE: '42',
        },
      });
      const changedVersion = collectAndroidEffectiveBuildContext(projectRoot, {
        variant: 'release',
        env: {
          NODE_ENV: 'production',
          POCKET_AI_ALLOW_DEBUG_RELEASE_SIGNING: 'true',
          POCKET_AI_VERSION_CODE: '43',
        },
      });
      const changedPlugin = collectAndroidEffectiveBuildContext(projectRoot, {
        variant: 'release',
        env: {
          NODE_ENV: 'production',
          POCKET_AI_ALLOW_DEBUG_RELEASE_SIGNING: 'true',
          POCKET_AI_VERSION_CODE: '42',
          POCKET_AI_ANDROID_KOTLIN_VERSION: '2.1.0',
        },
      });

      expect(firstContext.version).toEqual(expect.objectContaining({
        code: '42',
        codeSource: 'environment',
      }));
      expect(hashCanonicalJson(changedVersion)).not.toBe(hashCanonicalJson(firstContext));
      expect(hashCanonicalJson(changedPlugin)).not.toBe(hashCanonicalJson(firstContext));
    } finally {
      fs.rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it('models Gradle system project-property precedence from CLI and JVM option channels', () => {
    const projectRoot = createProject();

    try {
      const systemArgumentContext = collectAndroidEffectiveBuildContext(projectRoot, {
        variant: 'release',
        env: { POCKET_AI_VERSION_CODE: '40' },
        gradleArgs: ['-Dorg.gradle.project.pocketAiVersionCode=41'],
      });
      const projectArgumentContext = collectAndroidEffectiveBuildContext(projectRoot, {
        variant: 'release',
        env: { GRADLE_OPTS: '-Dorg.gradle.project.pocketAiVersionCode=42' },
        gradleArgs: ['-PpocketAiVersionCode=43'],
      });
      const legacyJavaOptionContext = collectAndroidEffectiveBuildContext(projectRoot, {
        variant: 'release',
        env: { _JAVA_OPTIONS: '-Dorg.gradle.project.pocketAiVersionCode=44' },
      });
      const jdkJavaOptionContext = collectAndroidEffectiveBuildContext(projectRoot, {
        variant: 'release',
        env: { JDK_JAVA_OPTIONS: '-Dorg.gradle.project.pocketAiVersionCode=45' },
      });

      expect(systemArgumentContext.version).toEqual(expect.objectContaining({
        code: '41',
        codeSource: 'gradle-system-property',
      }));
      expect(projectArgumentContext.version).toEqual(expect.objectContaining({
        code: '43',
        codeSource: 'gradle-argument',
      }));
      expect(legacyJavaOptionContext.version).toEqual(expect.objectContaining({
        code: '44',
        codeSource: 'gradle-system-property',
      }));
      expect(jdkJavaOptionContext.version).toEqual(expect.objectContaining({
        code: '45',
        codeSource: 'gradle-system-property',
      }));
    } finally {
      fs.rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it('binds release signing identity without serializing paths, aliases, or credentials', () => {
    const projectRoot = createProject();
    const keystoreDirectory = path.join(projectRoot, 'keystores');
    const keystorePath = path.join(keystoreDirectory, 'private-upload.jks');
    fs.mkdirSync(keystoreDirectory, { recursive: true });
    fs.writeFileSync(keystorePath, 'private-key-material');
    fs.writeFileSync(
      path.join(projectRoot, 'keystore.properties'),
      [
        'storeFile=keystores/private-upload.jks',
        'storePassword=super-secret-store-password',
        'keyAlias=private-release-alias',
        'keyPassword=super-secret-key-password',
      ].join('\n'),
    );

    try {
      const hmacKeyPath = path.join(projectRoot, 'private-cache', 'reuse-hmac.key');
      const first = collectAndroidEffectiveBuildContext(projectRoot, {
        variant: 'release',
        env: { EXPO_PUBLIC_ANDROID_QA: 'sensitive-public-value' },
      });
      const firstPrivateDigest = collectAndroidPrivateBuildReuseDigest(projectRoot, {
        hmacKeyPath,
        variant: 'release',
        env: { EXPO_PUBLIC_ANDROID_QA: 'sensitive-public-value' },
      });
      const changedPrivateDigest = collectAndroidPrivateBuildReuseDigest(projectRoot, {
        hmacKeyPath,
        variant: 'release',
        env: {
          EXPO_PUBLIC_ANDROID_QA: 'sensitive-public-value',
          POCKET_AI_UPLOAD_KEY_PASSWORD: 'different-secret-key-password',
        },
      });
      const changedGradleProjectDigest = collectAndroidPrivateBuildReuseDigest(projectRoot, {
        hmacKeyPath,
        variant: 'release',
        env: {
          EXPO_PUBLIC_ANDROID_QA: 'sensitive-public-value',
          ORG_GRADLE_PROJECT_reactNativeArchitectures: 'x86_64',
        },
      });
      const serialized = JSON.stringify(first);

      expect(first.signing).toEqual(expect.objectContaining({
        mode: 'upload',
        storeFileExists: true,
        storeFileSha256: expect.any(String),
      }));
      expect(changedPrivateDigest).not.toBe(firstPrivateDigest);
      expect(changedGradleProjectDigest).not.toBe(firstPrivateDigest);
      expect(first.signing).not.toHaveProperty('storePasswordHash');
      expect(first.signing).not.toHaveProperty('keyAliasHash');
      expect(first.signing).not.toHaveProperty('keyPasswordHash');
      expect(serialized).not.toContain('private-upload.jks');
      expect(serialized).not.toContain('private-release-alias');
      expect(serialized).not.toContain('super-secret');
      expect(serialized).not.toContain('sensitive-public-value');
      expect(serialized).not.toContain(projectRoot);
    } finally {
      fs.rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it('models Gradle project-property precedence and privately invalidates user properties', () => {
    const projectRoot = createProject();
    const userGradlePropertiesPath = path.join(projectRoot, 'private-gradle', 'gradle.properties');
    const hmacKeyPath = path.join(projectRoot, 'private-cache', 'reuse-hmac.key');
    fs.mkdirSync(path.dirname(userGradlePropertiesPath), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, 'android', 'gradle.properties'),
      'pocketAiVersionCode=44\n',
    );
    fs.writeFileSync(userGradlePropertiesPath, 'pocketAiVersionCode=45\nprivateValue=one\n');

    try {
      const userContext = collectAndroidEffectiveBuildContext(projectRoot, {
        variant: 'release',
        env: { ORG_GRADLE_PROJECT_pocketAiVersionCode: '43' },
        userGradlePropertiesPath,
      });
      const cliContext = collectAndroidEffectiveBuildContext(projectRoot, {
        variant: 'release',
        env: {},
        gradleArgs: ['-PpocketAiVersionCode=46'],
        userGradlePropertiesPath,
      });
      const firstPrivateDigest = collectAndroidPrivateBuildReuseDigest(projectRoot, {
        env: {},
        hmacKeyPath,
        userGradlePropertiesPath,
      });
      fs.writeFileSync(userGradlePropertiesPath, 'pocketAiVersionCode=45\nprivateValue=two\n');
      const nextPrivateDigest = collectAndroidPrivateBuildReuseDigest(projectRoot, {
        env: {},
        hmacKeyPath,
        userGradlePropertiesPath,
      });

      expect(userContext.version).toEqual(expect.objectContaining({
        code: '45',
        codeSource: 'user-gradle-properties',
      }));
      expect(cliContext.version).toEqual(expect.objectContaining({
        code: '46',
        codeSource: 'gradle-argument',
      }));
      expect(nextPrivateDigest).not.toBe(firstPrivateDigest);
      expect(JSON.stringify(userContext)).not.toContain('privateValue');
    } finally {
      fs.rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it('produces stable canonical hashes regardless of object key insertion order', () => {
    expect(hashCanonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe(
      hashCanonicalJson({ a: { c: 3, d: 4 }, b: 2 }),
    );
  });

  it('hashes APK bytes instead of path, size, or mtime metadata', () => {
    const projectRoot = createProject();
    const apkPath = path.join(projectRoot, 'app.apk');
    fs.writeFileSync(apkPath, 'apk-one');
    const first = createFileContentFingerprint(apkPath, projectRoot);
    const originalStats = fs.statSync(apkPath);
    fs.writeFileSync(apkPath, 'apk-two');
    fs.utimesSync(apkPath, originalStats.atime, originalStats.mtime);
    const second = createFileContentFingerprint(apkPath, projectRoot);

    try {
      expect(second.size).toBe(first.size);
      expect(second.sha256).not.toBe(first.sha256);
      expect(second.fingerprint).toBe(second.sha256);
      expect(second).not.toHaveProperty('mtimeMs');
    } finally {
      fs.rmSync(projectRoot, { force: true, recursive: true });
    }
  });
});

describe('Android build provenance routing', () => {
  it('parses split Gradle project properties and rejects malformed option boundaries', () => {
    expect(parseGradleProjectProperties([
      '--project-prop',
      'pocketAiVersionCode=99',
      '-P',
      'pocketAiVersionName=9.9.9',
    ])).toEqual({
      pocketAiVersionCode: '99',
      pocketAiVersionName: '9.9.9',
    });
    expect(() => parseGradleProjectProperties(['-P'])).toThrow(/requires a Gradle project-property declaration/);
    expect(() => parseGradleProjectProperties(['--project-prop', '--stacktrace']))
      .toThrow(/requires a Gradle project-property declaration/);
    expect(() => parseGradleProjectProperties(['--project-prop=']))
      .toThrow(/requires a Gradle project-property declaration/);
    expect(() => parseGradleProjectProperties(['-P=secret']))
      .toThrow(/require a non-empty name/);

    expect(parseGradleSystemProjectProperties([
      '-Dorg.gradle.project.reactNativeArchitectures=x86_64',
      '-D',
      'org.gradle.project.pocketAiVersionCode=99',
      '--system-prop=org.gradle.project.android.injected.signing.key.alias=private',
    ])).toEqual({
      reactNativeArchitectures: 'x86_64',
      pocketAiVersionCode: '99',
      'android.injected.signing.key.alias': 'private',
    });
    expect(() => parseGradleSystemProjectProperties(['-D', '--stacktrace']))
      .toThrow(/requires a Gradle system-property declaration/);
    expect(() => parseGradleSystemProjectProperties(['--system-prop=org.gradle.project.=secret']))
      .toThrow(/require a non-empty name/);
    expect(parseGradleSystemProperties([
      '-Dgradle.user.home=C:\\external-gradle',
      '--system-prop',
      'org.gradle.project.pocketAiVersionCode=99',
    ])).toEqual({
      'gradle.user.home': 'C:\\external-gradle',
      'org.gradle.project.pocketAiVersionCode': '99',
    });
  });

  it('decodes Java Properties whitespace separators, escapes, continuations, and duplicates', () => {
    const properties = parseJavaProperties([
      String.raw`escaped\ key whitespace-value`,
      'continued=value' + '\\',
      '  -tail',
      String.raw`android.inj\u0065cted.version.code=999`,
      String.raw`storeFile=C\:\\private\\upload.jks`,
      'duplicate=first',
      'duplicate:second',
    ].join('\n'), 'fixture.properties');

    expect(properties).toEqual({
      'android.injected.version.code': '999',
      continued: 'value-tail',
      duplicate: 'second',
      'escaped key': 'whitespace-value',
      storeFile: 'C:\\private\\upload.jks',
    });
    expect(() => parseJavaProperties(String.raw`key=\u00zz`, 'fixture.properties'))
      .toThrow(/Malformed Java Properties Unicode escape/);
  });

  it('builds one fail-closed cmd invocation for Windows Gradle wrappers', () => {
    const invocation = resolveAndroidGradleWrapperInvocation({
      platform: 'win32',
      comSpec: 'C:\\Windows\\System32\\cmd.exe',
      gradleArgs: [
        'app:bundleRelease',
        '-PpocketAiVersionName=1.6.0+build.7',
        '--rerun-tasks',
        '--no-build-cache',
      ],
    });
    expect(invocation).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        'gradlew.bat app:bundleRelease -PpocketAiVersionName=1.6.0+build.7 --rerun-tasks --no-build-cache',
      ],
    });
    for (const unsafeValue of ['&', '|', '<', '>', '^', '(', ')', '%', '!', '"', ' ']) {
      expect(() => resolveAndroidGradleWrapperInvocation({
        platform: 'win32',
        gradleArgs: [`-PpocketAiVersionName=1.0${unsafeValue}injected`],
      })).toThrow(/rejects arguments containing whitespace or cmd metacharacters/);
    }

    const secretGradleArgs = [
      'app:bundleRelease',
      '-PpocketAiVersionCode=42',
      '-PpocketAiUploadStorePassword=safeSecret123',
      '-Dorg.gradle.jvmargs=-Dorg.gradle.project.pocketAiUploadKeyPassword=nestedSecret456',
      '--rerun-tasks',
      '--no-build-cache',
    ];
    const secretInvocation = resolveAndroidGradleWrapperInvocation({
      platform: 'win32',
      gradleArgs: secretGradleArgs,
    });
    expect(secretInvocation.args.join(' ')).toContain('safeSecret123');
    const safeLog = formatAndroidGradleCommandForLog({
      platform: 'win32',
      command: secretInvocation.command,
      gradleArgs: secretGradleArgs,
    });
    expect(safeLog).toContain('gradlew.bat app:bundleRelease');
    expect(safeLog).toContain('pocketAiUploadStorePassword=<redacted>');
    expect(safeLog).toContain('pocketAiUploadKeyPassword=<redacted>');
    expect(safeLog).not.toContain('safeSecret123');
    expect(safeLog).not.toContain('nestedSecret456');
  });

  it('finds external architecture and injected-signing overrides without exposing values', () => {
    const projectRoot = createProject();
    const userGradlePropertiesPath = path.join(projectRoot, 'private-gradle', 'gradle.properties');
    fs.mkdirSync(path.dirname(userGradlePropertiesPath), { recursive: true });

    try {
      expect(findGradleProjectPropertyOverride(projectRoot, 'reactNativeArchitectures', {
        env: {},
        gradleArgs: ['-Dorg.gradle.project.reactNativeArchitectures=x86_64'],
        userGradlePropertiesPath,
      })).toEqual({
        propertyName: 'reactNativeArchitectures',
        source: 'gradle-system-argument',
      });
      expect(findGradleProjectPropertyOverride(projectRoot, 'reactNativeArchitectures', {
        env: { GRADLE_OPTS: '-Dorg.gradle.project.reactNativeArchitectures=x86_64' },
        userGradlePropertiesPath,
      })).toEqual({
        propertyName: 'reactNativeArchitectures',
        source: 'gradle-system-environment',
      });

      expect(findGradleProjectPropertyOverride(projectRoot, 'reactNativeArchitectures', {
        env: {},
        gradleArgs: ['--project-prop', 'reactNativeArchitectures=x86_64'],
        userGradlePropertiesPath,
      })).toEqual({
        propertyName: 'reactNativeArchitectures',
        source: 'gradle-argument',
      });

      fs.writeFileSync(userGradlePropertiesPath, 'reactNativeArchitectures=arm64-v8a\n');
      expect(findGradleProjectPropertyOverride(projectRoot, 'reactNativeArchitectures', {
        env: {},
        userGradlePropertiesPath,
      })).toEqual({
        propertyName: 'reactNativeArchitectures',
        source: 'user-gradle-properties',
      });

      fs.writeFileSync(
        userGradlePropertiesPath,
        'org.gradle.project.reactNativeArchitectures=x86_64\n',
      );
      expect(findGradleProjectPropertyOverride(projectRoot, 'reactNativeArchitectures', {
        env: {},
        userGradlePropertiesPath,
      })).toEqual({
        propertyName: 'reactNativeArchitectures',
        source: 'user-gradle-properties-system-property',
      });

      fs.writeFileSync(userGradlePropertiesPath, 'privateValue=unchanged\n');
      expect(findGradleProjectPropertyOverride(projectRoot, 'reactNativeArchitectures', {
        env: { ORG_GRADLE_PROJECT_reactNativeArchitectures: 'x86_64' },
        userGradlePropertiesPath,
      })).toEqual({
        propertyName: 'reactNativeArchitectures',
        source: 'gradle-environment',
      });

      fs.writeFileSync(
        path.join(projectRoot, 'android', 'gradle.properties'),
        'reactNativeArchitectures=arm64-v8a,x86_64\n',
      );
      expect(findGradleProjectPropertyOverride(projectRoot, 'reactNativeArchitectures', {
        env: {},
        userGradlePropertiesPath,
      })).toBeNull();

      fs.writeFileSync(
        path.join(projectRoot, 'android', 'gradle.properties'),
        'systemProp.org.gradle.project.reactNativeArchitectures=x86_64\n',
      );
      expect(findGradleProjectPropertyOverride(projectRoot, 'reactNativeArchitectures', {
        env: {},
        userGradlePropertiesPath,
      })).toEqual({
        propertyName: 'reactNativeArchitectures',
        source: 'project-gradle-properties-system-property',
      });

      fs.writeFileSync(
        path.join(projectRoot, 'android', 'gradle.properties'),
        'org.gradle.jvmargs=-Xmx2g -Dorg.gradle.project.reactNativeArchitectures=x86_64\n',
      );
      expect(findGradleProjectPropertyOverride(projectRoot, 'reactNativeArchitectures', {
        env: {},
        userGradlePropertiesPath,
      })).toEqual({
        propertyName: 'reactNativeArchitectures',
        source: 'project-gradle-properties-system-property',
      });

      expect(findGradleProjectPropertyOverride(
        projectRoot,
        (propertyName) => propertyName.startsWith('android.injected.signing.'),
        {
          env: {},
          gradleArgs: ['-Pandroid.injected.signing.key.alias=private-alias'],
          userGradlePropertiesPath,
        },
      )).toEqual({
        propertyName: 'android.injected.signing.key.alias',
        source: 'gradle-argument',
      });
      expect(findGradleProjectPropertyOverride(
        projectRoot,
        (propertyName) => propertyName.startsWith('android.injected.signing.'),
        {
          env: { 'ORG_GRADLE_PROJECT_android.injected.signing.key.password': 'private-password' },
          userGradlePropertiesPath,
        },
      )).toEqual({
        propertyName: 'android.injected.signing.key.password',
        source: 'gradle-environment',
      });

      fs.writeFileSync(
        path.join(projectRoot, 'android', 'gradle.properties'),
        'android.injected.signing.store.file=private-upload.jks\n',
      );
      expect(findGradleProjectPropertyOverride(
        projectRoot,
        (propertyName) => propertyName.startsWith('android.injected.signing.'),
        { env: {}, userGradlePropertiesPath },
      )).toBeNull();
      expect(findGradleProjectPropertyOverride(
        projectRoot,
        (propertyName) => propertyName.startsWith('android.injected.signing.'),
        { env: {}, includeProject: true, userGradlePropertiesPath },
      )).toEqual({
        propertyName: 'android.injected.signing.store.file',
        source: 'project-gradle-properties',
      });
    } finally {
      fs.rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it('enforces canonical universal ABIs and rejects injected signing across all Gradle channels', () => {
    const projectRoot = createProject();
    const userGradlePropertiesPath = path.join(projectRoot, 'private-gradle', 'gradle.properties');
    fs.mkdirSync(path.dirname(userGradlePropertiesPath), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, 'android', 'gradle.properties'),
      `reactNativeArchitectures=${ANDROID_UNIVERSAL_ABIS.join(',')}\n`,
    );

    try {
      expect(() => assertAndroidBuildOverrideContract(projectRoot, {
        abi: 'universal',
        variant: 'release',
        env: {},
        userGradlePropertiesPath,
      })).not.toThrow();
      expect(() => assertAndroidBuildOverrideContract(projectRoot, {
        abi: 'universal',
        variant: 'release',
        env: {},
        gradleArgs: ['-Dorg.gradle.project.reactNativeArchitectures=x86_64'],
        userGradlePropertiesPath,
      })).toThrow(/reject external reactNativeArchitectures overrides/);
      expect(() => assertAndroidBuildOverrideContract(projectRoot, {
        abi: 'universal',
        variant: 'debug',
        env: {
          JAVA_TOOL_OPTIONS:
            '-Dorg.gradle.project.android.injected.signing.store.file=C:\\private\\debug.jks',
        },
        userGradlePropertiesPath,
      })).toThrow(/reject injected signing overrides/);
      expect(() => assertAndroidBuildOverrideContract(projectRoot, {
        abi: 'universal',
        variant: 'release',
        env: {
          _JAVA_OPTIONS: '-Dorg.gradle.project.reactNativeArchitectures=x86_64',
        },
        userGradlePropertiesPath,
      })).toThrow(/reject external reactNativeArchitectures overrides/);
      expect(() => assertAndroidBuildOverrideContract(projectRoot, {
        abi: 'universal',
        variant: 'release',
        env: {
          JDK_JAVA_OPTIONS:
            '-Dorg.gradle.project.android.injected.signing.key.alias=private',
        },
        userGradlePropertiesPath,
      })).toThrow(/reject injected signing overrides/);

      fs.writeFileSync(
        path.join(projectRoot, 'android', 'gradle.properties'),
        'reactNativeArchitectures=x86_64\n',
      );
      expect(() => assertAndroidBuildOverrideContract(projectRoot, {
        abi: 'universal',
        variant: 'release',
        env: {},
        userGradlePropertiesPath,
      })).toThrow(/canonical Android ABI set/);
    } finally {
      fs.rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it('rejects external Gradle homes and init scripts before provenance-aware builds', () => {
    const projectRoot = createProject();
    const userGradlePropertiesPath = path.join(projectRoot, 'private-gradle', 'gradle.properties');
    const externalRoot = path.join(projectRoot, 'external-gradle');
    const initScriptPath = path.join(externalRoot, 'override.gradle');
    const settingsPath = path.join(externalRoot, 'settings.gradle');
    fs.mkdirSync(path.dirname(userGradlePropertiesPath), { recursive: true });
    fs.mkdirSync(externalRoot, { recursive: true });
    fs.writeFileSync(userGradlePropertiesPath, 'privateValue=one\n');
    fs.writeFileSync(initScriptPath, 'allprojects { ext.fixture = "one" }\n');
    fs.writeFileSync(settingsPath, 'rootProject.name = "external"\n');
    fs.writeFileSync(
      path.join(projectRoot, 'android', 'gradle.properties'),
      `reactNativeArchitectures=${ANDROID_UNIVERSAL_ABIS.join(',')}\n`,
    );
    const rejectedGradleArgs = [
      ['-g', externalRoot],
      [`-g=${externalRoot}`],
      [`-g${externalRoot}`],
      ['--gradle-user-home', externalRoot],
      [`--gradle-user-home=${externalRoot}`],
      ['-I', initScriptPath],
      [`-I=${initScriptPath}`],
      [`-I${initScriptPath}`],
      ['--init-script', initScriptPath],
      [`--init-script=${initScriptPath}`],
      ['-c', settingsPath],
      [`-c=${settingsPath}`],
      ['--settings-file', settingsPath],
      [`--settings-file=${settingsPath}`],
      ['-b', initScriptPath],
      ['--build-file', initScriptPath],
      ['-p', externalRoot],
      [`--project-dir=${externalRoot}`],
      ['--include-build', externalRoot],
      [`--include-build=${externalRoot}`],
      ['@' + path.join(externalRoot, 'gradle.args')],
      ['-Dgradle.user.home=' + externalRoot],
      ['-D', 'gradle.user.home=' + externalRoot],
      ['--system-prop=gradle.user.home=' + externalRoot],
      ['--system-prop', 'gradle.user.home=' + externalRoot],
      ['-Dorg.gradle.jvmargs=-Dgradle.user.home=' + externalRoot],
    ];

    try {
      for (const gradleArgs of rejectedGradleArgs) {
        expect(() => assertAndroidBuildOverrideContract(projectRoot, {
          abi: 'universal',
          variant: 'release',
          env: {},
          gradleArgs,
          userGradlePropertiesPath,
        })).toThrow(
          /reject external (?:Gradle (?:user-home|init-script|build topology|argument-file)|JVM argument-file) overrides/
        );
      }
      for (const [environmentKey, environmentValue] of [
        ['GRADLE_OPTS', '-Dgradle.user.home=' + externalRoot],
        ['JAVA_OPTS', '-Dgradle.user.home=' + externalRoot],
        ['JAVA_TOOL_OPTIONS', '-Dgradle.user.home=' + externalRoot],
        ['_JAVA_OPTIONS', '-Dgradle.user.home=' + externalRoot],
        ['JDK_JAVA_OPTIONS', '-Dgradle.user.home=' + externalRoot],
        [
          'GRADLE_OPTS',
          '-Dorg.gradle.jvmargs=-Dorg.gradle.project.android.injected.version.code=999',
        ],
      ]) {
        const assertOverride = () => assertAndroidBuildOverrideContract(projectRoot, {
          abi: 'universal',
          variant: 'release',
          env: { [environmentKey]: environmentValue },
          userGradlePropertiesPath,
        });
        if (environmentValue.includes('android.injected.')) {
          expect(assertOverride).toThrow(/reject injected Android build overrides/);
        } else {
          expect(assertOverride).toThrow(/reject external Gradle user-home overrides/);
        }
      }

      const argumentFilePath = path.join(externalRoot, 'jvm.args');
      fs.writeFileSync(argumentFilePath, '-Dorg.gradle.project.android.injected.version.code=999\n');
      expect(() => assertAndroidBuildOverrideContract(projectRoot, {
        abi: 'universal',
        variant: 'release',
        env: { JDK_JAVA_OPTIONS: '@' + argumentFilePath },
        userGradlePropertiesPath,
      })).toThrow(/reject external JVM argument-file overrides/);
      fs.writeFileSync(argumentFilePath, '-Dorg.gradle.project.android.injected.version.code=1000\n');
      expect(() => assertAndroidBuildOverrideContract(projectRoot, {
        abi: 'universal',
        variant: 'release',
        env: { GRADLE_OPTS: '-Dorg.gradle.jvmargs=@' + argumentFilePath },
        userGradlePropertiesPath,
      })).toThrow(/reject external JVM argument-file overrides/);

      fs.writeFileSync(userGradlePropertiesPath, 'systemProp.gradle.user.home=external\n');
      expect(() => assertAndroidBuildOverrideContract(projectRoot, {
        abi: 'universal',
        variant: 'release',
        env: {},
        userGradlePropertiesPath,
      })).toThrow(/reject external Gradle user-home overrides/);
      fs.writeFileSync(
        userGradlePropertiesPath,
        'org.gradle.jvmargs=-Dgradle.user.home=external\n',
      );
      expect(() => assertAndroidBuildOverrideContract(projectRoot, {
        abi: 'universal',
        variant: 'release',
        env: {},
        userGradlePropertiesPath,
      })).toThrow(/reject external Gradle user-home overrides/);
      fs.writeFileSync(
        userGradlePropertiesPath,
        'systemProp.org.gradle.jvmargs=-Dgradle.user.home=external\n',
      );
      expect(() => assertAndroidBuildOverrideContract(projectRoot, {
        abi: 'universal',
        variant: 'release',
        env: {},
        userGradlePropertiesPath,
      })).toThrow(/reject external Gradle user-home overrides/);

      fs.writeFileSync(initScriptPath, 'allprojects { ext.fixture = "two" }\n');
      fs.writeFileSync(userGradlePropertiesPath, 'privateValue=unchanged\n');
      expect(() => assertAndroidBuildOverrideContract(projectRoot, {
        abi: 'universal',
        variant: 'release',
        env: {},
        gradleArgs: ['--init-script', initScriptPath],
        userGradlePropertiesPath,
      })).toThrow(/reject external Gradle init-script overrides/);

      const initDirectory = path.join(path.dirname(userGradlePropertiesPath), 'init.d');
      fs.mkdirSync(initDirectory, { recursive: true });
      fs.writeFileSync(path.join(initDirectory, 'injected.gradle'), 'allprojects {}\n');
      expect(() => assertAndroidBuildOverrideContract(projectRoot, {
        abi: 'universal',
        variant: 'release',
        env: {},
        userGradlePropertiesPath,
      })).toThrow(/reject Gradle user-home init scripts/);
    } finally {
      fs.rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it('rejects task exclusion, stale-dependency, and no-execution Gradle modes', () => {
    const projectRoot = createProject();
    const userGradlePropertiesPath = path.join(projectRoot, 'private-gradle', 'gradle.properties');
    const staleIntermediate = path.join(
      projectRoot,
      'android',
      'app',
      'build',
      'intermediates',
      'stale.bin',
    );
    fs.mkdirSync(path.dirname(userGradlePropertiesPath), { recursive: true });
    fs.mkdirSync(path.dirname(staleIntermediate), { recursive: true });
    fs.writeFileSync(userGradlePropertiesPath, 'privateValue=unchanged\n');
    fs.writeFileSync(staleIntermediate, 'stale-intermediate');
    fs.writeFileSync(
      path.join(projectRoot, 'android', 'gradle.properties'),
      `reactNativeArchitectures=${ANDROID_UNIVERSAL_ABIS.join(',')}\n`,
    );
    const rejectedModes = [
      ['-x', 'app:createBundleReleaseJsAndAssets'],
      ['-x=app:createBundleReleaseJsAndAssets'],
      ['-xapp:createBundleReleaseJsAndAssets'],
      ['--exclude-task', 'app:createBundleReleaseJsAndAssets'],
      ['--exclude-task=app:createBundleReleaseJsAndAssets'],
      ['-a'],
      ['--no-rebuild'],
      ['-m'],
      ['--dry-run'],
      ['-h'],
      ['--help'],
      ['-v'],
      ['--version'],
      ['--status'],
      ['--stop'],
      ['--tasks'],
      ['--properties'],
      ['--'],
      ['--build-cache'],
      ['--configuration-cache'],
      ['--no-rerun-tasks'],
    ];

    try {
      for (const gradleArgs of rejectedModes) {
        expect(() => assertAndroidBuildOverrideContract(projectRoot, {
          abi: 'universal',
          variant: 'release',
          env: {},
          gradleArgs,
          userGradlePropertiesPath,
        })).toThrow(/reject non-hermetic Gradle execution overrides/);
      }
      expect(fs.readFileSync(staleIntermediate, 'utf8')).toBe('stale-intermediate');
    } finally {
      fs.rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it('isolates provenance builds from setup-gradle init scripts and pins cache bypass flags', () => {
    const projectRoot = createProject();
    const setupGradleHome = path.join(projectRoot, 'setup-gradle-home');
    const setupGradleInitDirectory = path.join(setupGradleHome, 'init.d');
    fs.mkdirSync(setupGradleInitDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(setupGradleInitDirectory, 'gradle-actions.build-result-capture.init.gradle'),
      'allprojects {}\n',
    );
    fs.writeFileSync(
      path.join(projectRoot, 'android', 'gradle.properties'),
      `reactNativeArchitectures=${ANDROID_UNIVERSAL_ABIS.join(',')}\n`,
    );

    try {
      expect(() => assertAndroidBuildOverrideContract(projectRoot, {
        abi: 'universal',
        variant: 'release',
        env: { GRADLE_USER_HOME: setupGradleHome },
      })).toThrow(/reject Gradle user-home init scripts/);

      const isolatedEnvironment = createIsolatedAndroidBuildEnvironment(
        projectRoot,
        { GRADLE_USER_HOME: setupGradleHome },
        { NODE_ENV: 'production' },
      );
      expect(isolatedEnvironment).toEqual(expect.objectContaining({
        GRADLE_USER_HOME: path.join(
          projectRoot,
          'node_modules',
          '.cache',
          'pocket-ai-android',
          'gradle-user-home',
        ),
        NODE_ENV: 'production',
      }));
      expect(isolatedEnvironment.GRADLE_USER_HOME).not.toBe(setupGradleHome);
      expect(() => assertAndroidBuildOverrideContract(projectRoot, {
        abi: 'universal',
        variant: 'release',
        env: isolatedEnvironment,
      })).not.toThrow();
      expect(withAndroidProvenanceGradleExecutionArgs(['app:assembleRelease']))
        .toEqual(['app:assembleRelease', ...ANDROID_PROVENANCE_GRADLE_EXECUTION_ARGS]);
      expect(ANDROID_PROVENANCE_GRADLE_EXECUTION_ARGS).toEqual([
        '--rerun-tasks',
        '--no-build-cache',
        '--no-configuration-cache',
      ]);
    } finally {
      fs.rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it('rejects external JVM code-loading across arguments, environment, and property files', () => {
    const projectRoot = createProject();
    const userGradlePropertiesPath = path.join(projectRoot, 'private-gradle', 'gradle.properties');
    const agentPath = path.join(projectRoot, 'external-gradle', 'mutator.jar');
    fs.mkdirSync(path.dirname(userGradlePropertiesPath), { recursive: true });
    fs.mkdirSync(path.dirname(agentPath), { recursive: true });
    fs.writeFileSync(agentPath, 'agent-version-one');
    fs.writeFileSync(
      path.join(projectRoot, 'android', 'gradle.properties'),
      `reactNativeArchitectures=${ANDROID_UNIVERSAL_ABIS.join(',')}\n`,
    );
    const expectRejected = (options) => expect(() => assertAndroidBuildOverrideContract(
      projectRoot,
      {
        abi: 'universal',
        variant: 'release',
        userGradlePropertiesPath,
        ...options,
      },
    )).toThrow(/reject JVM code-loading overrides/);

    try {
      expectRejected({
        env: {},
        gradleArgs: [`-Dorg.gradle.jvmargs=-javaagent:${agentPath}`],
      });
      expectRejected({
        env: { GRADLE_OPTS: `-Dorg.gradle.jvmargs=-agentpath:${agentPath}` },
      });
      expectRejected({ env: { JAVA_TOOL_OPTIONS: `-javaagent:${agentPath}` } });
      expectRejected({ env: { JAVA_OPTS: '-agentlib:jdwp=transport=dt_socket' } });
      expectRejected({ env: { _JAVA_OPTIONS: '-Xrunjdwp:transport=dt_socket' } });
      expectRejected({ env: { JDK_JAVA_OPTIONS: `-Xbootclasspath/a:${agentPath}` } });

      fs.writeFileSync(userGradlePropertiesPath, `org.gradle.jvmargs=-javaagent:${agentPath}\n`);
      expectRejected({ env: {} });
      fs.writeFileSync(
        userGradlePropertiesPath,
        `systemProp.org.gradle.jvmargs=-agentpath:${agentPath}\n`,
      );
      expectRejected({ env: {} });

      fs.writeFileSync(agentPath, 'agent-version-two');
      expectRejected({ env: { JAVA_TOOL_OPTIONS: `-javaagent:${agentPath}` } });
    } finally {
      fs.rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it('applies build guards after decoding escaped and continued Gradle properties', () => {
    const projectRoot = createProject();
    const userGradlePropertiesPath = path.join(projectRoot, 'private-gradle', 'gradle.properties');
    const agentPath = path.join(projectRoot, 'external-gradle', 'mutator.jar');
    fs.mkdirSync(path.dirname(userGradlePropertiesPath), { recursive: true });
    fs.mkdirSync(path.dirname(agentPath), { recursive: true });
    fs.writeFileSync(agentPath, 'agent');
    fs.writeFileSync(
      path.join(projectRoot, 'android', 'gradle.properties'),
      `reactNativeArchitectures=${ANDROID_UNIVERSAL_ABIS.join(',')}\n`,
    );
    const assertBuild = () => assertAndroidBuildOverrideContract(projectRoot, {
      abi: 'universal',
      variant: 'release',
      env: {},
      userGradlePropertiesPath,
    });

    try {
      fs.writeFileSync(
        userGradlePropertiesPath,
        String.raw`org.gradle.jvmargs -javaag\u0065nt:${agentPath}`,
      );
      expect(assertBuild).toThrow(/reject JVM code-loading overrides/);

      fs.writeFileSync(userGradlePropertiesPath, [
        'org.gradle.jvmargs=-javaag' + '\\',
        `  ent:${agentPath}`,
      ].join('\n'));
      expect(assertBuild).toThrow(/reject JVM code-loading overrides/);

      fs.writeFileSync(
        userGradlePropertiesPath,
        String.raw`systemProp.org.gradle.project.android.inj\u0065cted.version.code 999`,
      );
      expect(assertBuild).toThrow(/reject injected Android build overrides/);

      fs.writeFileSync(userGradlePropertiesPath, 'privateValue=unchanged\n');
      fs.writeFileSync(
        path.join(projectRoot, 'android', 'gradle.properties'),
        String.raw`reactNativeArchit\u0065ctures x86_64`,
      );
      expect(assertBuild).toThrow(/canonical Android ABI set/);
    } finally {
      fs.rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it('rejects every externally injected Android artifact override channel', () => {
    const projectRoot = createProject();
    const userGradlePropertiesPath = path.join(projectRoot, 'private-gradle', 'gradle.properties');
    fs.mkdirSync(path.dirname(userGradlePropertiesPath), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, 'android', 'gradle.properties'),
      `reactNativeArchitectures=${ANDROID_UNIVERSAL_ABIS.join(',')}\n`,
    );

    try {
      expect(() => assertAndroidBuildOverrideContract(projectRoot, {
        abi: 'universal',
        variant: 'release',
        env: {},
        gradleArgs: ['-Pandroid.injected.version.code=999'],
        userGradlePropertiesPath,
      })).toThrow(/reject injected Android build overrides/);
      expect(() => assertAndroidBuildOverrideContract(projectRoot, {
        abi: 'universal',
        variant: 'release',
        env: {},
        gradleArgs: ['-Dorg.gradle.project.android.injected.version.name=private'],
        userGradlePropertiesPath,
      })).toThrow(/reject injected Android build overrides/);
      expect(() => assertAndroidBuildOverrideContract(projectRoot, {
        abi: 'universal',
        variant: 'release',
        env: {},
        gradleArgs: [
          '-Dorg.gradle.jvmargs=-Dorg.gradle.project.android.injected.version.code=999',
        ],
        userGradlePropertiesPath,
      })).toThrow(/reject injected Android build overrides/);
      expect(() => assertAndroidBuildOverrideContract(projectRoot, {
        abi: 'universal',
        variant: 'release',
        env: { 'ORG_GRADLE_PROJECT_android.injected.testOnly': 'true' },
        userGradlePropertiesPath,
      })).toThrow(/reject injected Android build overrides/);

      fs.writeFileSync(userGradlePropertiesPath, 'android.injected.apk.location=external\n');
      expect(() => assertAndroidBuildOverrideContract(projectRoot, {
        abi: 'universal',
        variant: 'release',
        env: {},
        userGradlePropertiesPath,
      })).toThrow(/reject injected Android build overrides/);

      fs.writeFileSync(userGradlePropertiesPath, 'android.buildOnlyTargetAbi=true\n');
      expect(() => assertAndroidBuildOverrideContract(projectRoot, {
        abi: 'universal',
        variant: 'release',
        env: {},
        userGradlePropertiesPath,
      })).toThrow(/reject injected Android build overrides/);

      fs.writeFileSync(userGradlePropertiesPath, 'privateValue=unchanged\n');
      fs.writeFileSync(
        path.join(projectRoot, 'android', 'gradle.properties'),
        [
          `reactNativeArchitectures=${ANDROID_UNIVERSAL_ABIS.join(',')}`,
          'android.injected.build.abi=x86_64',
        ].join('\n'),
      );
      expect(() => assertAndroidBuildOverrideContract(projectRoot, {
        abi: 'universal',
        variant: 'release',
        env: {},
        userGradlePropertiesPath,
      })).toThrow(/reject injected Android build overrides/);
    } finally {
      fs.rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it('uses separate build stamps for variants and ABIs', () => {
    const cacheRoot = path.join('artifacts', '.cache');
    expect(resolveBuildStampPath(cacheRoot, 'debug', 'x86_64')).toContain('android-build-debug-x86_64.json');
    expect(resolveBuildStampPath(cacheRoot, 'release', 'arm64-v8a')).toContain('android-build-release-arm64-v8a.json');
    expect(resolvePrebuildStampPaths(cacheRoot, 'debug')).toEqual({
      activeStampPath: path.join(cacheRoot, 'android-prebuild-active.json'),
      variantStampPath: path.join(cacheRoot, 'android-prebuild-debug.json'),
    });
    expect(resolvePrebuildStampPaths(cacheRoot, 'release')).toEqual({
      activeStampPath: path.join(cacheRoot, 'android-prebuild-active.json'),
      variantStampPath: path.join(cacheRoot, 'android-prebuild-release.json'),
    });
  });

  it('binds release provenance only to exact app release tasks, never a stale artifact from another task', () => {
    const projectRoot = createProject();
    const staleReleaseApk = path.join(
      projectRoot,
      'android',
      'app',
      'build',
      'outputs',
      'apk',
      'release',
      'app-release.apk',
    );
    fs.mkdirSync(path.dirname(staleReleaseApk), { recursive: true });
    fs.writeFileSync(staleReleaseApk, 'stale-release-artifact');

    try {
      expect(() => resolveAndroidReleaseTaskContract('assembleDebug'))
        .toThrow(/Unsupported Android release task/);
      expect(() => resolveAndroidReleaseTaskContract(':other:assembleRelease'))
        .toThrow(/Unsupported Android release task/);
      expect(() => resolveAndroidReleaseTaskContract(':assembleRelease'))
        .toThrow(/Unsupported Android release task/);
      expect(() => resolveAndroidReleaseTaskContract('assembleRelease'))
        .toThrow(/Unsupported Android release task/);
      expect(() => resolveAndroidReleaseTaskContract('bundleRelease'))
        .toThrow(/Unsupported Android release task/);
      expect(fs.readFileSync(staleReleaseApk, 'utf8')).toBe('stale-release-artifact');
      expect(resolveAndroidReleaseTaskContract('app:assembleRelease')).toEqual({
        artifactPath: 'android/app/build/outputs/apk/release/app-release.apk',
        artifactType: 'apk',
        gradleTask: 'app:assembleRelease',
        module: 'app',
        shouldBumpVersionCode: false,
        variant: 'release',
      });
      expect(resolveAndroidReleaseTaskContract(':app:bundleRelease')).toEqual({
        artifactPath: 'android/app/build/outputs/bundle/release/app-release.aab',
        artifactType: 'aab',
        gradleTask: ':app:bundleRelease',
        module: 'app',
        shouldBumpVersionCode: true,
        variant: 'release',
      });

      const provenancePath = path.join(projectRoot, 'artifacts', 'android-release', 'provenance.json');
      fs.mkdirSync(path.dirname(provenancePath), { recursive: true });
      fs.writeFileSync(provenancePath, '{"stale":true}\n');
      const preparedArtifactPath = prepareAndroidReleaseArtifactOutput(
        projectRoot,
        resolveAndroidReleaseTaskContract('app:assembleRelease'),
        { provenancePath },
      );
      expect(preparedArtifactPath).toBe(staleReleaseApk);
      expect(fs.existsSync(staleReleaseApk)).toBe(false);
      expect(fs.existsSync(provenancePath)).toBe(false);
      expect(() => assertAndroidReleaseArtifactCreated(preparedArtifactPath))
        .toThrow(/without producing a fresh release artifact/);

      const releaseTaskContract = resolveAndroidReleaseTaskContract('app:assembleRelease');
      for (const failureMessage of [
        'Gradle failed after writing an artifact',
        'post-build provenance mismatch',
      ]) {
        expect(() => runAndroidReleaseArtifactTransaction(
          projectRoot,
          releaseTaskContract,
          { provenancePath },
          (artifactPath) => {
            fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
            fs.writeFileSync(artifactPath, 'unverified-release-artifact');
            fs.writeFileSync(provenancePath, '{"incomplete":true}\n');
            throw new Error(failureMessage);
          },
        )).toThrow(failureMessage);
        expect(fs.existsSync(staleReleaseApk)).toBe(false);
        expect(fs.existsSync(provenancePath)).toBe(false);
      }
      fs.writeFileSync(preparedArtifactPath, 'fresh-release-artifact');
      expect(() => assertAndroidReleaseArtifactCreated(preparedArtifactPath)).not.toThrow();
    } finally {
      fs.rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it('resolves Expo through the Node executable with explicit argv even when paths contain spaces', () => {
    const invocation = resolveExpoCliInvocation('C:\\repo with spaces', {
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
      resolveModule: (request) => {
        expect(request).toBe('expo/bin/cli');
        return 'C:\\repo with spaces\\node_modules\\expo\\bin\\cli';
      },
    });

    expect(invocation).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\repo with spaces\\node_modules\\expo\\bin\\cli'],
    });
    expect(invocation.command).not.toMatch(/npx(?:\.cmd)?$/i);
  });

  it('executes a resolved Expo CLI under a path with spaces without shell quoting', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket ai expo cli '));
    const expoRoot = path.join(projectRoot, 'node_modules', 'expo');
    const expoCliPath = path.join(expoRoot, 'bin', 'cli.js');
    fs.mkdirSync(path.dirname(expoCliPath), { recursive: true });
    fs.writeFileSync(
      path.join(expoRoot, 'package.json'),
      JSON.stringify({ name: 'expo', version: '1.0.0' }),
    );
    fs.writeFileSync(
      expoCliPath,
      "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n",
    );

    try {
      expect(projectRoot).toMatch(/\s/u);
      const invocation = resolveExpoCliInvocation(projectRoot);
      const cliArgs = buildAndroidCleanPrebuildArgs();
      const result = spawnSync(
        invocation.command,
        [...invocation.args, ...cliArgs],
        {
          cwd: projectRoot,
          encoding: 'utf8',
          shell: false,
          windowsHide: true,
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(cliArgs).toEqual([
        'prebuild',
        '--clean',
        '--platform',
        'android',
        '--no-install',
      ]);
      expect(JSON.parse(result.stdout)).toEqual({
        argv: cliArgs,
        cwd: projectRoot,
      });
    } finally {
      fs.rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it('redacts secret Gradle values while preserving non-sensitive release arguments', () => {
    const redacted = redactCommandArgsForLog([
      'bundleRelease',
      '-Pandroid.injected.signing.store.password=hunter2',
      '-PpocketAiUploadStoreFile=C:\\private\\upload.keystore',
      '-Pandroid.injected.signing.store.file=C:\\private\\injected.keystore',
      '-Pandroid.injected.signing.key.alias=release-key',
      '--token',
      'hf_private',
      '--project-prop=pocketAiUploadStoreFile=C:\\private\\nested.keystore',
      '--project-prop=pocketAiUploadKeyAlias=nested-release-key',
      '--project-prop=android.injected.signing.store.password=nested-password',
      '--system-prop=org.gradle.project.android.injected.signing.key.password=system-password',
      '-Dorg.gradle.project.android.injected.signing.store.file=C:\\private\\system.keystore',
      '-Dorg.gradle.jvmargs=-Dorg.gradle.project.pocketAiUploadStorePassword=supersecret -Dfile.encoding=UTF-8',
      '--system-prop',
      'org.gradle.jvmargs=-Dorg.gradle.project.pocketAiUploadKeyPassword=split-secret -Xmx2g',
      '--system-prop=org.gradle.jvmargs="-Dorg.gradle.project.android.injected.signing.store.password=quoted-secret -Xmx3g"',
      '-Dorg.gradle.jvmargs=-Dorg.gradle.jvmargs=-Dorg.gradle.project.pocketAiUploadKeyPassword=deep-secret',
      '-PpocketAiVersionCode=42',
    ]);
    expect(redacted).toEqual([
      'bundleRelease',
      '-Pandroid.injected.signing.store.password=<redacted>',
      '-PpocketAiUploadStoreFile=<redacted>',
      '-Pandroid.injected.signing.store.file=<redacted>',
      '-Pandroid.injected.signing.key.alias=<redacted>',
      '--token',
      '<redacted>',
      '--project-prop=pocketAiUploadStoreFile=<redacted>',
      '--project-prop=pocketAiUploadKeyAlias=<redacted>',
      '--project-prop=android.injected.signing.store.password=<redacted>',
      '--system-prop=org.gradle.project.android.injected.signing.key.password=<redacted>',
      '-Dorg.gradle.project.android.injected.signing.store.file=<redacted>',
      '-Dorg.gradle.jvmargs=-Dorg.gradle.project.pocketAiUploadStorePassword=<redacted> -Dfile.encoding=UTF-8',
      '--system-prop',
      'org.gradle.jvmargs=-Dorg.gradle.project.pocketAiUploadKeyPassword=<redacted> -Xmx2g',
      '--system-prop=org.gradle.jvmargs=-Dorg.gradle.project.android.injected.signing.store.password=<redacted>',
      '-Dorg.gradle.jvmargs=-Dorg.gradle.jvmargs=-Dorg.gradle.project.pocketAiUploadKeyPassword=<redacted>',
      '-PpocketAiVersionCode=42',
    ]);
    const serialized = redacted.join(' ');
    for (const secret of ['supersecret', 'split-secret', 'quoted-secret', 'deep-secret']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('normalizes local shipping mode and rejects effective Expo QA evidence', () => {
    const projectRoot = createProject();
    const productionEnvPath = path.join(projectRoot, '.env.production');

    try {
      const normalized = createAndroidShippingBuildEnvironment(
        projectRoot,
        { NODE_ENV: 'test' },
        { forceProductionNodeEnv: true },
      );
      expect(normalized).toEqual(expect.objectContaining({
        NODE_ENV: 'production',
        POCKET_AI_SHIPPING_BUILD: '1',
      }));
      expect(normalized.EXPO_PUBLIC_ANDROID_QA).toBeUndefined();

      expect(() => createAndroidShippingBuildEnvironment(
        projectRoot,
        { NODE_ENV: 'production', EXPO_PUBLIC_ANDROID_QA: '1' },
      )).toThrow(/reject EXPO_PUBLIC_ANDROID_QA=1/);
      expect(() => createAndroidShippingBuildEnvironment(
        projectRoot,
        { NODE_ENV: 'test' },
      )).toThrow(/require NODE_ENV=production/);

      fs.writeFileSync(productionEnvPath, 'EXPO_PUBLIC_ANDROID_QA=1\n');
      expect(() => createAndroidShippingBuildEnvironment(
        projectRoot,
        { NODE_ENV: 'test' },
        { forceProductionNodeEnv: true },
      )).toThrow(/reject EXPO_PUBLIC_ANDROID_QA=1/);
      expect(createAndroidShippingBuildEnvironment(
        projectRoot,
        { NODE_ENV: 'production', EXPO_PUBLIC_ANDROID_QA: '0' },
      ).EXPO_PUBLIC_ANDROID_QA).toBe('0');
    } finally {
      fs.rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it('accepts shipping APK and AAB native payloads only for the exact runnable ABI contract', () => {
    const entriesFor = (prefix) => ANDROID_UNIVERSAL_ABIS.flatMap((abi) => (
      ANDROID_REQUIRED_NATIVE_LIBRARIES_BY_ABI[abi]
        .map((library) => `${prefix}${abi}/${library}`)
    ));

    expect(inspectAndroidArtifactNativeEntries(entriesFor('lib/'), 'apk')).toEqual({
      nativeLibrariesVerified: true,
      packagedAbis: ['arm64-v8a', 'x86_64'],
    });
    expect(inspectAndroidArtifactNativeEntries(entriesFor('base/lib/'), 'aab')).toEqual({
      nativeLibrariesVerified: true,
      packagedAbis: ['arm64-v8a', 'x86_64'],
    });
    expect(() => inspectAndroidArtifactNativeEntries([
      ...entriesFor('base/lib/'),
      'base/lib/x86/libreactnative.so',
    ], 'aab')).toThrow(/exactly the canonical Android ABI set/);
    expect(() => inspectAndroidArtifactNativeEntries(
      entriesFor('lib/').filter((entry) => entry !== 'lib/x86_64/librnllama_jni.so'),
      'apk',
    )).toThrow(/missing required React Native or llama\.rn libraries/);
  });

  it('guards the EAS production profile and wires the public ABI contract', () => {
    const projectRoot = createProject();
    const guardPlugin = require('../../plugins/withAndroidQaReleaseGuard');
    const appConfig = require('../../app.json');
    const easConfig = require('../../eas.json');
    const guardConfig = { _internal: { projectRoot } };

    try {
      expect(guardPlugin._internal.isAndroidShippingBuild({ EAS_BUILD_PROFILE: 'production' }))
        .toBe(true);
      expect(guardPlugin._internal.isAndroidShippingBuild({ POCKET_AI_SHIPPING_BUILD: '1' }))
        .toBe(true);
      expect(guardPlugin._internal.assertAndroidQaReleaseGuard(
        guardConfig,
        { NODE_ENV: 'test', EXPO_PUBLIC_ANDROID_QA: '1' },
      )).toBeNull();
      expect(() => guardPlugin._internal.assertAndroidQaReleaseGuard(
        guardConfig,
        {
          EAS_BUILD_PROFILE: 'production',
          NODE_ENV: 'production',
          EXPO_PUBLIC_ANDROID_QA: '1',
        },
      )).toThrow(/reject EXPO_PUBLIC_ANDROID_QA=1/);
      expect(() => guardPlugin._internal.assertAndroidQaReleaseGuard(
        guardConfig,
        { EAS_BUILD_PROFILE: 'production', NODE_ENV: 'test' },
      )).toThrow(/require NODE_ENV=production/);

      expect(appConfig.expo.plugins[0]).toBe('./plugins/withAndroidQaReleaseGuard');
      const buildProperties = appConfig.expo.plugins.find(
        (plugin) => Array.isArray(plugin) && plugin[0] === 'expo-build-properties',
      );
      expect(buildProperties?.[1]?.android?.buildArchs).toEqual(ANDROID_UNIVERSAL_ABIS);
      expect(easConfig.build.production.env).toEqual(expect.objectContaining({
        NODE_ENV: 'production',
        POCKET_AI_SHIPPING_BUILD: '1',
      }));
    } finally {
      fs.rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it('invalidates generated native state across input, output, variant, schema, and crash boundaries', () => {
    const current = {
      schemaVersion: BUILD_PROVENANCE_SCHEMA_VERSION,
      variant: 'release',
      inputDigest: 'plugins-2',
      nativeInputDigest: 'native-2',
    };
    const inputState = { digest: 'plugins-2' };
    const nativeProjectState = { digest: 'native-2' };

    expect(shouldRunPrebuild({
      gradleWrapperExists: true,
      activeStamp: current,
      inputState,
      nativeProjectState,
      variant: 'release',
    })).toBe(false);
    expect(shouldRunPrebuild({
      gradleWrapperExists: true,
      activeStamp: { ...current, inputDigest: 'plugins-1' },
      inputState,
      nativeProjectState,
      variant: 'release',
    })).toBe(true);
    expect(shouldRunPrebuild({
      gradleWrapperExists: true,
      activeStamp: { ...current, schemaVersion: BUILD_PROVENANCE_SCHEMA_VERSION - 1 },
      inputState,
      nativeProjectState,
      variant: 'release',
    })).toBe(true);
    expect(shouldRunPrebuild({
      gradleWrapperExists: true,
      activeStamp: { ...current, nativeInputDigest: 'native-1' },
      inputState,
      nativeProjectState,
      variant: 'release',
    })).toBe(true);
    expect(shouldRunPrebuild({
      gradleWrapperExists: true,
      activeStamp: current,
      inputState,
      nativeProjectState,
      variant: 'debug',
    })).toBe(true);
    for (const interruptedState of [
      { gradleWrapperExists: false, activeStamp: current },
      { gradleWrapperExists: true, activeStamp: null },
    ]) {
      expect(shouldRunPrebuild({
        ...interruptedState,
        inputState,
        nativeProjectState,
        variant: 'release',
      })).toBe(true);
    }
  });

  it('records only the resolved Java version without publishing JVM option channels', () => {
    const projectRoot = createProject();
    const sentinel = 'sentinel-do-not-publish';
    const javaSpawn = jest.fn(() => ({
      status: 0,
      stdout: '',
      stderr: [
        `Picked up JAVA_TOOL_OPTIONS: -Dpocket.ai.reviewSecret=${sentinel}`,
        'openjdk version "17.0.14" 2025-01-21',
        'OpenJDK Runtime Environment Temurin-17',
      ].join('\n'),
    }));

    try {
      const javaVersion = readJavaVersion({
        env: {
          PATH: 'C:\\Windows\\System32',
          Java_Tool_Options: `-Dpocket.ai.reviewSecret=${sentinel}`,
          _JAVA_OPTIONS: `-Dpocket.ai.reviewSecret=${sentinel}`,
          JDK_JAVA_OPTIONS: `-Dpocket.ai.reviewSecret=${sentinel}`,
        },
        javaCommand: 'C:\\Java Home\\bin\\java.exe',
        spawnSync: javaSpawn,
      });
      expect(javaVersion).toBe('openjdk version "17.0.14" 2025-01-21');
      expect(javaVersion).not.toContain(sentinel);
      expect(javaSpawn).toHaveBeenCalledWith(
        'C:\\Java Home\\bin\\java.exe',
        ['-version'],
        expect.objectContaining({
          encoding: 'utf8',
          env: { PATH: 'C:\\Windows\\System32' },
        }),
      );
      expect(readGradleWrapperVersion(path.join(projectRoot, 'android'))).toEqual({
        distributionType: 'bin',
        version: '8.14.3',
      });
    } finally {
      fs.rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it('publishes no Gradle wrapper URL credentials or query tokens', () => {
    const projectRoot = createProject();
    const sentinel = 'sentinel-do-not-publish';
    const wrapperPropertiesPath = path.join(
      projectRoot,
      'android',
      'gradle',
      'wrapper',
      'gradle-wrapper.properties',
    );
    fs.writeFileSync(
      wrapperPropertiesPath,
      `distributionUrl=https\\://private-user:private-password@example.invalid/distributions/gradle-8.14.3-bin.zip?token=${sentinel}#private-fragment\n`,
    );

    try {
      const wrapperVersion = readGradleWrapperVersion(path.join(projectRoot, 'android'));
      expect(wrapperVersion).toEqual({ distributionType: 'bin', version: '8.14.3' });
      expect(JSON.stringify(wrapperVersion)).not.toMatch(
        /private-user|private-password|sentinel-do-not-publish|private-fragment/,
      );
    } finally {
      fs.rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it('does not echo Java probe output when version resolution fails', () => {
    const sentinel = 'sentinel-do-not-publish';
    const readFailedVersion = () => readJavaVersion({
      javaCommand: 'java',
      spawnSync: jest.fn(() => ({
        status: 1,
        stdout: '',
        stderr: `Picked up JAVA_TOOL_OPTIONS: -Dsecret=${sentinel}`,
      })),
    });

    expect(readFailedVersion).toThrow('Java exited with status 1');
    try {
      readFailedVersion();
    } catch (error) {
      expect(error.message).not.toContain(sentinel);
    }
  });

  it('wires the release builder to resolved Expo prebuild and content-hashed artifacts', () => {
    const releaseBuilderPath = path.join(
      __dirname,
      '..',
      '..',
      'scripts',
      'build-android-release.js',
    );
    const releaseBuilder = fs.readFileSync(releaseBuilderPath, 'utf8');
    const smokeRunner = fs.readFileSync(
      path.join(__dirname, '..', '..', 'scripts', 'android-smoke.js'),
      'utf8',
    );
    const appConfigPath = path.join(__dirname, '..', '..', 'app.json');
    const appConfigBeforeRejectedInvocations = fs.readFileSync(appConfigPath, 'utf8');
    const rejectedDebugTask = spawnSync(
      process.execPath,
      [releaseBuilderPath, '--task', 'assembleDebug', '--no-bump'],
      { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8' },
    );

    expect(rejectedDebugTask.status).not.toBe(0);
    expect(`${rejectedDebugTask.stdout}\n${rejectedDebugTask.stderr}`)
      .toContain('Unsupported Android release task "assembleDebug"');
    const rejectedQaRelease = spawnSync(
      process.execPath,
      [releaseBuilderPath, '--task', 'assembleDebug', '--no-bump'],
      {
        cwd: path.join(__dirname, '..', '..'),
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_ENV: 'test',
          EXPO_PUBLIC_ANDROID_QA: '1',
        },
      },
    );
    expect(rejectedQaRelease.status).not.toBe(0);
    expect(`${rejectedQaRelease.stdout}\n${rejectedQaRelease.stderr}`)
      .toContain('reject EXPO_PUBLIC_ANDROID_QA=1');
    for (const invalidInvocation of [
      {
        args: ['--task', '--no-bump'],
        message: '--task requires a value',
      },
      {
        args: ['--version-name', '--no-bump'],
        message: '--version-name requires a value',
      },
      {
        args: ['--version-code'],
        message: '--version-code requires a value',
      },
      {
        args: ['--version-code', '42junk'],
        message: 'Android versionCode must be a positive integer',
      },
      {
        args: ['--version-code', '9007199254740992'],
        message: 'Android versionCode must be a safe positive integer',
      },
      {
        args: ['--version-code', '2100000001'],
        message: 'Android versionCode must not exceed the Android publication limit',
      },
      {
        args: ['--version-code', '2100000000'],
        message: 'Cannot auto-reserve an Android versionCode after the publication limit',
      },
    ]) {
      const rejectedInvocation = spawnSync(
        process.execPath,
        [releaseBuilderPath, ...invalidInvocation.args],
        { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8' },
      );
      expect(rejectedInvocation.status).not.toBe(0);
      expect(`${rejectedInvocation.stdout}\n${rejectedInvocation.stderr}`)
        .toContain(invalidInvocation.message);
    }
    expect(fs.readFileSync(appConfigPath, 'utf8')).toBe(appConfigBeforeRejectedInvocations);
    expect(releaseBuilder).toContain('resolveExpoCliInvocation(projectRoot)');
    expect(releaseBuilder).toContain('[...expoCli.args, ...buildAndroidCleanPrebuildArgs()]');
    expect(smokeRunner).toContain('[...expoCli.args, ...buildAndroidCleanPrebuildArgs()]');
    expect(releaseBuilder).not.toContain('"prebuild", "--platform", "android", "--no-install"');
    expect(smokeRunner).not.toContain('"prebuild", "--platform", "android", "--no-install"');
    for (const [source, writeVariantStamp, writeActiveStamp] of [
      [
        releaseBuilder,
        'writeJsonAtomic(prebuildStampPath, verifiedPrebuildStamp);',
        'writeJsonAtomic(activePrebuildStampPath, verifiedPrebuildStamp);',
      ],
      [
        smokeRunner,
        'writeJsonFile(prebuildStampPath, verifiedPrebuildStamp);',
        'writeJsonFile(activePrebuildStampPath, verifiedPrebuildStamp);',
      ],
    ]) {
      const invalidationIndex = source.indexOf('fs.rmSync(activePrebuildStampPath, { force: true });');
      const prebuildIndex = source.indexOf('[...expoCli.args, ...buildAndroidCleanPrebuildArgs()]');
      const variantStampIndex = source.indexOf(writeVariantStamp);
      const activeStampIndex = source.indexOf(writeActiveStamp);
      expect(invalidationIndex).toBeGreaterThanOrEqual(0);
      expect(prebuildIndex).toBeGreaterThan(invalidationIndex);
      expect(variantStampIndex).toBeGreaterThan(prebuildIndex);
      expect(activeStampIndex).toBeGreaterThan(variantStampIndex);
    }
    expect(releaseBuilder).toContain('collectBuildProvenance(projectRoot');
    expect(releaseBuilder).toContain('createFileContentFingerprint(releaseArtifactPath');
    expect(releaseBuilder).toContain('build-provenance-release-universal.json');
    expect(releaseBuilder).toContain('fs.chmodSync(gradleWrapper, 0o755)');
    expect(releaseBuilder).toContain('parseGradleProjectProperties(gradleArgs)');
    expect(releaseBuilder).toContain('assertAndroidBuildOverrideContract(projectRoot');
    expect(releaseBuilder).toContain('const releaseTaskContract = resolveAndroidReleaseTaskContract(task)');
    expect(releaseBuilder).toContain('runAndroidReleaseArtifactTransaction(');
    expect(releaseBuilder).toContain('assertAndroidReleaseArtifactCreated(releaseArtifactPath)');
    expect(releaseBuilder).toContain('inspectAndroidArtifactNativeLibraries(');
    expect(releaseBuilder).toContain('...nativeArtifactInspection');
    const transactionCallIndex = releaseBuilder.lastIndexOf('\nrunAndroidReleaseArtifactTransaction(');
    const finalGuardIndex = releaseBuilder.lastIndexOf(
      'assertAndroidBuildOverrideContract(projectRoot',
      transactionCallIndex,
    );
    const releaseSpawnIndex = releaseBuilder.indexOf(
      'spawnSync(command, commandArgs',
      transactionCallIndex,
    );
    expect(finalGuardIndex).toBeGreaterThanOrEqual(0);
    expect(finalGuardIndex).toBeLessThan(transactionCallIndex);
    expect(transactionCallIndex).toBeLessThan(releaseSpawnIndex);
    expect(releaseBuilder.indexOf('const releaseTaskContract = resolveAndroidReleaseTaskContract(task)'))
      .toBeLessThan(releaseBuilder.indexOf('spawnSync('));
    expect(releaseBuilder).not.toContain('normalizedTask.includes("assemble")');
    expect(releaseBuilder).not.toContain('normalizedTask.includes("bundle")');
    expect(releaseBuilder.match(/assertAndroidBuildOverrideContract\(projectRoot/g)).toHaveLength(3);
    expect(releaseBuilder).toContain('Do not override ${reservedProperty} through raw Gradle arguments');
    expect(releaseBuilder).toContain(
      'const releaseGradleExecutionArgs = withAndroidProvenanceGradleExecutionArgs([',
    );
    expect(releaseBuilder).toContain('resolveAndroidGradleWrapperInvocation({');
    expect(releaseBuilder).toContain('gradleArgs: releaseGradleExecutionArgs');
    expect(releaseBuilder).toContain('createIsolatedAndroidBuildEnvironment(');
    expect(releaseBuilder).toContain('createAndroidShippingBuildEnvironment(projectRoot, process.env');
    expect(releaseBuilder).toContain('forceProductionNodeEnv: true');
    expect(releaseBuilder.match(/androidQaEvidence: false/g)).toHaveLength(2);
    expect(releaseBuilder).toContain('collectReleaseBuildContext(postBuildPrebuildInputState.digest)');
    expect(releaseBuilder).toMatch(/if \(postBuildProvenance\.digest !== buildProvenance\.digest\)/u);
    expect(releaseBuilder).not.toMatch(/\bnpx(?:\.cmd)?\b/);
    expect(releaseBuilder).not.toContain('mtimeMs');
  });
});
