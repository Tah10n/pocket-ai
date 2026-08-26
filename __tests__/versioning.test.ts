import fs from 'fs';
import path from 'path';

function loadJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
}

describe('versioning', () => {
  it('keeps package.json version aligned with app.json expo.version', () => {
    const packageJsonPath = path.resolve(__dirname, '../package.json');
    const appJsonPath = path.resolve(__dirname, '../app.json');

    const packageJson = loadJson(packageJsonPath);
    const appJson = loadJson(appJsonPath);

    assertPlainObject(packageJson, 'package.json');
    assertPlainObject(appJson, 'app.json');

    expect(packageJson.version).toBeDefined();
    expect(appJson.expo).toBeDefined();

    assertPlainObject(appJson.expo, 'app.json expo');

    expect(packageJson.version).toBe(appJson.expo.version);
  });

  it('uses one remote auto-increment source for Android and iOS store build numbers', () => {
    const easJsonPath = path.resolve(__dirname, '../eas.json');
    const easJson = loadJson(easJsonPath);

    assertPlainObject(easJson, 'eas.json');
    assertPlainObject(easJson.cli, 'eas.json cli');
    assertPlainObject(easJson.build, 'eas.json build');
    assertPlainObject(easJson.build.production, 'eas.json production profile');

    expect(easJson.cli.appVersionSource).toBe('remote');
    expect(easJson.build.production.autoIncrement).toBe(true);
  });

  it('keeps store builds on EAS and labels local artifacts as diagnostic only', () => {
    const packageJson = loadJson(path.resolve(__dirname, '../package.json'));
    assertPlainObject(packageJson, 'package.json');
    assertPlainObject(packageJson.scripts, 'package.json scripts');

    expect(packageJson.scripts['build:android:eas:production']).toContain('--platform android --profile production');
    expect(packageJson.scripts['build:ios:eas:production']).toContain('--platform ios --profile production');
    expect(packageJson.scripts['build:all:eas:production']).toContain('--platform all --profile production');

    const releaseChecklist = fs.readFileSync(path.resolve(__dirname, '../docs/release-checklist.md'), 'utf8');
    const androidGuide = fs.readFileSync(path.resolve(__dirname, '../docs/android-build.md'), 'utf8');
    const iosGuide = fs.readFileSync(path.resolve(__dirname, '../docs/ios-build.md'), 'utf8');
    for (const guide of [releaseChecklist, androidGuide, iosGuide]) {
      expect(guide).toMatch(/not store-upload eligible|must not be uploaded/u);
      expect(guide).toMatch(/version:sync[\s\S]{0,180}(?:does not|doesn't) reserve/u);
    }
  });
});

