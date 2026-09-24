const { withGradleProperties, withPodfile, withProjectBuildGradle } = require('expo/config-plugins');

const PROPERTY = 'rnllamaBuildFromSource';
const PODFILE_PREFIX = "# Pocket AI: compile the pinned llama.rn core corrections.\nENV['RNLLAMA_BUILD_FROM_SOURCE'] = '1'\n";

const HEXAGON_GUARD = `// @generated pocket-ai llama source-build guard
if ((findProperty("rnllamaBuildFromSource") ?: "false").toString() != "true") {
    throw new GradleException("Pocket AI requires the corrected llama.rn source core.")
}
def pocketLlamaArchitectures = (findProperty("reactNativeArchitectures") ?: "arm64-v8a,x86_64").toString().split(",").collect { it.trim() }
def pocketLlamaAbi = pocketLlamaArchitectures == ["x86_64"] ? "x86_64" : "universal"
if (pocketLlamaAbi != "x86_64" && (findProperty("rnllamaVariants") ?: "").toString().trim()) {
    throw new GradleException("Pocket AI ARM64 builds must preserve all llama.rn backend variants.")
}
if (pocketLlamaAbi != "x86_64" && (!System.getenv("HEXAGON_SDK_ROOT") || !System.getenv("HEXAGON_TOOLS_ROOT"))) {
    throw new GradleException("ARM64 source builds require the verified HEXAGON_SDK_ROOT and HEXAGON_TOOLS_ROOT environment passed to llama.rn.")
}
if (pocketLlamaAbi != "x86_64" && (!new File(System.getenv("HEXAGON_SDK_ROOT")).isAbsolute() || !new File(System.getenv("HEXAGON_TOOLS_ROOT")).isAbsolute())) {
    throw new GradleException("Hexagon SDK environment roots must be absolute so Gradle and the verifier use the same files.")
}
def pocketLlamaSdkOutput = new ByteArrayOutputStream()
def pocketLlamaSdkCheck = exec {
    workingDir rootDir.parentFile
    commandLine "node", "scripts/llama-hexagon-sdk.js", "verify", "--abi", pocketLlamaAbi
    standardOutput = pocketLlamaSdkOutput
    errorOutput = pocketLlamaSdkOutput
    ignoreExitValue = true
}
if (pocketLlamaSdkCheck.exitValue != 0) {
    throw new GradleException("Pinned llama.rn host SDK verification failed; run the repository Android build setup.")
}
// @end pocket-ai llama source-build guard`;

function ensureAndroidHexagonGuard(contents) {
  const normalized = contents.replace(/\r\n/gu, '\n');
  const marker = '// @generated pocket-ai llama source-build guard';
  const endMarker = '// @end pocket-ai llama source-build guard';
  const start = normalized.indexOf(marker);
  const end = normalized.indexOf(endMarker);
  if ((start < 0) !== (end < 0) || (start >= 0 && end < start)) throw new Error('Incomplete llama source-build guard.');
  const next = start < 0 ? normalized.trimEnd() + '\n\n' + HEXAGON_GUARD + '\n'
    : normalized.slice(0, start) + HEXAGON_GUARD + normalized.slice(end + endMarker.length);
  return contents.includes('\r\n') ? next.replace(/\n/gu, '\r\n') : next;
}

function ensureGradleSourceBuild(properties) {
  return [...properties.filter(item => item.type !== 'property' || item.key !== PROPERTY),
    { type: 'property', key: PROPERTY, value: 'true' }];
}

function ensurePodfileSourceBuild(contents) {
  const normalized = contents.replace(/\r\n/gu, '\n');
  const body = normalized.replace(PODFILE_PREFIX, '');
  if (/ENV\[\s*['"]RNLLAMA_BUILD_FROM_SOURCE['"]\s*\]\s*(?:\|\|)?=/u.test(body)) {
    throw new Error('Conflicting llama.rn source-build assignment in Podfile.');
  }
  const result = PODFILE_PREFIX + body;
  return contents.includes('\r\n') ? result.replace(/\n/gu, '\r\n') : result;
}

function assertPodfileSourceBuild(contents) {
  const normalized = contents.replace(/\r\n/gu, '\n');
  const index = normalized.indexOf(PODFILE_PREFIX);
  // expo-router prepends this literal feature switch after our Podfile mod.
  // Allow its harmless preamble, but never accept the guard after Ruby/Pods evaluation.
  const preamble = index < 0 ? [] : normalized.slice(0, index).split('\n');
  const safePreamble = preamble.every(line => {
    const value = line.trim();
    return !value || value.startsWith('#')
      || /^ENV\[['"]RNS_GAMMA_ENABLED['"]\]\s*\|\|=\s*['"]1['"]$/u.test(value);
  });
  if (index < 0 || !safePreamble) throw new Error('iOS must compile the corrected llama.rn core from source before pod resolution.');
  ensurePodfileSourceBuild(normalized);
}

module.exports = function withLlamaSourceBuild(config) {
  config = withGradleProperties(config, next => {
    next.modResults = ensureGradleSourceBuild(next.modResults);
    return next;
  });
  config = withProjectBuildGradle(config, next => {
    next.modResults.contents = ensureAndroidHexagonGuard(next.modResults.contents);
    return next;
  });
  return withPodfile(config, next => {
    next.modResults.contents = ensurePodfileSourceBuild(next.modResults.contents);
    return next;
  });
};

module.exports._internal = { PROPERTY, PODFILE_PREFIX, HEXAGON_GUARD, ensureAndroidHexagonGuard, ensureGradleSourceBuild, ensurePodfileSourceBuild, assertPodfileSourceBuild };
