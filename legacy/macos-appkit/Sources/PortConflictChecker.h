#import "AIKeySwitcherShared.h"

@interface PortConflictChecker : NSObject
+ (BOOL)portHasAnyListener:(NSInteger)port excludingPID:(pid_t)pid;
+ (NSInteger)firstSafePortFrom:(NSInteger)startPort maxAttempts:(NSInteger)maxAttempts;
@end
