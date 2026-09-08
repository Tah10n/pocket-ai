#!/usr/bin/env node

function normalizeResult(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function evaluateCiGateResults({
  eventName,
  nativeScopeResult,
  nativeRequired,
  deterministicResult,
  androidNativeResult,
  iosNativeResult,
}) {
  const normalized = {
    eventName: normalizeResult(eventName),
    nativeScopeResult: normalizeResult(nativeScopeResult),
    nativeRequired: normalizeResult(nativeRequired),
    deterministicResult: normalizeResult(deterministicResult),
    androidNativeResult: normalizeResult(androidNativeResult),
    iosNativeResult: normalizeResult(iosNativeResult),
  };
  const failures = [];
  const isPullRequest = normalized.eventName === "pull_request";
  const isPush = normalized.eventName === "push";

  if (!isPullRequest && !isPush) {
    failures.push(`event=${normalized.eventName || "missing"}`);
  }

  if (normalized.deterministicResult !== "success") {
    failures.push(`deterministic=${normalized.deterministicResult || "missing"}`);
  }

  if (isPullRequest && normalized.nativeScopeResult !== "success") {
    failures.push(`native-scope=${normalized.nativeScopeResult || "missing"}`);
  }
  if (isPullRequest && !["true", "false"].includes(normalized.nativeRequired)) {
    failures.push(`native-required=${normalized.nativeRequired || "missing"}`);
  }
  if (isPush && normalized.nativeScopeResult !== "skipped") {
    failures.push(`native-scope=${normalized.nativeScopeResult || "missing"};expected=skipped`);
  }
  if (isPush && normalized.nativeRequired !== "") {
    failures.push(`native-required=${normalized.nativeRequired};expected=missing`);
  }

  const requiresNative = normalized.nativeRequired === "true";
  if (requiresNative) {
    if (!isPullRequest) {
      failures.push(`native-required-on-${normalized.eventName || "missing-event"}`);
    }
    if (normalized.androidNativeResult !== "success") {
      failures.push(`android-native=${normalized.androidNativeResult || "missing"}`);
    }
    if (normalized.iosNativeResult !== "success") {
      failures.push(`ios-native=${normalized.iosNativeResult || "missing"}`);
    }
  } else {
    if (normalized.androidNativeResult !== "skipped") {
      failures.push(`android-native=${normalized.androidNativeResult || "missing"};expected=skipped`);
    }
    if (normalized.iosNativeResult !== "skipped") {
      failures.push(`ios-native=${normalized.iosNativeResult || "missing"};expected=skipped`);
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    results: normalized,
  };
}

function readEnvironment(environment = process.env) {
  return {
    eventName: environment.CI_EVENT_NAME,
    nativeScopeResult: environment.NATIVE_SCOPE_RESULT,
    nativeRequired: environment.NATIVE_REQUIRED,
    deterministicResult: environment.DETERMINISTIC_RESULT,
    androidNativeResult: environment.ANDROID_NATIVE_RESULT,
    iosNativeResult: environment.IOS_NATIVE_RESULT,
  };
}

function main() {
  const evaluation = evaluateCiGateResults(readEnvironment());
  const summary = [
    `event=${evaluation.results.eventName || "missing"}`,
    `native-scope=${evaluation.results.nativeScopeResult || "missing"}`,
    `native-required=${evaluation.results.nativeRequired || "false"}`,
    `deterministic=${evaluation.results.deterministicResult || "missing"}`,
    `android-native=${evaluation.results.androidNativeResult || "missing"}`,
    `ios-native=${evaluation.results.iosNativeResult || "missing"}`,
  ].join(" ");

  if (!evaluation.ok) {
    console.error(`Required verify gate failed: ${evaluation.failures.join(", ")}. ${summary}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Required verify gate passed. ${summary}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  evaluateCiGateResults,
  readEnvironment,
};
