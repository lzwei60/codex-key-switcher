#import "CodexConfigWriter.h"

static NSString * const ManagedProxyAppliedDefaultsKey = @"managedProxyApplied";
static NSString * const ManagedProxyEndpointDefaultsKey = @"managedProxyEndpoint";

@implementation CodexConfigWriter
+ (NSURL *)codexDirectoryURL {
    return CodexDirectoryURL();
}

+ (NSURL *)configURL {
    return [[self codexDirectoryURL] URLByAppendingPathComponent:@"config.toml"];
}

+ (NSURL *)authURL {
    return [[self codexDirectoryURL] URLByAppendingPathComponent:@"auth.json"];
}

+ (NSURL *)modelsCacheURL {
    return [[self codexDirectoryURL] URLByAppendingPathComponent:@"models_cache.json"];
}

+ (NSString *)restoreScriptPath {
    return AppSupportPath(@"restore-codex-config.command");
}

+ (NSURL *)backupURLForURL:(NSURL *)url suffix:(NSString *)suffix {
    return [NSURL fileURLWithPath:[url.path stringByAppendingString:suffix]];
}

+ (NSURL *)preferredBackupURLForURL:(NSURL *)url {
    return [self backupURLForURL:url suffix:ManagedBackupSuffix];
}

+ (NSURL *)existingBackupURLForURL:(NSURL *)url {
    NSURL *managedBackupURL = [self backupURLForURL:url suffix:ManagedBackupSuffix];
    if ([NSFileManager.defaultManager fileExistsAtPath:managedBackupURL.path]) return managedBackupURL;

    NSURL *legacyBackupURL = [self backupURLForURL:url suffix:LegacyBackupSuffix];
    if ([NSFileManager.defaultManager fileExistsAtPath:legacyBackupURL.path]) return legacyBackupURL;
    return nil;
}

+ (void)backupFileIfNeeded:(NSURL *)url {
    if (![NSFileManager.defaultManager fileExistsAtPath:url.path]) return;
    NSURL *backupURL = [self preferredBackupURLForURL:url];
    if ([NSFileManager.defaultManager fileExistsAtPath:backupURL.path]) return;
    [NSFileManager.defaultManager copyItemAtURL:url toURL:backupURL error:nil];
}

+ (NSString *)shellSingleQuotedString:(NSString *)value {
    NSString *escaped = [value ?: @"" stringByReplacingOccurrencesOfString:@"'" withString:@"'\\''"];
    return [NSString stringWithFormat:@"'%@'", escaped];
}

+ (BOOL)writeRestoreScriptWithError:(NSError **)error {
    NSString *configPath = [self configURL].path;
    NSString *authPath = [self authURL].path;
    NSString *modelsPath = [self modelsCacheURL].path;
    NSString *script = [NSString stringWithFormat:
        @"#!/bin/zsh\n"
         "set -euo pipefail\n\n"
         "CONFIG=%@\n"
         "AUTH=%@\n"
         "MODELS=%@\n"
         "CONFIG_BAK=\"${CONFIG}%@\"\n"
         "AUTH_BAK=\"${AUTH}%@\"\n"
         "MODELS_BAK=\"${MODELS}%@\"\n"
         "STAMP=$(date +%%Y%%m%%d%%H%%M%%S)\n\n"
         "if [[ ! -f \"$CONFIG_BAK\" || ! -f \"$AUTH_BAK\" ]]; then\n"
         "  echo \"Missing Codex Key Switcher backup files.\"\n"
         "  exit 1\n"
         "fi\n\n"
         "[[ -f \"$CONFIG\" ]] && cp \"$CONFIG\" \"${CONFIG}.before-restore.${STAMP}\"\n"
         "[[ -f \"$AUTH\" ]] && cp \"$AUTH\" \"${AUTH}.before-restore.${STAMP}\"\n"
         "[[ -f \"$MODELS\" ]] && cp \"$MODELS\" \"${MODELS}.before-restore.${STAMP}\"\n"
         "cp \"$CONFIG_BAK\" \"$CONFIG\"\n"
         "cp \"$AUTH_BAK\" \"$AUTH\"\n"
         "if [[ -f \"$MODELS_BAK\" ]]; then\n"
         "  cp \"$MODELS_BAK\" \"$MODELS\"\n"
         "fi\n"
         "echo \"Codex config restored. Restart Codex to apply it.\"\n",
         [self shellSingleQuotedString:configPath],
         [self shellSingleQuotedString:authPath],
         [self shellSingleQuotedString:modelsPath],
         ManagedBackupSuffix,
         ManagedBackupSuffix,
         ManagedBackupSuffix];

    NSString *scriptPath = [self restoreScriptPath];
    BOOL ok = [script writeToFile:scriptPath atomically:YES encoding:NSUTF8StringEncoding error:error];
    if (!ok) return NO;
    [NSFileManager.defaultManager setAttributes:@{NSFilePosixPermissions: @0700} ofItemAtPath:scriptPath error:nil];
    return YES;
}

+ (void)markManagedProxyApplied {
    [NSUserDefaults.standardUserDefaults setBool:YES forKey:ManagedProxyAppliedDefaultsKey];
    [NSUserDefaults.standardUserDefaults setObject:[self localGatewayEndpoint] forKey:ManagedProxyEndpointDefaultsKey];
    [NSUserDefaults.standardUserDefaults synchronize];
}

+ (void)clearManagedProxyApplied {
    [NSUserDefaults.standardUserDefaults setBool:NO forKey:ManagedProxyAppliedDefaultsKey];
    [NSUserDefaults.standardUserDefaults removeObjectForKey:ManagedProxyEndpointDefaultsKey];
    [NSUserDefaults.standardUserDefaults synchronize];
}

+ (NSString *)tomlString:(NSString *)value {
    NSString *escaped = [[value ?: @"" stringByReplacingOccurrencesOfString:@"\\" withString:@"\\\\"]
                         stringByReplacingOccurrencesOfString:@"\"" withString:@"\\\""];
    return [NSString stringWithFormat:@"\"%@\"", escaped];
}

+ (NSString *)configLineByRedactingSensitiveComment:(NSString *)line {
    NSString *trimmed = [line aks_trimmed];
    if (![trimmed hasPrefix:@"#"]) return line;

    NSString *lower = trimmed.lowercaseString;
    BOOL mentionsAPIKey = [lower rangeOfString:@"openai_api_key"].location != NSNotFound ||
                          [lower rangeOfString:@"api_key"].location != NSNotFound ||
                          [lower rangeOfString:@"api-key"].location != NSNotFound;
    if (!mentionsAPIKey) return line;

    NSRange equalRange = [line rangeOfString:@"="];
    if (equalRange.location == NSNotFound) return @"# API key redacted by Codex Key Switcher";
    return [[line substringToIndex:equalRange.location + 1] stringByAppendingString:@" \"<redacted>\""];
}

+ (BOOL)tomlLine:(NSString *)line hasKey:(NSString *)key {
    NSString *trimmed = [line aks_trimmed];
    if (trimmed.length == 0 || [trimmed hasPrefix:@"#"]) return NO;
    NSRange equalRange = [trimmed rangeOfString:@"="];
    if (equalRange.location == NSNotFound) return NO;
    NSString *left = [[trimmed substringToIndex:equalRange.location] aks_trimmed];
    return [left isEqualToString:key];
}

+ (NSString *)tomlValueForLine:(NSString *)line {
    NSRange equalRange = [line rangeOfString:@"="];
    if (equalRange.location == NSNotFound) return nil;
    NSString *rawValue = [[line substringFromIndex:equalRange.location + 1] aks_trimmed];
    if ([rawValue hasPrefix:@"\""] && [rawValue hasSuffix:@"\""] && rawValue.length >= 2) {
        return [rawValue substringWithRange:NSMakeRange(1, rawValue.length - 2)];
    }
    return rawValue.length > 0 ? rawValue : nil;
}

+ (NSString *)activeModelProviderNameInConfig:(NSString *)configText {
    NSArray<NSString *> *lines = [configText componentsSeparatedByCharactersInSet:NSCharacterSet.newlineCharacterSet];
    for (NSString *line in lines) {
        if (![self tomlLine:line hasKey:@"model_provider"]) continue;
        return [self tomlValueForLine:line];
    }
    return nil;
}

+ (BOOL)isLegacyLocalGatewayProviderName:(NSString *)providerName {
    return [providerName isEqualToString:LocalGatewayProviderName];
}

+ (void)rememberManagedProviderName:(NSString *)providerName {
    NSString *trimmed = [providerName aks_trimmed];
    if (trimmed.length == 0 || [self isLegacyLocalGatewayProviderName:trimmed]) return;
    [NSUserDefaults.standardUserDefaults setObject:trimmed forKey:ManagedCodexProviderNameDefaultsKey];
    [NSUserDefaults.standardUserDefaults synchronize];
}

+ (NSString *)providerNameFromBackupConfig {
    NSURL *backupURL = [self existingBackupURLForURL:[self configURL]];
    if (!backupURL) return nil;

    NSString *backupText = [NSString stringWithContentsOfURL:backupURL encoding:NSUTF8StringEncoding error:nil];
    NSString *backupProviderName = [self activeModelProviderNameInConfig:backupText];
    if (backupProviderName.length == 0 || [self isLegacyLocalGatewayProviderName:backupProviderName]) return nil;
    return backupProviderName;
}

+ (NSString *)managedProviderNameForConfigText:(NSString *)configText {
    NSString *currentProviderName = [self activeModelProviderNameInConfig:configText];
    if (currentProviderName.length > 0 && ![self isLegacyLocalGatewayProviderName:currentProviderName]) {
        [self rememberManagedProviderName:currentProviderName];
        return currentProviderName;
    }

    NSString *storedProviderName = [[NSUserDefaults.standardUserDefaults stringForKey:ManagedCodexProviderNameDefaultsKey] aks_trimmed];
    if (storedProviderName.length > 0 && ![self isLegacyLocalGatewayProviderName:storedProviderName]) {
        return storedProviderName;
    }

    NSString *backupProviderName = [self providerNameFromBackupConfig];
    if (backupProviderName.length > 0) {
        [self rememberManagedProviderName:backupProviderName];
        return backupProviderName;
    }

    return CodexDefaultProviderName;
}

+ (BOOL)sectionHeader:(NSString *)line matchesProviderName:(NSString *)providerName {
    NSString *trimmed = [line aks_trimmed];
    NSString *expected = [NSString stringWithFormat:@"[model_providers.%@]", providerName];
    return [trimmed isEqualToString:expected];
}

+ (NSString *)updatedConfigText:(NSString *)configText localGatewayModel:(NSString *)model {
    NSString *modelProviderName = [self managedProviderNameForConfigText:configText];
    NSMutableArray<NSString *> *lines = [[configText componentsSeparatedByCharactersInSet:NSCharacterSet.newlineCharacterSet] mutableCopy];
    NSString *modelLine = [NSString stringWithFormat:@"model = %@", [self tomlString:model.length > 0 ? model : @"gpt-4.1"]];
    NSString *providerLine = [NSString stringWithFormat:@"model_provider = %@", [self tomlString:modelProviderName]];
    NSString *baseURLLine = [NSString stringWithFormat:@"base_url = %@", [self tomlString:[self localGatewayEndpoint]]];
    NSString *wireAPILine = @"wire_api = \"responses\"";

    BOOL updatedTopLevelModel = NO;
    BOOL hasModelProviderLine = NO;
    BOOL insideAnySection = NO;
    BOOL insideTargetSection = NO;
    BOOL foundTargetSection = NO;
    BOOL updatedBaseURL = NO;
    BOOL updatedWireAPI = NO;
    NSUInteger targetSectionInsertIndex = NSNotFound;
    NSMutableIndexSet *duplicateTopLevelIndexes = [NSMutableIndexSet indexSet];

    for (NSUInteger index = 0; index < lines.count; index++) {
        lines[index] = [self configLineByRedactingSensitiveComment:lines[index]];
        NSString *trimmed = [lines[index] aks_trimmed];
        BOOL isSection = [trimmed hasPrefix:@"["] && [trimmed hasSuffix:@"]"];

        if (isSection) {
            insideAnySection = YES;
            if (insideTargetSection && (!updatedBaseURL || !updatedWireAPI)) {
                targetSectionInsertIndex = index;
            }
            insideTargetSection = [self sectionHeader:lines[index] matchesProviderName:modelProviderName];
            if (insideTargetSection) foundTargetSection = YES;
        }

        if (!insideAnySection && !isSection && [self tomlLine:trimmed hasKey:@"model_provider"]) {
            lines[index] = providerLine;
            hasModelProviderLine = YES;
            continue;
        }

        if (!insideAnySection && !isSection && [self tomlLine:trimmed hasKey:@"model"]) {
            if (!updatedTopLevelModel) {
                lines[index] = modelLine;
                updatedTopLevelModel = YES;
            } else {
                [duplicateTopLevelIndexes addIndex:index];
            }
            continue;
        }

        if (insideTargetSection && !isSection && [self tomlLine:trimmed hasKey:@"base_url"]) {
            lines[index] = baseURLLine;
            updatedBaseURL = YES;
        }

        if (insideTargetSection && !isSection && [self tomlLine:trimmed hasKey:@"wire_api"]) {
            lines[index] = wireAPILine;
            updatedWireAPI = YES;
        }
    }

    if (duplicateTopLevelIndexes.count > 0) {
        [lines removeObjectsAtIndexes:duplicateTopLevelIndexes];
    }

    if (!hasModelProviderLine) {
        [lines insertObject:providerLine atIndex:0];
    }

    if (!updatedTopLevelModel) {
        NSUInteger insertIndex = hasModelProviderLine ? 1 : 0;
        [lines insertObject:modelLine atIndex:MIN(insertIndex, lines.count)];
    }

    if (foundTargetSection && !updatedBaseURL) {
        if (targetSectionInsertIndex == NSNotFound) {
            [lines addObject:baseURLLine];
        } else {
            [lines insertObject:baseURLLine atIndex:targetSectionInsertIndex];
            targetSectionInsertIndex++;
        }
    }

    if (foundTargetSection && !updatedWireAPI) {
        if (targetSectionInsertIndex == NSNotFound) {
            [lines addObject:wireAPILine];
        } else {
            [lines insertObject:wireAPILine atIndex:targetSectionInsertIndex];
        }
    }

    if (!foundTargetSection) {
        [lines addObject:@""];
        [lines addObject:[NSString stringWithFormat:@"[model_providers.%@]", modelProviderName]];
        [lines addObject:[NSString stringWithFormat:@"name = %@", [self tomlString:modelProviderName]]];
        [lines addObject:baseURLLine];
        [lines addObject:wireAPILine];
    }

    return [lines componentsJoinedByString:@"\n"];
}

+ (NSString *)localGatewayEndpoint {
    return ConfiguredGatewayEndpoint();
}

+ (NSString *)configuredModel {
    NSString *configText = [NSString stringWithContentsOfURL:[self configURL] encoding:NSUTF8StringEncoding error:nil];
    if (!configText) return nil;
    BOOL insideAnySection = NO;
    NSArray<NSString *> *lines = [configText componentsSeparatedByCharactersInSet:NSCharacterSet.newlineCharacterSet];
    for (NSString *line in lines) {
        NSString *trimmed = [line aks_trimmed];
        BOOL isSection = [trimmed hasPrefix:@"["] && [trimmed hasSuffix:@"]"];
        if (isSection) {
            insideAnySection = YES;
            continue;
        }
        if (insideAnySection || ![self tomlLine:trimmed hasKey:@"model"]) continue;
        return [self tomlValueForLine:trimmed];
    }
    return nil;
}

+ (NSData *)updatedAuthDataWithAPIKey:(NSString *)apiKey currentData:(NSData *)data error:(NSError **)error {
    if (!data) return nil;

    NSMutableDictionary *payload = [[NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingMutableContainers error:error] mutableCopy];
    if (![payload isKindOfClass:NSMutableDictionary.class]) {
        if (error) *error = [NSError errorWithDomain:AppName code:20 userInfo:@{NSLocalizedDescriptionKey: @"auth.json 不是合法 JSON 对象。"}];
        return nil;
    }

    payload[@"auth_mode"] = @"apikey";
    payload[@"OPENAI_API_KEY"] = apiKey ?: @"";
    NSData *updatedData = [NSJSONSerialization dataWithJSONObject:payload options:NSJSONWritingPrettyPrinted error:error];
    return updatedData;
}

+ (BOOL)applyLocalGatewayWithModel:(NSString *)model error:(NSError **)error {
    NSURL *configURL = [self configURL];
    NSURL *authURL = [self authURL];
    NSString *originalConfig = [NSString stringWithContentsOfURL:configURL encoding:NSUTF8StringEncoding error:error];
    if (!originalConfig) return NO;

    NSData *originalAuthData = [NSData dataWithContentsOfURL:authURL options:0 error:error];
    if (!originalAuthData) return NO;

    NSString *updatedConfig = [self updatedConfigText:originalConfig localGatewayModel:model];
    NSData *updatedConfigData = [updatedConfig dataUsingEncoding:NSUTF8StringEncoding];
    NSData *updatedAuthData = [self updatedAuthDataWithAPIKey:LocalGatewayAPIKeyValue() currentData:originalAuthData error:error];
    if (!updatedConfigData || !updatedAuthData) return NO;

    BOOL configChanged = ![updatedConfig isEqualToString:originalConfig];
    BOOL authChanged = ![updatedAuthData isEqualToData:originalAuthData];
    if (!configChanged && !authChanged) {
        if ([self hasManagedBackup]) [self writeRestoreScriptWithError:nil];
        [self markManagedProxyApplied];
        return YES;
    }

    [self backupFileIfNeeded:configURL];
    [self backupFileIfNeeded:authURL];
    [self writeRestoreScriptWithError:nil];

    if (configChanged && ![updatedConfigData writeToURL:configURL options:NSDataWritingAtomic error:error]) {
        return NO;
    }

    if (authChanged && ![updatedAuthData writeToURL:authURL options:NSDataWritingAtomic error:error]) {
        NSError *rollbackError = nil;
        [originalConfig writeToURL:configURL atomically:YES encoding:NSUTF8StringEncoding error:&rollbackError];
        [originalAuthData writeToURL:authURL options:NSDataWritingAtomic error:nil];
        return NO;
    }
    [self markManagedProxyApplied];
    return YES;
}

+ (BOOL)configUsesLocalGateway {
    if (![NSUserDefaults.standardUserDefaults boolForKey:ManagedProxyAppliedDefaultsKey]) return NO;
    NSString *configText = [NSString stringWithContentsOfURL:[self configURL] encoding:NSUTF8StringEncoding error:nil];
    if (configText.length == 0) return NO;
    NSString *managedEndpoint = [NSUserDefaults.standardUserDefaults stringForKey:ManagedProxyEndpointDefaultsKey];
    if (managedEndpoint.length == 0) return YES;
    return [configText rangeOfString:managedEndpoint].location != NSNotFound ||
           [configText rangeOfString:LocalGatewayProviderName].location != NSNotFound;
}

+ (BOOL)hasManagedBackup {
    return [self existingBackupURLForURL:[self configURL]] != nil && [self existingBackupURLForURL:[self authURL]] != nil;
}

+ (BOOL)restoreSnapshotData:(NSData *)data toURL:(NSURL *)url error:(NSError **)error {
    if (data) {
        return [data writeToURL:url options:NSDataWritingAtomic error:error];
    }
    if ([NSFileManager.defaultManager fileExistsAtPath:url.path]) {
        return [NSFileManager.defaultManager removeItemAtURL:url error:error];
    }
    return YES;
}

+ (void)rollbackConfigData:(NSData *)configData authData:(NSData *)authData modelsData:(NSData *)modelsData {
    [self restoreSnapshotData:configData toURL:[self configURL] error:nil];
    [self restoreSnapshotData:authData toURL:[self authURL] error:nil];
    [self restoreSnapshotData:modelsData toURL:[self modelsCacheURL] error:nil];
}

+ (BOOL)restoreManagedBackup:(NSError **)error {
    if (![self hasManagedBackup]) {
        if (error) *error = [NSError errorWithDomain:AppName code:41 userInfo:@{NSLocalizedDescriptionKey: @"未找到完整的 Codex 配置备份，无法自动恢复。"}];
        return NO;
    }

    NSURL *configURL = [self configURL];
    NSURL *authURL = [self authURL];
    NSURL *modelsURL = [self modelsCacheURL];
    NSURL *configBackupURL = [self existingBackupURLForURL:configURL];
    NSURL *authBackupURL = [self existingBackupURLForURL:authURL];
    NSURL *modelsBackupURL = [self existingBackupURLForURL:modelsURL];

    NSData *backupConfigData = [NSData dataWithContentsOfURL:configBackupURL options:0 error:error];
    if (!backupConfigData) return NO;
    NSData *backupAuthData = [NSData dataWithContentsOfURL:authBackupURL options:0 error:error];
    if (!backupAuthData) return NO;
    NSData *backupModelsData = modelsBackupURL ? [NSData dataWithContentsOfURL:modelsBackupURL options:0 error:error] : nil;
    if (modelsBackupURL && !backupModelsData) return NO;

    NSData *currentConfigData = [NSData dataWithContentsOfURL:configURL options:0 error:nil];
    NSData *currentAuthData = [NSData dataWithContentsOfURL:authURL options:0 error:nil];
    NSData *currentModelsData = [NSData dataWithContentsOfURL:modelsURL options:0 error:nil];

    if (![backupConfigData writeToURL:configURL options:NSDataWritingAtomic error:error]) {
        return NO;
    }
    if (![backupAuthData writeToURL:authURL options:NSDataWritingAtomic error:error]) {
        [self rollbackConfigData:currentConfigData authData:currentAuthData modelsData:currentModelsData];
        return NO;
    }
    if (backupModelsData && ![backupModelsData writeToURL:modelsURL options:NSDataWritingAtomic error:error]) {
        [self rollbackConfigData:currentConfigData authData:currentAuthData modelsData:currentModelsData];
        return NO;
    }
    [self clearManagedProxyApplied];
    return YES;
}

+ (NSString *)configSummary {
    return [NSString stringWithFormat:@"本地路由代理：%@，Codex 固定连接此地址。", [self localGatewayEndpoint]];
}
@end
