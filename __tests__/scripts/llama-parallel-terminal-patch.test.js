const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { SOURCE_PATCHES, BUILD_FILES, VERSION, hashSource, patchLlamaBridge } = require('../../patches/llama-rn-0.13.0-rc.3');
const { copyLlamaPatchSources } = require('../fixtures/llama-native-patch');

const installed = path.resolve(__dirname, '../../node_modules/llama.rn');
const read = file => fs.readFileSync(path.join(installed, file), 'utf8').replace(/\r\n/gu, '\n');
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function runtime(source) {
  const exports = {};
  const global = {};
  const calls = [];
  const text = read(source);
  const keys = read('lib/commonjs/index.js').match(/const jsiBindingKeys = (\[[^;]+\]);/u)[1];
  for (const key of vm.runInNewContext(keys)) global[key] = () => undefined;
  for (const kind of ['Embedding', 'Rerank', 'Completion']) {
    global[`llamaQueue${kind}`] = (...args) => {
      const admission = deferred();
      calls.push({ kind, admission, callback: args[args.length - 1], token: kind === 'Completion' ? args[2] : null });
      return admission.promise;
    };
  }
  const code = source === 'lib/commonjs/index.js' ? text : ts.transpileModule(text, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(code, {
    exports, global, Promise, console,
    require: name => name === 'react-native' ? { Platform: { OS: 'android' } } : {},
  }, { filename: source });
  await exports.installJsi();
  return { context: new exports.LlamaContext({ contextId: 17 }), calls };
}

describe.each(['src/index.ts', 'lib/commonjs/index.js', 'lib/module/index.js'])('%s queued terminal behavior', source => {
  it.each(['embedding', 'rerank'])('%s rejects an error received before admission and never adds stop()', async kind => {
    const { context, calls } = await runtime(source);
    const admitted = kind === 'embedding' ? context.parallel.embedding('document') : context.parallel.rerank('query', ['document']);
    calls[0].callback({ error: 'parallel_batch_decode_failed' });
    // A result rejection occurs now, while the outer admission is still pending.
    await new Promise(resolve => setImmediate(resolve));
    calls[0].admission.resolve({ requestId: 4 });
    const handle = await admitted;
    expect(handle.requestId).toBe(4);
    expect(handle.stop).toBeUndefined();
    await expect(handle.promise).rejects.toThrow('parallel_batch_decode_failed');
  });

  it.each(['embedding', 'rerank'])('%s settles cancellation as failure and ignores duplicate terminal delivery', async kind => {
    const { context, calls } = await runtime(source);
    const admitted = kind === 'embedding' ? context.parallel.embedding('document') : context.parallel.rerank('query', ['document']);
    calls[0].admission.resolve({ requestId: 5 });
    const handle = await admitted;
    const rejection = expect(handle.promise).rejects.toThrow('parallel_request_cancelled');
    calls[0].callback({ error: 'parallel_request_cancelled' });
    calls[0].callback(kind === 'embedding' ? [0.6, 0.8] : [{ index: 0, score: 0.7 }]);
    await rejection;
  });

  it('keeps independently admitted results associated when they complete out of order', async () => {
    const { context, calls } = await runtime(source);
    const a = context.parallel.embedding('first');
    const b = context.parallel.embedding('second');
    calls[0].admission.resolve({ requestId: 1 });
    calls[1].admission.resolve({ requestId: 2 });
    const [ha, hb] = await Promise.all([a, b]);
    calls[1].callback([0, 1]);
    calls[0].callback([1, 0]);
    await expect(ha.promise).resolves.toEqual({ embedding: [1, 0] });
    await expect(hb.promise).resolves.toEqual({ embedding: [0, 1] });
  });

  it('preserves raw rerank scores, original indexes and document association', async () => {
    const { context, calls } = await runtime(source);
    const pending = context.parallel.rerank('query', ['first', 'second'], { normalize: 0 });
    calls[0].callback([{ index: 0, score: -2.5 }, { index: 1, score: 4.1 }]);
    calls[0].admission.resolve({ requestId: 8 });
    const handle = await pending;
    await expect(handle.promise).resolves.toEqual([
      { index: 1, score: 4.1, document: 'second' }, { index: 0, score: -2.5, document: 'first' },
    ]);
  });

  it('rejects admission separately from terminal completion', async () => {
    const { context, calls } = await runtime(source);
    const pending = context.parallel.embedding('document');
    const rejection = expect(pending).rejects.toThrow('parallel_disabled');
    calls[0].admission.reject(new Error('parallel_disabled'));
    await rejection;
  });

  it('observes early completion failure before returning its handle', async () => {
    const { context, calls } = await runtime(source);
    const pending = context.parallel.completion({ prompt: 'text' });
    calls[0].callback({ error: 'parallel_slot_initialization_failed' });
    await new Promise(resolve => setImmediate(resolve));
    calls[0].admission.resolve({ requestId: 9 });
    const handle = await pending;
    await expect(handle.promise).rejects.toThrow('parallel_slot_initialization_failed');
  });
});

describe('guarded native parallel terminal patch', () => {
  let root;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-parallel-terminal-'));
    copyLlamaPatchSources(root, { pristine: true });
    const dependencies = { 'llama.rn': VERSION };
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies }));
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: { '': { dependencies }, 'node_modules/llama.rn': { version: VERSION } } }));
    fs.writeFileSync(path.join(root, 'node_modules/llama.rn/package.json'), JSON.stringify({ version: VERSION }));
  });
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  it('applies from pristine, checks every source, and is idempotent', () => {
    expect(patchLlamaBridge(root).status).toBe('applied');
    expect(patchLlamaBridge(root, { check: true }).status).toBe('already-applied');
    for (const patch of SOURCE_PATCHES) expect(hashSource(fs.readFileSync(path.join(root, 'node_modules/llama.rn', patch.source), 'utf8'))).toBe(patch.afterSha256);
  });

  it('rejects unknown slot-manager source before writing any other patch', () => {
    fs.appendFileSync(path.join(root, 'node_modules/llama.rn/cpp/rn-slot-manager.cpp'), '\n// source drift\n');
    const paths = [...SOURCE_PATCHES.map(p => p.source), ...Object.keys(BUILD_FILES)];
    const snapshots = paths.map(file => hashSource(fs.readFileSync(path.join(root, 'node_modules/llama.rn', file), 'utf8')));
    expect(() => patchLlamaBridge(root)).toThrow(/source fingerprint mismatch/u);
    paths.forEach((file, i) => expect(hashSource(fs.readFileSync(path.join(root, 'node_modules/llama.rn', file), 'utf8'))).toBe(snapshots[i]));
  });

  it('preserves typed auxiliary error callbacks, worker-owned cancellation, and shared batch failure', () => {
    const manager = read('cpp/rn-slot-manager.cpp');
    const bridge = read('cpp/jsi/RNLlamaJSI.cpp');
    expect(manager).toContain('request.on_complete = on_error;');
    expect(manager).toContain('slot->on_complete_callback = request.on_complete;');
    expect(manager).toContain('slot->ctx_sampling == nullptr');
    expect(manager).toContain('slot->error_message = "parallel_slot_initialization_failed";');
    expect(manager).toContain('slot.error_message = "parallel_batch_decode_failed";');
    expect(manager).toContain('active_it->second->is_interrupted = true;');
    expect(bridge).toContain('tokens, normalize, resultCallback, requestId, errorCallback');
    expect(bridge).toContain('query, documents, normalize, resultCallback, requestId, errorCallback');
    expect(bridge).toContain('else if (callbacks.onResult)');
    expect(read('src/jsi.ts')).toContain('number[] | { error: string }');
    expect(read('lib/typescript/jsi.d.ts')).toContain('NativeRerankResult[] | { error: string }');
    expect(manager).not.toMatch(/LOG_\w+\([^;]*(?:token_text\.c_str|word\.c_str|embedding\[|normalized\[|e\.what)/su);
  });

  it('keeps DONE slots occupied until native reset, so terminal delivery cannot authorize disable', () => {
    const manager = read('cpp/rn-slot-manager.cpp');
    const status = manager.slice(manager.indexOf('llama_rn_parallel_status llama_rn_slot_manager::get_status()'));
    const pending = manager.slice(manager.indexOf('bool llama_rn_slot_manager::has_pending_work()'));
    const occupied = status.match(/if \(([^\n]+)\) \{\n\s+status.active_slots\+\+/u)[1];
    const hasWork = pending.match(/if \((slot.state[^\n]+)\) \{\n\s+return true/u)[1];
    for (const expression of [occupied, hasWork]) {
      for (const [state, expected] of [[0, false], [1, true], [2, true], [3, true]]) {
        expect(vm.runInNewContext(expression, { slot: { state }, SLOT_STATE_IDLE: 0, SLOT_STATE_DONE: 3 })).toBe(expected);
      }
    }
  });
});
