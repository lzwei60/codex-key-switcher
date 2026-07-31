#import "AIKeySwitcherShared.h"

NSString * const AppName = @"AIKeySwitcher";
NSString * const AppDisplayName = @"Codex Key Switcher";
NSString * const LocalGatewayProviderName = @"codex-key-switcher";
NSString * const CodexDefaultProviderName = @"openai";
NSString * const ManagedCodexProviderNameDefaultsKey = @"managedCodexProviderName";
NSString * const LocalGatewayAPIKeyDefaultsKey = @"localGatewayAPIKey";
NSString * const LegacyLocalGatewayAPIKey = @"codex-key-switcher-local-key";
NSString * const ManagedBackupSuffix = @".codex-key-switcher.bak";
NSString * const LegacyBackupSuffix = @".bak";
NSString * const APIFormatResponses = @"responses";
NSString * const APIFormatChatCompletions = @"chat_completions";
NSString * const APIFormatAnthropicMessages = @"anthropic_messages";
NSString * const LanguageDidChangeNotification = @"AIKeySwitcher.LanguageDidChange";
NSString * const UsageStoreDidChangeNotification = @"AIKeySwitcher.UsageStoreDidChange";
NSString * const RouteStateDidChangeNotification = @"AIKeySwitcher.RouteStateDidChange";
NSString * const ProviderRouteSelectionDidChangeNotification = @"AIKeySwitcher.ProviderRouteSelectionDidChange";
const int GatewayPort = 3456;
const NSTimeInterval UpstreamRequestTimeoutSeconds = 600;
const NSUInteger MaxGatewayRequestBytes = 64 * 1024 * 1024;
const unsigned long long MaxDebugLogBytes = 512 * 1024;
const CGFloat AppWindowInitialWidth = 1280;
const CGFloat AppWindowMinimumWidth = 1100;
const CGFloat AppWindowFixedContentHeight = 820;
const NSInteger StatsTablePageSize = 10;

NSInteger ConfiguredGatewayPort(void) {
    NSInteger port = [NSUserDefaults.standardUserDefaults integerForKey:@"listenPort"];
    return port >= 1024 && port <= 65535 ? port : GatewayPort;
}

NSString *ConfiguredListenAddress(void) {
    NSString *address = [[NSUserDefaults.standardUserDefaults stringForKey:@"listenAddress"] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    return address.length > 0 ? address : @"127.0.0.1";
}

NSString *GatewayClientHost(void) {
    NSString *address = ConfiguredListenAddress();
    return [address isEqualToString:@"0.0.0.0"] ? @"127.0.0.1" : address;
}

NSString *ConfiguredGatewayEndpoint(void) {
    return [NSString stringWithFormat:@"http://%@:%ld/v1", GatewayClientHost(), (long)ConfiguredGatewayPort()];
}

BOOL UseEnglishLanguage(void) {
    return [[NSUserDefaults.standardUserDefaults stringForKey:@"language"] isEqualToString:@"en"];
}

NSString *AKSText(NSString *simplifiedChinese, NSString *english) {
    return UseEnglishLanguage() ? (english ?: simplifiedChinese) : simplifiedChinese;
}

NSString *TrimString(NSString *value) {
    return [value isKindOfClass:NSString.class] ? [value stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet] : @"";
}

NSString *APIFormatDisplayName(NSString *apiFormat) {
    NSString *format = TrimString(apiFormat);
    if ([format isEqualToString:APIFormatChatCompletions]) return @"Chat Completions (/chat/completions)";
    if ([format isEqualToString:APIFormatAnthropicMessages]) return @"Anthropic Messages (/v1/messages)";
    return @"Responses (/responses)";
}

NSString *ProviderAPIFormat(NSDictionary *provider) {
    NSString *format = TrimString(provider[@"apiFormat"]);
    if ([format isEqualToString:APIFormatChatCompletions]) return APIFormatChatCompletions;
    if ([format isEqualToString:APIFormatAnthropicMessages]) return APIFormatAnthropicMessages;
    return APIFormatResponses;
}

NSString *ModelCustomName(NSDictionary *model) {
    NSString *customName = TrimString(model[@"customName"]);
    NSString *upstreamModel = TrimString(model[@"model"]);
    return customName.length > 0 ? customName : upstreamModel;
}

NSArray<NSDictionary *> *ProviderModels(NSDictionary *provider) {
    NSArray *models = provider[@"models"];
    NSMutableArray<NSDictionary *> *normalized = [NSMutableArray array];
    if ([models isKindOfClass:NSArray.class]) {
        for (NSDictionary *model in models) {
            if (![model isKindOfClass:NSDictionary.class]) continue;
            NSString *upstreamModel = TrimString(model[@"model"]);
            if (upstreamModel.length == 0) continue;
            NSString *customName = ModelCustomName(model);
            [normalized addObject:@{@"customName": customName, @"model": upstreamModel}];
        }
    }

    if (normalized.count == 0) {
        NSString *legacyModel = TrimString(provider[@"model"]);
        if (legacyModel.length > 0) {
            [normalized addObject:@{@"customName": legacyModel, @"model": legacyModel}];
        }
    }
    return normalized;
}

NSString *ProviderCatalogSlug(NSDictionary *provider, NSDictionary *model) {
    if (!provider || !model) return @"";
    NSString *upstreamModel = TrimString(model[@"model"]);
    NSString *customName = ModelCustomName(model);
    if (upstreamModel.length > 0 && [customName isEqualToString:upstreamModel]) return upstreamModel;

    NSString *providerId = TrimString(provider[@"id"]);
    if (providerId.length == 0 || customName.length == 0) return customName;

    NSMutableString *slug = [NSMutableString stringWithString:@"ks-"];
    NSString *shortId = providerId.length > 8 ? [providerId substringToIndex:8] : providerId;
    [slug appendString:shortId.lowercaseString];
    [slug appendString:@"-"];
    for (NSUInteger index = 0; index < customName.length; index++) {
        unichar character = [customName characterAtIndex:index];
        BOOL allowed = (character >= 'a' && character <= 'z') ||
                       (character >= 'A' && character <= 'Z') ||
                       (character >= '0' && character <= '9') ||
                       character == '-' || character == '_' || character == '.';
        unichar nextCharacter = allowed ? character : (unichar)'-';
        [slug appendFormat:@"%C", nextCharacter];
    }
    return slug.lowercaseString;
}

NSString *ProviderPrimaryCatalogModel(NSDictionary *provider) {
    NSDictionary *firstModel = ProviderModels(provider).firstObject;
    NSString *slug = ProviderCatalogSlug(provider, firstModel);
    return slug.length > 0 ? slug : @"gpt-4.1";
}

NSDictionary *ProviderSelectedModel(NSDictionary *provider) {
    NSArray<NSDictionary *> *models = ProviderModels(provider);
    NSString *selected = TrimString(provider[@"model"]);
    if (selected.length > 0) {
        for (NSDictionary *model in models) {
            NSString *customName = ModelCustomName(model);
            NSString *upstreamModel = TrimString(model[@"model"]);
            NSString *catalogSlug = ProviderCatalogSlug(provider, model);
            if ([selected isEqualToString:catalogSlug] || [selected isEqualToString:customName] || [selected isEqualToString:upstreamModel]) {
                return model;
            }
        }
    }
    return models.firstObject;
}

NSString *ProviderSelectedCatalogModel(NSDictionary *provider) {
    NSDictionary *model = ProviderSelectedModel(provider);
    NSString *slug = ProviderCatalogSlug(provider, model);
    return slug.length > 0 ? slug : ProviderPrimaryCatalogModel(provider);
}

NSString *ProviderSelectedModelName(NSDictionary *provider) {
    NSDictionary *model = ProviderSelectedModel(provider);
    NSString *name = ModelCustomName(model);
    return name.length > 0 ? name : ProviderSelectedCatalogModel(provider);
}

NSString *AppSupportPath(NSString *fileName) {
    NSURL *supportURL = [[NSFileManager.defaultManager URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask].firstObject URLByAppendingPathComponent:AppName isDirectory:YES];
    [NSFileManager.defaultManager createDirectoryAtURL:supportURL withIntermediateDirectories:YES attributes:nil error:nil];
    [NSFileManager.defaultManager setAttributes:@{NSFilePosixPermissions: @0700} ofItemAtPath:supportURL.path error:nil];
    return [supportURL.path stringByAppendingPathComponent:fileName ?: @""];
}

NSURL *CodexDirectoryURL(void) {
    NSString *savedPath = [NSUserDefaults.standardUserDefaults stringForKey:@"codexConfigDir"];
    NSString *path = savedPath.length > 0 ? savedPath : [NSHomeDirectory() stringByAppendingPathComponent:@".codex"];
    return [NSURL fileURLWithPath:path.stringByExpandingTildeInPath.stringByStandardizingPath isDirectory:YES];
}

BOOL RouteEnabled(void) {
    if ([NSUserDefaults.standardUserDefaults objectForKey:@"routeEnabled"] == nil) return YES;
    return [NSUserDefaults.standardUserDefaults boolForKey:@"routeEnabled"];
}

NSString *LocalGatewayAPIKeyValue(void) {
    NSString *storedKey = TrimString([NSUserDefaults.standardUserDefaults stringForKey:LocalGatewayAPIKeyDefaultsKey]);
    if (storedKey.length > 0) return storedKey;

    NSString *newKey = [@"cksw-" stringByAppendingString:NSUUID.UUID.UUIDString];
    [NSUserDefaults.standardUserDefaults setObject:newKey forKey:LocalGatewayAPIKeyDefaultsKey];
    [NSUserDefaults.standardUserDefaults synchronize];
    return newKey;
}

NSData *JSONData(id object) {
    return [NSJSONSerialization dataWithJSONObject:object options:0 error:nil] ?: NSData.data;
}

NSString *JSONString(id object) {
    NSData *data = JSONData(object);
    return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"{}";
}

NSString *ModelSwitchReplayNoticeText(void) {
    return AKSText(
        @"已切换。建议新建一个 Codex 会话后继续，让当前供应商和模型在全新上下文中工作。",
        @"Switched. Start a new Codex session before continuing so the selected provider and model can work from a fresh context."
    );
}

@implementation NSString (AIKeySwitcher)
- (NSString *)aks_trimmed {
    return [self stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
}

- (NSString *)aks_trimTrailingSlashes {
    NSString *value = [self aks_trimmed];
    while ([value hasSuffix:@"/"]) {
        value = [value substringToIndex:value.length - 1];
    }
    return value;
}

- (NSString *)aks_maskedKey {
    if (self.length <= 12) {
        return [@"" stringByPaddingToLength:self.length withString:@"*" startingAtIndex:0];
    }
    return [NSString stringWithFormat:@"%@...%@", [self substringToIndex:6], [self substringFromIndex:self.length - 4]];
}
@end

@implementation FlippedView
- (BOOL)isFlipped {
    return YES;
}
@end

static NSRect AKSInputTextFrame(NSTextFieldCell *cell, NSRect frame) {
    NSRect textFrame = NSInsetRect(frame, 12, 0);
    CGFloat textHeight = ceil(cell.cellSize.height);
    if (textHeight > 0 && textFrame.size.height > textHeight) {
        textFrame.origin.y += floor((textFrame.size.height - textHeight) / 2.0);
        textFrame.size.height = textHeight;
    }
    return textFrame;
}

@implementation AKSVerticalTextFieldCell
- (NSRect)drawingRectForBounds:(NSRect)rect {
    return AKSInputTextFrame(self, rect);
}

- (NSRect)titleRectForBounds:(NSRect)rect {
    return AKSInputTextFrame(self, rect);
}

- (void)editWithFrame:(NSRect)rect inView:(NSView *)controlView editor:(NSText *)textObj delegate:(id)delegate event:(NSEvent *)event {
    [super editWithFrame:AKSInputTextFrame(self, rect) inView:controlView editor:textObj delegate:delegate event:event];
}

- (void)selectWithFrame:(NSRect)rect inView:(NSView *)controlView editor:(NSText *)textObj delegate:(id)delegate start:(NSInteger)start length:(NSInteger)length {
    [super selectWithFrame:AKSInputTextFrame(self, rect) inView:controlView editor:textObj delegate:delegate start:start length:length];
}
@end

@implementation AKSVerticalSecureTextFieldCell
- (NSRect)drawingRectForBounds:(NSRect)rect {
    return AKSInputTextFrame(self, rect);
}

- (NSRect)titleRectForBounds:(NSRect)rect {
    return AKSInputTextFrame(self, rect);
}

- (void)editWithFrame:(NSRect)rect inView:(NSView *)controlView editor:(NSText *)textObj delegate:(id)delegate event:(NSEvent *)event {
    [super editWithFrame:AKSInputTextFrame(self, rect) inView:controlView editor:textObj delegate:delegate event:event];
}

- (void)selectWithFrame:(NSRect)rect inView:(NSView *)controlView editor:(NSText *)textObj delegate:(id)delegate start:(NSInteger)start length:(NSInteger)length {
    [super selectWithFrame:AKSInputTextFrame(self, rect) inView:controlView editor:textObj delegate:delegate start:start length:length];
}
@end

@implementation AKSTextField
- (BOOL)acceptsFirstResponder {
    return YES;
}

- (void)mouseDown:(NSEvent *)event {
    if (self.enabled && self.editable) {
        [self.window makeFirstResponder:self];
    }
    [super mouseDown:event];
}
@end

@implementation AKSSecureTextField
- (BOOL)acceptsFirstResponder {
    return YES;
}

- (void)mouseDown:(NSEvent *)event {
    if (self.enabled && self.editable) {
        [self.window makeFirstResponder:self];
    }
    [super mouseDown:event];
}
@end

@implementation LineChartView
- (BOOL)isFlipped {
    return YES;
}

- (void)drawRect:(NSRect)dirtyRect {
    [super drawRect:dirtyRect];
    NSRect plot = NSMakeRect(self.bounds.origin.x + 58, self.bounds.origin.y + 12, self.bounds.size.width - 78, self.bounds.size.height - 48);
    if (plot.size.width <= 0 || plot.size.height <= 0) return;

    CGFloat maxValue = 1;
    for (NSArray<NSNumber *> *values in self.series) {
        for (NSNumber *value in values) {
            maxValue = MAX(maxValue, value.doubleValue);
        }
    }

    NSDictionary *axisAttributes = @{
        NSFontAttributeName: [NSFont systemFontOfSize:10],
        NSForegroundColorAttributeName: NSColor.secondaryLabelColor
    };
    [[NSColor colorWithWhite:0.82 alpha:1.0] setStroke];
    NSBezierPath *grid = [NSBezierPath bezierPath];
    for (NSInteger i = 0; i <= 4; i++) {
        CGFloat y = plot.origin.y + plot.size.height * i / 4.0;
        [grid moveToPoint:NSMakePoint(plot.origin.x, y)];
        [grid lineToPoint:NSMakePoint(NSMaxX(plot), y)];

        CGFloat value = maxValue * (4 - i) / 4.0;
        NSString *label = [NSNumberFormatter localizedStringFromNumber:@((long long)llround(value)) numberStyle:NSNumberFormatterDecimalStyle];
        NSSize labelSize = [label sizeWithAttributes:axisAttributes];
        [label drawAtPoint:NSMakePoint(plot.origin.x - labelSize.width - 8, y - labelSize.height / 2.0) withAttributes:axisAttributes];
    }
    grid.lineWidth = 1;
    [grid stroke];

    [[NSColor colorWithWhite:0.58 alpha:1.0] setStroke];
    NSBezierPath *axis = [NSBezierPath bezierPath];
    [axis moveToPoint:NSMakePoint(plot.origin.x, plot.origin.y)];
    [axis lineToPoint:NSMakePoint(plot.origin.x, NSMaxY(plot))];
    [axis lineToPoint:NSMakePoint(NSMaxX(plot), NSMaxY(plot))];
    axis.lineWidth = 1;
    [axis stroke];

    NSUInteger labelCount = self.xLabels.count;
    if (labelCount > 0) {
        for (NSUInteger index = 0; index < labelCount; index++) {
            CGFloat x = plot.origin.x + (labelCount == 1 ? 0 : plot.size.width * index / (labelCount - 1));
            NSString *label = self.xLabels[index];
            NSSize labelSize = [label sizeWithAttributes:axisAttributes];
            [label drawAtPoint:NSMakePoint(x - labelSize.width / 2.0, NSMaxY(plot) + 8) withAttributes:axisAttributes];
        }
    }

    for (NSUInteger seriesIndex = 0; seriesIndex < self.series.count; seriesIndex++) {
        NSArray<NSNumber *> *values = self.series[seriesIndex];
        if (values.count == 0) continue;
        NSBezierPath *path = [NSBezierPath bezierPath];
        for (NSUInteger index = 0; index < values.count; index++) {
            CGFloat x = plot.origin.x + (values.count == 1 ? 0 : plot.size.width * index / (values.count - 1));
            CGFloat ratio = values[index].doubleValue / maxValue;
            CGFloat y = NSMaxY(plot) - plot.size.height * ratio;
            NSPoint point = NSMakePoint(x, y);
            index == 0 ? [path moveToPoint:point] : [path lineToPoint:point];
        }
        NSColor *color = seriesIndex < self.seriesColors.count ? self.seriesColors[seriesIndex] : NSColor.systemBlueColor;
        [color setStroke];
        path.lineWidth = 3;
        [path stroke];

        [color setFill];
        for (NSUInteger index = 0; index < values.count; index++) {
            CGFloat x = plot.origin.x + (values.count == 1 ? 0 : plot.size.width * index / (values.count - 1));
            CGFloat ratio = values[index].doubleValue / maxValue;
            CGFloat y = NSMaxY(plot) - plot.size.height * ratio;
            NSBezierPath *dot = [NSBezierPath bezierPathWithOvalInRect:NSMakeRect(x - 3, y - 3, 6, 6)];
            [dot fill];
        }
    }
}
@end

void ShowAlert(NSString *title, NSString *message) {
    dispatch_async(dispatch_get_main_queue(), ^{
        NSAlert *alert = [[NSAlert alloc] init];
        alert.messageText = title;
        alert.informativeText = message ?: @"";
        alert.alertStyle = NSAlertStyleWarning;
        [alert runModal];
    });
}

BOOL ConfirmSensitiveClipboardCopy(void) {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = AKSText(@"复制真实 API Key？", @"Copy real API key?");
    alert.informativeText = AKSText(
        @"环境变量里会包含完整 API Key。复制后请不要粘贴到聊天、日志或公开文档中；剪贴板会在 2 分钟后自动清空。",
        @"The environment text contains the full API key. Do not paste it into chats, logs, or public documents. The clipboard will be cleared automatically after 2 minutes."
    );
    [alert addButtonWithTitle:AKSText(@"复制", @"Copy")];
    [alert addButtonWithTitle:AKSText(@"取消", @"Cancel")];
    alert.alertStyle = NSAlertStyleWarning;
    return [alert runModal] == NSAlertFirstButtonReturn;
}

void CopySensitiveTextToPasteboard(NSString *text) {
    NSString *value = text ?: @"";
    [NSPasteboard.generalPasteboard clearContents];
    [NSPasteboard.generalPasteboard setString:value forType:NSPasteboardTypeString];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(120 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        NSString *current = [NSPasteboard.generalPasteboard stringForType:NSPasteboardTypeString];
        if ([current isEqualToString:value]) {
            [NSPasteboard.generalPasteboard clearContents];
        }
    });
}
