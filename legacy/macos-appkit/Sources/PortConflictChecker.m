#import "PortConflictChecker.h"

@implementation PortConflictChecker
+ (NSArray<NSString *> *)tokensFromLine:(NSString *)line {
    NSArray<NSString *> *parts = [line componentsSeparatedByCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
    NSMutableArray<NSString *> *tokens = [NSMutableArray array];
    for (NSString *part in parts) {
        if (part.length > 0) [tokens addObject:part];
    }
    return tokens;
}

+ (BOOL)line:(NSString *)line matchesPort:(NSInteger)port {
    if ([line rangeOfString:@"LISTEN"].location == NSNotFound) return NO;
    NSString *suffix = [NSString stringWithFormat:@":%ld", (long)port];
    NSString *arrowSuffix = [NSString stringWithFormat:@":%ld->", (long)port];
    return [line hasSuffix:suffix] ||
           [line rangeOfString:[suffix stringByAppendingString:@" "]].location != NSNotFound ||
           [line rangeOfString:arrowSuffix].location != NSNotFound;
}

+ (NSString *)lsofOutputForPort:(NSInteger)port {
    NSTask *task = [[NSTask alloc] init];
    task.launchPath = @"/usr/sbin/lsof";
    task.arguments = @[@"-nP", [NSString stringWithFormat:@"-iTCP:%ld", (long)port], @"-sTCP:LISTEN"];
    NSPipe *outputPipe = [NSPipe pipe];
    task.standardOutput = outputPipe;
    task.standardError = [NSPipe pipe];

    NSError *error = nil;
    if (![task launchAndReturnError:&error]) return @"";
    [task waitUntilExit];
    NSData *data = [outputPipe.fileHandleForReading readDataToEndOfFile];
    return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"";
}

+ (BOOL)portHasAnyListener:(NSInteger)port excludingPID:(pid_t)pid {
    if (port < 1 || port > 65535) return NO;
    NSString *output = [self lsofOutputForPort:port];
    if (output.length == 0) return NO;

    for (NSString *line in [output componentsSeparatedByCharactersInSet:NSCharacterSet.newlineCharacterSet]) {
        if (![self line:line matchesPort:port]) continue;
        NSArray<NSString *> *tokens = [self tokensFromLine:line];
        if (tokens.count < 2) continue;
        pid_t listenerPID = (pid_t)tokens[1].intValue;
        if (listenerPID > 0 && listenerPID != pid) return YES;
    }
    return NO;
}

+ (NSInteger)firstSafePortFrom:(NSInteger)startPort maxAttempts:(NSInteger)maxAttempts {
    NSInteger attempts = MAX(1, maxAttempts);
    NSInteger lastPort = MIN(65535, startPort + attempts - 1);
    for (NSInteger port = MAX(1024, startPort); port <= lastPort; port++) {
        if (![self portHasAnyListener:port excludingPID:getpid()]) return port;
    }
    return 0;
}
@end
