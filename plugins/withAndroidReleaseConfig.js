const { withAndroidManifest, withAppBuildGradle } = require('expo/config-plugins');
const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode');

const BLOCKED_PERMISSIONS = new Set([
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.SYSTEM_ALERT_WINDOW',
]);

function escapeGroovyDoubleQuotedString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function createReleaseConfigBlock({
  defaultVersionCode,
  defaultVersionName,
}) {
  const safeVersionCode = Number.isInteger(defaultVersionCode) && defaultVersionCode > 0 ? defaultVersionCode : 1;
  const safeVersionName = defaultVersionName ? escapeGroovyDoubleQuotedString(defaultVersionName) : '1.0.0';

  return `def keystoreProperties = new Properties()
def keystorePropertiesFile = rootProject.file("../keystore.properties")
if (keystorePropertiesFile.exists()) {
    keystorePropertiesFile.withInputStream { stream ->
        keystoreProperties.load(stream)
    }
}

def resolveStoreFileValue = { configuredPath ->
    if (configuredPath == null || !configuredPath.toString().trim()) {
        return null
    }

    def configuredFile = new File(configuredPath.toString().trim())
    if (configuredFile.isAbsolute()) {
        return configuredFile.absolutePath
    }

    return new File(keystorePropertiesFile.parentFile, configuredPath.toString().trim()).absolutePath
}

def resolveConfigValue = { gradleKey, envKey, propertiesKey ->
    def gradleValue = findProperty(gradleKey)
    if (gradleValue != null && gradleValue.toString().trim()) {
        return gradleValue.toString().trim()
    }

    def envValue = System.getenv(envKey)
    if (envValue != null && envValue.toString().trim()) {
        return envValue.toString().trim()
    }

    def propertyValue = keystoreProperties.getProperty(propertiesKey)
    if (propertyValue != null && propertyValue.toString().trim()) {
        return propertyValue.toString().trim()
    }

    return null
}

def resolveBooleanValue = { gradleKey, envKey, defaultValue ->
    def gradleValue = findProperty(gradleKey)
    if (gradleValue != null) {
        return gradleValue.toString().toLowerCase() in ["1", "true", "yes", "y"]
    }

    def envValue = System.getenv(envKey)
    if (envValue != null) {
        return envValue.toString().toLowerCase() in ["1", "true", "yes", "y"]
    }

    return defaultValue
}

def pocketAiDefaultVersionCode = ${safeVersionCode}
def pocketAiDefaultVersionName = "${safeVersionName}"

def appVersionCodeValue = (findProperty("pocketAiVersionCode") ?: System.getenv("POCKET_AI_VERSION_CODE") ?: pocketAiDefaultVersionCode).toString()
def appVersionNameValue = (findProperty("pocketAiVersionName") ?: System.getenv("POCKET_AI_VERSION_NAME") ?: pocketAiDefaultVersionName).toString()
def appVersionCode = appVersionCodeValue.toInteger()

def releaseStoreFile = resolveStoreFileValue(resolveConfigValue("pocketAiUploadStoreFile", "POCKET_AI_UPLOAD_STORE_FILE", "storeFile"))
def releaseStorePassword = resolveConfigValue("pocketAiUploadStorePassword", "POCKET_AI_UPLOAD_STORE_PASSWORD", "storePassword")
def releaseKeyAlias = resolveConfigValue("pocketAiUploadKeyAlias", "POCKET_AI_UPLOAD_KEY_ALIAS", "keyAlias")
def releaseKeyPassword = resolveConfigValue("pocketAiUploadKeyPassword", "POCKET_AI_UPLOAD_KEY_PASSWORD", "keyPassword")
def hasReleaseSigning = [releaseStoreFile, releaseStorePassword, releaseKeyAlias, releaseKeyPassword].every { it } &&
    new File(releaseStoreFile).exists()

def allowDebugReleaseSigning = resolveBooleanValue(
    "pocketAiAllowDebugReleaseSigning",
    "POCKET_AI_ALLOW_DEBUG_RELEASE_SIGNING",
    false
)

def isReleaseArtifactTaskName = { taskName ->
    def normalized = taskName.toString().toLowerCase()
    def isRelease = normalized.contains("release")
    def isArtifact = normalized.contains("bundle") || normalized.contains("assemble") || normalized.contains("package") || normalized.contains("install")
    return isRelease && isArtifact
}

gradle.taskGraph.whenReady { taskGraph ->
    def wantsSignedReleaseArtifact = taskGraph.allTasks.any { task ->
        return isReleaseArtifactTaskName(task.name) || isReleaseArtifactTaskName(task.path)
    }

    if (wantsSignedReleaseArtifact && !hasReleaseSigning) {
        if (!allowDebugReleaseSigning) {
            throw new GradleException(
                "Pocket AI upload signing is not configured. Create keystore.properties and keystores/... or set POCKET_AI_UPLOAD_* environment variables. " +
                "To build a debug-signed release artifact for local testing only, set POCKET_AI_ALLOW_DEBUG_RELEASE_SIGNING=true."
            )
        }

        logger.lifecycle("Pocket AI release signing is not configured. Falling back to the debug keystore for local builds.")
    }
}`;
}

const RELEASE_CONFIG_SENTINEL = 'def keystorePropertiesFile = rootProject.file("../keystore.properties")';
const RELEASE_CONFIG_TAG = 'pocket-ai-release-config';
const RELEASE_SIGNING_TAG = 'pocket-ai-release-signing';

const RELEASE_SIGNING_BLOCK = `        if (hasReleaseSigning) {
            release {
                storeFile file(releaseStoreFile)
                storePassword releaseStorePassword
                keyAlias releaseKeyAlias
                keyPassword releaseKeyPassword
            }
        }
`;

const DEFAULT_RELEASE_SIGNING_BLOCK = `            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug
`;

function parseBuildGradleDefaults(buildGradle, { fallbackVersionCode, fallbackVersionName }) {
  const versionCodeMatch = buildGradle.match(/\bversionCode\s+(\d+)\b/);
  const parsedVersionCode = versionCodeMatch ? Number.parseInt(versionCodeMatch[1], 10) : undefined;

  const versionNameMatch = buildGradle.match(/\bversionName\s+["']([^"']+)["']/);
  const parsedVersionName = versionNameMatch ? versionNameMatch[1] : undefined;

  return {
    defaultVersionCode:
      Number.isInteger(parsedVersionCode) && parsedVersionCode > 0
        ? parsedVersionCode
        : (fallbackVersionCode ?? 1),
    defaultVersionName: parsedVersionName || fallbackVersionName || '1.0.0',
  };
}

function applyBuildGradleReleaseConfig(buildGradle, configDefaults) {
  let contents = buildGradle;

  const defaults = parseBuildGradleDefaults(contents, configDefaults);
  const releaseConfigBlock = createReleaseConfigBlock(defaults);

  const hasGeneratedReleaseConfig = contents.includes(`@generated begin ${RELEASE_CONFIG_TAG} -`);
  const hasManualReleaseConfig = contents.includes(RELEASE_CONFIG_SENTINEL);

  if (hasGeneratedReleaseConfig || !hasManualReleaseConfig) {
    const projectRootAnchor =
      /def projectRoot\s*=\s*rootDir\.getAbsoluteFile\(\)\.getParentFile\(\)\.getAbsolutePath\(\)\s*/;

    if (projectRootAnchor.test(contents)) {
      const mergeResult = mergeContents({
        src: contents,
        newSrc: releaseConfigBlock,
        tag: RELEASE_CONFIG_TAG,
        anchor: projectRootAnchor,
        offset: 1,
        comment: '//',
      });
      contents = mergeResult.contents;
    } else if (/react\s*\{/.test(contents)) {
      console.warn(
        '[withAndroidReleaseConfig] Could not find `def projectRoot = ...`; inserting release config before `react {`.'
      );
      const mergeResult = mergeContents({
        src: contents,
        newSrc: releaseConfigBlock,
        tag: RELEASE_CONFIG_TAG,
        anchor: /react\s*\{/,
        offset: 0,
        comment: '//',
      });
      contents = mergeResult.contents;
    } else {
      console.warn(
        '[withAndroidReleaseConfig] Could not find a safe insertion point for release config in app/build.gradle.'
      );
    }
  }

  if (!contents.includes(RELEASE_CONFIG_SENTINEL)) {
    console.warn(
      '[withAndroidReleaseConfig] Release config block was not applied; skipping versioning and signing changes to app/build.gradle.'
    );
    return contents;
  }

  contents = contents.replace(/\bversionCode\s+\d+\b/, 'versionCode appVersionCode');
  contents = contents.replace(/\bversionName\s+["'][^"']+["']/, 'versionName appVersionNameValue');

  const hasGeneratedReleaseSigning = contents.includes(`@generated begin ${RELEASE_SIGNING_TAG} -`);
  const hasReleaseSigningConfig =
    hasGeneratedReleaseSigning ||
    contents.includes('storeFile file(releaseStoreFile)') ||
    contents.includes('storeFile rootProject.file(releaseStoreFile)');

  if (!hasReleaseSigningConfig) {
    if (/signingConfigs\s*\{/.test(contents)) {
      contents = mergeContents({
        src: contents,
        newSrc: RELEASE_SIGNING_BLOCK.trimEnd(),
        tag: RELEASE_SIGNING_TAG,
        anchor: /signingConfigs\s*\{/,
        offset: 1,
        comment: '//',
      }).contents;
    } else {
      console.warn('[withAndroidReleaseConfig] Could not find `signingConfigs {` in app/build.gradle.');
    }
  }

  if (contents.includes('signingConfig hasReleaseSigning ? signingConfigs.release : signingConfigs.debug')) {
    return contents;
  }

  if (contents.includes(DEFAULT_RELEASE_SIGNING_BLOCK)) {
    contents = contents.replace(
      DEFAULT_RELEASE_SIGNING_BLOCK,
      '            signingConfig hasReleaseSigning ? signingConfigs.release : signingConfigs.debug\n'
    );
    return contents;
  }

  const releaseSigningConfigRegex =
    /(buildTypes\s*\{[\s\S]*?\brelease\s*\{[\s\S]*?)^\s*signingConfig\s+signingConfigs\.debug\s*$/m;
  if (releaseSigningConfigRegex.test(contents)) {
    contents = contents.replace(
      releaseSigningConfigRegex,
      '$1            signingConfig hasReleaseSigning ? signingConfigs.release : signingConfigs.debug'
    );
    return contents;
  }

  const insertAfterReleaseBlockStartRegex = /(buildTypes\s*\{[\s\S]*?\brelease\s*\{\s*\n)/;
  if (insertAfterReleaseBlockStartRegex.test(contents)) {
    contents = contents.replace(
      insertAfterReleaseBlockStartRegex,
      '$1            signingConfig hasReleaseSigning ? signingConfigs.release : signingConfigs.debug\n'
    );
  } else {
    console.warn(
      '[withAndroidReleaseConfig] Could not find `buildTypes { release {` in app/build.gradle to configure signing.'
    );
  }

  return contents;
}

module.exports = function withAndroidReleaseConfig(config) {
  const configDefaults = {
    fallbackVersionCode: config.android?.versionCode,
    fallbackVersionName: config.version,
  };

  config = withAndroidManifest(config, (nextConfig) => {
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

  return withAppBuildGradle(config, (nextConfig) => {
    if (nextConfig.modResults.language === 'groovy') {
      nextConfig.modResults.contents = applyBuildGradleReleaseConfig(nextConfig.modResults.contents, configDefaults);
    }

    return nextConfig;
  });
};
