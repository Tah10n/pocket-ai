const {
  buildMetroBundlePath,
  evaluateApkReuse,
  evaluateInstallReuse,
  isInsufficientStorageInstallFailure,
  parseDumpsysPackageOutput,
  parsePackagePathOutput,
  sanitizeForFileName,
} = require('../../scripts/android-smoke');

describe('android-smoke Metro prewarm', () => {
  it('builds an Android bundle URL for prewarming Metro before app launch', () => {
    expect(buildMetroBundlePath()).toBe('/index.bundle?platform=android&dev=true&minify=false&lazy=true');
  });
});

describe('android-smoke storage failure detection', () => {
  it('detects the explicit ADB insufficient-storage install failure code', () => {
    expect(isInsufficientStorageInstallFailure('Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]')).toBe(true);
  });

  it('detects generic insufficient storage phrasing', () => {
    expect(isInsufficientStorageInstallFailure('adb: failed to install apk: insufficient storage')).toBe(true);
  });

  it('detects not-enough-space phrasing', () => {
    expect(isInsufficientStorageInstallFailure('INSTALL_PARSE_FAILED: not enough space on device')).toBe(true);
  });

  it('does not match unrelated install failures', () => {
    expect(isInsufficientStorageInstallFailure('Failure [INSTALL_FAILED_VERSION_DOWNGRADE]')).toBe(false);
  });
});

describe('android-smoke APK reuse decisions', () => {
  it('reuses the APK when the tracked fingerprint matches', () => {
    expect(
      evaluateApkReuse({
        apkExists: true,
        abiCompatible: true,
        fingerprintMatches: true,
        apkIsFreshByTime: false,
      })
    ).toEqual(
      expect.objectContaining({
        canReuse: true,
      })
    );
  });

  it('rebuilds when tracked native inputs are newer than the APK', () => {
    expect(
      evaluateApkReuse({
        apkExists: true,
        abiCompatible: true,
        fingerprintMatches: false,
        apkIsFreshByTime: false,
      })
    ).toEqual(
      expect.objectContaining({
        canReuse: false,
      })
    );
  });
});

describe('android-smoke install reuse decisions', () => {
  it('reuses an installed app only when stamp and device metadata still match', () => {
    expect(
      evaluateInstallReuse({
        packageInstalled: true,
        didBuildDebugApk: false,
        installStamp: {
          apkFingerprint: 'apk-1',
          packagePath: '/data/app/base.apk',
          lastUpdateTime: '2026-04-22 10:15:00',
          versionCode: '42',
        },
        apkFingerprint: { fingerprint: 'apk-1' },
        devicePackageInfo: {
          installed: true,
          packagePath: '/data/app/base.apk',
          lastUpdateTime: '2026-04-22 10:15:00',
          versionCode: '42',
        },
      })
    ).toEqual(
      expect.objectContaining({
        canReuse: true,
      })
    );
  });

  it('forces reinstall when the install stamp points to another APK', () => {
    expect(
      evaluateInstallReuse({
        packageInstalled: true,
        didBuildDebugApk: false,
        installStamp: {
          apkFingerprint: 'apk-old',
          packagePath: '/data/app/base.apk',
        },
        apkFingerprint: { fingerprint: 'apk-new' },
        devicePackageInfo: {
          installed: true,
          packagePath: '/data/app/base.apk',
          lastUpdateTime: '2026-04-22 10:15:00',
          versionCode: '42',
        },
      })
    ).toEqual(
      expect.objectContaining({
        canReuse: false,
      })
    );
  });
});

describe('android-smoke package metadata parsing', () => {
  it('extracts the base package path from pm output', () => {
    expect(
      parsePackagePathOutput('package:/data/app/~~abc/base.apk\npackage:/data/app/~~abc/split_config.en.apk\n')
    ).toBe('/data/app/~~abc/base.apk');
  });

  it('extracts lastUpdateTime and versionCode from dumpsys output', () => {
    expect(
      parseDumpsysPackageOutput('Packages:\n  Package [com.test.app] (123):\n    versionCode=42 minSdk=24\n    lastUpdateTime=2026-04-22 10:15:00\n')
    ).toEqual({
      lastUpdateTime: '2026-04-22 10:15:00',
      versionCode: '42',
    });
  });

  it('sanitizes device identifiers for cache file names', () => {
    expect(sanitizeForFileName('emulator-5554/com.test.app')).toBe('emulator-5554_com.test.app');
  });
});
