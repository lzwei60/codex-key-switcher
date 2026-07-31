#import "MainWindowController+Internal.h"
#import "CustomSelect.h"

@implementation MainWindowController (CustomSelect)
- (NSStackView *)verticalStackWithSpacing:(CGFloat)spacing {
    NSStackView *stack = [[NSStackView alloc] init];
    stack.orientation = NSUserInterfaceLayoutOrientationVertical;
    stack.spacing = spacing;
    stack.alignment = NSLayoutAttributeLeading;
    stack.distribution = NSStackViewDistributionFill;
    stack.translatesAutoresizingMaskIntoConstraints = NO;
    return stack;
}
- (void)addFullWidthView:(NSView *)view toStack:(NSStackView *)stack {
    view.translatesAutoresizingMaskIntoConstraints = NO;
    [stack addArrangedSubview:view];
    [view.widthAnchor constraintEqualToAnchor:stack.widthAnchor].active = YES;
}
- (void)addVerticalSpacerToStack:(NSStackView *)stack {
    NSView *spacer = [[NSView alloc] init];
    [spacer setContentHuggingPriority:NSLayoutPriorityFittingSizeCompression forOrientation:NSLayoutConstraintOrientationVertical];
    [spacer setContentCompressionResistancePriority:NSLayoutPriorityFittingSizeCompression forOrientation:NSLayoutConstraintOrientationVertical];
    [self addFullWidthView:spacer toStack:stack];
}
- (NSScrollView *)scrollViewWithContent:(NSView *)content {
    NSScrollView *scroll = [[NSScrollView alloc] init];
    scroll.hasVerticalScroller = YES;
    scroll.drawsBackground = NO;
    scroll.borderType = NSNoBorder;
    scroll.translatesAutoresizingMaskIntoConstraints = NO;

    FlippedView *documentView = [[FlippedView alloc] init];
    documentView.translatesAutoresizingMaskIntoConstraints = NO;
    content.translatesAutoresizingMaskIntoConstraints = NO;
    [documentView addSubview:content];
    scroll.documentView = documentView;

    [NSLayoutConstraint activateConstraints:@[
        [content.leadingAnchor constraintEqualToAnchor:documentView.leadingAnchor],
        [content.trailingAnchor constraintEqualToAnchor:documentView.trailingAnchor constant:-8],
        [content.topAnchor constraintEqualToAnchor:documentView.topAnchor],
        [content.bottomAnchor constraintEqualToAnchor:documentView.bottomAnchor],
        [content.widthAnchor constraintEqualToAnchor:documentView.widthAnchor constant:-8],
        [documentView.widthAnchor constraintEqualToAnchor:scroll.contentView.widthAnchor],
        [documentView.heightAnchor constraintGreaterThanOrEqualToAnchor:scroll.contentView.heightAnchor]
    ]];

    [scroll setContentHuggingPriority:NSLayoutPriorityDefaultLow forOrientation:NSLayoutConstraintOrientationVertical];
    [scroll setContentCompressionResistancePriority:NSLayoutPriorityDefaultLow forOrientation:NSLayoutConstraintOrientationVertical];
    return scroll;
}
- (NSView *)panel {
    return [self coloredView:[self panelBackgroundColor] border:YES];
}
- (NSView *)softPanel {
    return [self coloredView:[self softPanelBackgroundColor] border:YES];
}
- (void)pinSubview:(NSView *)subview toView:(NSView *)view inset:(CGFloat)inset {
    subview.translatesAutoresizingMaskIntoConstraints = NO;
    [view addSubview:subview];
    [NSLayoutConstraint activateConstraints:@[
        [subview.leadingAnchor constraintEqualToAnchor:view.leadingAnchor constant:inset],
        [subview.trailingAnchor constraintEqualToAnchor:view.trailingAnchor constant:-inset],
        [subview.topAnchor constraintEqualToAnchor:view.topAnchor constant:inset],
        [subview.bottomAnchor constraintEqualToAnchor:view.bottomAnchor constant:-inset]
    ]];
}
- (NSTextField *)textField:(NSString *)placeholder {
    NSTextField *field = [[AKSTextField alloc] init];
    field.placeholderString = placeholder;
    [self configureInputField:field];
    return field;
}
- (void)configureInputField:(NSTextField *)field {
    NSString *placeholder = field.placeholderString ?: @"";
    NSTextFieldCell *cell = nil;
    if ([field isKindOfClass:NSSecureTextField.class]) {
        cell = [[AKSVerticalSecureTextFieldCell alloc] initTextCell:field.stringValue ?: @""];
    } else {
        cell = [[AKSVerticalTextFieldCell alloc] initTextCell:field.stringValue ?: @""];
    }
    cell.placeholderString = placeholder;
    cell.enabled = YES;
    cell.editable = YES;
    cell.selectable = YES;
    cell.usesSingleLineMode = YES;
    cell.lineBreakMode = NSLineBreakByTruncatingTail;
    cell.wraps = NO;
    cell.drawsBackground = NO;
    field.cell = cell;

    field.font = [NSFont systemFontOfSize:15];
    field.delegate = self;
    field.enabled = YES;
    field.editable = YES;
    field.selectable = YES;
    field.translatesAutoresizingMaskIntoConstraints = NO;
    field.bezeled = NO;
    field.focusRingType = NSFocusRingTypeNone;
    field.drawsBackground = YES;
    field.backgroundColor = [self panelBackgroundColor];
    field.wantsLayer = YES;
    field.layer.cornerRadius = 8;
    field.layer.masksToBounds = YES;
    field.layer.borderWidth = 1;
    field.layer.borderColor = [self lineColor].CGColor;
    field.layer.backgroundColor = [self panelBackgroundColor].CGColor;
    [field.heightAnchor constraintEqualToConstant:38].active = YES;
    [field setContentHuggingPriority:NSLayoutPriorityDefaultLow forOrientation:NSLayoutConstraintOrientationHorizontal];
    [field setContentCompressionResistancePriority:NSLayoutPriorityDefaultLow forOrientation:NSLayoutConstraintOrientationHorizontal];
}
- (void)updateInputField:(NSTextField *)field focused:(BOOL)focused {
    if (![field isKindOfClass:NSTextField.class] || !field.editable) return;
    field.layer.borderWidth = 1;
    field.layer.borderColor = (focused ? [self primaryBlueColor] : [self lineColor]).CGColor;
    field.layer.backgroundColor = [self panelBackgroundColor].CGColor;
}
- (NSTextField *)readonlyField:(NSString *)text {
    NSTextField *field = [self textField:@""];
    field.stringValue = text ?: @"";
    field.editable = NO;
    field.selectable = NO;
    field.textColor = [self mutedTextColor];
    field.backgroundColor = [self softPanelBackgroundColor];
    return field;
}
- (NSView *)readonlySelectView:(NSString *)text {
    NSView *container = [self coloredView:[self panelBackgroundColor] border:YES];
    container.translatesAutoresizingMaskIntoConstraints = NO;
    [container.heightAnchor constraintEqualToConstant:38].active = YES;

    NSStackView *row = [[NSStackView alloc] init];
    row.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    row.alignment = NSLayoutAttributeCenterY;
    row.spacing = 8;
    row.edgeInsets = NSEdgeInsetsMake(0, 12, 0, 12);
    [self pinSubview:row toView:container inset:0];

    NSTextField *label = [NSTextField labelWithString:text ?: @""];
    label.font = [NSFont systemFontOfSize:14];
    [row addArrangedSubview:label];
    NSView *spacer = [[NSView alloc] init];
    [spacer setContentHuggingPriority:NSLayoutPriorityDefaultLow forOrientation:NSLayoutConstraintOrientationHorizontal];
    [row addArrangedSubview:spacer];
    NSTextField *chevron = [NSTextField labelWithString:@"⌄"];
    chevron.textColor = [self mutedTextColor];
    [row addArrangedSubview:chevron];
    return container;
}
- (void)selectAPIFormat:(id)apiFormat {
    NSString *nextFormat = [apiFormat isKindOfClass:NSButton.class] ? ((NSButton *)apiFormat).identifier : ([apiFormat isKindOfClass:NSString.class] ? apiFormat : APIFormatResponses);
    _selectedAPIFormat = ProviderAPIFormat(@{@"apiFormat": nextFormat});
    [self resetConnectionCheckState];
    if (![_apiFormatControl isKindOfClass:NSStackView.class]) return;
    for (NSView *view in ((NSStackView *)_apiFormatControl).arrangedSubviews) {
        if (![view isKindOfClass:NSButton.class]) continue;
        NSButton *button = (NSButton *)view;
        BOOL active = [button.identifier isEqualToString:_selectedAPIFormat];
        [self styleExistingButton:button primary:active];
        button.layer.borderWidth = 0;
        button.layer.backgroundColor = (active ? [self primaryBlueColor] : [NSColor clearColor]).CGColor;
        button.contentTintColor = active ? NSColor.whiteColor : [self mutedTextColor];
    }
}
- (NSString *)selectedAPIFormat {
    return ProviderAPIFormat(@{@"apiFormat": _selectedAPIFormat ?: APIFormatResponses});
}
- (NSView *)segmentedControlWithItems:(NSArray<NSArray<NSString *> *> *)items selected:(NSString *)selected action:(SEL)action {
    NSStackView *segmented = [[NSStackView alloc] init];
    segmented.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    segmented.spacing = 6;
    segmented.wantsLayer = YES;
    segmented.layer.cornerRadius = 8;
    segmented.layer.borderWidth = 1;
    segmented.layer.borderColor = [self lineColor].CGColor;
    segmented.layer.backgroundColor = [self softPanelBackgroundColor].CGColor;
    segmented.edgeInsets = NSEdgeInsetsMake(6, 6, 6, 6);

    for (NSArray<NSString *> *item in items) {
        NSString *title = item.firstObject ?: @"";
        NSString *value = item.count > 1 ? item[1] : title;
        BOOL active = [selected isEqualToString:value];
        NSButton *button = [NSButton buttonWithTitle:title target:self action:action];
        button.identifier = value;
        [self styleExistingButton:button primary:active];
        button.layer.borderWidth = 0;
        button.layer.backgroundColor = (active ? [self primaryBlueColor] : [NSColor clearColor]).CGColor;
        button.contentTintColor = active ? NSColor.whiteColor : [self mutedTextColor];
        [button.widthAnchor constraintGreaterThanOrEqualToConstant:96].active = YES;
        [segmented addArrangedSubview:button];
    }
    return segmented;
}
- (void)configureCheckButtonForState:(NSString *)state {
    if (!_testButton) return;

    _testButton.wantsLayer = YES;
    _testButton.bezelStyle = NSBezelStyleRegularSquare;
    _testButton.bordered = NO;
    _testButton.contentTintColor = NSColor.whiteColor;

    if ([state isEqualToString:@"success"]) {
        _testButton.title = AKSText(@"检测通过", @"Passed");
        _testButton.layer.backgroundColor = NSColor.systemGreenColor.CGColor;
    } else if ([state isEqualToString:@"failed"]) {
        _testButton.title = AKSText(@"检测失败", @"Failed");
        _testButton.layer.backgroundColor = NSColor.systemRedColor.CGColor;
    } else if ([state isEqualToString:@"testing"]) {
        _testButton.title = AKSText(@"检测中...", @"Testing...");
        _testButton.layer.backgroundColor = NSColor.systemGrayColor.CGColor;
    } else {
        _testButton.title = AKSText(@"检测连接", @"Test Connection");
        _testButton.layer.backgroundColor = NSColor.systemGrayColor.CGColor;
    }
    _testButton.layer.cornerRadius = 8;
    [_testButton.heightAnchor constraintGreaterThanOrEqualToConstant:36].active = YES;
}
- (NSView *)modelListView {
    NSView *container = [[NSView alloc] init];
    container.translatesAutoresizingMaskIntoConstraints = NO;

    NSStackView *stack = [self verticalStackWithSpacing:10];
    [self pinSubview:stack toView:container inset:0];
    [stack.bottomAnchor constraintEqualToAnchor:container.bottomAnchor].active = YES;

    NSStackView *header = [[NSStackView alloc] init];
    header.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    header.alignment = NSLayoutAttributeCenterY;
    NSTextField *title = [NSTextField labelWithString:AKSText(@"模型列表", @"Models")];
    title.font = [NSFont systemFontOfSize:13 weight:NSFontWeightMedium];
    title.textColor = [self mutedTextColor];
    NSView *spacer = [[NSView alloc] init];
    [spacer setContentHuggingPriority:NSLayoutPriorityDefaultLow forOrientation:NSLayoutConstraintOrientationHorizontal];
    NSButton *addButton = [self styledButton:AKSText(@"新增模型", @"Add Model") action:@selector(addModelRowFromButton:) primary:NO];
    [header addArrangedSubview:title];
    [header addArrangedSubview:spacer];
    [header addArrangedSubview:addButton];
    [self addFullWidthView:header toStack:stack];

    _modelRowsStack = [self verticalStackWithSpacing:8];
    [self addFullWidthView:_modelRowsStack toStack:stack];
    [self addModelRowWithCustomName:@"" model:@""];
    return container;
}
- (void)addModelRowWithCustomName:(NSString *)customName model:(NSString *)model {
    if (!_modelRowsStack) return;

    NSView *rowContainer = [[NSView alloc] init];
    rowContainer.translatesAutoresizingMaskIntoConstraints = NO;
    NSStackView *row = [[NSStackView alloc] init];
    row.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    row.spacing = 10;
    row.alignment = NSLayoutAttributeCenterY;
    row.translatesAutoresizingMaskIntoConstraints = NO;
    [rowContainer addSubview:row];
    [NSLayoutConstraint activateConstraints:@[
        [row.leadingAnchor constraintEqualToAnchor:rowContainer.leadingAnchor],
        [row.trailingAnchor constraintEqualToAnchor:rowContainer.trailingAnchor],
        [row.topAnchor constraintEqualToAnchor:rowContainer.topAnchor],
        [row.bottomAnchor constraintEqualToAnchor:rowContainer.bottomAnchor]
    ]];

    NSTextField *customField = [self textField:AKSText(@"自定义名称，例如 deepseek", @"Alias, for example deepseek")];
    customField.stringValue = customName ?: @"";
    NSTextField *modelField = [self textField:AKSText(@"真实模型名，例如 deepseek-v4-pro", @"Upstream model, for example deepseek-v4-pro")];
    modelField.stringValue = model ?: @"";
    NSTextField *statusLabel = nil;
    NSView *statusView = [self centeredTextContainerWithText:AKSText(@"未检测", @"Not tested")
                                                   textColor:[self mutedTextColor]
                                             backgroundColor:[self softPanelBackgroundColor]
                                                        font:[NSFont systemFontOfSize:13 weight:NSFontWeightMedium]
                                                cornerRadius:8
                                                    minWidth:78
                                                      height:38
                                           horizontalPadding:8
                                                       label:&statusLabel];
    statusView.layer.borderWidth = 1;
    statusView.layer.borderColor = [self lineColor].CGColor;
    [statusView.widthAnchor constraintEqualToConstant:78].active = YES;
    NSButton *removeButton = [self styledButton:AKSText(@"删除", @"Remove") action:@selector(removeModelRow:) primary:NO];

    [customField.widthAnchor constraintGreaterThanOrEqualToConstant:150].active = YES;
    [modelField.widthAnchor constraintGreaterThanOrEqualToConstant:190].active = YES;
    [row addArrangedSubview:customField];
    [row addArrangedSubview:modelField];
    [row addArrangedSubview:statusView];
    [row addArrangedSubview:removeButton];

    NSMutableDictionary *rowState = [@{
        @"container": rowContainer,
        @"customField": customField,
        @"modelField": modelField,
        @"statusLabel": statusLabel,
        @"statusView": statusView,
        @"removeButton": removeButton
    } mutableCopy];
    removeButton.identifier = [NSString stringWithFormat:@"%p", rowState];
    [_modelRows addObject:rowState];
    [self addFullWidthView:rowContainer toStack:_modelRowsStack];
}
- (void)addModelRowFromButton:(NSButton *)sender {
    [self addModelRowWithCustomName:@"" model:@""];
    [self resetConnectionCheckState];
}
- (void)removeModelRow:(NSButton *)sender {
    if (_modelRows.count <= 1) {
        [self showMessage:AKSText(@"至少保留一个模型。", @"Keep at least one model.") error:YES];
        return;
    }

    NSMutableDictionary *target = nil;
    for (NSMutableDictionary *rowState in _modelRows) {
        if ([sender.identifier isEqualToString:[NSString stringWithFormat:@"%p", rowState]]) {
            target = rowState;
            break;
        }
    }
    if (!target) return;
    NSView *container = target[@"container"];
    [_modelRowsStack removeArrangedSubview:container];
    [container removeFromSuperview];
    [_modelRows removeObject:target];
    [self resetConnectionCheckState];
}
- (void)setModelRows:(NSArray<NSDictionary *> *)models {
    for (NSMutableDictionary *rowState in _modelRows.copy) {
        NSView *container = rowState[@"container"];
        [_modelRowsStack removeArrangedSubview:container];
        [container removeFromSuperview];
    }
    [_modelRows removeAllObjects];

    NSArray<NSDictionary *> *source = models.count > 0 ? models : @[@{@"customName": @"", @"model": @""}];
    for (NSDictionary *model in source) {
        [self addModelRowWithCustomName:ModelCustomName(model) model:TrimString(model[@"model"])];
    }
}
- (NSView *)fieldGroup:(NSString *)title field:(NSView *)field {
    NSView *container = [[NSView alloc] init];
    container.translatesAutoresizingMaskIntoConstraints = NO;
    NSTextField *label = [NSTextField labelWithString:title];
    label.font = [NSFont systemFontOfSize:13 weight:NSFontWeightMedium];
    label.textColor = NSColor.secondaryLabelColor;
    label.alignment = NSTextAlignmentLeft;
    label.translatesAutoresizingMaskIntoConstraints = NO;
    [container addSubview:label];
    [container addSubview:field];

    [NSLayoutConstraint activateConstraints:@[
        [label.leadingAnchor constraintEqualToAnchor:container.leadingAnchor],
        [label.trailingAnchor constraintEqualToAnchor:container.trailingAnchor],
        [label.topAnchor constraintEqualToAnchor:container.topAnchor],
        [field.leadingAnchor constraintEqualToAnchor:container.leadingAnchor],
        [field.trailingAnchor constraintEqualToAnchor:container.trailingAnchor],
        [field.topAnchor constraintEqualToAnchor:label.bottomAnchor constant:6],
        [field.bottomAnchor constraintEqualToAnchor:container.bottomAnchor]
    ]];

    [container.heightAnchor constraintEqualToConstant:62].active = YES;
    return container;
}
@end
