const fs = require('node:fs');
const path = require('node:path');
const { ExpoModuleConfig } = require('expo-modules-autolinking/build/ExpoModuleConfig');
const { resolveModuleAsync } = require('expo-modules-autolinking/build/platforms/apple/apple');

it('resolves the phonemizer pod at the module root so core, engine and data stay inside CocoaPods scope', async () => {
  const moduleRoot = path.resolve(__dirname, '../../modules/pocket-phonemizer');
  const config = new ExpoModuleConfig(JSON.parse(fs.readFileSync(path.join(moduleRoot, 'expo-module.config.json'), 'utf8')));
  const resolved = await resolveModuleAsync('pocket-phonemizer', { path: moduleRoot, version: '0.0.1', config }, {});
  expect(resolved.pods).toEqual([{ podName: 'PocketPhonemizer', podspecDir: moduleRoot }]);
  expect(resolved.modules).toContainEqual({ name: null, class: 'PocketPhonemizerModule' });
  for (const relative of ['cpp/PhonemizerCore.cpp', 'ios/PocketPhonemizerBridge.mm', 'assets/data-manifest.json', 'assets/espeak-ng-data']) {
    const file = path.join(moduleRoot, relative);
    expect(fs.existsSync(file)).toBe(true);
    expect(path.relative(resolved.pods[0].podspecDir, file).split(path.sep)).not.toContain('..');
  }
});
it('requires the explicit Expo root podspec path rather than silently dropping the native module', async () => {
  const moduleRoot = path.resolve(__dirname, '../../modules/pocket-phonemizer');
  const config = JSON.parse(fs.readFileSync(path.join(moduleRoot, 'expo-module.config.json'), 'utf8'));
  delete config.apple.podspecPath;
  expect(await resolveModuleAsync('pocket-phonemizer', {
    path: moduleRoot, version: '0.0.1', config: new ExpoModuleConfig(config),
  }, {})).toBeNull();
});