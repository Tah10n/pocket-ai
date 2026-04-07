const { withAndroidManifest, withMainActivity } = require('expo/config-plugins');
const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode');

function getAndroidPackageName(config, androidManifest) {
  return config.android?.package ?? androidManifest?.$?.package ?? 'com.github.tah10n.pocketai';
}

function removeMainActivityScreenOrientation(androidManifest, packageName) {
  const application = androidManifest?.application?.[0];
  const activities = application?.activity;
  if (!Array.isArray(activities)) {
    return false;
  }

  const expectedNames = new Set([
    '.MainActivity',
    `${packageName}.MainActivity`,
  ]);

  let didUpdate = false;
  for (const activity of activities) {
    const activityName = activity?.$?.['android:name'];
    if (!activityName) continue;

    const isMainActivity = expectedNames.has(activityName) || activityName.endsWith('.MainActivity');
    if (!isMainActivity) continue;

    if (activity.$?.['android:screenOrientation'] != null) {
      delete activity.$['android:screenOrientation'];
      didUpdate = true;
    }
  }

  return didUpdate;
}

const MAIN_ACTIVITY_IMPORTS_TAG = 'pocket-ai-main-activity-orientation-imports';
const MAIN_ACTIVITY_ORIENTATION_TAG = 'pocket-ai-main-activity-orientation';
const MAIN_ACTIVITY_ONCREATE_TAG = 'pocket-ai-main-activity-orientation-oncreate';

const MAIN_ACTIVITY_IMPORTS = `import android.content.pm.ActivityInfo
import android.content.res.Configuration`;

const MAIN_ACTIVITY_ORIENTATION_BLOCK = `  private fun updateRequestedOrientation() {
    val isLargeScreen = resources.configuration.smallestScreenWidthDp >= 600
    val nextOrientation =
      if (isLargeScreen) ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED else ActivityInfo.SCREEN_ORIENTATION_PORTRAIT

    if (requestedOrientation != nextOrientation) {
      requestedOrientation = nextOrientation
    }
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    updateRequestedOrientation()
  }
`;

const MAIN_ACTIVITY_ONCREATE_LINE = `    updateRequestedOrientation()`;

function applyMainActivityOrientationSupport(contents) {
  let nextContents = contents;

  const hasActivityInfoImport = nextContents.includes('import android.content.pm.ActivityInfo');
  const hasConfigurationImport = nextContents.includes('import android.content.res.Configuration');

  if (!hasActivityInfoImport || !hasConfigurationImport) {
    const importsAnchor = /^import\s+android\.os\.Bundle\s*$/m;
    if (importsAnchor.test(nextContents)) {
      nextContents = mergeContents({
        src: nextContents,
        newSrc: MAIN_ACTIVITY_IMPORTS,
        tag: MAIN_ACTIVITY_IMPORTS_TAG,
        anchor: importsAnchor,
        offset: 0,
        comment: '//',
      }).contents;
    }
  }

  if (!nextContents.includes(`@generated begin ${MAIN_ACTIVITY_ORIENTATION_TAG} -`)) {
    const classAnchor = /^class\s+MainActivity\s*:\s*ReactActivity\(\)\s*\{\s*$/m;
    if (classAnchor.test(nextContents)) {
      nextContents = mergeContents({
        src: nextContents,
        newSrc: MAIN_ACTIVITY_ORIENTATION_BLOCK,
        tag: MAIN_ACTIVITY_ORIENTATION_TAG,
        anchor: classAnchor,
        offset: 1,
        comment: '//',
      }).contents;
    }
  }

  if (!nextContents.includes(`@generated begin ${MAIN_ACTIVITY_ONCREATE_TAG} -`)) {
    const onCreateAnchor =
      /^\s*override\s+fun\s+onCreate\s*\(\s*savedInstanceState:\s*Bundle\?\s*\)\s*\{\s*$/m;
    if (onCreateAnchor.test(nextContents)) {
      nextContents = mergeContents({
        src: nextContents,
        newSrc: MAIN_ACTIVITY_ONCREATE_LINE,
        tag: MAIN_ACTIVITY_ONCREATE_TAG,
        anchor: onCreateAnchor,
        offset: 1,
        comment: '//',
      }).contents;
    }
  }

  return nextContents;
}

module.exports = function withAndroidMainActivityOrientation(config) {
  config = withAndroidManifest(config, (nextConfig) => {
    const manifest = nextConfig.modResults.manifest;
    const packageName = getAndroidPackageName(nextConfig, manifest);

    const didUpdate = removeMainActivityScreenOrientation(manifest, packageName);
    if (!didUpdate) {
      console.warn('[withAndroidMainActivityOrientation] Could not remove android:screenOrientation from MainActivity.');
    }

    return nextConfig;
  });

  config = withMainActivity(config, (nextConfig) => {
    if (nextConfig.modResults.language !== 'kt') {
      console.warn('[withAndroidMainActivityOrientation] MainActivity is not Kotlin; skipping runtime orientation guard.');
      return nextConfig;
    }

    nextConfig.modResults.contents = applyMainActivityOrientationSupport(nextConfig.modResults.contents);
    return nextConfig;
  });

  return config;
};
