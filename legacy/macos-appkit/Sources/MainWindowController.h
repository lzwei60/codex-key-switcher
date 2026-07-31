#import "AIKeySwitcherShared.h"
#import "ProviderStore.h"
#import "LocalGateway.h"
#import "UsageStore.h"

@interface MainWindowController : NSWindowController <NSTextFieldDelegate>
- (instancetype)initWithStore:(ProviderStore *)store gateway:(LocalGateway *)gateway usageStore:(UsageStore *)usageStore;
- (void)reload;
@end
