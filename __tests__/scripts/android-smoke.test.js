const { isInsufficientStorageInstallFailure } = require('../../scripts/android-smoke');

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
