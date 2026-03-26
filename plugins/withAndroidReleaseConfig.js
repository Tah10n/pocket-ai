const { withAndroidManifest } = require('expo/config-plugins');

const BLOCKED_PERMISSIONS = new Set([
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.SYSTEM_ALERT_WINDOW',
]);

module.exports = function withAndroidReleaseConfig(config) {
  return withAndroidManifest(config, (nextConfig) => {
    const manifest = nextConfig.modResults.manifest;
    const application = manifest.application?.[0];

    if (application?.$) {
      application.$['android:allowBackup'] = 'false';
    }

    if (Array.isArray(manifest['uses-permission'])) {
      manifest['uses-permission'] = manifest['uses-permission'].filter((permission) => {
        const name = permission?.$?.['android:name'];
        return !BLOCKED_PERMISSIONS.has(name);
      });
    }

    return nextConfig;
  });
};
