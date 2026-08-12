#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawn, spawnSync } = require("child_process");
const {
  inspectAndroidArtifactNativeLibraries,
} = require("./android-build-provenance");
const {
  DOCUMENT_BENCHMARK_CASES,
  DOCUMENT_QA_PRIVACY,
  DOCUMENT_QA_SENTINELS,
  resolveDocumentQaFixture,
  validateDocumentQaCorpus,
} = require("./document-qa-fixtures");

const REPORT_SCHEMA_VERSION = 1;
const HOST_PROTOCOL_SCHEMA_VERSION = 1;
const HOST_RESPONSE_MAX_CHARS = 1_000_000;
const NATIVE_CONVERSION_DEADLINE_MS = 30_000;
const HOST_RESPONSE_TIMEOUT_MS = 45_000;
const projectRoot = path.resolve(__dirname, "..");
const defaultAndroidScenarioReport = path.join(
  projectRoot,
  "artifacts",
  "android-scenarios",
  "latest-report.json"
);
const defaultAndroidArtifact = path.join(
  projectRoot,
  "android",
  "app",
  "build",
  "outputs",
  "apk",
  "release",
  "app-release.apk"
);
const defaultReportRoot = path.join(projectRoot, "artifacts", "document-benchmarks");
const defaultHostRunner = path.join(
  projectRoot,
  "modules",
  "pocket-anydoc",
  "rust",
  "target",
  "release",
  `pocket-anydoc-host-bench${process.platform === "win32" ? ".exe" : ""}`
);
const mobileLibraryPattern = /^libpocket_anydoc(?:_jni)?\.(?:so|a|dylib)$/u;
const hostArtifactPattern = /^pocket-anydoc-host-bench(?:\.exe)?$/u;
const forbiddenEvidenceKeyPattern = /(?:content|markdown|prompt|logcat|stdout|stderr|command|localuri|sourcepath|privatepath|absolutepath)/iu;

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[document-benchmark] ${safeErrorCode(error)}`);
    process.exitCode = 1;
  });
}

async function main(argv) {
  const { command, options } = parseCli(argv);
  validateDocumentQaCorpus();
  if (command === "verify") {
    const schema = readJsonFile(path.join(__dirname, "document-benchmark-report.schema.json"));
    if (schema?.properties?.schemaVersion?.const !== REPORT_SCHEMA_VERSION) {
      throw codedError("schema_version_mismatch");
    }
    const plan = buildBenchmarkPlan("host");
    assertSentinelOnlyEvidence(plan);
    console.log(`Verified document benchmark schema and ${plan.cases.length} deterministic cases.`);
    return;
  }
  if (command === "plan") {
    const target = requireTarget(options.target);
    const plan = buildBenchmarkPlan(target);
    const output = options.output
      ? resolveOutputPath(options.output)
      : path.join(defaultReportRoot, `${target}-plan.json`);
    writeJsonAtomic(output, plan);
    console.log(`Wrote ${target} document benchmark plan.`);
    return;
  }
  if (command === "report-android") {
    const scenarioReportPath = options["scenario-report"]
      ? resolveInputPath(options["scenario-report"])
      : defaultAndroidScenarioReport;
    const artifactPath = options.artifact
      ? resolveInputPath(options.artifact)
      : defaultAndroidArtifact;
    const output = options.output
      ? resolveOutputPath(options.output)
      : path.join(defaultReportRoot, "android-device-latest.json");
    const report = buildAndroidBenchmarkReport({ scenarioReportPath, artifactPath });
    validateBenchmarkReport(report);
    writeJsonAtomic(output, report);
    console.log("Wrote validated Android device document benchmark report.");
    return;
  }
  if (command === "run-host") {
    const runnerPath = requireHostRunnerPath(options.runner);
    const libraries = normalizeHostLibraries(options.library, runnerPath);
    const output = options.output
      ? resolveOutputPath(options.output)
      : path.join(defaultReportRoot, "host-latest.json");
    const report = await runHostBenchmark({ runnerPath, libraries });
    validateBenchmarkReport(report);
    writeJsonAtomic(output, report);
    console.log("Wrote validated host document benchmark report.");
    return;
  }
  if (command === "validate") {
    const reportPath = resolveInputPath(requireOption(options.report, "--report"));
    validateBenchmarkReport(readJsonFile(reportPath));
    console.log("Validated document benchmark report.");
    return;
  }
  throw codedError("unknown_command");
}

function parseCli(argv) {
  const command = argv[0];
  if (!command || !["verify", "plan", "report-android", "run-host", "validate"].includes(command)) {
    throw codedError("usage");
  }
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      throw codedError("usage");
    }
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw codedError("usage");
    }
    index += 1;
    if (key === "library") {
      options.library = [...(options.library || []), value];
    } else if (["target", "output", "scenario-report", "artifact", "runner", "report"].includes(key)) {
      if (options[key] !== undefined) {
        throw codedError("duplicate_option");
      }
      options[key] = value;
    } else {
      throw codedError("usage");
    }
  }
  return { command, options };
}

function buildBenchmarkPlan(target) {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    target: requireTarget(target),
    buildType: "release",
    privacy: DOCUMENT_QA_PRIVACY,
    runnerProtocol: target === "host"
      ? {
          schemaVersion: HOST_PROTOCOL_SCHEMA_VERSION,
          executable: "pocket-anydoc-host-bench",
          transport: "jsonl",
          operations: ["prepare", "select", "release"],
        }
      : {
          schemaVersion: HOST_PROTOCOL_SCHEMA_VERSION,
          scenarioPack: "document-benchmark",
          transport: "android-scenario-report",
        },
    cases: DOCUMENT_BENCHMARK_CASES.map((definition) => ({
      id: definition.id,
      workload: definition.workload,
      fixtureIds: [...definition.fixtureIds],
      iterations: definition.iterations,
      warmupIterations: definition.warmupIterations,
    })),
  };
}

function buildAndroidBenchmarkReport({ scenarioReportPath, artifactPath }) {
  const scenarioReport = readJsonFile(scenarioReportPath);
  if (scenarioReport.pack !== "document-benchmark") {
    throw codedError("wrong_scenario_pack");
  }
  const resultsById = new Map((scenarioReport.results || []).map((result) => [result.id, result]));
  const cases = DOCUMENT_BENCHMARK_CASES.map((definition) => {
    const scenarioId = `document-benchmark-${definition.id}`;
    const result = resultsById.get(scenarioId);
    const benchmark = result?.details?.documentBenchmark;
    if (result?.status !== "passed" || !benchmark || benchmark.caseId !== definition.id) {
      throw codedError("incomplete_android_benchmark");
    }
    return normalizeBenchmarkCase(definition, benchmark.iterations, "android-device");
  });
  const artifactType = path.extname(artifactPath).slice(1).toLowerCase();
  if (!fs.existsSync(artifactPath) || !["apk", "aab"].includes(artifactType)) {
    throw codedError("missing_release_artifact");
  }
  const nativeInspection = inspectAndroidArtifactNativeLibraries(artifactPath, artifactType);
  const artifactStats = fs.statSync(artifactPath);
  const provenance = scenarioReport.provenance || {};
  const sourceRevision = normalizeSha(provenance.source?.head ?? provenance.source?.commit ?? null);
  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    target: "android-device",
    buildType: "release",
    privacy: DOCUMENT_QA_PRIVACY,
    environment: {
      platform: "android",
      arch: normalizeSafeLabel(provenance.device?.abis?.[0] || provenance.matchedAbi || "unknown", 64),
      sourceRevision,
      artifactBytes: artifactStats.size,
      artifactSha256: sha256File(artifactPath),
      ...(provenance.device?.model
        ? { deviceModel: normalizeSafeLabel(provenance.device.model, 128) }
        : null),
      ...(Number.isSafeInteger(provenance.device?.apiLevel)
        ? { androidApi: provenance.device.apiLevel }
        : null),
      ...(provenance.versionName
        ? { appVersion: normalizeSafeLabel(provenance.versionName, 64) }
        : null),
    },
    libraries: nativeInspection.nativeLibraryFingerprints.map((entry) => ({
      abi: entry.abi,
      library: entry.library,
      sizeBytes: entry.size,
      sha256: entry.sha256,
    })),
    cases,
  };
  report.summary = buildSummary(report);
  return report;
}

async function runHostBenchmark({ runnerPath, libraries }, options = {}) {
  const createRunner = options.createRunner ?? createHostRunner;
  const benchmarkCases = options.benchmarkCases ?? DOCUMENT_BENCHMARK_CASES;
  const cases = [];
  for (const definition of benchmarkCases) {
    const iterations = [];
    const totalIterations = definition.warmupIterations + definition.iterations;
    for (let index = 0; index < totalIterations; index += 1) {
      const runner = createRunner(runnerPath);
      try {
        const iteration = await runHostBenchmarkIteration(runner, definition, index, {
          warmup: index < definition.warmupIterations,
        });
        iterations.push(iteration);
      } finally {
        await runner.close();
      }
    }
    cases.push(normalizeBenchmarkCase(definition, iterations, "host"));
  }
  const artifactBytes = libraries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    target: "host",
    buildType: "release",
    privacy: DOCUMENT_QA_PRIVACY,
    environment: {
      platform: process.platform,
      arch: process.arch,
      sourceRevision: readCurrentHeadOrNull(),
      artifactBytes,
      artifactSha256: sha256Canonical(libraries.map(({ abi, library, sha256 }) => ({ abi, library, sha256 }))),
    },
    libraries,
    cases,
  };
  report.summary = buildSummary(report);
  return report;
}

async function runHostBenchmarkIteration(runner, definition, iteration, { warmup }) {
  const startedAt = Date.now();
  let peakRssBytes = 0;
  const observedSentinels = new Set();
  let expectedErrorCode = null;
  let outcome = "success";
  for (const fixtureId of definition.fixtureIds) {
    const fixtureDefinition = resolveDocumentQaFixture(fixtureId);
    const prepareRequestId = safeRequestId(definition.id, iteration, fixtureId, "prepare");
    const prepareEnvelope = await runner.request({
      op: "prepare",
      request: {
        schemaVersion: HOST_PROTOCOL_SCHEMA_VERSION,
        requestId: prepareRequestId,
        sourcePath: fixtureDefinition.absolutePath,
        privateRoot: path.dirname(fixtureDefinition.absolutePath),
        sourceSizeBytes: fixtureDefinition.bytes,
      },
    });
    peakRssBytes = Math.max(peakRssBytes, readEnvelopeRss(prepareEnvelope));
    if (fixtureDefinition.expectedErrorCode) {
      if (prepareEnvelope.ok !== false || prepareEnvelope.error?.code !== fixtureDefinition.expectedErrorCode) {
        throw codedError("unexpected_host_error_envelope");
      }
      expectedErrorCode = fixtureDefinition.expectedErrorCode;
      outcome = "expected-error";
      continue;
    }
    if (prepareEnvelope.ok !== true || typeof prepareEnvelope.data?.handle !== "string") {
      throw codedError("invalid_host_prepare_envelope");
    }
    const handle = prepareEnvelope.data.handle;
    try {
      const selectionEnvelope = await runner.request({
        op: "select",
        request: {
          schemaVersion: HOST_PROTOCOL_SCHEMA_VERSION,
          requestId: safeRequestId(definition.id, iteration, fixtureId, "select"),
          handle,
          query: `PQA-BENCH-${definition.id}`,
          maxChunks: 16,
          maxChars: 16_000,
        },
      });
      peakRssBytes = Math.max(peakRssBytes, readEnvelopeRss(selectionEnvelope));
      if (selectionEnvelope.ok !== true) {
        throw codedError("invalid_host_select_envelope");
      }
      const selectedText = Array.isArray(selectionEnvelope.data?.chunks)
        ? selectionEnvelope.data.chunks.map((chunk) => typeof chunk?.text === "string" ? chunk.text : "").join("\n")
        : "";
      fixtureDefinition.sentinelIds.forEach((sentinelId) => {
        if (selectedText.includes(DOCUMENT_QA_SENTINELS[sentinelId])) {
          observedSentinels.add(sentinelId);
        }
      });
    } finally {
      const releaseEnvelope = await runner.request({
        op: "release",
        request: { schemaVersion: HOST_PROTOCOL_SCHEMA_VERSION, handle },
      });
      peakRssBytes = Math.max(peakRssBytes, readEnvelopeRss(releaseEnvelope));
      if (releaseEnvelope.ok !== true) {
        throw codedError("invalid_host_release_envelope");
      }
    }
  }
  return {
    iteration,
    warmup,
    outcome,
    ...(expectedErrorCode ? { errorCode: expectedErrorCode } : null),
    elapsedMs: Date.now() - startedAt,
    peakRssBytes,
    uiProbeCount: 0,
    uiProbeMaxLatencyMs: 0,
    sentinelIds: [...observedSentinels].sort(),
  };
}

function createHostRunner(runnerPath, options = {}) {
  const child = spawn(runnerPath, [], {
    cwd: projectRoot,
    env: { ...process.env, RUST_BACKTRACE: "0" },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stderr.resume();
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pendingLines = [];
  const lineWaiters = [];
  let closed = null;
  let closeResolve;
  const closePromise = new Promise((resolve) => { closeResolve = resolve; });
  lines.on("line", (line) => {
    if (line.length > HOST_RESPONSE_MAX_CHARS) {
      const waiter = lineWaiters.shift();
      waiter?.reject(codedError("host_response_too_large"));
      return;
    }
    const waiter = lineWaiters.shift();
    if (waiter) {
      waiter.resolve(line);
    } else {
      pendingLines.push(line);
    }
  });
  child.once("error", () => {
    closed = { code: null, signal: null };
    closeResolve(closed);
    while (lineWaiters.length > 0) {
      lineWaiters.shift().reject(codedError("host_runner_start_failed"));
    }
  });
  child.once("close", (code, signal) => {
    closed = { code, signal };
    closeResolve(closed);
    while (lineWaiters.length > 0) {
      lineWaiters.shift().reject(codedError("host_runner_closed"));
    }
  });

  const nextLine = () => {
    if (pendingLines.length > 0) {
      return Promise.resolve(pendingLines.shift());
    }
    if (closed) {
      return Promise.reject(codedError("host_runner_closed"));
    }
    return new Promise((resolve, reject) => lineWaiters.push({ resolve, reject }));
  };
  return {
    request: async (operation) => {
      if (closed || !child.stdin.writable) {
        throw codedError("host_runner_closed");
      }
      child.stdin.write(`${JSON.stringify(operation)}\n`);
      try {
        const line = await waitForHostResponse(
          nextLine,
          options.responseTimeoutMs ?? HOST_RESPONSE_TIMEOUT_MS
        );
        const envelope = JSON.parse(line);
        if (!envelope || typeof envelope !== "object" || typeof envelope.ok !== "boolean") {
          throw codedError("invalid_host_envelope");
        }
        return envelope;
      } catch (error) {
        if (!closed) {
          child.kill();
        }
        throw error;
      }
    },
    close: async () => {
      lines.close();
      if (!closed) {
        child.stdin.end();
        const graceful = await Promise.race([
          closePromise,
          new Promise((resolve) => setTimeout(() => resolve(null), 2_000)),
        ]);
        if (!graceful && !closed) {
          child.kill();
          await closePromise;
        }
      }
      if (closed && closed.code !== 0 && closed.signal === null) {
        throw codedError("host_runner_failed");
      }
    },
  };
}

function normalizeBenchmarkCase(definition, iterations, target) {
  const normalized = iterations.map((iteration, index) => {
    if (!iteration || typeof iteration !== "object") {
      throw codedError("invalid_benchmark_iteration");
    }
    const expectedSentinels = new Set(
      definition.fixtureIds.flatMap((fixtureId) => resolveDocumentQaFixture(fixtureId).sentinelIds)
    );
    const observedSentinels = normalizeSentinelIds(iteration.sentinelIds);
    const expectedErrorCodes = new Set(
      definition.fixtureIds
        .map((fixtureId) => resolveDocumentQaFixture(fixtureId).expectedErrorCode)
        .filter(Boolean)
    );
    const warmup = iteration.warmup === true;
    const normalizedIteration = {
      iteration: Number.isSafeInteger(iteration.iteration) ? iteration.iteration : index,
      warmup,
      outcome: iteration.outcome,
      ...(typeof iteration.errorCode === "string" ? { errorCode: iteration.errorCode } : null),
      elapsedMs: requireNonNegativeInteger(iteration.elapsedMs, "elapsed_ms_missing"),
      peakRssBytes: requirePositiveInteger(iteration.peakRssBytes, "rss_missing"),
      uiProbeCount: requireNonNegativeInteger(iteration.uiProbeCount ?? 0, "ui_probe_missing"),
      uiProbeMaxLatencyMs: requireNonNegativeInteger(iteration.uiProbeMaxLatencyMs ?? 0, "ui_probe_latency_missing"),
      sentinelIds: observedSentinels,
    };
    if (expectedErrorCodes.size > 0) {
      if (
        normalizedIteration.outcome !== "expected-error"
        || !normalizedIteration.errorCode
        || !expectedErrorCodes.has(normalizedIteration.errorCode)
      ) {
        throw codedError("expected_error_not_observed");
      }
    } else {
      if (normalizedIteration.outcome !== "success") {
        throw codedError("benchmark_success_not_observed");
      }
      if ([...expectedSentinels].some((id) => !observedSentinels.includes(id))) {
        throw codedError("sentinel_missing");
      }
    }
    if (target === "android-device" && normalizedIteration.uiProbeCount < 1) {
      throw codedError("ui_responsiveness_evidence_missing");
    }
    return normalizedIteration;
  });
  if (normalized.filter((iteration) => !iteration.warmup).length !== definition.iterations) {
    throw codedError("measured_iteration_count_mismatch");
  }
  return {
    id: definition.id,
    workload: definition.workload,
    fixtureIds: [...definition.fixtureIds],
    iterations: normalized,
  };
}

function validateBenchmarkReport(report) {
  if (
    !report || typeof report !== "object" || Array.isArray(report)
    || report.schemaVersion !== REPORT_SCHEMA_VERSION
    || !["host", "android-device"].includes(report.target)
    || report.buildType !== "release"
    || report.privacy !== DOCUMENT_QA_PRIVACY
  ) {
    throw codedError("invalid_report_header");
  }
  assertSentinelOnlyEvidence(report);
  if (!Number.isFinite(Date.parse(report.generatedAt))) {
    throw codedError("invalid_generated_at");
  }
  const environment = report.environment;
  if (
    !environment || typeof environment !== "object"
    || !normalizeSafeLabel(environment.platform, 64)
    || !normalizeSafeLabel(environment.arch, 64)
    || !Number.isSafeInteger(environment.artifactBytes) || environment.artifactBytes <= 0
    || !/^[a-f0-9]{64}$/u.test(environment.artifactSha256 || "")
    || (environment.sourceRevision !== null && !/^[a-f0-9]{40}$/u.test(environment.sourceRevision || ""))
  ) {
    throw codedError("invalid_environment");
  }
  if (!Array.isArray(report.libraries) || report.libraries.length < 1) {
    throw codedError("libraries_missing");
  }
  report.libraries.forEach((entry) => validateLibrary(entry, report.target));
  if (!Array.isArray(report.cases) || report.cases.length !== DOCUMENT_BENCHMARK_CASES.length) {
    throw codedError("benchmark_cases_incomplete");
  }
  const byId = new Map(report.cases.map((item) => [item.id, item]));
  DOCUMENT_BENCHMARK_CASES.forEach((definition) => {
    const item = byId.get(definition.id);
    if (!item || item.workload !== definition.workload || !equalArrays(item.fixtureIds, definition.fixtureIds)) {
      throw codedError("benchmark_case_mismatch");
    }
    normalizeBenchmarkCase(definition, item.iterations, report.target);
  });
  const expectedSummary = buildSummary(report);
  if (JSON.stringify(report.summary) !== JSON.stringify(expectedSummary)) {
    throw codedError("summary_mismatch");
  }
  return report;
}

function buildSummary(report) {
  const measured = report.cases.flatMap((item) => item.iterations.filter((iteration) => !iteration.warmup));
  return {
    measuredIterationCount: measured.length,
    maxElapsedMs: Math.max(...measured.map((iteration) => iteration.elapsedMs)),
    maxPeakRssBytes: Math.max(...measured.map((iteration) => iteration.peakRssBytes)),
    libraryBytes: report.libraries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
  };
}

function assertSentinelOnlyEvidence(value, keyPath = "report", seen = new Set()) {
  if (!value || typeof value !== "object") {
    return;
  }
  if (seen.has(value)) {
    throw codedError("cyclic_evidence");
  }
  seen.add(value);
  for (const [key, entry] of Object.entries(value)) {
    if (forbiddenEvidenceKeyPattern.test(key)) {
      throw codedError("forbidden_evidence_field");
    }
    if (typeof entry === "string") {
      if (entry.length > 512 || /(?:file:\/\/|content:\/\/|[A-Za-z]:[\\/]|\/Users\/|\/home\/)/u.test(entry)) {
        throw codedError("forbidden_evidence_value");
      }
    } else {
      assertSentinelOnlyEvidence(entry, `${keyPath}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function normalizeHostLibraries(values, runnerPath) {
  if (!Array.isArray(values) || values.length < 1) {
    const resolvedRunner = requireHostRunnerPath(runnerPath);
    const stats = fs.statSync(resolvedRunner);
    return [{
      abi: normalizeSafeLabel(process.arch, 64),
      library: path.basename(resolvedRunner),
      sizeBytes: stats.size,
      sha256: sha256File(resolvedRunner),
    }];
  }
  return values.map((value) => {
    const parts = String(value).split(":");
    if (parts.length < 3) {
      throw codedError("invalid_host_library");
    }
    const abi = parts.shift();
    const library = parts.shift();
    const filePath = resolveInputPath(parts.join(":"));
    if (
      !/^[A-Za-z0-9_.-]+$/u.test(abi)
      || !hostArtifactPattern.test(library)
    ) {
      throw codedError("invalid_host_library");
    }
    const stats = fs.statSync(filePath);
    return { abi, library, sizeBytes: stats.size, sha256: sha256File(filePath) };
  });
}

function validateLibrary(entry, target) {
  const artifactNamePattern = target === "host" ? hostArtifactPattern : mobileLibraryPattern;
  if (
    !entry || typeof entry !== "object"
    || !/^[A-Za-z0-9_.-]+$/u.test(entry.abi || "")
    || !artifactNamePattern.test(entry.library || "")
    || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes <= 0
    || !/^[a-f0-9]{64}$/u.test(entry.sha256 || "")
  ) {
    throw codedError("invalid_library_measurement");
  }
}

function requireHostRunnerPath(value) {
  const runnerPath = resolveInputPath(value || defaultHostRunner);
  if (!/^pocket-anydoc-host-bench(?:\.exe)?$/iu.test(path.basename(runnerPath))) {
    throw codedError("invalid_host_runner_name");
  }
  return runnerPath;
}

function requireTarget(value) {
  if (!value || !["host", "android-device"].includes(value)) {
    throw codedError("invalid_target");
  }
  return value;
}

function resolveInputPath(value) {
  const resolved = path.resolve(projectRoot, value);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw codedError("input_missing");
  }
  return resolved;
}

function resolveOutputPath(value) {
  const resolved = path.resolve(projectRoot, value);
  const artifactsRoot = path.resolve(projectRoot, "artifacts");
  const relative = path.relative(artifactsRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || path.extname(resolved) !== ".json") {
    throw codedError("unsafe_output_path");
  }
  return resolved;
}

function writeJsonAtomic(filePath, value) {
  assertSentinelOnlyEvidence(value);
  assertSafeBenchmarkOutputPath(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const backup = `${filePath}.${process.pid}.${Date.now()}.previous`;
  let movedExisting = false;
  let installedReplacement = false;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    if (fs.existsSync(filePath)) {
      fs.renameSync(filePath, backup);
      movedExisting = true;
    }
    try {
      fs.renameSync(temporary, filePath);
      installedReplacement = true;
    } catch (error) {
      if (movedExisting && !fs.existsSync(filePath) && fs.existsSync(backup)) {
        fs.renameSync(backup, filePath);
        movedExisting = false;
      }
      throw error;
    }
  } finally {
    if (fs.existsSync(temporary)) {
      fs.rmSync(temporary, { force: true });
    }
    if (installedReplacement && movedExisting && fs.existsSync(backup)) {
      fs.rmSync(backup, { force: true });
    }
  }
}

function assertSafeBenchmarkOutputPath(filePath, allowedRoot = path.join(projectRoot, "artifacts")) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(path.resolve(allowedRoot), resolved);
  if (
    !relative
    || relative.startsWith("..")
    || path.isAbsolute(relative)
    || path.extname(resolved).toLowerCase() !== ".json"
  ) {
    throw codedError("unsafe_output_path");
  }
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw codedError("invalid_json");
  }
}

function readEnvelopeRss(envelope) {
  const candidate = envelope?.metrics?.peakRssBytes ?? envelope?.metrics?.rssBytes;
  return Number.isSafeInteger(candidate) && candidate > 0 ? candidate : 0;
}

function normalizeSentinelIds(value) {
  if (!Array.isArray(value) || value.some((id) => !Object.hasOwn(DOCUMENT_QA_SENTINELS, id))) {
    throw codedError("invalid_sentinel_ids");
  }
  return [...new Set(value)].sort();
}

function normalizeSafeLabel(value, maxLength) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength && !/[\u0000\r\n]/u.test(normalized)
    ? normalized
    : null;
}

function normalizeSha(value) {
  return typeof value === "string" && /^[a-f0-9]{40}$/u.test(value) ? value : null;
}

function safeRequestId(caseId, iteration, fixtureId, operation) {
  return `${operation}-${caseId}-${iteration}-${fixtureId}`.slice(0, 96);
}

function requireOption(value, name) {
  if (!value) {
    throw codedError(`missing_${name.slice(2).replace(/-/gu, "_")}`);
  }
  return value;
}

function requireNonNegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw codedError(code);
  }
  return value;
}

function requirePositiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw codedError(code);
  }
  return value;
}

function equalArrays(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((item, index) => item === right[index]);
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function sha256Canonical(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function readCurrentHeadOrNull(sourceRoot = projectRoot, options = {}) {
  const run = options.spawnSync || spawnSync;
  let result;
  try {
    result = run("git", ["-C", sourceRoot, "rev-parse", "--verify", "HEAD"], {
      encoding: "utf8",
      maxBuffer: 4_096,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
      windowsHide: true,
    });
  } catch {
    return null;
  }
  if (result?.error || result?.status !== 0) {
    return null;
  }
  const output = `${result.stdout || ""}`.trim();
  return /^[a-f0-9]{40}$/u.test(output) ? output : null;
}

async function waitForHostResponse(nextLine, timeoutMs = HOST_RESPONSE_TIMEOUT_MS) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= NATIVE_CONVERSION_DEADLINE_MS) {
    throw codedError("invalid_host_response_timeout");
  }
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve().then(nextLine),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(codedError("host_response_timeout")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeErrorCode(error) {
  return typeof error?.code === "string" && /^[a-z0-9_]+$/u.test(error.code)
    ? error.code
    : "benchmark_failed";
}

module.exports = {
  HOST_RESPONSE_TIMEOUT_MS,
  NATIVE_CONVERSION_DEADLINE_MS,
  REPORT_SCHEMA_VERSION,
  assertSentinelOnlyEvidence,
  assertSafeBenchmarkOutputPath,
  buildAndroidBenchmarkReport,
  buildBenchmarkPlan,
  buildSummary,
  normalizeBenchmarkCase,
  normalizeHostLibraries,
  parseCli,
  readCurrentHeadOrNull,
  runHostBenchmark,
  runHostBenchmarkIteration,
  validateBenchmarkReport,
  waitForHostResponse,
  writeJsonAtomic,
};
