#import "AIKeySwitcherShared.h"

@interface UsageStore : NSObject
- (void)recordProvider:(NSString *)provider model:(NSString *)model status:(NSInteger)status durationMs:(double)durationMs usage:(NSDictionary *)usage source:(NSString *)source;
- (NSArray<NSDictionary *> *)snapshot;
@end
