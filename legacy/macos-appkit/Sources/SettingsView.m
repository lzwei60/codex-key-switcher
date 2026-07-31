#import "MainWindowController+Internal.h"
#import "SettingsView.h"
#import "HealthChecker.h"
#import "PortConflictChecker.h"

@implementation MainWindowController (SettingsView)
- (void)renderSettingsPage {
    _page = @"settings";
    [self clearContentHost];
    [self refreshThemeColors];

    NSStackView *header = [self pageHeaderWithTitle:AKSText(@"设置", @"Settings") subtitle:nil back:YES];
    header.translatesAutoresizingMaskIntoConstraints = NO;
    NSView *tabs = [self settingsTabs];
    tabs.translatesAutoresizingMaskIntoConstraints = NO;

    NSView *content = nil;
    if ([_settingsTab isEqualToString:@"route"]) {
        content = [self routeSettingsView];
    } else if ([_settingsTab isEqualToString:@"stats"]) {
        content = [self statsSettingsView];
    } else if ([_settingsTab isEqualToString:@"diagnostics"]) {
        content = [self diagnosticsSettingsView];
    } else if ([_settingsTab isEqualToString:@"about"]) {
        content = [self aboutSettingsView];
    } else {
        content = [self generalSettingsView];
    }
    NSScrollView *scroll = [self scrollViewWithContent:content];
    [_contentHost addSubview:header];
    [_contentHost addSubview:tabs];
    [_contentHost addSubview:scroll];
    [NSLayoutConstraint activateConstraints:@[
        [header.leadingAnchor constraintEqualToAnchor:_contentHost.leadingAnchor constant:24],
        [header.trailingAnchor constraintEqualToAnchor:_contentHost.trailingAnchor constant:-24],
        [header.topAnchor constraintEqualToAnchor:_contentHost.topAnchor constant:24],
        [tabs.leadingAnchor constraintEqualToAnchor:_contentHost.leadingAnchor constant:24],
        [tabs.trailingAnchor constraintEqualToAnchor:_contentHost.trailingAnchor constant:-24],
        [tabs.topAnchor constraintEqualToAnchor:header.bottomAnchor constant:18],
        [tabs.heightAnchor constraintEqualToConstant:48],
        [scroll.leadingAnchor constraintEqualToAnchor:_contentHost.leadingAnchor constant:24],
        [scroll.trailingAnchor constraintEqualToAnchor:_contentHost.trailingAnchor constant:-24],
        [scroll.topAnchor constraintEqualToAnchor:tabs.bottomAnchor constant:18],
        [scroll.bottomAnchor constraintEqualToAnchor:_contentHost.bottomAnchor constant:-24]
    ]];
}
- (NSView *)settingsTabs {
    NSStackView *tabs = [[NSStackView alloc] init];
    tabs.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    tabs.spacing = 6;
    tabs.distribution = NSStackViewDistributionFillEqually;
    tabs.wantsLayer = YES;
    tabs.layer.cornerRadius = 8;
    tabs.layer.borderWidth = 1;
    tabs.layer.borderColor = [self lineColor].CGColor;
    tabs.layer.backgroundColor = [self panelBackgroundColor].CGColor;
    tabs.edgeInsets = NSEdgeInsetsMake(6, 6, 6, 6);
    NSArray *items = @[
        @[AKSText(@"通用", @"General"), @"general"],
        @[AKSText(@"路由", @"Routing"), @"route"],
        @[AKSText(@"使用统计", @"Usage"), @"stats"],
        @[AKSText(@"诊断", @"Diagnostics"), @"diagnostics"],
        @[AKSText(@"关于", @"About"), @"about"]
    ];
    for (NSArray *item in items) {
        NSButton *button = [NSButton buttonWithTitle:item[0] target:self action:@selector(selectSettingsTab:)];
        button.identifier = item[1];
        BOOL active = [_settingsTab isEqualToString:item[1]];
        [self styleExistingButton:button primary:active];
        button.layer.borderWidth = active ? 0 : 0;
        button.layer.backgroundColor = (active ? [self primaryBlueColor] : [NSColor clearColor]).CGColor;
        button.contentTintColor = active ? NSColor.whiteColor : [self mutedTextColor];
        [button.widthAnchor constraintGreaterThanOrEqualToConstant:160].active = YES;
        [tabs addArrangedSubview:button];
    }
    return tabs;
}
- (NSView *)generalSettingsView {
    NSView *panel = [self panel];
    NSStackView *stack = [self verticalStackWithSpacing:18];
    [self pinSubview:stack toView:panel inset:18];

    [self addFullWidthView:[self sectionTitle:AKSText(@"界面语言", @"Interface Language") subtitle:AKSText(@"选择后立即切换并永久保存。", @"Changes are applied and saved immediately.")] toStack:stack];
    NSArray *languages = @[@[@"简体中文", @"zh-Hans"], @[@"English", @"en"]];
    [self addFullWidthView:[self segmentedControlWithItems:languages selected:_pendingLanguage action:@selector(selectLanguageOption:)] toStack:stack];

    [self addFullWidthView:[self sectionTitle:AKSText(@"外观主题", @"Appearance") subtitle:AKSText(@"选择应用的外观主题，立即生效。", @"Choose an appearance theme. Changes apply immediately.")] toStack:stack];
    NSArray *themes = @[@[AKSText(@"跟随系统", @"System"), @"system"], @[AKSText(@"浅色", @"Light"), @"light"], @[AKSText(@"深色", @"Dark"), @"dark"]];
    NSString *theme = [NSUserDefaults.standardUserDefaults stringForKey:@"appearanceTheme"] ?: @"system";
    [self addFullWidthView:[self segmentedControlWithItems:themes selected:theme action:@selector(selectThemeOption:)] toStack:stack];

    [self addFullWidthView:[self sectionTitle:AKSText(@"窗口行为", @"Window Behavior") subtitle:AKSText(@"开机自启：登录 macOS 后自动运行 Codex Key Switcher。", @"Launch at login: start Codex Key Switcher after signing in to macOS.")] toStack:stack];
    _launchAtLoginSwitch = [[NSSwitch alloc] init];
    BOOL launchEnabled = [NSUserDefaults.standardUserDefaults boolForKey:@"launchAtLogin"];
    if (@available(macOS 13.0, *)) launchEnabled = SMAppService.mainAppService.status == SMAppServiceStatusEnabled;
    _launchAtLoginSwitch.state = launchEnabled ? NSControlStateValueOn : NSControlStateValueOff;
    _launchAtLoginSwitch.target = self;
    _launchAtLoginSwitch.action = @selector(launchAtLoginChanged);
    [stack addArrangedSubview:_launchAtLoginSwitch];

    [self addFullWidthView:[self sectionTitle:AKSText(@"配置文件目录", @"Configuration Directory") subtitle:AKSText(@"选择包含 config.toml 和 auth.json 的 Codex 配置目录。", @"Choose the Codex directory containing config.toml and auth.json.")] toStack:stack];
    _codexDirField = [self textField:@"~/.codex"];
    _codexDirField.stringValue = [NSUserDefaults.standardUserDefaults stringForKey:@"codexConfigDir"] ?: [NSHomeDirectory() stringByAppendingPathComponent:@".codex"];
    NSStackView *directoryRow = [[NSStackView alloc] init];
    directoryRow.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    directoryRow.alignment = NSLayoutAttributeCenterY;
    directoryRow.spacing = 8;
    [_codexDirField setContentHuggingPriority:NSLayoutPriorityDefaultLow forOrientation:NSLayoutConstraintOrientationHorizontal];
    [directoryRow addArrangedSubview:_codexDirField];
    [directoryRow addArrangedSubview:[self styledButton:AKSText(@"选择…", @"Choose…") action:@selector(chooseCodexDirectory) primary:NO]];
    [self addFullWidthView:directoryRow toStack:stack];

    NSButton *save = [self styledButton:AKSText(@"保存设置", @"Save Settings") action:@selector(saveGeneralSettings) primary:YES];
    [stack addArrangedSubview:save];
    [self addVerticalSpacerToStack:stack];
    return panel;
}
- (NSView *)routeSettingsView {
    NSView *panel = [self panel];
    NSStackView *stack = [self verticalStackWithSpacing:16];
    [self pinSubview:stack toView:panel inset:18];

    [self addFullWidthView:[self sectionTitle:AKSText(@"主页面显示本地路由开关", @"Show routing controls on main page") subtitle:AKSText(@"开启后，主页面顶部将显示路由和故障转移开关。", @"Shows routing and failover switches at the top of the main page.")] toStack:stack];
    _showRouteControlsSwitch = [[NSSwitch alloc] init];
    _showRouteControlsSwitch.state = [NSUserDefaults.standardUserDefaults boolForKey:@"showRouteControls"] ? NSControlStateValueOn : NSControlStateValueOff;
    _showRouteControlsSwitch.target = self;
    _showRouteControlsSwitch.action = @selector(showRouteControlsChanged);
    [stack addArrangedSubview:_showRouteControlsSwitch];

    [self addFullWidthView:[self sectionTitle:AKSText(@"故障转移", @"Failover") subtitle:AKSText(@"开启后，当前配置发生连接错误、超时或返回 5xx 时，将按配置列表顺序尝试下一个可用配置；4xx 业务错误不会切换，避免重复提交无效请求。", @"When enabled, connection errors, timeouts, and 5xx responses retry the next configuration in list order. 4xx errors do not fail over, preventing duplicate invalid requests.")] toStack:stack];
    _failoverSwitch = [[NSSwitch alloc] init];
    _failoverSwitch.state = [NSUserDefaults.standardUserDefaults boolForKey:@"failoverEnabled"] ? NSControlStateValueOn : NSControlStateValueOff;
    _failoverSwitch.target = self;
    _failoverSwitch.action = @selector(failoverSwitchChanged);
    [stack addArrangedSubview:_failoverSwitch];

    NSString *routeState = RouteEnabled() ? AKSText(@"路由总开关已启动", @"Routing enabled") : AKSText(@"路由总开关已停止", @"Routing disabled");
    [self addFullWidthView:[self sectionTitle:routeState subtitle:AKSText(@"配置本地路由服务监听的地址与端口。", @"Configure the local routing service listen address and port.")] toStack:stack];

    _listenAddressField = [self textField:@"127.0.0.1"];
    _listenAddressField.stringValue = [NSUserDefaults.standardUserDefaults stringForKey:@"listenAddress"] ?: @"127.0.0.1";
    [self addFullWidthView:[self fieldGroup:AKSText(@"监听地址", @"Listen Address") field:_listenAddressField] toStack:stack];

    _listenPortField = [self textField:@"3456"];
    NSInteger port = [NSUserDefaults.standardUserDefaults integerForKey:@"listenPort"];
    _listenPortField.stringValue = [NSString stringWithFormat:@"%ld", (long)(port > 0 ? port : GatewayPort)];
    [self addFullWidthView:[self fieldGroup:AKSText(@"监听端口", @"Listen Port") field:_listenPortField] toStack:stack];

    NSStackView *portCheckRow = [[NSStackView alloc] init];
    portCheckRow.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    portCheckRow.spacing = 10;
    portCheckRow.alignment = NSLayoutAttributeCenterY;
    _routePortCheckButton = [self styledButton:AKSText(@"检测端口", @"Check Port") action:@selector(testRoutePort) primary:NO];
    [_routePortCheckButton.widthAnchor constraintGreaterThanOrEqualToConstant:108].active = YES;
    _routePortStatusLabel = [NSTextField labelWithString:AKSText(@"未检测", @"Not checked")];
    _routePortStatusLabel.font = [NSFont systemFontOfSize:13 weight:NSFontWeightMedium];
    _routePortStatusLabel.textColor = [self mutedTextColor];
    _routePortStatusLabel.maximumNumberOfLines = 2;
    [_routePortStatusLabel setContentHuggingPriority:NSLayoutPriorityDefaultLow forOrientation:NSLayoutConstraintOrientationHorizontal];
    [_routePortStatusLabel setContentCompressionResistancePriority:NSLayoutPriorityDefaultLow forOrientation:NSLayoutConstraintOrientationHorizontal];
    [portCheckRow addArrangedSubview:_routePortCheckButton];
    [portCheckRow addArrangedSubview:_routePortStatusLabel];
    [self addFullWidthView:portCheckRow toStack:stack];
    [self resetRoutePortCheckState];

    NSTextField *hint = [NSTextField labelWithString:AKSText(@"监听地址默认只允许 127.x.x.x；监听端口范围：1024 ~ 65535。保存后本地代理会立即切换到新地址，并同步写入 Codex 配置；重启 Codex 后生效。", @"The listen address is limited to 127.x.x.x by default. Port range: 1024-65535. Saving immediately restarts the local proxy on the new endpoint and updates Codex configuration. Restart Codex to apply it.")];
    hint.textColor = NSColor.secondaryLabelColor;
    hint.maximumNumberOfLines = 3;
    [self addFullWidthView:hint toStack:stack];

    NSButton *save = [self styledButton:AKSText(@"保存路由设置", @"Save Routing") action:@selector(saveRouteSettings) primary:YES];
    [stack addArrangedSubview:save];
    [self addVerticalSpacerToStack:stack];
    return panel;
}
- (NSView *)diagnosticsSettingsView {
    NSView *panel = [self panel];
    NSStackView *stack = [self verticalStackWithSpacing:16];
    [self pinSubview:stack toView:panel inset:18];

    AKSHealthReport *report = [HealthChecker checkWithGateway:_gateway store:_store];
    NSString *levelText = report.level == AKSHealthLevelOK ? AKSText(@"正常", @"OK") : (report.level == AKSHealthLevelWarning ? AKSText(@"警告", @"Warning") : AKSText(@"错误", @"Error"));
    [self addFullWidthView:[self sectionTitle:AKSText(@"诊断与恢复", @"Diagnostics and Restore") subtitle:report.message] toStack:stack];
    [self addFullWidthView:[self keyValueView:@[
        @[AKSText(@"健康状态", @"Health"), [NSString stringWithFormat:@"%@ · %@", levelText, report.title ?: @""]],
        @[AKSText(@"本地路由", @"Local routing"), report.routeEnabled ? AKSText(@"已启用", @"Enabled") : AKSText(@"已停用", @"Disabled")],
        @[AKSText(@"代理服务", @"Gateway"), report.gatewayRunning ? AKSText(@"运行中", @"Running") : AKSText(@"未运行", @"Stopped")],
        @[AKSText(@"代理地址", @"Endpoint"), report.endpoint ?: @""],
        @[AKSText(@"Codex 指向代理", @"Codex uses proxy"), report.codexUsesGateway ? AKSText(@"是", @"Yes") : AKSText(@"否", @"No")],
        @[AKSText(@"恢复备份", @"Restore backup"), report.restoreAvailable ? AKSText(@"可用", @"Available") : AKSText(@"不可用", @"Unavailable")],
        @[AKSText(@"当前供应商", @"Current provider"), report.currentProviderName ?: @""],
        @[AKSText(@"当前模型", @"Current model"), report.currentModel ?: @""],
        @[AKSText(@"Codex 目录", @"Codex directory"), report.codexDirectory ?: @""],
        @[AKSText(@"恢复脚本", @"Restore script"), report.restoreScriptPath ?: @""]
    ]] toStack:stack];

    NSStackView *actions = [[NSStackView alloc] init];
    actions.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    actions.spacing = 8;
    actions.alignment = NSLayoutAttributeCenterY;
    NSButton *resync = [self styledButton:AKSText(@"重新同步 Codex 配置", @"Resync Codex Configuration") action:@selector(resyncCodexConfiguration) primary:YES];
    NSButton *restore = [self styledButton:AKSText(@"停用路由并恢复 Codex 原配置", @"Disable Routing and Restore Codex") action:@selector(restoreCodexConfigFromSettings) primary:NO];
    NSButton *prepareUninstall = [self styledButton:AKSText(@"准备卸载", @"Prepare Uninstall") action:@selector(prepareUninstallFromSettings) primary:NO];
    NSButton *openScript = [self styledButton:AKSText(@"打开恢复脚本目录", @"Open Restore Script Folder") action:@selector(openRestoreScriptFolder) primary:NO];
    NSButton *copy = [self styledButton:AKSText(@"复制诊断信息", @"Copy Diagnostics") action:@selector(copyDiagnostics) primary:NO];
    [actions addArrangedSubview:resync];
    [actions addArrangedSubview:restore];
    [actions addArrangedSubview:prepareUninstall];
    [actions addArrangedSubview:openScript];
    [actions addArrangedSubview:copy];
    [self addFullWidthView:actions toStack:stack];

    NSTextField *hint = [NSTextField labelWithString:AKSText(@"发布给其他用户时，卸载 App 前应先在这里恢复 Codex 原配置。异常删除 App 后，也可以运行恢复脚本手动还原。", @"Before uninstalling the app, restore the original Codex configuration here. If the app is removed unexpectedly, run the restore script manually.")];
    hint.textColor = [self mutedTextColor];
    hint.maximumNumberOfLines = 3;
    [self addFullWidthView:hint toStack:stack];
    [self addVerticalSpacerToStack:stack];
    return panel;
}
- (NSView *)aboutSettingsView {
    NSView *panel = [self panel];
    NSStackView *stack = [self verticalStackWithSpacing:12];
    [self pinSubview:stack toView:panel inset:18];
    [self addFullWidthView:[self sectionTitle:@"Codex Key Switcher" subtitle:AKSText(@"用于管理 Codex API Key、Base URL、模型别名与本地 Responses 路由。", @"Manage Codex API keys, base URLs, model aliases, and local Responses routing.")] toStack:stack];
    [stack addArrangedSubview:[NSTextField labelWithString:AKSText(@"版本：1.1.0", @"Version: 1.1.0")]];
    [stack addArrangedSubview:[NSTextField labelWithString:[NSString stringWithFormat:@"%@: %@", AKSText(@"本地代理", @"Local proxy"), ConfiguredGatewayEndpoint()]]];
    [stack addArrangedSubview:[NSTextField labelWithString:[NSString stringWithFormat:@"%@: %@", AKSText(@"配置目录", @"Configuration directory"), [NSUserDefaults.standardUserDefaults stringForKey:@"codexConfigDir"] ?: [NSHomeDirectory() stringByAppendingPathComponent:@".codex"]]]];
    [self addVerticalSpacerToStack:stack];
    return panel;
}
- (void)showSettingsPage {
    _page = @"settings";
    _settingsTab = @"general";
    [self renderSettingsPage];
}
- (void)selectSettingsTab:(NSButton *)sender {
    _settingsTab = sender.identifier ?: @"general";
    [self renderSettingsPage];
}
- (void)chooseCodexDirectory {
    NSOpenPanel *panel = [NSOpenPanel openPanel];
    panel.title = AKSText(@"选择 Codex 配置目录", @"Choose Codex Configuration Directory");
    panel.prompt = AKSText(@"选择", @"Choose");
    panel.canChooseFiles = NO;
    panel.canChooseDirectories = YES;
    panel.allowsMultipleSelection = NO;
    panel.canCreateDirectories = NO;
    NSString *currentPath = [_codexDirField.stringValue stringByExpandingTildeInPath].stringByStandardizingPath;
    if (currentPath.length > 0) panel.directoryURL = [NSURL fileURLWithPath:currentPath isDirectory:YES];
    if ([panel runModal] == NSModalResponseOK) {
        _codexDirField.stringValue = panel.URL.path.stringByStandardizingPath ?: @"";
    }
}
- (void)saveGeneralSettings {
    NSString *path = [[_codexDirField.stringValue aks_trimmed] stringByExpandingTildeInPath].stringByStandardizingPath;
    BOOL isDirectory = NO;
    NSFileManager *fileManager = NSFileManager.defaultManager;
    if (path.length == 0 || ![fileManager fileExistsAtPath:path isDirectory:&isDirectory] || !isDirectory) {
        ShowAlert(AKSText(@"配置目录无效", @"Invalid Configuration Directory"), AKSText(@"请选择一个已存在的文件夹。", @"Choose an existing directory."));
        return;
    }

    NSString *configPath = [path stringByAppendingPathComponent:@"config.toml"];
    NSString *authPath = [path stringByAppendingPathComponent:@"auth.json"];
    if (![fileManager isReadableFileAtPath:configPath] || ![fileManager isReadableFileAtPath:authPath]) {
        ShowAlert(AKSText(@"Codex 配置不完整", @"Incomplete Codex Configuration"), AKSText(@"所选目录必须包含可读取的 config.toml 和 auth.json。", @"The selected directory must contain readable config.toml and auth.json files."));
        return;
    }

    NSString *oldPath = [NSUserDefaults.standardUserDefaults stringForKey:@"codexConfigDir"];
    [NSUserDefaults.standardUserDefaults setObject:path forKey:@"codexConfigDir"];
    [NSUserDefaults.standardUserDefaults synchronize];

    NSDictionary *currentProvider = [_store currentProvider];
    NSString *model = currentProvider ? ProviderSelectedCatalogModel(currentProvider) : ([CodexConfigWriter configuredModel] ?: @"gpt-4.1");
    NSError *error = nil;
    if (![CodexConfigWriter applyLocalGatewayWithModel:model error:&error]) {
        if (oldPath.length > 0) {
            [NSUserDefaults.standardUserDefaults setObject:oldPath forKey:@"codexConfigDir"];
        } else {
            [NSUserDefaults.standardUserDefaults removeObjectForKey:@"codexConfigDir"];
        }
        [NSUserDefaults.standardUserDefaults synchronize];
        ShowAlert(AKSText(@"配置目录未应用", @"Configuration Directory Not Applied"), error.localizedDescription ?: AKSText(@"写入 Codex 配置失败，已恢复原目录。", @"Failed to update Codex configuration. The previous directory was restored."));
        return;
    }

    NSString *modelsCachePath = [path stringByAppendingPathComponent:@"models_cache.json"];
    if ([fileManager isReadableFileAtPath:modelsCachePath]) {
        NSError *catalogError = nil;
        if (![CodexModelCatalogWriter applyCatalogForProviders:_store.providers currentModel:model error:&catalogError]) {
            ShowAlert(AKSText(@"目录已保存，模型目录同步失败", @"Directory Saved, Model Catalog Sync Failed"), catalogError.localizedDescription);
            return;
        }
    }

    _codexDirField.stringValue = path;
    ShowAlert(AKSText(@"通用设置已保存", @"General Settings Saved"), AKSText(@"配置目录已应用。请重启 Codex 后生效。", @"The configuration directory is active. Restart Codex to apply it."));
}
- (void)launchAtLoginChanged {
    BOOL shouldEnable = _launchAtLoginSwitch.state == NSControlStateValueOn;
    NSError *error = nil;
    BOOL success = NO;
    BOOL requiresApproval = NO;
    if (@available(macOS 13.0, *)) {
        SMAppService *service = SMAppService.mainAppService;
        BOOL requestSucceeded = shouldEnable ? [service registerAndReturnError:&error] : [service unregisterAndReturnError:&error];
        (void)requestSucceeded;
        SMAppServiceStatus status = service.status;
        if (shouldEnable) {
            requiresApproval = status == SMAppServiceStatusRequiresApproval;
            success = status == SMAppServiceStatusEnabled;
        } else {
            success = status == SMAppServiceStatusNotRegistered;
        }
    }

    if (!success) {
        _launchAtLoginSwitch.state = shouldEnable ? NSControlStateValueOff : NSControlStateValueOn;
        if (requiresApproval) {
            if (@available(macOS 13.0, *)) [SMAppService openSystemSettingsLoginItems];
            ShowAlert(AKSText(@"需要系统批准", @"System Approval Required"), AKSText(@"登录项已提交，但 macOS 要求你在“系统设置 > 通用 > 登录项”中允许 Codex Key Switcher。批准后重新打开此页面即可看到真实状态。", @"The login item was submitted, but macOS requires approval in System Settings > General > Login Items. After approval, reopen this page to see the actual status."));
            return;
        }
        ShowAlert(AKSText(@"开机自启设置失败", @"Launch at Login Failed"), error.localizedDescription ?: AKSText(@"系统未能更新登录项。", @"macOS could not update the login item."));
        return;
    }

    [NSUserDefaults.standardUserDefaults setBool:shouldEnable forKey:@"launchAtLogin"];
    [NSUserDefaults.standardUserDefaults synchronize];
}
- (void)showRouteControlsChanged {
    [NSUserDefaults.standardUserDefaults setBool:_showRouteControlsSwitch.state == NSControlStateValueOn forKey:@"showRouteControls"];
}
- (void)routeSwitchChanged {
    BOOL shouldEnable = _routeEnabledSwitch.state == NSControlStateValueOn;
    [NSUserDefaults.standardUserDefaults setBool:shouldEnable forKey:@"routeEnabled"];
    [NSUserDefaults.standardUserDefaults setBool:shouldEnable forKey:@"autoStartLocalRoute"];
    [NSUserDefaults.standardUserDefaults setBool:!shouldEnable forKey:@"routeDisabledExplicitly"];
    [NSUserDefaults.standardUserDefaults synchronize];

    if (!shouldEnable) {
        NSError *restoreError = nil;
        if (![CodexConfigWriter restoreManagedBackup:&restoreError]) {
            [NSUserDefaults.standardUserDefaults setBool:YES forKey:@"routeEnabled"];
            [NSUserDefaults.standardUserDefaults setBool:YES forKey:@"autoStartLocalRoute"];
            [NSUserDefaults.standardUserDefaults setBool:NO forKey:@"routeDisabledExplicitly"];
            [NSUserDefaults.standardUserDefaults synchronize];
            _routeEnabledSwitch.state = NSControlStateValueOn;
            ShowAlert(AKSText(@"路由无法停用", @"Routing Could Not Be Disabled"), restoreError.localizedDescription ?: AKSText(@"未能恢复 Codex 原配置。", @"Could not restore the original Codex configuration."));
            [self refreshSidebar];
            [NSNotificationCenter.defaultCenter postNotificationName:RouteStateDidChangeNotification object:self];
            [self renderCurrentPage];
            return;
        }
        [_gateway stop];
        [self refreshSidebar];
        [NSNotificationCenter.defaultCenter postNotificationName:RouteStateDidChangeNotification object:self];
        [self renderCurrentPage];
        return;
    }

    NSDictionary *currentProvider = [_store currentProvider];
    if (!currentProvider || [_store apiKeyForProvider:currentProvider].length == 0) {
        [NSUserDefaults.standardUserDefaults setBool:NO forKey:@"routeEnabled"];
        [NSUserDefaults.standardUserDefaults setBool:NO forKey:@"autoStartLocalRoute"];
        [NSUserDefaults.standardUserDefaults setBool:YES forKey:@"routeDisabledExplicitly"];
        [NSUserDefaults.standardUserDefaults synchronize];
        _routeEnabledSwitch.state = NSControlStateValueOff;
        ShowAlert(AKSText(@"本地路由无法启用", @"Local Routing Could Not Be Enabled"),
                  AKSText(@"请先选择一个包含本地 API Key 的供应商配置。", @"Select a provider configuration with a local API key first."));
        [self refreshSidebar];
        [NSNotificationCenter.defaultCenter postNotificationName:RouteStateDidChangeNotification object:self];
        [self renderCurrentPage];
        return;
    }

    NSError *gatewayError = nil;
    NSInteger changedPort = 0;
    if (![_gateway startAllowingPortFallback:&gatewayError changedPort:&changedPort]) {
        [NSUserDefaults.standardUserDefaults setBool:NO forKey:@"routeEnabled"];
        [NSUserDefaults.standardUserDefaults setBool:NO forKey:@"autoStartLocalRoute"];
        [NSUserDefaults.standardUserDefaults setBool:YES forKey:@"routeDisabledExplicitly"];
        [NSUserDefaults.standardUserDefaults synchronize];
        _routeEnabledSwitch.state = NSControlStateValueOff;
        ShowAlert(AKSText(@"本地路由代理启动失败", @"Local Routing Proxy Failed"), gatewayError.localizedDescription);
        [self refreshSidebar];
        [NSNotificationCenter.defaultCenter postNotificationName:RouteStateDidChangeNotification object:self];
        [self renderCurrentPage];
        return;
    }
    if (changedPort > 0) {
        ShowAlert(AKSText(@"本地路由端口已自动切换", @"Local Routing Port Changed"), [NSString stringWithFormat:AKSText(@"指定端口被占用，已自动切换到 %@。", @"The requested port was busy. Switched automatically to %@."), ConfiguredGatewayEndpoint()]);
    }

    NSString *model = currentProvider ? ProviderSelectedCatalogModel(currentProvider) : ([CodexConfigWriter configuredModel] ?: @"gpt-4.1");
    NSError *configError = nil;
    if (![CodexConfigWriter applyLocalGatewayWithModel:model error:&configError]) {
        [_gateway stop];
        [NSUserDefaults.standardUserDefaults setBool:NO forKey:@"routeEnabled"];
        [NSUserDefaults.standardUserDefaults setBool:NO forKey:@"autoStartLocalRoute"];
        [NSUserDefaults.standardUserDefaults setBool:YES forKey:@"routeDisabledExplicitly"];
        [NSUserDefaults.standardUserDefaults synchronize];
        _routeEnabledSwitch.state = NSControlStateValueOff;
        ShowAlert(AKSText(@"Codex 本地代理配置失败", @"Codex Proxy Configuration Failed"), configError.localizedDescription);
        [self refreshSidebar];
        [NSNotificationCenter.defaultCenter postNotificationName:RouteStateDidChangeNotification object:self];
        [self renderCurrentPage];
        return;
    }

    NSError *catalogError = nil;
    if (![CodexModelCatalogWriter applyCatalogForProviders:_store.providers currentModel:model error:&catalogError]) {
        ShowAlert(AKSText(@"Codex 模型目录同步失败", @"Codex Model Catalog Sync Failed"), catalogError.localizedDescription);
    }
    [self refreshSidebar];
    [NSNotificationCenter.defaultCenter postNotificationName:RouteStateDidChangeNotification object:self];
    [self renderCurrentPage];
}
- (void)failoverSwitchChanged {
    [NSUserDefaults.standardUserDefaults setBool:_failoverSwitch.state == NSControlStateValueOn forKey:@"failoverEnabled"];
}
- (NSString *)routePortFingerprintWithAddress:(NSString *)address port:(NSInteger)port {
    return [NSString stringWithFormat:@"%@:%ld", address ?: @"", (long)port];
}
- (void)configureRoutePortCheckForState:(NSString *)state message:(NSString *)message {
    if (!_routePortCheckButton || !_routePortStatusLabel) return;

    _routePortCheckButton.wantsLayer = YES;
    _routePortCheckButton.bezelStyle = NSBezelStyleRegularSquare;
    _routePortCheckButton.bordered = NO;
    _routePortCheckButton.layer.cornerRadius = 8;

    if ([state isEqualToString:@"success"]) {
        _routePortCheckButton.title = AKSText(@"端口可用", @"Port OK");
        _routePortCheckButton.layer.backgroundColor = NSColor.systemGreenColor.CGColor;
        _routePortCheckButton.contentTintColor = NSColor.whiteColor;
        _routePortStatusLabel.textColor = NSColor.systemGreenColor;
    } else if ([state isEqualToString:@"failed"]) {
        _routePortCheckButton.title = AKSText(@"端口冲突", @"Port Busy");
        _routePortCheckButton.layer.backgroundColor = NSColor.systemRedColor.CGColor;
        _routePortCheckButton.contentTintColor = NSColor.whiteColor;
        _routePortStatusLabel.textColor = NSColor.systemRedColor;
    } else {
        _routePortCheckButton.title = AKSText(@"检测端口", @"Check Port");
        _routePortCheckButton.layer.backgroundColor = [self softPanelBackgroundColor].CGColor;
        _routePortCheckButton.contentTintColor = [self mutedTextColor];
        _routePortStatusLabel.textColor = [self mutedTextColor];
    }
    _routePortStatusLabel.stringValue = message ?: @"";
}
- (void)resetRoutePortCheckState {
    _routePortCheckPassed = NO;
    _routePortCheckFingerprint = nil;
    [self configureRoutePortCheckForState:@"idle" message:AKSText(@"保存前会再次检测端口是否被其他程序占用。", @"The port will be checked again before saving.")];
}
- (BOOL)validateRouteEndpointAddress:(NSString *)address port:(NSInteger)port safePort:(NSInteger *)safePort errorMessage:(NSString **)errorMessage {
    struct in_addr parsedAddress;
    if (inet_pton(AF_INET, address.UTF8String, &parsedAddress) != 1) {
        if (errorMessage) *errorMessage = AKSText(@"监听地址必须是合法的 IPv4 地址，例如 127.0.0.1。", @"Enter a valid IPv4 address, such as 127.0.0.1.");
        return NO;
    }
    BOOL allowLANListen = [NSUserDefaults.standardUserDefaults boolForKey:@"allowLANListen"];
    if (!allowLANListen && ![address hasPrefix:@"127."]) {
        if (errorMessage) *errorMessage = AKSText(@"公开版本默认只允许监听 127.x.x.x。本地代理包含模型路由能力，不建议暴露到局域网。", @"The public build only allows 127.x.x.x by default. The local proxy should not be exposed to the LAN.");
        return NO;
    }
    if (port < 1024 || port > 65535) {
        if (errorMessage) *errorMessage = AKSText(@"监听端口必须在 1024 ~ 65535 之间。", @"The listen port must be between 1024 and 65535.");
        return NO;
    }

    if ([PortConflictChecker portHasAnyListener:port excludingPID:getpid()]) {
        NSInteger fallback = [PortConflictChecker firstSafePortFrom:port + 1 maxAttempts:20];
        if (safePort) *safePort = fallback;
        if (errorMessage) {
            *errorMessage = fallback > 0
                ? [NSString stringWithFormat:AKSText(@"端口 %ld 已被其他程序占用，建议改用 %ld。", @"Port %ld is already used by another process. Try %ld instead."), (long)port, (long)fallback]
                : [NSString stringWithFormat:AKSText(@"端口 %ld 已被其他程序占用，且后续 20 个端口也不可用。", @"Port %ld is already used by another process, and no fallback was found in the next 20 ports."), (long)port];
        }
        return NO;
    }
    if (safePort) *safePort = 0;
    return YES;
}
- (void)testRoutePort {
    NSString *address = [_listenAddressField.stringValue aks_trimmed];
    NSInteger port = _listenPortField.stringValue.integerValue;
    NSInteger safePort = 0;
    NSString *errorMessage = nil;
    if (![self validateRouteEndpointAddress:address port:port safePort:&safePort errorMessage:&errorMessage]) {
        _routePortCheckPassed = NO;
        _routePortCheckFingerprint = nil;
        [self configureRoutePortCheckForState:@"failed" message:errorMessage];
        return;
    }

    _routePortCheckPassed = YES;
    _routePortCheckFingerprint = [self routePortFingerprintWithAddress:address port:port];
    [self configureRoutePortCheckForState:@"success" message:[NSString stringWithFormat:AKSText(@"%@:%ld 可用于本地路由。", @"%@:%ld is available for local routing."), address, (long)port]];
}
- (void)saveRouteSettings {
    NSString *address = [_listenAddressField.stringValue aks_trimmed];
    NSInteger port = _listenPortField.stringValue.integerValue;
    NSInteger safePort = 0;
    NSString *validationError = nil;
    if (![self validateRouteEndpointAddress:address port:port safePort:&safePort errorMessage:&validationError]) {
        [self configureRoutePortCheckForState:@"failed" message:validationError];
        NSString *title = safePort > 0 ? AKSText(@"端口已被占用", @"Port Already In Use") : AKSText(@"路由配置无效", @"Invalid Routing Configuration");
        ShowAlert(title, validationError);
        return;
    }
    _routePortCheckPassed = YES;
    _routePortCheckFingerprint = [self routePortFingerprintWithAddress:address port:port];
    [self configureRoutePortCheckForState:@"success" message:[NSString stringWithFormat:AKSText(@"%@:%ld 可用，正在保存。", @"%@:%ld is available. Saving."), address, (long)port]];

    NSString *oldAddress = ConfiguredListenAddress();
    NSInteger oldPort = ConfiguredGatewayPort();
    [NSUserDefaults.standardUserDefaults setObject:address forKey:@"listenAddress"];
    [NSUserDefaults.standardUserDefaults setInteger:port forKey:@"listenPort"];
    [NSUserDefaults.standardUserDefaults synchronize];

    if (!RouteEnabled()) {
        [self refreshSidebar];
        ShowAlert(AKSText(@"路由配置已保存", @"Routing Configuration Saved"), AKSText(@"新的监听地址已保存；路由开启后生效。", @"The new endpoint was saved and will apply when routing is enabled."));
        return;
    }

    NSError *gatewayError = nil;
    NSInteger changedPort = 0;
    if (![_gateway restartAllowingPortFallback:&gatewayError changedPort:&changedPort]) {
        [NSUserDefaults.standardUserDefaults setObject:oldAddress forKey:@"listenAddress"];
        [NSUserDefaults.standardUserDefaults setInteger:oldPort forKey:@"listenPort"];
        [NSUserDefaults.standardUserDefaults synchronize];
        [_gateway restart:nil];
        ShowAlert(AKSText(@"路由配置未应用", @"Routing Configuration Not Applied"), gatewayError.localizedDescription ?: AKSText(@"无法启动新的监听地址。已恢复原配置。", @"Could not start the new endpoint. The previous configuration was restored."));
        return;
    }
    if (changedPort > 0) {
        _listenPortField.stringValue = [NSString stringWithFormat:@"%ld", (long)changedPort];
        ShowAlert(AKSText(@"本地路由端口已自动切换", @"Local Routing Port Changed"), [NSString stringWithFormat:AKSText(@"指定端口被占用，已自动切换到 %@。", @"The requested port was busy. Switched automatically to %@."), ConfiguredGatewayEndpoint()]);
    }

    NSDictionary *currentProvider = [_store currentProvider];
    NSString *model = currentProvider ? ProviderSelectedCatalogModel(currentProvider) : ([CodexConfigWriter configuredModel] ?: @"gpt-4.1");
    NSError *configError = nil;
    if (![CodexConfigWriter applyLocalGatewayWithModel:model error:&configError]) {
        [NSUserDefaults.standardUserDefaults setObject:oldAddress forKey:@"listenAddress"];
        [NSUserDefaults.standardUserDefaults setInteger:oldPort forKey:@"listenPort"];
        [NSUserDefaults.standardUserDefaults synchronize];
        [_gateway restartAllowingPortFallback:nil changedPort:nil];
        ShowAlert(AKSText(@"Codex 配置更新失败", @"Codex Configuration Update Failed"), configError.localizedDescription ?: AKSText(@"已恢复原路由配置。", @"The previous routing configuration was restored."));
        return;
    }

    [self refreshSidebar];
    ShowAlert(AKSText(@"路由配置已保存", @"Routing Configuration Saved"), AKSText(@"新的监听地址已应用。请重启 Codex 后生效。", @"The new endpoint is active. Restart Codex to apply it."));
}
- (BOOL)confirmRestoreFromSettings {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = AKSText(@"停用路由并恢复 Codex 原配置？", @"Disable routing and restore original Codex configuration?");
    alert.informativeText = [NSString stringWithFormat:@"%@\n\n%@：%@", AKSText(@"这会停止本地代理，并用启用代理前的备份恢复 config.toml、auth.json 和模型目录。恢复后请重启 Codex。", @"This stops the local proxy and restores config.toml, auth.json, and the model catalog from the backup created before enabling the proxy. Restart Codex after restoring."), AKSText(@"独立恢复脚本", @"Standalone restore script"), [CodexConfigWriter restoreScriptPath]];
    [alert addButtonWithTitle:AKSText(@"恢复", @"Restore")];
    [alert addButtonWithTitle:AKSText(@"取消", @"Cancel")];
    alert.alertStyle = NSAlertStyleWarning;
    return [alert runModal] == NSAlertFirstButtonReturn;
}
- (void)restoreCodexConfigFromSettings {
    if (![self confirmRestoreFromSettings]) return;
    NSError *error = nil;
    if (![CodexConfigWriter restoreManagedBackup:&error]) {
        ShowAlert(AKSText(@"恢复失败", @"Restore Failed"), error.localizedDescription ?: AKSText(@"未能恢复 Codex 原配置。", @"Could not restore the original Codex configuration."));
        [self renderSettingsPage];
        return;
    }
    [NSUserDefaults.standardUserDefaults setBool:NO forKey:@"routeEnabled"];
    [NSUserDefaults.standardUserDefaults setBool:NO forKey:@"autoStartLocalRoute"];
    [NSUserDefaults.standardUserDefaults setBool:YES forKey:@"routeDisabledExplicitly"];
    [NSUserDefaults.standardUserDefaults synchronize];
    [_gateway stop];
    [self refreshSidebar];
    [self renderSettingsPage];
    ShowAlert(AKSText(@"已恢复 Codex 配置", @"Codex Configuration Restored"), AKSText(@"本地路由已停用。请重启 Codex，让它读取恢复后的配置。", @"Local routing has been disabled. Restart Codex so it reads the restored configuration."));
}
- (void)prepareUninstallFromSettings {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = AKSText(@"准备卸载 Codex Key Switcher？", @"Prepare to uninstall Codex Key Switcher?");
    alert.informativeText = AKSText(
        @"这会恢复 Codex 原配置、停止本地路由并关闭开机自启。你的供应商配置、API Key、本地用量统计不会被删除；如果确认不再使用，可以之后手动删除 ~/Library/Application Support/AIKeySwitcher。",
        @"This restores the original Codex configuration, stops local routing, and disables launch at login. Provider configurations, API keys, and usage stats are not deleted; remove ~/Library/Application Support/AIKeySwitcher manually if you no longer need them."
    );
    [alert addButtonWithTitle:AKSText(@"恢复并停用", @"Restore and Disable")];
    [alert addButtonWithTitle:AKSText(@"取消", @"Cancel")];
    alert.alertStyle = NSAlertStyleWarning;
    if ([alert runModal] != NSAlertFirstButtonReturn) return;

    NSError *restoreError = nil;
    if ([CodexConfigWriter hasManagedBackup] && ![CodexConfigWriter restoreManagedBackup:&restoreError]) {
        ShowAlert(AKSText(@"准备卸载失败", @"Prepare Uninstall Failed"), restoreError.localizedDescription ?: AKSText(@"未能恢复 Codex 原配置。", @"Could not restore the original Codex configuration."));
        [self renderSettingsPage];
        return;
    }

    [NSUserDefaults.standardUserDefaults setBool:NO forKey:@"routeEnabled"];
    [NSUserDefaults.standardUserDefaults setBool:NO forKey:@"autoStartLocalRoute"];
    [NSUserDefaults.standardUserDefaults setBool:YES forKey:@"routeDisabledExplicitly"];
    [NSUserDefaults.standardUserDefaults setBool:NO forKey:@"launchAtLogin"];
    [NSUserDefaults.standardUserDefaults synchronize];
    [_gateway stop];

    if (@available(macOS 13.0, *)) {
        [SMAppService.mainAppService unregisterAndReturnError:nil];
    }

    [self refreshSidebar];
    [self renderSettingsPage];
    ShowAlert(AKSText(@"已准备卸载", @"Ready to Uninstall"), AKSText(@"Codex 原配置已恢复，本地路由和开机自启已关闭。请重启 Codex 后再删除应用。", @"The original Codex configuration has been restored. Local routing and launch at login are disabled. Restart Codex before deleting the app."));
}
- (void)openRestoreScriptFolder {
    NSString *scriptPath = [CodexConfigWriter restoreScriptPath];
    NSURL *scriptURL = [NSURL fileURLWithPath:scriptPath];
    if ([NSFileManager.defaultManager fileExistsAtPath:scriptPath]) {
        [NSWorkspace.sharedWorkspace activateFileViewerSelectingURLs:@[scriptURL]];
        return;
    }
    [NSWorkspace.sharedWorkspace openURL:[scriptURL URLByDeletingLastPathComponent]];
}
- (void)copyDiagnostics {
    AKSHealthReport *report = [HealthChecker checkWithGateway:_gateway store:_store];
    [NSPasteboard.generalPasteboard clearContents];
    [NSPasteboard.generalPasteboard setString:[report diagnosticText] forType:NSPasteboardTypeString];
    ShowAlert(AKSText(@"已复制诊断信息", @"Diagnostics Copied"), AKSText(@"诊断信息不包含 API Key。", @"The diagnostics do not contain API keys."));
}
- (void)resyncCodexConfiguration {
    if (!RouteEnabled()) {
        ShowAlert(AKSText(@"本地路由未启用", @"Local Routing Disabled"), AKSText(@"请先开启本地路由。", @"Enable local routing first."));
        return;
    }
    NSError *gatewayError = nil;
    NSInteger changedPort = 0;
    if (!_gateway.running && ![_gateway startAllowingPortFallback:&gatewayError changedPort:&changedPort]) {
        ShowAlert(AKSText(@"本地路由代理启动失败", @"Local Routing Proxy Failed"), gatewayError.localizedDescription);
        [self renderSettingsPage];
        return;
    }
    if (changedPort > 0) {
        ShowAlert(AKSText(@"本地路由端口已自动切换", @"Local Routing Port Changed"), [NSString stringWithFormat:AKSText(@"原端口被占用，已自动切换到 %@。", @"The original port was busy. Switched automatically to %@."), ConfiguredGatewayEndpoint()]);
    }

    NSDictionary *currentProvider = [_store currentProvider];
    NSString *model = currentProvider ? ProviderSelectedCatalogModel(currentProvider) : ([CodexConfigWriter configuredModel] ?: @"gpt-4.1");
    NSError *configError = nil;
    if (![CodexConfigWriter applyLocalGatewayWithModel:model error:&configError]) {
        ShowAlert(AKSText(@"Codex 配置同步失败", @"Codex Configuration Sync Failed"), configError.localizedDescription);
        [self renderSettingsPage];
        return;
    }
    NSError *catalogError = nil;
    if (![CodexModelCatalogWriter applyCatalogForProviders:_store.providers currentModel:model error:&catalogError]) {
        ShowAlert(AKSText(@"Codex 模型目录同步失败", @"Codex Model Catalog Sync Failed"), catalogError.localizedDescription);
        [self renderSettingsPage];
        return;
    }
    [self refreshSidebar];
    [self renderSettingsPage];
    ShowAlert(AKSText(@"同步完成", @"Sync Complete"), AKSText(@"Codex 配置已重新指向本地路由代理。请重启 Codex 后生效。", @"Codex is configured to use the local routing proxy again. Restart Codex to apply it."));
}
@end
