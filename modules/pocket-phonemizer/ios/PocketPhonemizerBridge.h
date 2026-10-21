// SPDX-License-Identifier: GPL-3.0-or-later
#import <Foundation/Foundation.h>
NS_ASSUME_NONNULL_BEGIN
@interface PocketPhonemizerBridge : NSObject
+ (uint64_t)openOwner;
+ (NSString *)manifestSha;
+ (NSString *)reserve:(uint64_t)owner requestId:(NSString *)requestId;
+ (void)cancel:(uint64_t)owner requestId:(NSString *)requestId;
+ (void)invalidate:(uint64_t)owner;
+ (NSDictionary<NSString *, id> *)initialize:(uint64_t)owner dataPath:(NSString *)dataPath;
+ (NSDictionary<NSString *, id> *)convert:(uint64_t)owner requestId:(NSString *)requestId chunks:(NSArray<NSString *> *)chunks;
+ (void)dispose:(uint64_t)owner;
@end
NS_ASSUME_NONNULL_END
