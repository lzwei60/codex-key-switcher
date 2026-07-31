#import "HealthChecker.h"
#import "CodexConfigWriter.h"

@implementation AKSHealthReport
- (NSString *)diagnosticText {
    return [@[
        [NSString stringWithFormat:@"App: %@", AppDisplayName],
        [NSString stringWithFormat:@"Health: %@", self.title ?: @""],
        [NSString stringWithFormat:@"Message: %@", self.message ?: @""],
        [NSString stringWithFormat:@"Route Enabled: %@", self.routeEnabled ? @"true" : @"false"],
        [NSString stringWithFormat:@"Gateway Running: %@", self.gatewayRunning ? @"true" : @"false"],
        [NSString stringWithFormat:@"Endpoint: %@", self.endpoint ?: @""],
        [NSString stringWithFormat:@"Codex Uses Gateway: %@", self.codexUsesGateway ? @"true" : @"false"],
        [NSString stringWithFormat:@"Restore Available: %@", self.restoreAvailable ? @"true" : @"false"],
        [NSString stringWithFormat:@"Current Provider: %@", self.currentProviderName ?: @""],
        [NSString stringWithFormat:@"Current Model: %@", self.currentModel ?: @""],
        [NSString stringWithFormat:@"Codex Directory: %@", self.codexDirectory ?: @""],
        [NSString stringWithFormat:@"Restore Script: %@", self.restoreScriptPath ?: @""]
    ] componentsJoinedByString:@"\n"];
}
@end

@implementation HealthChecker
+ (BOOL)codexRequiredFilesReadable {
    NSURL *directoryURL = CodexDirectoryURL();
    NSString *configPath = [directoryURL URLByAppendingPathComponent:@"config.toml"].path;
    NSString *authPath = [directoryURL URLByAppendingPathComponent:@"auth.json"].path;
    return [NSFileManager.defaultManager isReadableFileAtPath:configPath] &&
           [NSFileManager.defaultManager isReadableFileAtPath:authPath];
}

+ (AKSHealthReport *)checkWithGateway:(LocalGateway *)gateway store:(ProviderStore *)store {
    AKSHealthReport *report = [[AKSHealthReport alloc] init];
    NSDictionary *current = [store currentProvider];
    report.routeEnabled = RouteEnabled();
    report.gatewayRunning = gateway.running;
    report.endpoint = ConfiguredGatewayEndpoint();
    report.codexUsesGateway = [CodexConfigWriter configUsesLocalGateway];
    report.restoreAvailable = [CodexConfigWriter hasManagedBackup];
    report.currentProviderName = current[@"name"] ?: AKSText(@"未选择", @"Not selected");
    report.currentModel = current ? ProviderSelectedCatalogModel(current) : ([CodexConfigWriter configuredModel] ?: @"");
    report.codexDirectory = CodexDirectoryURL().path ?: @"";
    report.restoreScriptPath = [CodexConfigWriter restoreScriptPath];

    if (![self codexRequiredFilesReadable]) {
        report.level = AKSHealthLevelError;
        report.title = AKSText(@"Codex 配置不完整", @"Codex configuration incomplete");
        report.message = AKSText(@"当前配置目录缺少可读取的 config.toml 或 auth.json。", @"The current configuration directory does not contain readable config.toml or auth.json.");
        return report;
    }

    if (report.routeEnabled && !report.gatewayRunning) {
        report.level = AKSHealthLevelError;
        report.title = AKSText(@"本地路由未运行", @"Local routing is not running");
        report.message = AKSText(@"Codex 可能仍指向本地代理，但代理服务没有运行。", @"Codex may still point to the local proxy, but the proxy service is not running.");
        return report;
    }

    if (report.routeEnabled && !report.codexUsesGateway) {
        report.level = AKSHealthLevelWarning;
        report.title = AKSText(@"Codex 尚未指向本地代理", @"Codex is not using the local proxy");
        report.message = AKSText(@"请重新同步 Codex 配置，或重启 Codex 后再试。", @"Sync the Codex configuration again, or restart Codex and try again.");
        return report;
    }

    if (!report.restoreAvailable) {
        report.level = AKSHealthLevelWarning;
        report.title = AKSText(@"未找到完整恢复备份", @"Restore backup is incomplete");
        report.message = AKSText(@"首次成功启用本地路由后会生成恢复备份和独立恢复脚本。", @"A restore backup and standalone restore script are created after local routing is enabled successfully.");
        return report;
    }

    report.level = AKSHealthLevelOK;
    report.title = AKSText(@"运行正常", @"Running normally");
    report.message = AKSText(@"本地路由、Codex 配置和恢复备份状态正常。", @"Local routing, Codex configuration, and restore backup are healthy.");
    return report;
}
@end
