import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import fixture from '../../docs/validation/llama-rn-stage7/neu-canonical-frontend-diagnostic.json';
import { ANDROID_QA_NEU_FRONTEND_SHA256, resolveAndroidQaNeuFrontend } from '../../src/services/AndroidQaNeuFrontend';

jest.mock('../../src/services/AndroidQaDocumentModelBootstrap', () => ({ isAndroidQaDocumentModelBootstrapEnabled: () => true }));
jest.mock('../../src/services/FileSystemSetup', () => ({ getAppCacheRootDir: () => 'file:///data/user/0/app.qa/cache/' }));
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
it('binds the diagnostic identity to exact fixture/license bytes and installed builtin Jo codes', () => {
  const root = resolve(__dirname, '../../docs/validation/llama-rn-stage7');
  const fixtureBytes = readFileSync(resolve(root, 'neu-canonical-frontend-diagnostic.json'));
  const licenseBytes = readFileSync(resolve(root, fixture.sourceLicense.file));
  expect(fixtureBytes.includes(13)).toBe(false);
  expect(licenseBytes.includes(13)).toBe(false);
  expect(sha(fixtureBytes)).toBe(ANDROID_QA_NEU_FRONTEND_SHA256);
  expect(sha(licenseBytes)).toBe(fixture.sourceLicense.sha256);
  expect(fixture.sourceLicense.modificationNotice).toContain('mechanically converted');
  const source = readFileSync(resolve(__dirname, '../../node_modules/llama.rn/src/tts-voices.ts'), 'utf8');
  const match = source.match(/const NEUTTS_JO: NeuTTSSpeaker = \{\s*ref_phones: '([^']+)',\s*ref_codes: \[([^\]]+)\]/)!;
  expect(match[1]).toBe(fixture.builtinReferencePhones);
  const codes: number[] = JSON.parse(`[${match[2]}]`);
  const bytes = Buffer.alloc(codes.length * 4); codes.forEach((value, i) => bytes.writeInt32LE(value, i * 4));
  expect(codes).toHaveLength(fixture.referenceCodesCount);
  expect(sha(bytes)).toBe(fixture.referenceCodesStorageSha256);
});
it('does not return any fixture for ordinary synthesis and freezes the closed diagnostic value', () => {
  expect(resolveAndroidQaNeuFrontend(undefined, 'any', 'any', 'any')).toBeUndefined();
  const value = resolveAndroidQaNeuFrontend(fixture.id, fixture.profileId, fixture.targetText, 'en', { kind: 'builtin', voice: 'jo' });
  expect(Object.isFrozen(value)).toBe(true);
  expect(value?.canonicalTargetPhones).not.toBe(fixture.productionTargetPhones);
});

it('pins exact diagnostic fixture and license checkout bytes to LF', () => {
  const attributes = readFileSync(resolve(__dirname, '../../.gitattributes'), 'utf8').split(/\r?\n/);
  for (const file of ['neu-canonical-frontend-diagnostic.json', fixture.sourceLicense.file]) {
    expect(attributes).toContain(`docs/validation/llama-rn-stage7/${file} text eol=lf`);
  }
});

it('keeps the closed allowlist independent of a mutable JSON import', () => {
  const original = { id: fixture.id, profileId: fixture.profileId, targetText: fixture.targetText };
  try {
    Object.assign(fixture, { id: 'mutated-selector', profileId: 'mutated-profile', targetText: 'mutated-target' });
    expect(() => resolveAndroidQaNeuFrontend(fixture.id, fixture.profileId, fixture.targetText, 'en', { kind: 'builtin', voice: 'jo' })).toThrow();
    expect(resolveAndroidQaNeuFrontend(original.id, original.profileId, original.targetText, 'en', { kind: 'builtin', voice: 'jo' })?.id).toBe(original.id);
  } finally { Object.assign(fixture, original); }
});
