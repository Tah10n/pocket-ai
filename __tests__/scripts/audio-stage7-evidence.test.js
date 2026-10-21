const { it, expect, jest } = require('@jest/globals');
const { sanitizeAudioStage7Evidence, validateAudioStage7Evidence, validateStage7MicInjectionReceipt, validateStage7CopiedClips } = require('../../scripts/lib/audio-stage7-evidence');
const { buildScenarios, configureScenarioBuildEnvironment, validateScenarioExecutionOptions,
  grantStage7MicrophoneAfterExplicitRecord, parseUiSnapshot } = require('../../scripts/android-scenarios');
const initial = mode => ({ schemaVersion: 1, status: 'native_passed', phase: 'complete', mode, requiresForceStop: false,
  runtimeVersion: '0.13.0-rc.3', backend: 'cpu', contentVerification: 'not_run', referenceConditioning: 'not_run', steps: [] });
const neuFields = { profileId: 'neutts-nano-q4_k_m-neucodec-q8_0', sampleRate: 24000, sampleCount: 12000, profileRestored: true, chatUnchanged: true, phonemizerElapsedMs: 20, phonemizerConversionMs: 5,
  termination: { schemaVersion: 1, sampledTokenCount: 50, audioTokenCount: 49, stopTokenKind: 'expected_speech_end' },
  operations: ['phonemizer', 'phonemizer_conversion', 'formatter', 'completion', 'decode'] };
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
  const voices = { ...initial('voices'), steps: [step('neu-synthetic-first', neuFields), step('neu-synthetic-repeat', neuFields), step('reference-r1'), step('reference-r2'),
  step('qwen-r1-eager', { ...common, speakerRows: 1, speakerBaked: true, operations }),
  step('qwen-r2-lazy', { ...common, speakerRows: 1, speakerBaked: true, operations: operations.filter(op => op !== 'speaker_bake') }),
  step('qwen-no-reference', { ...common, operations: ['formatter', 'completion', 'decode'] }),
  step('chat_after', { profileRestored: true }), step('voice_saved', { handlesPersisted: false })] };
  expect(validateAudioStage7Evidence(voices, 'voices')).toBe(voices);
  voices.steps.find(item => item.id === 'qwen-r1-eager').speakerBaked = false;
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
it.each(['phonemizer', 'reference'])('isolates targeted %s while preserving native QA build gates', mode => {
  const scenario = `runtime-stage7-${mode}`;
  const selected = buildScenarios().filter(item => item.id === scenario);
  expect(selected).toHaveLength(1);
  expect(selected[0]).toMatchObject({ requiresCurrentHeadProvenance: true, requiresIsolatedQaInstall: true });
  expect(() => validateScenarioExecutionOptions(selected, { isolatedQaInstall: false })).toThrow();
  const env = { ANDROID_SMOKE_APK_VARIANT: 'release' };
  configureScenarioBuildEnvironment({ scenario, isolatedQaInstall: true }, true, env);
  expect(env).toMatchObject({ EXPO_PUBLIC_ANDROID_QA: '1',
    EXPO_PUBLIC_ANDROID_QA_DOCUMENTS: '1', POCKET_AI_QA_PRIVATE_FILE_ACCESS: '1' });
  expect(sanitizeAudioStage7Evidence({ ...initial(mode), status: 'failed',
    failureCode: 'native_failed', failureStage: 'decode' })).toMatchObject({ mode, failureStage: 'decode' });
});
it('requires actual native synthesis and decode for targeted phonemizer acceptance', () => {
  const evidence = { ...initial('phonemizer'), steps: [
    step('neu-synthetic-first', { ...neuFields, sampleRate: 24000, sampleCount: 12000, profileRestored: true, chatUnchanged: true,
      phonemizerElapsedMs: 20, phonemizerModuleInitMs: 15, phonemizerConversionMs: 5,
      operations: ['phonemizer_module_init', 'phonemizer_conversion', 'phonemizer', 'formatter', 'completion', 'decode'] }),
    step('neu-synthetic-repeat', neuFields),
    step('chat_after', { profileRestored: true })] };
  expect(validateAudioStage7Evidence(sanitizeAudioStage7Evidence(evidence), 'phonemizer').steps[0])
    .toMatchObject({ phonemizerModuleInitMs: 15, phonemizerConversionMs: 5 });
  evidence.steps[0].operations = ['phonemizer_module_init', 'phonemizer_conversion', 'phonemizer'];
  expect(() => validateAudioStage7Evidence(evidence, 'phonemizer')).toThrow();
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

it('bounds failed-attempt retention and strips untrusted fields, nonfinite counters and nonexact reasons', () => {
  const receipt = { ...initial('phonemizer'), status: 'failed', failedAttempt: { id: 'neu-synthetic-first', observations: [
    ...Array.from({ length: 100 }, (_, promptTokens) => ({ operation: 'completion', phase: 'started', promptTokens })),
    { operation: 'first_failure', phase: 'failed', failureStage: 'completion', failureReason: 'grammar_parse_failed /private',
      elapsedMs: Infinity, sampleCount: 1000001, nativePrefillMs: -1, grammarPresent: 'true', stoppedEos: true,
      pcm: [1], prompt: '/private', message: '/private', speakerId: 12 },
    { operation: '/private', phase: 'failed' }, null,
  ] } };
  const safe = sanitizeAudioStage7Evidence(receipt);
  expect(safe.failedAttempt.observations).toHaveLength(62);
  expect(safe.failedAttempt.observations[0].promptTokens).toBe(39);
  expect(safe.failedAttempt.observations.at(-1)).toEqual({ operation: 'first_failure', phase: 'failed', failureStage: 'completion', stoppedEos: true });
  expect(JSON.stringify(safe)).not.toMatch(/private|speakerId|pcm|message/u);
  expect(sanitizeAudioStage7Evidence({ ...receipt, status: 'native_passed' }).failedAttempt).toBeUndefined();
  expect(() => validateAudioStage7Evidence(safe, 'phonemizer')).toThrow();
});

it('independently bounds closed termination telemetry in passed and failed native QA receipts', () => {
  const termination = { schemaVersion: 1, sampledTokenCount: 50, audioTokenCount: 49, stopTokenKind: 'expected_speech_end', text: 'private', tokenId: 128261 };
  const expected = { schemaVersion: 1, sampledTokenCount: 50, audioTokenCount: 49, stopTokenKind: 'expected_speech_end' };
  const source = { ...initial('phonemizer'), steps: [step('neu-synthetic-first', { profileId: 'neutts-nano-q4_k_m-neucodec-q8_0', termination })] };
  expect(sanitizeAudioStage7Evidence(source).steps[0].termination).toEqual(expected);
  const failed = { ...source, status: 'failed', failedAttempt: { id: 'neu-synthetic-first', observations: [{ operation: 'completion', phase: 'settled', termination }] } };
  expect(sanitizeAudioStage7Evidence(failed).failedAttempt.observations[0].termination).toEqual(expected);
  for (const invalid of [{ schemaVersion: 2 }, { sampledTokenCount: Infinity }, { audioTokenCount: 51 }, { audioTokenCount: -1 }]) {
    expect(sanitizeAudioStage7Evidence({ ...source, steps: [step('neu-synthetic-first', { profileId: 'neutts-nano-q4_k_m-neucodec-q8_0', termination: { ...termination, ...invalid } })] }).steps[0].termination).toBeUndefined();
  }
  expect(JSON.stringify(sanitizeAudioStage7Evidence(failed))).not.toContain('private');
});

it('requires both new targets to execute production phonemization and reach expected EOS', () => {
  const valid = () => ({ ...initial('phonemizer'), steps: [step('neu-synthetic-first', neuFields),
    step('neu-synthetic-repeat', neuFields), step('chat_after', { profileRestored: true })] });
  expect(() => validateAudioStage7Evidence(sanitizeAudioStage7Evidence(valid()), 'phonemizer')).not.toThrow();
  for (const index of [0, 1]) {
    for (const change of [{ operations: ['formatter', 'completion', 'decode'] },
      { phonemizerConversionMs: undefined }, { termination: undefined },
      { termination: { ...neuFields.termination, stopTokenKind: 'other_eog' } },
      { termination: { ...neuFields.termination, audioTokenCount: 0 } }]) {
      const evidence = valid(); evidence.steps[index] = { ...evidence.steps[index], ...change };
      expect(() => validateAudioStage7Evidence(sanitizeAudioStage7Evidence(evidence), 'phonemizer')).toThrow();
    }
  }
  for (const staleId of ['neu-jo', 'neu-canonical', 'canonical-target']) {
    const evidence = valid(); evidence.steps.push(step(staleId, neuFields));
    expect(() => validateAudioStage7Evidence(sanitizeAudioStage7Evidence(evidence), 'phonemizer')).toThrow();
  }
  for (const fields of [{ diagnosticOnly: true }, { productionG2POutputUsed: false }]) {
    expect(() => validateAudioStage7Evidence(sanitizeAudioStage7Evidence({ ...valid(), ...fields }), 'phonemizer')).toThrow();
  }
});
it('requires exact new clip exports rather than only a matching clip count', () => {
  const clips = ['neu-synthetic-first', 'neu-synthetic-repeat'];
  expect(() => validateStage7CopiedClips(new Set(clips), 'phonemizer')).not.toThrow();
  expect(() => validateStage7CopiedClips(new Set([...clips, 'qwen-r1-eager', 'qwen-r2-lazy', 'qwen-no-reference']), 'voices')).not.toThrow();
  for (const ids of [['neu-jo', 'neu-synthetic-repeat'], ['neu-canonical', 'neu-synthetic-first'], [clips[0]], [...clips, 'neu-jo']]) {
    expect(() => validateStage7CopiedClips(new Set(ids), 'phonemizer')).toThrow();
  }
});
