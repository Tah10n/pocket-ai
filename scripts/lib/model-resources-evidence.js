const STEP_IDS = ["cpu_load", "generate_before", "prepare_embedding", "embedding_check", "restore_chat", "generate_after",
  "offload_unused_embedding", "generate_after_offload", "confirm_context_retained"];
const FAILURE_CODES = ["timeout", "baseline_not_passed", "engine_busy", "verified_chat_missing",
  "chat_model_identity", "runtime_policy", "new_chat_blocked", "no_real_generation", "fixture_identity_conflict",
  "download_failed", "download_paused", "download_timeout", "embedding_invalid", "release_incomplete",
  "chat_changed", "settings_changed", "context_not_replaced", "operation_failed",
  "fixture_file_missing", "fixture_not_removed", "context_changed_on_offload"];
const IDENTITIES = {
  chatModelSha256: "bc64cce8e1c11e4ed870633b557e04af718249c817c4cf8a6784116144ec3e28",
  auxiliaryModelSha256: "263215c3cadd6e16740741a7624ab4cbb6c8e777688bd5331ecfbf5681c2f8ed",
  auxiliaryRevision: "544f204f2eaa2d71361ffc74d6df7170285b286a",
};
function sanitizeModelResourcesEvidence(input) {
  const numericFields = ["callbacks", "tokensPredicted", "tokensEvaluated", "outputCharacters", "dimensions"];
  const booleanFields = ["finite", "chatUnchanged", "settingsUnchanged", "contextChanged", "contextUnchanged", "fileRemoved"];
  return {
    schemaVersion: input?.schemaVersion === 1 ? 1 : null,
    status: ["idle", "running", "passed", "failed"].includes(input?.status) ? input.status : "unknown",
    phase: [...STEP_IDS, "idle", "preconditions", "complete"].includes(input?.phase) ? input.phase : "unknown",
    failureCode: FAILURE_CODES.includes(input?.failureCode) ? input.failureCode : undefined,
    requiresForceStop: typeof input?.requiresForceStop === "boolean" ? input.requiresForceStop : null,
    ...Object.fromEntries(Object.entries(IDENTITIES).map(([key, value]) => [key, input?.[key] === value ? value : null])),
    steps: Array.isArray(input?.steps) ? input.steps.map(step => ({
      id: STEP_IDS.includes(step?.id) ? step.id : "unknown",
      status: step?.status === "passed" ? "passed" : "unknown",
      ...Object.fromEntries(numericFields.filter(field => Number.isSafeInteger(step?.[field])).map(field => [field, step[field]])),
      ...Object.fromEntries(booleanFields.filter(field => typeof step?.[field] === "boolean").map(field => [field, step[field]])),
    })) : [],
  };
}
function validateModelResourcesEvidence(input) {
  const evidence = sanitizeModelResourcesEvidence(input);
  if (evidence.schemaVersion !== 1 || evidence.status !== "passed" || evidence.phase !== "complete"
    || evidence.requiresForceStop !== false || evidence.steps.length !== STEP_IDS.length
    || Object.entries(IDENTITIES).some(([key, value]) => evidence[key] !== value)) {
    throw new Error("Incomplete model resource lifecycle evidence or unverified model identities.");
  }
  evidence.steps.forEach((step, index) => {
    if (step.id !== STEP_IDS[index] || step.status !== "passed") throw new Error("Resource lifecycle sequence is incomplete.");
    if (["generate_before", "generate_after", "generate_after_offload"].includes(step.id)
      && ![step.callbacks, step.tokensPredicted, step.tokensEvaluated, step.outputCharacters]
        .every(value => Number.isSafeInteger(value) && value > 0)) throw new Error("No real chat generation evidence.");
    if (step.id === "embedding_check" && (step.dimensions !== 384 || step.finite !== true)) throw new Error("Specialized embedding evidence is missing.");
    if (step.id === "restore_chat" && (step.chatUnchanged !== true || step.settingsUnchanged !== true || step.contextChanged !== true)) {
      throw new Error("Chat restoration identity was not preserved.");
    }
    if (step.id === "offload_unused_embedding"
      && (step.chatUnchanged !== true || step.settingsUnchanged !== true || step.contextUnchanged !== true || step.fileRemoved !== true)) {
      throw new Error("Unused resource removal did not preserve the loaded chat context.");
    }
    if (step.id === "confirm_context_retained" && step.contextUnchanged !== true) {
      throw new Error("Chat context was replaced after resource removal.");
    }
  });
  return evidence;
}
async function waitForModelResourcesEvidence(readEvidence, options = {}) {
  const now = options.now || Date.now;
  const wait = options.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = now() + (options.timeoutMs ?? 900_000);
  while (now() < deadline) {
    const evidence = sanitizeModelResourcesEvidence(await readEvidence());
    if (evidence.status === "failed") throw new Error(`Model resource scenario failed: phase=${evidence.phase}, code=${evidence.failureCode || "unknown"}.`);
    if (evidence.status === "passed") return validateModelResourcesEvidence(evidence);
    await wait(1000);
  }
  throw new Error("Model resource lifecycle timed out without complete evidence.");
}
module.exports = { STEP_IDS, IDENTITIES, sanitizeModelResourcesEvidence, validateModelResourcesEvidence, waitForModelResourcesEvidence };
