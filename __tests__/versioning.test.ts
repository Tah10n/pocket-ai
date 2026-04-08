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
});

