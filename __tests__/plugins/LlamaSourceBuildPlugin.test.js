const { ensureGradleSourceBuild, ensurePodfileSourceBuild, assertPodfileSourceBuild, ensureAndroidHexagonGuard, HEXAGON_GUARD, PODFILE_PREFIX } = require('../../plugins/withLlamaSourceBuild')._internal;

describe('pinned llama.rn source build', () => {
  it('sets the real Android property and removes conflicting duplicate values', () => {
    const other = { type: 'property', key: 'unrelated', value: 'keep' };
    const input = [other, { type: 'property', key: 'rnllamaBuildFromSource', value: 'false' },
      { type: 'property', key: 'rnllamaBuildFromSource', value: 'true' }];
    const result = ensureGradleSourceBuild(input);
    expect(result).toEqual([other, { type: 'property', key: 'rnllamaBuildFromSource', value: 'true' }]);
    expect(ensureGradleSourceBuild(result)).toEqual(result);
    expect(input).toHaveLength(3);
  });

  it.each(['\n', '\r\n'])('sets the iOS switch before pod resolution and stays idempotent (%j)', newline => {
    const input = `require 'expo/scripts/autolinking'${newline}target 'PocketAI' do${newline}end${newline}`;
    const result = ensurePodfileSourceBuild(input);
    expect(result.replace(/\r\n/gu, '\n')).toBe(PODFILE_PREFIX + input.replace(/\r\n/gu, '\n'));
    expect(ensurePodfileSourceBuild(result)).toBe(result);
  });

  it.each(['\n', '\r\n'])('guards direct Gradle/EAS builds without modifying unrelated code (%j)', newline => {
    const input = `buildscript { }${newline}`;
    const result = ensureAndroidHexagonGuard(input);
    expect(result.replace(/\r\n/gu, '\n')).toBe('buildscript { }\n\n' + HEXAGON_GUARD + '\n');
    expect(ensureAndroidHexagonGuard(result)).toBe(result);
    expect(() => ensureAndroidHexagonGuard('// @generated pocket-ai llama source-build guard')).toThrow(/Incomplete/);
  });

  it('requires the same explicit SDK environment that the upstream module consumes', () => {
    expect(HEXAGON_GUARD).toContain('!System.getenv("HEXAGON_SDK_ROOT") || !System.getenv("HEXAGON_TOOLS_ROOT")');
    expect(HEXAGON_GUARD).toContain('!new File(System.getenv("HEXAGON_SDK_ROOT")).isAbsolute()');
    expect(HEXAGON_GUARD).toContain('!new File(System.getenv("HEXAGON_TOOLS_ROOT")).isAbsolute()');
    expect(HEXAGON_GUARD.indexOf('!System.getenv("HEXAGON_SDK_ROOT")')).toBeLessThan(HEXAGON_GUARD.indexOf('def pocketLlamaSdkCheck = exec'));
  });

  it.each(['\n', '\r\n'])('accepts the expo-router preamble and reapplies idempotently (%j)', newline => {
    const router = "# Set by expo-router. This enables Fabric-only features from react-native-screens\nENV['RNS_GAMMA_ENABLED'] ||= '1'\n";
    const body = "require 'expo/scripts/autolinking'\n";
    const generated = (router + PODFILE_PREFIX + body).replace(/\n/gu, newline);
    expect(() => assertPodfileSourceBuild(generated)).not.toThrow();
    const reapplied = ensurePodfileSourceBuild(generated);
    expect(reapplied.replace(/\r\n/gu, '\n')).toBe(PODFILE_PREFIX + router + body);
    expect(ensurePodfileSourceBuild(reapplied)).toBe(reapplied);
  });

  it.each([
    "require 'expo/scripts/autolinking'\n",
    "target 'PocketAI' do\n",
    "ENV['RNLLAMA_BUILD_FROM_SOURCE'] = '0'\n",
    "ENV['RNS_GAMMA_ENABLED'] ||= compute_value()\n",
  ])('rejects a guard after executable or conflicting Podfile content: %j', preamble => {
    expect(() => assertPodfileSourceBuild(preamble + PODFILE_PREFIX)).toThrow(/core from source/);
  });

  it('rejects missing, duplicate and conflicting source-build guards', () => {
    expect(() => assertPodfileSourceBuild("require 'json'\n")).toThrow(/core from source/);
    expect(() => assertPodfileSourceBuild(PODFILE_PREFIX + PODFILE_PREFIX)).toThrow(/Conflicting/);
    expect(() => assertPodfileSourceBuild(PODFILE_PREFIX + "ENV['RNLLAMA_BUILD_FROM_SOURCE'] = '0'\n")).toThrow(/Conflicting/);
  });

  it('rejects a later Podfile assignment which could silently select the unpatched core', () => {
    expect(() => ensurePodfileSourceBuild("ENV['RNLLAMA_BUILD_FROM_SOURCE'] = '0'\n")).toThrow(/Conflicting/);
    expect(() => ensurePodfileSourceBuild(PODFILE_PREFIX + 'ENV["RNLLAMA_BUILD_FROM_SOURCE"] ||= "0"\n')).toThrow(/Conflicting/);
  });
});
