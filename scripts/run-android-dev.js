#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { describeAndroidQaError } = require('./android-qa-sanitization');
const {
  captureOwnedProcessOwnership,
  spawnOwnedProcess,
  stopOwnedProcessTreeByPid,
} = require('./android-smoke');

const projectRoot = path.resolve(__dirname, '..');
const appConfigPath = path.join(projectRoot, 'app.json');
const androidSmokePath = path.join(projectRoot, 'scripts', 'android-smoke.js');
const androidDevGracefulTerminationTimeoutMs = 15_000;

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
    args: [
      path.join(root, 'scripts', 'android-smoke.js'),
      '--keep-metro-foreground',
      '--auto-target',
      ...extraArgs,
    ],
  };
}

function startAndroidDev(options = {}) {
  const root = options.projectRoot || projectRoot;
  const config = options.appConfig || readAppConfig(path.join(root, 'app.json'));
  const environment = buildAndroidDevEnvironment(options.environment || process.env, config);
  const invocation = buildAndroidDevInvocation(options.extraArgs || [], root);
  const spawnImpl = options.spawnImpl || spawn;
  const platform = options.platform || process.platform;
  const spawnOwnedProcessImpl = options.spawnOwnedProcessImpl || spawnOwnedProcess;

  if (!fs.existsSync(options.androidSmokePath || invocation.args[0])) {
    throw new Error('Android launcher is missing from scripts/android-smoke.js.');
  }

  console.log(
    `[android-dev] Using USB Metro loopback with app version ${environment.POCKET_AI_VERSION_NAME} (${environment.POCKET_AI_VERSION_CODE}).`
  );

  const child = spawnOwnedProcessImpl(invocation.command, invocation.args, {
    cwd: root,
    env: environment,
    stdio: 'inherit',
    windowsHide: false,
    detached: platform !== 'win32',
    platform,
    spawnImpl,
  });
  const expectedOwnershipBoundary = platform === 'win32'
    ? 'windows-job'
    : 'posix-process-group';
  if (child.pocketAiOwnershipBoundary !== expectedOwnershipBoundary) {
    child.kill?.('SIGTERM');
    throw new Error('Android launcher did not start inside the required ownership boundary.');
  }
  const captureOwnership = options.captureOwnedProcessOwnership || captureOwnedProcessOwnership;
  const ownershipSnapshot = captureOwnership(child.pid, {
    platform,
    ownershipBoundary: expectedOwnershipBoundary,
  });
  if (!ownershipSnapshot) {
    child.kill?.('SIGTERM');
    throw new Error(`Could not capture Android launcher ownership for PID ${child.pid}.`);
  }
  child.pocketAiOwnershipSnapshot = ownershipSnapshot;
  return child;
}

function attachAndroidDevLifecycle(child, processRef = process, options = {}) {
  let didSettle = false;
  let didForwardTerminationSignal = false;
  const removeSignalHandlers = () => {
    processRef.removeListener('SIGINT', onSigint);
    processRef.removeListener('SIGTERM', onSigterm);
  };
  const forwardSignal = (signal, exitCode) => {
    if (didSettle) {
      return;
    }
    didForwardTerminationSignal = true;
    processRef.exitCode = exitCode;
    try {
      const stopProcessTree = options.stopProcessTree ?? stopOwnedProcessTreeByPid;
      const ownershipSnapshot = child.pocketAiOwnershipSnapshot;
      const didStop = stopProcessTree(child.pid, {
        expectedIdentity: ownershipSnapshot?.processIdentity,
        expectedProcessTreeIdentities: ownershipSnapshot?.processTreeIdentities,
        ownershipBoundary:
          ownershipSnapshot?.ownershipBoundary ?? child.pocketAiOwnershipBoundary,
        gracefulTimeoutMs:
          options.gracefulTimeoutMs ?? androidDevGracefulTerminationTimeoutMs,
        trustedChildHandle: true,
        killRoot: () => child.kill(signal),
      });
      if (!didStop) {
        throw new Error(`could not stop launcher process tree ${child.pid}`);
      }
    } catch (error) {
      console.error(
        `[android-dev] Failed to forward ${signal}: ${describeAndroidQaError(error, 'signal-forward-failed')}`
      );
      processRef.exitCode = 1;
    }
  };
  const onSigint = () => forwardSignal('SIGINT', 130);
  const onSigterm = () => forwardSignal('SIGTERM', 143);

  processRef.once('SIGINT', onSigint);
  processRef.once('SIGTERM', onSigterm);
  child.once('error', (error) => {
    didSettle = true;
    removeSignalHandlers();
    console.error(
      `[android-dev] Failed to start Expo: ${describeAndroidQaError(error, 'expo-start-failed')}`
    );
    processRef.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    didSettle = true;
    removeSignalHandlers();
    if (typeof code === 'number') {
      if (!didForwardTerminationSignal) {
        processRef.exitCode = code;
      }
      return;
    }

    if (signal && !processRef.exitCode) {
      console.error(`[android-dev] Expo stopped after signal ${signal}.`);
      processRef.exitCode = 1;
    }
  });

  return removeSignalHandlers;
}

function main() {
  let child;

  try {
    child = startAndroidDev({ extraArgs: process.argv.slice(2), androidSmokePath });
  } catch (error) {
    console.error(`[android-dev] ${describeAndroidQaError(error, 'android-dev-start-failed')}`);
    process.exitCode = 1;
    return;
  }

  attachAndroidDevLifecycle(child);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildAndroidDevEnvironment,
  buildAndroidDevInvocation,
  attachAndroidDevLifecycle,
  startAndroidDev,
};
