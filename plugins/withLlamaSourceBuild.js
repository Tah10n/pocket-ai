const { withGradleProperties, withPodfile } = require('expo/config-plugins');

const PROPERTY = 'rnllamaBuildFromSource';
const PODFILE_PREFIX = "# Pocket AI: compile the pinned llama.rn core corrections.\nENV['RNLLAMA_BUILD_FROM_SOURCE'] = '1'\n";

function ensureGradleSourceBuild(properties) {
  return [...properties.filter(item => item.type !== 'property' || item.key !== PROPERTY),
    { type: 'property', key: PROPERTY, value: 'true' }];
}

function ensurePodfileSourceBuild(contents) {
  const normalized = contents.replace(/\r\n/gu, '\n');
  const body = normalized.startsWith(PODFILE_PREFIX) ? normalized.slice(PODFILE_PREFIX.length) : normalized;
  if (/ENV\[\s*['"]RNLLAMA_BUILD_FROM_SOURCE['"]\s*\]\s*(?:\|\|)?=/u.test(body)) {
    throw new Error('Conflicting llama.rn source-build assignment in Podfile.');
  }
  const result = PODFILE_PREFIX + body;
  return contents.includes('\r\n') ? result.replace(/\n/gu, '\r\n') : result;
}

module.exports = function withLlamaSourceBuild(config) {
  config = withGradleProperties(config, next => {
    next.modResults = ensureGradleSourceBuild(next.modResults);
    return next;
  });
  return withPodfile(config, next => {
    next.modResults.contents = ensurePodfileSourceBuild(next.modResults.contents);
    return next;
  });
};

module.exports._internal = { PROPERTY, PODFILE_PREFIX, ensureGradleSourceBuild, ensurePodfileSourceBuild };
