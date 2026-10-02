const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveExternalTtsDirectory, exportLocalTtsClip, assertTtsPrivateFileAccess } = require('../../scripts/lib/tts-local-export');

describe('isolated speech private-file access', () => {
  const packageName = 'com.github.tah10n.pocketai.qa';
  it('requires affirmative access to the exact QA data directory', () => {
    for (const stdout of [`/data/user/0/${packageName}\n`, `/data/data/${packageName}\n`]) {
      const capture = jest.fn(() => ({ status: 0, stdout, stderr: '' }));
      expect(() => assertTtsPrivateFileAccess('adb', 'owned-emulator', packageName, capture)).not.toThrow();
      expect(capture.mock.calls[0][1]).toEqual(['-s', 'owned-emulator', 'exec-out', 'run-as', packageName, 'pwd']);
    }
  });
  it.each([
    { status: 0, stdout: `run-as: package not debuggable: ${packageName}\n`, stderr: '' },
    { status: 0, stdout: '/data/user/0/com.github.tah10n.pocketai\n', stderr: '' },
    { status: 0, stdout: '', stderr: '' },
    { status: 1, stdout: `/data/user/0/${packageName}`, stderr: '' },
    { status: 0, stdout: `/data/user/0/${packageName}`, stderr: 'permission denied' },
    { error: new Error('timeout'), status: null, stdout: '', stderr: '' },
  ])('rejects unavailable access before accepting speech or cleanup proof: %#', result => {
    expect(() => assertTtsPrivateFileAccess('adb', 'owned-emulator', packageName, () => result)).toThrow(/no verified/);
  });
  it('never probes the production package', () => {
    const capture = jest.fn();
    expect(() => assertTtsPrivateFileAccess('adb', 'owned-emulator', 'com.github.tah10n.pocketai', capture)).toThrow(/isolated/);
    expect(capture).not.toHaveBeenCalled();
  });
});

describe('local speech export ownership', () => {
  let temporary;
  let publicRoot;
  const step = { sampleRate: 24000, sampleCount: 2, duration: 2 / 24000 };
  const wav = () => {
    const bytes = Buffer.alloc(48);
    bytes.write('RIFF', 0); bytes.writeUInt32LE(40, 4); bytes.write('WAVEfmt ', 8);
    bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28);
    bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
    bytes.write('data', 36); bytes.writeUInt32LE(4, 40); bytes.writeInt16LE(100, 44);
    return bytes;
  };
  beforeEach(() => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-tts-export-test-'));
    publicRoot = path.join(temporary, 'public'); fs.mkdirSync(publicRoot);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    const actual = fs.realpathSync(temporary);
    if (actual !== fs.realpathSync(os.tmpdir()) && path.dirname(actual) === fs.realpathSync(os.tmpdir())) {
      fs.rmSync(actual, { recursive: true });
    }
    expect(fs.existsSync(temporary)).toBe(false);
  });
  it('rejects public artifacts and a public ancestor before creating paths', () => {
    const nested = path.join(publicRoot, 'artifacts', 'speech');
    expect(() => resolveExternalTtsDirectory(nested, publicRoot)).toThrow(/outside/);
    expect(fs.existsSync(nested)).toBe(false);
    expect(() => resolveExternalTtsDirectory(temporary, publicRoot)).toThrow(/outside/);
  });
  it('resolves junctions before enforcing the public boundary', () => {
    const link = path.join(temporary, 'link');
    fs.symlinkSync(publicRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => resolveExternalTtsDirectory(path.join(link, 'speech'), publicRoot)).toThrow(/outside/);
    expect(fs.existsSync(path.join(publicRoot, 'speech'))).toBe(false);
  });
  it('exports one validated clip to an explicit outside directory', () => {
    const directory = resolveExternalTtsDirectory(path.join(temporary, 'audio'), publicRoot);
    const result = exportLocalTtsClip(directory, 'tokens-1', wav(), step);
    expect(result).toMatchObject({ filename: 'tokens-1.wav', bytes: 48, contentVerification: 'not_run' });
    expect(fs.readFileSync(path.join(directory, result.filename))).toEqual(wav());
  });
  it('preserves an existing file when exclusive creation fails', () => {
    const directory = resolveExternalTtsDirectory(path.join(temporary, 'audio'), publicRoot);
    const target = path.join(directory, 'tokens-1.wav'); fs.writeFileSync(target, 'user file');
    expect(() => exportLocalTtsClip(directory, 'tokens-1', wav(), step)).toThrow();
    expect(fs.readFileSync(target, 'utf8')).toBe('user file');
  });
  it('removes its partial file when the binary write fails', () => {
    const directory = resolveExternalTtsDirectory(path.join(temporary, 'audio'), publicRoot);
    const original = fs.writeFileSync;
    jest.spyOn(fs, 'writeFileSync').mockImplementation((target, bytes, options) => {
      if (typeof target === 'number') { original(target, bytes.subarray(0, 8)); throw new Error('disk full'); }
      return original(target, bytes, options);
    });
    expect(() => exportLocalTtsClip(directory, 'tokens-1', wav(), step)).toThrow('disk full');
    expect(fs.readdirSync(directory)).toEqual([]);
  });
  it('rejects identity traversal and mismatched native receipts before writing', () => {
    const directory = resolveExternalTtsDirectory(path.join(temporary, 'audio'), publicRoot);
    expect(() => exportLocalTtsClip(directory, '../tokens-1', wav(), step)).toThrow(/identity/);
    expect(() => exportLocalTtsClip(directory, 'tokens-1', wav(), { ...step, sampleRate: 48000 })).toThrow(/receipt/);
    expect(fs.readdirSync(directory)).toEqual([]);
  });
  it('still removes its exact new file if close reports an error', () => {
    const directory = resolveExternalTtsDirectory(path.join(temporary, 'audio'), publicRoot);
    const close = fs.closeSync;
    const closed = new Set();
    jest.spyOn(fs, 'closeSync').mockImplementation(descriptor => {
      if (!closed.has(descriptor)) { close(descriptor); closed.add(descriptor); }
      throw new Error('close failed');
    });
    expect(() => exportLocalTtsClip(directory, 'tokens-1', wav(), step)).toThrow('close failed');
    expect(fs.readdirSync(directory)).toEqual([]);
  });
});
