#import "AIKeySwitcherShared.h"

@interface CodexModelCatalogWriter : NSObject
+ (BOOL)applyCatalogForProviders:(NSArray<NSDictionary *> *)providers currentModel:(NSString *)currentModel error:(NSError **)error;
@end
