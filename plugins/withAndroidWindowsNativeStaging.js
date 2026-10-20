const { withProjectBuildGradle } = require('expo/config-plugins');

const START = '// @generated pocket-ai Windows native staging';
const END = '// @end pocket-ai Windows native staging';
const WINDOWS_NATIVE_STAGING = `${START}
// Keep legacy Ninja prefab paths and CMake's hashed object paths below Windows limits.
if (System.getProperty("os.name").toLowerCase(java.util.Locale.ROOT).startsWith("windows")) {
    def pocketNativeModules = [":react-native-mmkv": ["com.android.library", "m"], ":app": ["com.android.application", "a"]]
    subprojects { subproject ->
        def pocketNativeModule = pocketNativeModules[subproject.path]
        if (pocketNativeModule != null) {
            subproject.plugins.withId(pocketNativeModule[0]) {
                def pocketNativeRootHash = java.security.MessageDigest.getInstance("SHA-256").digest(rootProject.projectDir.canonicalPath.getBytes("UTF-8")).encodeHex().toString().substring(0, 12)
                subproject.android.externalNativeBuild.cmake.buildStagingDirectory = new File(gradle.gradleUserHomeDir, "n/" + pocketNativeModule[1] + "-" + pocketNativeRootHash)
            }
        }
    }
}
${END}`;

function ensureWindowsNativeStaging(contents) {
  const normalized = contents.replace(/\r\n/gu, '\n')
    .replaceAll('// @generated pocket-ai Windows MMKV staging', START)
    .replaceAll('// @end pocket-ai Windows MMKV staging', END);
  const starts = normalized.split(START).length - 1;
  const ends = normalized.split(END).length - 1;
  const start = normalized.indexOf(START);
  const end = normalized.indexOf(END);
  if (starts !== ends || starts > 1 || start >= 0 && end < start) {
    throw new Error('Incomplete or duplicate Windows native staging block.');
  }
  const next = start < 0 ? normalized.trimEnd() + '\n\n' + WINDOWS_NATIVE_STAGING + '\n'
    : normalized.slice(0, start) + WINDOWS_NATIVE_STAGING + normalized.slice(end + END.length);
  return contents.includes('\r\n') ? next.replace(/\n/gu, '\r\n') : next;
}

module.exports = function withAndroidWindowsNativeStaging(config) {
  return withProjectBuildGradle(config, next => {
    next.modResults.contents = ensureWindowsNativeStaging(next.modResults.contents);
    return next;
  });
};
module.exports._internal = { WINDOWS_NATIVE_STAGING, ensureWindowsNativeStaging };
