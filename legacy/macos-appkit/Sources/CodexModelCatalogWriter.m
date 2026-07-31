#import "CodexModelCatalogWriter.h"

@implementation CodexModelCatalogWriter
+ (NSURL *)modelsCacheURL {
    return [CodexDirectoryURL() URLByAppendingPathComponent:@"models_cache.json"];
}

+ (NSURL *)backupURLForURL:(NSURL *)url {
    return [NSURL fileURLWithPath:[url.path stringByAppendingString:ManagedBackupSuffix]];
}

+ (void)backupFileIfNeeded:(NSURL *)url {
    if (![NSFileManager.defaultManager fileExistsAtPath:url.path]) return;
    NSURL *backupURL = [self backupURLForURL:url];
    if ([NSFileManager.defaultManager fileExistsAtPath:backupURL.path]) return;
    [NSFileManager.defaultManager copyItemAtURL:url toURL:backupURL error:nil];
}

+ (NSArray<NSDictionary *> *)defaultResponsesModels {
    return @[
        @{@"slug": @"mimo-v2.5-pro", @"display": @"MiMo v2.5 Pro", @"description": @"Xiaomi MiMo native Responses model.", @"context": @272000},
        @{@"slug": @"mimo-v2.5", @"display": @"MiMo v2.5", @"description": @"Xiaomi MiMo native Responses model.", @"context": @272000},
        @{@"slug": @"doubao-seed-2-0-pro-260215", @"display": @"Doubao Seed 2.0 Pro", @"description": @"Volcano Ark Doubao native Responses model.", @"context": @272000},
        @{@"slug": @"doubao-seed-2-0-lite-260215", @"display": @"Doubao Seed 2.0 Lite", @"description": @"Volcano Ark Doubao native Responses model.", @"context": @272000},
        @{@"slug": @"qwen3-coder-plus", @"display": @"Qwen3 Coder Plus", @"description": @"Alibaba Cloud Qwen3-Coder native Responses model.", @"context": @1000000},
        @{@"slug": @"qwen3-coder-flash", @"display": @"Qwen3 Coder Flash", @"description": @"Alibaba Cloud Qwen3-Coder native Responses model.", @"context": @1000000},
        @{@"slug": @"qwen3-coder-next", @"display": @"Qwen3 Coder Next", @"description": @"Alibaba Cloud Qwen3-Coder native Responses model.", @"context": @262144},
        @{@"slug": @"deepseek-v4-flash", @"display": @"DeepSeek V4 Flash", @"description": @"DeepSeek OpenAI-compatible Chat Completions model.", @"context": @128000},
        @{@"slug": @"deepseek-v4-pro", @"display": @"DeepSeek V4 Pro", @"description": @"DeepSeek OpenAI-compatible Chat Completions model.", @"context": @128000},
        @{@"slug": @"LongCat-2.0", @"display": @"LongCat 2.0", @"description": @"Meituan LongCat OpenAI-compatible model.", @"context": @1000000},
        @{@"slug": @"MiniMax-M2", @"display": @"MiniMax M2", @"description": @"MiniMax OpenAI-compatible Responses model.", @"context": @272000},
        @{@"slug": @"MiniMax-M1", @"display": @"MiniMax M1", @"description": @"MiniMax OpenAI-compatible Responses model.", @"context": @272000}
    ];
}

+ (NSDictionary *)templateModelFromModels:(NSArray *)models {
    NSDictionary *firstVisible = nil;
    for (NSDictionary *model in models) {
        if (![model isKindOfClass:NSDictionary.class]) continue;
        if ([model[@"slug"] isEqualToString:@"gpt-5.5"]) return model;
        if (!firstVisible && [model[@"visibility"] isEqualToString:@"list"]) firstVisible = model;
    }
    return firstVisible ?: models.firstObject;
}

+ (BOOL)provider:(NSDictionary *)provider containsCatalogModel:(NSString *)catalogModel {
    NSString *target = TrimString(catalogModel);
    if (target.length == 0 || !provider) return NO;
    for (NSDictionary *model in ProviderModels(provider)) {
        if ([target isEqualToString:ProviderCatalogSlug(provider, model)]) return YES;
    }
    return NO;
}

+ (NSDictionary<NSString *, NSNumber *> *)currentProviderPrioritiesForProviders:(NSArray<NSDictionary *> *)providers currentModel:(NSString *)currentModel {
    NSString *target = TrimString(currentModel);
    if (target.length == 0) return @{};

    NSDictionary *currentProvider = nil;
    for (NSDictionary *provider in providers) {
        if ([self provider:provider containsCatalogModel:target]) {
            currentProvider = provider;
            break;
        }
    }
    if (!currentProvider) return @{};

    NSMutableDictionary<NSString *, NSNumber *> *priorities = [NSMutableDictionary dictionary];
    NSInteger siblingPriority = 119;
    for (NSDictionary *model in ProviderModels(currentProvider)) {
        NSString *slug = ProviderCatalogSlug(currentProvider, model);
        if (slug.length == 0) continue;
        if ([slug isEqualToString:target]) {
            priorities[slug] = @120;
        } else {
            priorities[slug] = @(siblingPriority);
            siblingPriority = MAX((NSInteger)100, siblingPriority - 1);
        }
    }
    return priorities;
}

+ (NSMutableDictionary *)entryFromTemplate:(NSDictionary *)template metadata:(NSDictionary *)metadata priority:(NSInteger)priority {
    NSMutableDictionary *entry = [template mutableCopy];
    NSString *slug = metadata[@"slug"] ?: @"";
    NSNumber *context = metadata[@"context"];
    entry[@"slug"] = slug;
    entry[@"display_name"] = metadata[@"display"] ?: slug;
    entry[@"description"] = metadata[@"description"] ?: @"Native Responses model exposed through Codex Key Switcher.";
    entry[@"visibility"] = @"list";
    entry[@"supported_in_api"] = @YES;
    entry[@"priority"] = @(priority);
    if ([context isKindOfClass:NSNumber.class] && context.integerValue > 0) {
        entry[@"context_window"] = context;
        entry[@"max_context_window"] = context;
    }
    return entry;
}

+ (NSArray<NSDictionary *> *)metadataForProvider:(NSDictionary *)provider {
    NSMutableArray<NSDictionary *> *items = [NSMutableArray array];
    NSString *providerName = [provider[@"name"] aks_trimmed];
    NSString *providerId = TrimString(provider[@"id"]);
    for (NSDictionary *model in ProviderModels(provider)) {
        NSString *customName = ModelCustomName(model);
        NSString *upstreamModel = TrimString(model[@"model"]);
        if (customName.length == 0 || upstreamModel.length == 0) continue;
        NSString *display = providerName.length > 0 ? [NSString stringWithFormat:@"%@: %@", providerName, customName] : customName;
        NSMutableDictionary *metadata = [@{
            @"slug": ProviderCatalogSlug(provider, model),
            @"display": display,
            @"description": [NSString stringWithFormat:@"User configured Responses model %@ exposed through Codex Key Switcher.", upstreamModel],
            @"context": @272000
        } mutableCopy];
        if (providerId.length > 0) metadata[@"providerId"] = providerId;
        [items addObject:metadata];
    }
    return items;
}

+ (BOOL)applyCatalogForProviders:(NSArray<NSDictionary *> *)providers currentModel:(NSString *)currentModel error:(NSError **)error {
    NSURL *url = [self modelsCacheURL];
    if (![NSFileManager.defaultManager fileExistsAtPath:url.path]) {
        if (error) *error = nil;
        return YES;
    }

    NSData *data = [NSData dataWithContentsOfURL:url options:0 error:error];
    if (!data) return NO;

    NSMutableDictionary *payload = [[NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingMutableContainers error:error] mutableCopy];
    if (![payload isKindOfClass:NSMutableDictionary.class]) {
        if (error) *error = [NSError errorWithDomain:AppName code:60 userInfo:@{NSLocalizedDescriptionKey: @"models_cache.json 不是合法 JSON 对象。"}];
        return NO;
    }

    NSMutableArray *models = [payload[@"models"] mutableCopy];
    if (![models isKindOfClass:NSMutableArray.class] || models.count == 0) {
        if (error) *error = [NSError errorWithDomain:AppName code:61 userInfo:@{NSLocalizedDescriptionKey: @"models_cache.json 未包含可克隆的 models 条目。"}];
        return NO;
    }

    NSDictionary *templateModel = [self templateModelFromModels:models];
    if (!templateModel) {
        if (error) *error = [NSError errorWithDomain:AppName code:62 userInfo:@{NSLocalizedDescriptionKey: @"未找到可用的 Codex 模型模板。"}];
        return NO;
    }

    NSMutableDictionary<NSString *, NSNumber *> *indexBySlug = [NSMutableDictionary dictionary];
    for (NSUInteger index = 0; index < models.count; index++) {
        NSDictionary *model = models[index];
        NSString *slug = [model isKindOfClass:NSDictionary.class] ? model[@"slug"] : nil;
        if (slug.length > 0) indexBySlug[slug] = @(index);
    }

    NSArray<NSDictionary *> *defaultModels = [self defaultResponsesModels];
    NSMutableSet<NSString *> *defaultSlugs = [NSMutableSet set];
    for (NSDictionary *model in defaultModels) {
        NSString *slug = model[@"slug"];
        if (slug.length > 0) [defaultSlugs addObject:slug];
    }

    NSMutableArray<NSDictionary *> *desired = [defaultModels mutableCopy];
    for (NSDictionary *provider in providers) {
        [desired addObjectsFromArray:[self metadataForProvider:provider]];
    }

    BOOL changed = NO;
    NSDictionary<NSString *, NSNumber *> *currentProviderPriorities = [self currentProviderPrioritiesForProviders:providers currentModel:currentModel];
    NSInteger priority = 30;
    for (NSDictionary *metadata in desired) {
        NSString *slug = metadata[@"slug"];
        if (slug.length == 0) continue;
        NSNumber *currentProviderPriority = currentProviderPriorities[slug];
        NSInteger entryPriority = currentProviderPriority ? currentProviderPriority.integerValue : priority;
        NSMutableDictionary *entry = [self entryFromTemplate:templateModel metadata:metadata priority:entryPriority];

        NSNumber *existingIndex = indexBySlug[slug];
        if (existingIndex) {
            NSMutableDictionary *existing = [models[existingIndex.unsignedIntegerValue] mutableCopy];
            NSString *existingDescription = existing[@"description"] ?: @"";
            BOOL existingLooksManaged = [existingDescription rangeOfString:@"Codex Key Switcher"].location != NSNotFound ||
                                        [existingDescription rangeOfString:@"native Responses model"].location != NSNotFound ||
                                        [existingDescription rangeOfString:@"OpenAI-compatible Responses model"].location != NSNotFound;
            if (![defaultSlugs containsObject:slug] && !existingLooksManaged) {
                continue;
            }

            BOOL needsUpdate = NO;
            for (NSString *key in @[@"display_name", @"description", @"visibility", @"supported_in_api", @"priority", @"context_window", @"max_context_window"]) {
                id nextValue = entry[key];
                if (nextValue && ![existing[key] isEqual:nextValue]) {
                    existing[key] = nextValue;
                    needsUpdate = YES;
                }
            }
            if (needsUpdate) {
                models[existingIndex.unsignedIntegerValue] = existing;
                changed = YES;
            }
        } else {
            [models addObject:entry];
            indexBySlug[slug] = @(models.count - 1);
            changed = YES;
        }
        priority = MAX(1, priority - 1);
    }

    if (!changed) return YES;
    payload[@"models"] = models;
    NSData *updatedData = [NSJSONSerialization dataWithJSONObject:payload options:NSJSONWritingPrettyPrinted error:error];
    if (!updatedData) return NO;
    [self backupFileIfNeeded:url];
    return [updatedData writeToURL:url options:NSDataWritingAtomic error:error];
}

@end
