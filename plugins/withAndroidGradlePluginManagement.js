const fs = require('node:fs');
const path = require('node:path');
const { withDangerousMod, withSettingsGradle } = require('expo/config-plugins');
const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode');

const ANDROID_GRADLE_WRAPPER_VERSION = '8.14.3';
const GRADLE_WRAPPER_DISTRIBUTION_PATTERN = /^distributionUrl=[^\r\n]*$/gm;

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

function ensureAndroidGradleWrapperVersion(contents) {
  const expectedDistribution =
    `distributionUrl=https\\://services.gradle.org/distributions/gradle-${ANDROID_GRADLE_WRAPPER_VERSION}-bin.zip`;
  const distributionLines = contents.match(GRADLE_WRAPPER_DISTRIBUTION_PATTERN) || [];

  if (distributionLines.length === 0) {
    throw new Error('Generated Android Gradle wrapper is missing distributionUrl.');
  }
  if (distributionLines.length !== 1) {
    throw new Error('Generated Android Gradle wrapper must contain exactly one distributionUrl.');
  }

  const [currentDistribution] = distributionLines;

  if (currentDistribution === expectedDistribution) {
    return contents;
  }

  return contents.replace(GRADLE_WRAPPER_DISTRIBUTION_PATTERN, expectedDistribution);
}

function updateAndroidGradleWrapperFile(wrapperPropertiesPath, io = fs) {
  let contents;
  try {
    contents = io.readFileSync(wrapperPropertiesPath, 'utf8');
  } catch {
    throw new Error('Unable to read generated Android Gradle wrapper properties.');
  }

  const nextContents = ensureAndroidGradleWrapperVersion(contents);
  if (nextContents === contents) {
    return;
  }

  try {
    io.writeFileSync(wrapperPropertiesPath, nextContents, 'utf8');
  } catch {
    throw new Error('Unable to write generated Android Gradle wrapper properties.');
  }
}

function withAndroidGradleWrapperVersion(config) {
  return withDangerousMod(config, [
    'android',
    async (nextConfig) => {
      const wrapperPropertiesPath = path.join(
        nextConfig.modRequest.platformProjectRoot,
        'gradle',
        'wrapper',
        'gradle-wrapper.properties'
      );
      updateAndroidGradleWrapperFile(wrapperPropertiesPath);
      return nextConfig;
    },
  ]);
}

module.exports = function withAndroidGradlePluginManagement(config) {
  const configWithPluginManagement = withSettingsGradle(config, (nextConfig) => {
    if (nextConfig.modResults.language === 'groovy') {
      nextConfig.modResults.contents = ensureAndroidPluginManagementVersions(nextConfig.modResults.contents);
    }

    return nextConfig;
  });

  return withAndroidGradleWrapperVersion(configWithPluginManagement);
};

module.exports._internal = {
  ANDROID_GRADLE_WRAPPER_VERSION,
  ensureAndroidGradleWrapperVersion,
  ensureAndroidPluginManagementVersions,
  updateAndroidGradleWrapperFile,
};
