#import "AIKeySwitcherShared.h"

@interface ProviderStore : NSObject
@property(nonatomic, strong) NSMutableArray<NSMutableDictionary *> *providers;
@property(nonatomic, copy) NSString *currentId;
@property(nonatomic, copy) void (^onChange)(void);
- (NSDictionary *)currentProvider;
- (NSString *)apiKeyForProvider:(NSDictionary *)provider;
- (NSString *)displayAPIKeyForProvider:(NSDictionary *)provider;
- (BOOL)upsertProviderId:(NSString *)providerId name:(NSString *)name apiKey:(NSString *)apiKey baseURL:(NSString *)baseURL apiFormat:(NSString *)apiFormat models:(NSArray<NSDictionary *> *)models tag:(NSString *)tag error:(NSError **)error;
- (BOOL)setCurrentId:(NSString *)providerId error:(NSError **)error;
- (BOOL)setCurrentId:(NSString *)providerId notifyCodex:(BOOL)notifyCodex error:(NSError **)error;
- (BOOL)setSelectedModel:(NSString *)model forProviderId:(NSString *)providerId error:(NSError **)error;
- (BOOL)setSelectedModel:(NSString *)model forProviderId:(NSString *)providerId notifyCodex:(BOOL)notifyCodex error:(NSError **)error;
- (BOOL)deleteProviderId:(NSString *)providerId error:(NSError **)error;
- (NSDictionary *)exportPayloadIncludingAPIKeys:(BOOL)includeAPIKeys;
- (NSUInteger)importPayload:(NSDictionary *)payload error:(NSError **)error;
@end
