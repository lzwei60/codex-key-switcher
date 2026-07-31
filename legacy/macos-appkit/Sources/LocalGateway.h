#import "AIKeySwitcherShared.h"
#import "ProviderStore.h"
#import "UsageStore.h"

@interface LocalGateway : NSObject
@property(nonatomic, assign) BOOL running;
- (instancetype)initWithStore:(ProviderStore *)store usageStore:(UsageStore *)usageStore;
- (BOOL)start:(NSError **)error;
- (BOOL)startAllowingPortFallback:(NSError **)error changedPort:(NSInteger *)changedPort;
- (BOOL)restart:(NSError **)error;
- (BOOL)restartAllowingPortFallback:(NSError **)error changedPort:(NSInteger *)changedPort;
- (void)stop;
- (NSString *)endpointText;
@end
