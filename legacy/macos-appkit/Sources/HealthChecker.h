#import "AIKeySwitcherShared.h"
#import "ProviderStore.h"
#import "LocalGateway.h"

typedef NS_ENUM(NSInteger, AKSHealthLevel) {
    AKSHealthLevelOK,
    AKSHealthLevelWarning,
    AKSHealthLevelError
};

@interface AKSHealthReport : NSObject
@property(nonatomic, assign) AKSHealthLevel level;
@property(nonatomic, copy) NSString *title;
@property(nonatomic, copy) NSString *message;
@property(nonatomic, assign) BOOL gatewayRunning;
@property(nonatomic, assign) BOOL routeEnabled;
@property(nonatomic, assign) BOOL codexUsesGateway;
@property(nonatomic, assign) BOOL restoreAvailable;
@property(nonatomic, copy) NSString *currentProviderName;
@property(nonatomic, copy) NSString *currentModel;
@property(nonatomic, copy) NSString *endpoint;
@property(nonatomic, copy) NSString *codexDirectory;
@property(nonatomic, copy) NSString *restoreScriptPath;
- (NSString *)diagnosticText;
@end

@interface HealthChecker : NSObject
+ (AKSHealthReport *)checkWithGateway:(LocalGateway *)gateway store:(ProviderStore *)store;
@end
