const { validateTtsWav } = require('./tts-evidence');
const syntheticFixtures = require('../../docs/validation/llama-rn-stage7/synthetic-inputs.json');
const IDS = ['recording_started', 'recording_finalized', 'recording_prepared', 'recording_preview', 'recording_discard',
  'recording_retry', 'recording_background', 'input_imported', 'input_recorded', 'neu-jo', 'reference-r1', 'reference-r2',
  'qwen-r1-eager', 'qwen-r2-lazy', 'qwen-no-reference', 'chat_after', 'voice_saved', 'voice_cold', 'qwen-saved-cold', 'voice_deleted'];
const CLIPS = ['recorded', 'neu-jo', 'qwen-r1-eager', 'qwen-r2-lazy', 'qwen-no-reference', 'qwen-saved-cold'];
const PHASES = ['idle', 'prepare', 'complete', 'recording_awaiting_controlled_sound', 'recording_awaiting_background',
  'awaiting_clip_copy', 'input_imported', 'input_recorded', 'chat_after', ...CLIPS];
const PROFILES = ['neutts-nano-q4_k_m-neucodec-q8_0', 'qwen3-tts-0.6b-q4_k_m-tokenizer-q8_0'];
const OPERATIONS = ['phonemizer', 'formatter', 'vocoder_init', 'speaker_create', 'speaker_bake', 'speaker_release',
  'completion', 'completion_stop', 'decode', 'vocoder_release'];
const NUMBERS = ['sampleRate', 'sampleCount', 'durationMs', 'sizeBytes', 'callbacks', 'outputCharacters',
  'speakerRows', 'phonemizerElapsedMs', 'voiceCount'];
const BOOLEANS = ['profileRestored', 'chatUnchanged', 'interrupted', 'noAutomaticResume', 'headerValidated',
  'speakerBaked', 'selected', 'contentMatched', 'completionDrained'];
const FAILURES = ['qa_operation_failed', 'host_continuation_timeout', 'isolated_package_required', 'preview_not_playing',
  'audio_preparation_invalid_audio', 'audio_preparation_limit', 'audio_preparation_cancelled',
  'audio_preparation_failed', 'audio_preparation_cleanup_failed',
  'audio_preparation_native_result', 'audio_preparation_prepared_uri', 'audio_preparation_channels',
  'audio_preparation_sample_rate', 'audio_preparation_sample_count', 'audio_preparation_output_size',
  'audio_preparation_source_hash', 'audio_preparation_output_hash', 'audio_preparation_native_input',
  'audio_preparation_native_admission', 'audio_preparation_native_sniff', 'audio_preparation_native_output',
  'audio_preparation_native_decode', 'audio_preparation_native_identity', 'audio_preparation_native_delivery',
  'recorder_busy', 'recorder_not_recording', 'source_not_finalized', 'source_discard_failed', 'retry_not_recording',
  'background_not_finalized', 'automatic_recording_resume', 'stage3_adapter_missing', 'profile_restore', 'chat_history_changed',
  'profile_missing', 'synthesis_receipt', 'reference_not_used', 'bake_mode_mismatch', 'speaker_release_order',
  'unexpected_reference', 'phonemizer_not_executed', 'tts_not_playing', 'reference_fixture_same', 'chat_after_failed',
  'qa_voice_library_not_empty', 'cleanup_native_owner_pending', 'cold_audio_activity', 'cold_saved_voice_missing',
  'native_handle_persisted', 'voice_delete_failed', 'borrowed_fixture_deleted', 'cold_saved_synthesis_missing', 'synthetic_fixture_identity_mismatch', 'audio_fixture_identity_conflict',
  'audio_fixture_queue_conflict', 'audio_fixture_download_timeout', 'audio_fixture_download_failed', 'audio_download_cleanup_failed',
  'native_audio_support_missing', 'audio_completion_missing', 'audio_imported_content_mismatch', 'audio_recorded_content_mismatch',
  'audio_completion_not_drained', 'selection_missing', 'selection_changed', 'files_missing', 'integrity_failed', 'profile_unverified',
  'codec_incompatible', 'prerequisite_missing', 'voice_unavailable', 'language_unsupported', 'phonemizer_failed', 'reference_invalid',
  'consent_required', 'memory_unknown', 'memory_insufficient', 'busy', 'cancelled', 'input_too_large', 'generation_incomplete',
  'payload_invalid', 'decode_failed', 'audio_focus_failed', 'audio_focus_delayed', 'playback_start_timeout', 'native_failed',
  'release_failed', 'restore_failed', 'storage_failed', 'playback_failed'];
const FAILURE_STAGES = ['adapter_prepare', 'base_lora_load', 'tts_fixture_prepare', 'tts_admission', 'tts_setup', 'tts_detach',
  'tts_backbone_init', 'vocoder_init', 'getTTSCapabilities', 'builtin_voice_lookup', 'phonemizer', 'speaker_create',
  'speaker_bake', 'formatter', 'prompt_prepare', 'completion', 'completion_stop', 'decode', 'speaker_release',
  'vocoder_release', 'context_release', 'restore', 'wav_encode', 'qa_voice_sequence'];
function sanitizeAudioStage7Evidence(value) {
  const source = value && typeof value === 'object' ? value : {};
  const result = { schemaVersion: source.schemaVersion === 1 ? 1 : null,
    status: ['idle', 'running', 'native_passed', 'failed'].includes(source.status) ? source.status : 'failed',
    phase: PHASES.includes(source.phase) ? source.phase : 'invalid',
    mode: ['recording', 'input', 'voices', 'cold_voice'].includes(source.mode) ? source.mode : null,
    requiresForceStop: source.requiresForceStop !== false, runtimeVersion: source.runtimeVersion === '0.13.0-rc.3' ? source.runtimeVersion : 'unknown',
    backend: source.backend === 'cpu' ? 'cpu' : 'unknown', contentVerification: 'not_run', referenceConditioning: 'not_run', steps: [] };
  if (CLIPS.includes(source.clipId)) result.clipId = source.clipId;
  if (FAILURES.includes(source.failureCode)) result.failureCode = source.failureCode;
  if (result.status === 'failed' && result.mode === 'voices'
    && FAILURE_STAGES.includes(source.failureStage)) result.failureStage = source.failureStage;
  if (result.status === 'failed' && result.failureCode === 'phonemizer_failed') {
    const failure = source.phonemizerFailure;
    if (failure && ['module_init', 'conversion', 'deadline', 'invalid_output'].includes(failure.reason)
      && ['elapsedMs', 'moduleInitMs'].every(key => failure[key] === undefined
        || (Number.isSafeInteger(failure[key]) && failure[key] >= 0 && failure[key] <= 300_000))
      && !(failure.moduleInitMs !== undefined && failure.elapsedMs !== undefined && failure.moduleInitMs > failure.elapsedMs)) {
      result.phonemizerFailure = { reason: failure.reason };
      for (const key of ['elapsedMs', 'moduleInitMs']) if (failure[key] !== undefined) result.phonemizerFailure[key] = failure[key];
    }
  }
  if (Array.isArray(source.steps)) result.steps = source.steps.slice(0, 24).flatMap(step => {
    if (!step || !IDS.includes(step.id)) return [];
    const safe = { id: step.id, status: step.status === 'passed' ? 'passed' : 'invalid' };
    for (const key of NUMBERS) if (Number.isFinite(step[key]) && step[key] >= 0 && step[key] <= 5_000_000) safe[key] = step[key];
    for (const key of BOOLEANS) if (typeof step[key] === 'boolean') safe[key] = step[key];
    if (/^[a-f0-9]{64}$/u.test(step.sourceSha256 ?? '')) safe.sourceSha256 = step.sourceSha256;
    if (PROFILES.includes(step.profileId)) safe.profileId = step.profileId;
    if (['recorded', 'imported'].includes(step.fixtureKind)) safe.fixtureKind = step.fixtureKind;
    if (step.handlesPersisted === false) safe.handlesPersisted = false;
    if (Array.isArray(step.operations)) safe.operations = step.operations.slice(0, 16).filter(item => OPERATIONS.includes(item));
    return [safe];
  });
  return result;
}
function validateAudioStage7Evidence(evidence, mode) {
  const fail = () => { throw new Error('Incomplete Stage7 native lifecycle evidence.'); };
  if (!evidence || evidence.schemaVersion !== 1 || evidence.status !== 'native_passed' || evidence.phase !== 'complete'
    || evidence.mode !== mode || evidence.backend !== 'cpu' || evidence.runtimeVersion !== '0.13.0-rc.3'
    || evidence.requiresForceStop !== false || evidence.contentVerification !== 'not_run' || evidence.referenceConditioning !== 'not_run') fail();
  const requireStep = id => { const step = evidence.steps.find(item => item.id === id); if (step?.status !== 'passed') fail(); return step; };
  if (mode === 'recording') {
    ['recording_started', 'recording_finalized', 'recording_prepared', 'recording_preview', 'recording_discard', 'recording_retry'].forEach(requireStep);
    const prepared = requireStep('recording_prepared');
    const background = requireStep('recording_background');
    if (prepared.headerValidated !== true || prepared.sampleRate !== 16000 || !prepared.sampleCount || prepared.sampleCount > 480000
      || background.interrupted !== true || background.noAutomaticResume !== true) fail();
  } else if (mode === 'input') {
    for (const id of ['input_imported', 'input_recorded']) {
      const step = requireStep(id);
      if (step.contentMatched !== true || step.completionDrained !== true || step.headerValidated !== true
        || step.sampleRate !== 16000 || !step.sampleCount || !step.callbacks) fail();
    }
  } else if (mode === 'voices') {
    const neu = requireStep('neu-jo');
    if (!neu.operations?.includes('phonemizer') || !Number.isFinite(neu.phonemizerElapsedMs)) fail();
    ['reference-r1', 'reference-r2'].forEach(requireStep);
    for (const [id, eager] of [['qwen-r1-eager', true], ['qwen-r2-lazy', false]]) {
      const step = requireStep(id); const ops = step.operations ?? [];
      if (step.speakerRows !== 1 || step.speakerBaked !== true || !ops.includes('speaker_create') || !ops.includes('speaker_release')
        || ops.includes('speaker_bake') !== eager || ops.indexOf('speaker_release') >= ops.indexOf('vocoder_release')) fail();
    }
    const none = requireStep('qwen-no-reference');
    if (none.operations?.includes('speaker_create')) fail();
    for (const id of ['neu-jo', 'qwen-r1-eager', 'qwen-r2-lazy', 'qwen-no-reference']) {
      const step = requireStep(id);
      if (!step.sampleRate || !step.sampleCount || step.profileRestored !== true || step.chatUnchanged !== true
        || !step.operations?.includes('formatter') || !step.operations.includes('completion') || !step.operations.includes('decode')) fail();
    }
    if (requireStep('chat_after').profileRestored !== true || requireStep('voice_saved').handlesPersisted !== false) fail();
  } else if (mode === 'cold_voice') {
    if (requireStep('voice_cold').handlesPersisted !== false || requireStep('voice_deleted').voiceCount !== 0) fail();
    const saved = requireStep('qwen-saved-cold'); const ops = saved.operations ?? [];
    if (!saved.sampleCount || !saved.sampleRate || saved.speakerRows !== 1 || saved.speakerBaked !== true
      || saved.profileRestored !== true || !ops.includes('speaker_create') || !ops.includes('speaker_bake')
      || !ops.includes('formatter') || !ops.includes('completion') || !ops.includes('decode') || !ops.includes('speaker_release')
      || ops.indexOf('speaker_release') >= ops.indexOf('vocoder_release')) fail();
  } else fail();
  return evidence;
}
function validateStage7MicInjectionReceipt(value, startedAt) {
  const input = syntheticFixtures.fixtures.find(item => item.filename === 'input-orange-seven.wav');
  if (!value || !input || value.mode !== 'emulator_grpc_injectAudio' || value.sourceSha256 !== input.sha256
    || value.sampleRate !== 16000 || value.sampleCount !== 57280 || value.channels !== 1 || value.bitsPerSample !== 16
    || !Number.isFinite(value.startedAt) || value.startedAt < startedAt || !Number.isFinite(value.finishedAt)
    || value.finishedAt < value.startedAt || value.finishedAt > Date.now() || value.streamEof !== true) {
    throw new Error('Missing current controlled emulator microphone injection proof.');
  }
  return { mode: value.mode, sourceSha256: value.sourceSha256, sampleRate: 16000, sampleCount: 57280,
    channels: 1, bitsPerSample: 16, streamEof: true, startedAt: value.startedAt, finishedAt: value.finishedAt };
}
module.exports = { sanitizeAudioStage7Evidence, validateAudioStage7Evidence, validateStage7MicInjectionReceipt, validateTtsWav };
