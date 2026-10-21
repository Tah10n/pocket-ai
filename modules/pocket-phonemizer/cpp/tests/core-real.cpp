// SPDX-License-Identifier: GPL-3.0-or-later
// Optional hex TSV input/output supports an external private parity corpus without embedding text.
#include "../PhonemizerCore.h"
#include <fstream>
#include <iostream>
#include <stdexcept>
std::string unhex(const std::string& value) {
  if (value.size() % 2 || value.find_first_not_of("0123456789abcdef") != std::string::npos) throw std::runtime_error("invalid_fixture");
  std::string out; for (size_t i = 0; i < value.size(); i += 2) out += static_cast<char>(std::stoul(value.substr(i, 2), nullptr, 16)); return out;
}
std::string hex(const std::string& value) {
  const char* digits = "0123456789abcdef"; std::string out;
  for (unsigned char c : value) { out += digits[c >> 4]; out += digits[c & 15]; } return out;
}
int main(int argc, char** argv) {
  if (argc != 2 && argc != 4) return 1;
  auto owner = pocket::phonemizer::openOwner(); int status = 0;
  try {
    auto init = pocket::phonemizer::initialize(owner, argv[1]); if (!init.error.empty()) throw std::runtime_error("initialize_failed");
    std::ifstream input; std::ofstream output; size_t rows = 0, calls = 0;
    if (argc == 4) { input.open(argv[2]); output.open(argv[3], std::ios::binary | std::ios::trunc); if (!input || !output) throw std::runtime_error("fixture_missing"); }
    std::string line;
    do {
      std::vector<std::string> chunks;
      if (argc == 4) {
        if (!std::getline(input, line)) break; if (!line.empty() && line.back() == '\r') line.pop_back();
        if (line.size() > 8192 || rows >= 64) throw std::runtime_error("fixture_limit");
        size_t position = 0;
        for (;;) { auto end = line.find('\t', position); chunks.push_back(unhex(line.substr(position, end == std::string::npos ? end : end - position))); if (end == std::string::npos) break; position = end + 1; }
      } else chunks = {"Hello world."};
      auto id = "parity_" + std::to_string(rows);
      auto reservation = pocket::phonemizer::reserve(owner, id);
      auto value = pocket::phonemizer::convert(owner, id, chunks);
      if (!reservation.empty() || !value.error.empty() || value.raw.size() != chunks.size() || !value.offThread || !value.calls) throw std::runtime_error("conversion_failed");
      if (argc == 4) { for (size_t i = 0; i < value.raw.size(); ++i) { if (i) output << '\t'; output << hex(value.raw[i]); } output << '\n'; }
      ++rows; calls += value.calls;
    } while (argc == 4);
    std::cout << "PASS: actual same-source mobile Core rows=" << rows << " calls=" << calls << '\n';
  } catch (...) { std::cerr << "core_parity_failed\n"; status = 2; }
  pocket::phonemizer::dispose(owner); return status;
}
