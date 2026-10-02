/** @jest-environment node */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { sanitizeTtsEvidence, validateTtsEvidence, validateTtsWav } = require('../../scripts/lib/tts-evidence');
const fixtures = require('../../docs/validation/llama-rn-stage6/tts-fixtures.json');
const patchSha256 = crypto.createHash('sha256').update(fs.readFileSync(
  path.resolve(__dirname, '../../patches/llama-rn-0.13.0-rc.3.js'), 'utf8').replace(/\r\n/gu, '\n')).digest('hex');
const proofError = 'Incomplete native TTS/decode/playback/lifecycle evidence.';
const wavError = 'Exported clip differs from the bounded mono PCM receipt.';

function clip(flow = 'tokens', suffix = '1') {
  const mapping = fixtures.fixtures.find(item => item.flow === flow).mapping;
  const sampleCount = mapping.samplesPerFrame * 2;
  return { id: `${flow}-${suffix}`, status: 'passed', flow, nativeSynthesis: 'passed', decode: 'passed', playback: 'passed',
    contentVerification: 'not_run', profileRestored: true, chatUnchanged: true, deletionRejected: true,
    sampleRate: mapping.sampleRate, sampleCount, duration: sampleCount / mapping.sampleRate,
    elementCount: (mapping.codesPerFrame ?? mapping.embeddingDim) * 2 };
}
function evidence(flow = 'tokens') {
  return { schemaVersion: 1, status: 'native_passed', phase: 'complete', flow, requiresForceStop: false,
    backend: 'cpu', runtimeVersion: '0.13.0-rc.3', patchSha256, contentVerification: 'not_run',
    steps: [...['1', '2', 'retry'].map(suffix => clip(flow, suffix)),
      { id: 'stop_drain', status: 'passed', flow, interrupted: true, completionDrained: true, profileRestored: true, chatUnchanged: true },
      { id: 'chat_after', status: 'passed', profileRestored: true, chatUnchanged: true },
      { id: 'cleanup', status: 'passed', fileRemoved: true }] };
}
function wav(step = clip()) {
  const bytes = Buffer.alloc(44 + step.sampleCount * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(step.sampleRate, 24); bytes.writeUInt32LE(step.sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36);
  bytes.writeUInt32LE(step.sampleCount * 2, 40);
  return bytes;
}

it('exports only bounded known receipts and never raw text, paths, errors, audio or schema objects', () => {
  const privateText = 'secret_password';
  const source = { ...evidence(), schemaVersion: { prompt: privateText }, phase: privateText, failureCode: privateText,
    prompt: privateText, path: 'file:///private/model.gguf', error: { message: privateText },
    audio: [1, 2, 3], transcript: privateText, contentVerification: 'passed',
    steps: evidence().steps.map(step => ({ ...step, prompt: privateText, samples: [Infinity, NaN],
      nativeError: new Error(privateText), decodePath: 'file:///private/codec.gguf' })) };
  const safe = sanitizeTtsEvidence(source);
  expect(safe).toMatchObject({ schemaVersion: null, phase: 'invalid', contentVerification: 'not_run', requiresForceStop: false });
  expect(safe).not.toHaveProperty('failureCode');
  const exported = JSON.stringify(safe);
  expect(exported).not.toMatch(/secret_password|file:\/\/|prompt|samples|nativeError|transcript/);
  expect(safe.steps).toEqual(evidence().steps);
  expect(source.steps[0]).toHaveProperty('prompt', privateText);
});

it('retains recognized public failure codes while rejecting object ids and nonfinite receipt values', () => {
  const safe = sanitizeTtsEvidence({ ...evidence(), failureCode: 'release_failed', requiresForceStop: true,
    steps: [null, { id: { toString: () => 'tokens-1', prompt: 'private' }, status: 'passed' },
      { ...clip(), sampleCount: Infinity, duration: NaN, elementCount: { prompt: 'private' }, status: 'failed' }] });
  expect(safe.failureCode).toBe('release_failed');
  expect(safe.requiresForceStop).toBe(true);
  expect(safe.steps).toHaveLength(1);
  expect(safe.steps[0]).toMatchObject({ id: 'tokens-1', status: 'invalid' });
  expect(safe.steps[0]).not.toHaveProperty('sampleCount');
  expect(safe.steps[0]).not.toHaveProperty('duration');
  expect(safe.steps[0]).not.toHaveProperty('elementCount');
  expect(JSON.stringify(safe)).not.toContain('private');
});

it.each(['tokens', 'continuous_embd'])('accepts complete native %s receipts while leaving linguistic verification not_run', flow => {
  const safe = sanitizeTtsEvidence(evidence(flow));
  expect(validateTtsEvidence(safe, flow)).toBe(safe);
  expect(safe.contentVerification).toBe('not_run');
  expect(safe.steps.slice(0, 3).every(step => step.contentVerification === 'not_run')).toBe(true);
});

it.each(['stop_drain', 'chat_after', 'cleanup'])('never promotes failed %s lifecycle proof even when all success booleans are present', id => {
  const value = evidence();
  value.steps.find(step => step.id === id).status = 'failed';
  expect(() => validateTtsEvidence(value, 'tokens')).toThrow(proofError);
  expect(() => validateTtsEvidence(sanitizeTtsEvidence(value), 'tokens')).toThrow(proofError);
});

it.each(['tokens-1', 'tokens-2', 'tokens-retry', 'stop_drain', 'chat_after', 'cleanup'])('rejects missing %s native proof', id => {
  const value = evidence(); value.steps = value.steps.filter(step => step.id !== id);
  expect(() => validateTtsEvidence(value, 'tokens')).toThrow(proofError);
});

it.each([null, {}, { steps: null }, { steps: {} }, { steps: [null] }])('fails closed with a controlled error for malformed evidence %j', malformed => {
  const value = malformed === null ? null : { ...evidence(), ...malformed };
  if (malformed && Object.keys(malformed).length === 0) delete value.steps;
  expect(() => validateTtsEvidence(value, 'tokens')).toThrow(proofError);
});

it('rejects duplicate, conflicting and foreign-flow receipts instead of taking the first match', () => {
  const duplicate = evidence(); duplicate.steps.push({ ...duplicate.steps[3], status: 'failed' });
  expect(() => validateTtsEvidence(duplicate, 'tokens')).toThrow(proofError);
  const replaced = evidence(); replaced.steps[2] = { ...replaced.steps[0] };
  expect(() => validateTtsEvidence(replaced, 'tokens')).toThrow(proofError);
  const foreign = evidence(); foreign.steps[0] = clip('continuous_embd');
  expect(() => validateTtsEvidence(foreign, 'tokens')).toThrow(proofError);
});

it.each([
  ['status', 'passed'], ['phase', 'prepare'], ['schemaVersion', 2], ['flow', 'unknown'], ['requiresForceStop', true],
  ['requiresForceStop', undefined], ['backend', 'gpu'], ['runtimeVersion', '0.13.0'],
  ['patchSha256', undefined], ['patchSha256', 'a'.repeat(64)], ['contentVerification', 'passed'],
])('rejects stale or incomplete native identity %s=%j', (field, value) => {
  expect(() => validateTtsEvidence({ ...evidence(), [field]: value }, 'tokens')).toThrow(proofError);
});

it.each(['nativeSynthesis', 'decode', 'playback', 'profileRestored', 'chatUnchanged', 'deletionRejected'])('requires actual %s proof rather than overall native_passed', field => {
  const value = evidence(); delete value.steps[0][field];
  expect(() => validateTtsEvidence(value, 'tokens')).toThrow(proofError);
});

it.each([
  ['sampleRate', 48000], ['sampleCount', 0], ['sampleCount', NaN], ['sampleCount', Infinity],
  ['sampleCount', 1.5], ['sampleCount', 768001], ['duration', Infinity], ['duration', -1],
  ['elementCount', 0], ['elementCount', 1], ['elementCount', 2402], ['elementCount', Infinity],
])('rejects malformed or unbounded native receipt %s=%j', (field, data) => {
  const value = evidence(); value.steps[0][field] = data;
  expect(() => validateTtsEvidence(value, 'tokens')).toThrow(proofError);
});

it.each(['tokens', 'continuous_embd'])('validates bounded mono PCM bytes and returns a checksum for %s', flow => {
  const step = clip(flow); const bytes = wav(step);
  expect(validateTtsWav(bytes, step)).toEqual({ bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'), sampleRate: step.sampleRate, sampleCount: step.sampleCount });
});

it.each([24000, 48000])('accepts exactly sixteen seconds at %s Hz within the sample and byte ceilings', sampleRate => {
  const step = { sampleRate, sampleCount: sampleRate * 16, duration: 16 };
  expect(validateTtsWav(wav(step), step).sampleCount).toBe(step.sampleCount);
});

it.each([
  ['sampleRate', NaN], ['sampleRate', Infinity], ['sampleRate', 0], ['sampleRate', 7999], ['sampleRate', 192001],
  ['sampleRate', 24000.5], ['sampleCount', NaN], ['sampleCount', Infinity], ['sampleCount', 0],
  ['sampleCount', 1.5], ['sampleCount', 768001], ['duration', NaN], ['duration', Infinity],
  ['duration', undefined], ['duration', 16.1], ['duration', 0],
])('rejects nonfinite, out-of-range or mismatched WAV receipt %s=%j', (field, value) => {
  expect(() => validateTtsWav(wav(), { ...clip(), [field]: value })).toThrow(wavError);
});

it('rejects an otherwise valid PCM clip exceeding the duration policy at a lower sample rate', () => {
  const step = { sampleRate: 8000, sampleCount: 128001, duration: 128001 / 8000 };
  expect(() => validateTtsWav(wav(step), step)).toThrow(wavError);
});

it.each([
  ['container', bytes => bytes.write('RIFX', 0)], ['RIFF size', bytes => bytes.writeUInt32LE(44, 4)],
  ['format', bytes => bytes.writeUInt16LE(3, 20)], ['stereo', bytes => bytes.writeUInt16LE(2, 22)],
  ['sample rate', bytes => bytes.writeUInt32LE(48000, 24)], ['byte rate', bytes => bytes.writeUInt32LE(48001, 28)],
  ['block alignment', bytes => bytes.writeUInt16LE(4, 32)], ['sample depth', bytes => bytes.writeUInt16LE(32, 34)],
  ['data size', bytes => bytes.writeUInt32LE(2, 40)],
])('rejects WAV header/receipt mismatch: %s', (_label, mutate) => {
  const bytes = wav(); mutate(bytes);
  expect(() => validateTtsWav(bytes, clip())).toThrow(wavError);
});

it('rejects truncation, extra samples and missing byte/receipt input with a controlled failure', () => {
  const bytes = wav();
  for (const value of [null, new Uint8Array(bytes), bytes.subarray(0, 43), bytes.subarray(0, bytes.length - 2),
    Buffer.concat([bytes, Buffer.from([0, 0])])]) {
    expect(() => validateTtsWav(value, clip())).toThrow(wavError);
  }
  expect(() => validateTtsWav(bytes, null)).toThrow(wavError);
});

it.each([undefined, null, 0, 'false', {}])('never promotes an unknown force-stop flag %j to a safe native proof', requiresForceStop => {
  const safe = sanitizeTtsEvidence({ ...evidence(), requiresForceStop });
  expect(safe.requiresForceStop).toBe(true);
  expect(() => validateTtsEvidence(safe, 'tokens')).toThrow(proofError);
});

it('cannot accept native_passed before the terminal complete phase after sanitization', () => {
  const safe = sanitizeTtsEvidence({ ...evidence(), phase: 'awaiting_clip_copy' });
  expect(() => validateTtsEvidence(safe, 'tokens')).toThrow(proofError);
});