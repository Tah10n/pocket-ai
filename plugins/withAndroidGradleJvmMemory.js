const { withGradleProperties } = require('expo/config-plugins');

const ANDROID_GRADLE_JVM_ARGS = '-Xmx2048m -XX:MaxMetaspaceSize=1024m';

function ensureAndroidGradleJvmMemory(properties) {
  const existing = properties.find(
    (property) => property.type === 'property' && property.key === 'org.gradle.jvmargs',
  );

  if (existing) {
    existing.value = ANDROID_GRADLE_JVM_ARGS;
    return properties;
  }

  properties.push({
    type: 'property',
    key: 'org.gradle.jvmargs',
    value: ANDROID_GRADLE_JVM_ARGS,
  });
  return properties;
}

module.exports = function withAndroidGradleJvmMemory(config) {
  return withGradleProperties(config, (nextConfig) => {
    nextConfig.modResults = ensureAndroidGradleJvmMemory(nextConfig.modResults);
    return nextConfig;
  });
};

module.exports._internal = {
  ANDROID_GRADLE_JVM_ARGS,
  ensureAndroidGradleJvmMemory,
};
