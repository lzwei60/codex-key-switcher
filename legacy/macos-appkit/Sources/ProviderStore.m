#import "ProviderStore.h"
#import "LocalAPIKeyStore.h"

@implementation ProviderStore {
    NSURL *_fileURL;
    LocalAPIKeyStore *_apiKeyStore;
    NSMutableDictionary<NSString *, NSString *> *_apiKeyCache;
}

- (instancetype)init {
    self = [super init];
    if (!self) return nil;

    _apiKeyStore = [[LocalAPIKeyStore alloc] init];
    _apiKeyCache = [NSMutableDictionary dictionary];
    _providers = [NSMutableArray array];

    NSURL *supportURL = [[NSFileManager.defaultManager URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask].firstObject URLByAppendingPathComponent:AppName isDirectory:YES];
    [NSFileManager.defaultManager createDirectoryAtURL:supportURL withIntermediateDirectories:YES attributes:nil error:nil];
    [NSFileManager.defaultManager setAttributes:@{NSFilePosixPermissions: @0700} ofItemAtPath:supportURL.path error:nil];
    _fileURL = [supportURL URLByAppendingPathComponent:@"providers.json"];
    [self load];
    return self;
}

- (NSDictionary *)currentProvider {
    if (self.currentId.length == 0) return nil;
    for (NSDictionary *provider in self.providers) {
        if ([provider[@"id"] isEqualToString:self.currentId]) return provider;
    }
    return nil;
}

- (NSString *)defaultCurrentProviderId {
    for (NSDictionary *provider in self.providers) {
        NSString *providerId = TrimString(provider[@"id"]);
        if (providerId.length == 0) continue;
        if ([self apiKeyForProvider:provider].length > 0) return providerId;
    }
    return TrimString(self.providers.firstObject[@"id"]);
}

- (void)repairCurrentProviderSelectionIfNeeded {
    if (self.providers.count == 0) {
        self.currentId = @"";
        return;
    }
    if ([self currentProvider]) return;

    NSString *providerId = [self defaultCurrentProviderId];
    if (providerId.length == 0) return;
    self.currentId = providerId;
    [self save:nil];
}

- (NSString *)apiKeyForProvider:(NSDictionary *)provider {
    NSString *providerId = provider[@"id"];
    if (providerId.length == 0) return nil;

    NSString *cachedAPIKey = _apiKeyCache[providerId];
    if (cachedAPIKey.length > 0) return cachedAPIKey;

    NSString *storedAPIKey = [_apiKeyStore apiKeyForId:providerId];
    if (storedAPIKey.length > 0) {
        _apiKeyCache[providerId] = storedAPIKey;
    }
    return storedAPIKey;
}

- (NSString *)displayAPIKeyForProvider:(NSDictionary *)provider {
    NSString *providerId = provider[@"id"];
    NSString *cachedAPIKey = providerId.length > 0 ? _apiKeyCache[providerId] : nil;
    if (cachedAPIKey.length > 0) return [cachedAPIKey aks_maskedKey];

    NSString *storedAPIKey = providerId.length > 0 ? [_apiKeyStore apiKeyForId:providerId] : nil;
    if (storedAPIKey.length > 0) {
        _apiKeyCache[providerId] = storedAPIKey;
        return [storedAPIKey aks_maskedKey];
    }

    return AKSText(@"需要重新填写 Key", @"Re-enter API Key");
}

- (BOOL)upsertProviderId:(NSString *)providerId name:(NSString *)name apiKey:(NSString *)apiKey baseURL:(NSString *)baseURL apiFormat:(NSString *)apiFormat models:(NSArray<NSDictionary *> *)models tag:(NSString *)tag error:(NSError **)error {
    NSString *nextId = providerId.length > 0 ? providerId : NSUUID.UUID.UUIDString;
    NSString *nextName = [name aks_trimmed];
    NSString *nextKey = [apiKey aks_trimmed];
    NSString *nextBaseURL = [baseURL aks_trimTrailingSlashes];
    NSString *nextAPIFormat = ProviderAPIFormat(@{@"apiFormat": apiFormat ?: @""});
    NSString *nextTag = [tag aks_trimmed];
    NSMutableArray<NSDictionary *> *nextModels = [NSMutableArray array];
    NSMutableSet<NSString *> *customNames = [NSMutableSet set];
    for (NSDictionary *model in models ?: @[]) {
        NSString *customName = TrimString(model[@"customName"]);
        NSString *upstreamModel = TrimString(model[@"model"]);
        if (customName.length == 0 || upstreamModel.length == 0) continue;
        if ([customNames containsObject:customName]) {
            if (error) *error = [NSError errorWithDomain:AppName code:4 userInfo:@{NSLocalizedDescriptionKey: [NSString stringWithFormat:@"模型自定义名称重复：%@", customName]}];
            return NO;
        }
        [customNames addObject:customName];
        [nextModels addObject:@{@"customName": customName, @"model": upstreamModel}];
    }

    NSUInteger existingIndex = NSNotFound;
    NSDictionary *existingProvider = nil;
    for (NSUInteger index = 0; index < self.providers.count; index++) {
        if ([self.providers[index][@"id"] isEqualToString:nextId]) {
            existingIndex = index;
            existingProvider = self.providers[index];
            break;
        }
    }

    BOOL isNewProvider = existingProvider == nil;
    if (nextName.length == 0 || nextBaseURL.length == 0 || nextModels.count == 0 || (isNewProvider && nextKey.length == 0)) {
        if (error) *error = [NSError errorWithDomain:AppName code:1 userInfo:@{NSLocalizedDescriptionKey: @"名称、Base URL、至少一个模型都必须填写；新增配置必须填写 API Key。"}];
        return NO;
    }

    if (!isNewProvider && nextKey.length == 0 && [_apiKeyStore apiKeyForId:nextId].length == 0) {
        if (error) *error = [NSError errorWithDomain:AppName code:5 userInfo:@{NSLocalizedDescriptionKey: @"当前配置没有本地保存的 API Key。为避免访问钥匙串弹窗，请重新填写 API Key 后保存。"}];
        return NO;
    }

    NSURL *url = [NSURL URLWithString:nextBaseURL];
    if (url.scheme.length == 0 || !([url.scheme isEqualToString:@"http"] || [url.scheme isEqualToString:@"https"])) {
        if (error) *error = [NSError errorWithDomain:AppName code:2 userInfo:@{NSLocalizedDescriptionKey: @"Base URL 必须是 http 或 https 地址。"}];
        return NO;
    }

    if (nextKey.length > 0) {
        if (![_apiKeyStore saveAPIKey:nextKey forId:nextId error:error]) return NO;
        _apiKeyCache[nextId] = nextKey;
    }

    NSString *keyPreview = nextKey.length > 0 ? [nextKey aks_maskedKey] : existingProvider[@"keyPreview"];
    if (keyPreview.length == 0) keyPreview = @"本地已保存";

    NSMutableDictionary *provider = [@{
        @"id": nextId,
        @"name": nextName,
        @"baseURL": nextBaseURL,
        @"apiFormat": nextAPIFormat,
        @"models": nextModels,
        @"model": nextModels.firstObject[@"customName"] ?: nextModels.firstObject[@"model"] ?: @"",
        @"tag": nextTag,
        @"keyPreview": keyPreview,
        @"updatedAt": existingProvider[@"updatedAt"] ?: @((long long)(NSDate.date.timeIntervalSince1970))
    } mutableCopy];

    if (existingIndex == NSNotFound) {
        [self.providers addObject:provider];
    } else {
        self.providers[existingIndex] = provider;
    }

    [self sortProvidersByUpdatedAtAscending];

    if (self.currentId.length == 0) {
        self.currentId = nextId;
    }

    BOOL saved = [self save:error];
    if (saved && self.onChange) self.onChange();
    return saved;
}

- (BOOL)setCurrentId:(NSString *)providerId error:(NSError **)error {
    return [self setCurrentId:providerId notifyCodex:YES error:error];
}

- (BOOL)setCurrentId:(NSString *)providerId notifyCodex:(BOOL)notifyCodex error:(NSError **)error {
    BOOL exists = NO;
    for (NSDictionary *provider in self.providers) {
        if ([provider[@"id"] isEqualToString:providerId]) {
            exists = YES;
            break;
        }
    }

    if (!exists) {
        if (error) *error = [NSError errorWithDomain:AppName code:3 userInfo:@{NSLocalizedDescriptionKey: @"配置不存在。"}];
        return NO;
    }

    self.currentId = providerId;
    BOOL saved = [self save:error];
    if (saved && notifyCodex && self.onChange) {
        self.onChange();
    } else if (saved) {
        [NSNotificationCenter.defaultCenter postNotificationName:ProviderRouteSelectionDidChangeNotification object:self];
    }
    return saved;
}

- (BOOL)setSelectedModel:(NSString *)model forProviderId:(NSString *)providerId error:(NSError **)error {
    return [self setSelectedModel:model forProviderId:providerId notifyCodex:YES error:error];
}

- (BOOL)setSelectedModel:(NSString *)model forProviderId:(NSString *)providerId notifyCodex:(BOOL)notifyCodex error:(NSError **)error {
    NSString *targetProviderId = TrimString(providerId);
    NSString *targetModel = TrimString(model);
    if (targetProviderId.length == 0 || targetModel.length == 0) {
        if (error) *error = [NSError errorWithDomain:AppName code:6 userInfo:@{NSLocalizedDescriptionKey: @"供应商或模型为空，无法切换模型。"}];
        return NO;
    }

    for (NSUInteger index = 0; index < self.providers.count; index++) {
        NSMutableDictionary *provider = [self.providers[index] mutableCopy];
        if (![provider[@"id"] isEqualToString:targetProviderId]) continue;

        BOOL modelExists = NO;
        NSString *selectedName = targetModel;
        for (NSDictionary *modelInfo in ProviderModels(provider)) {
            NSString *customName = ModelCustomName(modelInfo);
            NSString *upstreamModel = TrimString(modelInfo[@"model"]);
            NSString *catalogSlug = ProviderCatalogSlug(provider, modelInfo);
            if ([targetModel isEqualToString:catalogSlug] || [targetModel isEqualToString:customName] || [targetModel isEqualToString:upstreamModel]) {
                selectedName = customName.length > 0 ? customName : upstreamModel;
                modelExists = YES;
                break;
            }
        }

        if (!modelExists) {
            if (error) *error = [NSError errorWithDomain:AppName code:7 userInfo:@{NSLocalizedDescriptionKey: @"模型不存在，无法切换。"}];
            return NO;
        }

        provider[@"model"] = selectedName;
        self.providers[index] = provider;
        BOOL saved = [self save:error];
        if (saved && notifyCodex && self.onChange) {
            self.onChange();
        } else if (saved) {
            [NSNotificationCenter.defaultCenter postNotificationName:ProviderRouteSelectionDidChangeNotification object:self];
        }
        return saved;
    }

    if (error) *error = [NSError errorWithDomain:AppName code:3 userInfo:@{NSLocalizedDescriptionKey: @"配置不存在。"}];
    return NO;
}

- (BOOL)deleteProviderId:(NSString *)providerId error:(NSError **)error {
    NSIndexSet *indexes = [self.providers indexesOfObjectsPassingTest:^BOOL(NSDictionary *provider, NSUInteger index, BOOL *stop) {
        (void)index;
        (void)stop;
        return [provider[@"id"] isEqualToString:providerId];
    }];
    [self.providers removeObjectsAtIndexes:indexes];
    [_apiKeyStore deleteAPIKeyForId:providerId];
    [_apiKeyCache removeObjectForKey:providerId];
    if ([self.currentId isEqualToString:providerId]) {
        self.currentId = self.providers.firstObject[@"id"];
    }

    BOOL saved = [self save:error];
    if (saved && self.onChange) self.onChange();
    return saved;
}
- (NSDictionary *)exportPayloadIncludingAPIKeys:(BOOL)includeAPIKeys {
    NSMutableArray<NSDictionary *> *items = [NSMutableArray array];
    for (NSDictionary *provider in self.providers) {
        NSMutableDictionary *item = [provider mutableCopy];
        [item removeObjectForKey:@"keyPreview"];
        if (includeAPIKeys) {
            NSString *apiKey = [self apiKeyForProvider:provider];
            if (apiKey.length > 0) item[@"apiKey"] = apiKey;
        }
        [items addObject:item];
    }
    return @{
        @"codexKeySwitcherExportVersion": @1,
        @"exportedAt": @((long long)NSDate.date.timeIntervalSince1970),
        @"includesAPIKeys": @(includeAPIKeys),
        @"providers": items
    };
}
- (NSUInteger)indexForImportedProvider:(NSDictionary *)incoming {
    NSString *incomingId = TrimString(incoming[@"id"]);
    if (incomingId.length > 0) {
        for (NSUInteger index = 0; index < self.providers.count; index++) {
            if ([self.providers[index][@"id"] isEqualToString:incomingId]) return index;
        }
    }

    NSString *incomingName = TrimString(incoming[@"name"]);
    NSString *incomingBaseURL = [TrimString(incoming[@"baseURL"]) aks_trimTrailingSlashes];
    if (incomingName.length == 0 || incomingBaseURL.length == 0) return NSNotFound;
    for (NSUInteger index = 0; index < self.providers.count; index++) {
        NSDictionary *provider = self.providers[index];
        if ([TrimString(provider[@"name"]) isEqualToString:incomingName] &&
            [[TrimString(provider[@"baseURL"]) aks_trimTrailingSlashes] isEqualToString:incomingBaseURL]) {
            return index;
        }
    }
    return NSNotFound;
}
- (NSArray<NSDictionary *> *)normalizedImportedModels:(NSArray *)models {
    NSMutableArray<NSDictionary *> *normalized = [NSMutableArray array];
    NSMutableSet<NSString *> *customNames = [NSMutableSet set];
    for (NSDictionary *model in models ?: @[]) {
        if (![model isKindOfClass:NSDictionary.class]) continue;
        NSString *customName = ModelCustomName(model);
        NSString *upstreamModel = TrimString(model[@"model"]);
        if (customName.length == 0 || upstreamModel.length == 0 || [customNames containsObject:customName]) continue;
        [customNames addObject:customName];
        [normalized addObject:@{@"customName": customName, @"model": upstreamModel}];
    }
    return normalized;
}
- (NSUInteger)importPayload:(NSDictionary *)payload error:(NSError **)error {
    NSArray *providers = payload[@"providers"];
    if (![providers isKindOfClass:NSArray.class]) {
        if (error) *error = [NSError errorWithDomain:AppName code:80 userInfo:@{NSLocalizedDescriptionKey: @"导入文件格式无效：缺少 providers 列表。"}];
        return 0;
    }

    NSUInteger importedCount = 0;
    for (NSDictionary *incoming in providers) {
        if (![incoming isKindOfClass:NSDictionary.class]) continue;
        NSString *name = TrimString(incoming[@"name"]);
        NSString *baseURL = [TrimString(incoming[@"baseURL"]) aks_trimTrailingSlashes];
        NSArray<NSDictionary *> *models = [self normalizedImportedModels:incoming[@"models"]];
        if (name.length == 0 || baseURL.length == 0 || models.count == 0) continue;

        NSURL *url = [NSURL URLWithString:baseURL];
        if (url.scheme.length == 0 || !([url.scheme isEqualToString:@"http"] || [url.scheme isEqualToString:@"https"])) continue;

        NSUInteger existingIndex = [self indexForImportedProvider:incoming];
        NSDictionary *existingProvider = existingIndex == NSNotFound ? nil : self.providers[existingIndex];
        NSString *providerId = existingProvider[@"id"] ?: TrimString(incoming[@"id"]);
        if (providerId.length == 0) providerId = NSUUID.UUID.UUIDString;

        NSString *apiKey = TrimString(incoming[@"apiKey"]);
        if (apiKey.length > 0 && ![_apiKeyStore saveAPIKey:apiKey forId:providerId error:error]) return importedCount;
        if (apiKey.length > 0) _apiKeyCache[providerId] = apiKey;

        NSString *keyPreview = existingProvider[@"keyPreview"];
        if (apiKey.length > 0) keyPreview = [apiKey aks_maskedKey];
        if (keyPreview.length == 0) keyPreview = AKSText(@"需要重新填写 Key", @"Re-enter API Key");

        NSMutableDictionary *provider = [@{
            @"id": providerId,
            @"name": name,
            @"baseURL": baseURL,
            @"apiFormat": ProviderAPIFormat(incoming),
            @"models": models,
            @"model": models.firstObject[@"customName"] ?: models.firstObject[@"model"] ?: @"",
            @"tag": TrimString(incoming[@"tag"]),
            @"keyPreview": keyPreview,
            @"updatedAt": existingProvider[@"updatedAt"] ?: incoming[@"updatedAt"] ?: @((long long)NSDate.date.timeIntervalSince1970)
        } mutableCopy];

        if (existingIndex == NSNotFound) {
            [self.providers addObject:provider];
        } else {
            self.providers[existingIndex] = provider;
        }
        importedCount++;
    }

    [self sortProvidersByUpdatedAtAscending];
    if (self.currentId.length == 0 && self.providers.count > 0) {
        self.currentId = self.providers.firstObject[@"id"];
    }
    BOOL saved = [self save:error];
    if (saved && importedCount > 0 && self.onChange) self.onChange();
    return saved ? importedCount : 0;
}

- (void)load {
    NSData *data = [NSData dataWithContentsOfURL:_fileURL];
    if (!data) return;

    NSDictionary *payload = [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingMutableContainers error:nil];
    NSArray *providers = payload[@"providers"];
    if ([providers isKindOfClass:NSArray.class]) {
        self.providers = [providers mutableCopy];
        [self sortProvidersByUpdatedAtAscending];
    }
    NSString *currentId = payload[@"currentId"];
    if ([currentId isKindOfClass:NSString.class]) {
        self.currentId = currentId;
    }
    [self repairCurrentProviderSelectionIfNeeded];
}

- (BOOL)save:(NSError **)error {
    NSDictionary *payload = @{
        @"providers": self.providers ?: @[],
        @"currentId": self.currentId ?: @""
    };
    NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:NSJSONWritingPrettyPrinted error:error];
    if (!data) return NO;
    BOOL ok = [data writeToURL:_fileURL options:NSDataWritingAtomic error:error];
    if (!ok) return NO;
    [NSFileManager.defaultManager setAttributes:@{NSFilePosixPermissions: @0600} ofItemAtPath:_fileURL.path error:nil];
    return YES;
}

- (void)sortProvidersByUpdatedAtAscending {
    [self.providers sortUsingComparator:^NSComparisonResult(NSDictionary *left, NSDictionary *right) {
        NSNumber *leftTime = left[@"updatedAt"] ?: @0;
        NSNumber *rightTime = right[@"updatedAt"] ?: @0;
        return [leftTime compare:rightTime];
    }];
}
@end
