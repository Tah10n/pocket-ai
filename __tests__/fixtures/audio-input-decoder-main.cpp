// Real miniaudio regression: synthetic PCM only, no model or device.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define MINIAUDIO_IMPLEMENTATION
#define MA_NO_ENCODING
#define MA_NO_DEVICE_IO
#define MA_NO_RESOURCE_MANAGER
#define MA_NO_NODE_GRAPH
#define MA_NO_ENGINE
#define MA_NO_GENERATION
#define MA_API static
// MINIAUDIO_HEADER
#include <vector>
#include <cmath>
#include <stdexcept>
#include <cstring>
#include <iostream>
#include <fstream>
#include <iterator>

// AUDIO_DECODER

static void u16(std::vector<unsigned char> & v, size_t p, unsigned n) {
    v[p] = n & 255; v[p + 1] = (n >> 8) & 255;
}
static void u32(std::vector<unsigned char> & v, size_t p, unsigned n) {
    for (unsigned i = 0; i < 4; ++i) v[p + i] = (n >> (8 * i)) & 255;
}
static std::vector<unsigned char> wav(unsigned rate, unsigned channels, unsigned frames, bool floating = false) {
    const unsigned bits = floating ? 32 : 16;
    const unsigned alignment = channels * bits / 8;
    std::vector<unsigned char> v(44 + size_t(frames) * alignment, 0);
    std::memcpy(v.data(), "RIFF", 4); u32(v, 4, unsigned(v.size() - 8));
    std::memcpy(v.data() + 8, "WAVEfmt ", 8); u32(v, 16, 16);
    u16(v, 20, floating ? 3 : 1); u16(v, 22, channels); u32(v, 24, rate);
    u32(v, 28, rate * alignment); u16(v, 32, alignment); u16(v, 34, bits);
    std::memcpy(v.data() + 36, "data", 4); u32(v, 40, frames * alignment);
    if (!floating) for (size_t i = 44; i < v.size(); i += 2) u16(v, i, channels == 2 && ((i - 44) / 2) % 2 ? 3000 : 1000);
    return v;
}
static int failures = 0;
static void accepted(const char * name, const std::vector<unsigned char> & input, int rate, size_t expected, float expectedSignal = 1000.0f / 32768.0f) {
    try {
        std::vector<float> out;
        if (!decode_audio_from_buf(input.data(), input.size(), rate, out)
            || out.size() != expected || out.empty()) throw std::runtime_error("unexpected decoded length");
        for (float sample : out) if (!std::isfinite(sample)) throw std::runtime_error("nonfinite output");
        if (std::fabs(out[out.size() / 2] - expectedSignal) > 0.0001f) throw std::runtime_error("synthetic signal/downmix changed");
        std::cout << "PASS " << name << " frames=" << out.size() << "\n";
    } catch (const std::exception & e) {
        ++failures; std::cerr << "FAIL " << name << ": " << e.what() << "\n";
    }
}
static void rejected(const char * name, const std::vector<unsigned char> & input, const char * code) {
    try {
        std::vector<float> out;
        decode_audio_from_buf(input.data(), input.size(), 16000, out);
        ++failures; std::cerr << "FAIL " << name << ": accepted invalid input\n";
    } catch (const std::exception & e) {
        if (std::strcmp(e.what(), code) != 0) {
            ++failures; std::cerr << "FAIL " << name << ": " << e.what() << "\n";
        } else std::cout << "PASS " << name << "\n";
    }
}
int main(int argc, char ** argv) {
    const auto stereo = wav(48000, 2, 24 * 48000);
    accepted("48k-stereo-over-4MiB-to-16k", stereo, 16000, 24 * 16000, 2000.0f / 32768.0f);
    accepted("48k-stereo-same-rate", stereo, 48000, 24 * 48000, 2000.0f / 32768.0f);
    accepted("16k-mono-40-seconds", wav(16000, 1, 40 * 16000), 16000, 40 * 16000);
    accepted("44k1-mono-to-16k", wav(44100, 1, 44100), 16000, 16000);
    auto truncated = stereo; truncated.resize(truncated.size() - 4);
    rejected("truncated-aligned-PCM", truncated, "audio_decoder_invalid_format");
    auto unaligned = wav(16000, 1, 10); unaligned.pop_back(); u32(unaligned, 4, unsigned(unaligned.size() - 8)); u32(unaligned, 40, 19);
    rejected("unaligned-PCM-data", unaligned, "audio_decoder_invalid_format");
    auto badChunk = wav(16000, 1, 10); u32(badChunk, 40, 0xffffffffu);
    rejected("forged-chunk-length", badChunk, "audio_decoder_invalid_format");
    auto nonfinite = wav(16000, 1, 16, true); u32(nonfinite, 44, 0x7fc00000u);
    rejected("nonfinite-float", nonfinite, "audio_decoder_invalid_format");
    rejected("encoded-size-limit", std::vector<unsigned char>(25 * 1024 * 1024 + 1), "audio_decoder_size_limit");
    rejected("decoded-frame-limit", wav(16000, 1, 8 * 1024 * 1024 + 1), "audio_decoder_duration_limit");
    // Optional existing fixtures provide extra codec compatibility checks, without
    // copying private recordings or downloaded media into the source tree.
    for (int i = 1; i < argc; ++i) {
        std::ifstream file(argv[i], std::ios::binary);
        std::vector<unsigned char> input((std::istreambuf_iterator<char>(file)), {});
        try {
            std::vector<float> out;
            if (!file || input.empty() || !decode_audio_from_buf(input.data(), input.size(), 16000, out) || out.empty())
                throw std::runtime_error("fixture decode failed");
            std::cout << "PASS external-fixture-" << i << " frames=" << out.size() << "\n";
        } catch (const std::exception & e) {
            ++failures; std::cerr << "FAIL external-fixture-" << i << ": " << e.what() << "\n";
        }
    }
    return failures ? 1 : 0;
}
