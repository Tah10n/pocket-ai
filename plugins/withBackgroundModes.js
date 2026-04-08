const { withInfoPlist } = require('expo/config-plugins');

module.exports = function withBackgroundModes(config) {
  return withInfoPlist(config, (nextConfig) => {
    const existingModes = Array.isArray(nextConfig.modResults.UIBackgroundModes)
      ? nextConfig.modResults.UIBackgroundModes
      : [];

    const modes = new Set(existingModes);
    modes.add('processing');

    nextConfig.modResults.UIBackgroundModes = Array.from(modes);
    return nextConfig;
  });
};
