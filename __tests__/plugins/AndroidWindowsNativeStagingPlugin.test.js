const path = require('node:path');
const crypto = require('node:crypto');
const withAndroidWindowsNativeStaging = require('../../plugins/withAndroidWindowsNativeStaging');
const { WINDOWS_NATIVE_STAGING, ensureWindowsNativeStaging } = withAndroidWindowsNativeStaging._internal;
const { ensureAndroidHexagonGuard, HEXAGON_GUARD } = require('../../plugins/withLlamaSourceBuild')._internal;
const appConfig = require('../../app.json');

// Expo's root plugins can evaluate :app and finalize its CMake DSL immediately.
const mockRootGradle = `buildscript {
  repositories { google(); mavenCentral() }
  dependencies { classpath('com.android.tools.build:gradle') }
}

allprojects {
  repositories { google(); mavenCentral() }
}

apply plugin: "expo-root-project"
apply plugin: "com.facebook.react.rootproject"
`;
jest.mock('expo/config-plugins', () => ({
  withProjectBuildGradle: (_config, action) => action({ modResults: { contents: mockRootGradle } }),
}));

describe('Windows scoped native staging', () => {
  it('registers the real project Gradle mod once without removing the source-build guard plugin', () => {
    expect(appConfig.expo.plugins.filter(plugin => plugin === './plugins/withAndroidWindowsNativeStaging')).toHaveLength(1);
    expect(appConfig.expo.plugins).toContain('./plugins/withLlamaSourceBuild');
    expect(withAndroidWindowsNativeStaging({}).modResults.contents).toBe(ensureWindowsNativeStaging(mockRootGradle));
  });

  it.each(['\n', '\r\n'])('preserves the existing native guard and unrelated Gradle configuration on repeated generation (%j)', newline => {
    const original = ensureAndroidHexagonGuard((mockRootGradle + '// retained custom setting\n').replace(/\n/gu, newline));
    const result = ensureWindowsNativeStaging(original);
    expect(result.replace(WINDOWS_NATIVE_STAGING.replace(/\n/gu, newline) + newline + newline, '')).toBe(original);
    expect(result.replace(/\r\n/gu, '\n')).toContain(HEXAGON_GUARD);
    expect(ensureWindowsNativeStaging(result)).toBe(result);
    expect(ensureAndroidHexagonGuard(result)).toBe(result);
    if (newline === '\r\n') expect(result.replace(/\r\n/gu, '')).not.toContain('\n');
  });

  it.each(['fresh', 'existing-current', 'existing-legacy'])('registers before root plugin application can finalize the app CMake DSL (%s)', placement => {
    const legacy = WINDOWS_NATIVE_STAGING.replaceAll('Windows native staging', 'Windows MMKV staging');
    const existing = placement === 'fresh' ? '' : (placement === 'existing-current' ? WINDOWS_NATIVE_STAGING : legacy) + '\n';
    const original = ensureAndroidHexagonGuard(mockRootGradle + '\n' + existing);
    const result = ensureWindowsNativeStaging(original);
    const registration = result.indexOf('// @generated pocket-ai Windows native staging');
    expect(registration).toBeGreaterThanOrEqual(0);
    expect(registration).toBeLessThan(result.indexOf('apply plugin: "expo-root-project"'));
    expect(registration).toBeLessThan(result.indexOf('apply plugin: "com.facebook.react.rootproject"'));
    expect(result.split('// @generated pocket-ai Windows native staging')).toHaveLength(2);
    expect(result).toContain(HEXAGON_GUARD);
    expect(ensureWindowsNativeStaging(result)).toBe(result);
  });

  it('fails closed when the root-plugin lifecycle boundary is absent', () => {
    expect(() => ensureWindowsNativeStaging('buildscript { }\n')).toThrow(/root plugin boundary/);
  });
  it('limits Windows configuration to evidenced native modules using their respective Android plugin types', () => {
    const gate = 'if (System.getProperty("os.name").toLowerCase(java.util.Locale.ROOT).startsWith("windows"))';
    const registry = 'def pocketNativeModules = [":react-native-mmkv": ["com.android.library", "m"], ":react-native-worklets-core": ["com.android.library", "w"], ":react-native-reanimated": ["com.android.library", "r"], ":llama.rn": ["com.android.library", "l"], ":app": ["com.android.application", "a"]]';
    expect(WINDOWS_NATIVE_STAGING.indexOf(gate)).toBeLessThan(WINDOWS_NATIVE_STAGING.indexOf(registry));
    expect(WINDOWS_NATIVE_STAGING).toContain(registry);
    expect(WINDOWS_NATIVE_STAGING).toMatch(/def pocketNativeModule = pocketNativeModules\[subproject.path\]\s+if \(pocketNativeModule != null\) \{\s+subproject.plugins.withId\(pocketNativeModule\[0\]\)/u);
    expect(WINDOWS_NATIVE_STAGING).toContain('new File(gradle.gradleUserHomeDir, "n/" + pocketNativeModule[1] + "-" + pocketNativeRootHash)');
    expect(WINDOWS_NATIVE_STAGING).not.toMatch(/ndkVersion|cmake\.version|CMAKE_MAKE_PROGRAM|CMAKE_OBJECT_PATH_MAX|rnllama|abiFilters/u);
  });
  it('puts the failing prefab descendant below the legacy Ninja path limit in the isolated Gradle home', () => {
    const staging = path.win32.join('C:/Users/developer/.pa/g-123456789abc', 'n/m-123456789abc');
    const build = path.win32.join(staging, 'RelWithDebInfo/5g724w4h/x86_64');
    // Ninja 1.10 stats the joined path before resolving ../; count that original spelling.
    const dependent = build + '/../prefab/x86_64/prefab/lib/x86_64-linux-android/cmake/react-native-nitro-modules/react-native-nitro-modulesConfig.cmake';
    expect(dependent.length).toBeLessThan(260);
    expect(staging).toMatch(/\\g-123456789abc\\n\\m-123456789abc$/u);
  });

  it('shortens the worklets ARM64 Hermes prefab dependency before Ninja resolves its parent segment', () => {
    const relative = '/../prefab/arm64-v8a/prefab/lib/aarch64-linux-android/cmake/hermes-engine/hermes-engineConfigVersion.cmake';
    const original = path.win32.join('C:/Users/developer/.codex/worktrees/stage-seven-followup/pocket_ai/app/node_modules/react-native-worklets-core/android/.cxx', 'RelWithDebInfo/60125n11/arm64-v8a');
    const registry = Object.fromEntries([...WINDOWS_NATIVE_STAGING.matchAll(/"(:[^"]+)": \["([^"]+)", "([^"]+)"\]/gu)]
      .map(([, module, plugin, suffix]) => [module, { plugin, suffix }]));
    expect(registry[':react-native-worklets-core']).toEqual({ plugin: 'com.android.library', suffix: 'w' });
    const staged = path.win32.join('C:/Users/developer/.pa/g-123456789abc', `n/${registry[':react-native-worklets-core'].suffix}-123456789abc`, 'RelWithDebInfo/60125n11/arm64-v8a');
    // Do not normalize away ../: legacy Ninja stats the joined spelling first.
    expect((original + relative).length).toBeGreaterThanOrEqual(260);
    expect((staged + relative).length).toBeLessThan(260);
    expect(new Set(Object.values(registry).map(entry => entry.suffix)).size).toBe(5);
  });

  it('upgrades the existing app/MMKV block to include worklets before root plugin evaluation', () => {
    const previous = WINDOWS_NATIVE_STAGING.replace(', ":react-native-worklets-core": ["com.android.library", "w"]', '');
    const upgraded = ensureWindowsNativeStaging(mockRootGradle + '\n' + previous);
    expect(upgraded).toContain('":react-native-worklets-core": ["com.android.library", "w"]');
    expect(upgraded.indexOf('":react-native-worklets-core"')).toBeLessThan(upgraded.indexOf('apply plugin: "expo-root-project"'));
    expect(upgraded.split('// @generated pocket-ai Windows native staging')).toHaveLength(2);
    expect(ensureWindowsNativeStaging(upgraded)).toBe(upgraded);
  });

  it.each([
    { module: 'react-native-reanimated', suffix: 'r', hash: '5q145t23',
      target: 'CMakeFiles/reanimated.dir', source: 'Common/cpp/reanimated/LayoutAnimations',
      filename: 'LayoutAnimationsProxy_Experimental.cpp.o' },
    { module: 'llama.rn', suffix: 'l', hash: '2a3ns5a6',
      target: 'rnllama/CMakeFiles/rnllama_v8_2_dotprod_i8mm_hexagon_opencl.dir', source: 'cpp/ggml-hexagon/htp/v73',
      filename: 'htp_iface_stub.c.o' },
  ])('gives CMake room to hash the evidenced ARM64 object path for $module', ({ module, suffix, hash, target, source, filename }) => {
    expect(WINDOWS_NATIVE_STAGING).toContain(`":${module}": ["com.android.library", "${suffix}"]`);
    const project = 'C:/Users/developer/.codex/worktrees/stage-seven-followup/pocket_ai/app';
    const originalBuild = path.win32.join(project, `node_modules/${module}/android/.cxx/RelWithDebInfo/${hash}/arm64-v8a`);
    const originalObject = path.win32.join(originalBuild, target, project.replace(':', '_'), `node_modules/${module}`, source, filename);
    expect(originalObject.length).toBeGreaterThanOrEqual(260);
    const stagedBuild = path.win32.join(`C:/Users/developer/.pa/g-123456789abc/n/${suffix}-123456789abc`, `RelWithDebInfo/${hash}/arm64-v8a`);
    // CMake must regenerate the graph: shortening alone retains the old mangled source path.
    // Its existing 250-character budget now has room for a 32-hex source-parent hash.
    expect(path.win32.join(stagedBuild, target, 'a'.repeat(32), filename).length).toBeLessThanOrEqual(250);
  });

  it('upgrades an existing staged app/MMKV/worklets block with the remaining evidenced ARM modules', () => {
    const additions = ', ":react-native-reanimated": ["com.android.library", "r"], ":llama.rn": ["com.android.library", "l"]';
    const previous = WINDOWS_NATIVE_STAGING.replace(additions, '');
    const upgraded = ensureWindowsNativeStaging(mockRootGradle + '\n' + previous);
    expect(upgraded).toContain(additions);
    expect(upgraded.indexOf('":react-native-reanimated"')).toBeLessThan(upgraded.indexOf('apply plugin: "expo-root-project"'));
    expect(upgraded.split('// @generated pocket-ai Windows native staging')).toHaveLength(2);
    expect(ensureWindowsNativeStaging(upgraded)).toBe(upgraded);
  });

  it('uses a stable canonical project hash so checkouts sharing Gradle home stay isolated', () => {
    expect(WINDOWS_NATIVE_STAGING).toContain('java.security.MessageDigest.getInstance("SHA-256").digest(rootProject.projectDir.canonicalPath.getBytes("UTF-8")).encodeHex().toString().substring(0, 12)');
    const home = 'C:/Users/developer/.gradle';
    const directoryFor = canonicalRoot => path.win32.join(home, 'n/m-' + crypto.createHash('sha256').update(canonicalRoot, 'utf8').digest('hex').slice(0, 12));
    const first = directoryFor('C:\\checkouts\\one\\android');
    expect(directoryFor('C:\\checkouts\\one\\android')).toBe(first);
    expect(directoryFor('C:\\checkouts\\two\\android')).not.toBe(first);
    expect(first).toMatch(/\\n\\m-[a-f0-9]{12}$/u);
  });
  it('leaves enough room for CMake to hash the app codegen object path within its existing 250-character budget', () => {
    const descendant = 'RelWithDebInfo/6f434ri3/x86_64/safeareacontext_autolinked_build/CMakeFiles/react_codegen_safeareacontext.dir/' + 'a'.repeat(32) + '/RNCSafeAreaViewShadowNode.cpp.o';
    const original = path.win32.join('C:/Users/developer/.codex/worktrees/stage-seven-followup/pocket_ai/app/android/app/.cxx', descendant);
    const staged = path.win32.join('C:/Users/developer/.pa/g-123456789abc/n/a-123456789abc', descendant);
    expect(original.length).toBeGreaterThan(250);
    expect(staged.length).toBeLessThanOrEqual(250);
  });

  it.each(['\n', '\r\n'])('upgrades an existing MMKV-only block without duplicating either block or changing native guards (%j)', newline => {
    const guard = ensureAndroidHexagonGuard(mockRootGradle);
    const legacy = '// @generated pocket-ai Windows MMKV staging\noldMmkvConfiguration()\n// @end pocket-ai Windows MMKV staging\n';
    const upgraded = ensureWindowsNativeStaging((guard + legacy).replace(/\n/gu, newline));
    expect(upgraded.replace(/\r\n/gu, '\n')).toContain(HEXAGON_GUARD);
    expect(upgraded).not.toContain('oldMmkvConfiguration');
    expect(upgraded).not.toContain('Windows MMKV staging');
    expect(upgraded.split('// @generated pocket-ai Windows native staging')).toHaveLength(2);
    expect(ensureWindowsNativeStaging(upgraded)).toBe(upgraded);
    expect(() => ensureWindowsNativeStaging(upgraded + legacy)).toThrow(/duplicate/);
  });
  it.each([
    '// @generated pocket-ai Windows native staging',
    '// @end pocket-ai Windows native staging',
    '// @end pocket-ai Windows native staging\n// @generated pocket-ai Windows native staging',
    WINDOWS_NATIVE_STAGING + '\n' + WINDOWS_NATIVE_STAGING,
  ])('fails closed on malformed or duplicated generated blocks', input => {
    expect(() => ensureWindowsNativeStaging(input)).toThrow(/Incomplete or duplicate/);
  });
});
