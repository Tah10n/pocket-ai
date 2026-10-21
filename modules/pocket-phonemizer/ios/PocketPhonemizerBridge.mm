// SPDX-License-Identifier: GPL-3.0-or-later
#import "PocketPhonemizerBridge.h"
#include "../cpp/PhonemizerCore.h"
#include <stdexcept>
namespace {
std::string utf8(NSString *value) {
  NSData *data = [value dataUsingEncoding:NSUTF8StringEncoding allowLossyConversion:NO];
  if (!data) throw std::runtime_error("invalid_utf8");
  return data.length ? std::string(static_cast<const char *>(data.bytes), data.length) : std::string();
}
NSDictionary *result(const pocket::phonemizer::Result& value) {
  NSMutableArray *raw = [NSMutableArray new];
  for (const auto& item : value.raw) {
    NSString *text = [[NSString alloc] initWithBytes:item.data() length:item.size() encoding:NSUTF8StringEncoding];
    if (!text) throw std::runtime_error("invalid_utf8"); [raw addObject:text];
  }
  NSMutableDictionary *output = [@{@"raw": raw, @"initMs": @(value.initMs), @"conversionMs": @(value.conversionMs),
    @"calls": @(value.calls), @"offThread": @(value.offThread)} mutableCopy];
  if (!value.error.empty()) output[@"error"] = [NSString stringWithUTF8String:value.error.c_str()];
  return output;
}
void abandon(uint64_t owner) noexcept { try { pocket::phonemizer::invalidate(owner); pocket::phonemizer::dispose(owner); } catch (...) {} }
NSDictionary *failure() { pocket::phonemizer::Result value; value.error = "native_failure"; return result(value); }
}
@implementation PocketPhonemizerBridge
+ (uint64_t)openOwner { try { return pocket::phonemizer::openOwner(); } catch (...) { return 0; } }
+ (NSString *)manifestSha { return [NSString stringWithUTF8String:pocket::phonemizer::expectedManifestSha256()]; }
+ (NSString *)reserve:(uint64_t)owner requestId:(NSString *)requestId {
  try { return [NSString stringWithUTF8String:pocket::phonemizer::reserve(owner, utf8(requestId)).c_str()]; }
  catch (...) { return @"native_failure"; }
}
+ (void)cancel:(uint64_t)owner requestId:(NSString *)requestId { try { pocket::phonemizer::cancel(owner, utf8(requestId)); } catch (...) {} }
+ (void)invalidate:(uint64_t)owner { try { pocket::phonemizer::invalidate(owner); } catch (...) {} }
+ (NSDictionary *)initialize:(uint64_t)owner dataPath:(NSString *)dataPath {
  try { return result(pocket::phonemizer::initialize(owner, utf8(dataPath))); } catch (...) { abandon(owner); return failure(); }
}
+ (NSDictionary *)convert:(uint64_t)owner requestId:(NSString *)requestId chunks:(NSArray<NSString *> *)chunks {
  try { std::vector<std::string> values; if (chunks.count <= 240) for (NSString *chunk in chunks) values.push_back(utf8(chunk));
    return result(pocket::phonemizer::convert(owner, utf8(requestId), std::move(values))); } catch (...) { abandon(owner); return failure(); }
}
+ (void)dispose:(uint64_t)owner { try { pocket::phonemizer::dispose(owner); } catch (...) {} }
@end
