const { withProjectBuildGradle } = require('expo/config-plugins');

const START = '// @generated pocket-ai Windows MMKV staging';
const END = '// @end pocket-ai Windows MMKV staging';
const WINDOWS_MMKV_STAGING = `${START}
// Legacy Ninja cannot stat long prefab paths, even when their normalized path is shorter.
if (System.getProperty("os.name").toLowerCase(java.util.Locale.ROOT).startsWith("windows")) {
    subprojects { subproject ->
        if (subproject.path == ":react-native-mmkv") {
            subproject.plugins.withId("com.android.library") {
                def pocketMmkvRootHash = java.security.MessageDigest.getInstance("SHA-256").digest(rootProject.projectDir.canonicalPath.getBytes("UTF-8")).encodeHex().toString().substring(0, 12)
                subproject.android.externalNativeBuild.cmake.buildStagingDirectory = new File(gradle.gradleUserHomeDir, "n/m-" + pocketMmkvRootHash)
            }
        }
    }
}
${END}`;

function ensureWindowsMmkvStaging(contents) {
  const normalized = contents.replace(/\r\n/gu, '\n');
  const starts = normalized.split(START).length - 1;
  const ends = normalized.split(END).length - 1;
  const start = normalized.indexOf(START);
  const end = normalized.indexOf(END);
  if (starts !== ends || starts > 1 || start >= 0 && end < start) {
    throw new Error('Incomplete or duplicate Windows MMKV staging block.');
  }
  const next = start < 0 ? normalized.trimEnd() + '\n\n' + WINDOWS_MMKV_STAGING + '\n'
    : normalized.slice(0, start) + WINDOWS_MMKV_STAGING + normalized.slice(end + END.length);
  return contents.includes('\r\n') ? next.replace(/\n/gu, '\r\n') : next;
}

module.exports = function withAndroidWindowsMmkvStaging(config) {
  return withProjectBuildGradle(config, next => {
    next.modResults.contents = ensureWindowsMmkvStaging(next.modResults.contents);
    return next;
  });
};
module.exports._internal = { WINDOWS_MMKV_STAGING, ensureWindowsMmkvStaging };
