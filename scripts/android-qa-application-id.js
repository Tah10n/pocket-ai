// Pure shared identity rules: safe to import from Metro and Node consumers.
const ANDROID_QA_INSTANCE_PATTERN = "[a-z][a-z0-9]{0,31}";
const instancePattern = new RegExp(`^(?:${ANDROID_QA_INSTANCE_PATTERN})$`);

function normalizeAndroidQaInstance(value) {
  if (value == null) return null;
  if (typeof value !== "string" || value !== value.trim() || !instancePattern.test(value)) {
    throw new Error("Android QA instance must be one lowercase alphanumeric segment, starting with a letter (1-32 characters).");
  }
  return value;
}

function resolveAndroidQaApplicationId(defaultApplicationId, isolatedQaInstall = false, qaInstance = null) {
  const instance = normalizeAndroidQaInstance(qaInstance);
  if (instance !== null && !isolatedQaInstall) {
    throw new Error("Android QA instance requires an isolated QA install.");
  }
  const normalizedDefault = `${defaultApplicationId || ""}`.trim();
  if (!normalizedDefault) return null;
  return isolatedQaInstall
    ? `${normalizedDefault}${instance === null ? "" : `.${instance}`}.qa`
    : normalizedDefault;
}

function parseAndroidQaApplicationId(applicationId, defaultApplicationId) {
  if (typeof applicationId !== "string") return null;
  const base = resolveAndroidQaApplicationId(defaultApplicationId);
  if (!base) return null;
  if (applicationId === resolveAndroidQaApplicationId(base, true)) return { instance: null };
  const prefix = `${base}.`;
  if (!applicationId.startsWith(prefix) || !applicationId.endsWith(".qa")) return null;
  const instance = applicationId.slice(prefix.length, -3);
  try {
    return resolveAndroidQaApplicationId(base, true, instance) === applicationId ? { instance } : null;
  } catch {
    return null;
  }
}

module.exports = {
  ANDROID_QA_INSTANCE_PATTERN,
  normalizeAndroidQaInstance,
  resolveAndroidQaApplicationId,
  parseAndroidQaApplicationId,
};
