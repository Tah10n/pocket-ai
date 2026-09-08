const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ANDROID_REQUIRED_NATIVE_LIBRARIES_BY_ABI,
  ANDROID_UNIVERSAL_ABIS,
  inspectAndroidArtifactNativeLibraries,
} = require('../../scripts/android-build-provenance');
const { buildAndroidBenchmarkReport, validateBenchmarkReport } = require('../../scripts/document-benchmark');
const { DOCUMENT_BENCHMARK_CASES, resolveDocumentQaFixture } = require('../../scripts/document-qa-fixtures');

function createZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, bytes] of entries) {
    const nameBytes = Buffer.from(name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    local.push(header, nameBytes, bytes);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt32LE(bytes.length, 20);
    record.writeUInt32LE(bytes.length, 24);
    record.writeUInt16LE(nameBytes.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, nameBytes);
    offset += header.length + nameBytes.length + bytes.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function results() {
  return DOCUMENT_BENCHMARK_CASES.map((definition) => {
    const fixtures = definition.fixtureIds.map(resolveDocumentQaFixture);
    const errorCode = fixtures.find((fixture) => fixture.expectedErrorCode)?.expectedErrorCode;
    return {
      id: `document-benchmark-${definition.id}`,
      status: 'passed',
      details: {
        documentBenchmark: {
          caseId: definition.id,
          iterations: Array.from({ length: definition.iterations }, (_, iteration) => ({
            iteration,
            warmup: false,
            outcome: errorCode ? 'expected-error' : 'success',
            ...(errorCode ? { errorCode } : {}),
            elapsedMs: 10,
            peakRssBytes: 1024,
            uiProbeCount: 1,
            uiProbeMaxLatencyMs: 1,
            sentinelIds: [...new Set(fixtures.flatMap((fixture) => fixture.sentinelIds))],
          })),
        },
      },
    };
  });
}

describe('Android benchmark artifact reporting', () => {
  let root;
  let artifactPath;
  let scenarioReportPath;
  let provenance;

  function writeArtifact(abis = ['arm64-v8a'], extension = 'apk', omitLibrary = null) {
    artifactPath = path.join(root, `fixture.${extension}`);
    const prefix = extension === 'aab' ? 'base/lib' : 'lib';
    fs.writeFileSync(artifactPath, createZip(abis.flatMap((abi) => (
      ANDROID_REQUIRED_NATIVE_LIBRARIES_BY_ABI[abi]
        .filter((library) => library !== omitLibrary)
        .map((library) => [`${prefix}/${abi}/${library}`, Buffer.from(`${abi}:${library}`)])
    ))));
    const hash = crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');
    provenance.apkSha256 = hash;
    provenance.installedApkSha256 = hash;
  }

  function build() {
    fs.writeFileSync(scenarioReportPath, JSON.stringify({
      pack: 'document-benchmark', provenance, results: results(),
    }));
    return buildAndroidBenchmarkReport({ artifactPath, scenarioReportPath });
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-benchmark-report-'));
    scenarioReportPath = path.join(root, 'scenarios.json');
    provenance = {
      schemaVersion: 3,
      packageName: `${require('../../app.json').expo.android.package}.qa`,
      variant: 'release',
      embeddedBundle: true,
      androidQaEvidence: true,
      abi: 'arm64-v8a',
      matchedAbi: 'arm64-v8a',
      packagedAbis: ['arm64-v8a'],
      device: { abis: ['arm64-v8a', 'armeabi-v7a'] },
      source: { headSha: 'a'.repeat(40), head: 'b'.repeat(40) },
    };
    writeArtifact();
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('reports exact targeted QA library fingerprints and canonical source revision', () => {
    const report = build();
    expect(() => validateBenchmarkReport(report)).not.toThrow();
    expect(report.environment.sourceRevision).toBe('a'.repeat(40));
    expect(report.environment.artifactSha256).toBe(provenance.apkSha256);
    expect(report.environment.arch).toBe('arm64-v8a');
    expect(report.libraries).toEqual(['libpocket_anydoc.so', 'libpocket_anydoc_jni.so'].map((library) => {
      const bytes = Buffer.from(`arm64-v8a:${library}`);
      return {
        abi: 'arm64-v8a', library, sizeBytes: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      };
    }));
    expect(() => inspectAndroidArtifactNativeLibraries(artifactPath, 'apk'))
      .toThrow(/exactly the canonical Android ABI set/);
  });

  it.each(['apk', 'aab'])('keeps universal %s reporting and legacy source revision compatible', (extension) => {
    writeArtifact(ANDROID_UNIVERSAL_ABIS, extension);
    provenance = { source: { commit: 'c'.repeat(40) } };
    const report = build();
    expect(() => validateBenchmarkReport(report)).not.toThrow();
    expect(report.libraries).toHaveLength(4);
    expect(report.environment.sourceRevision).toBe('c'.repeat(40));
  });

  it.each([
    ['schemaVersion', 2], ['packageName', 'com.example.other.qa'], ['variant', 'debug'],
    ['embeddedBundle', false], ['androidQaEvidence', false], ['abi', 'armeabi-v7a'],
    ['matchedAbi', 'x86_64'], ['packagedAbis', ['arm64-v8a', 'x86_64']],
    ['packagedAbis', ['arm64-v8a', 'arm64-v8a']], ['packagedAbis', []],
    ['device', { abis: ['x86_64'] }], ['apkSha256', 'f'.repeat(64)],
    ['installedApkSha256', 'f'.repeat(64)],
  ])('rejects inconsistent targeted provenance %s', (key, value) => {
    provenance[key] = value;
    expect(build).toThrow('invalid_targeted_android_provenance');
  });

  it('rejects a replaced APK even when its native payload remains valid', () => {
    fs.appendFileSync(artifactPath, 'replacement');
    expect(build).toThrow('invalid_targeted_android_provenance');
  });

  it('rejects unexpected packaged ABIs despite self-consistent QA hashes', () => {
    writeArtifact(ANDROID_UNIVERSAL_ABIS);
    expect(build).toThrow(/exactly the target ABI/);
  });

  it('requires all runtime libraries in a targeted APK', () => {
    writeArtifact(['arm64-v8a'], 'apk', 'librnllama_jni.so');
    expect(build).toThrow(/missing required native libraries/);
  });

  it('does not treat an AAB as a targeted QA APK', () => {
    writeArtifact(['arm64-v8a'], 'aab');
    expect(build).toThrow('invalid_targeted_android_provenance');
  });

  it('does not infer targeted permission from APK contents without provenance', () => {
    provenance = {};
    expect(build).toThrow(/exactly the canonical Android ABI set/);
  });
});
