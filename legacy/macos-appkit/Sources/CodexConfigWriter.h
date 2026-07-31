#import "AIKeySwitcherShared.h"

@interface CodexConfigWriter : NSObject
+ (BOOL)applyLocalGatewayWithModel:(NSString *)model error:(NSError **)error;
+ (BOOL)restoreManagedBackup:(NSError **)error;
+ (BOOL)hasManagedBackup;
+ (BOOL)configUsesLocalGateway;
+ (NSString *)restoreScriptPath;
+ (NSString *)configuredModel;
+ (NSString *)configSummary;
@end
