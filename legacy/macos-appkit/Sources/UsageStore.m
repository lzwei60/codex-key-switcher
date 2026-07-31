#import "UsageStore.h"

@implementation UsageStore {
    NSMutableArray<NSDictionary *> *_records;
    NSString *_filePath;
}

- (instancetype)init {
    self = [super init];
    if (!self) return nil;
    _filePath = AppSupportPath(@"usage-stats.json");
    NSData *data = [NSData dataWithContentsOfFile:_filePath];
    NSArray *stored = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    _records = [stored isKindOfClass:NSArray.class] ? [stored mutableCopy] : [NSMutableArray array];
    [NSFileManager.defaultManager setAttributes:@{NSFilePosixPermissions: @0600} ofItemAtPath:_filePath error:nil];
    return self;
}

- (void)recordProvider:(NSString *)provider model:(NSString *)model status:(NSInteger)status durationMs:(double)durationMs usage:(NSDictionary *)usage source:(NSString *)source {
    NSDictionary *record = @{
        @"timestamp": @([NSDate.date timeIntervalSince1970]),
        @"provider": provider ?: @"",
        @"model": model ?: @"",
        @"status": @(status),
        @"durationMs": @(MAX(0, durationMs)),
        @"inputTokens": usage[@"inputTokens"] ?: @0,
        @"outputTokens": usage[@"outputTokens"] ?: @0,
        @"totalTokens": usage[@"totalTokens"] ?: @0,
        @"cachedTokens": usage[@"cachedTokens"] ?: @0,
        @"cacheCreationTokens": usage[@"cacheCreationTokens"] ?: @0,
        @"source": source ?: @"local_gateway"
    };
    @synchronized (self) {
        [_records addObject:record];
        if (_records.count > 5000) {
            [_records removeObjectsInRange:NSMakeRange(0, _records.count - 5000)];
        }
        NSData *data = [NSJSONSerialization dataWithJSONObject:_records options:0 error:nil];
        [data writeToFile:_filePath options:NSDataWritingAtomic error:nil];
        [NSFileManager.defaultManager setAttributes:@{NSFilePosixPermissions: @0600} ofItemAtPath:_filePath error:nil];
    }
    dispatch_async(dispatch_get_main_queue(), ^{
        [NSNotificationCenter.defaultCenter postNotificationName:UsageStoreDidChangeNotification object:self];
    });
}

- (NSArray<NSDictionary *> *)snapshot {
    @synchronized (self) {
        return [_records copy];
    }
}
@end
