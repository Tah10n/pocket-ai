// The three DAC function bodies below are extracted from the pinned source.
// Stubs observe their graph boundary; they do not simulate ggml performance.
#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

enum codec_status { CODEC_STATUS_SUCCESS, CODEC_STATUS_INVALID_ARG,
    CODEC_STATUS_INVALID_STATE, CODEC_STATUS_INTERNAL_ERROR };
struct codec_dac { bool has_decoder = true; int32_t n_q = 1, hop_size = 320, sample_rate = 24000; };
struct codec_model { void * impl; int32_t n_threads; };
struct codec_context { codec_model * model; };
struct codec_token_buffer { const int32_t * data; int32_t n_frames, n_q; };
struct codec_pcm_buffer { float * data = nullptr; int32_t n_samples = 0, sample_rate = 0, n_channels = 0; };
struct codec_graph_cache_entry {};
struct codec_graph_key { int kind, frames, q, hop, input, latent; };
struct lm_ggml_tensor { int64_t ne[1] = { 1 }; };
struct dac_decode_build { int32_t codebook_size = 1024; };
struct dac_decode_latent_build { int32_t frames, latent, hop; };
constexpr int CODEC_GRAPH_DAC_DECODE = 1, CODEC_GRAPH_DAC_DECODE_LATENT = 2;
static int graph_calls = 0, observed_threads = 0, active_guards = 0, released_guards = 0;
static bool fail_graph = false;
struct codec_graph_eval_guard {
    explicit codec_graph_eval_guard(codec_context *) { ++active_guards; }
    ~codec_graph_eval_guard() { --active_guards; ++released_guards; }
};
static void codec_context_set_error(codec_context *, const std::string &) {}
static bool codec_dac_init_decode_build(codec_context *, int, int, dac_decode_build *, std::string *) { return true; }
static bool codec_dac_build_decode() { return true; }
static bool codec_dac_build_decode_latent() { return true; }
static bool codec_graph_cache_get_or_build(codec_context *, codec_graph_key, bool (*)(),
        void *, size_t, codec_graph_cache_entry ** entry, std::string *) {
    static codec_graph_cache_entry value;
    *entry = &value;
    return true;
}
static lm_ggml_tensor * codec_graph_get_tensor(codec_context *, codec_graph_cache_entry *, const char *) {
    static lm_ggml_tensor value;
    return &value;
}
static bool codec_graph_prepare_io(codec_context *, codec_graph_cache_entry *, std::string *) { return true; }
static bool codec_runtime_write_tensor(lm_ggml_tensor *, const void *, size_t, std::string *) { return true; }
static bool codec_runtime_read_tensor(lm_ggml_tensor *, void *, size_t, std::string *) { return true; }
static bool codec_graph_compute(codec_context *, codec_graph_cache_entry *, int32_t threads, std::string *) {
    ++graph_calls;
    observed_threads = threads;
    return !fail_graph;
}
static void codec_pcm_buffer_reset(codec_pcm_buffer * pcm) { *pcm = {}; }
struct codec_decode_params { int32_t n_threads = 0, n_q = 0; };

// DAC_TOKEN_GRAPH
// DAC_LATENT_DECODE
// DAC_TOKEN_DECODE

static void require(bool condition, const char * label) {
    if (!condition) { std::cerr << label << '\n'; std::exit(12); }
}
int main() {
    codec_dac dac;
    codec_model model { &dac, 7 };
    codec_context ctx { &model };
    const int32_t token = 0;
    const float latent = 0;
    codec_token_buffer tokens { &token, 1, 1 };
    for (const bool latent_path : { false, true }) {
        for (const int requested : { 4, 2, 0, -1 }) {
            codec_pcm_buffer pcm;
            const int calls = graph_calls, released = released_guards;
            const codec_decode_params params { requested, 0 };
            const auto result = latent_path
                ? codec_dac_decode_latent(&ctx, &latent, 1, 1, &pcm, params)
                : codec_dac_decode(&ctx, &tokens, &pcm, params);
            require(result == CODEC_STATUS_SUCCESS, "decode success");
            require(graph_calls == calls + 1, "one graph compute");
            require(observed_threads == (requested > 0 ? requested : 7), "decode request must reach graph compute");
            require(model.n_threads == 7, "decode must not mutate model defaults");
            require(active_guards == 0 && released_guards == released + 1, "graph released after decode");
            std::free(pcm.data);
        }
        model.n_threads = 0;
        codec_pcm_buffer pcm;
        const auto fallback = latent_path
            ? codec_dac_decode_latent(&ctx, &latent, 1, 1, &pcm, {})
            : codec_dac_decode(&ctx, &tokens, &pcm, {});
        require(fallback == CODEC_STATUS_SUCCESS && observed_threads == 1, "default minimum one thread");
        require(model.n_threads == 0, "default model remains unchanged");
        std::free(pcm.data);
        model.n_threads = 7;
        pcm = {};
        fail_graph = true;
        const int released = released_guards;
        const auto failed = latent_path
            ? codec_dac_decode_latent(&ctx, &latent, 1, 1, &pcm, { 4, 0 })
            : codec_dac_decode(&ctx, &tokens, &pcm, { 4, 0 });
        require(failed == CODEC_STATUS_INTERNAL_ERROR && observed_threads == 4, "graph failure preserved");
        require(active_guards == 0 && released_guards == released + 1 && pcm.data == nullptr, "failure releases graph without PCM");
        fail_graph = false;
    }
    codec_pcm_buffer pcm;
    const int calls = graph_calls;
    require(codec_dac_decode(&ctx, &tokens, &pcm, { 4, 2 }) == CODEC_STATUS_INVALID_ARG, "invalid codebooks rejected");
    require(codec_dac_decode_latent(&ctx, &latent, 0, 1, &pcm, { 4, 0 }) == CODEC_STATUS_INVALID_ARG, "invalid latent shape rejected");
    dac.has_decoder = false;
    require(codec_dac_decode(&ctx, &tokens, &pcm, { 4, 0 }) == CODEC_STATUS_INVALID_STATE, "missing decoder rejected");
    require(graph_calls == calls && active_guards == 0, "invalid calls never execute graph");
    std::cout << "DAC native decode thread forwarding and release checks passed\n";
}
