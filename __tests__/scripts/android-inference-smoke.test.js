const {
  buildScenarios, selectScenarios, configureScenarioBuildEnvironment,
  validateScenarioExecutionOptions, validateInferenceSmokeEvidence, waitForInferenceSmokeEvidence,
  sanitizeInferenceSmokeEvidence,
} = require('../../scripts/android-scenarios');

const fixture = () => ({
  schemaVersion: 1, status: 'passed', phase: 'complete', requiresForceStop: false,
  steps: ['backend_discovery', 'cpu_load', 'generate', 'stop_after_token', 'generate_after_stop',
    'new_chat_isolation', 'unload', 'cpu_reload', 'generate_after_reload'].map((id) => ({
    id, status: 'passed', callbacks: 2, outputCharacters: 5, tokensPredicted: 2,
    tokensEvaluated: 12, inputMessages: 1, discoveredDeviceCount: 0,
    backendMode: 'cpu', loadedGpuLayers: 0, actualGpuAccelerated: false,
  })),
});

describe('explicit Android native inference smoke', () => {
  it('requires isolated current-source Release proof and explicit fixture provisioning', () => {
    const selected = selectScenarios(buildScenarios(), { pack: 'inference' });
    expect(selected.map(scenario => scenario.id)).toEqual(['runtime-inference-lifecycle', 'runtime-model-resources', 'runtime-stage3', 'runtime-local-tools']);
    expect(selectScenarios(buildScenarios(), { pack: 'all' }).some((scenario) => scenario.id === selected[2].id)).toBe(false);
    expect(selected[2]).toMatchObject({ requiresCurrentHeadProvenance: true, requiresIsolatedQaInstall: true });
    expect(selectScenarios(buildScenarios(), { pack: 'all' }).some((scenario) => scenario.id === selected[3].id)).toBe(false);
    expect(selected[3]).toMatchObject({ requiresCurrentHeadProvenance: true, requiresIsolatedQaInstall: true });
    expect(selectScenarios(buildScenarios(), { pack: 'all' }).some((scenario) => scenario.id === selected[1].id)).toBe(false);
    expect(selectScenarios(buildScenarios(), { pack: 'all' }).some((scenario) => scenario.id === selected[0].id)).toBe(false);
    expect(selected[0]).toMatchObject({ requiresCurrentHeadProvenance: true, requiresIsolatedQaInstall: true });
    expect(() => validateScenarioExecutionOptions(selected, {})).toThrow(/isolated/);
    const env = {};
    configureScenarioBuildEnvironment({ pack: 'inference' }, true, env);
    expect(env).toMatchObject({ ANDROID_SMOKE_APK_VARIANT: 'release', EXPO_PUBLIC_ANDROID_QA: '1', EXPO_PUBLIC_ANDROID_QA_DOCUMENTS: '1' });
  });
  it('accepts a complete real-generation lifecycle record', () => {
    expect(validateInferenceSmokeEvidence(fixture()).status).toBe('passed');
  });
  it('retains partial native counts but excludes content and paths from failure evidence', () => {
    const value = fixture();
    value.status = 'failed'; value.phase = 'unload'; value.failureCode = 'unload_incomplete';
    value.prompt = 'private prompt'; value.steps[2].text = 'private response';
    value.steps[2].modelPath = '/private/model'; value.steps = value.steps.slice(0, 6);
    const safe = sanitizeInferenceSmokeEvidence(value);
    expect(safe).toMatchObject({ status: 'failed', phase: 'unload', failureCode: 'unload_incomplete' });
    expect(safe.steps[2].tokensPredicted).toBe(2);
    expect(JSON.stringify(safe)).not.toContain('private');
    expect(sanitizeInferenceSmokeEvidence({ ...value, failureCode: 'private_prompt' }).failureCode).toBeUndefined();
  });
  it.each([null, {}, { ...fixture(), steps: [] }, { ...fixture(), requiresForceStop: true }])(
    'rejects missing or incomplete evidence', (value) => {
      expect(() => validateInferenceSmokeEvidence(value)).toThrow();
    }
  );
  it.each(['callbacks', 'outputCharacters', 'tokensPredicted', 'tokensEvaluated'])(
    'rejects zero %s despite a passed label', (field) => {
      const value = fixture(); value.steps[2][field] = 0;
      expect(() => validateInferenceSmokeEvidence(value)).toThrow(/real generation/);
    }
  );
  it('rejects cancellation without actual tokens and missing subsequent generation', () => {
    const value = fixture(); value.steps[3].callbacks = 0;
    expect(() => validateInferenceSmokeEvidence(value)).toThrow(/cancellation/);
    value.steps.splice(4, 1);
    expect(() => validateInferenceSmokeEvidence(value)).toThrow();
  });
  it('fails absent evidence at a bounded deadline', async () => {
    let time = 0;
    await expect(waitForInferenceSmokeEvidence(() => null, {
      timeoutMs: 10, now: () => time, wait: async () => { time += 10; },
    })).rejects.toThrow(/timed out/);
  });
  it('fails immediately when native cancellation cannot drain', async () => {
    await expect(waitForInferenceSmokeEvidence(() => ({ status: 'failed', requiresForceStop: true })))
      .rejects.toThrow(/failed/);
  });
});
