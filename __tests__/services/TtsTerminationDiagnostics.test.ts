import { sanitizeTtsNativeCompletion, sanitizeTtsObservation, sanitizeTtsTerminationDiagnostics } from '../../src/types/tts';

const receipt = { schemaVersion: 1, sampledTokenCount: 50, audioTokenCount: 49, stopTokenKind: 'expected_speech_end' };
it.each(['expected_speech_end', 'other_eog'])('admits only the closed %s category and strips payload fields', stopTokenKind => {
  expect(sanitizeTtsTerminationDiagnostics({ ...receipt, stopTokenKind, tokenId: 128261, text: 'private', audio: [1] }))
    .toEqual({ ...receipt, stopTokenKind });
});
it.each([{ schemaVersion: 2 }, { sampledTokenCount: -1 }, { sampledTokenCount: 1.5 }, { sampledTokenCount: NaN },
  { sampledTokenCount: 1_000_001 }, { audioTokenCount: 51 }, { audioTokenCount: '49' }])('rejects invalid diagnostic values %j', invalid => {
  expect(sanitizeTtsTerminationDiagnostics({ ...receipt, ...invalid })).toBeUndefined();
});
it('keeps missing or unknown EOS categories absent and scopes observations to settled completion', () => {
  expect(sanitizeTtsTerminationDiagnostics({ ...receipt, stopTokenKind: 'private' })).toEqual({ schemaVersion: 1, sampledTokenCount: 50, audioTokenCount: 49 });
  expect(sanitizeTtsObservation({ operation: 'formatter', phase: 'settled', termination: receipt })?.termination).toBeUndefined();
  expect(sanitizeTtsObservation({ operation: 'completion', phase: 'started', termination: receipt })?.termination).toBeUndefined();
  expect(sanitizeTtsObservation({ operation: 'completion', phase: 'settled', termination: receipt })?.termination).toEqual(receipt);
  expect(sanitizeTtsNativeCompletion({ termination: receipt })?.termination).toEqual(receipt);
});
