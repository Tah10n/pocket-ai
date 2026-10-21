// Included after the fingerprinted native grammar implementation, sampler wrappers and builder.
// Only vocabulary lookup is shimmed; parser, stack transitions and logit masking are native.
// Verified Neu GGUF SHA256 14049f27cd9fac6bc703d06bbfd2580ec6fdc2b23780533bb416ddaf236d993f:
// tokenizer.ggml.eos_token_id=128261, token_type=CONTROL(3), piece=<|SPEECH_GENERATION_END|>.
// The numeric token range is 128262..193797 (speech_0..speech_65535).
struct llama_vocab::impl {};
llama_vocab::llama_vocab(): pimpl(new impl) {}
llama_vocab::~llama_vocab() = default;
bool llama_vocab::is_eog(llama_token id) const { return id == 128261; }
const std::string & llama_vocab::token_to_piece(llama_token id) const {
    static const std::map<int, std::string> pieces = {
        {128261, "<|SPEECH_GENERATION_END|>"}, {128262, "<|speech_0|>"}, {193797, "<|speech_65535|>"},
        // Synthetic negative candidates are outside the pinned speech vocabulary.
        {193798, "<|speech_65536|>"}, {193799, "invalid-text"}, {193800, "<|speech_00|>"},
    };
    return pieces.at(id);
}
int32_t llama_vocab::tokenize(const char *, int32_t, llama_token *, int32_t, bool, bool) const {
    throw std::runtime_error("unexpected vocab access in grammar parser regression");
}
void lm_ggml_abort(const char *, int, const char *, ...) { std::abort(); }
void llama_log_internal(lm_ggml_log_level, const char *, ...) {}

static std::set<std::string> expand(const llama_grammar_parser &parser, uint32_t id, int depth = 0) {
    if (depth > 8) throw std::runtime_error("unexpected recursive numeric grammar");
    std::set<std::string> result;
    std::set<std::string> sequence = {""};
    const auto &rule = parser.rules.at(id);
    for (size_t i = 0; i < rule.size(); ++i) {
        const auto e = rule[i];
        if (e.type == LLAMA_GRETYPE_ALT || e.type == LLAMA_GRETYPE_END) {
            result.insert(sequence.begin(), sequence.end());
            sequence = {""};
        } else {
            std::set<std::string> pieces;
            if (e.type == LLAMA_GRETYPE_RULE_REF) pieces = expand(parser, e.value, depth + 1);
            else if (e.type == LLAMA_GRETYPE_CHAR) {
                uint32_t end = e.value;
                if (i + 1 < rule.size() && rule[i + 1].type == LLAMA_GRETYPE_CHAR_RNG_UPPER) end = rule[++i].value;
                if (end > 127) throw std::runtime_error("unexpected non-ASCII numeric grammar");
                for (uint32_t c = e.value; c <= end; ++c) pieces.insert(std::string(1, char(c)));
            } else throw std::runtime_error("unexpected numeric grammar element");
            std::set<std::string> next;
            for (const auto &a : sequence) for (const auto &b : pieces) {
                if (a.size() + b.size() > 5 || next.size() > 65536) throw std::runtime_error("numeric expansion bound");
                next.insert(a + b);
            }
            sequence = std::move(next);
        }
    }
    return result;
}
static bool allowed(llama_sampler &sampler, int id) {
    llama_token_data candidate{id, 0.0f, 0.0f};
    llama_token_data_array candidates{&candidate, 1, -1, false};
    llama_sampler_grammar_apply(&sampler, &candidates);
    return std::isfinite(candidate.logit);
}
static int check_eos_contract(const std::string &source) {
    llama_vocab vocab;
    std::unique_ptr<llama_grammar, decltype(&llama_grammar_free_impl)> grammar(
        llama_grammar_init_impl(&vocab, source.c_str(), "root", false, nullptr, 0, nullptr, 0), llama_grammar_free_impl);
    if (!grammar) return 10;
    llama_sampler_grammar state{&vocab, source, "root", grammar.get()};
    llama_sampler sampler{nullptr, &state};
    // Empty audio must not terminate. Both valid codec bounds remain legal.
    if (allowed(sampler, 128261) || !allowed(sampler, 128262) || !allowed(sampler, 193797)) return 11;
    llama_sampler_grammar_accept_impl(&sampler, 128262);
    if (!allowed(sampler, 128261)) { puts("FAIL: EOS masked after complete speech token"); return 12; }
    if (!allowed(sampler, 128262) || !allowed(sampler, 193797)
        || allowed(sampler, 193798) || allowed(sampler, 193799) || allowed(sampler, 193800)) return 13;
    llama_sampler_grammar_accept_impl(&sampler, 193797);
    if (!allowed(sampler, 128261)) return 14;
    llama_grammar_accept_str(*grammar, "<|speech_");
    if (allowed(sampler, 128261)) return 15;
    llama_grammar_accept_str(*grammar, "42|>");
    if (!allowed(sampler, 128261)) return 16;
    llama_sampler_grammar_accept_impl(&sampler, 128261);
    return 0;
}
int main() {
    llama_grammar_parser parser;
    if (!parser.parse(build_neutts_dynamic_grammar().c_str())) {
        fprintf(stderr, "FAIL: native Neu grammar rejected by pinned parser\n"); return 1;
    }
    const auto found = parser.symbol_ids.find("speech-id");
    if (found == parser.symbol_ids.end()) return 2;
    const auto values = expand(parser, found->second);
    if (values.size() != 65536) return 3;
    for (int i = 0; i < 65536; ++i) if (!values.count(std::to_string(i))) return 4;
    const int eos = check_eos_contract(build_neutts_dynamic_grammar());
    if (eos != 0) return eos;
    puts("PASS: native Neu grammar, exact 65536-code language and sampler EOS boundary");
}
