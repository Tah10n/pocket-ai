#import <Foundation/Foundation.h>

/// Reads the current app limit on every admission; this is not physical RAM.
@interface PAPMemoryAdmission : NSObject
+ (NSUInteger)availableBytes;
@end
