#import "MainWindowController+Internal.h"

@implementation MainWindowController
- (instancetype)initWithStore:(ProviderStore *)store gateway:(LocalGateway *)gateway usageStore:(UsageStore *)usageStore {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, AppWindowInitialWidth, AppWindowFixedContentHeight)
                                                   styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
                                                     backing:NSBackingStoreBuffered
                                                       defer:NO];
    window.title = @"Codex Key Switcher";
    window.contentMinSize = NSMakeSize(AppWindowMinimumWidth, AppWindowFixedContentHeight);
    window.contentMaxSize = NSMakeSize(CGFLOAT_MAX, AppWindowFixedContentHeight);
    self = [super initWithWindow:window];
    if (!self) return nil;
    _store = store;
    _gateway = gateway;
    _usageStore = usageStore;
    _modelRows = [NSMutableArray array];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(usageStoreDidChange:) name:UsageStoreDidChangeNotification object:_usageStore];
    [self buildUI];
    [self reload];
    return self;
}
- (void)usageStoreDidChange:(NSNotification *)notification {
    if ([_page isEqualToString:@"settings"] && [_settingsTab isEqualToString:@"stats"]) {
        [self renderSettingsPage];
    }
}
- (void)buildUI {
    NSView *content = self.window.contentView;
    content.wantsLayer = YES;
    content.layer.backgroundColor = [self appBackgroundColor].CGColor;
    [content.heightAnchor constraintEqualToConstant:AppWindowFixedContentHeight].active = YES;

    NSStackView *shell = [[NSStackView alloc] init];
    shell.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    shell.alignment = NSLayoutAttributeTop;
    shell.spacing = 0;
    shell.distribution = NSStackViewDistributionFill;
    shell.translatesAutoresizingMaskIntoConstraints = NO;
    [content addSubview:shell];
    [NSLayoutConstraint activateConstraints:@[
        [shell.leadingAnchor constraintEqualToAnchor:content.leadingAnchor constant:12],
        [shell.trailingAnchor constraintEqualToAnchor:content.trailingAnchor constant:-12],
        [shell.topAnchor constraintEqualToAnchor:content.topAnchor constant:12],
        [shell.bottomAnchor constraintEqualToAnchor:content.bottomAnchor constant:-12]
    ]];

    NSView *sidebar = [self sidebarView];
    [sidebar.widthAnchor constraintEqualToConstant:260].active = YES;
    [shell addArrangedSubview:sidebar];
    [sidebar.heightAnchor constraintEqualToAnchor:shell.heightAnchor].active = YES;

    _contentHost = [[NSView alloc] init];
    _contentHost.translatesAutoresizingMaskIntoConstraints = NO;
    _contentHost.wantsLayer = YES;
    _contentHost.layer.backgroundColor = [self appBackgroundColor].CGColor;
    [shell addArrangedSubview:_contentHost];
    [_contentHost.heightAnchor constraintEqualToAnchor:shell.heightAnchor].active = YES;

    _page = @"main";
    _settingsTab = @"general";
    _statsProviderPage = 0;
    _statsModelPage = 0;
    _statsLogPage = 0;
    _pendingLanguage = [NSUserDefaults.standardUserDefaults stringForKey:@"language"] ?: @"zh-Hans";
    _selectedAPIFormat = APIFormatResponses;
    [self applySavedAppearance];
    [self renderCurrentPage];
}
- (void)clearContentHost {
    for (NSView *view in _contentHost.subviews.copy) {
        [view removeFromSuperview];
    }
}
- (void)renderCurrentPage {
    if ([_page isEqualToString:@"add"]) {
        [self renderFormPageWithTitle:AKSText(@"添加配置", @"Add Configuration")];
    } else if ([_page isEqualToString:@"edit"]) {
        [self renderFormPageWithTitle:AKSText(@"编辑配置", @"Edit Configuration")];
    } else if ([_page isEqualToString:@"settings"]) {
        [self renderSettingsPage];
    } else {
        [self renderMainPage];
    }
}
- (NSStackView *)pageRootWithSpacing:(CGFloat)spacing {
    [self clearContentHost];
    [self refreshSidebar];
    _contentHost.layer.backgroundColor = [self appBackgroundColor].CGColor;
    NSStackView *root = [self verticalStackWithSpacing:spacing];
    [_contentHost addSubview:root];
    [NSLayoutConstraint activateConstraints:@[
        [root.leadingAnchor constraintEqualToAnchor:_contentHost.leadingAnchor constant:24],
        [root.trailingAnchor constraintEqualToAnchor:_contentHost.trailingAnchor constant:-24],
        [root.topAnchor constraintEqualToAnchor:_contentHost.topAnchor constant:24],
        [root.bottomAnchor constraintEqualToAnchor:_contentHost.bottomAnchor constant:-24]
    ]];
    return root;
}
- (NSButton *)iconButton:(NSString *)title action:(SEL)action {
    return [self styledButton:title action:action primary:NO];
}
- (NSStackView *)pageHeaderWithTitle:(NSString *)title subtitle:(NSString *)subtitle back:(BOOL)back {
    NSStackView *header = [[NSStackView alloc] init];
    BOOL hasSubtitle = subtitle.length > 0;
    header.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    header.alignment = NSLayoutAttributeCenterY;
    header.spacing = 12;
    [header setContentHuggingPriority:NSLayoutPriorityRequired forOrientation:NSLayoutConstraintOrientationVertical];
    [header setContentCompressionResistancePriority:NSLayoutPriorityRequired forOrientation:NSLayoutConstraintOrientationVertical];
    [header.heightAnchor constraintEqualToConstant:52].active = YES;
    if (back) {
        NSButton *backButton = [self iconButton:@"←" action:@selector(showMainPage)];
        [backButton.widthAnchor constraintEqualToConstant:64].active = YES;
        [header addArrangedSubview:backButton];
    }
    NSStackView *titleStack = [self verticalStackWithSpacing:3];
    NSTextField *label = [NSTextField labelWithString:title];
    label.font = [NSFont systemFontOfSize:24 weight:NSFontWeightBold];
    [titleStack addArrangedSubview:label];
    if (hasSubtitle) {
        NSTextField *subtitleLabel = [NSTextField labelWithString:subtitle];
        subtitleLabel.font = [NSFont systemFontOfSize:13];
        subtitleLabel.textColor = [self mutedTextColor];
        [titleStack addArrangedSubview:subtitleLabel];
    }
    [header addArrangedSubview:titleStack];
    NSView *spacer = [[NSView alloc] init];
    [spacer setContentHuggingPriority:NSLayoutPriorityDefaultLow forOrientation:NSLayoutConstraintOrientationHorizontal];
    [header addArrangedSubview:spacer];
    return header;
}
- (NSView *)keyValueView:(NSArray<NSArray<NSString *> *> *)items {
    NSGridView *grid = [[NSGridView alloc] init];
    for (NSArray<NSString *> *item in items) {
        NSString *key = item.count > 0 ? item[0] : @"";
        NSString *value = item.count > 1 ? item[1] : @"";
        NSTextField *keyLabel = [NSTextField labelWithString:key];
        keyLabel.font = [NSFont systemFontOfSize:13];
        keyLabel.textColor = [self mutedTextColor];
        [keyLabel.widthAnchor constraintEqualToConstant:88].active = YES;

        NSTextField *valueLabel = [NSTextField labelWithString:value ?: @""];
        valueLabel.font = [NSFont systemFontOfSize:13 weight:NSFontWeightMedium];
        valueLabel.lineBreakMode = NSLineBreakByTruncatingMiddle;
        valueLabel.maximumNumberOfLines = 1;
        [grid addRowWithViews:@[keyLabel, valueLabel]];
    }
    grid.rowSpacing = 8;
    grid.columnSpacing = 12;
    return grid;
}
- (void)hideWindow {
    [self.window orderOut:nil];
}
- (void)reload {
    if (!_listStack || ![_page isEqualToString:@"main"]) return;
    [self refreshSidebar];

    for (NSView *view in _listStack.arrangedSubviews.copy) {
        [_listStack removeArrangedSubview:view];
        [view removeFromSuperview];
    }

    if (_store.providers.count == 0) {
        NSTextField *empty = [NSTextField labelWithString:AKSText(@"暂无配置", @"No configurations")];
        empty.alignment = NSTextAlignmentCenter;
        empty.textColor = NSColor.secondaryLabelColor;
        [empty.heightAnchor constraintEqualToConstant:180].active = YES;
        [self addFullWidthView:empty toStack:_listStack];
        return;
    }

    for (NSUInteger index = 0; index < _store.providers.count; index += 2) {
        NSStackView *row = [[NSStackView alloc] init];
        row.orientation = NSUserInterfaceLayoutOrientationHorizontal;
        row.spacing = 14;
        row.distribution = NSStackViewDistributionFillEqually;
        [row addArrangedSubview:[self providerCard:_store.providers[index]]];
        if (index + 1 < _store.providers.count) {
            [row addArrangedSubview:[self providerCard:_store.providers[index + 1]]];
        } else {
            NSView *empty = [[NSView alloc] init];
            [row addArrangedSubview:empty];
        }
        [self addFullWidthView:row toStack:_listStack];
    }
}
@end
