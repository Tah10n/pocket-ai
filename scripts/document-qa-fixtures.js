#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const fixtureRoot = path.join(projectRoot, "modules", "pocket-anydoc", "rust", "fixtures");
const DOCUMENT_QA_PRIVACY = "synthetic-only";

const DOCUMENT_QA_SENTINELS = Object.freeze({
  "fixture-book": "Fixture Book",
  "orchid-742": "ORCHID-742",
  "zebra-end-991": "ZEBRA-END-991",
});

const DOCUMENT_QA_SUPPORTED_FILE_EXTENSIONS = Object.freeze([
  "txt", "md", "markdown", "json", "tsv",
  "doc", "docx", "docm",
  "ppt", "pps", "pot", "pptx", "pptm", "ppsx", "ppsm",
  "xls", "xlsx", "xlsm", "xlsb",
  "odt", "ods", "odp",
  "rtf", "epub", "csv", "pdf",
]);

const DOCUMENT_QA_FIXTURES = Object.freeze([
  fixture({
    id: "typical-txt",
    relativePath: "pocket-ai/multilingual.txt",
    format: "txt",
    bytes: 224,
    sha256: "c3b308bef277ef688d8df423c3956b28745b3138445446b85ac9817faf47ddc6",
    sentinelIds: ["orchid-742"],
  }),
  fixture({
    id: "typical-md",
    relativePath: "pocket-ai/multilingual.md",
    format: "md",
    bytes: 869,
    sha256: "ca727e310122337ba6430f5a14125048f4b17922b5b59b52fcb683d61828c04c",
    sentinelIds: ["orchid-742", "zebra-end-991"],
  }),
  fixture({
    id: "typical-markdown",
    relativePath: "pocket-ai/multilingual.md",
    stagedExtension: "markdown",
    format: "markdown",
    bytes: 869,
    sha256: "ca727e310122337ba6430f5a14125048f4b17922b5b59b52fcb683d61828c04c",
    sentinelIds: ["orchid-742", "zebra-end-991"],
  }),
  fixture({
    id: "typical-json",
    relativePath: "pocket-ai/multilingual.json",
    format: "json",
    bytes: 434,
    sha256: "0d3cb2d2da183cf678b2b6ec32c3810e8f9781ac5e000c5002788b72c92e1ead",
    sentinelIds: ["orchid-742"],
  }),
  fixture({
    id: "typical-tsv",
    relativePath: "pocket-ai/multilingual.tsv",
    format: "tsv",
    bytes: 359,
    sha256: "1366bbaa1c95b4a049fc181e577079fb68400a1492e87e72e3e22ee8261f1a0c",
    sentinelIds: ["orchid-742"],
  }),
  fixture({
    id: "typical-csv",
    relativePath: "pocket-ai/multilingual.csv",
    format: "csv",
    bytes: 330,
    sha256: "b382158ef9a2e64957884e59b5a599b1befcb29673601e68c4fce1d54fdf2585",
    sentinelIds: ["orchid-742"],
  }),
  fixture({
    id: "typical-doc",
    relativePath: "pocket-ai/office/multilingual.doc",
    format: "doc",
    bytes: 32_256,
    sha256: "69abab769b4d9ef4c76a1cf9577ec6030ab6fba8d6069beba300827d8b123270",
    sentinelIds: ["orchid-742", "zebra-end-991"],
  }),
  fixture({
    id: "typical-docx",
    relativePath: "pocket-ai/office/multilingual.docx",
    format: "docx",
    bytes: 20_477,
    sha256: "b2a6b080d1260ee05d76c667fa0784376bd710d10d65a5eda163cc76dcc85c67",
    sentinelIds: ["orchid-742", "zebra-end-991"],
  }),
  fixture({
    id: "typical-docm",
    relativePath: "pocket-ai/office/multilingual.docm",
    format: "docm",
    bytes: 20_478,
    sha256: "39b41dca9ad722dba8693fb5e4661043c3971a1213fa63fa8e59e84a13c14e90",
    sentinelIds: ["orchid-742", "zebra-end-991"],
  }),
  fixture({
    id: "typical-odt",
    relativePath: "pocket-ai/office/multilingual.odt",
    format: "odt",
    bytes: 10_379,
    sha256: "d0066175be40d8bee980a898b2e3807f5b83ce0a922406efb7126666f47c9911",
    sentinelIds: ["orchid-742", "zebra-end-991"],
  }),
  fixture({
    id: "typical-rtf",
    relativePath: "pocket-ai/office/multilingual.rtf",
    format: "rtf",
    bytes: 92_631,
    sha256: "cff7fc5dfc54eb2363de190b3dc55ecf451ee7ace67f6af77e1ffd685ecfbe4a",
    sentinelIds: ["orchid-742", "zebra-end-991"],
  }),
  fixture({
    id: "typical-ppt",
    relativePath: "pocket-ai/office/multilingual.ppt",
    format: "ppt",
    bytes: 287_232,
    sha256: "fcd752cb07d6ff7e80e1f0dc7ca5a2ce8acc02f7d719ca63393d7d49238cc8c8",
    sentinelIds: ["orchid-742", "zebra-end-991"],
  }),
  fixture({
    id: "typical-pot",
    relativePath: "pocket-ai/office/multilingual.ppt",
    stagedExtension: "pot",
    format: "pot",
    bytes: 287_232,
    sha256: "fcd752cb07d6ff7e80e1f0dc7ca5a2ce8acc02f7d719ca63393d7d49238cc8c8",
    sentinelIds: ["orchid-742", "zebra-end-991"],
  }),
  fixture({
    id: "typical-pps",
    relativePath: "pocket-ai/office/multilingual.ppt",
    stagedExtension: "pps",
    format: "pps",
    bytes: 287_232,
    sha256: "fcd752cb07d6ff7e80e1f0dc7ca5a2ce8acc02f7d719ca63393d7d49238cc8c8",
    sentinelIds: ["orchid-742", "zebra-end-991"],
  }),
  fixture({
    id: "typical-odp",
    relativePath: "pocket-ai/office/multilingual.odp",
    format: "odp",
    bytes: 48_711,
    sha256: "dec1b81275d291324dbeedf2713cd82f47b60040533de6f129f83970ba48dc23",
    sentinelIds: ["orchid-742", "zebra-end-991"],
  }),
  fixture({
    id: "typical-pptx",
    relativePath: "pocket-ai/office/multilingual.pptx",
    format: "pptx",
    bytes: 46_875,
    sha256: "5fa338949ee71e2594a48a953fb87aba2c3619aef23bb3f5a8b166e387d5ae82",
    sentinelIds: ["orchid-742", "zebra-end-991"],
  }),
  fixture({
    id: "typical-pptm",
    relativePath: "pocket-ai/office/multilingual.pptx",
    stagedExtension: "pptm",
    format: "pptm",
    bytes: 46_875,
    sha256: "5fa338949ee71e2594a48a953fb87aba2c3619aef23bb3f5a8b166e387d5ae82",
    sentinelIds: ["orchid-742", "zebra-end-991"],
  }),
  fixture({
    id: "typical-ppsx",
    relativePath: "pocket-ai/office/multilingual.pptx",
    stagedExtension: "ppsx",
    format: "ppsx",
    bytes: 46_875,
    sha256: "5fa338949ee71e2594a48a953fb87aba2c3619aef23bb3f5a8b166e387d5ae82",
    sentinelIds: ["orchid-742", "zebra-end-991"],
  }),
  fixture({
    id: "typical-ppsm",
    relativePath: "pocket-ai/office/multilingual.pptx",
    stagedExtension: "ppsm",
    format: "ppsm",
    bytes: 46_875,
    sha256: "5fa338949ee71e2594a48a953fb87aba2c3619aef23bb3f5a8b166e387d5ae82",
    sentinelIds: ["orchid-742", "zebra-end-991"],
  }),
  fixture({
    id: "typical-xls",
    relativePath: "pocket-ai/office/multilingual.xls",
    format: "xls",
    bytes: 27_648,
    sha256: "9a375ac5a1c45ef17375c4c46e009d1217cf7a6b3eaa9c5da0407cdbef9af24c",
    sentinelIds: ["orchid-742", "zebra-end-991"],
  }),
  fixture({
    id: "typical-xlsb",
    relativePath: "pocket-ai/office/multilingual.xlsb",
    format: "xlsb",
    bytes: 9_628,
    sha256: "1dd9a3f7651df9d0b3658a3ca29503bdec9f8c2d92ffee2213a8bfce4d5cdd8a",
    sentinelIds: ["orchid-742", "zebra-end-991"],
  }),
  fixture({
    id: "typical-xlsm",
    relativePath: "pocket-ai/office/multilingual.xlsm",
    format: "xlsm",
    bytes: 10_125,
    sha256: "4c280675f43af4a4e3e1e6e374175a73ae358a99bd2bf2f84f556dd431fb2a2d",
    sentinelIds: ["orchid-742", "zebra-end-991"],
  }),
  fixture({
    id: "typical-xlsx",
    relativePath: "pocket-ai/office/multilingual.xlsx",
    format: "xlsx",
    bytes: 10_091,
    sha256: "8b902499593655f9a486460b21f744f2c203711ea937cca19fe9d7a7a4e34dec",
    sentinelIds: ["orchid-742", "zebra-end-991"],
  }),
  fixture({
    id: "typical-ods",
    relativePath: "pocket-ai/office/multilingual.ods",
    format: "ods",
    bytes: 3_807,
    sha256: "9c7f8d1fa5b6b17e0d04b5a08bc6c884b36a3bc97def036b866a6cc19010ac08",
    sentinelIds: ["orchid-742", "zebra-end-991"],
  }),
  fixture({
    id: "typical-epub",
    relativePath: "upstream-anydoc-v0.1.7/epub/book.epub",
    format: "epub",
    bytes: 6_167,
    sha256: "292cba3ea8019684cb59cb890de6caf31bc9399d9f983b25db1506e275f83563",
    sentinelIds: ["fixture-book"],
  }),
  fixture({
    id: "typical-pdf",
    relativePath: "pocket-ai/office/multilingual.pdf",
    format: "pdf",
    bytes: 185_806,
    sha256: "254f8f5c45276ab99f737c61a0e874dfadf61974e63bfcc238690be5febb4eff",
    sentinelIds: ["orchid-742", "zebra-end-991"],
  }),
  fixture({
    id: "invalid-docx",
    relativePath: "upstream-anydoc-v0.1.7/malformed/truncated--errors.docx",
    format: "docx",
    bytes: 6_095,
    sha256: "65b78f02a11298d0b860247911e34431aedb05637749f49819a6b7a70fe1967b",
    expectedErrorCode: "corrupt_document",
  }),
  fixture({
    id: "encrypted-odt",
    relativePath: "upstream-anydoc-v0.1.7/malformed/encrypted--errors.odt",
    format: "odt",
    bytes: 658,
    sha256: "3143f94edf73d6add594bf1bf835f437c1a8f0597f62c6323fc7887e27ea5a27",
    expectedErrorCode: "encrypted_document",
  }),
  fixture({
    id: "resource-limit-epub",
    relativePath: "pocket-ai/archives/epub-repeated-itemref-64.epub",
    format: "epub",
    bytes: 1_161,
    sha256: "8278e23fcc378e9b85a4abaf9bdb64705dcb82070c967ea76316ea1604343941",
    expectedErrorCode: "resource_limit",
  }),
  fixture({
    id: "benchmark-100-slide",
    relativePath: "pocket-ai/office/benchmark-100-slide.pptx",
    format: "pptx",
    bytes: 151_871,
    sha256: "c6506eaec76482338760c0786269fe57798a1940cdae0517be7410bbf6f291b8",
    sentinelIds: ["orchid-742"],
  }),
  fixture({
    id: "benchmark-40-page",
    relativePath: "pocket-ai/office/benchmark-40-page.docx",
    format: "docx",
    bytes: 15_570,
    sha256: "16271f40086907752239d481580090448eeab11c4b3a414c8bbaf9d06f69e160",
    sentinelIds: ["orchid-742"],
  }),
  fixture({
    id: "benchmark-20-sheet",
    relativePath: "pocket-ai/office/benchmark-20-sheet.xlsx",
    format: "xlsx",
    bytes: 63_121,
    sha256: "c03d96b3f2411dd247c49b4427115533c6882dafcd8d2b7cd10e75e477363cd9",
    sentinelIds: ["orchid-742"],
  }),
  fixture({
    id: "malicious-zipbomb-docx",
    relativePath: "upstream-anydoc-v0.1.7/abuse/zipbomb--errors.docx",
    format: "docx",
    bytes: 196_603,
    sha256: "132715bbfe9f82b5a5e4e9ea21375dbd32d00300fc127facb73c2214dd2512c2",
    expectedErrorCode: "resource_limit",
  }),
  fixture({
    id: "malicious-deepxml-docx",
    relativePath: "upstream-anydoc-v0.1.7/abuse/deepxml--errors.docx",
    format: "docx",
    bytes: 1_257,
    sha256: "86650b49a31fc5b7c684b15d75af996fabe38c915524b8670f1cc42355af1b73",
    expectedErrorCode: "resource_limit",
  }),
]);

const DOCUMENT_QA_SCENARIOS = Object.freeze([
  scenario("document-direct-text-flow", "success", [
    "typical-txt",
    "typical-md",
    "typical-json",
    "typical-tsv",
  ]),
  scenario("document-markdown-alias-send", "success", ["typical-markdown"]),
  scenario("document-csv-send", "success", ["typical-csv"]),
  scenario("document-word-family-flow", "success", [
    "typical-doc",
    "typical-docm",
    "typical-odt",
    "typical-rtf",
  ]),
  scenario("document-docx-send", "success", ["typical-docx"]),
  scenario("document-session-follow-up", "session-follow-up", ["typical-docx"]),
  scenario("document-legacy-presentation-flow", "success", [
    "typical-ppt",
    "typical-pot",
    "typical-pps",
    "typical-odp",
  ]),
  scenario("document-ooxml-presentation-flow", "success", [
    "typical-pptx",
    "typical-pptm",
    "typical-ppsx",
    "typical-ppsm",
  ]),
  scenario("document-pptx-send", "success", ["typical-pptx"]),
  scenario("document-spreadsheet-family-flow", "success", [
    "typical-xls",
    "typical-xlsb",
    "typical-xlsm",
    "typical-ods",
  ]),
  scenario("document-xlsx-send", "success", ["typical-xlsx"]),
  scenario("document-epub-send", "success", ["typical-epub"]),
  scenario("document-pdf-send", "success", ["typical-pdf"]),
  scenario("document-invalid-error", "error", ["invalid-docx"]),
  scenario("document-encrypted-error", "error", ["encrypted-odt"]),
  scenario("document-resource-limit-error", "error", ["resource-limit-epub"]),
  scenario("document-stop-during-parse", "stop-race", [
    "benchmark-100-slide",
    "benchmark-40-page",
    "benchmark-20-sheet",
    "typical-pdf",
  ]),
  scenario("document-thread-switch-race", "thread-race", [
    "benchmark-100-slide",
    "benchmark-40-page",
    "benchmark-20-sheet",
    "typical-pdf",
  ]),
  scenario("document-model-switch-race", "model-race", [
    "benchmark-100-slide",
    "benchmark-40-page",
    "benchmark-20-sheet",
    "typical-pdf",
  ]),
  scenario("document-four-flow", "success", [
    "typical-docx",
    "typical-pptx",
    "typical-xlsx",
    "typical-epub",
  ]),
]);

const DOCUMENT_BENCHMARK_CASES = Object.freeze([
  benchmark("typical-docx", ["typical-docx"], "typical"),
  benchmark("typical-pptx", ["typical-pptx"], "typical"),
  benchmark("typical-xlsx", ["typical-xlsx"], "typical"),
  benchmark("typical-epub", ["typical-epub"], "typical"),
  benchmark("typical-pdf", ["typical-pdf"], "typical"),
  benchmark("presentation-100-slide", ["benchmark-100-slide"], "stress"),
  benchmark("document-40-page", ["benchmark-40-page"], "stress"),
  benchmark("workbook-20-sheet", ["benchmark-20-sheet"], "stress"),
  benchmark("four-sequential", [
    "typical-docx",
    "typical-pptx",
    "typical-xlsx",
    "typical-epub",
  ], "sequential"),
  benchmark("malicious-repeated-epub", ["resource-limit-epub"], "malicious"),
  benchmark("malicious-zipbomb-docx", ["malicious-zipbomb-docx"], "malicious"),
  benchmark("malicious-deepxml-docx", ["malicious-deepxml-docx"], "malicious"),
  benchmark("encrypted-document", ["encrypted-odt"], "malicious"),
  benchmark("invalid-document", ["invalid-docx"], "malicious"),
]);

function fixture(value) {
  return Object.freeze({
    privacy: DOCUMENT_QA_PRIVACY,
    sentinelIds: [],
    expectedErrorCode: null,
    ...value,
  });
}

function scenario(id, kind, fixtureIds) {
  return Object.freeze({ id, kind, fixtureIds: Object.freeze([...fixtureIds]) });
}

function benchmark(id, fixtureIds, workload) {
  return Object.freeze({
    id,
    fixtureIds: Object.freeze([...fixtureIds]),
    workload,
    iterations: 3,
    warmupIterations: workload === "malicious" ? 0 : 1,
  });
}

function resolveDocumentQaFixture(fixtureId) {
  const fixtureDefinition = DOCUMENT_QA_FIXTURES.find((candidate) => candidate.id === fixtureId);
  if (!fixtureDefinition) {
    throw new Error(`Unknown document QA fixture id "${fixtureId}".`);
  }
  return {
    ...fixtureDefinition,
    absolutePath: path.resolve(fixtureRoot, ...fixtureDefinition.relativePath.split("/")),
  };
}

function resolveDocumentQaStagedExtension(fixtureDefinition) {
  return fixtureDefinition.stagedExtension
    ? `.${fixtureDefinition.stagedExtension}`
    : path.extname(fixtureDefinition.relativePath).toLowerCase();
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function validateDocumentQaCorpus() {
  const errors = [];
  const fixtureIds = new Set();
  const scenarioIds = new Set();
  const benchmarkIds = new Set();
  const sentinelIds = new Set(Object.keys(DOCUMENT_QA_SENTINELS));
  const fixtureRootWithSeparator = `${path.resolve(fixtureRoot)}${path.sep}`;

  for (const definition of DOCUMENT_QA_FIXTURES) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(definition.id) || fixtureIds.has(definition.id)) {
      errors.push(`Invalid or duplicate fixture id: ${definition.id}`);
    }
    fixtureIds.add(definition.id);
    if (definition.privacy !== DOCUMENT_QA_PRIVACY) {
      errors.push(`Fixture ${definition.id} is not synthetic-only.`);
    }
    if (definition.stagedExtension && !/^[a-z0-9]+$/u.test(definition.stagedExtension)) {
      errors.push(`Fixture ${definition.id} has an invalid staged extension.`);
    }
    if (resolveDocumentQaStagedExtension(definition) !== `.${definition.format}`) {
      errors.push(`Fixture ${definition.id} format does not match its staged extension.`);
    }
    if (
      path.isAbsolute(definition.relativePath)
      || definition.relativePath.split("/").some((segment) => !segment || segment === "." || segment === "..")
    ) {
      errors.push(`Fixture ${definition.id} has an unsafe relative path.`);
      continue;
    }
    const resolved = resolveDocumentQaFixture(definition.id);
    const resolvedPath = path.resolve(resolved.absolutePath);
    if (!`${resolvedPath}${path.sep}`.startsWith(fixtureRootWithSeparator)) {
      errors.push(`Fixture ${definition.id} resolves outside the fixture root.`);
      continue;
    }
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
      errors.push(`Fixture ${definition.id} is missing.`);
      continue;
    }
    const stats = fs.statSync(resolvedPath);
    if (stats.size !== definition.bytes) {
      errors.push(`Fixture ${definition.id} byte length does not match its manifest.`);
    }
    if (sha256File(resolvedPath) !== definition.sha256) {
      errors.push(`Fixture ${definition.id} SHA-256 does not match its manifest.`);
    }
    if (definition.sentinelIds.some((id) => !sentinelIds.has(id))) {
      errors.push(`Fixture ${definition.id} references an unknown sentinel id.`);
    }
    if (definition.expectedErrorCode && definition.sentinelIds.length > 0) {
      errors.push(`Error fixture ${definition.id} must not claim prompt sentinels.`);
    }
  }

  for (const definition of DOCUMENT_QA_SCENARIOS) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(definition.id) || scenarioIds.has(definition.id)) {
      errors.push(`Invalid or duplicate document scenario id: ${definition.id}`);
    }
    scenarioIds.add(definition.id);
    if (definition.fixtureIds.length < 1 || definition.fixtureIds.length > 4) {
      errors.push(`Scenario ${definition.id} must route one to four fixtures.`);
    }
    definition.fixtureIds.forEach((id) => {
      if (!fixtureIds.has(id)) {
        errors.push(`Scenario ${definition.id} references unknown fixture ${id}.`);
      }
    });
  }

  for (const definition of DOCUMENT_BENCHMARK_CASES) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(definition.id) || benchmarkIds.has(definition.id)) {
      errors.push(`Invalid or duplicate document benchmark id: ${definition.id}`);
    }
    benchmarkIds.add(definition.id);
    if (definition.fixtureIds.length < 1 || definition.fixtureIds.length > 4) {
      errors.push(`Benchmark ${definition.id} must route one to four fixtures.`);
    }
    definition.fixtureIds.forEach((id) => {
      if (!fixtureIds.has(id)) {
        errors.push(`Benchmark ${definition.id} references unknown fixture ${id}.`);
      }
    });
    if (definition.workload === "typical") {
      definition.fixtureIds.forEach((id) => {
        const item = DOCUMENT_QA_FIXTURES.find((candidate) => candidate.id === id);
        if (item && item.bytes > 5 * 1024 * 1024) {
          errors.push(`Typical benchmark fixture ${id} exceeds 5 MiB.`);
        }
      });
    }
  }

  const requiredScenarioKinds = new Set([
    "success", "error", "session-follow-up", "stop-race", "thread-race", "model-race",
  ]);
  DOCUMENT_QA_SCENARIOS.forEach((definition) => requiredScenarioKinds.delete(definition.kind));
  if (requiredScenarioKinds.size > 0) {
    errors.push(`Document QA scenario kinds are incomplete: ${[...requiredScenarioKinds].join(", ")}.`);
  }
  const requiredWorkloads = new Set(["typical", "stress", "sequential", "malicious"]);
  DOCUMENT_BENCHMARK_CASES.forEach((definition) => requiredWorkloads.delete(definition.workload));
  if (requiredWorkloads.size > 0) {
    errors.push(`Document benchmark workloads are incomplete: ${[...requiredWorkloads].join(", ")}.`);
  }
  const successExtensions = new Set(
    DOCUMENT_QA_SCENARIOS
      .filter((definition) => definition.kind === "success")
      .flatMap((definition) => definition.fixtureIds)
      .map((fixtureId) => resolveDocumentQaStagedExtension(resolveDocumentQaFixture(fixtureId)).slice(1))
  );
  for (const extension of DOCUMENT_QA_SUPPORTED_FILE_EXTENSIONS) {
    if (!successExtensions.has(extension)) {
      errors.push(`Document QA success coverage is missing .${extension}.`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Document QA corpus verification failed:\n- ${errors.join("\n- ")}`);
  }
  return {
    fixtureCount: DOCUMENT_QA_FIXTURES.length,
    scenarioCount: DOCUMENT_QA_SCENARIOS.length,
    benchmarkCount: DOCUMENT_BENCHMARK_CASES.length,
  };
}

function main(argv) {
  if (argv.length !== 1 || argv[0] !== "--verify") {
    throw new Error("Usage: node ./scripts/document-qa-fixtures.js --verify");
  }
  const result = validateDocumentQaCorpus();
  console.log(
    `Verified ${result.fixtureCount} synthetic document fixtures, `
    + `${result.scenarioCount} Android scenarios, and ${result.benchmarkCount} benchmark cases.`
  );
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`[document-qa-fixtures] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

module.exports = {
  DOCUMENT_BENCHMARK_CASES,
  DOCUMENT_QA_FIXTURES,
  DOCUMENT_QA_PRIVACY,
  DOCUMENT_QA_SCENARIOS,
  DOCUMENT_QA_SENTINELS,
  DOCUMENT_QA_SUPPORTED_FILE_EXTENSIONS,
  fixtureRoot,
  resolveDocumentQaFixture,
  resolveDocumentQaStagedExtension,
  validateDocumentQaCorpus,
};
