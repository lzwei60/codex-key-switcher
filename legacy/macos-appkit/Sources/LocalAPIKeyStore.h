#import "AIKeySwitcherShared.h"

@interface LocalAPIKeyStore : NSObject
- (BOOL)saveAPIKey:(NSString *)apiKey forId:(NSString *)providerId error:(NSError **)error;
- (NSString *)apiKeyForId:(NSString *)providerId;
- (void)deleteAPIKeyForId:(NSString *)providerId;
@end
