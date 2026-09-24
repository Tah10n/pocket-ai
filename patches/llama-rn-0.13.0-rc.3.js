// Narrow corrections for the pinned release; core fixes require a source-core build.
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
const CLOCK_SOURCE = 'cpp/common/chat.cpp';
const CLOCK_BEFORE_SHA256 = 'a7e0aeaf40a7f9ac94093c2554d1086d430cade04a6a03e0001b711643338e34';
const CLOCK_AFTER_SHA256 = '2184f18ae06502e17060e1bcbbccd0faa12416d8ecbc129e1f0b503e014d66f5';
const CLOCK_PREVIOUS_SHA256 = 'ad51d8e0db5e98d2f5ae3c7aa56ad6c82664cb00204d3c4a5b74b4b8df743c24';
const CLOCK_BEFORE = '    jinja::context ctx(tmpl.source());\n';
const CLOCK_AFTER = `${CLOCK_BEFORE}    ctx.current_time = std::chrono::system_clock::to_time_t(inputs.now);\n`;
const CLOCK_PRIVACY_REPLACEMENTS = [
  [
    "            LOG_ERR(\"%s: failed to apply template: %s\\n\", __func__, e.what());",
    "            LOG_ERR(\"%s: failed to apply template\\n\", __func__);"
  ],
  [
    "        LOG_ERR(\"%s: error: %s\\n\", __func__, e.what());",
    "        LOG_ERR(\"%s: template initialization failed\\n\", __func__);"
  ],
  [
    "            LOG_ERR(\"%s: failed to parse tool use chat template (ignoring it): %s\\n\", __func__, e.what());",
    "            LOG_ERR(\"%s: failed to parse tool use chat template (ignoring it)\\n\", __func__);"
  ],
  [
    "        LOG_DBG(\"%s: generated parser:\\n%s\\n\\nparser generation prompt: %s\\n\", __func__, arena.dump(arena.root()).c_str(), auto_params.generation_prompt.c_str());",
    "        LOG_DBG(\"%s: generated parser\\n\", __func__);"
  ],
  [
    "        LOG_WRN(\"%s: unparsed %s output: %s\\n\", __func__, common_chat_format_name(params.format), effective_input.substr(result.end).c_str());",
    "        LOG_WRN(\"%s: output did not match %s parser\\n\", __func__, common_chat_format_name(params.format));"
  ],
  [
    "        LOG_DBG(\"%s: full %s output triggering error:\\n=== BEGIN ===\\n%s\\n=== END ===\\n\", __func__, common_chat_format_name(params.format), effective_input.c_str());",
    "        LOG_DBG(\"%s: output parser failed\\n\", __func__);"
  ],
  [
    "        LOG_DBG(\"Parsed message: %s\\n\", common_chat_msgs_to_json_oaicompat({ msg }).at(0).dump().c_str());",
    "        LOG_DBG(\"Parsed complete message\\n\");"
  ],
  [
    "            LOG_INF(\"Skipping tool without function: %s\", tool.dump(2).c_str());",
    "            LOG_INF(\"Skipping tool without function\");"
  ],
  [
    "                LOG_ERR(\"Tool call mismatch: prev='%s' new='%s'\\n\", pref.name.c_str(), newf.name.c_str());",
    "                LOG_ERR(\"Tool call name mismatch\\n\");"
  ]
];
const COMPLETION_SOURCE = 'cpp/rn-completion.cpp';
const COMPLETION_BEFORE_SHA256 = '4563b4a65e98e7022d4ae38014f12acd2241a0911fc2201f5da465679df82087';
const COMPLETION_AFTER_SHA256 = 'e4148aee26b8f99b8646407e3b217157ef66a3614e0529dcc2cf6fe0416d2b2d';
const COMPLETION_REPLACEMENTS = [
  [
    `    if (ctx_sampling != nullptr) {
        common_sampler_free(ctx_sampling);
    }
    ctx_sampling = common_sampler_init(parent_ctx->model, parent_ctx->params.sampling);`,
    `    if (ctx_sampling != nullptr) {
        common_sampler_free(ctx_sampling);
        ctx_sampling = nullptr;
    }
    ctx_sampling = common_sampler_init(parent_ctx->model, parent_ctx->params.sampling);`
  ]
];
const SAMPLING_SOURCE = 'cpp/common/sampling.cpp';
const SAMPLING_BEFORE_SHA256 = 'e4926ff1507748facc785d6192554f66dcbaa7aa98b3371d907b11414c1f9fa5';
const SAMPLING_AFTER_SHA256 = '942c2c508a03968f8ba78fc554832c899b0fc8e29be4f6c526ba8118f141cf1c';
const SAMPLING_REPLACEMENTS = [
  [
    `    llama_sampler * grmr = nullptr;
    llama_sampler * rbudget = nullptr;
    llama_sampler * chain = llama_sampler_chain_init(lparams);

    std::vector<llama_sampler *> samplers;`,
    `    llama_sampler * grmr = nullptr;
    llama_sampler * rbudget = nullptr;
    llama_sampler * chain = nullptr;

    std::vector<llama_sampler *> samplers;
    struct sampler_init_guard {
        llama_sampler * & grmr;
        llama_sampler * & rbudget;
        llama_sampler * & chain;
        std::vector<llama_sampler *> & pending;
        bool released = false;
        ~sampler_init_guard() {
            if (released) {
                return;
            }
            for (auto * smpl : pending) {
                llama_sampler_free(smpl);
            }
            llama_sampler_free(grmr);
            llama_sampler_free(rbudget);
            llama_sampler_free(chain);
        }
    } guard { grmr, rbudget, chain, samplers };
    chain = llama_sampler_chain_init(lparams);
    samplers.reserve(params.samplers.size() + 3);`
  ],
  [
    `    for (auto * smpl : samplers) {
        llama_sampler_chain_add(chain, smpl);
    }`,
    `    for (auto * & smpl : samplers) {
        llama_sampler_chain_add(chain, smpl);
        smpl = nullptr;
    }`
  ],
  [
    `    return result;
}

void common_sampler_free`,
    `    guard.released = true;
    return result;
}

void common_sampler_free`
  ],
  [
    "            LOG_DBG(\"%s: prefill token: %d = %s\\n\", __func__, tokens[i], piece.c_str());",
    "            LOG_DBG(\"%s: prepared prefill token\\n\", __func__);"
  ],
  [
    "                LOG_DBG(\"%s: grammar accepted prefill token (%d)\\n\", __func__, token);",
    "                LOG_DBG(\"%s: grammar accepted prefill token\\n\", __func__);"
  ],
  [
    "            LOG_ERR(\"%s: error initializing grammar sampler for grammar:\\n%s\\n\\nGeneration prompt:\\n'%s'\\n\", __func__,\n                common_grammar_value(params.grammar).c_str(), params.generation_prompt.c_str());",
    "            LOG_ERR(\"%s: grammar sampler rejected generation prefill\\n\", __func__);"
  ],
  [
    "            LOG_DBG(\"%s: reasoning-budget accepted prefill token (%d)\\n\", __func__, token);",
    "            LOG_DBG(\"%s: reasoning-budget accepted prefill token\\n\", __func__);"
  ]
];
const GRAMMAR_SOURCE = 'cpp/llama-grammar.cpp';
const GRAMMAR_BEFORE_SHA256 = '7f1d1912560a81254674f713cd82da1872c4a83ebf1eca80ae90558373283939';
const GRAMMAR_AFTER_SHA256 = 'b14101f01415a702662ee9a746f0831ee14518e3c7f3796aa42ab810f5f17d33';
const GRAMMAR_REPLACEMENTS = [
  [
    "    } catch (const std::exception & err) {\n        fprintf(stderr, \"%s: error parsing grammar: %s\\n\\n%s\\n\", __func__, err.what(), src);",
    "    } catch (const std::exception &) {\n        fprintf(stderr, \"%s: grammar parsing failed\\n\", __func__);"
  ],
  [
    "            LLAMA_LOG_DEBUG(\"Grammar triggered on token %u (`%s`)\", token, piece.c_str());",
    "            LLAMA_LOG_DEBUG(\"Grammar triggered on token\");"
  ],
  [
    "                    auto constrained_str = grammar.trigger_buffer.substr(start);\n                    grammar.trigger_buffer.clear();\n                    grammar.trigger_buffer_positions.clear();",
    "                    grammar.trigger_buffer.clear();\n                    grammar.trigger_buffer_positions.clear();"
  ],
  [
    "                    LLAMA_LOG_DEBUG(\"Grammar triggered on regex: '%s'\\n\", constrained_str.c_str());",
    "                    LLAMA_LOG_DEBUG(\"Grammar triggered on regex\\n\");"
  ],
  [
    "            LLAMA_LOG_DEBUG(\"Grammar still awaiting trigger after token %d (`%s`)\\n\", token, piece.c_str());",
    "            LLAMA_LOG_DEBUG(\"Grammar still awaiting trigger\\n\");"
  ]
];
const SOURCE_PATCHES = [
  { source: SOURCE, beforeSha256: BEFORE_SHA256, afterSha256: AFTER_SHA256, replacements: [[BEFORE, AFTER]] },
  { source: PARAMS_SOURCE, beforeSha256: PARAMS_BEFORE_SHA256, afterSha256: PARAMS_AFTER_SHA256, replacements: PARAMS_REPLACEMENTS },
  { source: CLOCK_SOURCE, beforeSha256: CLOCK_BEFORE_SHA256, afterSha256: CLOCK_AFTER_SHA256, replacements: [[CLOCK_BEFORE, CLOCK_AFTER], ...CLOCK_PRIVACY_REPLACEMENTS], intermediates: [{ sha256: CLOCK_PREVIOUS_SHA256, replacements: CLOCK_PRIVACY_REPLACEMENTS }] },
  { source: COMPLETION_SOURCE, beforeSha256: COMPLETION_BEFORE_SHA256, afterSha256: COMPLETION_AFTER_SHA256, replacements: COMPLETION_REPLACEMENTS },
  { source: SAMPLING_SOURCE, beforeSha256: SAMPLING_BEFORE_SHA256, afterSha256: SAMPLING_AFTER_SHA256, replacements: SAMPLING_REPLACEMENTS },
  { source: GRAMMAR_SOURCE, beforeSha256: GRAMMAR_BEFORE_SHA256, afterSha256: GRAMMAR_AFTER_SHA256, replacements: GRAMMAR_REPLACEMENTS },
  { source: 'llama-rn.podspec', beforeSha256: 'af42dc7cca2823272b4367ddfd21b8191bb265d8fd5c54b6a2072959b0931a55', afterSha256: 'e539fba083a63e6edda56d27780c7d14194542cabb3b99919a4fe81a609adbff', replacements: [
    [
      "s.source_files = \"ios/**/*.{h,m,mm}\", \"cpp/**/*.{h,cpp,hpp,c,m,mm,s}\"",
      "s.source_files = \"ios/*.{h,m,mm}\", \"cpp/**/*.{cpp,c,m,mm,s}\""
    ],
    [
      "    header_search_paths << '\"${PODS_TARGET_SRCROOT}/cpp/hash\"'",
      "    header_search_paths << '\"${PODS_TARGET_SRCROOT}/cpp/hash\"'\n    header_search_paths << '\"${PODS_TARGET_SRCROOT}/cpp/nlohmann\"'\n    header_search_paths << '\"${PODS_TARGET_SRCROOT}/cpp/ggml-cpu\"'\n    header_search_paths << '\"${PODS_TARGET_SRCROOT}/cpp/codec/include\"'\n    header_search_paths << '\"${PODS_TARGET_SRCROOT}/cpp/codec/common\"'\n    header_search_paths << '\"${PODS_TARGET_SRCROOT}/cpp/tools/mtmd\"'\n    # Resolve quoted runtime headers before dependency header maps.\n    header_search_paths.drop(1).each do |include_path|\n      base_compiler_flags += \" -iquote #{include_path}\"\n    end"
    ],
    [
      "# Header-only JSON dependency needed by JSI when using the prebuilt xcframework\n  s.preserve_paths = \"cpp/nlohmann/**/*.{h,hpp}\"",
      "# Keep internal headers for compilation without exporting duplicate basenames.\n  s.preserve_paths = \"cpp/**/*.{h,hpp}\""
    ]
  ], intermediates: [{ sha256: '0074a4cddbe0f46352067174cdc89362dde6512625eea29a0fcd3b444d648f50', replacements: [["    header_search_paths << '\"${PODS_TARGET_SRCROOT}/cpp/tools/mtmd\"'", "    header_search_paths << '\"${PODS_TARGET_SRCROOT}/cpp/tools/mtmd\"'\n    # Resolve quoted runtime headers before dependency header maps.\n    header_search_paths.drop(1).each do |include_path|\n      base_compiler_flags += \" -iquote #{include_path}\"\n    end"]] }] },
  { source: 'cpp/common/jinja/value.cpp', beforeSha256: '9e9ee66217afe97e555f9423be6152fd69f8c1776740f002a9cd12681a76a411', afterSha256: '48c3eaad040ccdc3cbc278b5648aa79a25ae83656a483f56269470a5ded5f22f', replacements: [["#include \"json.h\"", "#include \"../json.h\""]] },
  { source: 'cpp/common/jinja/caps.cpp', beforeSha256: 'cc497360610e81359fa843656fa8352a917dd37926737cfc9d888cf6f7d1baa0', afterSha256: '329b9a013dba2d19f974a4af1e8733c0c91de1dfa942bf733aae9f7ad7b6bfe1', replacements: [["#include \"json.h\"", "#include \"../json.h\""]] },
  {"source": "cpp/jsi/JSINativeHeaders.h", "beforeSha256": "100fe22ecc52e4979d370cfb62986a2fd2b0abe6b9b98cf594610b9dad94e053", "afterSha256": "1915df1b29ee735d8344a8bd9b974dc6dbb1dba974abaacb6d92dfafe4643ba4", "replacements": [["#include \"json.h\"", "#include \"../common/json.h\""], ["#include \"common.h\"", "#include \"../common/common.h\""]], "intermediates": [{"sha256": "2a79c573ef863ed015ed35413ee44618486aa714fbafd2324913f7000fc7659d", "replacements": [["#include \"common.h\"", "#include \"../common/common.h\""]]}]},
  {"source": "cpp/rn-completion.h", "beforeSha256": "a827a43b7452ecb6130f821fc20dc1c3c30bd9c8c3fa7dfc450bc8cae185b182", "afterSha256": "bdc0fe895be630ab6cb301d08f66bae4287dd3b9d3417662d270e86bcf280588", "replacements": [["#include \"common.h\"", "#include \"common/common.h\""]]},
  {"source": "cpp/rn-llama.h", "beforeSha256": "2ede73fed4a0a28a697001133ed67ad51525a8059f23582867138ba6c6971105", "afterSha256": "2094b3bc9350c7138dbd7d2152b44580700293ab0146496d081a9bafe8ee392d", "replacements": [["#include \"common.h\"", "#include \"common/common.h\""]]},
  {"source": "cpp/rn-slot-manager.h", "beforeSha256": "76b457c59ae574134094e203c38d411f1dc7243b6616c4fd13d32d3c80b88dce", "afterSha256": "882150b9bb69c8b4cb4da71b1433b42adf161caa256e6c7c4dc058731ead2c3e", "replacements": [["#include \"common.h\"", "#include \"common/common.h\""]]},
  {"source": "cpp/rn-slot.h", "beforeSha256": "6c44d5d937212addb9e31ec629953937e77be26ba0427047190992e2bf2794d2", "afterSha256": "cd89f60afb06a0c819fac99f8f8a036c83826484e2a03276d7b151848151c7a0", "replacements": [["#include \"common.h\"", "#include \"common/common.h\""]]},
  {"source": "cpp/rn-tts.cpp", "beforeSha256": "2e02fd6d1acaeac7a7f321baeb6ea99dac4503ba78b70439ee2c9de8effe488c", "afterSha256": "147e5c43104da96b104cad76841c2639338b33628d5bdad74696b84fc9be541f", "replacements": [["#include \"common.h\"", "#include \"common/common.h\""]]},
];
// JSI fixes are compiled locally in every mode. Clock and sampler fixes are in the core:
// source-build configuration must also be enforced by the native config verifier.
// Exact fingerprints protect source inclusion and the request-clock data contract.
const BUILD_FILES = Object.freeze({
  'cpp/common/sampling.h': '92a10833fc729a5a8eff065d269a88ceb21b81d77c2eba5942a3450fe1a0d2d1',
  'cpp/llama-sampler.cpp': '38999ce7ce5fdba6a9cd29b775a81cee918ab6d1a3e0f0d71d35c9158d629c0f',
  'android/src/main/CMakeLists.txt': '286375df7159c18c674e30ef8e324c964c4d7304f451f07abffa4a2f279eb2b6',
  'android/build.gradle': '841f2514b2f6540a6f118b9fc024690ea238e17b23151c421a52a3105fb16583',
  'android/src/main/rnllama/CMakeLists.txt': 'f58142de643017b3145767553add3353a411a9ae2accfff1cc0bc6cc6a710364',
  'cpp/common/jinja/runtime.h': '89c8efc60ad287f49089fbcf7f028d1b88b32d41a2e859f1b68af5a574816a3f',
  'cpp/common/chat-auto-parser.h': 'c774fcc02980529671793e110118ecfccb1e3c48eac52c852ce354922f599b52',
  'cpp/common/chat.h': 'e6d106744146668453d38fa3db725b630a438eb982c74effd094f30cd3ed4d65',
  'cpp/rn-llama.cpp': 'e33948572e199c90a74f1ecb4d27be791924fe4954737f0d83c96b2a18ad0d1c',
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
    const intermediate = patch.intermediates?.find(entry => entry.sha256 === sourceHash);
    if (sourceHash !== patch.beforeSha256 && !intermediate) {
      throw new Error('llama.rn bridge patch source fingerprint mismatch: ' + patch.source + '; review upstream before changing this patch.');
    }
    if (check) throw new Error('llama.rn bridge patch is missing; run npm ci with postinstall enabled and rebuild the native app.');
    const patched = applyReplacements(source, intermediate?.replacements || patch.replacements);
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

module.exports = { AFTER, AFTER_SHA256, BEFORE, BEFORE_SHA256, BUILD_FILES, SOURCE, VERSION, SOURCE_PATCHES, PARAMS_SOURCE, PARAMS_BEFORE_SHA256, PARAMS_AFTER_SHA256, CLOCK_SOURCE, CLOCK_BEFORE_SHA256, CLOCK_AFTER_SHA256, CLOCK_BEFORE, CLOCK_AFTER, CLOCK_PREVIOUS_SHA256, CLOCK_PRIVACY_REPLACEMENTS, COMPLETION_SOURCE, COMPLETION_BEFORE_SHA256, COMPLETION_AFTER_SHA256, SAMPLING_SOURCE, SAMPLING_BEFORE_SHA256, SAMPLING_AFTER_SHA256, GRAMMAR_SOURCE, GRAMMAR_BEFORE_SHA256, GRAMMAR_AFTER_SHA256, hashSource, applyReplacements, patchLlamaBridge };
