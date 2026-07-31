#import "MainWindowController+Internal.h"
#import "StatsView.h"

@interface AKSHorizontalOnlyTableScrollView : NSScrollView
@end

@implementation AKSHorizontalOnlyTableScrollView
- (void)scrollWheel:(NSEvent *)event {
    CGFloat horizontalDelta = fabs(event.scrollingDeltaX);
    CGFloat verticalDelta = fabs(event.scrollingDeltaY);
    if (horizontalDelta > verticalDelta) {
        [super scrollWheel:event];
        return;
    }

    NSResponder *responder = self.nextResponder;
    while (responder && ![responder respondsToSelector:@selector(scrollWheel:)]) {
        responder = responder.nextResponder;
    }
    if (responder) {
        [responder scrollWheel:event];
    } else {
        [super scrollWheel:event];
    }
}
@end

@implementation MainWindowController (StatsView)
- (NSView *)statsSettingsView {
    NSStackView *stack = [self verticalStackWithSpacing:14];
    NSArray<NSDictionary *> *records = [_usageStore snapshot];
    long long totalTokens = 0;
    NSInteger successfulRequests = 0;
    for (NSDictionary *record in records) {
        totalTokens += [record[@"totalTokens"] longLongValue];
        NSInteger status = [record[@"status"] integerValue];
        if (status >= 200 && status < 300) successfulRequests += 1;
    }
    NSString *(^formatInteger)(long long) = ^NSString *(long long value) {
        return [NSNumberFormatter localizedStringFromNumber:@(value) numberStyle:NSNumberFormatterDecimalStyle];
    };
    NSString *successRate = records.count > 0 ? [NSString stringWithFormat:@"%.1f%%", successfulRequests * 100.0 / records.count] : @"0.0%";

    NSStackView *hero = [[NSStackView alloc] init];
    hero.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    hero.spacing = 14;
    hero.distribution = NSStackViewDistributionFillEqually;
    [hero addArrangedSubview:[self statCard:AKSText(@"真实消耗 Tokens", @"Actual Tokens") value:formatInteger(totalTokens)]];
    [hero addArrangedSubview:[self statCard:AKSText(@"真实请求数", @"Actual Requests") value:formatInteger(records.count)]];
    [hero addArrangedSubview:[self statCard:AKSText(@"成功率", @"Success Rate") value:successRate]];
    [self addFullWidthView:hero toStack:stack];

    NSView *chart = [self panel];
    NSStackView *chartStack = [self verticalStackWithSpacing:8];
    [self pinSubview:chartStack toView:chart inset:18];
    NSTextField *chartTitle = [NSTextField labelWithString:records.count > 0 ? AKSText(@"使用趋势", @"Usage Trend") : AKSText(@"使用趋势（暂无真实请求数据）", @"Usage Trend (no real request data yet)")];
    chartTitle.font = [NSFont systemFontOfSize:16 weight:NSFontWeightSemibold];
    [chartStack addArrangedSubview:chartTitle];
    LineChartView *lineChart = [[LineChartView alloc] init];
    lineChart.translatesAutoresizingMaskIntoConstraints = NO;
    NSCalendar *calendar = NSCalendar.currentCalendar;
    NSDateFormatter *dayFormatter = [[NSDateFormatter alloc] init];
    dayFormatter.dateFormat = @"yyyy-MM-dd";
    NSMutableArray<NSString *> *dayKeys = [NSMutableArray array];
    NSMutableDictionary<NSString *, NSMutableDictionary *> *dayTotals = [NSMutableDictionary dictionary];
    NSDate *today = [calendar startOfDayForDate:NSDate.date];
    for (NSInteger offset = 7; offset >= 0; offset--) {
        NSDate *date = [calendar dateByAddingUnit:NSCalendarUnitDay value:-offset toDate:today options:0];
        NSString *key = [dayFormatter stringFromDate:date];
        [dayKeys addObject:key];
        dayTotals[key] = [@{@"input": @0, @"output": @0, @"cached": @0} mutableCopy];
    }
    for (NSDictionary *record in records) {
        NSString *key = [dayFormatter stringFromDate:[NSDate dateWithTimeIntervalSince1970:[record[@"timestamp"] doubleValue]]];
        NSMutableDictionary *totals = dayTotals[key];
        if (!totals) continue;
        totals[@"input"] = @([totals[@"input"] longLongValue] + [record[@"inputTokens"] longLongValue]);
        totals[@"output"] = @([totals[@"output"] longLongValue] + [record[@"outputTokens"] longLongValue]);
        totals[@"cached"] = @([totals[@"cached"] longLongValue] + [record[@"cachedTokens"] longLongValue]);
    }
    NSMutableArray *inputSeries = [NSMutableArray array];
    NSMutableArray *outputSeries = [NSMutableArray array];
    NSMutableArray *cachedSeries = [NSMutableArray array];
    for (NSString *key in dayKeys) {
        [inputSeries addObject:dayTotals[key][@"input"]];
        [outputSeries addObject:dayTotals[key][@"output"]];
        [cachedSeries addObject:dayTotals[key][@"cached"]];
    }
    lineChart.series = @[inputSeries, outputSeries, cachedSeries];
    lineChart.seriesColors = @[[self primaryBlueColor], NSColor.systemRedColor, NSColor.systemGreenColor];
    NSDateFormatter *axisFormatter = [[NSDateFormatter alloc] init];
    axisFormatter.dateFormat = @"MM/dd";
    NSMutableArray<NSString *> *axisLabels = [NSMutableArray array];
    for (NSString *key in dayKeys) {
        NSDate *date = [dayFormatter dateFromString:key];
        [axisLabels addObject:date ? [axisFormatter stringFromDate:date] : key];
    }
    lineChart.xLabels = axisLabels;
    [lineChart.heightAnchor constraintEqualToConstant:220].active = YES;
    [self addFullWidthView:lineChart toStack:chartStack];
    long long inputTotal = 0;
    long long outputTotal = 0;
    long long cachedTotal = 0;
    for (NSNumber *value in inputSeries) inputTotal += value.longLongValue;
    for (NSNumber *value in outputSeries) outputTotal += value.longLongValue;
    for (NSNumber *value in cachedSeries) cachedTotal += value.longLongValue;
    [self addFullWidthView:[self trendLegendViewWithInput:formatInteger(inputTotal) output:formatInteger(outputTotal) cached:formatInteger(cachedTotal)] toStack:chartStack];
    NSTextField *axisHint = [NSTextField labelWithString:AKSText(@"横坐标：日期；纵坐标：Token 数量。", @"X-axis: date; Y-axis: token count.")];
    axisHint.font = [NSFont systemFontOfSize:12];
    axisHint.textColor = [self mutedTextColor];
    [chartStack addArrangedSubview:axisHint];
    [chart.heightAnchor constraintGreaterThanOrEqualToConstant:328].active = YES;
    [self addFullWidthView:chart toStack:stack];

    NSMutableDictionary<NSString *, NSMutableDictionary *> *providerTotals = [NSMutableDictionary dictionary];
    for (NSDictionary *record in records) {
        NSString *provider = [record[@"provider"] length] > 0 ? record[@"provider"] : AKSText(@"未知供应商", @"Unknown provider");
        NSMutableDictionary *totals = providerTotals[provider];
        if (!totals) {
            totals = [@{@"requests": @0, @"success": @0, @"tokens": @0} mutableCopy];
            providerTotals[provider] = totals;
        }
        totals[@"requests"] = @([totals[@"requests"] integerValue] + 1);
        NSInteger status = [record[@"status"] integerValue];
        if (status >= 200 && status < 300) totals[@"success"] = @([totals[@"success"] integerValue] + 1);
        totals[@"tokens"] = @([totals[@"tokens"] longLongValue] + [record[@"totalTokens"] longLongValue]);
    }
    NSArray<NSString *> *sortedProviders = [providerTotals.allKeys sortedArrayUsingComparator:^NSComparisonResult(NSString *left, NSString *right) {
        NSComparisonResult result = [providerTotals[right][@"tokens"] compare:providerTotals[left][@"tokens"]];
        return result == NSOrderedSame ? [left localizedCaseInsensitiveCompare:right] : result;
    }];
    NSMutableArray *providerRows = [NSMutableArray array];
    for (NSString *provider in sortedProviders) {
        NSDictionary *totals = providerTotals[provider];
        NSInteger requests = [totals[@"requests"] integerValue];
        NSString *rate = requests > 0 ? [NSString stringWithFormat:@"%.1f%%", [totals[@"success"] integerValue] * 100.0 / requests] : @"0.0%";
        [providerRows addObject:@[provider, formatInteger([totals[@"tokens"] longLongValue]), formatInteger(requests), rate]];
    }
    _statsProviderPage = [self safePageForPage:_statsProviderPage totalRows:providerRows.count pageSize:StatsTablePageSize];
    NSArray *providerHeaders = @[AKSText(@"供应商", @"Provider"), AKSText(@"真实消耗 Tokens", @"Actual Tokens"), AKSText(@"真实请求数", @"Actual Requests"), AKSText(@"成功率", @"Success Rate")];
    [self addFullWidthView:[self paginatedTablePanelWithTitle:AKSText(@"供应商统计", @"Provider Statistics") headers:providerHeaders rows:providerRows page:_statsProviderPage pageSize:StatsTablePageSize previousAction:@selector(previousProviderStatsPage) nextAction:@selector(nextProviderStatsPage) jumpAction:@selector(jumpProviderStatsPage)] toStack:stack];

    NSMutableDictionary<NSString *, NSMutableDictionary *> *modelTotals = [NSMutableDictionary dictionary];
    for (NSDictionary *record in records) {
        NSString *model = [record[@"model"] length] > 0 ? record[@"model"] : AKSText(@"未知模型", @"Unknown model");
        NSMutableDictionary *totals = modelTotals[model];
        if (!totals) {
            totals = [@{@"requests": @0, @"success": @0, @"input": @0, @"output": @0, @"total": @0, @"cached": @0} mutableCopy];
            modelTotals[model] = totals;
        }
        totals[@"requests"] = @([totals[@"requests"] integerValue] + 1);
        NSInteger status = [record[@"status"] integerValue];
        if (status >= 200 && status < 300) totals[@"success"] = @([totals[@"success"] integerValue] + 1);
        totals[@"input"] = @([totals[@"input"] longLongValue] + [record[@"inputTokens"] longLongValue]);
        totals[@"output"] = @([totals[@"output"] longLongValue] + [record[@"outputTokens"] longLongValue]);
        totals[@"total"] = @([totals[@"total"] longLongValue] + [record[@"totalTokens"] longLongValue]);
        totals[@"cached"] = @([totals[@"cached"] longLongValue] + [record[@"cachedTokens"] longLongValue]);
    }
    NSArray<NSString *> *sortedModels = [modelTotals.allKeys sortedArrayUsingComparator:^NSComparisonResult(NSString *left, NSString *right) {
        return [modelTotals[right][@"total"] compare:modelTotals[left][@"total"]];
    }];
    NSMutableArray *modelRows = [NSMutableArray array];
    for (NSString *model in sortedModels) {
        NSDictionary *totals = modelTotals[model];
        NSInteger requests = [totals[@"requests"] integerValue];
        NSString *rate = requests > 0 ? [NSString stringWithFormat:@"%.1f%%", [totals[@"success"] integerValue] * 100.0 / requests] : @"0.0%";
        [modelRows addObject:@[model, formatInteger(requests), formatInteger([totals[@"input"] longLongValue]), formatInteger([totals[@"output"] longLongValue]), formatInteger([totals[@"total"] longLongValue]), formatInteger([totals[@"cached"] longLongValue]), rate]];
    }
    _statsModelPage = [self safePageForPage:_statsModelPage totalRows:modelRows.count pageSize:StatsTablePageSize];
    NSArray *modelHeaders = @[AKSText(@"模型", @"Model"), AKSText(@"请求数", @"Requests"), AKSText(@"输入 Tokens", @"Input"), AKSText(@"输出 Tokens", @"Output"), AKSText(@"总 Tokens", @"Total"), AKSText(@"缓存 Tokens", @"Cached"), AKSText(@"成功率", @"Success")];
    [self addFullWidthView:[self paginatedTablePanelWithTitle:AKSText(@"模型统计", @"Model Statistics") headers:modelHeaders rows:modelRows page:_statsModelPage pageSize:StatsTablePageSize previousAction:@selector(previousModelStatsPage) nextAction:@selector(nextModelStatsPage) jumpAction:@selector(jumpModelStatsPage)] toStack:stack];

    NSDateFormatter *timeFormatter = [[NSDateFormatter alloc] init];
    timeFormatter.dateFormat = @"MM/dd HH:mm:ss";
    NSArray *sortedRecords = [records sortedArrayUsingComparator:^NSComparisonResult(NSDictionary *left, NSDictionary *right) {
        return [right[@"timestamp"] compare:left[@"timestamp"]];
    }];
    NSMutableArray *rows = [NSMutableArray array];
    for (NSDictionary *record in sortedRecords) {
        [rows addObject:@[
            [timeFormatter stringFromDate:[NSDate dateWithTimeIntervalSince1970:[record[@"timestamp"] doubleValue]]],
            record[@"provider"] ?: @"",
            record[@"model"] ?: @"",
            formatInteger([record[@"inputTokens"] longLongValue]),
            formatInteger([record[@"outputTokens"] longLongValue]),
            formatInteger([record[@"totalTokens"] longLongValue]),
            [NSString stringWithFormat:@"%.0fms", [record[@"durationMs"] doubleValue]],
            [record[@"status"] stringValue],
            record[@"source"] ?: @"local_gateway"
        ]];
    }
    _statsLogPage = [self safePageForPage:_statsLogPage totalRows:rows.count pageSize:StatsTablePageSize];
    NSArray *headers = @[AKSText(@"时间", @"Time"), AKSText(@"供应商", @"Provider"), AKSText(@"模型", @"Model"), AKSText(@"输入", @"Input"), AKSText(@"输出", @"Output"), AKSText(@"总 Tokens", @"Total"), AKSText(@"耗时", @"Duration"), AKSText(@"状态", @"Status"), AKSText(@"来源", @"Source")];
    [self addFullWidthView:[self paginatedTablePanelWithTitle:AKSText(@"请求日志", @"Request Log") headers:headers rows:rows page:_statsLogPage pageSize:StatsTablePageSize previousAction:@selector(previousLogStatsPage) nextAction:@selector(nextLogStatsPage) jumpAction:@selector(jumpLogStatsPage)] toStack:stack];
    return stack;
}
- (NSView *)sectionTitle:(NSString *)title subtitle:(NSString *)subtitle {
    NSStackView *stack = [self verticalStackWithSpacing:4];
    NSTextField *titleLabel = [NSTextField labelWithString:title ?: @""];
    titleLabel.font = [NSFont systemFontOfSize:17 weight:NSFontWeightSemibold];
    NSTextField *subtitleLabel = [NSTextField labelWithString:subtitle ?: @""];
    subtitleLabel.textColor = NSColor.secondaryLabelColor;
    subtitleLabel.maximumNumberOfLines = 3;
    [stack addArrangedSubview:titleLabel];
    [stack addArrangedSubview:subtitleLabel];
    return stack;
}
- (NSView *)statCard:(NSString *)title value:(NSString *)value {
    NSView *card = [self panel];
    NSStackView *stack = [self verticalStackWithSpacing:8];
    [self pinSubview:stack toView:card inset:14];
    NSTextField *titleLabel = [NSTextField labelWithString:title];
    titleLabel.textColor = NSColor.secondaryLabelColor;
    NSTextField *valueLabel = [NSTextField labelWithString:value];
    valueLabel.font = [NSFont systemFontOfSize:20 weight:NSFontWeightSemibold];
    [stack addArrangedSubview:titleLabel];
    [stack addArrangedSubview:valueLabel];
    [card.heightAnchor constraintEqualToConstant:92].active = YES;
    return card;
}
- (NSView *)trendLegendItemWithTitle:(NSString *)title value:(NSString *)value color:(NSColor *)color {
    NSStackView *item = [[NSStackView alloc] init];
    item.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    item.alignment = NSLayoutAttributeCenterY;
    item.spacing = 6;

    NSView *dot = [self coloredView:color border:NO];
    dot.layer.cornerRadius = 5;
    [dot.widthAnchor constraintEqualToConstant:10].active = YES;
    [dot.heightAnchor constraintEqualToConstant:10].active = YES;

    NSTextField *label = [NSTextField labelWithString:[NSString stringWithFormat:@"%@：%@", title ?: @"", value ?: @"0"]];
    label.font = [NSFont systemFontOfSize:12 weight:NSFontWeightMedium];
    label.textColor = [self mutedTextColor];
    [item addArrangedSubview:dot];
    [item addArrangedSubview:label];
    return item;
}
- (NSView *)trendLegendViewWithInput:(NSString *)input output:(NSString *)output cached:(NSString *)cached {
    NSStackView *legend = [[NSStackView alloc] init];
    legend.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    legend.alignment = NSLayoutAttributeCenterY;
    legend.spacing = 18;
    [legend addArrangedSubview:[self trendLegendItemWithTitle:AKSText(@"蓝色线 输入 Tokens（最近 8 天合计）", @"Blue line Input tokens (last 8 days)") value:input color:[self primaryBlueColor]]];
    [legend addArrangedSubview:[self trendLegendItemWithTitle:AKSText(@"红色线 输出 Tokens（最近 8 天合计）", @"Red line Output tokens (last 8 days)") value:output color:NSColor.systemRedColor]];
    [legend addArrangedSubview:[self trendLegendItemWithTitle:AKSText(@"绿色线 缓存 Tokens（最近 8 天合计）", @"Green line Cached tokens (last 8 days)") value:cached color:NSColor.systemGreenColor]];
    return legend;
}
- (NSView *)tableLikeViewWithHeaders:(NSArray<NSString *> *)headers rows:(NSArray<NSArray<NSString *> *> *)rows {
    NSStackView *table = [[NSStackView alloc] init];
    table.orientation = NSUserInterfaceLayoutOrientationVertical;
    table.alignment = NSLayoutAttributeLeading;
    table.spacing = 0;
    table.distribution = NSStackViewDistributionFill;
    NSArray<NSNumber *> *columnWidths = [self tableColumnWidthsForHeaders:headers];

    NSStackView *(^makeRow)(NSArray<NSString *> *, BOOL) = ^NSStackView *(NSArray<NSString *> *values, BOOL headerRow) {
        NSStackView *rowView = [[NSStackView alloc] init];
        rowView.orientation = NSUserInterfaceLayoutOrientationHorizontal;
        rowView.alignment = NSLayoutAttributeCenterY;
        rowView.spacing = 22;
        rowView.distribution = NSStackViewDistributionFill;
        [rowView.heightAnchor constraintEqualToConstant:headerRow ? 28 : 30].active = YES;

        for (NSUInteger index = 0; index < headers.count; index++) {
            NSString *value = index < values.count ? values[index] : @"";
            NSTextField *label = [NSTextField labelWithString:value ?: @""];
            label.font = headerRow ? [NSFont systemFontOfSize:13 weight:NSFontWeightSemibold] : [NSFont systemFontOfSize:13];
            label.textColor = headerRow ? [self mutedTextColor] : ([value isEqualToString:@"200"] ? NSColor.systemGreenColor : NSColor.labelColor);
            label.lineBreakMode = NSLineBreakByTruncatingTail;
            label.maximumNumberOfLines = 1;
            [label.widthAnchor constraintEqualToConstant:[columnWidths[index] doubleValue]].active = YES;
            [rowView addArrangedSubview:label];
        }
        return rowView;
    };

    [table addArrangedSubview:makeRow(headers, YES)];
    for (NSArray<NSString *> *row in rows) {
        [table addArrangedSubview:makeRow(row, NO)];
    }
    return table;
}
- (NSArray<NSNumber *> *)tableColumnWidthsForHeaders:(NSArray<NSString *> *)headers {
    if (headers.count == 4) {
        return @[@260, @170, @150, @110];
    }
    if (headers.count == 7) {
        return @[@220, @86, @110, @110, @110, @110, @86];
    }
    if (headers.count == 9) {
        return @[@110, @160, @210, @86, @86, @110, @90, @72, @120];
    }
    NSMutableArray<NSNumber *> *widths = [NSMutableArray array];
    for (NSUInteger index = 0; index < headers.count; index++) {
        [widths addObject:@120];
    }
    return widths;
}
- (CGFloat)tableWidthForHeaders:(NSArray<NSString *> *)headers {
    NSArray<NSNumber *> *widths = [self tableColumnWidthsForHeaders:headers];
    CGFloat width = MAX(0, ((NSInteger)widths.count - 1) * 22);
    for (NSNumber *columnWidth in widths) {
        width += columnWidth.doubleValue;
    }
    return width;
}
- (NSScrollView *)scrollableTableViewWithHeaders:(NSArray<NSString *> *)headers rows:(NSArray<NSArray<NSString *> *> *)rows {
    NSScrollView *scroll = [[AKSHorizontalOnlyTableScrollView alloc] init];
    scroll.hasHorizontalScroller = YES;
    scroll.hasVerticalScroller = NO;
    scroll.drawsBackground = NO;
    scroll.borderType = NSNoBorder;
    scroll.autohidesScrollers = YES;
    scroll.translatesAutoresizingMaskIntoConstraints = NO;

    NSView *documentView = [[FlippedView alloc] init];
    documentView.translatesAutoresizingMaskIntoConstraints = NO;
    NSView *table = [self tableLikeViewWithHeaders:headers rows:rows];
    table.translatesAutoresizingMaskIntoConstraints = NO;
    [documentView addSubview:table];
    scroll.documentView = documentView;

    CGFloat tableWidth = [self tableWidthForHeaders:headers];
    [NSLayoutConstraint activateConstraints:@[
        [table.leadingAnchor constraintEqualToAnchor:documentView.leadingAnchor],
        [table.trailingAnchor constraintEqualToAnchor:documentView.trailingAnchor],
        [table.topAnchor constraintEqualToAnchor:documentView.topAnchor],
        [table.bottomAnchor constraintEqualToAnchor:documentView.bottomAnchor],
        [table.widthAnchor constraintEqualToConstant:tableWidth],
        [documentView.widthAnchor constraintEqualToConstant:tableWidth]
    ]];
    [scroll.heightAnchor constraintEqualToConstant:28 + (rows.count * 30)].active = YES;
    return scroll;
}
- (NSView *)tablePanelWithTitle:(NSString *)title headers:(NSArray<NSString *> *)headers rows:(NSArray<NSArray<NSString *> *> *)rows {
    NSView *panel = [self panel];
    NSStackView *stack = [self verticalStackWithSpacing:14];
    [self pinSubview:stack toView:panel inset:16];
    NSTextField *titleLabel = [NSTextField labelWithString:title ?: @""];
    titleLabel.font = [NSFont systemFontOfSize:16 weight:NSFontWeightSemibold];
    [stack addArrangedSubview:titleLabel];
    [self addFullWidthView:[self scrollableTableViewWithHeaders:headers rows:rows] toStack:stack];
    return panel;
}
- (NSArray<NSArray<NSString *> *> *)rows:(NSArray<NSArray<NSString *> *> *)rows forPage:(NSInteger)page pageSize:(NSInteger)pageSize {
    if (rows.count == 0 || pageSize <= 0) return @[];
    NSInteger safePage = [self safePageForPage:page totalRows:rows.count pageSize:pageSize];
    NSInteger start = safePage * pageSize;
    NSInteger length = MIN(pageSize, (NSInteger)rows.count - start);
    return [rows subarrayWithRange:NSMakeRange((NSUInteger)start, (NSUInteger)length)];
}
- (NSInteger)safePageForPage:(NSInteger)page totalRows:(NSUInteger)totalRows pageSize:(NSInteger)pageSize {
    NSInteger safePageSize = MAX(1, pageSize);
    NSInteger totalPages = MAX(1, ((NSInteger)totalRows + safePageSize - 1) / safePageSize);
    return MIN(MAX(0, page), totalPages - 1);
}
- (NSArray<NSArray<NSString *> *> *)displayRows:(NSArray<NSArray<NSString *> *> *)rows forPage:(NSInteger)page pageSize:(NSInteger)pageSize columns:(NSUInteger)columns {
    (void)columns;
    return [self rows:rows forPage:page pageSize:pageSize];
}
- (NSView *)paginationViewForPage:(NSInteger)page totalRows:(NSUInteger)totalRows pageSize:(NSInteger)pageSize previousAction:(SEL)previousAction nextAction:(SEL)nextAction jumpAction:(SEL)jumpAction {
    NSStackView *bar = [[NSStackView alloc] init];
    bar.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    bar.alignment = NSLayoutAttributeCenterY;
    bar.spacing = 8;

    NSInteger safePageSize = MAX(1, pageSize);
    NSInteger totalPages = MAX(1, ((NSInteger)totalRows + safePageSize - 1) / safePageSize);
    NSInteger safePage = [self safePageForPage:page totalRows:totalRows pageSize:pageSize];
    NSString *pageInfo = UseEnglishLanguage()
        ? [NSString stringWithFormat:@"Page %ld of %ld, %lu records", (long)safePage + 1, (long)totalPages, (unsigned long)totalRows]
        : [NSString stringWithFormat:@"第 %ld / %ld 页，共 %lu 条", (long)safePage + 1, (long)totalPages, (unsigned long)totalRows];
    NSTextField *info = [NSTextField labelWithString:pageInfo];
    info.textColor = [self mutedTextColor];
    info.font = [NSFont systemFontOfSize:12];
    NSView *spacer = [[NSView alloc] init];
    [spacer setContentHuggingPriority:NSLayoutPriorityDefaultLow forOrientation:NSLayoutConstraintOrientationHorizontal];
    NSButton *previous = [self styledButton:AKSText(@"上一页", @"Previous") action:previousAction primary:NO];
    NSButton *next = [self styledButton:AKSText(@"下一页", @"Next") action:nextAction primary:NO];
    previous.enabled = safePage > 0;
    next.enabled = safePage < totalPages - 1;
    NSTextField *jumpInput = [self textField:@"1"];
    jumpInput.stringValue = [NSString stringWithFormat:@"%ld", (long)safePage + 1];
    jumpInput.target = self;
    jumpInput.action = jumpAction;
    [jumpInput.widthAnchor constraintEqualToConstant:68].active = YES;
    if (jumpAction == @selector(jumpProviderStatsPage)) {
        _statsProviderJumpField = jumpInput;
    } else if (jumpAction == @selector(jumpModelStatsPage)) {
        _statsModelJumpField = jumpInput;
    } else if (jumpAction == @selector(jumpLogStatsPage)) {
        _statsLogJumpField = jumpInput;
    }
    NSTextField *jumpLabel = [NSTextField labelWithString:AKSText(@"跳至", @"Go to")];
    jumpLabel.font = [NSFont systemFontOfSize:12];
    jumpLabel.textColor = [self mutedTextColor];
    NSTextField *pageLabel = [NSTextField labelWithString:AKSText(@"页", @"page")];
    pageLabel.font = [NSFont systemFontOfSize:12];
    pageLabel.textColor = [self mutedTextColor];
    NSButton *jumpButton = [self styledButton:AKSText(@"跳转", @"Go") action:jumpAction primary:NO];
    jumpButton.enabled = totalPages > 1;

    [bar addArrangedSubview:info];
    [bar addArrangedSubview:spacer];
    [bar addArrangedSubview:jumpLabel];
    [bar addArrangedSubview:jumpInput];
    [bar addArrangedSubview:pageLabel];
    [bar addArrangedSubview:jumpButton];
    [bar addArrangedSubview:previous];
    [bar addArrangedSubview:next];
    return bar;
}
- (NSView *)paginatedTablePanelWithTitle:(NSString *)title headers:(NSArray<NSString *> *)headers rows:(NSArray<NSArray<NSString *> *> *)rows page:(NSInteger)page pageSize:(NSInteger)pageSize previousAction:(SEL)previousAction nextAction:(SEL)nextAction jumpAction:(SEL)jumpAction {
    NSView *panel = [self panel];
    NSStackView *stack = [self verticalStackWithSpacing:14];
    [self pinSubview:stack toView:panel inset:16];

    NSTextField *titleLabel = [NSTextField labelWithString:title ?: @""];
    titleLabel.font = [NSFont systemFontOfSize:16 weight:NSFontWeightSemibold];
    [stack addArrangedSubview:titleLabel];
    [self addFullWidthView:[self scrollableTableViewWithHeaders:headers rows:[self displayRows:rows forPage:page pageSize:pageSize columns:headers.count]] toStack:stack];
    [self addFullWidthView:[self paginationViewForPage:page totalRows:rows.count pageSize:pageSize previousAction:previousAction nextAction:nextAction jumpAction:jumpAction] toStack:stack];
    return panel;
}
- (void)previousProviderStatsPage {
    _statsProviderPage = MAX(0, _statsProviderPage - 1);
    [self renderSettingsPage];
}
- (void)nextProviderStatsPage {
    _statsProviderPage += 1;
    [self renderSettingsPage];
}
- (void)previousModelStatsPage {
    _statsModelPage = MAX(0, _statsModelPage - 1);
    [self renderSettingsPage];
}
- (void)nextModelStatsPage {
    _statsModelPage += 1;
    [self renderSettingsPage];
}
- (void)previousLogStatsPage {
    _statsLogPage = MAX(0, _statsLogPage - 1);
    [self renderSettingsPage];
}
- (void)nextLogStatsPage {
    _statsLogPage += 1;
    [self renderSettingsPage];
}
- (NSInteger)pageIndexFromJumpField:(NSTextField *)field {
    NSInteger requestedPage = field.stringValue.integerValue;
    return MAX(0, requestedPage - 1);
}
- (void)jumpProviderStatsPage {
    _statsProviderPage = [self pageIndexFromJumpField:_statsProviderJumpField];
    [self renderSettingsPage];
}
- (void)jumpModelStatsPage {
    _statsModelPage = [self pageIndexFromJumpField:_statsModelJumpField];
    [self renderSettingsPage];
}
- (void)jumpLogStatsPage {
    _statsLogPage = [self pageIndexFromJumpField:_statsLogJumpField];
    [self renderSettingsPage];
}
@end
