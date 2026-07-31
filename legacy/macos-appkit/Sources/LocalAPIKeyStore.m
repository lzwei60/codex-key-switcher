#import "LocalAPIKeyStore.h"

@implementation LocalAPIKeyStore {
    NSURL *_fileURL;
    NSMutableDictionary<NSString *, NSString *> *_keys;
}

- (instancetype)init {
    self = [super init];
    if (!self) return nil;

    _fileURL = [NSURL fileURLWithPath:AppSupportPath(@"api-keys.json")];
    _keys = [NSMutableDictionary dictionary];

    NSData *data = [NSData dataWithContentsOfURL:_fileURL];
    NSDictionary *stored = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    if ([stored isKindOfClass:NSDictionary.class]) {
        [stored enumerateKeysAndObjectsUsingBlock:^(id key, id value, BOOL *stop) {
            (void)stop;
            if ([key isKindOfClass:NSString.class] && [value isKindOfClass:NSString.class]) {
                self->_keys[key] = value;
            }
        }];
    }
    return self;
}

- (BOOL)writeKeys:(NSError **)error {
    NSData *data = [NSJSONSerialization dataWithJSONObject:_keys options:NSJSONWritingPrettyPrinted error:error];
    if (!data) return NO;

    NSURL *directoryURL = [_fileURL URLByDeletingLastPathComponent];
    [NSFileManager.defaultManager createDirectoryAtURL:directoryURL
                           withIntermediateDirectories:YES
                                            attributes:@{NSFilePosixPermissions: @0700}
                                                 error:nil];
    [NSFileManager.defaultManager setAttributes:@{NSFilePosixPermissions: @0700} ofItemAtPath:directoryURL.path error:nil];
    BOOL ok = [data writeToURL:_fileURL options:NSDataWritingAtomic error:error];
    if (!ok) return NO;

    [NSFileManager.defaultManager setAttributes:@{NSFilePosixPermissions: @0600} ofItemAtPath:_fileURL.path error:nil];
    return YES;
}

- (BOOL)saveAPIKey:(NSString *)apiKey forId:(NSString *)providerId error:(NSError **)error {
    NSString *trimmedId = [providerId aks_trimmed];
    if (trimmedId.length == 0) {
        if (error) *error = [NSError errorWithDomain:AppName code:70 userInfo:@{NSLocalizedDescriptionKey: @"配置 ID 为空，无法保存 API Key。"}];
        return NO;
    }

    _keys[trimmedId] = apiKey ?: @"";
    return [self writeKeys:error];
}

- (NSString *)apiKeyForId:(NSString *)providerId {
    NSString *trimmedId = [providerId aks_trimmed];
    return trimmedId.length > 0 ? _keys[trimmedId] : nil;
}

- (void)deleteAPIKeyForId:(NSString *)providerId {
    NSString *trimmedId = [providerId aks_trimmed];
    if (trimmedId.length == 0) return;
    [_keys removeObjectForKey:trimmedId];
    [self writeKeys:nil];
}
@end
