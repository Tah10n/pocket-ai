const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const { ESLint } = require('eslint');

const appRoot = path.resolve(__dirname, '../..');
const generated = [
  'modules/pocket-phonemizer/generated/native-tests/CMakeFiles/espeak.dir/compiler_depend.ts',
  'modules/pocket-phonemizer/android/build/CMakeFiles/compiler_depend.ts',
  'modules/pocket-phonemizer/android/.cxx/Release/compiler_depend.ts',
  'modules/pocket-phonemizer/android/.gradle/generated/compiler_depend.ts',
];
const ownedSources = [
  'modules/pocket-phonemizer/index.ts',
  'modules/pocket-phonemizer/src/contract.ts',
  'modules/pocket-phonemizer/scripts/source-check.ts',
  'src/config-regression.ts',
];
let fixture;
beforeEach(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-native-config-'));
  for (const relative of [...generated, ...ownedSources, 'node_modules/fixture/index.ts', 'android/generated.ts', 'ios/generated.ts']) {
    const file = path.join(fixture, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, generated.includes(relative) ? '# CMAKE generated dependency file; not TypeScript\n' : 'export const checked: string = "yes";\n');
  }
});
afterEach(() => {
  if (fixture && path.dirname(fixture) === path.resolve(os.tmpdir()) && path.basename(fixture).startsWith('pocket-native-config-')) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

it('TypeScript excludes CMake outputs while retaining owned module sources and Expo exclusions', () => {
  const { config, error } = ts.readConfigFile(path.join(appRoot, 'tsconfig.json'), ts.sys.readFile);
  expect(error).toBeUndefined();
  // Only relocate the real inherited Expo config; use the app include/exclude unchanged.
  config.extends = require.resolve('expo/tsconfig.base.json');
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, fixture);
  expect(parsed.errors).toEqual([]);
  const selected = parsed.fileNames.map(file => path.relative(fixture, file).replace(/\\/g, '/'));
  for (const source of ownedSources) expect(selected).toContain(source);
  for (const output of [...generated, 'node_modules/fixture/index.ts', 'android/generated.ts', 'ios/generated.ts']) expect(selected).not.toContain(output);
});

it('ESLint ignores native build outputs while retaining owned module TypeScript sources', async () => {
  const eslint = new ESLint({ cwd: fixture, overrideConfigFile: true, overrideConfig: require('../../eslint.config') });
  for (const output of generated) expect(await eslint.isPathIgnored(path.join(fixture, output))).toBe(true);
  for (const source of ownedSources) expect(await eslint.isPathIgnored(path.join(fixture, source))).toBe(false);
});