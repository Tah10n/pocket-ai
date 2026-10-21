const { applyBuildGradleReleaseConfig } = require('../../plugins/withAndroidReleaseConfig')._internal;
const { resolveAndroidQaApplicationId } = require('../../scripts/android-qa-application-id');

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
  it('regenerates the exact named-instance selector using the shared full-segment admission rule', () => {
    const generated = applyBuildGradleReleaseConfig(source, defaults);
    expect(applyBuildGradleReleaseConfig(generated, defaults)).toBe(generated);
    const emittedPattern = generated.match(/pocketAiQaInstance\.matches\('([^']+)'\)/u)?.[1];
    expect(emittedPattern).toBeDefined();
    const fullMatch = new RegExp(`^(?:${emittedPattern})$`);
    for (const instance of ['stage7', 'a', 'a'.repeat(32)]) {
      expect(fullMatch.test(instance)).toBe(true);
      expect(resolveAndroidQaApplicationId(defaults.fallbackApplicationId, true, instance))
        .toBe(`${defaults.fallbackApplicationId}.${instance}.qa`);
    }
    for (const instance of ['', 'Stage7', 'stage.7', 'stage-7', ' stage7', 'stage7 ', '7stage', 'a'.repeat(33)]) {
      expect(fullMatch.test(instance)).toBe(false);
      expect(() => resolveAndroidQaApplicationId(defaults.fallbackApplicationId, true, instance)).toThrow();
    }
    expect(generated).toContain('pocketAiIsolatedQaApplicationId = pocketAiDefaultApplicationId + "." + pocketAiQaInstance + ".qa"');
    expect(generated).toContain('pocketAiQaInstance != null && (appApplicationId != pocketAiIsolatedQaApplicationId');
    expect(generated).toContain('Android QA instance requires its exact isolated package and nonshipping QA controls.');
    expect(generated).toContain('!allowDebugReleaseSigning || hasReleaseSigning');
  });

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
