const { withAndroidManifest } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const FOREGROUND_SERVICE_TYPE = 'dataSync';
const FOREGROUND_SERVICE_PERMISSION = 'android.permission.FOREGROUND_SERVICE';
const DATA_SYNC_PERMISSION = 'android.permission.FOREGROUND_SERVICE_DATA_SYNC';

function resolveBackgroundActionsServiceName(projectRoot) {
  const fallback = 'com.asterinet.react.bgactions.RNBackgroundActionsTask';

  try {
    const packageJsonPath = require.resolve('react-native-background-actions/package.json', {
      paths: [projectRoot],
    });
    const packageRoot = path.dirname(packageJsonPath);
    const manifestPath = path.join(packageRoot, 'android', 'src', 'main', 'AndroidManifest.xml');

    if (!fs.existsSync(manifestPath)) {
      return resolveFallbackServiceName(packageRoot, fallback);
    }

    const manifestXml = fs.readFileSync(manifestPath, 'utf8');
    const packageMatch = manifestXml.match(/<manifest\b[^>]*\bpackage=["']([^"']+)["']/);
    const manifestPackage = packageMatch?.[1]?.trim() ?? '';

    const serviceMatch = manifestXml.match(/<service\b[^>]*\bandroid:name=["']([^"']+)["']/);
    const manifestService = serviceMatch?.[1]?.trim() ?? '';

    if (!manifestService) {
      return resolveFallbackServiceName(packageRoot, fallback);
    }

    if (manifestService.startsWith('.')) {
      if (manifestPackage) {
        return `${manifestPackage}${manifestService}`;
      }
      return resolveFallbackServiceName(packageRoot, fallback);
    }

    if (manifestService.includes('.')) {
      return manifestService;
    }

    if (manifestPackage) {
      return `${manifestPackage}.${manifestService}`;
    }

    return resolveFallbackServiceName(packageRoot, fallback);
  } catch {
    return null;
  }
}

function resolveFallbackServiceName(packageRoot, fallbackServiceName) {
  try {
    const javaRoot = path.join(packageRoot, 'android', 'src', 'main', 'java');
    const parts = fallbackServiceName.split('.').filter(Boolean);
    if (parts.length < 2) {
      return null;
    }

    const className = parts.pop();
    const javaFilePath = path.join(javaRoot, ...parts, `${className}.java`);
    const kotlinFilePath = path.join(javaRoot, ...parts, `${className}.kt`);
    return fs.existsSync(javaFilePath) || fs.existsSync(kotlinFilePath) ? fallbackServiceName : null;
  } catch {
    return null;
  }
}

function ensureToolsNamespace(manifest) {
  manifest.$ = manifest.$ || {};
  if (!manifest.$['xmlns:tools']) {
    manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
  }
}

function ensureUsesPermission(manifest, permissionName) {
  manifest['uses-permission'] = manifest['uses-permission'] || [];
  const hasPermission = manifest['uses-permission'].some(
    (permission) => permission?.$?.['android:name'] === permissionName,
  );
  if (!hasPermission) {
    manifest['uses-permission'].push({ $: { 'android:name': permissionName } });
  }
}

function mergeToolsReplaceValue(existingValue, attributeName) {
  if (!existingValue || typeof existingValue !== 'string') {
    return attributeName;
  }

  const parts = existingValue
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  if (!parts.includes(attributeName)) {
    parts.push(attributeName);
  }

  return parts.join(',');
}

function ensureBackgroundActionsService(application, serviceName) {
  application.service = application.service || [];

  const existingService = application.service.find(
    (service) => service?.$?.['android:name'] === serviceName,
  );

  if (existingService) {
    existingService.$ = existingService.$ || {};
    existingService.$['android:foregroundServiceType'] = FOREGROUND_SERVICE_TYPE;
    existingService.$['tools:replace'] = mergeToolsReplaceValue(
      existingService.$['tools:replace'],
      'android:foregroundServiceType',
    );
    return;
  }

  application.service.push({
    $: {
      'android:name': serviceName,
      'android:foregroundServiceType': FOREGROUND_SERVICE_TYPE,
      'tools:replace': 'android:foregroundServiceType',
    },
  });
}

module.exports = function withAndroidBackgroundActionsForegroundService(config) {
  return withAndroidManifest(config, (nextConfig) => {
    const projectRoot = nextConfig.modRequest?.projectRoot;
    const serviceName = projectRoot ? resolveBackgroundActionsServiceName(projectRoot) : null;

    const manifest = nextConfig.modResults.manifest;
    if (!manifest) {
      console.warn('[withAndroidBackgroundActionsForegroundService] Missing manifest; skipping.');
      return nextConfig;
    }

    ensureToolsNamespace(manifest);
    ensureUsesPermission(manifest, FOREGROUND_SERVICE_PERMISSION);
    ensureUsesPermission(manifest, DATA_SYNC_PERMISSION);

    const application = manifest.application?.[0];
    if (!application) {
      console.warn('[withAndroidBackgroundActionsForegroundService] Missing application node; skipping.');
      return nextConfig;
    }

    if (!serviceName) {
      console.warn(
        '[withAndroidBackgroundActionsForegroundService] Could not resolve background-actions service name; skipping service override.'
      );
      return nextConfig;
    }

    ensureBackgroundActionsService(application, serviceName);
    return nextConfig;
  });
};
