const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

jest.mock('expo/config-plugins', () => ({
  withDangerousMod: (config, [, action]) => action(config),
  withSettingsGradle: (config, action) => action(config),
}));

const withAndroidGradlePluginManagement = require('../../plugins/withAndroidGradlePluginManagement');
const {
  ANDROID_GRADLE_WRAPPER_VERSION,
  ensureAndroidGradleWrapperVersion,
  updateAndroidGradleWrapperFile,
} = withAndroidGradlePluginManagement._internal;

describe('withAndroidGradlePluginManagement', () => {
  it('registers the wrapper rewrite while retaining plugin management', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-ai-gradle-wrapper-'));
    const wrapperDirectory = path.join(tempRoot, 'gradle', 'wrapper');
    const wrapperPath = path.join(wrapperDirectory, 'gradle-wrapper.properties');
    fs.mkdirSync(wrapperDirectory, { recursive: true });
    fs.writeFileSync(
      wrapperPath,
      'distributionBase=GRADLE_USER_HOME\n'
        + 'distributionUrl=https\\://services.gradle.org/distributions/gradle-9.0.0-bin.zip\n',
      'utf8'
    );

    try {
      const config = {
        modRequest: { platformProjectRoot: tempRoot },
        modResults: {
          language: 'groovy',
          contents: 'pluginManagement {\n}\n',
        },
      };

      const result = await withAndroidGradlePluginManagement(config);
      const wrapper = fs.readFileSync(wrapperPath, 'utf8');

      expect(result.modResults.contents).toContain('pocket-ai-plugin-management');
      expect(wrapper).toContain(
        `distributionUrl=https\\://services.gradle.org/distributions/gradle-${ANDROID_GRADLE_WRAPPER_VERSION}-bin.zip`
      );
      expect(wrapper).not.toContain('gradle-9.0.0-bin.zip');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('is idempotent and fails closed for missing or duplicate wrapper declarations', () => {
    const pinned =
      `distributionUrl=https\\://services.gradle.org/distributions/gradle-${ANDROID_GRADLE_WRAPPER_VERSION}-bin.zip\n`;

    expect(ensureAndroidGradleWrapperVersion(pinned)).toBe(pinned);
    expect(() => ensureAndroidGradleWrapperVersion('networkTimeout=10000\n'))
      .toThrow('missing distributionUrl');
    expect(() => ensureAndroidGradleWrapperVersion(
      'distributionUrl=https\\://services.gradle.org/distributions/gradle-9.0.0-bin.zip\n'
        + 'distributionUrl=https\\://services.gradle.org/distributions/gradle-9.1.0-bin.zip\n'
    )).toThrow('exactly one distributionUrl');
  });

  it('redacts native filesystem details on wrapper read and write failures', () => {
    const privatePath = 'C:\\Users\\private\\generated\\gradle-wrapper.properties';
    const pathBearingError = new Error(
      `ENOENT: no such file or directory, open '${privatePath}'`
    );
    const readFailureIo = {
      readFileSync: () => {
        throw pathBearingError;
      },
    };
    const writeFailureIo = {
      readFileSync: () => (
        'distributionUrl=https\\://services.gradle.org/distributions/gradle-9.0.0-bin.zip\n'
      ),
      writeFileSync: () => {
        throw pathBearingError;
      },
    };

    expect(() => updateAndroidGradleWrapperFile(privatePath, readFailureIo))
      .toThrow('Unable to read generated Android Gradle wrapper properties.');
    expect(() => updateAndroidGradleWrapperFile(privatePath, writeFailureIo))
      .toThrow('Unable to write generated Android Gradle wrapper properties.');

    for (const io of [readFailureIo, writeFailureIo]) {
      try {
        updateAndroidGradleWrapperFile(privatePath, io);
      } catch (error) {
        expect(error.message).not.toContain(privatePath);
        expect(error.message).not.toContain('ENOENT');
      }
    }
  });
});
