const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('expo/config-plugins');

function normalizeSdkPath(sdkDir) {
  return sdkDir.trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

function readSdkDirFromLocalProperties(localPropertiesPath) {
  if (!fs.existsSync(localPropertiesPath)) {
    return null;
  }

  const content = fs.readFileSync(localPropertiesPath, 'utf8');
  const match = content.match(/^\s*sdk\.dir=(.+)\s*$/m);
  return match ? match[1].trim() : null;
}

function pathExistsOrIsPermissionDenied(candidate) {
  try {
    fs.statSync(candidate);
    return true;
  } catch (error) {
    return error && (error.code === 'EACCES' || error.code === 'EPERM');
  }
}

function resolveDefaultSdkDir() {
  const candidates = [];
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'));
    }
    if (process.env.USERPROFILE) {
      candidates.push(path.join(process.env.USERPROFILE, 'AppData', 'Local', 'Android', 'Sdk'));
    }
    candidates.push('C:\\Android\\Sdk');
  } else if (process.platform === 'darwin') {
    if (process.env.HOME) {
      candidates.push(path.join(process.env.HOME, 'Library', 'Android', 'sdk'));
    }
  } else {
    if (process.env.HOME) {
      candidates.push(path.join(process.env.HOME, 'Android', 'Sdk'));
      candidates.push(path.join(process.env.HOME, 'Android', 'sdk'));
    }
  }

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (pathExistsOrIsPermissionDenied(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveSdkDir() {
  return (
    process.env.ANDROID_HOME ||
    process.env.ANDROID_SDK_ROOT ||
    resolveDefaultSdkDir()
  );
}

function ensureAndroidLocalProperties(projectRoot) {
  const androidRoot = path.join(projectRoot, 'android');
  const localPropertiesPath = path.join(androidRoot, 'local.properties');

  const existingSdkDir = readSdkDirFromLocalProperties(localPropertiesPath);
  if (existingSdkDir) {
    return;
  }

  const sdkDir = resolveSdkDir();
  if (!sdkDir) {
    console.warn(
      '[withAndroidLocalProperties] Android SDK location not found. ' +
        'Set ANDROID_HOME/ANDROID_SDK_ROOT or create android/local.properties with sdk.dir=...'
    );
    return;
  }

  fs.mkdirSync(androidRoot, { recursive: true });
  const normalizedSdkDir = normalizeSdkPath(sdkDir);

  const prefix = fs.existsSync(localPropertiesPath)
    ? `${fs.readFileSync(localPropertiesPath, 'utf8').replace(/\s*$/, '')}\n`
    : '';

  fs.writeFileSync(localPropertiesPath, `${prefix}sdk.dir=${normalizedSdkDir}\n`, 'utf8');
  console.log(`[withAndroidLocalProperties] Wrote android/local.properties (sdk.dir=${normalizedSdkDir}).`);
}

module.exports = function withAndroidLocalProperties(config) {
  return withDangerousMod(config, [
    'android',
    async (nextConfig) => {
      if (nextConfig.modRequest.introspect) {
        return nextConfig;
      }

      ensureAndroidLocalProperties(nextConfig.modRequest.projectRoot);
      return nextConfig;
    },
  ]);
};
