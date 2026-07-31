#import "AIKeySwitcherShared.h"

@interface ProviderConnectionTester : NSObject
+ (void)testBaseURL:(NSString *)baseURL apiKey:(NSString *)apiKey model:(NSString *)model apiFormat:(NSString *)apiFormat completion:(void (^)(BOOL ok, NSString *message))completion;
@end
