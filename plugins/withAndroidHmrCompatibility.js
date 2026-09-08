/* global __dirname */
const fs = require('node:fs');
const path = require('node:path');
const { withDangerousMod, withMainApplication } = require('expo/config-plugins');
const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode');

const TAG = 'pocket-ai-debug-hmr-compatibility';
const REGISTRATION = '    if (BuildConfig.DEBUG) PocketHmrCompatibility.install(reactHost)';

function createSource(packageName) {
  if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(packageName)) {
    throw new Error('withAndroidHmrCompatibility requires a valid Android package name.');
  }
  return fs.readFileSync(path.join(__dirname, 'android', 'PocketHmrCompatibility.java'), 'utf8')
    .replace('package __PACKAGE__;', `package ${packageName};`);
}

function applyRegistration(contents) {
  return mergeContents({
    src: contents,
    newSrc: REGISTRATION,
    tag: TAG,
    anchor: /^\s*loadReactNative\(this\)\s*$/m,
    offset: 1,
    comment: '//',
  }).contents;
}

function withAndroidHmrCompatibility(config) {
  config = withDangerousMod(config, ['android', async (nextConfig) => {
    if (!nextConfig.modRequest.introspect) {
      const packageName = nextConfig.android?.package;
      const source = createSource(packageName);
      const directory = path.join(nextConfig.modRequest.platformProjectRoot,
        'app', 'src', 'main', 'java', ...packageName.split('.'));
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'PocketHmrCompatibility.java'), source);
    }
    return nextConfig;
  }]);
  return withMainApplication(config, (nextConfig) => {
    if (nextConfig.modResults.language !== 'kt') {
      throw new Error('withAndroidHmrCompatibility supports Kotlin MainApplication only.');
    }
    nextConfig.modResults.contents = applyRegistration(nextConfig.modResults.contents);
    return nextConfig;
  });
}

withAndroidHmrCompatibility._internal = { createSource, applyRegistration };
module.exports = withAndroidHmrCompatibility;
