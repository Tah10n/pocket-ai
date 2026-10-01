#!/usr/bin/env node

const fs = require("fs");

function selectQaPack(pullRequest) {
  // GitHub Actions contains() compares strings without regard to case.
  const labels = new Set((pullRequest.labels || []).map((label) => label.name.toLowerCase()));
  const body = (pullRequest.body || "").toLowerCase();
  const checked = (text) => body.includes(`- [x] ${text.toLowerCase()}`);

  // Keep the documented pack priority and existing checkbox semantics.
  if (labels.has("android-pack-all")) return "all";
  if (labels.has("android-pack-documents") || checked("Run Android document pack")) return "documents";
  if (labels.has("android-pack-native")) return "native";
  if (labels.has("android-pack-runtime")) return "runtime";
  if (labels.has("android-pack-dependency-ui")) return "dependency-ui";
  if (labels.has("android-pack-catalog")) return "catalog";
  if (labels.has("android-pack-extended") || labels.has("run-android-scenarios") || checked("Run Android scenarios")) return "extended";
  if (labels.has("run-android-checks") || checked("Run Android checks")) return "runtime";
  return "";
}

function evaluateQaRequest(eventName, event) {
  if (eventName !== "pull_request") return { run: false, pack: "", diagnostics: false };
  if (!event.pull_request) throw new Error("Missing pull_request payload.");

  const current = event.pull_request;
  const pack = selectQaPack(current);
  const result = { run: false, pack, diagnostics: pack !== "" };
  if (!pack) return result;

  if (["opened", "reopened", "synchronize"].includes(event.action)) {
    return { ...result, run: true };
  }
  if (event.action === "edited") {
    // Retargeting changes the tested merge revision; title/prose edits do not.
    if (event.changes?.base) return { ...result, run: true };
    if (!event.changes?.body) return result;
    const previous = { ...current, body: event.changes.body.from || "" };
    return { ...result, run: selectQaPack(previous) !== pack };
  }
  if (["labeled", "unlabeled"].includes(event.action)) {
    if (!event.label?.name) throw new Error("Missing changed label.");
    const changedLabel = event.label.name.toLowerCase();
    const labels = (current.labels || []).filter((label) => label.name.toLowerCase() !== changedLabel);
    if (event.action === "unlabeled") labels.push(event.label);
    return { ...result, run: selectQaPack({ ...current, labels }) !== pack };
  }
  return result;
}

function main(environment = process.env) {
  const event = JSON.parse(fs.readFileSync(environment.GITHUB_EVENT_PATH, "utf8"));
  const result = evaluateQaRequest(environment.GITHUB_EVENT_NAME, event);
  fs.appendFileSync(environment.GITHUB_OUTPUT,
    `run=${result.run}\npack=${result.pack}\ndiagnostics=${result.diagnostics}\n`);
  console.log(`Android QA pack=${result.pack || "none"}; requested run=${result.run}; retain diagnostics=${result.diagnostics}`);
}

if (require.main === module) main();

module.exports = { selectQaPack, evaluateQaRequest };
