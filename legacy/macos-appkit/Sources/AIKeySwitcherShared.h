#import <Cocoa/Cocoa.h>
#import <ServiceManagement/ServiceManagement.h>
#import <sys/socket.h>
#import <netinet/in.h>
#import <arpa/inet.h>
#import <unistd.h>

FOUNDATION_EXPORT NSString * const AppName;
FOUNDATION_EXPORT NSString * const AppDisplayName;
FOUNDATION_EXPORT NSString * const LocalGatewayProviderName;
FOUNDATION_EXPORT NSString * const CodexDefaultProviderName;
FOUNDATION_EXPORT NSString * const ManagedCodexProviderNameDefaultsKey;
FOUNDATION_EXPORT NSString * const LocalGatewayAPIKeyDefaultsKey;
FOUNDATION_EXPORT NSString * const LegacyLocalGatewayAPIKey;
FOUNDATION_EXPORT NSString * const ManagedBackupSuffix;
FOUNDATION_EXPORT NSString * const LegacyBackupSuffix;
FOUNDATION_EXPORT NSString * const APIFormatResponses;
FOUNDATION_EXPORT NSString * const APIFormatChatCompletions;
FOUNDATION_EXPORT NSString * const APIFormatAnthropicMessages;
FOUNDATION_EXPORT NSString * const LanguageDidChangeNotification;
FOUNDATION_EXPORT NSString * const UsageStoreDidChangeNotification;
FOUNDATION_EXPORT NSString * const RouteStateDidChangeNotification;
FOUNDATION_EXPORT NSString * const ProviderRouteSelectionDidChangeNotification;
FOUNDATION_EXPORT const int GatewayPort;
FOUNDATION_EXPORT const NSTimeInterval UpstreamRequestTimeoutSeconds;
FOUNDATION_EXPORT const NSUInteger MaxGatewayRequestBytes;
FOUNDATION_EXPORT const unsigned long long MaxDebugLogBytes;
FOUNDATION_EXPORT const CGFloat AppWindowInitialWidth;
FOUNDATION_EXPORT const CGFloat AppWindowMinimumWidth;
FOUNDATION_EXPORT const CGFloat AppWindowFixedContentHeight;
FOUNDATION_EXPORT const NSInteger StatsTablePageSize;

NSInteger ConfiguredGatewayPort(void);
NSString *ConfiguredListenAddress(void);
NSString *GatewayClientHost(void);
NSString *ConfiguredGatewayEndpoint(void);
BOOL UseEnglishLanguage(void);
NSString *AKSText(NSString *simplifiedChinese, NSString *english);
NSString *TrimString(NSString *value);
NSString *APIFormatDisplayName(NSString *apiFormat);
NSString *ProviderAPIFormat(NSDictionary *provider);
NSString *ModelCustomName(NSDictionary *model);
NSArray<NSDictionary *> *ProviderModels(NSDictionary *provider);
NSString *ProviderCatalogSlug(NSDictionary *provider, NSDictionary *model);
NSString *ProviderPrimaryCatalogModel(NSDictionary *provider);
NSDictionary *ProviderSelectedModel(NSDictionary *provider);
NSString *ProviderSelectedCatalogModel(NSDictionary *provider);
NSString *ProviderSelectedModelName(NSDictionary *provider);
NSString *AppSupportPath(NSString *fileName);
NSURL *CodexDirectoryURL(void);
BOOL RouteEnabled(void);
NSString *LocalGatewayAPIKeyValue(void);
NSData *JSONData(id object);
NSString *JSONString(id object);
NSString *ModelSwitchReplayNoticeText(void);
void ShowAlert(NSString *title, NSString *message);
BOOL ConfirmSensitiveClipboardCopy(void);
void CopySensitiveTextToPasteboard(NSString *text);

@interface NSString (AIKeySwitcher)
- (NSString *)aks_trimmed;
- (NSString *)aks_trimTrailingSlashes;
- (NSString *)aks_maskedKey;
@end

@interface FlippedView : NSView
@end

@interface AKSTextField : NSTextField
@end

@interface AKSSecureTextField : NSSecureTextField
@end

@interface AKSVerticalTextFieldCell : NSTextFieldCell
@end

@interface AKSVerticalSecureTextFieldCell : NSSecureTextFieldCell
@end

@interface LineChartView : NSView
@property(nonatomic, strong) NSArray<NSArray<NSNumber *> *> *series;
@property(nonatomic, strong) NSArray<NSColor *> *seriesColors;
@property(nonatomic, strong) NSArray<NSString *> *xLabels;
@end
