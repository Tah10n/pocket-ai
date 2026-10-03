const { applyBuildGradleReleaseConfig } = require('../../plugins/withAndroidReleaseConfig')._internal;

const defaults = {
  fallbackApplicationId: 'com.github.tah10n.pocketai', fallbackVersionCode: 20, fallbackVersionName: '1.6.3',
};
const source = `def projectRoot = rootDir.getAbsoluteFile().getParentFile().getAbsolutePath()
react {
  autolinkLibrariesWithApp()
}
android {
  defaultConfig {
    applicationId 'com.github.tah10n.pocketai'
    versionCode 20
    versionName '1.6.3'
  }
  signingConfigs {
    debug {}
  }
  buildTypes {
    debug {}
    release {
      signingConfig signingConfigs.debug
    }
  }
}
dependencies {
  implementation('com.facebook.react:react-android')
}`;

describe('isolated QA release private-file access plugin', () => {
  it('generates one idempotent opt-in release gate while retaining the embedded-bundle variant contract', () => {
    const first = applyBuildGradleReleaseConfig(source, defaults);
    expect(applyBuildGradleReleaseConfig(first, defaults)).toBe(first);
    const start = first.indexOf('// @generated begin pocket-ai-qa-private-file-access');
    const guarded = first.slice(start);
    expect(first.match(/@generated begin pocket-ai-qa-private-file-access/gu)).toHaveLength(1);
    expect(guarded).toContain('pocketAiQaPrivateFileAccessValue == "1"');
    expect(guarded).toContain('pocketAiQaPrivateFileAccessValue in ["0", "1"]');
    expect(guarded).toContain('appApplicationId != pocketAiIsolatedQaApplicationId');
    expect(guarded).toContain('System.getenv("EXPO_PUBLIC_ANDROID_QA") != "1"');
    expect(guarded).toContain('!allowDebugReleaseSigning || hasReleaseSigning');
    expect(guarded).toContain('System.getenv("POCKET_AI_SHIPPING_BUILD")');
    expect(guarded).toContain('android.buildTypes.getByName("release").debuggable = pocketAiQaPrivateFileAccessEnabled');
    expect(guarded).toContain('android.buildTypes.getByName("release").debuggable != pocketAiQaPrivateFileAccessEnabled');
    expect(guarded).toContain('project.extensions.getByType(com.facebook.react.ReactExtension).debuggableVariants.get().any { it.equalsIgnoreCase("release") }');
    expect(guarded).toContain('must retain the embedded Release JavaScript bundle');
    expect(start).toBeGreaterThan(first.indexOf('dependencies {'));
    expect(first).not.toMatch(/debuggable\s+true|debuggableVariants\s*=/u);
    expect(first).toContain('signingConfig hasReleaseSigning ? signingConfigs.release : signingConfigs.debug');
    expect(first).toContain('applicationId appApplicationId');
  });

  it('reads the typed RN extension when the legacy ext.react compatibility map shadows the project property', () => {
    const generated = applyBuildGradleReleaseConfig(`project.ext.react = [:]\n${source}`, defaults);
    const guarded = generated.slice(generated.indexOf('// @generated begin pocket-ai-qa-private-file-access'));
    expect(generated).toContain('project.ext.react = [:]');
    expect(guarded).toContain('project.extensions.getByType(com.facebook.react.ReactExtension).debuggableVariants.get()');
    expect(guarded).not.toMatch(/\breact\.debuggableVariants/u);
    expect(guarded).not.toContain('findByType');
    expect(guarded).toContain('must retain the embedded Release JavaScript bundle');
  });
  it('replaces an old generated gate and checks final release state after earlier custom debuggable settings', () => {
    const old = source.replace('release {\n', 'release {\n      debuggable true\n')
      + '\n// @generated begin pocket-ai-qa-private-file-access - old\nandroid.buildTypes.release.debuggable = true\n// @generated end pocket-ai-qa-private-file-access\n';
    const result = applyBuildGradleReleaseConfig(old, defaults);
    expect(result).not.toContain('android.buildTypes.release.debuggable = true');
    expect(result.match(/@generated begin pocket-ai-qa-private-file-access/gu)).toHaveLength(1);
    expect(result.lastIndexOf('android.buildTypes.getByName("release").debuggable =')).toBeGreaterThan(result.indexOf('debuggable true'));
    expect(result).toContain('gradle.taskGraph.whenReady {\n    if (android.buildTypes.getByName("release").debuggable != pocketAiQaPrivateFileAccessEnabled)');
  });
});
