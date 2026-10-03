#import "PocketAudioMemory.h"
#include <os/proc.h>

@implementation PAPMemoryAdmission
+ (NSUInteger)availableBytes {
  return os_proc_available_memory();
}
@end
