#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const appConfigPath = path.join(projectRoot, 'app.json');
const androidSmokePath = path.join(projectRoot, 'scripts', 'android-smoke.js');

function readAppConfig(configPath = appConfigPath) {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function buildAndroidDevEnvironment(baseEnvironment, appConfig) {
  const expoConfig = appConfig?.expo;
  const versionName = typeof expoConfig?.version === 'string'
    ? expoConfig.version.trim()
    : '';
  const versionCode = expoConfig?.android?.versionCode;

  if (!versionName) {
    throw new Error('app.json must define expo.version before running Android.');
  }

  if (!Number.isSafeInteger(versionCode) || versionCode <= 0) {
    throw new Error('app.json must define a positive integer expo.android.versionCode before running Android.');
  }

  return {
    ...baseEnvironment,
    // The connected-device workflow uses adb reverse. Advertising a LAN address can
    // leave the native splash screen visible when Windows or the Wi-Fi network blocks it.
    REACT_NATIVE_PACKAGER_HOSTNAME: '127.0.0.1',
    // The generated android/ directory is intentionally ignored and can outlive a version
    // bump. Keep local APK metadata aligned with the tracked Expo config on every run.
    POCKET_AI_VERSION_CODE: String(versionCode),
    POCKET_AI_VERSION_NAME: versionName,
  };
}

function buildAndroidDevInvocation(extraArgs = [], root = projectRoot) {
  return {
    command: process.execPath,
    args: [path.join(root, 'scripts', 'android-smoke.js'), '--keep-metro-foreground', ...extraArgs],
  };
}

function startAndroidDev(options = {}) {
  const root = options.projectRoot || projectRoot;
  const config = options.appConfig || readAppConfig(path.join(root, 'app.json'));
  const environment = buildAndroidDevEnvironment(options.environment || process.env, config);
  const invocation = buildAndroidDevInvocation(options.extraArgs || [], root);
  const spawnImpl = options.spawnImpl || spawn;

  if (!fs.existsSync(options.androidSmokePath || invocation.args[0])) {
    throw new Error('Android launcher is missing from scripts/android-smoke.js.');
  }

  console.log(
    `[android-dev] Using USB Metro loopback with app version ${environment.POCKET_AI_VERSION_NAME} (${environment.POCKET_AI_VERSION_CODE}).`
  );

  return spawnImpl(invocation.command, invocation.args, {
    cwd: root,
    env: environment,
    stdio: 'inherit',
    windowsHide: false,
  });
}

function main() {
  let child;

  try {
    child = startAndroidDev({ extraArgs: process.argv.slice(2), androidSmokePath });
  } catch (error) {
    console.error(`[android-dev] ${error.message}`);
    process.exitCode = 1;
    return;
  }

  child.once('error', (error) => {
    console.error(`[android-dev] Failed to start Expo: ${error.message}`);
    process.exitCode = 1;
  });

  child.once('exit', (code, signal) => {
    if (typeof code === 'number') {
      process.exitCode = code;
      return;
    }

    if (signal) {
      console.error(`[android-dev] Expo stopped after signal ${signal}.`);
    }
    process.exitCode = 1;
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  buildAndroidDevEnvironment,
  buildAndroidDevInvocation,
  startAndroidDev,
};
