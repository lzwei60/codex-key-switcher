#import "MainWindowController+Internal.h"
#import "ProviderFormView.h"
#import "ProviderPresets.h"

@implementation MainWindowController (ProviderFormView)
- (void)renderFormPageWithTitle:(NSString *)titleText {
    [self clearContentHost];
    [self refreshThemeColors];

    NSStackView *header = [self pageHeaderWithTitle:titleText subtitle:nil back:YES];
    header.translatesAutoresizingMaskIntoConstraints = NO;
    [_contentHost addSubview:header];

    NSView *formPanel = [self panel];
    NSStackView *form = [self verticalStackWithSpacing:16];
    [self pinSubview:form toView:formPanel inset:18];

    _modelRows = [NSMutableArray array];
    _nameField = [self textField:AKSText(@"例如 OpenAI 官方 / 中转 A", @"For example, OpenAI / Relay A")];
    _apiKeyField = [AKSSecureTextField new];
    _apiKeyField.placeholderString = @"sk-...";
    [self configureInputField:_apiKeyField];
    _baseURLField = [self textField:@"https://api.openai.com/v1"];
    _tagField = [self textField:AKSText(@"主力 / 备用 / 便宜", @"Primary / Backup / Low cost")];

    [self addFullWidthView:[self providerPresetView] toStack:form];

    NSStackView *nameRow = [[NSStackView alloc] init];
    nameRow.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    nameRow.spacing = 16;
    nameRow.distribution = NSStackViewDistributionFillEqually;
    [nameRow addArrangedSubview:[self fieldGroup:AKSText(@"名称", @"Name") field:_nameField]];
    [nameRow addArrangedSubview:[self fieldGroup:AKSText(@"标签", @"Tag") field:_tagField]];
    [self addFullWidthView:nameRow toStack:form];
    [self addFullWidthView:[self fieldGroup:@"API Key" field:_apiKeyField] toStack:form];
    [self addFullWidthView:[self fieldGroup:@"Base URL" field:_baseURLField] toStack:form];

    NSView *statusField = [self centeredTextContainerWithText:AKSText(@"未检测", @"Not tested")
                                                    textColor:[self mutedTextColor]
                                              backgroundColor:[self softPanelBackgroundColor]
                                                         font:[NSFont systemFontOfSize:14]
                                                 cornerRadius:8
                                                     minWidth:78
                                                       height:38
                                            horizontalPadding:12];
    statusField.layer.borderWidth = 1;
    statusField.layer.borderColor = [self lineColor].CGColor;
    NSStackView *formatRow = [[NSStackView alloc] init];
    formatRow.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    formatRow.spacing = 16;
    formatRow.distribution = NSStackViewDistributionFillEqually;
    NSArray *apiFormats = @[
        @[APIFormatDisplayName(APIFormatResponses), APIFormatResponses],
        @[APIFormatDisplayName(APIFormatChatCompletions), APIFormatChatCompletions],
        @[APIFormatDisplayName(APIFormatAnthropicMessages), APIFormatAnthropicMessages]
    ];
    _apiFormatControl = [self segmentedControlWithItems:apiFormats selected:[self selectedAPIFormat] action:@selector(selectAPIFormat:)];
    [formatRow addArrangedSubview:[self fieldGroup:AKSText(@"链接 API 格式", @"API Format") field:_apiFormatControl]];
    [formatRow addArrangedSubview:[self fieldGroup:AKSText(@"检测状态", @"Test Status") field:statusField]];
    [self addFullWidthView:formatRow toStack:form];

    [self addFullWidthView:[self modelListView] toStack:form];

    NSStackView *actions = [[NSStackView alloc] init];
    actions.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    actions.spacing = 8;
    actions.alignment = NSLayoutAttributeCenterY;
    NSView *actionSpacer = [[NSView alloc] init];
    [actionSpacer setContentHuggingPriority:NSLayoutPriorityDefaultLow forOrientation:NSLayoutConstraintOrientationHorizontal];
    [actions addArrangedSubview:actionSpacer];
    _testButton = [NSButton buttonWithTitle:AKSText(@"检测连接", @"Test Connection") target:self action:@selector(testConnection)];
    [self configureCheckButtonForState:@"idle"];
    [_testButton.widthAnchor constraintGreaterThanOrEqualToConstant:112].active = YES;
    _saveButton = [NSButton buttonWithTitle:AKSText(@"保存配置", @"Save") target:self action:@selector(saveProvider)];
    _saveButton.keyEquivalent = @"\r";
    _saveButton.enabled = NO;
    [self styleExistingButton:_saveButton primary:YES];
    NSButton *clear = [self styledButton:AKSText(@"清空", @"Clear") action:@selector(clearForm) primary:NO];
    NSButton *copy = [self styledButton:AKSText(@"复制当前环境变量", @"Copy Environment") action:@selector(copyCurrentEnv) primary:NO];
    [actions addArrangedSubview:_testButton];
    [actions addArrangedSubview:_saveButton];
    [actions addArrangedSubview:clear];
    [actions addArrangedSubview:copy];
    [self addFullWidthView:actions toStack:form];

    _messageLabel = [NSTextField labelWithString:AKSText(@"保存前需要先检测连接。", @"Test the connection before saving.")];
    _messageLabel.textColor = NSColor.secondaryLabelColor;
    _messageLabel.lineBreakMode = NSLineBreakByCharWrapping;
    _messageLabel.maximumNumberOfLines = 0;
    [_messageLabel setContentHuggingPriority:NSLayoutPriorityDefaultLow forOrientation:NSLayoutConstraintOrientationHorizontal];
    [_messageLabel setContentCompressionResistancePriority:NSLayoutPriorityDefaultLow forOrientation:NSLayoutConstraintOrientationHorizontal];
    NSStackView *messageContainer = [self verticalStackWithSpacing:0];
    [self addFullWidthView:_messageLabel toStack:messageContainer];
    [self addFullWidthView:messageContainer toStack:form];

    [self addVerticalSpacerToStack:form];

    NSScrollView *scroll = [self scrollViewWithContent:formPanel];
    [_contentHost addSubview:scroll];
    [NSLayoutConstraint activateConstraints:@[
        [header.leadingAnchor constraintEqualToAnchor:_contentHost.leadingAnchor constant:24],
        [header.trailingAnchor constraintEqualToAnchor:_contentHost.trailingAnchor constant:-24],
        [header.topAnchor constraintEqualToAnchor:_contentHost.topAnchor constant:24],
        [scroll.leadingAnchor constraintEqualToAnchor:_contentHost.leadingAnchor constant:24],
        [scroll.trailingAnchor constraintEqualToAnchor:_contentHost.trailingAnchor constant:-24],
        [scroll.topAnchor constraintEqualToAnchor:header.bottomAnchor constant:16],
        [scroll.bottomAnchor constraintEqualToAnchor:_contentHost.bottomAnchor constant:-24]
    ]];
    dispatch_async(dispatch_get_main_queue(), ^{
        if ([self->_page isEqualToString:@"add"]) {
            [self.window makeFirstResponder:self->_nameField];
        }
    });
}
- (NSView *)providerPresetView {
    NSView *container = [self softPanel];
    NSStackView *stack = [self verticalStackWithSpacing:10];
    [self pinSubview:stack toView:container inset:14];

    NSTextField *title = [NSTextField labelWithString:AKSText(@"供应商预设", @"Provider Presets")];
    title.font = [NSFont systemFontOfSize:13 weight:NSFontWeightMedium];
    title.textColor = [self mutedTextColor];
    [self addFullWidthView:title toStack:stack];

    NSStackView *row = [[NSStackView alloc] init];
    row.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    row.spacing = 8;
    row.alignment = NSLayoutAttributeCenterY;
    NSArray<NSDictionary *> *presets = ProviderPresets.allPresets;
    for (NSUInteger index = 0; index < presets.count; index++) {
        NSDictionary *preset = presets[index];
        NSButton *button = [self styledButton:preset[@"title"] ?: @"" action:@selector(applyProviderPreset:) primary:NO];
        button.tag = (NSInteger)index;
        [button setContentHuggingPriority:NSLayoutPriorityRequired forOrientation:NSLayoutConstraintOrientationHorizontal];
        [row addArrangedSubview:button];
    }
    [self addFullWidthView:row toStack:stack];
    return container;
}
- (void)applyProviderPreset:(NSButton *)sender {
    NSArray<NSDictionary *> *presets = ProviderPresets.allPresets;
    NSDictionary *preset = sender.tag >= 0 && (NSUInteger)sender.tag < presets.count ? presets[(NSUInteger)sender.tag] : nil;
    if (!preset) return;

    _nameField.stringValue = preset[@"name"] ?: @"";
    _baseURLField.stringValue = preset[@"baseURL"] ?: @"";
    _tagField.stringValue = preset[@"tag"] ?: @"";
    [self selectAPIFormat:preset[@"apiFormat"] ?: APIFormatResponses];
    [self setModelRows:preset[@"models"] ?: @[]];
    [self resetConnectionCheckState];
    [self showMessage:AKSText(@"已套用预设。请填写 API Key，并检测通过后保存。", @"Preset applied. Enter the API key, then test before saving.") error:NO];
}
- (void)showAddPage {
    _editingId = nil;
    _page = @"add";
    _selectedAPIFormat = APIFormatResponses;
    [self renderFormPageWithTitle:AKSText(@"添加配置", @"Add Configuration")];
    [self clearFormFieldsOnly];
}
- (void)showMessage:(NSString *)message error:(BOOL)isError {
    _messageLabel.stringValue = message ?: @"";
    _messageLabel.textColor = isError ? NSColor.systemRedColor : NSColor.secondaryLabelColor;
    CGFloat availableWidth = _messageLabel.superview.bounds.size.width;
    if (availableWidth > 0) {
        _messageLabel.preferredMaxLayoutWidth = availableWidth;
    }
    [_messageLabel invalidateIntrinsicContentSize];
}
- (NSDictionary *)editingProvider {
    if (_editingId.length == 0) return nil;
    for (NSDictionary *provider in _store.providers) {
        if ([provider[@"id"] isEqualToString:_editingId]) return provider;
    }
    return nil;
}
- (BOOL)editingProviderModelListChangedToModels:(NSArray<NSDictionary *> *)models {
    NSDictionary *existingProvider = [self editingProvider];
    if (!existingProvider) return NO;
    return ![ProviderModels(existingProvider) isEqualToArray:models ?: @[]];
}
- (BOOL)confirmSaveWithChangedModelList {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = AKSText(@"模型列表已修改", @"Model List Changed");
    alert.informativeText = AKSText(
        @"保存后，本地路由代理会立刻按新的模型映射处理后续请求；但 Codex 当前任务的模型下拉列表可能不会实时刷新。新增、删除或重命名模型后，通常需要新建任务或重启 Codex 才能稳定显示。",
        @"After saving, the local proxy will use the new model mapping for subsequent requests immediately. The model picker in the current Codex task may not refresh live. After adding, deleting, or renaming models, create a new task or restart Codex for the list to update reliably."
    );
    [alert addButtonWithTitle:AKSText(@"继续保存", @"Save Anyway")];
    [alert addButtonWithTitle:AKSText(@"取消", @"Cancel")];
    alert.alertStyle = NSAlertStyleWarning;
    return [alert runModal] == NSAlertFirstButtonReturn;
}
- (NSString *)connectionFingerprintWithName:(NSString *)name apiKey:(NSString *)apiKey baseURL:(NSString *)baseURL apiFormat:(NSString *)apiFormat models:(NSArray<NSDictionary *> *)models tag:(NSString *)tag {
    NSData *modelsData = [NSJSONSerialization dataWithJSONObject:models ?: @[] options:0 error:nil];
    NSString *modelsText = modelsData ? [[NSString alloc] initWithData:modelsData encoding:NSUTF8StringEncoding] : @"";
    return [NSString stringWithFormat:@"%@\n%@\n%@\n%@\n%@\n%@\n%@",
            _editingId ?: @"",
            name ?: @"",
            apiKey ?: @"",
            baseURL ?: @"",
            apiFormat ?: @"",
            modelsText ?: @"",
            tag ?: @""];
}
- (void)resetConnectionCheckState {
    _connectionCheckPassed = NO;
    _checkedFingerprint = nil;
    _activeTestFingerprint = nil;
    _isTestingConnection = NO;
    _saveButton.enabled = NO;
    _testButton.enabled = YES;
    for (NSDictionary *rowState in _modelRows) {
        NSTextField *statusLabel = rowState[@"statusLabel"];
        statusLabel.stringValue = AKSText(@"未检测", @"Not tested");
        statusLabel.textColor = NSColor.secondaryLabelColor;
    }
    [self configureCheckButtonForState:@"idle"];
}
- (BOOL)isProviderFormField:(id)object {
    if (object == _nameField || object == _apiKeyField || object == _baseURLField || object == _tagField) return YES;
    for (NSDictionary *rowState in _modelRows) {
        if (object == rowState[@"customField"] || object == rowState[@"modelField"]) return YES;
    }
    return NO;
}
- (void)controlTextDidChange:(NSNotification *)notification {
    if ([self isProviderFormField:notification.object]) {
        [self resetConnectionCheckState];
        return;
    }
    if (notification.object == _listenAddressField || notification.object == _listenPortField) {
        [self resetRoutePortCheckState];
    }
}
- (void)controlTextDidBeginEditing:(NSNotification *)notification {
    [self updateInputField:notification.object focused:YES];
}
- (void)controlTextDidEndEditing:(NSNotification *)notification {
    [self updateInputField:notification.object focused:NO];
}
- (NSArray<NSDictionary *> *)collectedModelRowsWithErrorMessage:(NSString **)errorMessage {
    NSMutableArray<NSDictionary *> *models = [NSMutableArray array];
    NSMutableSet<NSString *> *customNames = [NSMutableSet set];
    NSUInteger rowIndex = 1;
    for (NSDictionary *rowState in _modelRows) {
        NSTextField *customField = rowState[@"customField"];
        NSTextField *modelField = rowState[@"modelField"];
        NSString *customName = [customField.stringValue aks_trimmed];
        NSString *upstreamModel = [modelField.stringValue aks_trimmed];
        if (customName.length == 0 || upstreamModel.length == 0) {
            if (errorMessage) *errorMessage = UseEnglishLanguage()
                ? [NSString stringWithFormat:@"Model %lu requires both an alias and an upstream model name.", (unsigned long)rowIndex]
                : [NSString stringWithFormat:@"第 %lu 个模型需要填写自定义名称和真实模型名。", (unsigned long)rowIndex];
            return nil;
        }
        if ([customNames containsObject:customName]) {
            if (errorMessage) *errorMessage = [NSString stringWithFormat:AKSText(@"模型自定义名称重复：%@", @"Duplicate model alias: %@"), customName];
            return nil;
        }
        [customNames addObject:customName];
        [models addObject:@{@"customName": customName, @"model": upstreamModel}];
        rowIndex++;
    }
    if (models.count == 0) {
        if (errorMessage) *errorMessage = AKSText(@"至少需要填写一个模型。", @"Add at least one model.");
        return nil;
    }
    return models;
}
- (BOOL)collectFormName:(NSString **)name apiKey:(NSString **)apiKey baseURL:(NSString **)baseURL apiFormat:(NSString **)apiFormat models:(NSArray<NSDictionary *> **)models tag:(NSString **)tag fingerprint:(NSString **)fingerprint errorMessage:(NSString **)errorMessage {
    NSString *nextName = [_nameField.stringValue aks_trimmed];
    NSString *inputKey = [_apiKeyField.stringValue aks_trimmed];
    NSString *nextBaseURL = [_baseURLField.stringValue aks_trimTrailingSlashes];
    NSString *nextAPIFormat = [self selectedAPIFormat];
    NSArray<NSDictionary *> *nextModels = [self collectedModelRowsWithErrorMessage:errorMessage];
    NSString *nextTag = [_tagField.stringValue aks_trimmed];
    NSDictionary *existingProvider = [self editingProvider];
    NSString *testKey = inputKey.length > 0 ? inputKey : (existingProvider ? [_store apiKeyForProvider:existingProvider] : nil);

    if (nextName.length == 0 || nextBaseURL.length == 0 || nextModels.count == 0 || testKey.length == 0) {
        if (errorMessage && (*errorMessage).length == 0) *errorMessage = AKSText(@"名称、API Key、Base URL、至少一个模型都必须填写；编辑已有配置时，只有本地已保存 Key 才可留空。", @"Name, API key, Base URL, and at least one model are required. When editing, the key may be left blank only if it is already saved locally.");
        return NO;
    }

    NSURL *url = [NSURL URLWithString:nextBaseURL];
    if (url.scheme.length == 0 || !([url.scheme isEqualToString:@"http"] || [url.scheme isEqualToString:@"https"])) {
        if (errorMessage) *errorMessage = AKSText(@"Base URL 必须是 http 或 https 地址。", @"Base URL must use http or https.");
        return NO;
    }

    if (name) *name = nextName;
    if (apiKey) *apiKey = testKey;
    if (baseURL) *baseURL = nextBaseURL;
    if (apiFormat) *apiFormat = nextAPIFormat;
    if (models) *models = nextModels;
    if (tag) *tag = nextTag;
    if (fingerprint) *fingerprint = [self connectionFingerprintWithName:nextName apiKey:testKey baseURL:nextBaseURL apiFormat:nextAPIFormat models:nextModels tag:nextTag];
    return YES;
}
- (void)testConnection {
    NSString *name = nil;
    NSString *apiKey = nil;
    NSString *baseURL = nil;
    NSString *apiFormat = nil;
    NSArray<NSDictionary *> *models = nil;
    NSString *tag = nil;
    NSString *fingerprint = nil;
    NSString *errorMessage = nil;
    if (![self collectFormName:&name apiKey:&apiKey baseURL:&baseURL apiFormat:&apiFormat models:&models tag:&tag fingerprint:&fingerprint errorMessage:&errorMessage]) {
        [self resetConnectionCheckState];
        [self configureCheckButtonForState:@"failed"];
        [self showMessage:errorMessage error:YES];
        return;
    }

    _connectionCheckPassed = NO;
    _checkedFingerprint = nil;
    _activeTestFingerprint = fingerprint;
    _isTestingConnection = YES;
    _saveButton.enabled = NO;
    _testButton.enabled = NO;
    [self configureCheckButtonForState:@"testing"];
    [self showMessage:UseEnglishLanguage()
        ? [NSString stringWithFormat:@"Testing %lu models with %@...", (unsigned long)models.count, APIFormatDisplayName(apiFormat)]
        : [NSString stringWithFormat:@"正在检测 %@ 下的 %lu 个模型...", APIFormatDisplayName(apiFormat), (unsigned long)models.count] error:NO];

    __block NSInteger pending = models.count;
    __block NSMutableArray<NSString *> *failures = [NSMutableArray array];
    for (NSUInteger index = 0; index < models.count; index++) {
        NSDictionary *modelInfo = models[index];
        NSMutableDictionary *rowState = index < _modelRows.count ? _modelRows[index] : nil;
        NSTextField *statusLabel = rowState[@"statusLabel"];
        statusLabel.stringValue = AKSText(@"检测中", @"Testing");
        statusLabel.textColor = NSColor.secondaryLabelColor;

        NSString *customName = ModelCustomName(modelInfo);
        NSString *upstreamModel = TrimString(modelInfo[@"model"]);
        [ProviderConnectionTester testBaseURL:baseURL apiKey:apiKey model:upstreamModel apiFormat:apiFormat completion:^(BOOL ok, NSString *message) {
            if (![self->_activeTestFingerprint isEqualToString:fingerprint]) {
                return;
            }

            if (ok) {
                statusLabel.stringValue = AKSText(@"通过", @"Passed");
                statusLabel.textColor = NSColor.systemGreenColor;
            } else {
                statusLabel.stringValue = AKSText(@"失败", @"Failed");
                statusLabel.textColor = NSColor.systemRedColor;
                [failures addObject:[NSString stringWithFormat:@"%@: %@", customName, message ?: AKSText(@"连接检测失败。", @"Connection test failed.")]];
            }

            pending--;
            if (pending > 0) return;

            self->_isTestingConnection = NO;
            self->_testButton.enabled = YES;
            self->_activeTestFingerprint = nil;

            if (failures.count > 0) {
                self->_connectionCheckPassed = NO;
                self->_checkedFingerprint = nil;
                self->_saveButton.enabled = NO;
                [self configureCheckButtonForState:@"failed"];
                [self showMessage:[failures componentsJoinedByString:@"\n"] error:YES];
                return;
            }

            self->_connectionCheckPassed = YES;
            self->_checkedFingerprint = fingerprint;
            self->_saveButton.enabled = YES;
            [self configureCheckButtonForState:@"success"];
            [self showMessage:AKSText(@"全部模型检测通过，可以保存配置。", @"All model tests passed. You can save the configuration.") error:NO];
        }];
    }
}
- (void)saveProvider {
    NSString *name = nil;
    NSString *apiKey = nil;
    NSString *baseURL = nil;
    NSString *apiFormat = nil;
    NSArray<NSDictionary *> *models = nil;
    NSString *tag = nil;
    NSString *fingerprint = nil;
    NSString *errorMessage = nil;
    if (![self collectFormName:&name apiKey:&apiKey baseURL:&baseURL apiFormat:&apiFormat models:&models tag:&tag fingerprint:&fingerprint errorMessage:&errorMessage]) {
        [self resetConnectionCheckState];
        [self showMessage:errorMessage error:YES];
        return;
    }

    if (!_connectionCheckPassed || ![_checkedFingerprint isEqualToString:fingerprint]) {
        [self resetConnectionCheckState];
        [self showMessage:AKSText(@"请先检测连接，通过后才能保存配置。", @"Test the connection successfully before saving.") error:YES];
        return;
    }

    if ([self editingProviderModelListChangedToModels:models] && ![self confirmSaveWithChangedModelList]) {
        [self showMessage:AKSText(@"已取消保存，模型列表未修改。", @"Save canceled. The model list was not changed.") error:NO];
        return;
    }

    NSString *inputKey = [_apiKeyField.stringValue aks_trimmed];
    NSError *error = nil;
    BOOL saved = [_store upsertProviderId:_editingId name:name apiKey:inputKey baseURL:baseURL apiFormat:apiFormat models:models tag:tag error:&error];
    if (!saved) {
        [self showMessage:error.localizedDescription error:YES];
        return;
    }
    [self clearFormFieldsOnly];
    [self showMainPage];
}
- (void)clearFormFieldsOnly {
    _editingId = nil;
    _nameField.stringValue = @"";
    _apiKeyField.stringValue = @"";
    _apiKeyField.placeholderString = @"sk-...";
    _baseURLField.stringValue = @"";
    [self selectAPIFormat:APIFormatResponses];
    [self setModelRows:@[@{@"customName": @"", @"model": @""}]];
    _tagField.stringValue = @"";
    [self resetConnectionCheckState];
    [self showMessage:AKSText(@"Codex 固定连接本地路由代理；切换 Key 会实时影响后续请求。", @"Codex connects to the local proxy. Switching the key affects subsequent requests immediately.") error:NO];
}
- (void)clearForm {
    [self clearFormFieldsOnly];
}
@end
