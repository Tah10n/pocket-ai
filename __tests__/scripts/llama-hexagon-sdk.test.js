const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { Readable } = require('stream');
const { manifest, requiresHexagonSdk, setupLlamaHexagonSdk, verifyLlamaHexagonSdk, _internal } = require('../../scripts/llama-hexagon-sdk');

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pythonEnvironment = { ...process.env, PYTHON: process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3') };
let root;
const childPids = [];
const options = () => ({ abi: 'arm64-v8a', env: pythonEnvironment, onProcess: pid => childPids.push(pid) });

function createPin() {
  const contents = {
    'incs/sample.h': 'pinned header\n',
    'ipc/fastrpc/rpcmem/inc/rpcmem.h': 'pinned rpcmem\n',
    'ipc/fastrpc/remote/ship/android_aarch64/libcdsprpc.so': 'pinned link stub\n',
    'tools/HEXAGON_Tools/19.0.04/NOTICE.txt': 'proprietary notice\n',
    'tools/HEXAGON_Tools/19.0.04/RELEASE_NOTES.txt': 'authentic release notes\n',
  };
  const files = Object.entries(contents).map(([name, text]) => ({ path: `6.4.0.2/${name}`, size: Buffer.byteLength(text), sha256: sha(text) }));
  return { version: '6.4.0.2', toolsVersion: '19.0.04', sourceUrl: 'https://example.invalid/pinned-sdk.tar.xz', files, requiredFilesDigest: _internal.requiredFilesDigest(files), contents };
}

function writeSubset(destination, pin) {
  for (const [name, contents] of Object.entries(pin.contents)) {
    const file = path.join(destination, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
}

async function createArchive(pin, extraEntries = []) {
  const archive = path.join(root, 'caller-owned.tar.xz');
  const entries = Object.entries(pin.contents).map(([name, contents]) => ({ name: `${pin.version}/${name}`, contents }))
    .filter(entry => !extraEntries.some(extra => extra.link && extra.name === entry.name));
  fs.writeFileSync(path.join(root, 'archive-input.json'), JSON.stringify([...entries, ...extraEntries]));
  await _internal.runPython(['-c', `import io,json,sys,tarfile
with open(sys.argv[1], encoding='utf-8') as f: entries=json.load(f)
with tarfile.open(sys.argv[2], 'w:xz') as archive:
 for entry in entries:
  member=tarfile.TarInfo(entry['name'])
  data=entry.get('contents','').encode()
  member.size=len(data)
  if entry.get('link'):
   member.type=tarfile.SYMTYPE
   member.linkname=entry['link']
   member.size=0
  archive.addfile(member, io.BytesIO(data))
`, path.join(root, 'archive-input.json'), archive], options());
  const bytes = fs.readFileSync(archive);
  pin.archiveBytes = bytes.length;
  pin.archiveSha256 = sha(bytes);
  return archive;
}

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-hexagon-unit-')); });
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  expect(fs.existsSync(root)).toBe(false);
  for (const pid of childPids.splice(0)) {
    expect(() => process.kill(pid, 0)).toThrow();
  }
});

describe('pinned Hexagon host SDK', () => {
  it('pins the verified archive and all 60 files, including authentic tool notices', () => {
    expect(manifest.archiveBytes).toBe(706737852);
    expect(manifest.archiveSha256).toBe('b4a57a774795cf12da19a777a5d306e970905bf9758a4c4765e5e4593428ae0b');
    expect(manifest.files).toHaveLength(60);
    expect(manifest.files.reduce((sum, file) => sum + file.size, 0)).toBe(678879);
    expect(_internal.requiredFilesDigest(manifest.files)).toBe(manifest.requiredFilesDigest);
    expect(manifest.files.map(file => file.path)).toEqual(expect.arrayContaining([
      '6.4.0.2/tools/HEXAGON_Tools/19.0.04/NOTICE.txt', '6.4.0.2/tools/HEXAGON_Tools/19.0.04/RELEASE_NOTES.txt',
    ]));
  });

  it('does not inspect, create or download SDK inputs for x86_64', async () => {
    const download = jest.fn(() => { throw new Error('unexpected download'); });
    const config = { abi: 'x86_64', env: { HEXAGON_TOOLS_ROOT: 'invalid' }, sdkRoot: 'missing', openDownload: download };
    await expect(setupLlamaHexagonSdk(root, config)).resolves.toEqual({ status: 'not_required', env: {}, identity: null });
    expect(verifyLlamaHexagonSdk(root, config)).toEqual({ status: 'not_required', env: {}, identity: null });
    expect(download).not.toHaveBeenCalled();
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it.each(['arm64-v8a', 'universal'])('requires a verified SDK for %s', abi => {
    expect(requiresHexagonSdk(abi)).toBe(true);
    expect(() => verifyLlamaHexagonSdk(root, { abi, env: {} })).toThrow();
  });

  it('rejects unsupported ABI and tools-only overrides before setup', async () => {
    expect(() => requiresHexagonSdk('arm')).toThrow();
    await expect(setupLlamaHexagonSdk(root, { abi: 'universal', env: { HEXAGON_TOOLS_ROOT: root } })).rejects.toThrow(/requires a verified SDK root/);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('reuses a fully verified external subset and exposes only safe identity metadata', async () => {
    const pin = createPin();
    pin.archiveSha256 = 'a'.repeat(64);
    writeSubset(root, pin);
    const download = jest.fn();
    const result = await _internal.setupSdk(root, { ...options(), sdkRoot: root, openDownload: download }, pin);
    expect(result.env.HEXAGON_TOOLS_ROOT).toBe(path.join(root, 'tools', 'HEXAGON_Tools', '19.0.04'));
    expect(result.identity).toEqual({ version: pin.version, archiveSha256: pin.archiveSha256, requiredFilesDigest: pin.requiredFilesDigest });
    expect(JSON.stringify(result.identity)).not.toContain(root);
    expect(download).not.toHaveBeenCalled();
    expect(() => _internal.verifySdk(root, { ...options(), sdkRoot: root, env: { HEXAGON_TOOLS_ROOT: path.dirname(root) } }, pin)).toThrow(/does not match/);
  });

  it.each(['incs/sample.h', 'ipc/fastrpc/remote/ship/android_aarch64/libcdsprpc.so', 'tools/HEXAGON_Tools/19.0.04/NOTICE.txt'])('rejects missing or changed required file %s', file => {
    const pin = createPin();
    writeSubset(root, pin);
    const absolute = path.join(root, file);
    fs.writeFileSync(absolute, 'tampered');
    expect(() => _internal.verifySubset(root, pin)).toThrow(/differs/);
    fs.unlinkSync(absolute);
    expect(() => _internal.verifySubset(root, pin)).toThrow();
  });

  it.each(['incs/unpinned.h', 'ipc/fastrpc/rpcmem/inc/unpinned.h', 'utils/examples/unpinned.h'])('rejects unexpected include file %s', file => {
    const pin = createPin();
    writeSubset(root, pin);
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'extra');
    expect(() => _internal.verifySubset(root, pin)).toThrow(/Unexpected file/);
  });

  it('rejects filesystem junctions in include paths', () => {
    const pin = createPin();
    writeSubset(root, pin);
    const moved = path.join(root, 'moved-incs');
    fs.renameSync(path.join(root, 'incs'), moved);
    fs.symlinkSync(moved, path.join(root, 'incs'), 'junction');
    expect(() => _internal.verifySubset(root, pin)).toThrow(/links/);
  });

  it('installs only whitelisted bytes from a pinned caller archive, reuses them, and preserves the archive', async () => {
    const pin = createPin();
    const archivePath = await createArchive(pin, [{ name: '6.4.0.2/unselected-large-file', contents: 'must not extract' }]);
    const download = jest.fn();
    const setupOptions = { ...options(), archivePath, openDownload: download };
    const result = await _internal.setupSdk(root, setupOptions, pin);
    expect(result.status).toBe('verified');
    expect(fs.existsSync(path.join(result.env.HEXAGON_SDK_ROOT, 'unselected-large-file'))).toBe(false);
    expect(fs.existsSync(archivePath)).toBe(true);
    expect(fs.readdirSync(path.dirname(result.env.HEXAGON_SDK_ROOT))).toEqual(['6.4.0.2']);
    await expect(_internal.setupSdk(root, setupOptions, pin)).resolves.toEqual(result);
    expect(download).not.toHaveBeenCalled();
  });

  it('downloads at most once and removes its archive and staging after success', async () => {
    const pin = createPin();
    const archive = await createArchive(pin);
    const bytes = fs.readFileSync(archive);
    const download = jest.fn(async () => Readable.from([bytes]));
    const config = { ...options(), openDownload: download };
    const first = await _internal.setupSdk(root, config, pin);
    await _internal.setupSdk(root, config, pin);
    expect(download).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(path.dirname(first.env.HEXAGON_SDK_ROOT))).toEqual(['6.4.0.2']);
  });

  it.each(['oversize', 'truncated', 'hash'])('rejects a %s download and removes partial bytes', async mode => {
    const bytes = Buffer.from('archive');
    const pin = { archiveBytes: bytes.length, archiveSha256: sha(bytes), sourceUrl: 'https://example.invalid/archive' };
    const received = mode === 'oversize' ? Buffer.concat([bytes, bytes]) : mode === 'truncated' ? bytes.subarray(1) : Buffer.from('xxxxxxx');
    const destination = path.join(root, 'download');
    await expect(_internal.downloadArchive(destination, pin, { openDownload: async () => Readable.from([received]) })).rejects.toThrow(/size|SHA/);
    expect(fs.existsSync(destination)).toBe(false);
  });

  it.each([
    ['traversal', { name: '../escaped', contents: 'bad' }],
    ['absolute', { name: '/escaped', contents: 'bad' }],
    ['duplicate', { name: '6.4.0.2/incs/sample.h', contents: 'pinned header\n' }],
    ['link', { name: '6.4.0.2/incs/sample.h', link: '../outside' }],
  ])('rejects %s archive entries and cleans staging', async (_name, member) => {
    const pin = createPin();
    const archivePath = await createArchive(pin, [member]);
    await expect(_internal.setupSdk(root, { ...options(), archivePath }, pin)).rejects.toThrow(/extraction/);
    const cache = path.join(root, 'node_modules', '.cache', 'pocket-ai-android', 'hexagon-sdk');
    expect(fs.readdirSync(cache)).toEqual([]);
    expect(fs.existsSync(archivePath)).toBe(true);
  });

  it('rejects an archive missing a required header even when the archive hash is valid', async () => {
    const pin = createPin();
    delete pin.contents['incs/sample.h'];
    const archivePath = await createArchive(pin);
    await expect(_internal.setupSdk(root, { ...options(), archivePath }, pin)).rejects.toThrow(/extraction/);
    expect(fs.readdirSync(path.join(root, 'node_modules', '.cache', 'pocket-ai-android', 'hexagon-sdk'))).toEqual([]);
    expect(fs.existsSync(archivePath)).toBe(true);
  });

  it('cleans owned setup state when a download is aborted', async () => {
    const pin = createPin();
    const archive = await createArchive(pin);
    const controller = new AbortController();
    const config = { ...options(), signal: controller.signal, openDownload: async () => {
      controller.abort();
      return Readable.from([fs.readFileSync(archive)]);
    } };
    await expect(_internal.setupSdk(root, config, pin)).rejects.toThrow();
    expect(fs.readdirSync(path.join(root, 'node_modules', '.cache', 'pocket-ai-android', 'hexagon-sdk'))).toEqual([]);
  });

  it('fails closed on drifted cache without downloading or overwriting it', async () => {
    const pin = createPin();
    const cached = path.join(root, 'node_modules', '.cache', 'pocket-ai-android', 'hexagon-sdk', pin.version);
    writeSubset(cached, pin);
    fs.writeFileSync(path.join(cached, 'incs', 'sample.h'), 'private changes');
    const download = jest.fn();
    await expect(_internal.setupSdk(root, { ...options(), openDownload: download }, pin)).rejects.toThrow(/differs/);
    expect(download).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(cached, 'incs', 'sample.h'), 'utf8')).toBe('private changes');
  });

  it('cleans setup after archive hash rejection and preserves the caller archive', async () => {
    const pin = createPin();
    const archivePath = await createArchive(pin);
    pin.archiveSha256 = '0'.repeat(64);
    await expect(_internal.setupSdk(root, { ...options(), archivePath }, pin)).rejects.toThrow(/SHA/);
    expect(fs.readdirSync(path.join(root, 'node_modules', '.cache', 'pocket-ai-android', 'hexagon-sdk'))).toEqual([]);
    expect(fs.existsSync(archivePath)).toBe(true);
  });

  it('drains the Python child after timeout and abort', async () => {
    await expect(_internal.runPython(['-c', 'import time; time.sleep(60)'], { ...options(), timeoutMs: 20 })).rejects.toThrow(/cancelled/);
    const controller = new AbortController();
    controller.abort();
    await expect(_internal.runPython(['-c', 'import time; time.sleep(60)'], { ...options(), signal: controller.signal })).rejects.toThrow(/cancelled/);
  });

  it.each(['SIGINT', 'SIGTERM'])('direct public setup owns %s cancellation and drains its real extractor', async signal => {
    const pin = createPin();
    const archivePath = await createArchive(pin);
    let publicSdk;
    jest.isolateModules(() => {
      jest.doMock('../../scripts/llama-hexagon-sdk-manifest.json', () => pin);
      publicSdk = require('../../scripts/llama-hexagon-sdk');
    });
    const previousSigint = process.listeners('SIGINT');
    const previousSigterm = process.listeners('SIGTERM');
    let extractorPid;
    try {
      await expect(publicSdk.setupLlamaHexagonSdk(root, {
        ...options(), archivePath,
        env: { ...pythonEnvironment, HEXAGON_SDK_ROOT: '', HEXAGON_TOOLS_ROOT: '' },
        onProcess: pid => {
          extractorPid = pid;
          childPids.push(pid);
          process.emit(signal);
        },
      })).rejects.toThrow(/cancelled/);
      expect(extractorPid).toEqual(expect.any(Number));
      expect(() => process.kill(extractorPid, 0)).toThrow();
      expect(fs.readdirSync(path.join(root, 'node_modules', '.cache', 'pocket-ai-android', 'hexagon-sdk'))).toEqual([]);
      expect(fs.existsSync(archivePath)).toBe(true);
      expect(process.listeners('SIGINT')).toEqual(previousSigint);
      expect(process.listeners('SIGTERM')).toEqual(previousSigterm);
    } finally {
      jest.dontMock('../../scripts/llama-hexagon-sdk-manifest.json');
    }
  });

  it('direct public setup preserves caller signal ownership without adding process handlers', async () => {
    const pin = createPin();
    const archivePath = await createArchive(pin);
    let publicSdk;
    jest.isolateModules(() => {
      jest.doMock('../../scripts/llama-hexagon-sdk-manifest.json', () => pin);
      publicSdk = require('../../scripts/llama-hexagon-sdk');
    });
    const previousSigint = process.listeners('SIGINT');
    const previousSigterm = process.listeners('SIGTERM');
    const controller = new AbortController();
    let observedListeners;
    try {
      await expect(publicSdk.setupLlamaHexagonSdk(root, {
        ...options(), archivePath, signal: controller.signal,
        env: { ...pythonEnvironment, HEXAGON_SDK_ROOT: '', HEXAGON_TOOLS_ROOT: '' },
        onProcess: pid => {
          childPids.push(pid);
          observedListeners = [process.listeners('SIGINT'), process.listeners('SIGTERM')];
          controller.abort();
        },
      })).rejects.toThrow(/cancelled/);
      expect(observedListeners).toEqual([previousSigint, previousSigterm]);
      expect(fs.readdirSync(path.join(root, 'node_modules', '.cache', 'pocket-ai-android', 'hexagon-sdk'))).toEqual([]);
      expect(process.listeners('SIGINT')).toEqual(previousSigint);
      expect(process.listeners('SIGTERM')).toEqual(previousSigterm);
    } finally {
      jest.dontMock('../../scripts/llama-hexagon-sdk-manifest.json');
    }
  });

  it.each(['SIGINT', 'SIGTERM'])('CLI %s waits for the extractor close and owned cleanup', async signal => {
    const processRef = new (require('events').EventEmitter)();
    processRef.stdout = { write: jest.fn() };
    processRef.stderr = { write: jest.fn() };
    const owned = path.join(root, '.setup-owned');
    let cleanupFinished = false;
    const setup = async (_projectRoot, config) => {
      fs.mkdirSync(owned);
      try {
        await _internal.runPython(['-c', 'import time; time.sleep(60)'], {
          ...config, env: pythonEnvironment,
          onProcess: pid => {
            childPids.push(pid);
            config.onProcess(pid);
            processRef.emit(signal);
          },
        });
      } finally {
        fs.rmSync(owned, { recursive: true, force: true });
        cleanupFinished = true;
      }
    };
    await expect(_internal.main(['setup', '--abi', 'universal'], { processRef, setup })).rejects.toThrow(/cancelled/);
    expect(cleanupFinished).toBe(true);
    expect(fs.existsSync(owned)).toBe(false);
    expect(processRef.stdout.write).not.toHaveBeenCalled();
    expect(processRef.stderr.write).toHaveBeenCalledWith(expect.stringMatching(/extractor PID \d+/));
    expect(processRef.listenerCount('SIGINT')).toBe(0);
    expect(processRef.listenerCount('SIGTERM')).toBe(0);
  });

  it('offers CPU CLI JSON and sanitizes failing CLI diagnostics', () => {
    const script = path.resolve(__dirname, '../../scripts/llama-hexagon-sdk.js');
    const success = spawnSync(process.execPath, [script, 'verify', '--abi', 'x86_64'], { encoding: 'utf8' });
    childPids.push(success.pid);
    expect(success.status).toBe(0);
    expect(JSON.parse(success.stdout).status).toBe('not_required');
    const failure = spawnSync(process.execPath, [script, 'verify', '--abi', 'universal'], {
      encoding: 'utf8', env: { ...process.env, HEXAGON_SDK_ROOT: path.join(root, 'PRIVATE_MISSING'), HEXAGON_TOOLS_ROOT: '' },
    });
    childPids.push(failure.pid);
    expect(failure.status).toBe(1);
    expect(failure.stderr.trim()).toBe(_internal.SAFE_ERROR);
    expect(failure.stderr).not.toContain(root);
    expect(failure.stdout).toBe('');
  });
});
