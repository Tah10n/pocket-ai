"use strict";

const DEFAULT_QA_TEXT_LIMIT = 1_000_000;

function escapeRegularExpression(value) {
  return `${value}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceSensitiveRoot(value, sensitiveRoot) {
  const normalizedRoot = `${sensitiveRoot || ""}`.trim();
  if (!normalizedRoot) {
    return value;
  }
  const variants = new Set([
    normalizedRoot,
    normalizedRoot.replace(/\\/g, "/"),
    normalizedRoot.replace(/\//g, "\\"),
  ]);
  let sanitized = value;
  for (const variant of variants) {
    sanitized = sanitized.replace(
      new RegExp(escapeRegularExpression(variant), "gi"),
      "<local-path>"
    );
  }
  return sanitized;
}

function redactAssignedValue(value, names) {
  const namePattern = names.join("|");
  const assignmentPattern = new RegExp(
    `\\b(${namePattern})\\b["']?(\\s*[:=]\\s*)("[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\r\\n]*)`,
    "gi"
  );
  return value.replace(
    assignmentPattern,
    (match, name, separator, assignedValue) => {
      const normalizedAssignedValue = `${assignedValue}`.trim();
      if (
        /^(?:Bearer|Basic)\s+<redacted>$/iu.test(normalizedAssignedValue)
        || normalizedAssignedValue === "<hugging-face-token>"
      ) {
        return match;
      }
      return `${name}${separator}<redacted>`;
    }
  );
}

function sanitizeAndroidQaText(value, options = {}) {
  let sanitized = `${value ?? ""}`;
  const sensitiveRoots = [
    ...(options.sensitiveRoots || []),
    process.env.USERPROFILE,
    process.env.HOME,
  ]
    .filter(Boolean)
    .sort((left, right) => `${right}`.length - `${left}`.length);
  for (const sensitiveRoot of sensitiveRoots) {
    sanitized = replaceSensitiveRoot(sanitized, sensitiveRoot);
  }

  sanitized = sanitized
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, "$1 <redacted>")
    .replace(/\bhf_[A-Za-z0-9]{8,}\b/g, "<hugging-face-token>")
    .replace(/file:\/\/[^\s"'<>]+/gi, "<local-file-uri>")
    .replace(/\/data\/user\/\d+\/[^\s"'<>]+/g, "<app-private-path>");

  sanitized = redactAssignedValue(sanitized, [
    "api[_-]?key",
    "access[_-]?token",
    "auth(?:orization)?",
    "password",
    "passwd",
    "secret",
    "token",
  ]);
  sanitized = redactAssignedValue(sanitized, [
    "system[_ -]?prompt",
    "prompt",
    "reasoning",
    "raw[_ -]?completion",
    "chat[_ -]?template",
    "message[_ -]?content",
  ]);

  sanitized = sanitized
    .replace(/\b[A-Za-z]:[\\/][^\r\n"'<>|]+/g, "<local-path>")
    .replace(/\\\\[^\r\n"'<>|]+/g, "<local-path>")
    .replace(
      /\/(?:Users|home|tmp|var|private|sdcard|mnt|storage(?:\/emulated\/\d+)?)(?:\/[^\r\n"'<>|]*)?/g,
      "<local-path>"
    );

  const maxChars = Number.isSafeInteger(options.maxChars)
    ? Math.max(0, options.maxChars)
    : DEFAULT_QA_TEXT_LIMIT;
  if (sanitized.length > maxChars) {
    const omittedCharacterCount = sanitized.length - maxChars;
    return `${sanitized.slice(0, maxChars)}\n<truncated:${omittedCharacterCount}>`;
  }
  return sanitized;
}

module.exports = {
  DEFAULT_QA_TEXT_LIMIT,
  sanitizeAndroidQaText,
};
