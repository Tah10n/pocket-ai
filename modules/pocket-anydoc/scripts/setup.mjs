import {
  ANDROID_TARGETS,
  CARGO_NDK_VERSION,
  IOS_TARGETS,
  commandExists,
  fail,
  isExactCargoNdkVersion,
  readPinnedToolchain,
  run,
} from './build-utils.mjs';

const requestedPlatform = process.argv.find((argument) => argument.startsWith('--platform='))?.split('=')[1]
  ?? process.env.EAS_BUILD_PLATFORM
  ?? 'all';

if (!['all', 'android', 'ios'].includes(requestedPlatform)) {
  fail(`Unsupported setup platform: ${requestedPlatform}`);
}
if (!commandExists('rustup')) {
  fail('rustup is required. Install it from https://rustup.rs and rerun anydoc:setup.');
}

const toolchain = readPinnedToolchain();
run('rustup', ['toolchain', 'install', toolchain, '--profile', 'minimal', '--component', 'rustfmt', '--component', 'clippy']);

let targets = requestedPlatform === 'android'
  ? ANDROID_TARGETS
  : requestedPlatform === 'ios'
    ? IOS_TARGETS
    : [...ANDROID_TARGETS, ...IOS_TARGETS];

if (process.platform !== 'darwin' && targets.some((target) => target.includes('apple-ios'))) {
  if (requestedPlatform === 'ios') {
    fail('iOS setup requires macOS with Xcode.');
  }
  targets = targets.filter((target) => !target.includes('apple-ios'));
}

run('rustup', ['target', 'add', '--toolchain', toolchain, ...targets]);

if (requestedPlatform === 'android' || requestedPlatform === 'all') {
  const cargoNdkVersion = commandExists('cargo', ['ndk', '--version'])
    ? run('cargo', ['ndk', '--version'], { capture: true })
    : '';
  if (!isExactCargoNdkVersion(cargoNdkVersion)) {
    run('cargo', [`+${toolchain}`, 'install', 'cargo-ndk', '--version', CARGO_NDK_VERSION, '--locked']);
  }
}

console.log(`[pocket-anydoc] Rust ${toolchain} setup complete for ${requestedPlatform}.`);
