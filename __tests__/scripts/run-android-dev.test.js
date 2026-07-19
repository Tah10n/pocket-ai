const path = require('path');
const { EventEmitter } = require('events');

const {
  buildAndroidDevEnvironment,
  buildAndroidDevInvocation,
  startAndroidDev,
} = require('../../scripts/run-android-dev');

describe('Android development launcher', () => {
  const appConfig = {
    expo: {
      version: '1.6.0',
      android: {
        versionCode: 19,
      },
    },
  };

  it('forces USB loopback and tracked Expo version metadata', () => {
    const environment = buildAndroidDevEnvironment(
      {
        KEEP_ME: 'yes',
        REACT_NATIVE_PACKAGER_HOSTNAME: '192.168.1.50',
        POCKET_AI_VERSION_CODE: '12',
        POCKET_AI_VERSION_NAME: '1.2.0',
      },
      appConfig
    );

    expect(environment).toEqual(
      expect.objectContaining({
        KEEP_ME: 'yes',
        REACT_NATIVE_PACKAGER_HOSTNAME: '127.0.0.1',
        POCKET_AI_VERSION_CODE: '19',
        POCKET_AI_VERSION_NAME: '1.6.0',
      })
    );
  });

  it.each([
    [{ expo: { android: { versionCode: 19 } } }, 'expo.version'],
    [{ expo: { version: '1.6.0', android: { versionCode: 0 } } }, 'expo.android.versionCode'],
    [{ expo: { version: '1.6.0', android: { versionCode: 19.5 } } }, 'expo.android.versionCode'],
  ])('rejects incomplete or invalid version configuration', (config, expectedMessage) => {
    expect(() => buildAndroidDevEnvironment({}, config)).toThrow(expectedMessage);
  });

  it('passes extra Android launcher arguments without a shell wrapper', () => {
    const root = path.resolve('C:\\projects\\pocket-ai');
    const invocation = buildAndroidDevInvocation(['--serial', 'phone-1', '--port', '8082'], root);

    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args).toEqual([
      path.join(root, 'scripts', 'android-smoke.js'),
      '--keep-metro-foreground',
      '--serial',
      'phone-1',
      '--port',
      '8082',
    ]);
  });

  it('spawns the attached Android launcher with the hardened environment', () => {
    const child = new EventEmitter();
    const spawnImpl = jest.fn(() => child);
    const root = path.resolve(__dirname, '..', '..');

    expect(
      startAndroidDev({
        projectRoot: root,
        appConfig,
        environment: { KEEP_ME: 'yes' },
        extraArgs: ['--serial', 'phone-1'],
        spawnImpl,
      })
    ).toBe(child);

    expect(spawnImpl).toHaveBeenCalledWith(
      process.execPath,
      [
        path.join(root, 'scripts', 'android-smoke.js'),
        '--keep-metro-foreground',
        '--serial',
        'phone-1',
      ],
      expect.objectContaining({
        cwd: root,
        stdio: 'inherit',
        windowsHide: false,
        env: expect.objectContaining({
          KEEP_ME: 'yes',
          REACT_NATIVE_PACKAGER_HOSTNAME: '127.0.0.1',
          POCKET_AI_VERSION_CODE: '19',
          POCKET_AI_VERSION_NAME: '1.6.0',
        }),
      })
    );
  });
});
