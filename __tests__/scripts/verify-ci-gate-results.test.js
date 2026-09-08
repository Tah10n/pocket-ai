const { evaluateCiGateResults, readEnvironment } = require('../../scripts/verify-ci-gate-results');

const nativePullRequestResults = (overrides = {}) => ({
  eventName: 'pull_request',
  nativeScopeResult: 'success',
  nativeRequired: 'true',
  deterministicResult: 'success',
  androidNativeResult: 'success',
  iosNativeResult: 'success',
  ...overrides,
});

describe('required CI aggregate gate', () => {
  it('accepts a native PR only after deterministic, Android, and iOS jobs succeed', () => {
    expect(evaluateCiGateResults(nativePullRequestResults())).toMatchObject({
      ok: true,
      failures: [],
    });
  });

  it('accepts skipped native jobs only for a successful non-native PR scope', () => {
    expect(evaluateCiGateResults(nativePullRequestResults({
      nativeRequired: 'false',
      androidNativeResult: 'skipped',
      iosNativeResult: 'skipped',
    }))).toMatchObject({ ok: true, failures: [] });
  });

  it('accepts push CI when the PR-only scope and native jobs are skipped', () => {
    expect(evaluateCiGateResults(nativePullRequestResults({
      eventName: 'push',
      nativeScopeResult: 'skipped',
      nativeRequired: '',
      androidNativeResult: 'skipped',
      iosNativeResult: 'skipped',
    }))).toMatchObject({ ok: true, failures: [] });
  });

  it.each([
    ['deterministic failure', { deterministicResult: 'failure' }, 'deterministic=failure'],
    ['Android failure', { androidNativeResult: 'failure' }, 'android-native=failure'],
    ['iOS cancellation', { iosNativeResult: 'cancelled' }, 'ios-native=cancelled'],
    ['scope failure', { nativeScopeResult: 'failure', nativeRequired: '' }, 'native-scope=failure'],
    ['missing required output', { nativeRequired: '', androidNativeResult: 'skipped', iosNativeResult: 'skipped' }, 'native-required=missing'],
    ['unexpected native execution', { nativeRequired: 'false' }, 'android-native=success;expected=skipped'],
    ['unknown event', { eventName: 'workflow_dispatch' }, 'event=workflow_dispatch'],
  ])('fails closed for %s', (_label, overrides, expectedFailure) => {
    const evaluation = evaluateCiGateResults(nativePullRequestResults(overrides));

    expect(evaluation.ok).toBe(false);
    expect(evaluation.failures).toContain(expectedFailure);
  });

  it('reads only the explicit aggregate result environment', () => {
    expect(readEnvironment({
      CI_EVENT_NAME: 'pull_request',
      NATIVE_SCOPE_RESULT: 'success',
      NATIVE_REQUIRED: 'true',
      DETERMINISTIC_RESULT: 'success',
      ANDROID_NATIVE_RESULT: 'success',
      IOS_NATIVE_RESULT: 'success',
      UNRELATED_SECRET: 'do-not-read',
    })).toEqual(nativePullRequestResults());
  });
});
