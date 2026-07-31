#import "MainWindowController+Internal.h"
#import "ThemeManager.h"

@implementation MainWindowController (ThemeManager)
- (NSColor *)colorWithHex:(NSUInteger)hex {
    CGFloat red = ((hex >> 16) & 0xff) / 255.0;
    CGFloat green = ((hex >> 8) & 0xff) / 255.0;
    CGFloat blue = (hex & 0xff) / 255.0;
    return [NSColor colorWithSRGBRed:red green:green blue:blue alpha:1.0];
}
- (BOOL)isDarkAppearance {
    NSAppearance *appearance = NSApp.effectiveAppearance ?: NSAppearance.currentDrawingAppearance ?: [NSAppearance appearanceNamed:NSAppearanceNameAqua];
    NSString *bestMatch = [appearance bestMatchFromAppearancesWithNames:@[NSAppearanceNameAqua, NSAppearanceNameDarkAqua]];
    return [bestMatch isEqualToString:NSAppearanceNameDarkAqua];
}
- (NSColor *)appBackgroundColor {
    return [self isDarkAppearance] ? [self colorWithHex:0x111318] : [self colorWithHex:0xf5f7fb];
}
- (NSColor *)sidebarBackgroundColor {
    return [self isDarkAppearance] ? [self colorWithHex:0x171a20] : [self colorWithHex:0xf8fafd];
}
- (NSColor *)panelBackgroundColor {
    return [self isDarkAppearance] ? [self colorWithHex:0x1d2027] : NSColor.whiteColor;
}
- (NSColor *)softPanelBackgroundColor {
    return [self isDarkAppearance] ? [self colorWithHex:0x222631] : [self colorWithHex:0xf9fafc];
}
- (NSColor *)lineColor {
    return [self isDarkAppearance] ? [self colorWithHex:0x353a45] : [self colorWithHex:0xdfe3ea];
}
- (NSColor *)primaryBlueColor {
    return [self colorWithHex:0x147efb];
}
- (NSColor *)primaryTintColor {
    return [self isDarkAppearance] ? [self colorWithHex:0x18375f] : [self colorWithHex:0xe9f2ff];
}
- (NSColor *)mutedTextColor {
    return [self isDarkAppearance] ? [self colorWithHex:0xa5acb8] : [self colorWithHex:0x6d7480];
}
- (NSColor *)quietTextColor {
    return [self isDarkAppearance] ? [self colorWithHex:0x7f8794] : [self colorWithHex:0x9aa1ad];
}
- (NSView *)coloredView:(NSColor *)background border:(BOOL)border {
    NSView *view = [[NSView alloc] init];
    view.wantsLayer = YES;
    view.layer.cornerRadius = 8;
    view.layer.backgroundColor = background.CGColor;
    if (border) {
        view.layer.borderWidth = 1;
        view.layer.borderColor = [self lineColor].CGColor;
    }
    return view;
}
- (NSView *)centeredTextContainerWithText:(NSString *)text
                                textColor:(NSColor *)textColor
                          backgroundColor:(NSColor *)backgroundColor
                                     font:(NSFont *)font
                             cornerRadius:(CGFloat)cornerRadius
                                 minWidth:(CGFloat)minWidth
                                   height:(CGFloat)height
                        horizontalPadding:(CGFloat)horizontalPadding {
    return [self centeredTextContainerWithText:text
                                     textColor:textColor
                               backgroundColor:backgroundColor
                                          font:font
                                  cornerRadius:cornerRadius
                                      minWidth:minWidth
                                        height:height
                             horizontalPadding:horizontalPadding
                                         label:nil];
}
- (NSView *)centeredTextContainerWithText:(NSString *)text
                                textColor:(NSColor *)textColor
                          backgroundColor:(NSColor *)backgroundColor
                                     font:(NSFont *)font
                             cornerRadius:(CGFloat)cornerRadius
                                 minWidth:(CGFloat)minWidth
                                   height:(CGFloat)height
                        horizontalPadding:(CGFloat)horizontalPadding
                                    label:(NSTextField **)labelOut {
    NSView *container = [self coloredView:backgroundColor border:NO];
    container.translatesAutoresizingMaskIntoConstraints = NO;
    container.layer.cornerRadius = cornerRadius;
    [container.widthAnchor constraintGreaterThanOrEqualToConstant:minWidth].active = YES;
    [container.heightAnchor constraintEqualToConstant:height].active = YES;
    [container setContentHuggingPriority:NSLayoutPriorityDefaultHigh forOrientation:NSLayoutConstraintOrientationHorizontal];
    [container setContentCompressionResistancePriority:NSLayoutPriorityRequired forOrientation:NSLayoutConstraintOrientationHorizontal];

    NSTextField *label = [NSTextField labelWithString:text ?: @""];
    label.translatesAutoresizingMaskIntoConstraints = NO;
    label.alignment = NSTextAlignmentCenter;
    label.font = font;
    label.textColor = textColor;
    label.lineBreakMode = NSLineBreakByTruncatingTail;
    label.maximumNumberOfLines = 1;
    [label setContentCompressionResistancePriority:NSLayoutPriorityRequired forOrientation:NSLayoutConstraintOrientationHorizontal];
    [container addSubview:label];
    if (labelOut) *labelOut = label;
    [NSLayoutConstraint activateConstraints:@[
        [label.centerXAnchor constraintEqualToAnchor:container.centerXAnchor],
        [label.centerYAnchor constraintEqualToAnchor:container.centerYAnchor],
        [label.leadingAnchor constraintGreaterThanOrEqualToAnchor:container.leadingAnchor constant:horizontalPadding],
        [label.trailingAnchor constraintLessThanOrEqualToAnchor:container.trailingAnchor constant:-horizontalPadding]
    ]];
    return container;
}
- (NSButton *)styledButton:(NSString *)title action:(SEL)action primary:(BOOL)primary {
    NSButton *button = [NSButton buttonWithTitle:title target:self action:action];
    button.bezelStyle = NSBezelStyleRegularSquare;
    button.bordered = NO;
    button.wantsLayer = YES;
    button.layer.cornerRadius = 8;
    button.font = [NSFont systemFontOfSize:14 weight:primary ? NSFontWeightSemibold : NSFontWeightRegular];
    button.contentTintColor = primary ? NSColor.whiteColor : NSColor.labelColor;
    button.layer.backgroundColor = (primary ? [self primaryBlueColor] : [self panelBackgroundColor]).CGColor;
    button.layer.borderWidth = primary ? 0 : 1;
    button.layer.borderColor = [self lineColor].CGColor;
    button.alignment = NSTextAlignmentCenter;
    button.translatesAutoresizingMaskIntoConstraints = NO;
    [button.heightAnchor constraintEqualToConstant:36].active = YES;
    CGFloat minWidth = MAX(64, title.length * 16 + 28);
    [button.widthAnchor constraintGreaterThanOrEqualToConstant:minWidth].active = YES;
    return button;
}
- (NSButton *)navButton:(NSString *)title action:(SEL)action active:(BOOL)active {
    NSButton *button = [self styledButton:title action:action primary:NO];
    button.alignment = NSTextAlignmentLeft;
    button.layer.borderWidth = 0;
    [self updateNavButton:button title:title active:active];
    return button;
}
- (void)updateNavButton:(NSButton *)button title:(NSString *)title active:(BOOL)active {
    NSColor *textColor = active ? [self primaryBlueColor] : [self mutedTextColor];
    NSFont *font = [NSFont systemFontOfSize:14 weight:active ? NSFontWeightSemibold : NSFontWeightRegular];
    NSMutableParagraphStyle *paragraph = [[NSMutableParagraphStyle alloc] init];
    paragraph.alignment = NSTextAlignmentLeft;
    paragraph.firstLineHeadIndent = 12;
    paragraph.headIndent = 12;
    paragraph.tailIndent = -12;
    button.attributedTitle = [[NSAttributedString alloc] initWithString:title attributes:@{
        NSFontAttributeName: font,
        NSForegroundColorAttributeName: textColor,
        NSParagraphStyleAttributeName: paragraph
    }];
    button.contentTintColor = textColor;
    button.layer.backgroundColor = (active ? [self primaryTintColor] : [NSColor clearColor]).CGColor;
}
- (void)styleExistingButton:(NSButton *)button primary:(BOOL)primary {
    button.bezelStyle = NSBezelStyleRegularSquare;
    button.bordered = NO;
    button.wantsLayer = YES;
    button.layer.cornerRadius = 8;
    button.layer.backgroundColor = (primary ? [self primaryBlueColor] : [self panelBackgroundColor]).CGColor;
    button.layer.borderWidth = primary ? 0 : 1;
    button.layer.borderColor = [self lineColor].CGColor;
    button.contentTintColor = primary ? NSColor.whiteColor : NSColor.labelColor;
    button.font = [NSFont systemFontOfSize:14 weight:primary ? NSFontWeightSemibold : NSFontWeightRegular];
    button.alignment = NSTextAlignmentCenter;
    [button.heightAnchor constraintEqualToConstant:36].active = YES;
    CGFloat minWidth = MAX(64, button.title.length * 16 + 28);
    [button.widthAnchor constraintGreaterThanOrEqualToConstant:minWidth].active = YES;
}
- (NSView *)sidebarView {
    NSView *sidebar = [self coloredView:[self sidebarBackgroundColor] border:NO];
    sidebar.translatesAutoresizingMaskIntoConstraints = NO;
    _sidebarView = sidebar;

    NSStackView *stack = [self verticalStackWithSpacing:14];
    [self pinSubview:stack toView:sidebar inset:18];

    NSStackView *brand = [[NSStackView alloc] init];
    brand.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    brand.alignment = NSLayoutAttributeCenterY;
    brand.spacing = 10;
    NSView *mark = [self centeredTextContainerWithText:@"CK"
                                             textColor:NSColor.whiteColor
                                       backgroundColor:[self colorWithHex:0x101418]
                                                  font:[NSFont systemFontOfSize:14 weight:NSFontWeightBold]
                                          cornerRadius:8
                                              minWidth:34
                                                height:34
                                     horizontalPadding:0];
    [mark.widthAnchor constraintEqualToConstant:34].active = YES;
    [brand addArrangedSubview:mark];

    NSStackView *brandText = [self verticalStackWithSpacing:2];
    _sidebarBrandTitleLabel = [NSTextField labelWithString:@"Codex Key Switcher"];
    _sidebarBrandTitleLabel.font = [NSFont systemFontOfSize:15 weight:NSFontWeightBold];
    _sidebarBrandSubtitleLabel = [NSTextField labelWithString:@"Responses Key 管理"];
    _sidebarBrandSubtitleLabel.font = [NSFont systemFontOfSize:12];
    _sidebarBrandSubtitleLabel.textColor = [self mutedTextColor];
    [brandText addArrangedSubview:_sidebarBrandTitleLabel];
    [brandText addArrangedSubview:_sidebarBrandSubtitleLabel];
    [brand addArrangedSubview:brandText];
    [self addFullWidthView:brand toStack:stack];

    NSView *navContainer = [[NSView alloc] init];
    NSStackView *nav = [self verticalStackWithSpacing:6];
    [navContainer addSubview:nav];
    [NSLayoutConstraint activateConstraints:@[
        [nav.leadingAnchor constraintEqualToAnchor:navContainer.leadingAnchor constant:8],
        [nav.trailingAnchor constraintEqualToAnchor:navContainer.trailingAnchor constant:-8],
        [nav.topAnchor constraintEqualToAnchor:navContainer.topAnchor],
        [nav.bottomAnchor constraintEqualToAnchor:navContainer.bottomAnchor]
    ]];
    _navMainButton = [self navButton:@"配置列表" action:@selector(showMainPage) active:YES];
    _navSettingsButton = [self navButton:@"设置" action:@selector(showSettingsPage) active:NO];
    [self addFullWidthView:_navMainButton toStack:nav];
    [self addFullWidthView:_navSettingsButton toStack:nav];
    [self addFullWidthView:navContainer toStack:stack];

    NSView *spacer = [[NSView alloc] init];
    [spacer setContentHuggingPriority:NSLayoutPriorityDefaultLow forOrientation:NSLayoutConstraintOrientationVertical];
    [stack addArrangedSubview:spacer];

    NSView *footer = [self coloredView:[self panelBackgroundColor] border:YES];
    _sidebarFooterView = footer;
    NSStackView *footerStack = [self verticalStackWithSpacing:4];
    [self pinSubview:footerStack toView:footer inset:12];
    _sidebarFooterTitleLabel = [NSTextField labelWithString:@"当前 Key"];
    _sidebarFooterTitleLabel.font = [NSFont systemFontOfSize:12];
    _sidebarFooterTitleLabel.textColor = [self mutedTextColor];
    _sidebarCurrentLabel = [NSTextField labelWithString:@"未选择"];
    _sidebarCurrentLabel.font = [NSFont systemFontOfSize:14 weight:NSFontWeightSemibold];
    _sidebarProxyLabel = [NSTextField labelWithString:@"代理 http://127.0.0.1:3456/v1"];
    _sidebarProxyLabel.font = [NSFont systemFontOfSize:12];
    _sidebarProxyLabel.textColor = [self mutedTextColor];
    _sidebarProxyLabel.maximumNumberOfLines = 2;
    [footerStack addArrangedSubview:_sidebarFooterTitleLabel];
    [footerStack addArrangedSubview:_sidebarCurrentLabel];
    [footerStack addArrangedSubview:_sidebarProxyLabel];
    [self addFullWidthView:footer toStack:stack];
    [footer.heightAnchor constraintGreaterThanOrEqualToConstant:92].active = YES;

    return sidebar;
}
- (void)refreshSidebar {
    BOOL settingsActive = [_page isEqualToString:@"settings"];
    [self updateNavButton:_navMainButton title:AKSText(@"配置列表", @"Configurations") active:!settingsActive];
    [self updateNavButton:_navSettingsButton title:AKSText(@"设置", @"Settings") active:settingsActive];

    NSDictionary *current = [_store currentProvider];
    _sidebarBrandSubtitleLabel.stringValue = AKSText(@"Responses Key 管理", @"Responses Key Manager");
    _sidebarFooterTitleLabel.stringValue = AKSText(@"当前 Key", @"Current Key");
    _sidebarBrandTitleLabel.textColor = NSColor.labelColor;
    _sidebarBrandSubtitleLabel.textColor = [self mutedTextColor];
    _sidebarFooterTitleLabel.textColor = [self mutedTextColor];
    _sidebarCurrentLabel.stringValue = current ? current[@"name"] : AKSText(@"未选择", @"Not selected");
    _sidebarCurrentLabel.textColor = NSColor.labelColor;
    _sidebarProxyLabel.stringValue = [NSString stringWithFormat:@"%@ %@", AKSText(@"代理", @"Proxy"), ConfiguredGatewayEndpoint()];
    _sidebarProxyLabel.textColor = [self mutedTextColor];
}
- (void)refreshThemeColors {
    self.window.contentView.layer.backgroundColor = [self appBackgroundColor].CGColor;
    _contentHost.layer.backgroundColor = [self appBackgroundColor].CGColor;
    _sidebarView.layer.backgroundColor = [self sidebarBackgroundColor].CGColor;
    _sidebarFooterView.layer.backgroundColor = [self panelBackgroundColor].CGColor;
    _sidebarFooterView.layer.borderColor = [self lineColor].CGColor;
    [self refreshSidebar];
}
- (void)applySavedAppearance {
    NSString *theme = [NSUserDefaults.standardUserDefaults stringForKey:@"appearanceTheme"] ?: @"system";
    if ([theme isEqualToString:@"dark"]) {
        NSApp.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
    } else if ([theme isEqualToString:@"light"]) {
        NSApp.appearance = [NSAppearance appearanceNamed:NSAppearanceNameAqua];
    } else {
        NSApp.appearance = nil;
    }
    [self refreshThemeColors];
}
- (void)selectThemeOption:(NSButton *)sender {
    NSString *theme = sender.identifier ?: @"system";
    [NSUserDefaults.standardUserDefaults setObject:theme forKey:@"appearanceTheme"];
    [self applySavedAppearance];
    [self renderSettingsPage];
}
- (void)selectLanguageOption:(NSButton *)sender {
    _pendingLanguage = sender.identifier ?: @"zh-Hans";
    [NSUserDefaults.standardUserDefaults setObject:_pendingLanguage forKey:@"language"];
    [NSUserDefaults.standardUserDefaults synchronize];
    [NSNotificationCenter.defaultCenter postNotificationName:LanguageDidChangeNotification object:nil];
    [self renderCurrentPage];
}
@end
