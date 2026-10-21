// Included only in the bounded host regression, never in the app.
#include <cassert>
#include <cstddef>
#include <iostream>
using llama_token = int;
constexpr int NEUTTS_NANO = 5;
static int selected_token = 0;
static int sampler_calls = 0;
llama_token common_sampler_sample(void *, void *, int) { ++sampler_calls; return selected_token; }
bool llama_vocab_is_eog(void *, llama_token token) { return token == 128261 || token == 128009; }
llama_token llama_vocab_eos(void *) { return 128261; }
struct Parent;
struct Tts { int family = NEUTTS_NANO; int getTTSType(Parent *) { return family; } };
struct Parent { bool enabled = true; Tts *tts_wrapper; void *ctx = nullptr; bool isVocoderEnabled() { return enabled; } };
struct Receipt {
    Parent *parent_ctx;
    void *ctx_sampling = nullptr;
    void *vocab = nullptr;
    size_t tts_sampled_tokens = 0;
    int tts_stop_token_kind = 0;
    size_t num_tokens_predicted = 0;
    void sample() {
        // NATIVE_SAMPLE_BLOCK
    }
    void rewind() {
        // NATIVE_RESET_BLOCK
    }
};
int main() {
    Tts tts; Parent parent{true, &tts}; Receipt receipt{&parent};
    for (int i = 0; i < 49; ++i) { selected_token = 128262 + i; receipt.sample(); }
    assert(receipt.tts_sampled_tokens == 49 && receipt.tts_stop_token_kind == 0);
    selected_token = 128261; receipt.sample();
    assert(receipt.tts_sampled_tokens == 50 && receipt.tts_stop_token_kind == 1 && sampler_calls == 50);
    receipt.rewind();
    assert(receipt.tts_sampled_tokens == 0 && receipt.tts_stop_token_kind == 0);
    selected_token = 128009; receipt.sample();
    assert(receipt.tts_sampled_tokens == 1 && receipt.tts_stop_token_kind == 2);
    receipt.rewind(); selected_token = 128262; receipt.sample();
    // Cancel/limit after an ordinary draw cannot manufacture an EOS category.
    assert(receipt.tts_sampled_tokens == 1 && receipt.tts_stop_token_kind == 0);
    receipt.rewind(); parent.enabled = false; selected_token = 128261; receipt.sample();
    assert(receipt.tts_sampled_tokens == 0 && receipt.tts_stop_token_kind == 0);
    parent.enabled = true; tts.family = 1; receipt.sample();
    assert(receipt.tts_sampled_tokens == 0 && receipt.tts_stop_token_kind == 0);
    tts.family = NEUTTS_NANO; receipt.tts_sampled_tokens = 1000000; receipt.sample();
    assert(receipt.tts_sampled_tokens == 1000000 && receipt.tts_stop_token_kind == 1);
    std::cout << "PASS: native Neu receipt classification, counts, reset and isolation\n";
}
