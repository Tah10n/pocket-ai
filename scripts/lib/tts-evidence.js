const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const fixtures = require('../../docs/validation/llama-rn-stage6/tts-fixtures.json');
const patchSha256 = crypto.createHash('sha256').update(fs.readFileSync(
  path.resolve(__dirname, '../../patches/llama-rn-0.13.0-rc.3.js'), 'utf8').replace(/\r\n/gu, '\n')).digest('hex');
const FLOWS = ['tokens', 'continuous_embd'];
const PHASES = ['idle', 'prepare', 'awaiting_clip_copy', 'awaiting_public_controls', 'stop_drain', 'chat_after', 'cleanup', 'complete',
  ...FLOWS.flatMap(flow => ['1', '2', 'retry'].map(suffix => `${flow}-${suffix}`))];
const FAILURE_CODES = ['selection_missing', 'selection_changed', 'files_missing', 'integrity_failed', 'profile_unverified',
  'codec_incompatible', 'prerequisite_missing', 'voice_unavailable', 'language_unsupported', 'memory_unknown', 'memory_insufficient',
  'busy', 'cancelled', 'input_too_large', 'generation_incomplete', 'payload_invalid', 'decode_failed', 'native_failed',
  'release_failed', 'restore_failed', 'storage_failed', 'playback_failed', 'fixture_identity_conflict', 'download_timeout',
  'download_failed', 'codec_binding', 'codec_download_timeout', 'codec_download_failed', 'clip_copy_timeout',
  'chat_selection_changed', 'stage3_adapter_missing', 'profile_restore', 'history_changed', 'codec_missing',
  'decode_receipt', 'codec_delete_guard', 'playback_position', 'playback_pause', 'playback_replay', 'stop_drain',
  'chat_after', 'cache_unavailable', 'clip_cleanup', 'cleanup_failed', 'qa_assertion', 'synthesis_count',
  'public_controls_timeout', 'background_clip_cleanup', 'background_playback_missing', 'audio_focus_failed', 'audio_focus_delayed', 'playback_start_timeout'];
const STEP_FIELDS = ['flow', 'nativeSynthesis', 'decode', 'playback', 'contentVerification', 'sampleRate', 'sampleCount',
  'duration', 'elementCount', 'interrupted', 'completionDrained', 'profileRestored', 'chatUnchanged', 'deletionRejected', 'fileRemoved'];
function sanitizeTtsEvidence(value) {
  const source = value && typeof value === 'object' ? value : {};
  const safe = { schemaVersion: source.schemaVersion === 1 ? 1 : null, status: source.status, phase: source.phase,
    flow: source.flow, clipId: source.clipId, failureCode: source.failureCode, requiresForceStop: source.requiresForceStop,
    backend: source.backend, runtimeVersion: source.runtimeVersion, patchSha256: source.patchSha256,
    contentVerification: source.contentVerification, steps: [] };
  if (source.mode === 'playback_start') safe.mode = source.mode;
  if (Number.isSafeInteger(source.synthesisCount) && source.synthesisCount >= 0 && source.synthesisCount <= 4) {
    safe.synthesisCount = source.synthesisCount;
  }
  if (!['idle', 'running', 'native_passed', 'failed'].includes(safe.status)) safe.status = 'failed';
  if (!PHASES.includes(safe.phase)) safe.phase = 'invalid';
  if (!FLOWS.includes(safe.flow)) delete safe.flow;
  if (typeof safe.clipId !== 'string' || !/^(tokens|continuous_embd)-(1|2|retry)$/u.test(safe.clipId)) delete safe.clipId;
  if (!FAILURE_CODES.includes(safe.failureCode)) delete safe.failureCode;
  if (safe.backend !== 'cpu') safe.backend = 'unknown';
  if (safe.runtimeVersion !== '0.13.0-rc.3') safe.runtimeVersion = 'unknown';
  if (typeof safe.patchSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(safe.patchSha256)) delete safe.patchSha256;
  safe.contentVerification = 'not_run'; // Native/player receipts cannot prove linguistic content.
  safe.requiresForceStop = source.requiresForceStop !== false;
  if (Array.isArray(source.steps)) safe.steps = source.steps.slice(0, 8).flatMap(step => {
    if (!step || typeof step !== 'object' || typeof step.id !== 'string'
      || !/^(?:(tokens|continuous_embd)-(1|2|retry)|stop_drain|background_cleanup|chat_after|cleanup)$/u.test(step.id)) return [];
    const receipt = { id: step.id, status: step.status === 'passed' ? 'passed' : 'invalid' };
    for (const field of STEP_FIELDS) {
      const data = step[field];
      if (typeof data === 'boolean' || (typeof data === 'number' && Number.isFinite(data))) receipt[field] = data;
      else if (typeof data === 'string' && [...FLOWS, 'passed', 'not_run'].includes(data)) receipt[field] = data;
    }
    return [receipt];
  });
  return safe;
}
function validateTtsEvidence(evidence, flow) {
  const fail = () => { throw new Error('Incomplete native TTS/decode/playback/lifecycle evidence.'); };
  if (!evidence || typeof evidence !== 'object' || !FLOWS.includes(flow)
    || evidence.schemaVersion !== 1 || evidence.status !== 'native_passed' || evidence.phase !== 'complete' || evidence.flow !== flow
    || evidence.requiresForceStop !== false || evidence.backend !== 'cpu' || evidence.runtimeVersion !== '0.13.0-rc.3'
    || evidence.patchSha256 !== patchSha256 || evidence.contentVerification !== 'not_run'
    || !Array.isArray(evidence.steps)) fail();
  const fixture = fixtures.fixtures.find(item => item.flow === flow);
  const maxElements = fixture.mapping.maxAudioCodeElementsPolicy ?? fixture.mapping.maxLatentElementsPolicy;
  const elementsPerFrame = fixture.mapping.codesPerFrame ?? fixture.mapping.embeddingDim;
  const expectedIds = ['1', '2', 'retry'].map(suffix => `${flow}-${suffix}`).concat(['stop_drain', 'chat_after', 'cleanup']);
  if (evidence.steps.length !== expectedIds.length || evidence.steps.some(step => !step || typeof step !== 'object'
    || !expectedIds.includes(step.id)) || new Set(evidence.steps.map(step => step.id)).size !== expectedIds.length) fail();
  for (const suffix of ['1', '2', 'retry']) {
    const step = evidence.steps.find(item => item.id === `${flow}-${suffix}`);
    if (!step || step.flow !== flow || step.status !== 'passed' || step.nativeSynthesis !== 'passed'
      || step.decode !== 'passed' || step.playback !== 'passed' || step.contentVerification !== 'not_run'
      || step.profileRestored !== true || step.chatUnchanged !== true || step.deletionRejected !== true
      || step.sampleRate !== fixture.mapping.sampleRate || !Number.isSafeInteger(step.sampleCount) || step.sampleCount < 1
      || step.sampleCount > 768000 || step.duration !== step.sampleCount / step.sampleRate
      || step.duration > 16 || !Number.isSafeInteger(step.elementCount) || step.elementCount < 1
      || step.elementCount > maxElements || step.elementCount % elementsPerFrame) fail();
  }
  const stopped = evidence.steps.find(item => item.id === 'stop_drain');
  const chat = evidence.steps.find(item => item.id === 'chat_after');
  const cleanup = evidence.steps.find(item => item.id === 'cleanup');
  if (!stopped || stopped.status !== 'passed' || stopped.flow !== flow || stopped.interrupted !== true
    || stopped.completionDrained !== true || stopped.profileRestored !== true || stopped.chatUnchanged !== true
    || !chat || chat.status !== 'passed' || chat.profileRestored !== true || chat.chatUnchanged !== true
    || !cleanup || cleanup.status !== 'passed' || cleanup.fileRemoved !== true) fail();
  return evidence;
}
function validateTtsWav(bytes, step) {
  if (!step || typeof step !== 'object' || !Number.isSafeInteger(step.sampleRate) || step.sampleRate < 8000 || step.sampleRate > 192000
    || !Number.isSafeInteger(step.sampleCount) || step.sampleCount < 1 || step.sampleCount > 768000
    || !Number.isFinite(step.duration) || step.duration !== step.sampleCount / step.sampleRate || step.duration > 16
    || !Buffer.isBuffer(bytes) || bytes.length < 46 || bytes.length > 1536044
    || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE'
    || bytes.readUInt32LE(4) !== bytes.length - 8 || bytes.toString('ascii', 12, 16) !== 'fmt '
    || bytes.readUInt32LE(16) !== 16 || bytes.readUInt16LE(20) !== 1 || bytes.readUInt16LE(22) !== 1
    || bytes.readUInt32LE(24) !== step.sampleRate || bytes.readUInt32LE(28) !== step.sampleRate * 2
    || bytes.readUInt16LE(32) !== 2 || bytes.readUInt16LE(34) !== 16 || bytes.toString('ascii', 36, 40) !== 'data'
    || bytes.readUInt32LE(40) !== step.sampleCount * 2 || bytes.length !== 44 + step.sampleCount * 2) {
    throw new Error('Exported clip differs from the bounded mono PCM receipt.');
  }
  return { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    sampleRate: step.sampleRate, sampleCount: step.sampleCount };
}
function validateTtsPlaybackEvidence(value) {
  const fail = () => { throw new Error('Incomplete single-clip TTS playback acceptance.'); };
  const native = value?.native;
  const controls = value?.publicControls;
  const sameClip = value?.sameClip;
  const background = value?.background;
  if (!native || native.schemaVersion !== 1 || native.status !== 'native_passed' || native.phase !== 'complete'
    || native.flow !== 'tokens' || native.mode !== 'playback_start' || native.synthesisCount !== 1
    || native.requiresForceStop !== false || native.backend !== 'cpu' || native.runtimeVersion !== '0.13.0-rc.3'
    || native.patchSha256 !== patchSha256 || native.contentVerification !== 'not_run') fail();
  const ids = ['tokens-1', 'background_cleanup', 'chat_after', 'cleanup'];
  if (!Array.isArray(native.steps) || native.steps.length !== ids.length
    || native.steps.some((step, index) => step?.id !== ids[index] || step.status !== 'passed')) fail();
  const clip = native.steps[0];
  if (clip.nativeSynthesis !== 'passed' || clip.decode !== 'passed' || clip.flow !== 'tokens'
    || clip.contentVerification !== 'not_run' || clip.profileRestored !== true || clip.chatUnchanged !== true
    || clip.deletionRejected !== true || clip.sampleRate !== 24000 || !Number.isSafeInteger(clip.sampleCount)
    || clip.sampleCount < 1 || clip.sampleCount > 384000 || clip.duration !== clip.sampleCount / 24000
    || !Number.isSafeInteger(clip.elementCount) || clip.elementCount < 2 || clip.elementCount > 2400 || clip.elementCount % 2) fail();
  if (native.steps[1].playback !== 'passed' || native.steps[1].fileRemoved !== true || native.steps[1].profileRestored !== true || native.steps[1].chatUnchanged !== true
    || native.steps[2].profileRestored !== true || native.steps[2].chatUnchanged !== true
    || native.steps[3].fileRemoved !== true) fail();
  if (!controls || ['status', 'playback', 'pause', 'stop', 'replay'].some(key => controls[key] !== 'passed')
    || controls.sampleRate !== clip.sampleRate || controls.sampleCount !== clip.sampleCount
    || !Array.isArray(controls.observedPausedPositions) || controls.observedPausedPositions.length < 3
    || controls.observedPausedPositions.some(step => !Number.isFinite(step?.position) || step.position <= 0 || step.position >= clip.duration)
    || controls.contentVerification !== 'not_run') fail();
  if (!sameClip || !/^[a-f0-9]{64}$/u.test(sameClip.before) || sameClip.before !== sameClip.after
    || !background || ['playingObserved', 'clipRemoved', 'previewClosed', 'noAutoplay'].some(key => background[key] !== true)) fail();
  return value;
}
module.exports = { sanitizeTtsEvidence, validateTtsEvidence, validateTtsWav, validateTtsPlaybackEvidence };
