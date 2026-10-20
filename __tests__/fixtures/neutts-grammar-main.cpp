// Included after the unchanged pinned parser implementation and native Neu grammar builder.
// The null-vocab parser route never tokenizes; fail loudly if that boundary changes.
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
    puts("PASS: actual native parser accepts Neu grammar; exact numeric language is 0..65535 (65536 strings)");
}
