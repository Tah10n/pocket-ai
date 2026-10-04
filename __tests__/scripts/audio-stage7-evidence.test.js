const { it, expect, jest } = require('@jest/globals');
const { sanitizeAudioStage7Evidence, validateAudioStage7Evidence, validateStage7MicInjectionReceipt } = require('../../scripts/lib/audio-stage7-evidence');
const { buildScenarios, configureScenarioBuildEnvironment, validateScenarioExecutionOptions,
  grantStage7MicrophoneAfterExplicitRecord, parseUiSnapshot } = require('../../scripts/android-scenarios');
const initial = mode => ({ schemaVersion: 1, status: 'native_passed', phase: 'complete', mode, requiresForceStop: false,
  runtimeVersion: '0.13.0-rc.3', backend: 'cpu', contentVerification: 'not_run', referenceConditioning: 'not_run', steps: [] });
const step = (id, fields = {}) => ({ id, status: 'passed', ...fields });
it('drops every source/transcript/phoneme/native-handle field from receipts', () => {
  const safe = sanitizeAudioStage7Evidence({ ...initial('voices'), transcript: 'private', sourceUri: '/private/audio',
    referenceConditioning: 'passed', contentVerification: 'passed',
    steps: [step('qwen-r1-eager', { speakerId: 123, refText: 'private', phones: 'private', pcm: [1],
      sourceUri: '/private', operations: ['speaker_create', 'private text'], speakerRows: 1 })] });
  expect(safe).toMatchObject({ referenceConditioning: 'not_run', contentVerification: 'not_run',
    steps: [{ operations: ['speaker_create'], speakerRows: 1 }] });
  expect(JSON.stringify(safe)).not.toMatch(/private|speakerId|sourceUri|refText|phones|pcm/u);
});
it('retains only failed phonemizer diagnostics with finite reasons and bounded integer timings', () => {
  const failure = { ...initial('voices'), status: 'failed', failureCode: 'phonemizer_failed',
    phonemizerFailure: { reason: 'deadline', elapsedMs: 1001, moduleInitMs: 30, input: 'private', phones: 'private' } };
  expect(sanitizeAudioStage7Evidence(failure).phonemizerFailure).toEqual({ reason: 'deadline', elapsedMs: 1001, moduleInitMs: 30 });
  for (const reason of ['module_init', 'conversion', 'invalid_output']) {
    expect(sanitizeAudioStage7Evidence({ ...failure, phonemizerFailure: { reason } }).phonemizerFailure).toEqual({ reason });
  }
  expect(JSON.stringify(sanitizeAudioStage7Evidence(failure))).not.toContain('private');
  for (const value of [-1, 1.5, NaN, Infinity, 300001, '20', null]) {
    for (const key of ['elapsedMs', 'moduleInitMs']) {
      expect(sanitizeAudioStage7Evidence({ ...failure, phonemizerFailure: { reason: 'deadline', [key]: value } }).phonemizerFailure).toBeUndefined();
    }
  }
  for (const phonemizerFailure of [{ reason: 'private' }, { reason: 'deadline', elapsedMs: 1, moduleInitMs: 2 }]) {
    expect(sanitizeAudioStage7Evidence({ ...failure, phonemizerFailure }).phonemizerFailure).toBeUndefined();
  }
  expect(sanitizeAudioStage7Evidence({ ...failure, status: 'native_passed' }).phonemizerFailure).toBeUndefined();
  expect(sanitizeAudioStage7Evidence({ ...failure, failureCode: 'storage_failed' }).phonemizerFailure).toBeUndefined();
});
it('refuses successful status without actual recorder lifecycle and finalized header receipts', () => {
  expect(() => validateAudioStage7Evidence(initial('recording'), 'recording')).toThrow();
  const recording = { ...initial('recording'), steps: ['recording_started', 'recording_finalized', 'recording_preview',
    'recording_discard', 'recording_retry'].map(id => step(id)).concat([
    step('recording_prepared', { headerValidated: true, sampleRate: 16000, sampleCount: 32000 }),
    step('recording_background', { interrupted: true, noAutomaticResume: true })]) };
  expect(validateAudioStage7Evidence(recording, 'recording')).toBe(recording);
  recording.steps.at(-1).noAutomaticResume = false;
  expect(() => validateAudioStage7Evidence(recording, 'recording')).toThrow();
});
it('requires separate imported and recorded audio content proof', () => {
  const input = { ...initial('input'), steps: ['input_imported', 'input_recorded'].map(id => step(id, {
    contentMatched: true, completionDrained: true, headerValidated: true, sampleRate: 16000, sampleCount: 30000, callbacks: 2 })) };
  expect(validateAudioStage7Evidence(input, 'input')).toBe(input);
  input.steps[1].contentMatched = false;
  expect(() => validateAudioStage7Evidence(input, 'input')).toThrow();
});
it('requires actual bake receipt and release order rather than random output hashes', () => {
  const operations = ['vocoder_init', 'speaker_create', 'speaker_bake', 'formatter', 'completion', 'decode', 'speaker_release', 'vocoder_release'];
  const common = { sampleRate: 24000, sampleCount: 12000, profileRestored: true, chatUnchanged: true };
  const voices = { ...initial('voices'), steps: [step('neu-jo', { ...common, phonemizerElapsedMs: 20,
    operations: ['phonemizer', 'formatter', 'completion', 'decode'] }), step('reference-r1'), step('reference-r2'),
  step('qwen-r1-eager', { ...common, speakerRows: 1, speakerBaked: true, operations }),
  step('qwen-r2-lazy', { ...common, speakerRows: 1, speakerBaked: true, operations: operations.filter(op => op !== 'speaker_bake') }),
  step('qwen-no-reference', { ...common, operations: ['formatter', 'completion', 'decode'] }),
  step('chat_after', { profileRestored: true }), step('voice_saved', { handlesPersisted: false })] };
  expect(validateAudioStage7Evidence(voices, 'voices')).toBe(voices);
  voices.steps[3].speakerBaked = false;
  expect(() => validateAudioStage7Evidence(voices, 'voices')).toThrow();
});
it('accepts only the current exact controlled grpc fixture injection after actual Record', () => {
  const now = Date.now();
  const injection = { mode: 'emulator_grpc_injectAudio', sourceSha256: 'dad094e335ce919ca55e169e192295a1ca1bccacb5a36243427a5e3927955e78',
    sampleRate: 16000, sampleCount: 57280, channels: 1, bitsPerSample: 16, startedAt: now - 2000, finishedAt: now - 1000, streamEof: true };
  expect(validateStage7MicInjectionReceipt(injection, now - 3000)).toMatchObject({ streamEof: true });
  expect(() => validateStage7MicInjectionReceipt(injection, now)).toThrow();
  expect(() => validateStage7MicInjectionReceipt({ ...injection, streamEof: false }, now - 3000)).toThrow();
  expect(() => validateStage7MicInjectionReceipt({ ...injection, sourceSha256: 'a'.repeat(64) }, now - 3000)).toThrow();
});
it('selects the small new pack without the prior six clips/retrieval pack', () => {
  const scenarios = buildScenarios();
  const ids = ['runtime-stage7-recording', 'runtime-stage7-audio-input', 'runtime-stage7-voices'];
  for (const id of ids) expect(scenarios.find(scenario => scenario.id === id)).toMatchObject({ requiresCurrentHeadProvenance: true, requiresIsolatedQaInstall: true });
  const selected = scenarios.filter(scenario => ids.includes(scenario.id));
  expect(() => validateScenarioExecutionOptions(selected, { isolatedQaInstall: false })).toThrow();
  const env = { ANDROID_SMOKE_APK_VARIANT: 'release' };
  configureScenarioBuildEnvironment({ pack: 'audio-voices', isolatedQaInstall: true }, true, env);
  expect(env).toMatchObject({ EXPO_PUBLIC_ANDROID_QA: '1', EXPO_PUBLIC_ANDROID_QA_DOCUMENTS: '1', POCKET_AI_QA_PRIVATE_FILE_ACCESS: '1' });
});

it('handles the OS prompt with no QA marker, exclusively after explicit Record', () => {
  const snapshot = parseUiSnapshot('<hierarchy><node bounds="[0,0][1080,2400]" />'
    + '<node resource-id="com.android.permissioncontroller:id/permission_allow_foreground_only_button" text="While using the app" bounds="[100,800][900,1000]" />'
    + '</hierarchy>');
  const tap = jest.fn(); const createSnapshot = jest.fn(() => snapshot);
  expect(grantStage7MicrophoneAfterExplicitRecord('adb', 'emulator', { createSnapshot, tapBounds: tap })).toBe(false);
  expect(tap).not.toHaveBeenCalled(); expect(createSnapshot).not.toHaveBeenCalled();
  expect(grantStage7MicrophoneAfterExplicitRecord('adb', 'emulator', { explicitRecordIssued: true, createSnapshot, tapBounds: tap })).toBe(true);
  expect(tap).toHaveBeenCalledTimes(1);
});

it('retains one closed failure stage only for failed voices and never upgrades failure to native acceptance', () => {
  const { TTS_FAILURE_STAGES } = require('../../src/types/tts');
  for (const failureStage of TTS_FAILURE_STAGES) {
    const source = { ...initial('voices'), status: 'failed', failureCode: 'native_failed', failureStage,
      error: { message: 'synthetic private detail' }, paths: ['/private'], phonemes: ['private'],
      failureEvents: [{ failureStage, tokens: [1, 2] }] };
    const safe = sanitizeAudioStage7Evidence(source);
    expect(safe.failureStage).toBe(failureStage);
    expect(JSON.stringify(safe)).not.toMatch(/private|failureEvents|phonemes|tokens|paths/u);
    expect(() => validateAudioStage7Evidence(safe, 'voices')).toThrow();
    expect(sanitizeAudioStage7Evidence({ ...source, status: 'native_passed' })).not.toHaveProperty('failureStage');
    for (const mode of ['recording', 'input', 'cold_voice']) {
      expect(sanitizeAudioStage7Evidence({ ...source, mode })).not.toHaveProperty('failureStage');
    }
  }
  for (const failureStage of [null, 1, [], {}, 'private', 'formatter\n/private']) {
    expect(sanitizeAudioStage7Evidence({ ...initial('voices'), status: 'failed', failureCode: 'native_failed', failureStage }))
      .not.toHaveProperty('failureStage');
  }
});
