const path = require('node:path');
const crypto = require('node:crypto');
const withAndroidWindowsMmkvStaging = require('../../plugins/withAndroidWindowsMmkvStaging');
const { WINDOWS_MMKV_STAGING, ensureWindowsMmkvStaging } = withAndroidWindowsMmkvStaging._internal;
const { ensureAndroidHexagonGuard, HEXAGON_GUARD } = require('../../plugins/withLlamaSourceBuild')._internal;
const appConfig = require('../../app.json');

jest.mock('expo/config-plugins', () => ({
  withProjectBuildGradle: (_config, action) => action({ modResults: { contents: 'buildscript { }\n' } }),
}));

describe('Windows MMKV native staging', () => {
  it('registers the real project Gradle mod once without removing the source-build guard plugin', () => {
    expect(appConfig.expo.plugins.filter(plugin => plugin === './plugins/withAndroidWindowsMmkvStaging')).toHaveLength(1);
    expect(appConfig.expo.plugins).toContain('./plugins/withLlamaSourceBuild');
    expect(withAndroidWindowsMmkvStaging({}).modResults.contents).toBe(ensureWindowsMmkvStaging('buildscript { }\n'));
  });

  it.each(['\n', '\r\n'])('preserves the existing native guard and unrelated Gradle configuration on repeated generation (%j)', newline => {
    const original = ensureAndroidHexagonGuard(`buildscript { }${newline}// retained custom setting${newline}`);
    const result = ensureWindowsMmkvStaging(original);
    expect(result.startsWith(original)).toBe(true);
    expect(result.replace(/\r\n/gu, '\n')).toContain(HEXAGON_GUARD);
    expect(ensureWindowsMmkvStaging(result)).toBe(result);
    expect(ensureAndroidHexagonGuard(result)).toBe(result);
    if (newline === '\r\n') expect(result.replace(/\r\n/gu, '')).not.toContain('\n');
  });

  it('gates the only assignment on Windows, the MMKV project and the Android library plugin', () => {
    expect(WINDOWS_MMKV_STAGING).toMatch(/if \(System\.getProperty\("os.name"\)\.toLowerCase\(java.util.Locale.ROOT\)\.startsWith\("windows"\)\) \{\s+subprojects \{ subproject ->\s+if \(subproject.path == ":react-native-mmkv"\) \{\s+subproject.plugins.withId\("com.android.library"\) \{\s+def pocketMmkvRootHash = [^\n]+\s+subproject.android.externalNativeBuild.cmake.buildStagingDirectory = new File\(gradle.gradleUserHomeDir, "n\/m-" \+ pocketMmkvRootHash\)\s+\}\s+\}\s+\}/u);
    expect(WINDOWS_MMKV_STAGING).not.toMatch(/ndkVersion|cmake\.version|CMAKE_MAKE_PROGRAM|rnllama|abiFilters/u);
  });

  it('puts the failing prefab descendant below the legacy Ninja path limit in the isolated Gradle home', () => {
    const staging = path.win32.join('C:/Users/developer/.pa/g-123456789abc', 'n/m-123456789abc');
    const build = path.win32.join(staging, 'RelWithDebInfo/5g724w4h/x86_64');
    // Ninja 1.10 stats the joined path before resolving ../; count that original spelling.
    const dependent = build + '/../prefab/x86_64/prefab/lib/x86_64-linux-android/cmake/react-native-nitro-modules/react-native-nitro-modulesConfig.cmake';
    expect(dependent.length).toBeLessThan(260);
    expect(staging).toMatch(/\\g-123456789abc\\n\\m-123456789abc$/u);
  });

  it('uses a stable canonical project hash so checkouts sharing Gradle home stay isolated', () => {
    expect(WINDOWS_MMKV_STAGING).toContain('java.security.MessageDigest.getInstance("SHA-256").digest(rootProject.projectDir.canonicalPath.getBytes("UTF-8")).encodeHex().toString().substring(0, 12)');
    const home = 'C:/Users/developer/.gradle';
    const directoryFor = canonicalRoot => path.win32.join(home, 'n/m-' + crypto.createHash('sha256').update(canonicalRoot, 'utf8').digest('hex').slice(0, 12));
    const first = directoryFor('C:\\checkouts\\one\\android');
    expect(directoryFor('C:\\checkouts\\one\\android')).toBe(first);
    expect(directoryFor('C:\\checkouts\\two\\android')).not.toBe(first);
    expect(first).toMatch(/\\n\\m-[a-f0-9]{12}$/u);
  });
  it.each([
    '// @generated pocket-ai Windows MMKV staging',
    '// @end pocket-ai Windows MMKV staging',
    '// @end pocket-ai Windows MMKV staging\n// @generated pocket-ai Windows MMKV staging',
    WINDOWS_MMKV_STAGING + '\n' + WINDOWS_MMKV_STAGING,
  ])('fails closed on malformed or duplicated generated blocks', input => {
    expect(() => ensureWindowsMmkvStaging(input)).toThrow(/Incomplete or duplicate/);
  });
});
