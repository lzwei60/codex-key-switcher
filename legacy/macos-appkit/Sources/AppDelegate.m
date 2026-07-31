#import "AppDelegate.h"
#import "ProviderStore.h"
#import "UsageStore.h"
#import "LocalGateway.h"
#import "MainWindowController.h"
#import "CodexConfigWriter.h"
#import "CodexModelCatalogWriter.h"

@implementation AppDelegate {
    ProviderStore *_store;
    UsageStore *_usageStore;
    LocalGateway *_gateway;
    NSStatusItem *_statusItem;
    MainWindowController *_windowController;
    BOOL _isRestoringCodexConfig;
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    [self registerDefaultSettings];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSImage *appIcon = [NSImage imageNamed:@"icon-chatgpt"];
    if (appIcon) {
        NSApp.applicationIconImage = appIcon;
    }
    [self setupMainMenu];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(languageDidChange:) name:LanguageDidChangeNotification object:nil];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(routeStateDidChange:) name:RouteStateDidChangeNotification object:nil];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(providerRouteSelectionDidChange:) name:ProviderRouteSelectionDidChangeNotification object:nil];
    _store = [[ProviderStore alloc] init];
    _usageStore = [[UsageStore alloc] init];
    _gateway = [[LocalGateway alloc] initWithStore:_store usageStore:_usageStore];
    [self applyRouteAutoStartPreference];
    _windowController = [[MainWindowController alloc] initWithStore:_store gateway:_gateway usageStore:_usageStore];
    _statusItem = [NSStatusBar.systemStatusBar statusItemWithLength:NSVariableStatusItemLength];
    if (![self showFirstRunGuideIfNeeded]) {
        [NSApp terminate:nil];
        return;
    }
    [self startGatewayAndConfigureCodex];

    __weak typeof(self) weakSelf = self;
    _store.onChange = ^{
        __strong typeof(weakSelf) strongSelf = weakSelf;
        if (!strongSelf) return;
        [strongSelf syncCodexStateShowingAlert:YES preferredModel:ProviderSelectedCatalogModel([strongSelf->_store currentProvider])];
        [strongSelf->_windowController reload];
        [strongSelf renderMenu];
    };

    [self renderMenu];
    [self openWindow];
    [self->_windowController reload];
}

- (BOOL)showFirstRunGuideIfNeeded {
    if ([NSUserDefaults.standardUserDefaults boolForKey:@"firstRunGuideAccepted"]) return YES;
    BOOL hasManagedState = [NSUserDefaults.standardUserDefaults objectForKey:@"managedProxyApplied"] != nil;
    BOOL hasExistingProviders = [NSFileManager.defaultManager fileExistsAtPath:AppSupportPath(@"providers.json")];
    if (hasManagedState || hasExistingProviders) {
        [NSUserDefaults.standardUserDefaults setBool:YES forKey:@"firstRunGuideAccepted"];
        [NSUserDefaults.standardUserDefaults synchronize];
        return YES;
    }

    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = @"启用 Codex Key Switcher？";
    alert.informativeText = [NSString stringWithFormat:@"这个工具会把 Codex 配置改为连接本地路由代理 %@，并在启用前创建备份和独立恢复脚本。你可以在“设置 > 诊断”里恢复 Codex 原配置。\n\nAPI Key 默认保存在本机应用支持目录，文件权限会限制为当前用户可读写。", ConfiguredGatewayEndpoint()];
    [alert addButtonWithTitle:@"继续启用"];
    [alert addButtonWithTitle:@"退出"];
    alert.alertStyle = NSAlertStyleInformational;
    if ([alert runModal] != NSAlertFirstButtonReturn) return NO;

    [NSUserDefaults.standardUserDefaults setBool:YES forKey:@"firstRunGuideAccepted"];
    [NSUserDefaults.standardUserDefaults synchronize];
    return YES;
}

- (void)registerDefaultSettings {
    [NSUserDefaults.standardUserDefaults registerDefaults:@{
        @"autoStartLocalRoute": @YES,
        @"routeDisabledExplicitly": @NO,
        @"routeEnabled": @YES,
        @"showRouteControls": @YES,
        @"listenAddress": @"127.0.0.1",
        @"listenPort": @(GatewayPort),
        @"appearanceTheme": @"system",
        @"language": @"zh-Hans"
    }];
}

- (void)applyRouteAutoStartPreference {
    NSUserDefaults *defaults = NSUserDefaults.standardUserDefaults;
    BOOL routeDisabledExplicitly = [defaults boolForKey:@"routeDisabledExplicitly"];
    BOOL autoStartLocalRoute = [defaults boolForKey:@"autoStartLocalRoute"];
    [defaults setBool:(autoStartLocalRoute && !routeDisabledExplicitly) forKey:@"routeEnabled"];
    [defaults synchronize];
}

- (void)languageDidChange:(NSNotification *)notification {
    [self setupMainMenu];
    [self renderMenu];
}

- (void)routeStateDidChange:(NSNotification *)notification {
    (void)notification;
    [self renderMenu];
}

- (void)providerRouteSelectionDidChange:(NSNotification *)notification {
    (void)notification;
    [_windowController reload];
    [self renderMenu];
}

- (void)startGatewayAndConfigureCodex {
    if (!RouteEnabled()) {
        [_gateway stop];
        if ([CodexConfigWriter configUsesLocalGateway] && [CodexConfigWriter hasManagedBackup]) {
            NSError *restoreError = nil;
            [CodexConfigWriter restoreManagedBackup:&restoreError];
        }
        return;
    }

    NSError *gatewayError = nil;
    NSInteger changedPort = 0;
    if (![_gateway startAllowingPortFallback:&gatewayError changedPort:&changedPort]) {
        ShowAlert(@"本地路由代理启动失败", gatewayError.localizedDescription);
        return;
    }
    if (changedPort > 0) {
        ShowAlert(@"本地路由端口已自动切换", [NSString stringWithFormat:@"默认端口被占用，已自动切换到 %@。Codex 配置会同步写入新地址。", ConfiguredGatewayEndpoint()]);
    }

    [self syncCodexStateShowingAlert:YES preferredModel:ProviderSelectedCatalogModel([_store currentProvider])];
}

- (BOOL)modelExistsInProviders:(NSString *)model {
    NSString *target = TrimString(model);
    if (target.length == 0) return NO;
    for (NSDictionary *provider in _store.providers) {
        for (NSDictionary *modelInfo in ProviderModels(provider)) {
            if ([target isEqualToString:ProviderCatalogSlug(provider, modelInfo)] || [target isEqualToString:ModelCustomName(modelInfo)] || [target isEqualToString:TrimString(modelInfo[@"model"])]) {
                return YES;
            }
        }
    }
    return NO;
}

- (BOOL)model:(NSString *)model existsInProvider:(NSDictionary *)provider {
    NSString *target = TrimString(model);
    if (target.length == 0 || !provider) return NO;
    for (NSDictionary *modelInfo in ProviderModels(provider)) {
        if ([target isEqualToString:ProviderCatalogSlug(provider, modelInfo)]) {
            return YES;
        }
    }
    return NO;
}

- (void)syncCodexStateShowingAlert:(BOOL)showAlert preferredModel:(NSString *)preferredModel {
    if (!RouteEnabled()) return;

    NSDictionary *current = [_store currentProvider];
    NSString *configuredModel = [CodexConfigWriter configuredModel];
    NSString *model = preferredModel.length > 0
        ? preferredModel
        : ([self model:configuredModel existsInProvider:current] ? configuredModel : (current ? ProviderSelectedCatalogModel(current) : @"gpt-4.1"));
    NSError *configError = nil;
    if (![CodexConfigWriter applyLocalGatewayWithModel:model error:&configError]) {
        if (showAlert) ShowAlert(@"Codex 本地代理配置失败", configError.localizedDescription);
        return;
    }

    NSError *catalogError = nil;
    if (![CodexModelCatalogWriter applyCatalogForProviders:_store.providers currentModel:model error:&catalogError]) {
        if (showAlert) ShowAlert(@"Codex 模型目录同步失败", catalogError.localizedDescription);
        return;
    }
}

- (void)setupMainMenu {
    NSMenu *mainMenu = [[NSMenu alloc] initWithTitle:@""];

    NSMenuItem *appMenuItem = [[NSMenuItem alloc] initWithTitle:@"" action:nil keyEquivalent:@""];
    NSMenu *appMenu = [[NSMenu alloc] initWithTitle:AppDisplayName];
    [appMenu addItem:[[NSMenuItem alloc] initWithTitle:[NSString stringWithFormat:@"%@ %@", AKSText(@"隐藏", @"Hide"), AppDisplayName] action:@selector(hide:) keyEquivalent:@"h"]];
    [appMenu addItem:NSMenuItem.separatorItem];
    NSMenuItem *quitItem = [[NSMenuItem alloc] initWithTitle:[NSString stringWithFormat:@"%@ %@", AKSText(@"退出", @"Quit"), AppDisplayName] action:@selector(quit) keyEquivalent:@"q"];
    quitItem.target = self;
    [appMenu addItem:quitItem];
    appMenuItem.submenu = appMenu;
    [mainMenu addItem:appMenuItem];

    NSMenuItem *editMenuItem = [[NSMenuItem alloc] initWithTitle:@"" action:nil keyEquivalent:@""];
    NSMenu *editMenu = [[NSMenu alloc] initWithTitle:AKSText(@"编辑", @"Edit")];
    [editMenu addItem:[[NSMenuItem alloc] initWithTitle:AKSText(@"撤销", @"Undo") action:@selector(undo:) keyEquivalent:@"z"]];
    [editMenu addItem:[[NSMenuItem alloc] initWithTitle:AKSText(@"重做", @"Redo") action:@selector(redo:) keyEquivalent:@"Z"]];
    [editMenu addItem:NSMenuItem.separatorItem];
    [editMenu addItem:[[NSMenuItem alloc] initWithTitle:AKSText(@"剪切", @"Cut") action:@selector(cut:) keyEquivalent:@"x"]];
    [editMenu addItem:[[NSMenuItem alloc] initWithTitle:AKSText(@"复制", @"Copy") action:@selector(copy:) keyEquivalent:@"c"]];
    [editMenu addItem:[[NSMenuItem alloc] initWithTitle:AKSText(@"粘贴", @"Paste") action:@selector(paste:) keyEquivalent:@"v"]];
    [editMenu addItem:[[NSMenuItem alloc] initWithTitle:AKSText(@"全选", @"Select All") action:@selector(selectAll:) keyEquivalent:@"a"]];
    editMenuItem.submenu = editMenu;
    [mainMenu addItem:editMenuItem];

    NSMenuItem *windowMenuItem = [[NSMenuItem alloc] initWithTitle:@"" action:nil keyEquivalent:@""];
    NSMenu *windowMenu = [[NSMenu alloc] initWithTitle:AKSText(@"窗口", @"Window")];
    [windowMenu addItem:[self menuItem:AKSText(@"关闭主界面", @"Close Main Window") action:@selector(closeMainWindow) key:@"w"]];
    windowMenuItem.submenu = windowMenu;
    [mainMenu addItem:windowMenuItem];

    NSApp.mainMenu = mainMenu;
}

- (void)renderMenu {
    NSDictionary *current = [_store currentProvider];
    NSString *currentName = current ? current[@"name"] : AKSText(@"未选择", @"Not selected");
    NSButton *statusButton = _statusItem.button;
    statusButton.image = nil;
    statusButton.imagePosition = NSNoImage;
    statusButton.attributedTitle = [self statusBarTitleForCurrentName:currentName];

    NSMenu *menu = [[NSMenu alloc] init];
    NSString *currentTitle = current ? [NSString stringWithFormat:@"%@：%@", AKSText(@"当前", @"Current"), currentName] : [NSString stringWithFormat:@"%@：%@", AKSText(@"当前", @"Current"), AKSText(@"未选择", @"Not selected")];
    NSMenuItem *currentItem = [[NSMenuItem alloc] initWithTitle:currentTitle action:nil keyEquivalent:@""];
    currentItem.enabled = NO;
    [menu addItem:currentItem];

    NSString *modeTitle = _gateway.running ? AKSText(@"模式：本地路由代理", @"Mode: Local routing proxy") : AKSText(@"模式：本地路由代理已停用", @"Mode: Local routing proxy disabled");
    NSMenuItem *modeItem = [[NSMenuItem alloc] initWithTitle:modeTitle action:nil keyEquivalent:@""];
    modeItem.enabled = NO;
    [menu addItem:modeItem];
    NSString *endpointTitle = _gateway.running ? [NSString stringWithFormat:@"%@：%@", AKSText(@"代理", @"Proxy"), [_gateway endpointText]] : AKSText(@"代理：未运行", @"Proxy: Not running");
    NSMenuItem *endpointItem = [[NSMenuItem alloc] initWithTitle:endpointTitle action:nil keyEquivalent:@""];
    endpointItem.enabled = NO;
    [menu addItem:endpointItem];
    if (current) {
        NSString *modelTitle = [NSString stringWithFormat:@"%@：%@", AKSText(@"模型", @"Model"), ProviderSelectedModelName(current)];
        NSMenuItem *modelItem = [[NSMenuItem alloc] initWithTitle:modelTitle action:nil keyEquivalent:@""];
        modelItem.enabled = NO;
        [menu addItem:modelItem];
    }

    NSMenuItem *providerMenuItem = [[NSMenuItem alloc] initWithTitle:AKSText(@"切换供应商", @"Switch Provider") action:nil keyEquivalent:@""];
    NSMenu *providerMenu = [[NSMenu alloc] initWithTitle:AKSText(@"切换供应商", @"Switch Provider")];
    if (_store.providers.count == 0) {
        NSMenuItem *emptyItem = [[NSMenuItem alloc] initWithTitle:AKSText(@"暂无供应商", @"No providers") action:nil keyEquivalent:@""];
        emptyItem.enabled = NO;
        [providerMenu addItem:emptyItem];
    } else {
        for (NSDictionary *provider in _store.providers) {
            BOOL isCurrentProvider = [provider[@"id"] isEqualToString:_store.currentId];
            BOOL hasAPIKey = [_store apiKeyForProvider:provider].length > 0;
            NSString *providerName = provider[@"name"] ?: @"";
            NSString *title = providerName;
            if (!hasAPIKey) {
                title = [NSString stringWithFormat:@"%@（%@）", providerName, AKSText(@"缺 Key", @"Missing Key")];
            }
            NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:title action:@selector(selectProvider:) keyEquivalent:@""];
            item.target = self;
            item.representedObject = provider[@"id"];
            item.enabled = hasAPIKey;
            item.state = isCurrentProvider ? NSControlStateValueOn : NSControlStateValueOff;
            [providerMenu addItem:item];
        }
    }
    providerMenuItem.submenu = providerMenu;
    [menu addItem:providerMenuItem];

    if (current) {
        NSMenuItem *modelMenuItem = [[NSMenuItem alloc] initWithTitle:AKSText(@"切换模型", @"Switch Model") action:nil keyEquivalent:@""];
        NSMenu *modelMenu = [[NSMenu alloc] initWithTitle:AKSText(@"切换模型", @"Switch Model")];
        NSString *selectedSlug = ProviderSelectedCatalogModel(current);
        for (NSDictionary *model in ProviderModels(current)) {
            NSString *slug = ProviderCatalogSlug(current, model);
            NSString *title = ModelCustomName(model);
            NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:title action:@selector(selectModel:) keyEquivalent:@""];
            item.target = self;
            item.representedObject = @{@"providerId": current[@"id"] ?: @"", @"model": slug ?: @""};
            item.state = [slug isEqualToString:selectedSlug] ? NSControlStateValueOn : NSControlStateValueOff;
            [modelMenu addItem:item];
        }
        modelMenuItem.submenu = modelMenu;
        [menu addItem:modelMenuItem];
    }
    [menu addItem:NSMenuItem.separatorItem];

    [menu addItem:[self menuItem:AKSText(@"打开主界面", @"Open Main Window") action:@selector(openWindow) key:@"o"]];
    [menu addItem:[self menuItem:AKSText(@"复制当前环境变量", @"Copy Current Environment") action:@selector(copyCurrentEnvFromMenu) key:@"c"]];
    [menu addItem:NSMenuItem.separatorItem];
    [menu addItem:[self menuItem:AKSText(@"退出", @"Quit") action:@selector(quit) key:@"q"]];
    _statusItem.menu = menu;
}

- (NSAttributedString *)statusBarTitleForCurrentName:(NSString *)currentName {
    NSString *title = [NSString stringWithFormat:@"CK：%@", currentName ?: @""];
    return [[NSAttributedString alloc] initWithString:title attributes:@{
        NSFontAttributeName: [NSFont systemFontOfSize:14 weight:NSFontWeightSemibold],
        NSForegroundColorAttributeName: NSColor.whiteColor
    }];
}

- (NSMenuItem *)menuItem:(NSString *)title action:(SEL)action key:(NSString *)key {
    NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:title action:action keyEquivalent:key];
    item.target = self;
    return item;
}

- (void)selectProvider:(NSMenuItem *)sender {
    NSString *targetProviderId = [sender.representedObject isKindOfClass:NSString.class] ? sender.representedObject : @"";
    if ([targetProviderId isEqualToString:_store.currentId]) return;

    for (NSDictionary *provider in _store.providers) {
        if (![provider[@"id"] isEqualToString:targetProviderId]) continue;
        if ([_store apiKeyForProvider:provider].length == 0) {
            ShowAlert(@"切换失败", @"该配置缺少本地 API Key，请打开主界面编辑后重新填写 Key。");
            return;
        }
        break;
    }

    NSError *error = nil;
    if (![_store setCurrentId:targetProviderId notifyCodex:NO error:&error]) {
        ShowAlert(@"切换失败", error.localizedDescription);
    } else {
        NSDictionary *current = [_store currentProvider];
        ShowAlert(AKSText(@"已切换供应商", @"Provider Switched"),
                  [NSString stringWithFormat:@"%@\n\n%@：%@\n%@：%@",
                   ModelSwitchReplayNoticeText(),
                   AKSText(@"供应商", @"Provider"),
                   current[@"name"] ?: @"",
                   AKSText(@"模型", @"Model"),
                   current ? ProviderSelectedModelName(current) : @""]);
    }
}

- (void)selectModel:(NSMenuItem *)sender {
    NSDictionary *payload = [sender.representedObject isKindOfClass:NSDictionary.class] ? sender.representedObject : nil;
    NSString *providerId = TrimString(payload[@"providerId"]);
    NSString *model = TrimString(payload[@"model"]);
    NSDictionary *beforeProvider = [_store currentProvider];
    NSString *beforeModel = beforeProvider ? ProviderSelectedCatalogModel(beforeProvider) : @"";
    if ([providerId isEqualToString:_store.currentId] && [model isEqualToString:beforeModel]) return;

    NSError *error = nil;
    if (![_store setSelectedModel:model forProviderId:providerId notifyCodex:NO error:&error]) {
        ShowAlert(AKSText(@"模型切换失败", @"Model Switch Failed"), error.localizedDescription);
    } else {
        NSDictionary *current = [_store currentProvider];
        ShowAlert(AKSText(@"已切换模型", @"Model Switched"),
                  [NSString stringWithFormat:@"%@\n\n%@：%@\n%@：%@",
                   ModelSwitchReplayNoticeText(),
                   AKSText(@"供应商", @"Provider"),
                   current[@"name"] ?: @"",
                   AKSText(@"模型", @"Model"),
                   current ? ProviderSelectedModelName(current) : @""]);
    }
}

- (void)openWindow {
    [_windowController showWindow:nil];
    [_windowController.window center];
    [NSApp activateIgnoringOtherApps:YES];
}

- (void)closeMainWindow {
    [_windowController.window orderOut:nil];
}

- (void)copyCurrentEnvFromMenu {
    NSDictionary *provider = [_store currentProvider];
    NSString *apiKey = provider ? [_store apiKeyForProvider:provider] : nil;
    if (!provider || apiKey.length == 0) {
        ShowAlert(@"复制失败", @"请先选择当前配置。");
        return;
    }

    NSString *text = [NSString stringWithFormat:@"AI_PROVIDER_NAME=%@\nOPENAI_API_KEY=%@\nOPENAI_BASE_URL=%@\nOPENAI_MODEL=%@",
                      provider[@"name"], apiKey, provider[@"baseURL"], ProviderSelectedCatalogModel(provider)];
    if (!ConfirmSensitiveClipboardCopy()) return;
    CopySensitiveTextToPasteboard(text);
}

- (BOOL)confirmRestoreCodexConfig {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = @"恢复 Codex 原配置？";
    alert.informativeText = [NSString stringWithFormat:@"这会用启用本地代理前的备份覆盖 ~/.codex/config.toml、~/.codex/auth.json，并尽量恢复 models_cache.json，然后停止本地代理。恢复后需要重启 Codex。\n\n独立恢复脚本：%@", [CodexConfigWriter restoreScriptPath]];
    [alert addButtonWithTitle:@"恢复配置"];
    [alert addButtonWithTitle:@"取消"];
    alert.alertStyle = NSAlertStyleWarning;
    return [alert runModal] == NSAlertFirstButtonReturn;
}

- (BOOL)restoreCodexConfigWithConfirmation:(BOOL)shouldConfirm showSuccess:(BOOL)showSuccess {
    if (shouldConfirm && ![self confirmRestoreCodexConfig]) return NO;

    _isRestoringCodexConfig = YES;
    NSError *error = nil;
    if (![CodexConfigWriter restoreManagedBackup:&error]) {
        _isRestoringCodexConfig = NO;
        ShowAlert(@"恢复失败", error.localizedDescription);
        return NO;
    }

    [NSUserDefaults.standardUserDefaults setBool:NO forKey:@"routeEnabled"];
    [NSUserDefaults.standardUserDefaults setBool:NO forKey:@"autoStartLocalRoute"];
    [NSUserDefaults.standardUserDefaults setBool:YES forKey:@"routeDisabledExplicitly"];
    [NSUserDefaults.standardUserDefaults synchronize];
    [_gateway stop];
    [self renderMenu];
    _isRestoringCodexConfig = NO;
    if (showSuccess) {
        ShowAlert(@"已恢复 Codex 配置", [NSString stringWithFormat:@"本地代理已停止，模型目录也已尽量恢复。请重启 Codex，让它读取恢复后的配置。\n\n独立恢复脚本：%@", [CodexConfigWriter restoreScriptPath]]);
    }
    return YES;
}

- (BOOL)restoreCodexConfigWithConfirmation:(BOOL)shouldConfirm {
    return [self restoreCodexConfigWithConfirmation:shouldConfirm showSuccess:YES];
}

- (void)restoreCodexConfigFromMenu {
    [self restoreCodexConfigWithConfirmation:YES];
}

- (void)quit {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = AKSText(@"退出 Codex Key Switcher？", @"Quit Codex Key Switcher?");
    alert.informativeText = AKSText(
        @"退出后将停止本地路由，并恢复 Codex 的默认连接设置。已经打开的 Codex 会话可能需要重新启动后才能生效。",
        @"Quitting will stop local routing and restore Codex's default connection settings. Restart any open Codex sessions for the change to take effect."
    );
    [alert addButtonWithTitle:AKSText(@"退出", @"Quit")];
    [alert addButtonWithTitle:AKSText(@"继续使用", @"Keep Using")];
    alert.alertStyle = NSAlertStyleWarning;

    NSModalResponse response = [alert runModal];
    if (response == NSAlertSecondButtonReturn) return;

    if (response == NSAlertFirstButtonReturn && ![self restoreCodexConfigWithConfirmation:NO showSuccess:NO]) {
        return;
    }

    [NSApp terminate:nil];
}

- (void)applicationWillTerminate:(NSNotification *)notification {
    if (!_isRestoringCodexConfig && RouteEnabled() && [CodexConfigWriter configUsesLocalGateway] && [CodexConfigWriter hasManagedBackup]) {
        _isRestoringCodexConfig = YES;
        [CodexConfigWriter restoreManagedBackup:nil];
    }
    [_gateway stop];
}
@end
