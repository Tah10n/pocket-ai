const { withSettingsGradle } = require('expo/config-plugins');
const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode');

const PLUGIN_MANAGEMENT_BLOCK = `  // Pinned for stable local prebuilds. Override via:
  // - POCKET_AI_ANDROID_AGP_VERSION
  // - POCKET_AI_ANDROID_KOTLIN_VERSION
  // - POCKET_AI_ANDROID_KSP_VERSION
  def pocketAiAgpVersion = System.getenv("POCKET_AI_ANDROID_AGP_VERSION") ?: "8.11.0"
  def pocketAiKotlinVersion = System.getenv("POCKET_AI_ANDROID_KOTLIN_VERSION") ?: "2.0.21"
  def pocketAiKspVersion = System.getenv("POCKET_AI_ANDROID_KSP_VERSION") ?: "2.0.21-1.0.28"

  repositories {
    google()
    mavenCentral()
    gradlePluginPortal()
  }

  plugins {
    id("com.android.application") version pocketAiAgpVersion
    id("com.android.library") version pocketAiAgpVersion
    id("org.jetbrains.kotlin.android") version pocketAiKotlinVersion
    id("com.google.devtools.ksp") version pocketAiKspVersion
  }`;

function ensureAndroidPluginManagementVersions(contents) {
  if (!/pluginManagement\s*\{/.test(contents)) {
    return contents;
  }

  const alreadyPinned =
    contents.includes('pocket-ai-plugin-management') ||
    [
      'com.android.application',
      'com.android.library',
      'org.jetbrains.kotlin.android',
      'com.google.devtools.ksp',
    ].some(
      (pluginId) =>
        contents.includes(`id("${pluginId}") version`) || contents.includes(`id '${pluginId}' version`)
    );

  if (alreadyPinned) {
    return contents;
  }

  return mergeContents({
    src: contents,
    newSrc: PLUGIN_MANAGEMENT_BLOCK,
    tag: 'pocket-ai-plugin-management',
    anchor: /pluginManagement\s*\{/,
    offset: 1,
    comment: '//',
  }).contents;
}

module.exports = function withAndroidGradlePluginManagement(config) {
  return withSettingsGradle(config, (nextConfig) => {
    if (nextConfig.modResults.language === 'groovy') {
      nextConfig.modResults.contents = ensureAndroidPluginManagementVersions(nextConfig.modResults.contents);
    }

    return nextConfig;
  });
};
