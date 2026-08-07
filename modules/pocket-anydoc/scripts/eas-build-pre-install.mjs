import { fail, run } from './build-utils.mjs';

const platform = process.env.EAS_BUILD_PLATFORM;
if (platform !== 'android' && platform !== 'ios') {
  fail('EAS_BUILD_PLATFORM must be android or ios.');
}

run(process.execPath, ['./scripts/setup.mjs', `--platform=${platform}`]);
if (platform === 'ios') {
  // CocoaPods evaluates vendored_frameworks during pod installation, so the
  // deterministic XCFramework must exist before that phase. The podspec does
  // not run networked or mutating prepare commands.
  run(process.execPath, ['./scripts/build-ios.mjs']);
}

console.log(`[pocket-anydoc] EAS pre-install prerequisites complete for ${platform}.`);
