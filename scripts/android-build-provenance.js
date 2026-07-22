const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { getEnvFiles, parseEnvFiles } = require("@expo/env");

const BUILD_PROVENANCE_SCHEMA_VERSION = 2;
const BASE_BUILD_INPUTS = [
  "app.json",
  "app.config.js",
  "app.config.ts",
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "patches",
  "plugins",
  "android",
];
const PREBUILD_INPUTS = [
  "app.json",
  "app.config.js",
  "app.config.ts",
  "assets",
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "patches",
  "plugins",
];
const EMBEDDED_BUNDLE_INPUTS = [
  "app",
  "src",
  "components",
  "constants",
  "assets",
  "tsconfig.json",
  "expo-env.d.ts",
  "babel.config.js",
  "metro.config.js",
  "tailwind.config.js",
  "global.css",
  "nativewind-env.d.ts",
];
const DEFAULT_ANDROID_BUILD_PLUGIN_VERSIONS = Object.freeze({
  agp: "8.11.0",
  kotlin: "2.0.21",
  ksp: "2.0.21-1.0.28",
});
const ANDROID_UNIVERSAL_ABIS = Object.freeze([
  "arm64-v8a",
  "x86_64",
]);
const ANDROID_REQUIRED_NATIVE_LIBRARIES_BY_ABI = Object.freeze({
  "arm64-v8a": Object.freeze([
    "libreactnative.so",
    "librnllama.so",
    "librnllama_jni.so",
  ]),
  x86_64: Object.freeze([
    "libreactnative.so",
    "librnllama.so",
    "librnllama_jni.so",
  ]),
});
const ANDROID_PROVENANCE_GRADLE_EXECUTION_ARGS = Object.freeze([
  "--rerun-tasks",
  "--no-build-cache",
  "--no-configuration-cache",
]);
const ANDROID_RELEASE_TASK_CONTRACTS = Object.freeze({
  "app:bundleRelease": Object.freeze({
    artifactPath: "android/app/build/outputs/bundle/release/app-release.aab",
    artifactType: "aab",
    shouldBumpVersionCode: true,
  }),
  "app:assembleRelease": Object.freeze({
    artifactPath: "android/app/build/outputs/apk/release/app-release.apk",
    artifactType: "apk",
    shouldBumpVersionCode: false,
  }),
});
const GRADLE_SYSTEM_PROJECT_PROPERTY_PREFIX = "org.gradle.project.";
const ANDROID_ROOT_GENERATED_INPUT_DIRECTORIES = new Set([
  "build",
  ".gradle",
  ".cxx",
  ".kotlin",
  ".externalNativeBuild",
]);
const ANDROID_MODULE_GENERATED_INPUT_DIRECTORIES = new Set([
  "build",
  ".cxx",
  ".kotlin",
  ".externalNativeBuild",
]);
const WINDOWS_NINJA_LEGACY_MAX_PATH_CHARS = 259;
const WINDOWS_NATIVE_BUILD_DESCENDANT_BUDGET_CHARS = 207;
const ANDROID_NATIVE_BUILD_INTERMEDIATE_NAMES = Object.freeze([
  ".cxx",
  ".externalNativeBuild",
]);

function resolveIsolatedAndroidGradleUserHome(projectRoot, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "win32") {
    return path.join(
      projectRoot,
      "node_modules",
      ".cache",
      "pocket-ai-android",
      "gradle-user-home"
    );
  }

  const windowsPath = path.win32;
  const shortCacheRoot = options.shortCacheRoot || os.tmpdir();
  if (!windowsPath.isAbsolute(shortCacheRoot)) {
    throw new Error(
      "Windows Android builds require POCKET_AI_ANDROID_SHORT_CACHE_ROOT to be an absolute writable short path."
    );
  }
  const normalizedProjectRoot = windowsPath
    .resolve(projectRoot)
    .replace(/\\/gu, "/")
    .toLowerCase();
  const projectKey = crypto
    .createHash("sha256")
    .update(normalizedProjectRoot)
    .digest("hex")
    .slice(0, 12);
  const gradleUserHome = windowsPath.join(
    windowsPath.resolve(shortCacheRoot),
    `g-${projectKey}`
  );
  if (
    gradleUserHome.length
      + 1
      + WINDOWS_NATIVE_BUILD_DESCENDANT_BUDGET_CHARS
    > WINDOWS_NINJA_LEGACY_MAX_PATH_CHARS
  ) {
    throw new Error(
      "Windows Android builds require POCKET_AI_ANDROID_SHORT_CACHE_ROOT to resolve to a writable short path."
    );
  }
  return gradleUserHome;
}

function createIsolatedAndroidBuildEnvironment(projectRoot, env = {}, overrides = {}) {
  const mergedEnvironment = {
    ...env,
    ...overrides,
  };
  return {
    ...mergedEnvironment,
    GRADLE_USER_HOME: resolveIsolatedAndroidGradleUserHome(projectRoot, {
      shortCacheRoot: mergedEnvironment.POCKET_AI_ANDROID_SHORT_CACHE_ROOT,
    }),
  };
}

function isPathInsideRoot(candidatePath, rootPath) {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath !== ""
    && relativePath !== ".."
    && !relativePath.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativePath);
}

function collectInstalledAndroidPackageRoots(nodeModulesRoot) {
  if (!fs.existsSync(nodeModulesRoot)) {
    return [];
  }
  const packageRoots = [];
  for (const entry of fs.readdirSync(nodeModulesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const entryPath = path.join(nodeModulesRoot, entry.name);
    if (!entry.name.startsWith("@")) {
      packageRoots.push(entryPath);
      continue;
    }
    for (const scopedEntry of fs.readdirSync(entryPath, { withFileTypes: true })) {
      if (scopedEntry.isDirectory()) {
        packageRoots.push(path.join(entryPath, scopedEntry.name));
      }
    }
  }
  return packageRoots;
}

function cleanAndroidNativeBuildIntermediates(projectRoot) {
  try {
    const resolvedProjectRoot = path.resolve(projectRoot);
    const realProjectRoot = fs.realpathSync(resolvedProjectRoot);
    const nodeModulesRoot = path.join(resolvedProjectRoot, "node_modules");
    const androidRoot = path.join(resolvedProjectRoot, "android");
    const projectAndroidModuleRoots = fs.existsSync(androidRoot)
      ? fs.readdirSync(androidRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => path.join(androidRoot, entry.name))
      : [];
    const ownerRoots = [
      androidRoot,
      ...projectAndroidModuleRoots,
      ...collectInstalledAndroidPackageRoots(nodeModulesRoot)
        .map((packageRoot) => path.join(packageRoot, "android")),
    ];
    let removedDirectoryCount = 0;

    for (const ownerRoot of ownerRoots) {
      for (const intermediateName of ANDROID_NATIVE_BUILD_INTERMEDIATE_NAMES) {
        const candidatePath = path.resolve(ownerRoot, intermediateName);
        const allowedRoot = isPathInsideRoot(candidatePath, nodeModulesRoot)
          ? nodeModulesRoot
          : androidRoot;
        if (!isPathInsideRoot(candidatePath, allowedRoot) || !fs.existsSync(candidatePath)) {
          continue;
        }
        const resolvedAllowedRoot = fs.realpathSync(allowedRoot);
        const resolvedCandidatePath = fs.realpathSync(candidatePath);
        if (
          !isPathInsideRoot(resolvedAllowedRoot, realProjectRoot)
          || !isPathInsideRoot(resolvedCandidatePath, resolvedAllowedRoot)
        ) {
          throw new Error("Unsafe Android native intermediate target.");
        }
        const candidateStats = fs.lstatSync(candidatePath);
        if (!candidateStats.isDirectory() || candidateStats.isSymbolicLink()) {
          throw new Error("Unsafe Android native intermediate shape.");
        }
        fs.rmSync(candidatePath, { force: true, recursive: true });
        removedDirectoryCount += 1;
      }
    }
    return removedDirectoryCount;
  } catch {
    throw new Error("Unable to reset generated Android native build intermediates safely.");
  }
}

function createAndroidShippingBuildEnvironment(projectRoot, env = {}, options = {}) {
  const shippingEnvironment = {
    ...env,
    ...(options.forceProductionNodeEnv === true ? { NODE_ENV: "production" } : {}),
    POCKET_AI_SHIPPING_BUILD: "1",
  };
  if (shippingEnvironment.NODE_ENV !== "production") {
    throw new Error(
      "Android shipping builds require NODE_ENV=production so Expo resolves production bundle inputs deterministically."
    );
  }

  const effectiveExpoEnvironment = {
    ...resolveExpoEnvironment(projectRoot, shippingEnvironment),
    ...shippingEnvironment,
  };
  if (effectiveExpoEnvironment.EXPO_PUBLIC_ANDROID_QA === "1") {
    throw new Error(
      "Android shipping builds reject EXPO_PUBLIC_ANDROID_QA=1 because QA generation controls must never be embedded in a distributable artifact."
    );
  }
  return effectiveExpoEnvironment;
}

function withAndroidProvenanceGradleExecutionArgs(args = []) {
  return [...args, ...ANDROID_PROVENANCE_GRADLE_EXECUTION_ARGS];
}

function resolveAndroidGradleWrapperInvocation(options = {}) {
  const platform = options.platform || process.platform;
  const gradleArgs = (options.gradleArgs || []).map((value) => `${value}`);
  if (platform !== "win32") {
    return {
      command: options.gradleWrapperPath || "./gradlew",
      args: gradleArgs,
    };
  }

  const unsafeArgument = gradleArgs.find((argument) => (
    !/^[a-z0-9_./:\\=,+@-]+$/iu.test(argument)
  ));
  if (unsafeArgument != null) {
    throw new Error(
      "Windows Android Gradle execution rejects arguments containing whitespace or cmd metacharacters; use repository-owned config or environment variables instead."
    );
  }
  return {
    command: options.comSpec || process.env.ComSpec || process.env.COMSPEC || "cmd.exe",
    args: ["/d", "/s", "/c", ["gradlew.bat", ...gradleArgs].join(" ")],
  };
}

function formatAndroidGradleCommandForLog(options = {}) {
  const platform = options.platform || process.platform;
  const commandLabel = platform === "win32"
    ? "gradlew.bat"
    : `${options.command || options.gradleWrapperPath || "./gradlew"}`;
  return [
    commandLabel,
    ...redactCommandArgsForLog(options.gradleArgs || []),
  ].join(" ");
}

function resolveAndroidReleaseTaskContract(task) {
  const rawTask = `${task || ""}`.trim();
  const normalizedTask = rawTask.startsWith(":app:") ? rawTask.slice(1) : rawTask;
  const contract = ANDROID_RELEASE_TASK_CONTRACTS[normalizedTask];
  if (!contract) {
    throw new Error(
      `Unsupported Android release task "${rawTask || "<missing>"}". Use app:bundleRelease, :app:bundleRelease, app:assembleRelease, or :app:assembleRelease.`
    );
  }
  return {
    ...contract,
    gradleTask: rawTask,
    module: "app",
    variant: "release",
  };
}

function resolveAndroidReleaseArtifactOutputPaths(projectRoot, taskContract, options = {}) {
  const outputsRoot = path.resolve(projectRoot, "android", "app", "build", "outputs");
  const artifactPath = path.resolve(projectRoot, taskContract?.artifactPath || "");
  if (!artifactPath.startsWith(`${outputsRoot}${path.sep}`)) {
    throw new Error("Validated Android release artifact path escaped the app outputs directory.");
  }
  let provenancePath = null;
  if (options.provenancePath) {
    const provenanceRoot = path.resolve(projectRoot, "artifacts", "android-release");
    provenancePath = path.resolve(options.provenancePath);
    if (!provenancePath.startsWith(`${provenanceRoot}${path.sep}`)) {
      throw new Error("Validated Android release provenance path escaped its artifact directory.");
    }
  }
  return { artifactPath, provenancePath };
}

function discardAndroidReleaseArtifactOutput(projectRoot, taskContract, options = {}) {
  const { artifactPath, provenancePath } = resolveAndroidReleaseArtifactOutputPaths(
    projectRoot,
    taskContract,
    options
  );
  try {
    fs.rmSync(artifactPath, { force: true });
    if (provenancePath) {
      fs.rmSync(provenancePath, { force: true });
    }
  } catch {
    throw new Error("Unable to remove the exact Android release artifact transaction outputs.");
  }
  return artifactPath;
}

function prepareAndroidReleaseArtifactOutput(projectRoot, taskContract, options = {}) {
  return discardAndroidReleaseArtifactOutput(projectRoot, taskContract, options);
}

function runAndroidReleaseArtifactTransaction(
  projectRoot,
  taskContract,
  options,
  operation
) {
  const artifactPath = prepareAndroidReleaseArtifactOutput(projectRoot, taskContract, options);
  try {
    return operation(artifactPath);
  } catch (error) {
    try {
      discardAndroidReleaseArtifactOutput(projectRoot, taskContract, options);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Android release failed and its exact unverified outputs could not be removed."
      );
    }
    throw error;
  }
}

function assertAndroidReleaseArtifactCreated(artifactPath) {
  if (!fs.existsSync(artifactPath)) {
    throw new Error(
      "The validated Android app release task completed without producing a fresh release artifact."
    );
  }
}

function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);

  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }

  return hash.digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, canonicalize(value[key])])
  );
}

function hashCanonicalJson(value) {
  return sha256Buffer(JSON.stringify(canonicalize(value)));
}

function parseBooleanBuildValue(value, defaultValue = false) {
  if (value == null || `${value}`.trim().length === 0) {
    return defaultValue;
  }
  return ["1", "true", "yes", "y"].includes(`${value}`.trim().toLowerCase());
}

function decodeJavaPropertiesEscapes(value, filePath) {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      decoded += character;
      continue;
    }
    if (index + 1 >= value.length) {
      decoded += "\\";
      continue;
    }
    const escaped = value[index + 1];
    index += 1;
    if (escaped === "t") {
      decoded += "\t";
    } else if (escaped === "n") {
      decoded += "\n";
    } else if (escaped === "r") {
      decoded += "\r";
    } else if (escaped === "f") {
      decoded += "\f";
    } else if (escaped === "u") {
      const codePoint = value.slice(index + 1, index + 5);
      if (!/^[0-9a-f]{4}$/iu.test(codePoint)) {
        throw new Error(
          `Malformed Java Properties Unicode escape in ${path.basename(filePath)}.`
        );
      }
      decoded += String.fromCharCode(Number.parseInt(codePoint, 16));
      index += 4;
    } else {
      decoded += escaped;
    }
  }
  return decoded;
}

function collectJavaPropertiesLogicalLines(contents) {
  const naturalLines = contents.replace(/^\uFEFF/u, "").split(/\r\n|\n|\r/u);
  const logicalLines = [];
  let currentLine = "";
  let continuing = false;
  for (const naturalLine of naturalLines) {
    const segment = continuing
      ? naturalLine.replace(/^[ \t\f]+/u, "")
      : naturalLine;
    currentLine += segment;
    let trailingBackslashCount = 0;
    for (
      let index = currentLine.length - 1;
      index >= 0 && currentLine[index] === "\\";
      index -= 1
    ) {
      trailingBackslashCount += 1;
    }
    if (trailingBackslashCount % 2 === 1) {
      currentLine = currentLine.slice(0, -1);
      continuing = true;
      continue;
    }
    logicalLines.push(currentLine);
    currentLine = "";
    continuing = false;
  }
  if (continuing || currentLine) {
    logicalLines.push(currentLine);
  }
  return logicalLines;
}

function parseJavaProperties(contents, filePath = "<properties>") {
  const properties = {};
  for (const line of collectJavaPropertiesLogicalLines(contents)) {
    let keyStart = 0;
    while (keyStart < line.length && /[ \t\f]/u.test(line[keyStart])) {
      keyStart += 1;
    }
    if (
      keyStart >= line.length
      || line[keyStart] === "#"
      || line[keyStart] === "!"
    ) {
      continue;
    }

    let keyEnd = keyStart;
    while (keyEnd < line.length) {
      const character = line[keyEnd];
      if (character === "\\") {
        keyEnd = Math.min(line.length, keyEnd + 2);
        continue;
      }
      if (character === "=" || character === ":" || /[ \t\f]/u.test(character)) {
        break;
      }
      keyEnd += 1;
    }

    let valueStart = keyEnd;
    if (valueStart < line.length && /[ \t\f]/u.test(line[valueStart])) {
      while (valueStart < line.length && /[ \t\f]/u.test(line[valueStart])) {
        valueStart += 1;
      }
      if (line[valueStart] === "=" || line[valueStart] === ":") {
        valueStart += 1;
      }
    } else if (line[valueStart] === "=" || line[valueStart] === ":") {
      valueStart += 1;
    }
    while (valueStart < line.length && /[ \t\f]/u.test(line[valueStart])) {
      valueStart += 1;
    }

    const key = decodeJavaPropertiesEscapes(line.slice(keyStart, keyEnd), filePath);
    const value = decodeJavaPropertiesEscapes(line.slice(valueStart), filePath);
    properties[key] = value;
  }
  return properties;
}

function parseSimplePropertiesFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  return parseJavaProperties(fs.readFileSync(filePath, "utf8"), filePath);
}

function parseGradleProjectProperties(args = []) {
  const properties = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = `${args[index]}`;
    let declaration = null;
    if (argument === "-P" || argument === "--project-prop") {
      const nextArgument = args[index + 1] == null ? "" : `${args[index + 1]}`;
      if (!nextArgument.trim() || nextArgument.trimStart().startsWith("-")) {
        throw new Error(`${argument} requires a Gradle project-property declaration.`);
      }
      declaration = nextArgument;
      index += 1;
    } else if (argument.startsWith("-P") && argument.length > 2) {
      declaration = argument.slice(2);
    } else if (argument.startsWith("--project-prop=")) {
      declaration = argument.slice("--project-prop=".length);
      if (!declaration.trim()) {
        throw new Error("--project-prop requires a Gradle project-property declaration.");
      }
    }
    if (!declaration) {
      continue;
    }
    const separatorIndex = declaration.indexOf("=");
    const key = (separatorIndex < 0 ? declaration : declaration.slice(0, separatorIndex)).trim();
    if (!key) {
      throw new Error("Gradle project-property declarations require a non-empty name.");
    }
    properties[key] = separatorIndex < 0 ? "true" : declaration.slice(separatorIndex + 1).trim();
  }
  return properties;
}

function tokenizeJvmOptions(value) {
  const input = `${value || ""}`;
  const tokens = [];
  let current = "";
  let quote = null;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quote) {
      if (character === quote) {
        quote = null;
      } else if (character === "\\" && input[index + 1] === quote) {
        current += quote;
        index += 1;
      } else {
        current += character;
      }
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function isJvmCodeLoadingOption(value) {
  const normalized = `${value || ""}`.trim().toLowerCase();
  return normalized.startsWith("-javaagent:")
    || normalized.startsWith("-agentpath:")
    || normalized.startsWith("-agentlib:")
    || normalized.startsWith("-xrun")
    || normalized.startsWith("-xbootclasspath");
}

function findJvmCodeLoadingOption(args = [], depth = 0) {
  if (depth > 4) {
    throw new Error("Gradle JVM option nesting exceeded the supported bound.");
  }
  const directOption = args.find(isJvmCodeLoadingOption);
  if (directOption) {
    return directOption;
  }
  const systemProperties = parseGradleSystemProperties(args);
  const nestedJvmArguments = systemProperties["org.gradle.jvmargs"];
  if (!nestedJvmArguments) {
    return null;
  }
  return findJvmCodeLoadingOption(tokenizeJvmOptions(nestedJvmArguments), depth + 1);
}

function parseGradleSystemProjectProperties(args = []) {
  const systemProperties = parseGradleSystemProperties(args);
  const properties = {};
  for (const [propertyName, value] of Object.entries(systemProperties)) {
    if (!propertyName.startsWith(GRADLE_SYSTEM_PROJECT_PROPERTY_PREFIX)) {
      continue;
    }
    const key = propertyName.slice(GRADLE_SYSTEM_PROJECT_PROPERTY_PREFIX.length).trim();
    if (!key) {
      throw new Error("Gradle system project-property declarations require a non-empty name.");
    }
    properties[key] = value;
  }
  return properties;
}

function parseGradleSystemProperties(args = [], depth = 0) {
  if (depth > 4) {
    throw new Error("Gradle JVM system-property nesting exceeded the supported bound.");
  }
  const properties = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = `${args[index]}`;
    let declaration = null;
    if (argument === "-D" || argument === "--system-prop") {
      const nextArgument = args[index + 1] == null ? "" : `${args[index + 1]}`;
      if (!nextArgument.trim() || nextArgument.trimStart().startsWith("-")) {
        throw new Error(`${argument} requires a Gradle system-property declaration.`);
      }
      declaration = nextArgument;
      index += 1;
    } else if (argument.startsWith("-D") && argument.length > 2) {
      declaration = argument.slice(2);
    } else if (argument.startsWith("--system-prop=")) {
      declaration = argument.slice("--system-prop=".length);
      if (!declaration.trim()) {
        throw new Error("--system-prop requires a Gradle system-property declaration.");
      }
    }
    if (!declaration) {
      continue;
    }
    const separatorIndex = declaration.indexOf("=");
    const key = (
      separatorIndex < 0 ? declaration : declaration.slice(0, separatorIndex)
    ).trim();
    if (!key) {
      throw new Error("Gradle system-property declarations require a non-empty name.");
    }
    properties[key] = separatorIndex < 0
      ? "true"
      : declaration.slice(separatorIndex + 1).trim();
  }
  if (Object.prototype.hasOwnProperty.call(properties, "org.gradle.jvmargs")) {
    if (depth === 4) {
      throw new Error("Gradle JVM system-property nesting exceeded the supported bound.");
    }
    Object.assign(
      properties,
      parseGradleSystemProperties(
        tokenizeJvmOptions(properties["org.gradle.jvmargs"]),
        depth + 1
      )
    );
  }
  return properties;
}

function parseGradleSystemProjectPropertiesFromOptionString(value) {
  return parseGradleSystemProjectProperties(tokenizeJvmOptions(value));
}

function analyzeGradlePropertiesFile(properties) {
  const systemProperties = {};
  const systemProjectProperties = {};
  for (const [key, value] of Object.entries(properties)) {
    if (key.startsWith("systemProp.")) {
      const propertyName = key.slice("systemProp.".length).trim();
      if (propertyName) {
        systemProperties[propertyName] = value;
      }
      continue;
    }
    if (key.startsWith(GRADLE_SYSTEM_PROJECT_PROPERTY_PREFIX)) {
      systemProperties[key] = value;
      continue;
    }
    if (key === "org.gradle.jvmargs") {
      systemProperties[key] = value;
    }
  }
  if (Object.prototype.hasOwnProperty.call(systemProperties, "org.gradle.jvmargs")) {
    Object.assign(
      systemProperties,
      parseGradleSystemProperties(tokenizeJvmOptions(systemProperties["org.gradle.jvmargs"]))
    );
  }
  for (const [propertyName, value] of Object.entries(systemProperties)) {
    if (!propertyName.startsWith(GRADLE_SYSTEM_PROJECT_PROPERTY_PREFIX)) {
      continue;
    }
    const projectPropertyName = propertyName
      .slice(GRADLE_SYSTEM_PROJECT_PROPERTY_PREFIX.length)
      .trim();
    if (projectPropertyName) {
      systemProjectProperties[projectPropertyName] = value;
    }
  }
  return {
    properties,
    systemProperties,
    systemProjectProperties,
  };
}

function collectGradleSystemEnvironmentProperties(env) {
  const properties = {};
  for (const environmentKey of [
    "_JAVA_OPTIONS",
    "JDK_JAVA_OPTIONS",
    "JAVA_TOOL_OPTIONS",
    "JAVA_OPTS",
    "GRADLE_OPTS",
  ]) {
    if (env[environmentKey]) {
      Object.assign(
        properties,
        parseGradleSystemProjectPropertiesFromOptionString(env[environmentKey])
      );
    }
  }
  return properties;
}

function findExternalGradleConfigurationOverride(args = [], env = {}) {
  const disallowedOptions = [
    {
      long: "--gradle-user-home",
      short: "-g",
      type: "external Gradle user-home",
    },
    {
      long: "--init-script",
      short: "-I",
      type: "external Gradle init-script",
    },
    {
      long: "--settings-file",
      short: "-c",
      type: "external Gradle build topology",
    },
    {
      long: "--build-file",
      short: "-b",
      type: "external Gradle build topology",
    },
    {
      long: "--project-dir",
      short: "-p",
      type: "external Gradle build topology",
    },
    {
      long: "--include-build",
      short: null,
      type: "external Gradle build topology",
    },
  ];
  for (const argumentValue of args) {
    const argument = `${argumentValue}`;
    if (argument.startsWith("@")) {
      return { source: "gradle-argument", type: "external Gradle argument-file" };
    }
    const excludedTaskOption = (
      argument === "-x"
      || argument.startsWith("-x=")
      || (argument.startsWith("-x") && argument.length > 2)
      || argument === "--exclude-task"
      || argument.startsWith("--exclude-task=")
    );
    const nonHermeticExecutionOption = excludedTaskOption || [
      "--",
      "-a",
      "--no-rebuild",
      "-m",
      "--dry-run",
      "-h",
      "--help",
      "-v",
      "--version",
      "--status",
      "--stop",
      "--tasks",
      "--properties",
      "--build-cache",
      "--configuration-cache",
      "--no-rerun-tasks",
    ].includes(argument);
    if (nonHermeticExecutionOption) {
      return { source: "gradle-argument", type: "non-hermetic Gradle execution" };
    }
    for (const option of disallowedOptions) {
      if (
        (option.short && argument === option.short)
        || (option.short && argument.startsWith(`${option.short}=`))
        || (
          option.short
          && argument.startsWith(option.short)
          && argument.length > option.short.length
        )
        || argument === option.long
        || argument.startsWith(`${option.long}=`)
      ) {
        return { source: "gradle-argument", type: option.type };
      }
    }
  }

  if (findJvmCodeLoadingOption(args)) {
    return { source: "gradle-argument", type: "JVM code-loading" };
  }

  const argumentSystemProperties = parseGradleSystemProperties(args);
  if (Object.prototype.hasOwnProperty.call(argumentSystemProperties, "gradle.user.home")) {
    return { source: "gradle-system-argument", type: "external Gradle user-home" };
  }
  if (
    argumentSystemProperties["org.gradle.jvmargs"]
    && tokenizeJvmOptions(argumentSystemProperties["org.gradle.jvmargs"])
      .some((argument) => argument.startsWith("@"))
  ) {
    return { source: "gradle-system-argument", type: "external JVM argument-file" };
  }

  for (const environmentKey of [
    "_JAVA_OPTIONS",
    "JDK_JAVA_OPTIONS",
    "JAVA_TOOL_OPTIONS",
    "JAVA_OPTS",
    "GRADLE_OPTS",
  ]) {
    if (!env[environmentKey]) {
      continue;
    }
    const environmentArguments = tokenizeJvmOptions(env[environmentKey]);
    if (findJvmCodeLoadingOption(environmentArguments)) {
      return {
        source: `environment:${environmentKey}`,
        type: "JVM code-loading",
      };
    }
    if (environmentArguments.some((argument) => argument.startsWith("@"))) {
      return {
        source: `environment:${environmentKey}`,
        type: "external JVM argument-file",
      };
    }
    const properties = parseGradleSystemProperties(environmentArguments);
    if (Object.prototype.hasOwnProperty.call(properties, "gradle.user.home")) {
      return {
        source: `environment:${environmentKey}`,
        type: "external Gradle user-home",
      };
    }
    if (
      properties["org.gradle.jvmargs"]
      && tokenizeJvmOptions(properties["org.gradle.jvmargs"])
        .some((argument) => argument.startsWith("@"))
    ) {
      return {
        source: `environment:${environmentKey}`,
        type: "external JVM argument-file",
      };
    }
  }
  return null;
}

function findGradlePropertyFileExternalConfigurationOverride(projectRoot, env, options = {}) {
  const { propertySources } = readGradlePropertySources(projectRoot, env, options);
  for (const propertySource of propertySources) {
    if (
      Object.prototype.hasOwnProperty.call(propertySource.systemProperties, "gradle.user.home")
      || Object.prototype.hasOwnProperty.call(propertySource.properties, "gradle.user.home")
    ) {
      return { source: propertySource.source, type: "external Gradle user-home" };
    }
    const jvmArguments = tokenizeJvmOptions(
      propertySource.systemProperties["org.gradle.jvmargs"]
        || propertySource.properties["org.gradle.jvmargs"]
    );
    if (findJvmCodeLoadingOption(jvmArguments)) {
      return { source: propertySource.source, type: "JVM code-loading" };
    }
    if (jvmArguments.some((argument) => argument.startsWith("@"))) {
      return { source: propertySource.source, type: "external JVM argument-file" };
    }
  }
  return null;
}

function hasGradleUserInitScripts(env, options = {}) {
  const userGradleHome = path.dirname(resolveUserGradlePropertiesPath(env, options));
  for (const fileName of ["init.gradle", "init.gradle.kts"]) {
    if (fs.existsSync(path.join(userGradleHome, fileName))) {
      return true;
    }
  }
  const initDirectory = path.join(userGradleHome, "init.d");
  if (!fs.existsSync(initDirectory)) {
    return false;
  }
  try {
    return fs.readdirSync(initDirectory, { withFileTypes: true }).some((entry) => (
      (entry.isFile() || entry.isSymbolicLink())
      && (entry.name.endsWith(".gradle") || entry.name.endsWith(".gradle.kts"))
    ));
  } catch {
    throw new Error(
      "Unable to verify that the Gradle user home is free of external init scripts."
    );
  }
}

function findGradleProjectPropertyOverride(projectRoot, propertyNameOrMatcher, options = {}) {
  const env = options.env || process.env;
  const matches = typeof propertyNameOrMatcher === "function"
    ? propertyNameOrMatcher
    : (propertyName) => propertyName === propertyNameOrMatcher;
  const argumentProperties = parseGradleProjectProperties(options.gradleArgs || []);
  const argumentPropertyName = Object.keys(argumentProperties).find(matches);
  if (argumentPropertyName) {
    return { propertyName: argumentPropertyName, source: "gradle-argument" };
  }

  const systemArgumentProperties = parseGradleSystemProjectProperties(options.gradleArgs || []);
  const systemArgumentPropertyName = Object.keys(systemArgumentProperties).find(matches);
  if (systemArgumentPropertyName) {
    return { propertyName: systemArgumentPropertyName, source: "gradle-system-argument" };
  }

  const systemEnvironmentProperties = collectGradleSystemEnvironmentProperties(env);
  const systemEnvironmentPropertyName = Object.keys(systemEnvironmentProperties).find(matches);
  if (systemEnvironmentPropertyName) {
    return {
      propertyName: systemEnvironmentPropertyName,
      source: "gradle-system-environment",
    };
  }

  const { propertySources } = readGradlePropertySources(projectRoot, env, options);
  for (const propertySource of propertySources) {
    const systemPropertyName = Object.keys(propertySource.systemProjectProperties).find(matches);
    if (systemPropertyName) {
      return {
        propertyName: systemPropertyName,
        source: `${propertySource.source}-system-property`,
      };
    }
    const includePlainProperties = propertySource.source !== "project-gradle-properties"
      || options.includeProject === true;
    const propertyName = includePlainProperties
      ? Object.keys(propertySource.properties).find(matches)
      : null;
    if (propertyName) {
      return { propertyName, source: propertySource.source };
    }
  }

  const environmentPrefix = "ORG_GRADLE_PROJECT_";
  const environmentKey = Object.keys(env).find((key) => (
    key.startsWith(environmentPrefix)
    && matches(key.slice(environmentPrefix.length))
  ));
  if (environmentKey) {
    return {
      propertyName: environmentKey.slice(environmentPrefix.length),
      source: "gradle-environment",
    };
  }
  return null;
}

function areExactStringSetsEqual(left, right) {
  const normalizedLeft = [...left].sort((first, second) => first.localeCompare(second));
  const normalizedRight = [...right].sort((first, second) => first.localeCompare(second));
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function assertAndroidBuildOverrideContract(projectRoot, options = {}) {
  const variant = `${options.variant || "debug"}`.trim().toLowerCase();
  const abi = `${options.abi || "universal"}`.trim().toLowerCase();
  const externalConfigurationOverride = findExternalGradleConfigurationOverride(
    options.gradleArgs || [],
    options.env || process.env
  );
  if (externalConfigurationOverride) {
    throw new Error(
      `Android provenance-aware builds reject ${externalConfigurationOverride.type} overrides from ${externalConfigurationOverride.source}.`
    );
  }
  const propertyFileConfigurationOverride = findGradlePropertyFileExternalConfigurationOverride(
    projectRoot,
    options.env || process.env,
    options
  );
  if (propertyFileConfigurationOverride) {
    throw new Error(
      `Android provenance-aware builds reject ${propertyFileConfigurationOverride.type} overrides from ${propertyFileConfigurationOverride.source}.`
    );
  }
  if (hasGradleUserInitScripts(options.env || process.env, options)) {
    throw new Error(
      "Android provenance-aware builds reject Gradle user-home init scripts."
    );
  }
  if (abi === "universal") {
    const architectureOverride = findGradleProjectPropertyOverride(
      projectRoot,
      "reactNativeArchitectures",
      options
    );
    if (architectureOverride) {
      throw new Error(
        `Universal Android ${variant} builds reject external reactNativeArchitectures overrides from ${architectureOverride.source}.`
      );
    }

    const projectProperties = parseSimplePropertiesFile(
      path.join(projectRoot, "android", "gradle.properties")
    );
    if (Object.prototype.hasOwnProperty.call(projectProperties, "reactNativeArchitectures")) {
      const projectAbis = `${projectProperties.reactNativeArchitectures}`
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      if (!areExactStringSetsEqual(projectAbis, ANDROID_UNIVERSAL_ABIS)) {
        throw new Error(
          "Universal Android builds require the repository-owned reactNativeArchitectures property to list exactly the canonical Android ABI set."
        );
      }
    }
  }

  const injectedBuildOverride = findGradleProjectPropertyOverride(
    projectRoot,
    (propertyName) => (
      propertyName.startsWith("android.injected.")
      || propertyName === "android.buildOnlyTargetAbi"
    ),
    {
      ...options,
      includeProject: true,
    }
  );
  if (injectedBuildOverride) {
    const overrideType = injectedBuildOverride.propertyName.startsWith(
      "android.injected.signing."
    )
      ? "injected signing"
      : "injected Android build";
    throw new Error(
      `Android ${variant} builds reject ${overrideType} overrides from ${injectedBuildOverride.source}; configure the repository-owned build contract instead.`
    );
  }
}

function readAndroidAppVersionDefaults(projectRoot) {
  const appConfigPath = path.join(projectRoot, "app.json");
  if (!fs.existsSync(appConfigPath)) {
    return { versionCode: 1, versionName: "1.0.0" };
  }
  const expo = JSON.parse(fs.readFileSync(appConfigPath, "utf8")).expo || {};
  return {
    versionCode: expo.android?.versionCode ?? 1,
    versionName: expo.version ?? "1.0.0",
  };
}

function resolveEffectiveBuildValue({
  gradleProperties,
  systemGradleProperties = {},
  gradleKey,
  env,
  envKey,
  properties,
  propertiesKey,
  propertySources = [],
  defaultValue = null,
}) {
  if (gradleProperties[gradleKey] != null && `${gradleProperties[gradleKey]}`.trim()) {
    return { source: "gradle-argument", value: `${gradleProperties[gradleKey]}`.trim() };
  }
  if (
    systemGradleProperties[gradleKey] != null
    && `${systemGradleProperties[gradleKey]}`.trim()
  ) {
    return {
      source: "gradle-system-property",
      value: `${systemGradleProperties[gradleKey]}`.trim(),
    };
  }
  for (const propertySource of propertySources) {
    const propertyValue = propertySource.properties?.[gradleKey];
    if (propertyValue != null && `${propertyValue}`.trim()) {
      return { source: propertySource.source, value: `${propertyValue}`.trim() };
    }
  }
  const gradleEnvironmentKey = `ORG_GRADLE_PROJECT_${gradleKey}`;
  if (env[gradleEnvironmentKey] != null && `${env[gradleEnvironmentKey]}`.trim()) {
    return { source: "gradle-environment", value: `${env[gradleEnvironmentKey]}`.trim() };
  }
  if (env[envKey] != null && `${env[envKey]}`.trim()) {
    return { source: "environment", value: `${env[envKey]}`.trim() };
  }
  if (properties[propertiesKey] != null && `${properties[propertiesKey]}`.trim()) {
    return { source: "keystore-properties", value: `${properties[propertiesKey]}`.trim() };
  }
  return { source: "default", value: defaultValue == null ? null : `${defaultValue}` };
}

function resolveUserGradlePropertiesPath(env, options = {}) {
  if (options.userGradlePropertiesPath) {
    return path.resolve(options.userGradlePropertiesPath);
  }
  const gradleUserHome = env.GRADLE_USER_HOME
    ? path.resolve(env.GRADLE_USER_HOME)
    : path.join(os.homedir(), ".gradle");
  return path.join(gradleUserHome, "gradle.properties");
}

function readGradlePropertySources(projectRoot, env, options = {}) {
  const userPropertiesPath = resolveUserGradlePropertiesPath(env, options);
  const projectPropertiesPath = path.join(projectRoot, "android", "gradle.properties");
  const userProperties = analyzeGradlePropertiesFile(parseSimplePropertiesFile(userPropertiesPath));
  const projectProperties = analyzeGradlePropertiesFile(
    parseSimplePropertiesFile(projectPropertiesPath)
  );
  return {
    propertySources: [
      {
        source: "user-gradle-properties",
        ...userProperties,
      },
      {
        source: "project-gradle-properties",
        ...projectProperties,
      },
    ],
    userPropertiesPath,
  };
}

function collectAndroidEffectiveBuildContext(projectRoot, options = {}) {
  const env = options.env || process.env;
  const variant = `${options.variant || "debug"}`.trim().toLowerCase();
  const gradleProperties = parseGradleProjectProperties(options.gradleArgs || []);
  const gradlePropertyState = readGradlePropertySources(projectRoot, env, options);
  const { propertySources } = gradlePropertyState;
  const systemGradleProperties = Object.assign(
    {},
    ...[...propertySources].reverse().map((source) => source.systemProjectProperties),
    collectGradleSystemEnvironmentProperties(env),
    parseGradleSystemProjectProperties(options.gradleArgs || [])
  );
  const keystorePropertiesPath = path.join(projectRoot, "keystore.properties");
  const keystoreProperties = parseSimplePropertiesFile(keystorePropertiesPath);
  const defaults = {
    ...readAndroidAppVersionDefaults(projectRoot),
    ...(options.versionDefaults || {}),
  };
  const versionCode = resolveEffectiveBuildValue({
    gradleProperties,
    systemGradleProperties,
    gradleKey: "pocketAiVersionCode",
    env,
    envKey: "POCKET_AI_VERSION_CODE",
    properties: {},
    propertiesKey: "unused",
    propertySources,
    defaultValue: defaults.versionCode,
  });
  const versionName = resolveEffectiveBuildValue({
    gradleProperties,
    systemGradleProperties,
    gradleKey: "pocketAiVersionName",
    env,
    envKey: "POCKET_AI_VERSION_NAME",
    properties: {},
    propertiesKey: "unused",
    propertySources,
    defaultValue: defaults.versionName,
  });
  const signingValues = {
    storeFile: resolveEffectiveBuildValue({
      gradleProperties,
      systemGradleProperties,
      gradleKey: "pocketAiUploadStoreFile",
      env,
      envKey: "POCKET_AI_UPLOAD_STORE_FILE",
      properties: keystoreProperties,
      propertiesKey: "storeFile",
      propertySources,
    }),
    storePassword: resolveEffectiveBuildValue({
      gradleProperties,
      systemGradleProperties,
      gradleKey: "pocketAiUploadStorePassword",
      env,
      envKey: "POCKET_AI_UPLOAD_STORE_PASSWORD",
      properties: keystoreProperties,
      propertiesKey: "storePassword",
      propertySources,
    }),
    keyAlias: resolveEffectiveBuildValue({
      gradleProperties,
      systemGradleProperties,
      gradleKey: "pocketAiUploadKeyAlias",
      env,
      envKey: "POCKET_AI_UPLOAD_KEY_ALIAS",
      properties: keystoreProperties,
      propertiesKey: "keyAlias",
      propertySources,
    }),
    keyPassword: resolveEffectiveBuildValue({
      gradleProperties,
      systemGradleProperties,
      gradleKey: "pocketAiUploadKeyPassword",
      env,
      envKey: "POCKET_AI_UPLOAD_KEY_PASSWORD",
      properties: keystoreProperties,
      propertiesKey: "keyPassword",
      propertySources,
    }),
  };
  const allowDebugSigningValue = resolveEffectiveBuildValue({
    gradleProperties,
    systemGradleProperties,
    gradleKey: "pocketAiAllowDebugReleaseSigning",
    env,
    envKey: "POCKET_AI_ALLOW_DEBUG_RELEASE_SIGNING",
    properties: {},
    propertiesKey: "unused",
    propertySources,
    defaultValue: false,
  });
  const allowDebugReleaseSigning = parseBooleanBuildValue(allowDebugSigningValue.value);
  const configuredStoreFile = signingValues.storeFile.value;
  const resolvedStoreFile = configuredStoreFile
    ? (path.isAbsolute(configuredStoreFile)
      ? configuredStoreFile
      : path.resolve(projectRoot, configuredStoreFile))
    : null;
  const storeFileExists = Boolean(resolvedStoreFile && fs.existsSync(resolvedStoreFile));
  const hasReleaseSigning = variant === "release"
    && storeFileExists
    && Object.values(signingValues).every((entry) => Boolean(entry.value));
  const publicEnvironmentKeys = Object.keys(env)
    .filter((key) => key.startsWith("EXPO_PUBLIC_"))
    .sort((left, right) => left.localeCompare(right));

  return {
    schemaVersion: 1,
    pluginVersions: {
      agp: env.POCKET_AI_ANDROID_AGP_VERSION || DEFAULT_ANDROID_BUILD_PLUGIN_VERSIONS.agp,
      kotlin: env.POCKET_AI_ANDROID_KOTLIN_VERSION || DEFAULT_ANDROID_BUILD_PLUGIN_VERSIONS.kotlin,
      ksp: env.POCKET_AI_ANDROID_KSP_VERSION || DEFAULT_ANDROID_BUILD_PLUGIN_VERSIONS.ksp,
    },
    version: {
      code: versionCode.value,
      codeSource: versionCode.source,
      name: versionName.value,
      nameSource: versionName.source,
    },
    javascript: {
      nodeEnv: env.NODE_ENV || null,
      babelEnv: env.BABEL_ENV || null,
      publicEnvironmentKeys,
    },
    externalGradleInputs: {
      userPropertiesPresent: fs.existsSync(gradlePropertyState.userPropertiesPath),
      gradleOptsPresent: Boolean(env.GRADLE_OPTS),
      javaOptionsPresent: Boolean(env._JAVA_OPTIONS),
      jdkJavaOptionsPresent: Boolean(env.JDK_JAVA_OPTIONS),
      javaOptsPresent: Boolean(env.JAVA_OPTS),
      javaToolOptionsPresent: Boolean(env.JAVA_TOOL_OPTIONS),
    },
    signing: variant === "release"
      ? {
          mode: hasReleaseSigning
            ? "upload"
            : (allowDebugReleaseSigning ? "debug-fallback" : "missing"),
          allowDebugReleaseSigning,
          allowDebugReleaseSigningSource: allowDebugSigningValue.source,
          storeFileExists,
          storeFileSha256: storeFileExists ? sha256File(resolvedStoreFile) : null,
          storeFileSource: signingValues.storeFile.source,
          storePasswordSource: signingValues.storePassword.source,
          keyAliasSource: signingValues.keyAlias.source,
          keyPasswordSource: signingValues.keyPassword.source,
        }
      : { mode: "debug" },
  };
}

function collectAndroidPrivateBuildReuseDigest(projectRoot, options = {}) {
  const env = options.env || process.env;
  const userPropertiesPath = resolveUserGradlePropertiesPath(env, options);
  const keystorePropertiesPath = path.join(projectRoot, "keystore.properties");
  const hmacKeyPath = options.hmacKeyPath || path.join(
    projectRoot,
    "node_modules",
    ".cache",
    "pocket-ai-android",
    "reuse-hmac.key"
  );
  fs.mkdirSync(path.dirname(hmacKeyPath), { recursive: true });
  if (!fs.existsSync(hmacKeyPath)) {
    fs.writeFileSync(hmacKeyPath, crypto.randomBytes(32), { mode: 0o600 });
  }
  const relevantEnvironment = Object.fromEntries(
    Object.keys(env)
      .filter((key) => (
        key.startsWith("POCKET_AI_")
        // Gradle maps every ORG_GRADLE_PROJECT_* variable to a project property.
        // Hash the complete namespace so external architecture/engine/new-arch overrides
        // cannot reuse an APK built from different effective inputs.
        || key.startsWith("ORG_GRADLE_PROJECT_")
        || key.startsWith("EXPO_")
        || key === "_JAVA_OPTIONS"
        || key === "GRADLE_OPTS"
        || key === "JDK_JAVA_OPTIONS"
        || key === "JAVA_OPTS"
        || key === "JAVA_TOOL_OPTIONS"
      ))
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, `${env[key]}`])
  );
  const environmentFileNames = fs.readdirSync(projectRoot, { withFileTypes: true })
    .filter((entry) => (
      (entry.isFile() || entry.isSymbolicLink())
      && (entry.name === ".env" || entry.name.startsWith(".env."))
    ))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const resolvedExpoEnvironment = resolveExpoEnvironment(projectRoot, env);
  const privateInputs = {
    scope: options.scope || "build",
    gradleArgs: (options.gradleArgs || []).map((value) => `${value}`),
    relevantEnvironment,
    environmentFiles: Object.fromEntries(environmentFileNames.map((relativePath) => {
      const filePath = path.join(projectRoot, relativePath);
      return [relativePath, fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null];
    })),
    resolvedExpoEnvironment,
    userGradleProperties: fs.existsSync(userPropertiesPath)
      ? fs.readFileSync(userPropertiesPath, "utf8")
      : null,
    keystoreProperties: fs.existsSync(keystorePropertiesPath)
      ? fs.readFileSync(keystorePropertiesPath, "utf8")
      : null,
  };
  return crypto
    .createHmac("sha256", fs.readFileSync(hmacKeyPath))
    .update(JSON.stringify(canonicalize(privateInputs)))
    .digest("hex");
}

function withExpoDotenvEnabled(callback) {
  const hadOverride = Object.prototype.hasOwnProperty.call(process.env, "EXPO_NO_DOTENV");
  const previousOverride = process.env.EXPO_NO_DOTENV;
  try {
    delete process.env.EXPO_NO_DOTENV;
    return callback();
  } finally {
    if (hadOverride) {
      process.env.EXPO_NO_DOTENV = previousOverride;
    } else {
      delete process.env.EXPO_NO_DOTENV;
    }
  }
}

function resolveExpoEnvironment(projectRoot, env) {
  if (parseBooleanBuildValue(env.EXPO_NO_DOTENV, false)) {
    return {};
  }

  const relativeFiles = withExpoDotenvEnabled(() => getEnvFiles({
    mode: env.NODE_ENV,
    silent: true,
  }));
  const parsed = withExpoDotenvEnabled(() => parseEnvFiles(
    relativeFiles.map((relativePath) => path.join(projectRoot, relativePath)),
    { systemEnv: env }
  ));
  return Object.fromEntries(
    Object.keys(parsed.env)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [
        key,
        env[key] == null ? `${parsed.env[key]}` : `${env[key]}`,
      ])
  );
}

function normalizePath(value) {
  return `${value}`.replace(/\\/g, "/");
}

function isExcludedAndroidBuildInput(relativePath) {
  const normalized = normalizePath(relativePath);
  if (normalized === "android/local.properties") {
    return true;
  }

  const segments = normalized.split("/");
  if (segments[0] !== "android") {
    return false;
  }
  if (
    segments.length >= 2
    && ANDROID_ROOT_GENERATED_INPUT_DIRECTORIES.has(segments[1])
  ) {
    return true;
  }

  return segments.length >= 3
    && ANDROID_MODULE_GENERATED_INPUT_DIRECTORIES.has(segments[2]);
}

function collectContentHashEntries(projectRoot, relativeInputs, options = {}) {
  const entriesByPath = new Map();
  const exclude = options.exclude || (() => false);

  const addPath = (absolutePath) => {
    const relativePath = normalizePath(path.relative(projectRoot, absolutePath));
    if (!relativePath || relativePath.startsWith("../") || exclude(relativePath)) {
      return;
    }

    const stats = fs.lstatSync(absolutePath);
    if (stats.isSymbolicLink()) {
      const target = fs.readlinkSync(absolutePath);
      entriesByPath.set(relativePath, {
        path: relativePath,
        type: "symlink",
        size: Buffer.byteLength(target),
        sha256: sha256Buffer(target),
      });
      return;
    }

    if (stats.isDirectory()) {
      const children = fs.readdirSync(absolutePath, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        addPath(path.join(absolutePath, child.name));
      }
      return;
    }

    if (!stats.isFile()) {
      return;
    }

    entriesByPath.set(relativePath, {
      path: relativePath,
      type: "file",
      size: stats.size,
      sha256: sha256File(absolutePath),
    });
  };

  for (const relativeInput of relativeInputs) {
    const absolutePath = path.resolve(projectRoot, relativeInput);
    if (fs.existsSync(absolutePath)) {
      addPath(absolutePath);
    }
  }

  return [...entriesByPath.values()]
    .sort((left, right) => left.path.localeCompare(right.path));
}

function runGit(projectRoot, args, options = {}) {
  const run = options.spawnSync || spawnSync;
  const result = run("git", args, {
    cwd: projectRoot,
    encoding: options.encoding ?? "utf8",
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8").trim()
      : `${result.stderr || ""}`.trim();
    throw new Error(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
  }

  return result.stdout;
}

function splitNullTerminated(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value || "", "utf8");
  return buffer
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function collectGitProvenance(projectRoot, options = {}) {
  const treeSha = `${runGit(projectRoot, ["rev-parse", "HEAD^{tree}"], options)}`.trim();
  const headSha = `${runGit(projectRoot, ["rev-parse", "HEAD"], options)}`.trim();
  const status = runGit(
    projectRoot,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { ...options, encoding: null }
  );
  const trackedDiff = runGit(
    projectRoot,
    ["diff", "--binary", "--no-ext-diff", "HEAD", "--"],
    { ...options, encoding: null }
  );
  const untrackedPaths = splitNullTerminated(runGit(
    projectRoot,
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { ...options, encoding: null }
  )).sort((left, right) => left.localeCompare(right));
  const untrackedEntries = untrackedPaths.map((relativePath) => {
    const absolutePath = path.resolve(projectRoot, relativePath);
    return {
      path: normalizePath(relativePath),
      sha256: fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()
        ? sha256File(absolutePath)
        : null,
    };
  });
  const statusBuffer = Buffer.isBuffer(status) ? status : Buffer.from(status || "", "utf8");
  const diffBuffer = Buffer.isBuffer(trackedDiff)
    ? trackedDiff
    : Buffer.from(trackedDiff || "", "utf8");
  const dirtyDigest = sha256Buffer(Buffer.concat([
    statusBuffer,
    Buffer.from("\0tracked-diff\0", "utf8"),
    diffBuffer,
    Buffer.from("\0untracked\0", "utf8"),
    Buffer.from(JSON.stringify(untrackedEntries), "utf8"),
  ]));

  return {
    headSha,
    treeSha,
    dirty: statusBuffer.length > 0,
    dirtyDigest,
    dirtyEntryCount: splitNullTerminated(statusBuffer).length,
  };
}

function readGradleWrapperVersion(androidRoot) {
  const wrapperPropertiesPath = path.join(
    androidRoot,
    "gradle",
    "wrapper",
    "gradle-wrapper.properties"
  );
  if (!fs.existsSync(wrapperPropertiesPath)) {
    return null;
  }

  const content = fs.readFileSync(wrapperPropertiesPath, "utf8");
  const distributionUrl = parseJavaProperties(content, wrapperPropertiesPath).distributionUrl || null;
  const versionMatch = distributionUrl?.match(
    /(?:^|[\\/])gradle-([0-9][0-9A-Za-z._-]*)-(all|bin)\.zip(?:[?#]|$)/
  );
  return {
    distributionType: versionMatch ? versionMatch[2] : null,
    version: versionMatch ? versionMatch[1] : null,
  };
}

function readJavaVersion(options = {}) {
  const run = options.spawnSync || spawnSync;
  const javaHome = options.javaHome || process.env.JAVA_HOME;
  const javaCommand = options.javaCommand || (javaHome
    ? path.join(javaHome, "bin", process.platform === "win32" ? "java.exe" : "java")
    : "java");
  const javaEnvironment = { ...(options.env || process.env) };
  const javaOptionEnvironmentKeys = new Set([
    "JAVA_TOOL_OPTIONS",
    "_JAVA_OPTIONS",
    "JDK_JAVA_OPTIONS",
  ]);
  for (const environmentKey of Object.keys(javaEnvironment)) {
    if (javaOptionEnvironmentKeys.has(environmentKey.toUpperCase())) {
      delete javaEnvironment[environmentKey];
    }
  }
  const result = run(javaCommand, ["-version"], {
    encoding: "utf8",
    env: javaEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw new Error(
      `Could not resolve the Java version for Android provenance: Java could not be started (${result.error.code || "spawn failure"})`
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `Could not resolve the Java version for Android provenance: Java exited with status ${result.status ?? "unknown"}`
    );
  }

  const versionLine = `${result.stderr || ""}\n${result.stdout || ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^(?:openjdk|java)\s+version(?:\s|$)/i.test(line));
  if (!versionLine) {
    throw new Error(
      "Could not resolve the Java version for Android provenance: Java emitted no recognizable version line"
    );
  }
  return versionLine;
}

function collectToolchainVersions(projectRoot, options = {}) {
  const androidRoot = options.androidRoot || path.join(projectRoot, "android");
  return {
    node: options.nodeVersion || process.version,
    java: options.javaVersion || readJavaVersion(options),
    gradleWrapper: options.gradleWrapper || readGradleWrapperVersion(androidRoot),
  };
}

function collectPrebuildInputState(projectRoot, options = {}) {
  const entries = collectContentHashEntries(projectRoot, PREBUILD_INPUTS);
  const context = {
    variant: options.variant || "debug",
    nodeEnv: options.nodeEnv || process.env.NODE_ENV || null,
    privateInputHmac: collectAndroidPrivateBuildReuseDigest(projectRoot, {
      ...options,
      scope: "prebuild",
    }),
  };
  return {
    schemaVersion: BUILD_PROVENANCE_SCHEMA_VERSION,
    context,
    entries,
    digest: hashCanonicalJson({ context, entries }),
  };
}

function collectAndroidNativeProjectState(projectRoot) {
  const entries = collectContentHashEntries(projectRoot, ["android"], {
    exclude: isExcludedAndroidBuildInput,
  });
  return {
    entries,
    digest: hashCanonicalJson({ entries }),
  };
}

function collectBuildProvenance(projectRoot, options = {}) {
  const variant = `${options.variant || "debug"}`.trim().toLowerCase();
  const abi = `${options.abi || "universal"}`.trim().toLowerCase();
  assertAndroidBuildOverrideContract(projectRoot, {
    ...options,
    variant,
    abi,
  });
  const includeBundleInputs = options.includeBundleInputs === true || variant === "release";
  const inputs = includeBundleInputs
    ? [...BASE_BUILD_INPUTS, ...EMBEDDED_BUNDLE_INPUTS]
    : BASE_BUILD_INPUTS;
  const entries = collectContentHashEntries(projectRoot, inputs, {
    exclude: isExcludedAndroidBuildInput,
  });
  const buildContext = {
    ...(options.buildContext || {}),
    privateInputHmac: collectAndroidPrivateBuildReuseDigest(projectRoot, options),
  };
  const manifest = {
    schemaVersion: BUILD_PROVENANCE_SCHEMA_VERSION,
    variant,
    abi,
    embeddedBundle: includeBundleInputs,
    buildContext,
    toolchains: options.toolchains || collectToolchainVersions(projectRoot, options),
    git: options.git || collectGitProvenance(projectRoot, options),
    entries,
  };

  return {
    ...manifest,
    digest: hashCanonicalJson(manifest),
  };
}

function createFileContentFingerprint(filePath, projectRoot = path.dirname(filePath)) {
  const stats = fs.statSync(filePath);
  const sha256 = sha256File(filePath);
  return {
    path: normalizePath(path.relative(projectRoot, filePath)),
    size: stats.size,
    sha256,
    fingerprint: sha256,
  };
}

function listZipEntries(zipFilePath) {
  const zipBuffer = fs.readFileSync(zipFilePath);
  const eocdSignature = 0x06054b50;
  const centralDirectoryHeaderSignature = 0x02014b50;
  const minimumEocdSize = 22;
  const maxCommentLength = 0xffff;
  if (zipBuffer.length < minimumEocdSize) {
    throw new Error(`Android artifact ${path.basename(zipFilePath)} has no ZIP central directory.`);
  }
  const searchStart = Math.max(0, zipBuffer.length - minimumEocdSize - maxCommentLength);

  let eocdOffset = -1;
  for (let offset = zipBuffer.length - minimumEocdSize; offset >= searchStart; offset -= 1) {
    if (zipBuffer.readUInt32LE(offset) === eocdSignature) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error(`Android artifact ${path.basename(zipFilePath)} has no ZIP central directory.`);
  }

  const expectedEntryCount = zipBuffer.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = zipBuffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = zipBuffer.readUInt32LE(eocdOffset + 16);
  const directoryEnd = centralDirectoryOffset + centralDirectorySize;
  if (
    centralDirectoryOffset > eocdOffset
    || directoryEnd > eocdOffset
    || directoryEnd > zipBuffer.length
  ) {
    throw new Error(`Android artifact ${path.basename(zipFilePath)} has invalid ZIP bounds.`);
  }

  const entries = [];
  let offset = centralDirectoryOffset;
  while (offset < directoryEnd) {
    if (
      offset + 46 > directoryEnd
      || zipBuffer.readUInt32LE(offset) !== centralDirectoryHeaderSignature
    ) {
      throw new Error(`Android artifact ${path.basename(zipFilePath)} has an invalid ZIP entry header.`);
    }
    const fileNameLength = zipBuffer.readUInt16LE(offset + 28);
    const extraFieldLength = zipBuffer.readUInt16LE(offset + 30);
    const fileCommentLength = zipBuffer.readUInt16LE(offset + 32);
    const fileNameOffset = offset + 46;
    const fileNameEnd = fileNameOffset + fileNameLength;
    const nextOffset = fileNameEnd + extraFieldLength + fileCommentLength;
    if (fileNameEnd > directoryEnd || nextOffset > directoryEnd) {
      throw new Error(`Android artifact ${path.basename(zipFilePath)} has an invalid ZIP entry length.`);
    }
    entries.push(zipBuffer.toString("utf8", fileNameOffset, fileNameEnd));
    offset = nextOffset;
  }
  if (offset !== directoryEnd || entries.length !== expectedEntryCount) {
    throw new Error(`Android artifact ${path.basename(zipFilePath)} has inconsistent ZIP metadata.`);
  }
  return entries;
}

function inspectAndroidArtifactNativeEntries(zipEntries, artifactType) {
  const normalizedArtifactType = `${artifactType || ""}`.trim().toLowerCase();
  if (!["apk", "aab"].includes(normalizedArtifactType)) {
    throw new Error(`Unsupported Android native artifact type: ${artifactType}.`);
  }
  const libraryPrefix = normalizedArtifactType === "aab" ? "base/lib/" : "lib/";
  const normalizedEntries = new Set(
    (zipEntries || []).map((entry) => normalizePath(entry))
  );
  const packagedAbis = [...normalizedEntries]
    .filter((entry) => entry.startsWith(libraryPrefix))
    .map((entry) => entry.slice(libraryPrefix.length).split("/")[0])
    .filter(Boolean)
    .filter((abi, index, values) => values.indexOf(abi) === index)
    .sort();
  const canonicalAbis = [...ANDROID_UNIVERSAL_ABIS].sort();
  if (!areExactStringSetsEqual(packagedAbis, canonicalAbis)) {
    throw new Error(
      `Android ${normalizedArtifactType.toUpperCase()} must package exactly the canonical Android ABI set.`
    );
  }

  const missingEntries = canonicalAbis.flatMap((abi) => (
    ANDROID_REQUIRED_NATIVE_LIBRARIES_BY_ABI[abi]
      .map((library) => `${libraryPrefix}${abi}/${library}`)
      .filter((entry) => !normalizedEntries.has(entry))
  ));
  if (missingEntries.length > 0) {
    throw new Error(
      `Android ${normalizedArtifactType.toUpperCase()} is missing required React Native or llama.rn libraries: ${missingEntries.join(", ")}.`
    );
  }
  return {
    nativeLibrariesVerified: true,
    packagedAbis,
  };
}

function inspectAndroidArtifactNativeLibraries(artifactPath, artifactType) {
  return inspectAndroidArtifactNativeEntries(listZipEntries(artifactPath), artifactType);
}

function sanitizeForFileName(value) {
  return `${value}`.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function resolveBuildStampPath(cacheRoot, variant, abi = "universal") {
  return path.join(
    cacheRoot,
    `android-build-${sanitizeForFileName(variant)}-${sanitizeForFileName(abi)}.json`
  );
}

function resolvePrebuildStampPaths(cacheRoot, variant) {
  return {
    activeStampPath: path.join(cacheRoot, "android-prebuild-active.json"),
    variantStampPath: path.join(
      cacheRoot,
      `android-prebuild-${sanitizeForFileName(variant)}.json`
    ),
  };
}

function buildAndroidCleanPrebuildArgs() {
  return ["prebuild", "--clean", "--platform", "android", "--no-install"];
}

function resolveExpoCliInvocation(projectRoot, options = {}) {
  const resolveModule = options.resolveModule || ((request) => require.resolve(request, {
    paths: [projectRoot],
  }));
  return {
    command: options.nodeExecutable || process.execPath,
    args: [resolveModule("expo/bin/cli")],
  };
}

function redactGradlePropertyDeclarationForLog(declaration, depth = 0) {
  const sensitiveName = /(?:password|passwd|token|secret|credential|private[-_.]?key|store[-_.]?file|key[-_.]?alias)/i;
  const value = `${declaration}`;
  const separatorIndex = value.indexOf("=");
  const key = separatorIndex < 0 ? value : value.slice(0, separatorIndex);
  if (sensitiveName.test(key)) {
    return separatorIndex < 0 ? "<redacted>" : `${key}=<redacted>`;
  }
  if (key.trim().toLowerCase() !== "org.gradle.jvmargs" || separatorIndex < 0) {
    return value;
  }
  if (depth >= 4) {
    return `${key}=<redacted>`;
  }
  const nestedArguments = tokenizeJvmOptions(value.slice(separatorIndex + 1));
  return `${key}=${redactCommandArgsForLog(nestedArguments, depth + 1).join(" ")}`;
}

function redactCommandArgsForLog(args, depth = 0) {
  const sensitiveName = /(?:password|passwd|token|secret|credential|private[-_.]?key|store[-_.]?file|key[-_.]?alias)/i;
  let redactNextValue = false;
  let redactNextPropertyDeclaration = false;
  return args.map((argument) => {
    const value = `${argument}`;
    if (redactNextValue) {
      redactNextValue = false;
      return "<redacted>";
    }
    if (redactNextPropertyDeclaration) {
      redactNextPropertyDeclaration = false;
      return redactGradlePropertyDeclarationForLog(value, depth);
    }

    if (["-P", "--project-prop", "-D", "--system-prop"].includes(value)) {
      redactNextPropertyDeclaration = true;
      return value;
    }

    for (const nestedPropertyPrefix of ["--project-prop=", "--system-prop="]) {
      if (value.startsWith(nestedPropertyPrefix)) {
        const declaration = value.slice(nestedPropertyPrefix.length);
        return `${nestedPropertyPrefix}${redactGradlePropertyDeclarationForLog(declaration, depth)}`;
      }
    }

    for (const attachedPropertyPrefix of ["-P", "-D"]) {
      if (value.startsWith(attachedPropertyPrefix) && value.length > attachedPropertyPrefix.length) {
        return `${attachedPropertyPrefix}${redactGradlePropertyDeclarationForLog(
          value.slice(attachedPropertyPrefix.length),
          depth
        )}`;
      }
    }

    const separatorIndex = value.indexOf("=");
    if (separatorIndex >= 0 && sensitiveName.test(value.slice(0, separatorIndex))) {
      return `${value.slice(0, separatorIndex + 1)}<redacted>`;
    }
    if (sensitiveName.test(value)) {
      redactNextValue = true;
    }
    return value;
  });
}

function shouldRunPrebuild({
  gradleWrapperExists,
  activeStamp,
  inputState,
  nativeProjectState,
  variant,
}) {
  return !(
    gradleWrapperExists
    && activeStamp
    && activeStamp.schemaVersion === BUILD_PROVENANCE_SCHEMA_VERSION
    && activeStamp.variant === variant
    && activeStamp.inputDigest === inputState?.digest
    && activeStamp.nativeInputDigest === nativeProjectState?.digest
  );
}

module.exports = {
  ANDROID_PROVENANCE_GRADLE_EXECUTION_ARGS,
  ANDROID_REQUIRED_NATIVE_LIBRARIES_BY_ABI,
  ANDROID_UNIVERSAL_ABIS,
  BASE_BUILD_INPUTS,
  BUILD_PROVENANCE_SCHEMA_VERSION,
  EMBEDDED_BUNDLE_INPUTS,
  PREBUILD_INPUTS,
  assertAndroidReleaseArtifactCreated,
  assertAndroidBuildOverrideContract,
  buildAndroidCleanPrebuildArgs,
  canonicalize,
  collectAndroidNativeProjectState,
  collectBuildProvenance,
  collectAndroidEffectiveBuildContext,
  collectAndroidPrivateBuildReuseDigest,
  collectContentHashEntries,
  collectGitProvenance,
  collectPrebuildInputState,
  collectToolchainVersions,
  cleanAndroidNativeBuildIntermediates,
  createAndroidShippingBuildEnvironment,
  createIsolatedAndroidBuildEnvironment,
  createFileContentFingerprint,
  discardAndroidReleaseArtifactOutput,
  findGradleProjectPropertyOverride,
  formatAndroidGradleCommandForLog,
  hashCanonicalJson,
  inspectAndroidArtifactNativeEntries,
  inspectAndroidArtifactNativeLibraries,
  isExcludedAndroidBuildInput,
  listZipEntries,
  normalizePath,
  parseGradleProjectProperties,
  parseGradleSystemProperties,
  parseGradleSystemProjectProperties,
  parseJavaProperties,
  prepareAndroidReleaseArtifactOutput,
  readGradleWrapperVersion,
  readJavaVersion,
  redactCommandArgsForLog,
  resolveAndroidReleaseTaskContract,
  resolveAndroidGradleWrapperInvocation,
  resolveBuildStampPath,
  resolveIsolatedAndroidGradleUserHome,
  resolvePrebuildStampPaths,
  resolveExpoCliInvocation,
  runAndroidReleaseArtifactTransaction,
  sanitizeForFileName,
  sha256Buffer,
  sha256File,
  shouldRunPrebuild,
  splitNullTerminated,
  withAndroidProvenanceGradleExecutionArgs,
};
