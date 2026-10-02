/** @jest-environment node */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { applyExpoAudioTtsPatch, patches, VERSION } = require('../../patches/expo-audio-55.0.18');

const installed = path.resolve(__dirname, '../../node_modules/expo-audio');
const normalized = text => text.replace(/\r\n/g, '\n');
const hash = text => crypto.createHash('sha256').update(normalized(text)).digest('hex');
let fixtureRoot;
beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-audio-patch-test-'));
  fs.writeFileSync(path.join(fixtureRoot, 'package.json'), JSON.stringify({ version: VERSION }));
  for (const patch of patches) {
    const target = path.join(fixtureRoot, patch.file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(installed, patch.file), target);
  }
});
afterEach(() => {
  // Remove only the exact test-owned directory returned by mkdtempSync.
  const resolved = path.resolve(fixtureRoot);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('pocket-audio-patch-test-')) {
    throw new Error('Unsafe fixture cleanup target');
  }
  fs.rmSync(resolved, { recursive: true, force: true });
  expect(fs.existsSync(resolved)).toBe(false);
});
const contents = () => patches.map(patch => fs.readFileSync(path.join(fixtureRoot, patch.file), 'utf8'));

it('verifies every installed native/type byte and is idempotent with CRLF input', () => {
  for (const patch of patches) {
    const target = path.join(fixtureRoot, patch.file);
    const text = normalized(fs.readFileSync(target, 'utf8'));
    expect(hash(text)).toBe(patch.after);
    fs.writeFileSync(target, text.replace(/\n/g, '\r\n'));
  }
  const before = contents();
  expect(applyExpoAudioTtsPatch(fixtureRoot)).toEqual([]);
  expect(contents()).toEqual(before);
});

it('rejects a changed package version without writing any source', () => {
  fs.writeFileSync(path.join(fixtureRoot, 'package.json'), JSON.stringify({ version: '55.0.19' }));
  const before = contents();
  expect(() => applyExpoAudioTtsPatch(fixtureRoot)).toThrow('refusing changed version');
  expect(contents()).toEqual(before);
});

it('rejects drift in the final native file before making any writes', () => {
  const target = path.join(fixtureRoot, patches.at(-1).file);
  fs.appendFileSync(target, '\n// unexpected upstream change\n');
  const before = contents();
  expect(() => applyExpoAudioTtsPatch(fixtureRoot)).toThrow('source hash mismatch');
  expect(contents()).toEqual(before);
});

it('keeps native opt-in guards and synchronous teardown visible in the public contract', () => {
  const read = file => fs.readFileSync(path.join(fixtureRoot, file), 'utf8');
  const android = read('android/src/main/java/expo/modules/audio/AudioModule.kt');
  const androidPlayer = read('android/src/main/java/expo/modules/audio/AudioPlayer.kt');
  const ios = read('ios/AudioModule.swift');
  const iosPlayer = read('ios/AudioPlayer.swift');
  expect(androidPlayer).toContain('var preventAutomaticResume = false');
  expect(iosPlayer).toContain('var preventAutomaticResume = false');
  expect(android).toMatch(/AsyncFunction\("disposeAsync"\)[\s\S]*?player\.dispose\(\)[\s\S]*?players\.remove\(player\.id\)[\s\S]*?runOnQueue\(Queues\.MAIN\)/);
  expect(ios).toMatch(/AsyncFunction\("disposeAsync"\)[\s\S]*?player\.dispose\(\)[\s\S]*?runOnQueue\(\.main\)/);
  expect(android).toContain('player.ref.setHandleAudioBecomingNoisy(value)');
  expect(android).toContain('playable.preventAutomaticResume || playable.disposalStarted');
  expect(iosPlayer).toContain('if preventAutomaticResume {\n      wasPlaying = false\n      ref.pause()');
  expect(ios).toContain('!player.preventAutomaticResume && !player.disposalStarted && interruptedPlayers.contains(player.id)');
  expect(ios).toContain('if player.preventAutomaticResume { player.updateStatus(with: ["playing": false]) }');
  expect(iosPlayer).toContain('owningRegistry?.removeSynchronously(self)');
  expect(iosPlayer).toContain('ref.replaceCurrentItem(with: nil)');
  for (const file of ['src/AudioModule.types.ts', 'build/AudioModule.types.d.ts']) {
    expect(read(file)).toContain('preventAutomaticResume: boolean;');
    expect(read(file)).toContain('disposeAsync(): Promise<void>;');
  }
});
