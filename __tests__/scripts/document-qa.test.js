const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  DOCUMENT_BENCHMARK_CASES,
  DOCUMENT_QA_FIXTURES,
  DOCUMENT_QA_PRIVACY,
  DOCUMENT_QA_SCENARIOS,
  resolveDocumentQaFixture,
  validateDocumentQaCorpus,
} = require('../../scripts/document-qa-fixtures');
const {
  DOCUMENT_BENCHMARK_SCENARIOS,
  DOCUMENT_EVIDENCE_POLICY,
  DOCUMENT_NATIVE_CONVERSION_DEADLINE_MS,
  DOCUMENT_RACE_POST_CANCEL_HORIZON_MS,
  DOCUMENT_SCENARIOS,
  assertDocumentSentinelsStayAbsent,
  buildDocumentFailureFields,
  buildScenarios,
  describeDocumentScenarioConsoleError,
  parseUiSnapshot,
  parseCliOptions,
  readAndroidProcessRssBytes,
  selectScenarios,
  serializeReportResults,
} = require('../../scripts/android-scenarios');
const {
  HOST_RESPONSE_TIMEOUT_MS,
  NATIVE_CONVERSION_DEADLINE_MS,
  assertSentinelOnlyEvidence,
  buildBenchmarkPlan,
  normalizeHostLibraries,
  parseCli,
  readCurrentHeadOrNull,
  runHostBenchmark,
  runHostBenchmarkIteration,
  waitForHostResponse,
  writeJsonAtomic,
} = require('../../scripts/document-benchmark');

describe('synthetic document Android QA corpus', () => {
  it('provisions each platform toolchain before shared verification and native build', () => {
    const packageJson = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', '..', 'package.json'),
      'utf8',
    ));
    expect(packageJson.scripts['verify:documents:android']).toBe(
      'npm run anydoc:setup -- --platform=android && npm run verify:documents && npm run anydoc:build:android',
    );
    expect(packageJson.scripts['verify:documents:ios']).toBe(
      'npm run anydoc:setup -- --platform=ios && npm run verify:documents && npm run anydoc:build:ios',
    );
  });

  it('pins every routed fixture by byte length and SHA-256', () => {
    expect(validateDocumentQaCorpus()).toEqual({
      fixtureCount: 13,
      scenarioCount: 12,
      benchmarkCount: 14,
    });
    expect(DOCUMENT_QA_FIXTURES.every((fixture) => fixture.privacy === DOCUMENT_QA_PRIVACY)).toBe(true);
    expect(DOCUMENT_QA_FIXTURES.every((fixture) => {
      const resolved = resolveDocumentQaFixture(fixture.id);
      return fs.statSync(resolved.absolutePath).size === fixture.bytes;
    })).toBe(true);
  });

  it('covers the required formats, errors, lifecycle races, and four-document route', () => {
    const byId = new Map(DOCUMENT_QA_SCENARIOS.map((scenario) => [scenario.id, scenario]));
    expect([...byId.keys()]).toEqual([
      'document-docx-send',
      'document-pptx-send',
      'document-xlsx-send',
      'document-epub-send',
      'document-pdf-send',
      'document-invalid-error',
      'document-encrypted-error',
      'document-resource-limit-error',
      'document-stop-during-parse',
      'document-thread-switch-race',
      'document-model-switch-race',
      'document-four-flow',
    ]);
    expect(byId.get('document-four-flow').fixtureIds).toHaveLength(4);
    expect(new Set(DOCUMENT_QA_SCENARIOS.map((scenario) => scenario.kind))).toEqual(new Set([
      'success',
      'error',
      'stop-race',
      'thread-race',
      'model-race',
    ]));
  });
});

describe('document Android scenario packs', () => {
  const scenarios = buildScenarios();

  it('selects only sentinel-only current-head scenarios for the documents pack', () => {
    const selected = selectScenarios(scenarios, parseCliOptions(['--pack', 'documents']));
    expect(selected.map((scenario) => scenario.id)).toEqual(DOCUMENT_SCENARIOS);
    expect(selected.every((scenario) => (
      scenario.evidencePolicy === DOCUMENT_EVIDENCE_POLICY
      && scenario.requiresCurrentHeadProvenance === true
      && scenario.captureFullEvidence !== true
    ))).toBe(true);
  });

  it('keeps expensive document and benchmark packs out of default and broad all runs', () => {
    const defaultIds = selectScenarios(scenarios, parseCliOptions([]))
      .map((scenario) => scenario.id);
    const allIds = selectScenarios(scenarios, parseCliOptions(['--pack', 'all']))
      .map((scenario) => scenario.id);
    expect(defaultIds).not.toEqual(expect.arrayContaining(DOCUMENT_SCENARIOS));
    expect(defaultIds).not.toEqual(expect.arrayContaining(DOCUMENT_BENCHMARK_SCENARIOS));
    expect(allIds).not.toEqual(expect.arrayContaining(DOCUMENT_SCENARIOS));
    expect(allIds).not.toEqual(expect.arrayContaining(DOCUMENT_BENCHMARK_SCENARIOS));
  });

  it('rejects a stale document sentinel that arrives after the old five-second window', async () => {
    let elapsedMs = 0;
    const lateSentinelAtMs = 6_000;
    const sentinelId = 'orchid-742';
    const createSnapshot = jest.fn(() => parseUiSnapshot(`
      <hierarchy>
        <node resource-id="" bounds="[0,0][1080,2400]" />
        ${elapsedMs >= lateSentinelAtMs
    ? `<node resource-id="chat-prepared-document-sentinel-${sentinelId}" bounds="[0,0][1,1]" />`
    : ''}
      </hierarchy>
    `));

    expect(DOCUMENT_NATIVE_CONVERSION_DEADLINE_MS).toBe(30_000);
    expect(DOCUMENT_RACE_POST_CANCEL_HORIZON_MS).toBe(35_000);
    await expect(assertDocumentSentinelsStayAbsent('adb', 'device-1', [sentinelId], {
      now: () => elapsedMs,
      createSnapshot,
      delayFn: async (delayMs) => { elapsedMs += delayMs; },
      pollIntervalMs: 1_000,
    })).rejects.toThrow('A stale document prompt sentinel reached a replacement chat context.');
    expect(elapsedMs).toBe(lateSentinelAtMs);
    expect(elapsedMs).toBeGreaterThan(5_000);
  });

  it('maps every benchmark case to a dedicated sentinel-only scenario', () => {
    const selected = selectScenarios(
      scenarios,
      parseCliOptions(['--pack', 'document-benchmark'])
    );
    expect(selected.map((scenario) => scenario.id)).toEqual(
      DOCUMENT_BENCHMARK_CASES.map((benchmark) => `document-benchmark-${benchmark.id}`)
    );
    expect(selected.every((scenario) => scenario.evidencePolicy === 'sentinel-only')).toBe(true);
  });

  it('parses Android TOTAL RSS as bytes without retaining dumpsys output', () => {
    const run = jest.fn(() => 'App Summary\nTOTAL RSS: 123,456 KB\n');
    expect(readAndroidProcessRssBytes('adb', 'device-1', run)).toBe(123_456 * 1024);
    expect(run).toHaveBeenCalledWith('adb', expect.arrayContaining([
      'dumpsys',
      'meminfo',
      '--local',
      'com.github.tah10n.pocketai',
    ]), expect.objectContaining({ allowFailure: true }));
    expect(readAndroidProcessRssBytes('adb', 'device-1', () => 'TOTAL PSS: 123')).toBeNull();
  });

  it('reduces document failures to allowlisted codes without UI, prompt, or filename text', () => {
    const privateText = 'PQA-PRIVATE prompt from synthetic-secret-name.docx Visible UI: secret body';
    const error = new Error(privateText);
    const serialized = serializeReportResults([{
      id: 'document-docx-send',
      tier: 'critical',
      status: 'failed',
      durationMs: 17,
      evidencePolicy: DOCUMENT_EVIDENCE_POLICY,
      error: privateText,
      captureError: privateText,
      reason: privateText,
      details: { prompt: privateText },
    }]);
    expect(serialized).toEqual([{
      id: 'document-docx-send',
      tier: 'critical',
      status: 'failed',
      durationMs: 17,
      evidencePolicy: DOCUMENT_EVIDENCE_POLICY,
      errorCode: 'document_scenario_failed',
      failureStage: 'scenario',
    }]);
    expect(JSON.stringify(serialized)).not.toContain(privateText);
    expect(JSON.stringify(buildDocumentFailureFields(error, 'scenario'))).not.toContain(privateText);
    expect(describeDocumentScenarioConsoleError(error)).toBe('document_scenario_run_failed');
    expect(describeDocumentScenarioConsoleError(error)).not.toContain(privateText);
  });
});

describe('document benchmark contract', () => {
  it('builds deterministic host and Android release plans without paths or content', () => {
    const host = buildBenchmarkPlan('host');
    const android = buildBenchmarkPlan('android-device');
    expect(host).toEqual(expect.objectContaining({
      buildType: 'release',
      privacy: 'synthetic-only',
      runnerProtocol: expect.objectContaining({ executable: 'pocket-anydoc-host-bench' }),
    }));
    expect(android.runnerProtocol).toEqual(expect.objectContaining({
      scenarioPack: 'document-benchmark',
    }));
    expect(host.cases).toHaveLength(DOCUMENT_BENCHMARK_CASES.length);
    expect(() => assertSentinelOnlyEvidence(host)).not.toThrow();
    expect(JSON.stringify(host)).not.toMatch(/(?:localUri|sourcePath|privateRoot|logcat|prompt|markdown)/i);
  });

  it('rejects content, logcat, paths, and raw prompt fields from reports', () => {
    for (const forbidden of [
      { content: 'document text' },
      { logcat: 'raw output' },
      { prompt: 'raw prompt' },
      { localUri: 'file:///private/doc' },
      { nested: { sourcePath: 'C:\\private\\doc.docx' } },
    ]) {
      expect(() => assertSentinelOnlyEvidence(forbidden)).toThrow();
    }
  });

  it('parses an explicit host runner artifact without shell command strings', () => {
    expect(parseCli([
      'run-host',
      '--runner',
      'pocket-anydoc-host-bench.exe',
      '--library',
      'x86_64:pocket-anydoc-host-bench.exe:pocket-anydoc-host-bench.exe',
    ])).toEqual({
      command: 'run-host',
      options: {
        runner: 'pocket-anydoc-host-bench.exe',
        library: [
          'x86_64:pocket-anydoc-host-bench.exe:pocket-anydoc-host-bench.exe',
        ],
      },
    });
  });

  it('uses the statically linked release runner as the canonical host artifact', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-anydoc-host-artifact-'));
    const runnerPath = path.join(root, process.platform === 'win32'
      ? 'pocket-anydoc-host-bench.exe'
      : 'pocket-anydoc-host-bench');
    fs.writeFileSync(runnerPath, 'synthetic runner bytes');
    try {
      expect(normalizeHostLibraries(undefined, runnerPath)).toEqual([expect.objectContaining({
        abi: process.arch,
        library: path.basename(runnerPath),
        sizeBytes: Buffer.byteLength('synthetic runner bytes'),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      })]);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it('binds a custom runner to the default host artifact measurement', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'scripts', 'document-benchmark.js'),
      'utf8',
    );
    expect(source).toContain('normalizeHostLibraries(options.library, runnerPath)');
    expect(source).not.toContain('normalizeHostLibraries(options.library);');
  });

  it('keeps the checked-in report schema aligned with the harness version', () => {
    const schemaPath = path.join(__dirname, '..', '..', 'scripts', 'document-benchmark-report.schema.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    expect(schema.properties.schemaVersion.const).toBe(1);
    expect(schema.properties.target.enum).toEqual(['host', 'android-device']);
    expect(schema.properties.privacy.const).toBe('synthetic-only');
  });

  it('allows a bounded host response at the native conversion deadline', async () => {
    jest.useFakeTimers();
    try {
      expect(HOST_RESPONSE_TIMEOUT_MS).toBeGreaterThan(NATIVE_CONVERSION_DEADLINE_MS);
      const pending = waitForHostResponse(
        () => new Promise((resolve) => {
          setTimeout(() => resolve('{"ok":false,"error":{"code":"resource_limit"}}'),
            NATIVE_CONVERSION_DEADLINE_MS);
        }),
        HOST_RESPONSE_TIMEOUT_MS,
      );
      await jest.advanceTimersByTimeAsync(NATIVE_CONVERSION_DEADLINE_MS);
      await expect(pending).resolves.toContain('resource_limit');
    } finally {
      jest.useRealTimers();
    }
  });

  it('sends the Rust host runner a schema-valid prepare request without a fake file identity', async () => {
    const operations = [];
    const runner = {
      request: jest.fn(async (operation) => {
        operations.push(operation);
        if (operation.op === 'prepare') {
          return { ok: true, data: { handle: 'host-handle' }, metrics: { peakRssBytes: 4096 } };
        }
        if (operation.op === 'select') {
          return {
            ok: true,
            data: { chunks: [{ text: 'Fixture Book ORCHID-742 ZEBRA-END-991' }] },
            metrics: { peakRssBytes: 8192 },
          };
        }
        return { ok: true, data: { releasedCount: 1 }, metrics: { peakRssBytes: 8192 } };
      }),
    };
    const definition = DOCUMENT_BENCHMARK_CASES.find((entry) => entry.id === 'typical-docx');
    const result = await runHostBenchmarkIteration(runner, definition, 0, { warmup: false });
    expect(result.outcome).toBe('success');
    expect(operations[0]).toEqual(expect.objectContaining({
      op: 'prepare',
      request: expect.objectContaining({
        schemaVersion: 1,
        sourceSizeBytes: expect.any(Number),
      }),
    }));
    expect(operations[0].request).not.toHaveProperty('sourceIdentity');
  });

  it('isolates every host benchmark iteration in a fresh runner and always closes it', async () => {
    const baseDefinition = DOCUMENT_BENCHMARK_CASES.find((entry) => entry.id === 'four-sequential');
    const definition = {
      ...baseDefinition,
      warmupIterations: 1,
      iterations: 2,
    };
    const libraries = [{
      abi: 'x86_64',
      library: 'pocket-anydoc-host-bench',
      sizeBytes: 1,
      sha256: 'a'.repeat(64),
    }];
    const runners = [];
    const createRunner = jest.fn(() => {
      const runnerId = runners.length;
      const handle = `host-handle-${runnerId}`;
      const runner = {
        request: jest.fn(async (operation) => {
          if (operation.op === 'prepare') {
            return { ok: true, data: { handle }, metrics: { peakRssBytes: 4_096 + runnerId } };
          }
          expect(operation.request.handle).toBe(handle);
          if (operation.op === 'select') {
            return {
              ok: true,
              data: { chunks: [{ text: 'Fixture Book ORCHID-742 ZEBRA-END-991' }] },
              metrics: { peakRssBytes: 8_192 + runnerId },
            };
          }
          return { ok: true, data: { releasedCount: 1 }, metrics: { peakRssBytes: 8_192 + runnerId } };
        }),
        close: jest.fn(async () => undefined),
      };
      runners.push(runner);
      return runner;
    });

    const report = await runHostBenchmark({
      runnerPath: 'pocket-anydoc-host-bench',
      libraries,
    }, {
      createRunner,
      benchmarkCases: [definition],
    });

    expect(report.cases).toHaveLength(1);
    expect(report.cases[0].iterations).toHaveLength(3);
    expect(createRunner).toHaveBeenCalledTimes(3);
    expect(new Set(runners.map((runner) => runner.request)).size).toBe(3);
    expect(runners.every((runner) => (
      runner.request.mock.calls.filter(([operation]) => operation.op === 'prepare').length === 4
    ))).toBe(true);
    expect(runners.every((runner) => runner.close.mock.calls.length === 1)).toBe(true);

    const failingClose = jest.fn(async () => undefined);
    await expect(runHostBenchmark({
      runnerPath: 'pocket-anydoc-host-bench',
      libraries,
    }, {
      createRunner: () => ({
        request: jest.fn(async () => { throw new Error('synthetic_iteration_failure'); }),
        close: failingClose,
      }),
      benchmarkCases: [{ ...definition, warmupIterations: 0, iterations: 1 }],
    })).rejects.toThrow('synthetic_iteration_failure');
    expect(failingClose).toHaveBeenCalledTimes(1);
  });

  it('resolves both branch and detached source revisions through bounded git argv', () => {
    const branchSha = 'a'.repeat(40);
    const detachedSha = 'b'.repeat(40);
    for (const sha of [branchSha, detachedSha]) {
      const spawnGit = jest.fn(() => ({ status: 0, stdout: `${sha}\n`, stderr: '' }));
      expect(readCurrentHeadOrNull('C:\\synthetic-public-root', { spawnSync: spawnGit })).toBe(sha);
      expect(spawnGit).toHaveBeenCalledWith(
        'git',
        ['-C', 'C:\\synthetic-public-root', 'rev-parse', '--verify', 'HEAD'],
        expect.objectContaining({ shell: false, timeout: 5_000, windowsHide: true }),
      );
    }
    expect(readCurrentHeadOrNull('C:\\private-root', {
      spawnSync: () => ({ status: 128, stdout: '', stderr: 'fatal: C:\\private-root' }),
    })).toBeNull();
  });

  it('atomically replaces the same benchmark output on repeat runs', () => {
    const artifactsRoot = path.join(__dirname, '..', '..', 'artifacts');
    fs.mkdirSync(artifactsRoot, { recursive: true });
    const outputRoot = fs.mkdtempSync(path.join(artifactsRoot, 'document-benchmark-write-'));
    const outputPath = path.join(outputRoot, 'report.json');
    try {
      writeJsonAtomic(outputPath, { schemaVersion: 1, revision: 'first' });
      writeJsonAtomic(outputPath, { schemaVersion: 1, revision: 'second' });
      expect(JSON.parse(fs.readFileSync(outputPath, 'utf8'))).toEqual({
        schemaVersion: 1,
        revision: 'second',
      });
      expect(fs.readdirSync(outputRoot)).toEqual(['report.json']);
    } finally {
      fs.rmSync(outputRoot, { force: true, recursive: true });
    }
  });
});
