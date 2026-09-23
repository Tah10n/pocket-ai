const { ensureGradleSourceBuild, ensurePodfileSourceBuild, PODFILE_PREFIX } = require('../../plugins/withLlamaSourceBuild')._internal;

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

  it('rejects a later Podfile assignment which could silently select the unpatched core', () => {
    expect(() => ensurePodfileSourceBuild("ENV['RNLLAMA_BUILD_FROM_SOURCE'] = '0'\n")).toThrow(/Conflicting/);
    expect(() => ensurePodfileSourceBuild(PODFILE_PREFIX + 'ENV["RNLLAMA_BUILD_FROM_SOURCE"] ||= "0"\n')).toThrow(/Conflicting/);
  });
});
