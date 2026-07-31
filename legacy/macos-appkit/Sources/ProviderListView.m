#import "MainWindowController+Internal.h"
#import "ProviderListView.h"

@implementation MainWindowController (ProviderListView)
- (void)renderMainPage {
    _page = @"main";
    NSStackView *root = [self pageRootWithSpacing:18];

    NSStackView *header = [self pageHeaderWithTitle:AKSText(@"配置列表", @"Configurations") subtitle:AKSText(@"管理 Codex 使用的 API Key、Base URL 与模型别名。", @"Manage API keys, base URLs, and model aliases used by Codex.") back:NO];
    NSButton *addButton = [self styledButton:AKSText(@"添加配置", @"Add") action:@selector(showAddPage) primary:YES];
    NSButton *importButton = [self styledButton:AKSText(@"导入", @"Import") action:@selector(importProviders) primary:NO];
    NSButton *exportButton = [self styledButton:AKSText(@"导出", @"Export") action:@selector(exportProviders) primary:NO];
    NSButton *settingsButton = [self styledButton:AKSText(@"设置", @"Settings") action:@selector(showSettingsPage) primary:NO];
    [header addArrangedSubview:addButton];
    [header addArrangedSubview:importButton];
    [header addArrangedSubview:exportButton];
    [header addArrangedSubview:settingsButton];
    [self addFullWidthView:header toStack:root];

    if ([NSUserDefaults.standardUserDefaults boolForKey:@"showRouteControls"]) {
        NSView *routePanel = [self softPanel];
        NSStackView *route = [[NSStackView alloc] init];
        route.orientation = NSUserInterfaceLayoutOrientationHorizontal;
        route.alignment = NSLayoutAttributeCenterY;
        route.spacing = 16;
        [self pinSubview:route toView:routePanel inset:14];
        NSTextField *routeTitle = [NSTextField labelWithString:AKSText(@"本地路由", @"Local Routing")];
        routeTitle.font = [NSFont systemFontOfSize:14 weight:NSFontWeightSemibold];
        [route addArrangedSubview:routeTitle];
        _routeEnabledSwitch = [[NSSwitch alloc] init];
        _routeEnabledSwitch.state = RouteEnabled() ? NSControlStateValueOn : NSControlStateValueOff;
        _routeEnabledSwitch.target = self;
        _routeEnabledSwitch.action = @selector(routeSwitchChanged);
        [route addArrangedSubview:_routeEnabledSwitch];
        [route addArrangedSubview:[NSTextField labelWithString:AKSText(@"故障转移", @"Failover")]];
        _failoverSwitch = [[NSSwitch alloc] init];
        _failoverSwitch.state = [NSUserDefaults.standardUserDefaults boolForKey:@"failoverEnabled"] ? NSControlStateValueOn : NSControlStateValueOff;
        _failoverSwitch.target = self;
        _failoverSwitch.action = @selector(failoverSwitchChanged);
        [route addArrangedSubview:_failoverSwitch];
        NSView *spacer = [[NSView alloc] init];
        [spacer setContentHuggingPriority:NSLayoutPriorityDefaultLow forOrientation:NSLayoutConstraintOrientationHorizontal];
        [route addArrangedSubview:spacer];
        NSTextField *stateLabel = [NSTextField labelWithString:RouteEnabled() ? AKSText(@"路由总开关已启动", @"Routing enabled") : AKSText(@"路由总开关已停止", @"Routing disabled")];
        stateLabel.textColor = [self mutedTextColor];
        [route addArrangedSubview:stateLabel];
        [self addFullWidthView:routePanel toStack:root];
    }

    NSScrollView *scroll = [[NSScrollView alloc] init];
    scroll.hasVerticalScroller = YES;
    scroll.drawsBackground = NO;
    scroll.borderType = NSNoBorder;
    scroll.translatesAutoresizingMaskIntoConstraints = NO;
    FlippedView *documentView = [[FlippedView alloc] init];
    documentView.translatesAutoresizingMaskIntoConstraints = NO;
    _listStack = [self verticalStackWithSpacing:10];
    _listStack.edgeInsets = NSEdgeInsetsMake(0, 0, 0, 10);
    [documentView addSubview:_listStack];
    scroll.documentView = documentView;
    [NSLayoutConstraint activateConstraints:@[
        [_listStack.leadingAnchor constraintEqualToAnchor:documentView.leadingAnchor],
        [_listStack.trailingAnchor constraintEqualToAnchor:documentView.trailingAnchor],
        [_listStack.topAnchor constraintEqualToAnchor:documentView.topAnchor],
        [_listStack.bottomAnchor constraintLessThanOrEqualToAnchor:documentView.bottomAnchor],
        [_listStack.widthAnchor constraintEqualToAnchor:documentView.widthAnchor],
        [documentView.widthAnchor constraintEqualToAnchor:scroll.contentView.widthAnchor constant:-8],
        [documentView.heightAnchor constraintGreaterThanOrEqualToAnchor:scroll.contentView.heightAnchor]
    ]];
    [self addFullWidthView:scroll toStack:root];
    [scroll.heightAnchor constraintGreaterThanOrEqualToConstant:480].active = YES;
    [self reload];
}
- (void)showMainPage {
    _page = @"main";
    [self renderMainPage];
}

- (NSView *)providerCard:(NSDictionary *)provider {
    NSView *container = [self panel];
    BOOL current = [provider[@"id"] isEqualToString:_store.currentId];
    container.layer.borderWidth = current ? 2 : 1;
    container.layer.borderColor = current ? [self primaryBlueColor].CGColor : [self lineColor].CGColor;
    container.layer.backgroundColor = [self panelBackgroundColor].CGColor;

    NSStackView *stack = [self verticalStackWithSpacing:12];
    [self pinSubview:stack toView:container inset:16];

    NSStackView *titleRow = [[NSStackView alloc] init];
    titleRow.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    titleRow.alignment = NSLayoutAttributeCenterY;
    titleRow.spacing = 10;

    NSString *name = provider[@"name"] ?: @"";
    NSString *initial = name.length > 0 ? [[name substringToIndex:1] uppercaseString] : @"K";
    NSView *logo = [self centeredTextContainerWithText:initial
                                             textColor:[self primaryBlueColor]
                                       backgroundColor:[self colorWithHex:0xeef4ff]
                                                  font:[NSFont systemFontOfSize:16 weight:NSFontWeightBold]
                                          cornerRadius:8
                                              minWidth:36
                                                height:36
                                     horizontalPadding:0];
    [logo.widthAnchor constraintEqualToConstant:36].active = YES;

    NSStackView *nameStack = [self verticalStackWithSpacing:3];
    NSTextField *title = [NSTextField labelWithString:provider[@"name"]];
    title.font = [NSFont systemFontOfSize:16 weight:NSFontWeightSemibold];
    NSString *apiFormatName = APIFormatDisplayName(ProviderAPIFormat(provider));
    NSString *metaText = current
        ? [NSString stringWithFormat:@"%@ · %@", apiFormatName, AKSText(@"当前使用", @"In use")]
        : (UseEnglishLanguage() ? [NSString stringWithFormat:@"%@ · %lu models", apiFormatName, (unsigned long)ProviderModels(provider).count] : [NSString stringWithFormat:@"%@ · %lu 个模型", apiFormatName, (unsigned long)ProviderModels(provider).count]);
    NSTextField *meta = [NSTextField labelWithString:metaText];
    meta.font = [NSFont systemFontOfSize:12];
    meta.textColor = [self mutedTextColor];
    [nameStack addArrangedSubview:title];
    [nameStack addArrangedSubview:meta];

    BOOL hasAPIKey = [_store apiKeyForProvider:provider].length > 0;
    NSString *badgeText = !hasAPIKey ? AKSText(@"缺 Key", @"Missing Key") : (current ? AKSText(@"当前", @"Current") : ([provider[@"tag"] length] > 0 ? provider[@"tag"] : AKSText(@"备用", @"Backup")));
    NSColor *badgeTextColor = !hasAPIKey ? NSColor.systemRedColor : (current ? NSColor.systemGreenColor : [self primaryBlueColor]);
    NSColor *badgeBackgroundColor = !hasAPIKey ? [self colorWithHex:0xffeeee] : (current ? [self colorWithHex:0xe9fbf2] : [self colorWithHex:0xe9f2ff]);
    NSView *badge = [self centeredTextContainerWithText:badgeText
                                             textColor:badgeTextColor
                                       backgroundColor:badgeBackgroundColor
                                                  font:[NSFont systemFontOfSize:12 weight:NSFontWeightSemibold]
                                          cornerRadius:10
                                              minWidth:52
                                                height:24
                                     horizontalPadding:8];
    NSView *titleSpacer = [[NSView alloc] init];
    [titleSpacer setContentHuggingPriority:NSLayoutPriorityDefaultLow forOrientation:NSLayoutConstraintOrientationHorizontal];
    [titleRow addArrangedSubview:logo];
    [titleRow addArrangedSubview:nameStack];
    [titleRow addArrangedSubview:titleSpacer];
    [titleRow addArrangedSubview:badge];
    [self addFullWidthView:titleRow toStack:stack];

    NSString *apiKey = [_store displayAPIKeyForProvider:provider];
    NSMutableArray<NSString *> *modelTexts = [NSMutableArray array];
    for (NSDictionary *model in ProviderModels(provider)) {
        NSString *customName = ModelCustomName(model);
        NSString *upstreamModel = TrimString(model[@"model"]);
        [modelTexts addObject:[customName isEqualToString:upstreamModel] ? customName : [NSString stringWithFormat:@"%@ -> %@", customName, upstreamModel]];
    }
    [self addFullWidthView:[self keyValueView:@[
        @[AKSText(@"当前模型", @"Current Model"), ProviderSelectedModelName(provider)],
        @[AKSText(@"模型", @"Models"), [modelTexts componentsJoinedByString:@", "]],
        @[@"Base URL", provider[@"baseURL"] ?: @""],
        @[@"API Key", apiKey ?: @""]
    ]] toStack:stack];

    NSStackView *actions = [[NSStackView alloc] init];
    actions.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    actions.spacing = 8;
    actions.alignment = NSLayoutAttributeCenterY;
    NSView *actionSpacer = [[NSView alloc] init];
    [actionSpacer setContentHuggingPriority:NSLayoutPriorityDefaultLow forOrientation:NSLayoutConstraintOrientationHorizontal];
    NSButton *use = [NSButton buttonWithTitle:current ? AKSText(@"使用中", @"In Use") : AKSText(@"设为当前", @"Set Current") target:self action:@selector(setCurrentFromButton:)];
    use.identifier = provider[@"id"];
    use.enabled = !current && hasAPIKey;
    NSButton *edit = [NSButton buttonWithTitle:AKSText(@"编辑", @"Edit") target:self action:@selector(editProvider:)];
    edit.identifier = provider[@"id"];
    NSButton *delete = [NSButton buttonWithTitle:AKSText(@"删除", @"Delete") target:self action:@selector(deleteProvider:)];
    delete.identifier = provider[@"id"];
    [self styleExistingButton:use primary:NO];
    [self styleExistingButton:edit primary:NO];
    [self styleExistingButton:delete primary:NO];
    [actions addArrangedSubview:actionSpacer];
    [actions addArrangedSubview:use];
    [actions addArrangedSubview:edit];
    [actions addArrangedSubview:delete];
    [self addFullWidthView:actions toStack:stack];

    [container.heightAnchor constraintGreaterThanOrEqualToConstant:190].active = YES;
    return container;
}
- (void)copyCurrentEnv {
    NSDictionary *provider = [_store currentProvider];
    NSString *apiKey = provider ? [_store apiKeyForProvider:provider] : nil;
    if (!provider || apiKey.length == 0) {
        [self showMessage:AKSText(@"请先选择当前配置。", @"Select a current configuration first.") error:YES];
        return;
    }
    NSString *text = [NSString stringWithFormat:@"AI_PROVIDER_NAME=%@\nOPENAI_API_KEY=%@\nOPENAI_BASE_URL=%@\nOPENAI_MODEL=%@",
                      provider[@"name"], apiKey, provider[@"baseURL"], ProviderSelectedCatalogModel(provider)];
    if (!ConfirmSensitiveClipboardCopy()) {
        [self showMessage:AKSText(@"已取消复制。", @"Copy canceled.") error:NO];
        return;
    }
    CopySensitiveTextToPasteboard(text);
    [self showMessage:AKSText(@"已复制当前环境变量，剪贴板会在 2 分钟后自动清空。", @"Current environment variables copied. The clipboard will be cleared in 2 minutes.") error:NO];
}
- (NSInteger)exportAPIKeyMode {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = AKSText(@"导出配置", @"Export Configurations");
    alert.informativeText = AKSText(@"默认导出不包含 API Key，更适合备份配置结构或分享给其他设备。包含 API Key 的文件必须视为敏感文件保存。", @"The default export does not include API keys. Files containing API keys must be treated as sensitive.");
    [alert addButtonWithTitle:AKSText(@"不包含 Key", @"Without Keys")];
    [alert addButtonWithTitle:AKSText(@"包含 Key", @"Include Keys")];
    [alert addButtonWithTitle:AKSText(@"取消", @"Cancel")];
    alert.alertStyle = NSAlertStyleInformational;
    NSModalResponse response = [alert runModal];
    if (response == NSAlertThirdButtonReturn) return -1;
    return response == NSAlertSecondButtonReturn ? 1 : 0;
}
- (void)exportProviders {
    if (_store.providers.count == 0) {
        [self showMessage:AKSText(@"没有可导出的配置。", @"There are no configurations to export.") error:YES];
        return;
    }

    NSInteger exportMode = [self exportAPIKeyMode];
    if (exportMode < 0) {
        [self showMessage:AKSText(@"已取消导出。", @"Export canceled.") error:NO];
        return;
    }
    BOOL includeKeys = exportMode == 1;
    NSSavePanel *panel = [NSSavePanel savePanel];
    panel.title = AKSText(@"导出 Codex Key Switcher 配置", @"Export Codex Key Switcher Configurations");
    panel.nameFieldStringValue = includeKeys ? @"codex-key-switcher-with-keys.json" : @"codex-key-switcher-config.json";
    if ([panel runModal] != NSModalResponseOK) return;

    NSDictionary *payload = [_store exportPayloadIncludingAPIKeys:includeKeys];
    NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:NSJSONWritingPrettyPrinted error:nil];
    NSError *error = nil;
    if (!data || ![data writeToURL:panel.URL options:NSDataWritingAtomic error:&error]) {
        [self showMessage:error.localizedDescription ?: AKSText(@"导出失败。", @"Export failed.") error:YES];
        return;
    }
    [self showMessage:includeKeys ? AKSText(@"已导出配置，文件包含完整 API Key，请妥善保存。", @"Exported with full API keys. Store the file securely.") : AKSText(@"已导出配置，文件不包含 API Key。", @"Exported without API keys.") error:NO];
}
- (void)importProviders {
    NSOpenPanel *panel = [NSOpenPanel openPanel];
    panel.title = AKSText(@"导入 Codex Key Switcher 配置", @"Import Codex Key Switcher Configurations");
    panel.canChooseFiles = YES;
    panel.canChooseDirectories = NO;
    panel.allowsMultipleSelection = NO;
    if ([panel runModal] != NSModalResponseOK) return;

    NSError *error = nil;
    NSData *data = [NSData dataWithContentsOfURL:panel.URL options:0 error:&error];
    NSDictionary *payload = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:&error] : nil;
    if (![payload isKindOfClass:NSDictionary.class]) {
        [self showMessage:error.localizedDescription ?: AKSText(@"导入文件不是合法 JSON 对象。", @"The import file is not a valid JSON object.") error:YES];
        return;
    }

    NSUInteger count = [_store importPayload:payload error:&error];
    if (count == 0) {
        [self showMessage:error.localizedDescription ?: AKSText(@"没有导入任何有效配置。", @"No valid configurations were imported.") error:YES];
        return;
    }
    [self reload];
    [self showMessage:[NSString stringWithFormat:AKSText(@"已导入 %lu 个配置。缺少 API Key 的配置需要编辑后补填。", @"Imported %lu configurations. Configurations without API keys must be edited before use."), (unsigned long)count] error:NO];
}
- (void)setCurrentFromButton:(NSButton *)sender {
    for (NSDictionary *provider in _store.providers) {
        if (![provider[@"id"] isEqualToString:sender.identifier]) continue;
        if ([_store apiKeyForProvider:provider].length == 0) {
            [self showMessage:AKSText(@"该配置缺少本地 API Key，请编辑后重新填写 Key。", @"This configuration is missing a local API key. Edit it and re-enter the key.") error:YES];
            return;
        }
        break;
    }

    NSError *error = nil;
    if (![_store setCurrentId:sender.identifier notifyCodex:NO error:&error]) {
        [self showMessage:error.localizedDescription error:YES];
    } else {
        NSDictionary *current = [_store currentProvider];
        NSString *message = [NSString stringWithFormat:@"%@ %@：%@，%@：%@",
                             ModelSwitchReplayNoticeText(),
                             AKSText(@"供应商", @"Provider"),
                             current[@"name"] ?: @"",
                             AKSText(@"模型", @"Model"),
                             current ? ProviderSelectedModelName(current) : @""];
        [self showMessage:message error:NO];
    }
}
- (void)editProvider:(NSButton *)sender {
    NSString *providerId = sender.identifier;
    for (NSDictionary *provider in _store.providers) {
        if (![provider[@"id"] isEqualToString:providerId]) continue;
        _page = @"edit";
        [self renderFormPageWithTitle:AKSText(@"编辑配置", @"Edit Configuration")];
        _editingId = providerId;
        _nameField.stringValue = provider[@"name"] ?: @"";
        _apiKeyField.stringValue = @"";
        _apiKeyField.placeholderString = AKSText(@"留空表示不修改原 Key", @"Leave blank to keep the current key");
        _baseURLField.stringValue = provider[@"baseURL"] ?: @"";
        [self selectAPIFormat:ProviderAPIFormat(provider)];
        [self setModelRows:ProviderModels(provider)];
        _tagField.stringValue = provider[@"tag"] ?: @"";
        [self resetConnectionCheckState];
        [self showMessage:AKSText(@"编辑已有配置时，API Key 留空会继续使用本地已保存的 Key。", @"When editing, leave API Key blank to keep the locally saved key.") error:NO];
        [self.window makeFirstResponder:_nameField];
        return;
    }
}
- (void)deleteProvider:(NSButton *)sender {
    NSString *providerId = sender.identifier;
    NSDictionary *target = nil;
    for (NSDictionary *provider in _store.providers) {
        if ([provider[@"id"] isEqualToString:providerId]) {
            target = provider;
            break;
        }
    }
    if (!target) return;

    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = @"删除配置";
    alert.informativeText = [NSString stringWithFormat:@"确认删除 %@？", target[@"name"]];
    [alert addButtonWithTitle:@"删除"];
    [alert addButtonWithTitle:@"取消"];
    alert.alertStyle = NSAlertStyleWarning;
    if ([alert runModal] != NSAlertFirstButtonReturn) return;

    NSError *error = nil;
    if (![_store deleteProviderId:providerId error:&error]) {
        [self showMessage:error.localizedDescription error:YES];
    }
    [self showMainPage];
}
@end
