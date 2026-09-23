// Narrow correction for the pinned release; no dependency upgrade or core rebuild.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const VERSION = '0.13.0-rc.3';
const SOURCE = 'cpp/jsi/RNLlamaJSI.cpp';
const BEFORE_SHA256 = '2534ba08430259ba417e21483ebcea3cd0e01508cb40689ae7aed284212ea8c1';
const AFTER_SHA256 = '4f4c6254c3cefecabe19110efd18dd6d70078083a88b29adf1e73ab083a667a1';
const BEFORE = '                ctx->completion->rewind();\n';
const AFTER = `${BEFORE}                ctx->completion->generated_token_probs.clear();\n`;
const PARAMS_SOURCE = 'cpp/jsi/JSIParams.cpp';
const PARAMS_BEFORE_SHA256 = '07a9f25b2b79bab090cfd112668f1968c6fb078e11a6d8b65c649294a4e16475';
const PARAMS_AFTER_SHA256 = '6ab84994d6db625621b501461181ad4de4d0e427ef5a960ddf2e0f7464b5c9d5';
const PARAMS_REPLACEMENTS = [
  [
    "#include <cmath>\n",
    "#include <cmath>\n#include <limits>\n"
  ],
  [
    "getPropertyAsBool(runtime, params, \"ignore_eos\", ctx->params.sampling.ignore_eos)",
    "getPropertyAsBool(runtime, params, \"ignore_eos\", false)"
  ],
  [
    `        if (ctx->params.sampling.ignore_eos) {
            sparams.logit_bias[llama_vocab_eos(vocab)].bias = -INFINITY;
        }

        if (params.hasProperty(runtime, "logit_bias")) {
            auto logitBias = params.getProperty(runtime, "logit_bias").asObject(runtime).asArray(runtime);
            for (size_t i = 0; i < logitBias.size(runtime); i++) {
                auto el = logitBias.getValueAtIndex(runtime, i).asObject(runtime).asArray(runtime);
                if (el.size(runtime) == 2) {
                    int tok = (int)el.getValueAtIndex(runtime, 0).asNumber();
                    auto val = el.getValueAtIndex(runtime, 1);
                    if (val.isNumber()) {
                        sparams.logit_bias[tok].bias = val.asNumber();
                    } else if (val.isBool() && !val.getBool()) {
                        sparams.logit_bias[tok].bias = -INFINITY;
                    }
                }
            }
        }`,
    `        if (params.hasProperty(runtime, "logit_bias")) {
            auto logitBias = params.getProperty(runtime, "logit_bias").asObject(runtime).asArray(runtime);
            for (size_t i = 0; i < logitBias.size(runtime); i++) {
                auto el = logitBias.getValueAtIndex(runtime, i).asObject(runtime).asArray(runtime);
                if (el.size(runtime) != 2 || !el.getValueAtIndex(runtime, 0).isNumber()
                    || !el.getValueAtIndex(runtime, 1).isNumber()) {
                    throw std::runtime_error("logit_bias requires numeric token/bias pairs");
                }
                const double token = el.getValueAtIndex(runtime, 0).asNumber();
                const double bias = el.getValueAtIndex(runtime, 1).asNumber();
                if (!std::isfinite(token) || std::trunc(token) != token || token < 0
                    || token >= llama_vocab_n_tokens(vocab)) {
                    throw std::runtime_error("logit_bias token is outside the loaded vocabulary");
                }
                if (!std::isfinite(bias) || bias < -std::numeric_limits<float>::max()
                    || bias > std::numeric_limits<float>::max()) {
                    throw std::runtime_error("logit_bias must be a finite float");
                }
                const llama_token tok = static_cast<llama_token>(token);
                const auto existing = std::find_if(sparams.logit_bias.begin(), sparams.logit_bias.end(),
                    [tok](const llama_logit_bias & entry) { return entry.token == tok; });
                if (existing == sparams.logit_bias.end()) {
                    sparams.logit_bias.push_back({tok, static_cast<float>(bias)});
                } else {
                    existing->bias = static_cast<float>(bias);
                }
            }
        }
        if (sparams.ignore_eos) {
            for (const auto & eog : sparams.logit_bias_eog) {
                const auto existing = std::find_if(sparams.logit_bias.begin(), sparams.logit_bias.end(),
                    [&eog](const llama_logit_bias & entry) { return entry.token == eog.token; });
                if (existing == sparams.logit_bias.end()) {
                    sparams.logit_bias.push_back(eog);
                } else {
                    existing->bias = eog.bias;
                }
            }
        }`
  ]
];
const SOURCE_PATCHES = [
  { source: SOURCE, beforeSha256: BEFORE_SHA256, afterSha256: AFTER_SHA256, replacements: [[BEFORE, AFTER]] },
  { source: PARAMS_SOURCE, beforeSha256: PARAMS_BEFORE_SHA256, afterSha256: PARAMS_AFTER_SHA256, replacements: PARAMS_REPLACEMENTS },
];
// Both prebuilt-core and source-core builds compile this JSI wrapper locally.
// Exact build-file fingerprints fail closed if that inclusion contract changes.
const BUILD_FILES = Object.freeze({
  'android/src/main/CMakeLists.txt': '286375df7159c18c674e30ef8e324c964c4d7304f451f07abffa4a2f279eb2b6',
  'llama-rn.podspec': 'af42dc7cca2823272b4367ddfd21b8191bb265d8fd5c54b6a2072959b0931a55',
  'cpp/rn-completion.h': 'a827a43b7452ecb6130f821fc20dc1c3c30bd9c8c3fa7dfc450bc8cae185b182',
});

function hashSource(text) {
  return crypto.createHash('sha256').update(text.replace(/\r\n/gu, '\n')).digest('hex');
}

function applyReplacements(source, replacements) {
  let patched = source.replace(/\r\n/gu, '\n');
  for (const [before, after] of replacements) {
    if (patched.split(before).length !== 2) throw new Error('llama.rn bridge patch anchor is not unique.');
    patched = patched.replace(before, after);
  }
  return patched;
}

function patchLlamaBridge(root = path.resolve(__dirname, '..'), { check = false } = {}) {
  const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  const manifest = readJson('package.json');
  const lock = readJson('package-lock.json');
  const installed = readJson('node_modules/llama.rn/package.json');
  if (manifest.dependencies?.['llama.rn'] !== VERSION
    || lock.packages?.['']?.dependencies?.['llama.rn'] !== VERSION
    || lock.packages?.['node_modules/llama.rn']?.version !== VERSION
    || installed.version !== VERSION) {
    throw new Error(`Bridge patch requires exactly llama.rn ${VERSION} in manifest, lock and installation.`);
  }
  const llamaRoot = path.join(root, 'node_modules', 'llama.rn');
  for (const [file, expectedHash] of Object.entries(BUILD_FILES)) {
    if (hashSource(fs.readFileSync(path.join(llamaRoot, file), 'utf8')) !== expectedHash) {
      throw new Error(`llama.rn bridge patch build-source contract drift: ${file}.`);
    }
  }
  // Validate every source before writing any file, including partially-applied installs.
  const writes = [];
  const sources = {};
  for (const patch of SOURCE_PATCHES) {
    const sourcePath = path.join(llamaRoot, patch.source);
    const source = fs.readFileSync(sourcePath, 'utf8');
    const sourceHash = hashSource(source);
    sources[patch.source] = patch.afterSha256;
    if (sourceHash === patch.afterSha256) continue;
    if (sourceHash !== patch.beforeSha256) {
      throw new Error('llama.rn bridge patch source fingerprint mismatch: ' + patch.source + '; review upstream before changing this patch.');
    }
    if (check) throw new Error('llama.rn bridge patch is missing; run npm ci with postinstall enabled and rebuild the native app.');
    const patched = applyReplacements(source, patch.replacements);
    if (hashSource(patched) !== patch.afterSha256) throw new Error('llama.rn bridge patch output fingerprint mismatch.');
    writes.push({ sourcePath, text: source.includes('\r\n') ? patched.replace(/\n/gu, '\r\n') : patched, sha256: patch.afterSha256 });
  }
  for (const write of writes) {
    fs.writeFileSync(write.sourcePath, write.text);
    if (hashSource(fs.readFileSync(write.sourcePath, 'utf8')) !== write.sha256) {
      throw new Error('llama.rn bridge patch write verification failed.');
    }
  }
  return { status: writes.length ? 'applied' : 'already-applied', sources };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--check')) throw new Error('Only --check is supported.');
  const result = patchLlamaBridge(undefined, { check: args.includes('--check') });
  console.log(`llama.rn ${VERSION} bridge patch: ${result.status}; sources ${JSON.stringify(result.sources)}`);
}

module.exports = { AFTER, AFTER_SHA256, BEFORE, BEFORE_SHA256, BUILD_FILES, SOURCE, VERSION, SOURCE_PATCHES, PARAMS_SOURCE, PARAMS_BEFORE_SHA256, PARAMS_AFTER_SHA256, hashSource, applyReplacements, patchLlamaBridge };
