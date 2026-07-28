const path = require('node:path');
const {
  createAndroidShippingBuildEnvironment,
} = require('../scripts/android-build-provenance');

function isAndroidShippingBuild(env = {}) {
  return env.POCKET_AI_SHIPPING_BUILD === '1'
    || `${env.EAS_BUILD_PROFILE || ''}`.trim().toLowerCase() === 'production';
}

function assertAndroidQaReleaseGuard(config, env = process.env, options = {}) {
  if (!isAndroidShippingBuild(env)) {
    return null;
  }
  const projectRoot = path.resolve(
    options.projectRoot
      || config?._internal?.projectRoot
      || process.cwd(),
  );
  return createAndroidShippingBuildEnvironment(projectRoot, env);
}

function withAndroidQaReleaseGuard(config) {
  assertAndroidQaReleaseGuard(config);
  return config;
}

module.exports = withAndroidQaReleaseGuard;
module.exports._internal = {
  assertAndroidQaReleaseGuard,
  isAndroidShippingBuild,
};
