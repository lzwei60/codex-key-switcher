#import "LocalGateway.h"
#import "PortConflictChecker.h"

@interface AKSStreamingBridge : NSObject <NSURLSessionDataDelegate>
@property(nonatomic, copy) void (^onResponse)(NSHTTPURLResponse *response);
@property(nonatomic, copy) void (^onData)(NSData *data);
@property(nonatomic, copy) void (^onComplete)(NSError *error, NSData *capturedData);
@property(nonatomic, strong) NSMutableData *capturedData;
@property(nonatomic, assign) BOOL didReceiveResponse;
@end

@implementation AKSStreamingBridge
- (instancetype)init {
    self = [super init];
    if (!self) return nil;
    _capturedData = [NSMutableData data];
    return self;
}

- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)dataTask didReceiveResponse:(NSURLResponse *)response completionHandler:(void (^)(NSURLSessionResponseDisposition disposition))completionHandler {
    self.didReceiveResponse = YES;
    if (self.onResponse) self.onResponse((NSHTTPURLResponse *)response);
    completionHandler(NSURLSessionResponseAllow);
}

- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)dataTask didReceiveData:(NSData *)data {
    if (data.length > 0) {
        [self.capturedData appendData:data];
        if (self.onData) self.onData(data);
    }
}

- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error {
    if (self.onComplete) self.onComplete(error, [self.capturedData copy]);
}
@end

@implementation LocalGateway {
    ProviderStore *_store;
    UsageStore *_usageStore;
    int _serverSocket;
    dispatch_queue_t _queue;
    NSUInteger _generation;
    NSMutableDictionary<NSString *, NSString *> *_chatReasoningContentByCallId;
    NSMutableDictionary<NSString *, NSString *> *_routeSignatureByResponseId;
}

- (BOOL)isLoopbackPeerAddress:(struct sockaddr_storage)peerAddress {
    if (peerAddress.ss_family == AF_INET) {
        struct sockaddr_in *ipv4 = (struct sockaddr_in *)&peerAddress;
        uint32_t address = ntohl(ipv4->sin_addr.s_addr);
        return (address >> 24) == 127;
    }
    return NO;
}

- (void)disableSIGPIPEForSocket:(int)socketFD {
#ifdef SO_NOSIGPIPE
    int yes = 1;
    setsockopt(socketFD, SOL_SOCKET, SO_NOSIGPIPE, &yes, sizeof(yes));
#else
    (void)socketFD;
#endif
}

- (instancetype)initWithStore:(ProviderStore *)store usageStore:(UsageStore *)usageStore {
    self = [super init];
    if (!self) return nil;
    _store = store;
    _usageStore = usageStore;
    _serverSocket = -1;
    _queue = dispatch_queue_create("AIKeySwitcher.LocalGateway", DISPATCH_QUEUE_SERIAL);
    _chatReasoningContentByCallId = [NSMutableDictionary dictionary];
    _routeSignatureByResponseId = [NSMutableDictionary dictionary];
    return self;
}

- (NSString *)endpointText {
    return ConfiguredGatewayEndpoint();
}

- (BOOL)start:(NSError **)error {
    if (self.running) return YES;

    _serverSocket = socket(AF_INET, SOCK_STREAM, 0);
    if (_serverSocket < 0) {
        if (error) *error = [NSError errorWithDomain:AppName code:10 userInfo:@{NSLocalizedDescriptionKey: @"无法创建本地网关 socket。"}];
        return NO;
    }

    int yes = 1;
    setsockopt(_serverSocket, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));

    struct sockaddr_in address;
    memset(&address, 0, sizeof(address));
    address.sin_family = AF_INET;
    NSInteger port = ConfiguredGatewayPort();
    NSString *listenAddress = ConfiguredListenAddress();
    BOOL allowLANListen = [NSUserDefaults.standardUserDefaults boolForKey:@"allowLANListen"];
    if (!allowLANListen && ![listenAddress hasPrefix:@"127."]) {
        close(_serverSocket);
        _serverSocket = -1;
        if (error) *error = [NSError errorWithDomain:AppName code:15 userInfo:@{NSLocalizedDescriptionKey: @"公开版本默认只允许监听 127.x.x.x。本地代理不应暴露到局域网。"}];
        return NO;
    }
    address.sin_port = htons((uint16_t)port);
    if (inet_pton(AF_INET, listenAddress.UTF8String, &address.sin_addr) != 1) {
        close(_serverSocket);
        _serverSocket = -1;
        if (error) *error = [NSError errorWithDomain:AppName code:13 userInfo:@{NSLocalizedDescriptionKey: @"监听地址必须是合法的 IPv4 地址。"}];
        return NO;
    }

    if (bind(_serverSocket, (struct sockaddr *)&address, sizeof(address)) < 0) {
        close(_serverSocket);
        _serverSocket = -1;
        if (error) *error = [NSError errorWithDomain:AppName code:11 userInfo:@{NSLocalizedDescriptionKey: [NSString stringWithFormat:@"无法监听 %@:%ld，地址或端口可能已被占用。", listenAddress, (long)port]}];
        return NO;
    }

    if (listen(_serverSocket, 16) < 0) {
        close(_serverSocket);
        _serverSocket = -1;
        if (error) *error = [NSError errorWithDomain:AppName code:12 userInfo:@{NSLocalizedDescriptionKey: @"本地网关启动失败。"}];
        return NO;
    }

    self.running = YES;
    NSUInteger generation = ++_generation;
    int serverSocket = _serverSocket;
    dispatch_async(_queue, ^{
        while (self.running && self->_generation == generation) {
            struct sockaddr_storage peerAddress;
            socklen_t peerLength = sizeof(peerAddress);
            memset(&peerAddress, 0, sizeof(peerAddress));
            int client = accept(serverSocket, (struct sockaddr *)&peerAddress, &peerLength);
            if (client < 0) continue;
            [self disableSIGPIPEForSocket:client];
            dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
                [self handleClient:client peerAddress:peerAddress];
            });
        }
    });
    return YES;
}

- (BOOL)startAllowingPortFallback:(NSError **)error changedPort:(NSInteger *)changedPort {
    NSInteger originalPort = ConfiguredGatewayPort();
    if ([PortConflictChecker portHasAnyListener:originalPort excludingPID:getpid()]) {
        NSInteger safePort = [PortConflictChecker firstSafePortFrom:originalPort + 1 maxAttempts:20];
        if (safePort <= 0) {
            if (error) *error = [NSError errorWithDomain:AppName code:14 userInfo:@{NSLocalizedDescriptionKey: [NSString stringWithFormat:@"端口 %ld 已被其他进程监听，且未找到可自动切换的后续端口。", (long)originalPort]}];
            return NO;
        }

        [NSUserDefaults.standardUserDefaults setInteger:safePort forKey:@"listenPort"];
        [NSUserDefaults.standardUserDefaults synchronize];
        NSError *safePortError = nil;
        if ([self start:&safePortError]) {
            if (changedPort) *changedPort = safePort;
            return YES;
        }
        [NSUserDefaults.standardUserDefaults setInteger:originalPort forKey:@"listenPort"];
        [NSUserDefaults.standardUserDefaults synchronize];
        if (error) *error = safePortError;
        return NO;
    }

    NSError *startError = nil;
    if ([self start:&startError]) {
        if (changedPort) *changedPort = 0;
        return YES;
    }

    if (startError.code != 11) {
        if (error) *error = startError;
        return NO;
    }

    for (NSInteger port = originalPort + 1; port <= MIN(65535, originalPort + 20); port++) {
        if ([PortConflictChecker portHasAnyListener:port excludingPID:getpid()]) continue;
        [NSUserDefaults.standardUserDefaults setInteger:port forKey:@"listenPort"];
        [NSUserDefaults.standardUserDefaults synchronize];
        NSError *fallbackError = nil;
        if ([self start:&fallbackError]) {
            if (changedPort) *changedPort = port;
            return YES;
        }
        if (fallbackError.code != 11) {
            [NSUserDefaults.standardUserDefaults setInteger:originalPort forKey:@"listenPort"];
            [NSUserDefaults.standardUserDefaults synchronize];
            if (error) *error = fallbackError;
            return NO;
        }
    }

    [NSUserDefaults.standardUserDefaults setInteger:originalPort forKey:@"listenPort"];
    [NSUserDefaults.standardUserDefaults synchronize];
    if (error) *error = startError;
    return NO;
}

- (void)stop {
    self.running = NO;
    _generation += 1;
    if (_serverSocket >= 0) {
        shutdown(_serverSocket, SHUT_RDWR);
        close(_serverSocket);
        _serverSocket = -1;
    }
}

- (BOOL)restart:(NSError **)error {
    [self stop];
    return [self start:error];
}

- (BOOL)restartAllowingPortFallback:(NSError **)error changedPort:(NSInteger *)changedPort {
    [self stop];
    return [self startAllowingPortFallback:error changedPort:changedPort];
}

- (void)handleClient:(int)client peerAddress:(struct sockaddr_storage)peerAddress {
    NSMutableData *buffer = [NSMutableData data];
    uint8_t temp[8192];
    NSDictionary *request = nil;

    while (buffer.length < MaxGatewayRequestBytes) {
        ssize_t count = recv(client, temp, sizeof(temp), 0);
        if (count <= 0) break;
        [buffer appendBytes:temp length:(NSUInteger)count];
        request = [self parseRequestData:buffer];
        if (request) break;
    }

    if (!request) {
        if (buffer.length >= MaxGatewayRequestBytes) {
            [self writeJSON:@{@"error": @"HTTP request is too large"} status:413 toClient:client];
            close(client);
            return;
        }
        [self writeJSON:@{@"error": @"Invalid HTTP request"} status:400 toClient:client];
        close(client);
        return;
    }

    if ([request[@"method"] isEqualToString:@"OPTIONS"]) {
        [self writeData:NSData.data status:204 headers:@{@"Access-Control-Allow-Origin": @"http://127.0.0.1", @"Access-Control-Allow-Headers": @"Authorization, Content-Type", @"Access-Control-Allow-Methods": @"GET, POST, OPTIONS"} toClient:client];
        close(client);
        return;
    }

    NSString *pathOnly = [request[@"path"] componentsSeparatedByString:@"?"].firstObject;
    if ([pathOnly isEqualToString:@"/__status"] || [pathOnly isEqualToString:@"/v1/__status"]) {
        BOOL authorized = [self isAuthorizedRequest:request];
        if (![self isLoopbackPeerAddress:peerAddress] && !authorized) {
            [self writeJSON:@{@"error": @"Unauthorized local gateway status request"} status:401 toClient:client];
            close(client);
            return;
        }
        [self writeJSON:[self statusPayloadIncludingDetails:authorized] status:200 toClient:client];
        close(client);
        return;
    }

    if (![self isAuthorizedRequest:request]) {
        [self writeJSON:@{@"error": @"Unauthorized local gateway request"} status:401 toClient:client];
        close(client);
        return;
    }

    [self forwardRequest:request toClient:client];
    close(client);
}

- (NSDictionary *)statusPayloadIncludingDetails:(BOOL)includeDetails {
    NSDictionary *provider = [_store currentProvider];
    if (!provider) {
        return @{
            @"gateway": @"running",
            @"endpoint": [self endpointText],
            @"current": [NSNull null]
        };
    }

    return @{
        @"gateway": @"running",
        @"endpoint": [self endpointText],
            @"current": @{
            @"id": provider[@"id"] ?: @"",
            @"name": provider[@"name"] ?: @"",
            @"baseURL": includeDetails ? (provider[@"baseURL"] ?: @"") : @"<redacted>",
            @"apiFormat": ProviderAPIFormat(provider),
            @"models": includeDetails ? ProviderModels(provider) : @[],
            @"model": ProviderSelectedCatalogModel(provider),
            @"tag": provider[@"tag"] ?: @""
        }
    };
}

- (NSDictionary *)parseRequestData:(NSData *)data {
    NSData *separator = [@"\r\n\r\n" dataUsingEncoding:NSUTF8StringEncoding];
    NSRange range = [data rangeOfData:separator options:0 range:NSMakeRange(0, data.length)];
    if (range.location == NSNotFound) return nil;

    NSData *headerData = [data subdataWithRange:NSMakeRange(0, range.location)];
    NSString *headerText = [[NSString alloc] initWithData:headerData encoding:NSUTF8StringEncoding];
    if (!headerText) return nil;

    NSArray<NSString *> *lines = [headerText componentsSeparatedByString:@"\r\n"];
    NSArray<NSString *> *requestParts = [lines.firstObject componentsSeparatedByString:@" "];
    if (requestParts.count < 2) return nil;

    NSMutableDictionary *headers = [NSMutableDictionary dictionary];
    for (NSUInteger index = 1; index < lines.count; index++) {
        NSString *line = lines[index];
        NSRange colon = [line rangeOfString:@":"];
        if (colon.location == NSNotFound) continue;
        NSString *key = [[line substringToIndex:colon.location] aks_trimmed];
        NSString *value = [[line substringFromIndex:colon.location + 1] aks_trimmed];
        headers[key] = value;
    }

    NSUInteger bodyStart = range.location + range.length;
    long long contentLengthValue = 0;
    for (NSString *key in headers) {
        if ([key.lowercaseString isEqualToString:@"content-length"]) {
            contentLengthValue = [headers[key] longLongValue];
            break;
        }
    }

    if (contentLengthValue < 0) return nil;
    NSUInteger contentLength = (NSUInteger)contentLengthValue;
    if (contentLength > MaxGatewayRequestBytes || bodyStart > MaxGatewayRequestBytes - contentLength) return nil;
    if (data.length < bodyStart + contentLength) return nil;
    NSData *body = [data subdataWithRange:NSMakeRange(bodyStart, contentLength)];
    return @{@"method": requestParts[0], @"path": requestParts[1], @"headers": headers, @"body": body};
}

- (NSString *)headerValueForName:(NSString *)name inHeaders:(NSDictionary *)headers {
    NSString *target = name.lowercaseString;
    for (NSString *key in headers) {
        if ([key.lowercaseString isEqualToString:target]) return headers[key];
    }
    return nil;
}

- (BOOL)isAuthorizedRequest:(NSDictionary *)request {
    NSString *authorization = [[self headerValueForName:@"authorization" inHeaders:request[@"headers"]] aks_trimmed];
    NSString *token = authorization;
    if ([authorization.lowercaseString hasPrefix:@"bearer "]) {
        token = [[authorization substringFromIndex:7] aks_trimmed];
    }
    if (token.length == 0) return NO;

    NSString *apiKey = LocalGatewayAPIKeyValue();
    if ([token isEqualToString:apiKey] || [token isEqualToString:LegacyLocalGatewayAPIKey]) return YES;

    NSDictionary *provider = [self providerForRequestBody:request[@"body"]];
    NSString *providerKey = provider ? [_store apiKeyForProvider:provider] : nil;
    return providerKey.length > 0 && [token isEqualToString:providerKey];
}

- (NSDictionary *)usagePayloadFromObject:(id)object {
    if (![object isKindOfClass:NSDictionary.class]) return nil;
    NSDictionary *dictionary = object;
    if ([dictionary[@"usage"] isKindOfClass:NSDictionary.class]) return dictionary[@"usage"];
    NSDictionary *response = dictionary[@"response"];
    if ([response isKindOfClass:NSDictionary.class]) return [self usagePayloadFromObject:response];
    return nil;
}

- (NSDictionary *)normalizedUsageFromData:(NSData *)data {
    if (data.length == 0) return @{};
    NSDictionary *usage = [self usagePayloadFromObject:[NSJSONSerialization JSONObjectWithData:data options:0 error:nil]];
    if (!usage) {
        NSString *text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"";
        for (NSString *line in [text componentsSeparatedByCharactersInSet:NSCharacterSet.newlineCharacterSet].reverseObjectEnumerator) {
            NSString *trimmed = [line aks_trimmed];
            if (![trimmed hasPrefix:@"data:"]) continue;
            NSString *jsonText = [[trimmed substringFromIndex:5] aks_trimmed];
            if ([jsonText isEqualToString:@"[DONE]"]) continue;
            NSData *jsonData = [jsonText dataUsingEncoding:NSUTF8StringEncoding];
            usage = [self usagePayloadFromObject:[NSJSONSerialization JSONObjectWithData:jsonData options:0 error:nil]];
            if (usage) break;
        }
    }
    if (!usage) return @{};

    NSNumber *input = usage[@"input_tokens"] ?: usage[@"prompt_tokens"] ?: @0;
    NSNumber *output = usage[@"output_tokens"] ?: usage[@"completion_tokens"] ?: @0;
    NSDictionary *details = usage[@"input_tokens_details"] ?: usage[@"prompt_tokens_details"];
    NSNumber *cached = [details isKindOfClass:NSDictionary.class] ? (details[@"cached_tokens"] ?: @0) : @0;
    if (usage[@"cache_read_input_tokens"]) cached = usage[@"cache_read_input_tokens"];
    NSNumber *cacheCreation = usage[@"cache_creation_input_tokens"] ?: @0;
    NSNumber *total = usage[@"total_tokens"] ?: @(input.longLongValue + output.longLongValue);
    return @{
        @"inputTokens": input,
        @"outputTokens": output,
        @"totalTokens": total,
        @"cachedTokens": cached,
        @"cacheCreationTokens": cacheCreation
    };
}

- (id)jsonObjectFromData:(NSData *)data {
    if (data.length == 0) return nil;
    return [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingMutableContainers error:nil];
}

- (id)jsonObjectFromJSONString:(NSString *)text fallback:(id)fallback {
    NSString *trimmed = TrimString(text);
    if (trimmed.length == 0) return fallback;
    NSData *data = [trimmed dataUsingEncoding:NSUTF8StringEncoding];
    id object = [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingMutableContainers error:nil];
    return object ?: fallback;
}

- (NSArray *)chatToolsFromResponsesTools:(id)tools {
    if (![tools isKindOfClass:NSArray.class]) return nil;
    NSMutableArray *converted = [NSMutableArray array];
    for (NSDictionary *tool in (NSArray *)tools) {
        if (![tool isKindOfClass:NSDictionary.class]) continue;
        NSDictionary *function = [tool[@"function"] isKindOfClass:NSDictionary.class] ? tool[@"function"] : nil;
        NSString *name = TrimString(function[@"name"] ?: tool[@"name"]);
        if (name.length == 0) continue;
        NSDictionary *parameters = function[@"parameters"] ?: tool[@"parameters"] ?: tool[@"input_schema"] ?: @{@"type": @"object", @"properties": @{}};
        NSMutableDictionary *functionTool = [@{
            @"type": @"function",
            @"function": @{
                @"name": name,
                @"description": TrimString(function[@"description"] ?: tool[@"description"]),
                @"parameters": parameters
            }
        } mutableCopy];
        [converted addObject:functionTool];
    }
    return converted.count > 0 ? converted : nil;
}

- (NSArray *)anthropicToolsFromResponsesTools:(id)tools {
    if (![tools isKindOfClass:NSArray.class]) return nil;
    NSMutableArray *converted = [NSMutableArray array];
    for (NSDictionary *tool in (NSArray *)tools) {
        if (![tool isKindOfClass:NSDictionary.class]) continue;
        NSDictionary *function = [tool[@"function"] isKindOfClass:NSDictionary.class] ? tool[@"function"] : nil;
        NSString *name = TrimString(function[@"name"] ?: tool[@"name"]);
        if (name.length == 0) continue;
        NSDictionary *inputSchema = function[@"parameters"] ?: tool[@"parameters"] ?: tool[@"input_schema"] ?: @{@"type": @"object", @"properties": @{}};
        [converted addObject:@{
            @"name": name,
            @"description": TrimString(function[@"description"] ?: tool[@"description"]),
            @"input_schema": inputSchema
        }];
    }
    return converted.count > 0 ? converted : nil;
}

- (NSString *)chatRoleFromResponsesRole:(NSString *)role {
    NSString *normalized = TrimString(role).lowercaseString;
    if ([normalized isEqualToString:@"developer"] || [normalized isEqualToString:@"system"]) return @"system";
    if ([normalized isEqualToString:@"assistant"]) return @"assistant";
    if ([normalized isEqualToString:@"tool"]) return @"tool";
    return @"user";
}

- (NSString *)reasoningContentForChatItem:(NSDictionary *)item callId:(NSString *)callId {
    NSString *reasoning = TrimString(item[@"reasoning_content"] ?: item[@"reasoning"]);
    if (reasoning.length > 0) return reasoning;
    NSString *safeCallId = TrimString(callId);
    if (safeCallId.length == 0) return @"";
    return TrimString(_chatReasoningContentByCallId[safeCallId]);
}

- (void)rememberReasoningContent:(NSString *)reasoningContent forCallId:(NSString *)callId {
    NSString *safeCallId = TrimString(callId);
    NSString *safeReasoning = TrimString(reasoningContent);
    if (safeCallId.length == 0 || safeReasoning.length == 0) return;
    _chatReasoningContentByCallId[safeCallId] = safeReasoning;
    if (_chatReasoningContentByCallId.count <= 512) return;
    NSArray<NSString *> *keys = _chatReasoningContentByCallId.allKeys;
    for (NSUInteger index = 0; index < MIN((NSUInteger)128, keys.count); index++) {
        [_chatReasoningContentByCallId removeObjectForKey:keys[index]];
    }
}

- (NSDictionary *)chatToolMessageFromResponsesOutputItem:(NSDictionary *)item callId:(NSString *)callId {
    NSString *safeCallId = TrimString(callId.length > 0 ? callId : (item[@"call_id"] ?: item[@"tool_call_id"] ?: item[@"id"]));
    if (safeCallId.length == 0) return nil;
    NSString *content = [self textFromResponsesContent:item[@"output"] ?: item[@"content"]];
    return @{
        @"role": @"tool",
        @"content": content ?: @"",
        @"tool_call_id": safeCallId
    };
}

- (NSArray *)chatMessagesFromResponsesPayload:(NSDictionary *)payload {
    id input = payload[@"input"];
    NSMutableArray *messages = [NSMutableArray array];
    if ([input isKindOfClass:NSString.class]) {
        [messages addObject:@{@"role": @"user", @"content": input}];
        return messages;
    }

    if (![input isKindOfClass:NSArray.class]) return @[@{@"role": @"user", @"content": @"ping"}];
    NSMutableDictionary<NSString *, NSDictionary *> *toolOutputByCallId = [NSMutableDictionary dictionary];
    for (NSDictionary *item in (NSArray *)input) {
        if (![item isKindOfClass:NSDictionary.class]) continue;
        NSString *type = TrimString(item[@"type"]);
        if (![type isEqualToString:@"function_call_output"]) continue;
        NSString *callId = TrimString(item[@"call_id"] ?: item[@"tool_call_id"] ?: item[@"id"]);
        if (callId.length > 0) toolOutputByCallId[callId] = item;
    }
    NSMutableSet<NSString *> *emittedToolOutputCallIds = [NSMutableSet set];

    for (NSDictionary *item in (NSArray *)input) {
        if (![item isKindOfClass:NSDictionary.class]) continue;
        NSString *type = TrimString(item[@"type"]);
        NSString *role = TrimString(item[@"role"]);
        if (role.length == 0) role = @"user";
        role = [self chatRoleFromResponsesRole:role];

        if ([type isEqualToString:@"function_call_output"]) {
            NSString *callId = TrimString(item[@"call_id"] ?: item[@"tool_call_id"] ?: item[@"id"]);
            if (callId.length == 0 || [emittedToolOutputCallIds containsObject:callId]) continue;
            // Chat Completions requires tool results to immediately follow their assistant tool call.
            // Unpaired tool outputs cannot be represented safely, so they are skipped.
            continue;
        }

        if ([type isEqualToString:@"function_call"]) {
            NSString *callId = TrimString(item[@"call_id"] ?: item[@"id"]);
            NSString *name = TrimString(item[@"name"]);
            if (name.length > 0) {
                NSString *safeCallId = callId.length > 0 ? callId : [@"call_" stringByAppendingString:NSUUID.UUID.UUIDString];
                NSDictionary *toolOutputItem = toolOutputByCallId[safeCallId];
                if (!toolOutputItem) {
                    continue;
                }
                NSString *reasoningContent = [self reasoningContentForChatItem:item callId:safeCallId];
                NSMutableDictionary *assistant = [@{@"role": @"assistant", @"content": @"", @"tool_calls": @[
                    @{
                        @"id": safeCallId,
                        @"type": @"function",
                        @"function": @{
                            @"name": name,
                            @"arguments": TrimString(item[@"arguments"])
                        }
                    }
                ]} mutableCopy];
                if (reasoningContent.length > 0) assistant[@"reasoning_content"] = reasoningContent;
                [messages addObject:assistant];
                NSDictionary *toolMessage = [self chatToolMessageFromResponsesOutputItem:toolOutputItem callId:safeCallId];
                if (toolMessage) {
                    [messages addObject:toolMessage];
                    [emittedToolOutputCallIds addObject:safeCallId];
                }
            }
            continue;
        }

        NSString *content = [self textFromResponsesContent:item[@"content"] ?: item[@"text"]];
        if (content.length == 0 && [type isEqualToString:@"message"]) content = [self textFromResponsesContent:item[@"output_text"]];
        if (content.length == 0) continue;
        NSMutableDictionary *message = [@{@"role": role, @"content": content} mutableCopy];
        NSString *reasoningContent = [self reasoningContentForChatItem:item callId:@""];
        if ([role isEqualToString:@"assistant"] && reasoningContent.length > 0) {
            message[@"reasoning_content"] = reasoningContent;
        }
        [messages addObject:message];
    }
    return messages.count > 0 ? messages : @[@{@"role": @"user", @"content": @"ping"}];
}

- (NSData *)chatCompletionsBodyFromResponsesBody:(NSData *)body stream:(BOOL)stream {
    id object = [self jsonObjectFromData:body];
    if (![object isKindOfClass:NSDictionary.class]) return body;
    NSDictionary *payload = object;
    NSMutableDictionary *converted = [@{
        @"model": TrimString(payload[@"model"]),
        @"messages": [self chatMessagesFromResponsesPayload:payload],
        @"stream": @(stream)
    } mutableCopy];
    id maxTokens = payload[@"max_output_tokens"] ?: payload[@"max_tokens"];
    if (maxTokens) converted[@"max_tokens"] = maxTokens;
    if (payload[@"temperature"]) converted[@"temperature"] = payload[@"temperature"];
    if (payload[@"top_p"]) converted[@"top_p"] = payload[@"top_p"];
    NSArray *tools = [self chatToolsFromResponsesTools:payload[@"tools"]];
    if (tools.count > 0) converted[@"tools"] = tools;
    if (payload[@"tool_choice"]) converted[@"tool_choice"] = payload[@"tool_choice"];
    return JSONData(converted);
}

- (NSArray *)anthropicMessagesFromResponsesPayload:(NSDictionary *)payload system:(NSString **)systemOut {
    id input = payload[@"input"];
    NSMutableArray *messages = [NSMutableArray array];
    NSMutableArray<NSString *> *systemParts = [NSMutableArray array];
    NSString *instructions = TrimString(payload[@"instructions"]);
    if (instructions.length > 0) [systemParts addObject:instructions];

    if ([input isKindOfClass:NSString.class]) {
        [messages addObject:@{@"role": @"user", @"content": input}];
    } else if ([input isKindOfClass:NSArray.class]) {
        for (NSDictionary *item in (NSArray *)input) {
            if (![item isKindOfClass:NSDictionary.class]) continue;
            NSString *type = TrimString(item[@"type"]);
            NSString *role = TrimString(item[@"role"]);
            if (role.length == 0) role = @"user";

            if ([role isEqualToString:@"system"] || [role isEqualToString:@"developer"]) {
                NSString *systemText = [self textFromResponsesContent:item[@"content"] ?: item[@"text"]];
                if (systemText.length > 0) [systemParts addObject:systemText];
                continue;
            }

            if ([type isEqualToString:@"function_call_output"] || [role isEqualToString:@"tool"]) {
                NSString *toolUseId = TrimString(item[@"call_id"] ?: item[@"tool_call_id"] ?: item[@"id"]);
                NSString *toolText = [self textFromResponsesContent:item[@"output"] ?: item[@"content"]];
                NSDictionary *toolResult = @{
                    @"type": @"tool_result",
                    @"tool_use_id": toolUseId.length > 0 ? toolUseId : @"call_unknown",
                    @"content": toolText ?: @""
                };
                [messages addObject:@{@"role": @"user", @"content": @[toolResult]}];
                continue;
            }

            if ([type isEqualToString:@"function_call"]) {
                NSString *callId = TrimString(item[@"call_id"] ?: item[@"id"]);
                NSString *name = TrimString(item[@"name"]);
                if (name.length > 0) {
                    id inputObject = [self jsonObjectFromJSONString:item[@"arguments"] fallback:@{}];
                    if (![inputObject isKindOfClass:NSDictionary.class]) inputObject = @{};
                    [messages addObject:@{@"role": @"assistant", @"content": @[
                        @{
                            @"type": @"tool_use",
                            @"id": callId.length > 0 ? callId : [@"call_" stringByAppendingString:NSUUID.UUID.UUIDString],
                            @"name": name,
                            @"input": inputObject
                        }
                    ]}];
                }
                continue;
            }

            NSString *content = [self textFromResponsesContent:item[@"content"] ?: item[@"text"]];
            if (content.length == 0) continue;
            NSString *anthropicRole = [role isEqualToString:@"assistant"] ? @"assistant" : @"user";
            [messages addObject:@{@"role": anthropicRole, @"content": content}];
        }
    }

    if (systemOut) *systemOut = [systemParts componentsJoinedByString:@"\n\n"];
    return messages.count > 0 ? messages : @[@{@"role": @"user", @"content": @"ping"}];
}

- (NSData *)anthropicMessagesBodyFromResponsesBody:(NSData *)body stream:(BOOL)stream {
    id object = [self jsonObjectFromData:body];
    if (![object isKindOfClass:NSDictionary.class]) return body;
    NSDictionary *payload = object;
    NSString *system = nil;
    NSMutableDictionary *converted = [@{
        @"model": TrimString(payload[@"model"]),
        @"messages": [self anthropicMessagesFromResponsesPayload:payload system:&system],
        @"max_tokens": payload[@"max_output_tokens"] ?: payload[@"max_tokens"] ?: @4096
    } mutableCopy];
    if (system.length > 0) converted[@"system"] = system;
    if (payload[@"temperature"]) converted[@"temperature"] = payload[@"temperature"];
    if (payload[@"top_p"]) converted[@"top_p"] = payload[@"top_p"];
    if (stream) converted[@"stream"] = @YES;
    NSArray *tools = [self anthropicToolsFromResponsesTools:payload[@"tools"]];
    if (tools.count > 0) converted[@"tools"] = tools;
    return JSONData(converted);
}

- (NSData *)requestBodyForUpstreamFromResponsesBody:(NSData *)body provider:(NSDictionary *)provider apiFormat:(NSString *)apiFormat stream:(BOOL)stream {
    NSData *responsesBody = [self requestBodyByApplyingActiveModel:body provider:provider];
    NSString *format = ProviderAPIFormat(@{@"apiFormat": apiFormat ?: @""});
    if ([format isEqualToString:APIFormatChatCompletions]) {
        return [self chatCompletionsBodyFromResponsesBody:responsesBody stream:stream];
    }
    if ([format isEqualToString:APIFormatAnthropicMessages]) {
        return [self anthropicMessagesBodyFromResponsesBody:responsesBody stream:stream];
    }
    return responsesBody;
}

- (NSArray *)outputItemsFromChatCompletionsPayload:(NSDictionary *)payload model:(NSString *)model {
    NSArray *choices = payload[@"choices"];
    NSDictionary *choice = [choices isKindOfClass:NSArray.class] ? choices.firstObject : nil;
    NSDictionary *message = [choice[@"message"] isKindOfClass:NSDictionary.class] ? choice[@"message"] : nil;
    NSMutableArray *items = [NSMutableArray array];
    NSString *reasoningContent = TrimString(message[@"reasoning_content"]);
    NSString *text = [self textFromResponsesContent:message[@"content"]];
    if (text.length == 0) text = [self textFromResponsesContent:message[@"text"] ?: message[@"output_text"]];
    if (text.length == 0) text = [self textFromResponsesContent:payload[@"output_text"] ?: payload[@"text"]];
    if (text.length > 0) {
        NSMutableDictionary *messageItem = [@{
            @"id": [@"msg_" stringByAppendingString:NSUUID.UUID.UUIDString],
            @"type": @"message",
            @"status": @"completed",
            @"role": @"assistant",
            @"content": @[@{@"type": @"output_text", @"text": text, @"annotations": @[]}]
        } mutableCopy];
        if (reasoningContent.length > 0) messageItem[@"reasoning_content"] = reasoningContent;
        [items addObject:messageItem];
    }

    NSArray *toolCalls = message[@"tool_calls"];
    if ([toolCalls isKindOfClass:NSArray.class]) {
        for (NSDictionary *toolCall in toolCalls) {
            if (![toolCall isKindOfClass:NSDictionary.class]) continue;
            NSDictionary *function = [toolCall[@"function"] isKindOfClass:NSDictionary.class] ? toolCall[@"function"] : nil;
            NSString *name = TrimString(function[@"name"]);
            if (name.length == 0) continue;
            NSString *callId = TrimString(toolCall[@"id"]);
            NSString *safeCallId = callId.length > 0 ? callId : [@"call_" stringByAppendingString:NSUUID.UUID.UUIDString];
            NSMutableDictionary *functionItem = [@{
                @"id": [@"fc_" stringByAppendingString:NSUUID.UUID.UUIDString],
                @"type": @"function_call",
                @"status": @"completed",
                @"call_id": safeCallId,
                @"name": name,
                @"arguments": TrimString(function[@"arguments"])
            } mutableCopy];
            if (reasoningContent.length > 0) {
                functionItem[@"reasoning_content"] = reasoningContent;
                [self rememberReasoningContent:reasoningContent forCallId:safeCallId];
            }
            [items addObject:functionItem];
        }
    }

    NSDictionary *legacyFunctionCall = [message[@"function_call"] isKindOfClass:NSDictionary.class] ? message[@"function_call"] : nil;
    NSString *legacyName = TrimString(legacyFunctionCall[@"name"]);
    if (legacyName.length > 0) {
        NSString *safeCallId = [@"call_" stringByAppendingString:NSUUID.UUID.UUIDString];
        NSMutableDictionary *functionItem = [@{
            @"id": [@"fc_" stringByAppendingString:NSUUID.UUID.UUIDString],
            @"type": @"function_call",
            @"status": @"completed",
            @"call_id": safeCallId,
            @"name": legacyName,
            @"arguments": TrimString(legacyFunctionCall[@"arguments"])
        } mutableCopy];
        if (reasoningContent.length > 0) {
            functionItem[@"reasoning_content"] = reasoningContent;
            [self rememberReasoningContent:reasoningContent forCallId:safeCallId];
        }
        [items addObject:functionItem];
    }
    return items;
}

- (NSArray *)outputItemsFromAnthropicMessagesPayload:(NSDictionary *)payload model:(NSString *)model {
    NSArray *content = payload[@"content"];
    NSMutableArray *items = [NSMutableArray array];
    NSMutableString *text = [NSMutableString string];
    if ([content isKindOfClass:NSArray.class]) {
        for (NSDictionary *part in content) {
            if (![part isKindOfClass:NSDictionary.class]) continue;
            NSString *type = TrimString(part[@"type"]);
            if ([type isEqualToString:@"text"]) {
                NSString *partText = TrimString(part[@"text"]);
                if (partText.length > 0) [text appendString:partText];
            } else if ([type isEqualToString:@"tool_use"]) {
                id input = part[@"input"] ?: @{};
                [items addObject:@{
                    @"id": [@"fc_" stringByAppendingString:NSUUID.UUID.UUIDString],
                    @"type": @"function_call",
                    @"status": @"completed",
                    @"call_id": TrimString(part[@"id"]).length > 0 ? TrimString(part[@"id"]) : [@"call_" stringByAppendingString:NSUUID.UUID.UUIDString],
                    @"name": TrimString(part[@"name"]),
                    @"arguments": [input isKindOfClass:NSString.class] ? input : JSONString(input)
                }];
            }
        }
    }
    if (text.length > 0) {
        [items insertObject:@{
            @"id": [@"msg_" stringByAppendingString:NSUUID.UUID.UUIDString],
            @"type": @"message",
            @"status": @"completed",
            @"role": @"assistant",
            @"content": @[@{@"type": @"output_text", @"text": text, @"annotations": @[]}]
        } atIndex:0];
    }
    return items;
}

- (NSData *)responsesDataFromOutputItems:(NSArray *)items model:(NSString *)model forceStream:(BOOL)forceStream {
    NSArray *outputItems = items ?: @[];
    if (forceStream) return [self responsesSSEFromOutputItems:outputItems model:model];
    return JSONData([self responseObjectWithId:nil model:model outputItems:outputItems]);
}

- (NSData *)responsesDataFromChatCompletionsData:(NSData *)data model:(NSString *)model forceStream:(BOOL)forceStream {
    id object = [self jsonObjectFromData:data ?: NSData.data];
    if (![object isKindOfClass:NSDictionary.class]) {
        NSString *text = [[NSString alloc] initWithData:data ?: NSData.data encoding:NSUTF8StringEncoding] ?: @"";
        return forceStream ? [self responsesSSEFromText:text model:model] : JSONData([self responseObjectWithId:nil model:model status:@"completed" text:text itemId:nil]);
    }
    return [self responsesDataFromOutputItems:[self outputItemsFromChatCompletionsPayload:object model:model] model:model ?: object[@"model"] forceStream:forceStream];
}

- (NSData *)responsesDataFromAnthropicMessagesData:(NSData *)data model:(NSString *)model forceStream:(BOOL)forceStream {
    id object = [self jsonObjectFromData:data ?: NSData.data];
    if (![object isKindOfClass:NSDictionary.class]) {
        NSString *text = [[NSString alloc] initWithData:data ?: NSData.data encoding:NSUTF8StringEncoding] ?: @"";
        return forceStream ? [self responsesSSEFromText:text model:model] : JSONData([self responseObjectWithId:nil model:model status:@"completed" text:text itemId:nil]);
    }
    return [self responsesDataFromOutputItems:[self outputItemsFromAnthropicMessagesPayload:object model:model] model:model ?: object[@"model"] forceStream:forceStream];
}

- (NSDictionary *)upstreamResultForRequest:(NSDictionary *)request provider:(NSDictionary *)provider {
    CFAbsoluteTime startedAt = CFAbsoluteTimeGetCurrent();
    NSString *apiKey = provider ? [_store apiKeyForProvider:provider] : nil;
    if (!provider || apiKey.length == 0) {
        return @{@"status": @503, @"error": @"Provider API Key is unavailable", @"retryable": @YES, @"durationMs": @0};
    }
    NSString *path = request[@"path"];
    if ([path hasPrefix:@"/v1/"]) {
        path = [path substringFromIndex:3];
    } else if ([path isEqualToString:@"/v1"]) {
        path = @"";
    }

    NSString *originalPath = path;
    NSString *apiFormat = ProviderAPIFormat(provider);
    path = [self upstreamPathForPath:path provider:provider];
    NSString *urlText = [provider[@"baseURL"] stringByAppendingString:path];
    NSURL *url = [NSURL URLWithString:urlText];
    if (!url) {
        return @{@"status": @500, @"error": @"Invalid provider baseURL", @"retryable": @YES, @"durationMs": @0};
    }

    BOOL clientWantsStream = [self requestBodyWantsStream:request[@"body"]];
    NSData *bodyData = [self requestBodyForUpstreamFromResponsesBody:request[@"body"] provider:provider apiFormat:apiFormat stream:NO];
    if ([apiFormat isEqualToString:APIFormatResponses] && clientWantsStream && [originalPath isEqualToString:@"/responses"]) {
        bodyData = [self requestBodyByForcingStream:NO body:bodyData];
    }

    NSMutableURLRequest *urlRequest = [NSMutableURLRequest requestWithURL:url cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:UpstreamRequestTimeoutSeconds];
    urlRequest.HTTPMethod = request[@"method"];
    urlRequest.HTTPBody = bodyData;

    NSDictionary *headers = request[@"headers"];
    for (NSString *key in headers) {
        NSString *lower = key.lowercaseString;
        if ([lower isEqualToString:@"host"] || [lower isEqualToString:@"content-length"] || [lower isEqualToString:@"connection"] || [lower isEqualToString:@"authorization"]) {
            continue;
        }
        [urlRequest setValue:headers[key] forHTTPHeaderField:key];
    }
    if ([apiFormat isEqualToString:APIFormatAnthropicMessages]) {
        [urlRequest setValue:apiKey forHTTPHeaderField:@"x-api-key"];
        [urlRequest setValue:@"2023-06-01" forHTTPHeaderField:@"anthropic-version"];
    } else {
        [urlRequest setValue:[NSString stringWithFormat:@"Bearer %@", apiKey] forHTTPHeaderField:@"Authorization"];
    }
    if (![urlRequest valueForHTTPHeaderField:@"Content-Type"]) {
        [urlRequest setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
    }

    NSString *codexRequestedModel = [self requestedModelFromBody:request[@"body"]] ?: @"";
    NSString *upstreamModel = [self requestedModelFromBody:bodyData] ?: [self selectedUpstreamModelForProvider:provider];
    NSString *routeSignature = [self routeSignatureForProvider:provider upstreamModel:upstreamModel];
    [self appendDebugLine:[NSString stringWithFormat:@"--> %@ %@ provider=%@ api=%@ selectedModel=%@ upstreamModel=%@ codexRequestedModel=%@ bodyBytes=%lu stream=%@",
                           request[@"method"] ?: @"",
                           urlText ?: @"",
                           provider[@"name"] ?: @"",
                           apiFormat ?: @"",
                           ProviderSelectedCatalogModel(provider),
                           upstreamModel ?: @"",
                           codexRequestedModel ?: @"",
                           (unsigned long)bodyData.length,
                           clientWantsStream ? @"true" : @"false"]];

    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    __block NSData *responseData = nil;
    __block NSHTTPURLResponse *httpResponse = nil;
    __block NSError *taskError = nil;

    NSURLSessionDataTask *task = [NSURLSession.sharedSession dataTaskWithRequest:urlRequest completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        responseData = data;
        httpResponse = (NSHTTPURLResponse *)response;
        taskError = error;
        dispatch_semaphore_signal(semaphore);
    }];
    [task resume];
    long waitResult = dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW, (int64_t)((UpstreamRequestTimeoutSeconds + 5) * NSEC_PER_SEC)));
    if (waitResult != 0) {
        [task cancel];
        return @{@"status": @504,
                 @"error": @"Upstream request timed out before completion",
                 @"retryable": @YES,
                 @"durationMs": @((CFAbsoluteTimeGetCurrent() - startedAt) * 1000.0)};
    }

    if (taskError) {
        [self appendDebugLine:[NSString stringWithFormat:@"<-- error provider=%@ error=%@", provider[@"name"] ?: @"", taskError.localizedDescription ?: @""]];
        return @{@"status": @502,
                 @"error": taskError.localizedDescription ?: @"Upstream request failed",
                 @"retryable": @YES,
                 @"durationMs": @((CFAbsoluteTimeGetCurrent() - startedAt) * 1000.0)};
    }

    NSInteger status = httpResponse ? httpResponse.statusCode : 200;
    NSString *contentType = [httpResponse.allHeaderFields[@"Content-Type"] description] ?: @"application/json";
    [self appendDebugLine:[NSString stringWithFormat:@"<-- status=%ld contentType=%@ bodyBytes=%lu",
                           (long)status,
                           contentType ?: @"",
                           (unsigned long)responseData.length]];
    NSData *usageData = responseData ?: NSData.data;
    if (status >= 200 && status < 300 && [originalPath isEqualToString:@"/responses"] && [apiFormat isEqualToString:APIFormatResponses] && clientWantsStream) {
        responseData = [self responsesDataFromNativeResponsesData:responseData model:upstreamModel ?: ProviderSelectedCatalogModel(provider) contentType:contentType forceStream:YES];
        contentType = @"text/event-stream";
        [self appendDebugLine:[NSString stringWithFormat:@"<-- native converted contentType=%@ bodyBytes=%lu",
                               contentType ?: @"",
                               (unsigned long)responseData.length]];
    } else if (status >= 200 && status < 300 && [originalPath isEqualToString:@"/responses"] && [apiFormat isEqualToString:APIFormatChatCompletions]) {
        responseData = [self responsesDataFromChatCompletionsData:responseData model:upstreamModel ?: ProviderSelectedCatalogModel(provider) forceStream:clientWantsStream];
        contentType = clientWantsStream ? @"text/event-stream" : @"application/json";
        [self appendDebugLine:[NSString stringWithFormat:@"<-- chat converted contentType=%@ bodyBytes=%lu",
                               contentType ?: @"",
                               (unsigned long)responseData.length]];
    } else if (status >= 200 && status < 300 && [originalPath isEqualToString:@"/responses"] && [apiFormat isEqualToString:APIFormatAnthropicMessages]) {
        responseData = [self responsesDataFromAnthropicMessagesData:responseData model:upstreamModel ?: ProviderSelectedCatalogModel(provider) forceStream:clientWantsStream];
        contentType = clientWantsStream ? @"text/event-stream" : @"application/json";
        [self appendDebugLine:[NSString stringWithFormat:@"<-- anthropic converted contentType=%@ bodyBytes=%lu",
                               contentType ?: @"",
                               (unsigned long)responseData.length]];
    }
    [self recordResponseRoutesFromData:responseData routeSignature:routeSignature];
    return @{
        @"status": @(status),
        @"data": responseData ?: NSData.data,
        @"usageData": usageData,
        @"contentType": contentType ?: @"application/json",
        @"retryable": @(status >= 500),
        @"durationMs": @((CFAbsoluteTimeGetCurrent() - startedAt) * 1000.0),
        @"model": upstreamModel ?: ProviderSelectedCatalogModel(provider),
        @"apiFormat": apiFormat ?: APIFormatResponses
    };
}

- (NSString *)normalizedGatewayPathForRequestPath:(NSString *)requestPath {
    NSString *path = requestPath ?: @"";
    if ([path hasPrefix:@"/v1/"]) {
        return [path substringFromIndex:3];
    }
    if ([path isEqualToString:@"/v1"]) return @"";
    return path;
}

- (BOOL)canStreamNativeResponsesRequest:(NSDictionary *)request provider:(NSDictionary *)provider {
    if (!provider) return NO;
    if (![ProviderAPIFormat(provider) isEqualToString:APIFormatResponses]) return NO;
    if (![self requestBodyWantsStream:request[@"body"]]) return NO;
    NSString *path = [[self normalizedGatewayPathForRequestPath:request[@"path"]] componentsSeparatedByString:@"?"].firstObject;
    return [path isEqualToString:@"/responses"];
}

- (BOOL)canStreamAdaptedResponsesRequest:(NSDictionary *)request provider:(NSDictionary *)provider {
    if (!provider) return NO;
    NSString *apiFormat = ProviderAPIFormat(provider);
    if (![apiFormat isEqualToString:APIFormatChatCompletions] && ![apiFormat isEqualToString:APIFormatAnthropicMessages]) return NO;
    if (![self requestBodyWantsStream:request[@"body"]]) return NO;
    NSString *path = [[self normalizedGatewayPathForRequestPath:request[@"path"]] componentsSeparatedByString:@"?"].firstObject;
    return [path isEqualToString:@"/responses"];
}

- (NSMutableURLRequest *)upstreamURLRequestForRequest:(NSDictionary *)request provider:(NSDictionary *)provider bodyData:(NSData **)bodyDataOut originalPath:(NSString **)originalPathOut errorText:(NSString **)errorText {
    NSString *apiKey = provider ? [_store apiKeyForProvider:provider] : nil;
    if (!provider || apiKey.length == 0) {
        if (errorText) *errorText = @"Provider API Key is unavailable";
        return nil;
    }

    NSString *originalPath = [self normalizedGatewayPathForRequestPath:request[@"path"]];
    if (originalPathOut) *originalPathOut = originalPath;
    NSString *path = [self upstreamPathForPath:originalPath provider:provider];
    NSString *urlText = [provider[@"baseURL"] stringByAppendingString:path];
    NSURL *url = [NSURL URLWithString:urlText];
    if (!url) {
        if (errorText) *errorText = @"Invalid provider baseURL";
        return nil;
    }

    NSString *apiFormat = ProviderAPIFormat(provider);
    NSData *bodyData = [self requestBodyForUpstreamFromResponsesBody:request[@"body"] provider:provider apiFormat:apiFormat stream:YES];
    if ([apiFormat isEqualToString:APIFormatResponses]) {
        bodyData = [self requestBodyByForcingStream:YES body:bodyData];
    }
    if (bodyDataOut) *bodyDataOut = bodyData;

    NSMutableURLRequest *urlRequest = [NSMutableURLRequest requestWithURL:url cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:UpstreamRequestTimeoutSeconds];
    urlRequest.HTTPMethod = request[@"method"];
    urlRequest.HTTPBody = bodyData;

    NSDictionary *headers = request[@"headers"];
    for (NSString *key in headers) {
        NSString *lower = key.lowercaseString;
        if ([lower isEqualToString:@"host"] || [lower isEqualToString:@"content-length"] || [lower isEqualToString:@"connection"] || [lower isEqualToString:@"authorization"]) continue;
        [urlRequest setValue:headers[key] forHTTPHeaderField:key];
    }
    if ([apiFormat isEqualToString:APIFormatAnthropicMessages]) {
        [urlRequest setValue:apiKey forHTTPHeaderField:@"x-api-key"];
        [urlRequest setValue:@"2023-06-01" forHTTPHeaderField:@"anthropic-version"];
    } else {
        [urlRequest setValue:[NSString stringWithFormat:@"Bearer %@", apiKey] forHTTPHeaderField:@"Authorization"];
    }
    if (![urlRequest valueForHTTPHeaderField:@"Content-Type"]) {
        [urlRequest setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
    }
    return urlRequest;
}

- (void)streamNativeResponsesRequest:(NSDictionary *)request provider:(NSDictionary *)provider toClient:(int)client {
    CFAbsoluteTime startedAt = CFAbsoluteTimeGetCurrent();
    NSData *bodyData = nil;
    NSString *originalPath = nil;
    NSString *errorText = nil;
    NSMutableURLRequest *urlRequest = [self upstreamURLRequestForRequest:request provider:provider bodyData:&bodyData originalPath:&originalPath errorText:&errorText];
    NSString *codexRequestedModel = [self requestedModelFromBody:request[@"body"]] ?: @"";
    NSString *model = [self requestedModelFromBody:bodyData] ?: [self selectedUpstreamModelForProvider:provider];
    NSString *routeSignature = [self routeSignatureForProvider:provider upstreamModel:model];
    if (!urlRequest) {
        [self writeJSON:@{@"error": errorText ?: @"Upstream request could not be created",
                          @"provider": provider[@"name"] ?: @"",
                          @"baseURL": provider[@"baseURL"] ?: @"",
                          @"model": model ?: @""}
                 status:[errorText isEqualToString:@"Provider API Key is unavailable"] ? 503 : 500
               toClient:client];
        return;
    }

    [self appendDebugLine:[NSString stringWithFormat:@"--> STREAM %@ %@ provider=%@ api=%@ selectedModel=%@ upstreamModel=%@ codexRequestedModel=%@ bodyBytes=%lu stream=true",
                           request[@"method"] ?: @"",
                           urlRequest.URL.absoluteString ?: @"",
                           provider[@"name"] ?: @"",
                           ProviderAPIFormat(provider),
                           ProviderSelectedCatalogModel(provider),
                           model ?: @"",
                           codexRequestedModel ?: @"",
                           (unsigned long)bodyData.length]];

    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    __block BOOL wroteResponseHeaders = NO;
    __block BOOL clientWritable = YES;
    __block NSInteger finalStatus = 502;
    __block NSError *finalError = nil;
    __block NSURLSessionDataTask *task = nil;

    AKSStreamingBridge *bridge = [[AKSStreamingBridge alloc] init];
    bridge.onResponse = ^(NSHTTPURLResponse *response) {
        finalStatus = response.statusCode;
        NSString *contentType = [response.allHeaderFields[@"Content-Type"] description];
        if (contentType.length == 0) contentType = @"text/event-stream";
        NSDictionary *headers = @{
            @"Content-Type": contentType,
            @"Access-Control-Allow-Origin": @"http://127.0.0.1",
            @"X-AI-Key-Switcher-Provider": provider[@"name"] ?: @"",
            @"X-AI-Key-Switcher-Base-URL": provider[@"baseURL"] ?: @"",
            @"X-AI-Key-Switcher-API-Format": ProviderAPIFormat(provider),
            @"X-AI-Key-Switcher-Model": model ?: @""
        };
        wroteResponseHeaders = [self writeChunkedHeadersStatus:finalStatus headers:headers toClient:client];
        clientWritable = wroteResponseHeaders;
        [self appendDebugLine:[NSString stringWithFormat:@"<-- STREAM status=%ld contentType=%@", (long)finalStatus, contentType ?: @""]];
    };
    bridge.onData = ^(NSData *data) {
        if (!clientWritable) return;
        clientWritable = [self writeChunk:data toClient:client];
        if (!clientWritable) [task cancel];
    };
    bridge.onComplete = ^(NSError *error, NSData *capturedData) {
        finalError = error;
        [self recordResponseRoutesFromData:capturedData ?: NSData.data routeSignature:routeSignature];
        if (!wroteResponseHeaders && error) {
            [self writeJSON:@{@"error": error.localizedDescription ?: @"Upstream stream failed",
                              @"provider": provider[@"name"] ?: @"",
                              @"baseURL": provider[@"baseURL"] ?: @"",
                              @"model": model ?: @""}
                     status:502
                   toClient:client];
        } else if (wroteResponseHeaders && clientWritable) {
            [self finishChunkedResponseToClient:client];
        }

        NSDictionary *usage = [self normalizedUsageFromData:capturedData ?: NSData.data];
        [_usageStore recordProvider:provider[@"name"]
                              model:model ?: ProviderSelectedCatalogModel(provider)
                             status:finalStatus > 0 ? finalStatus : (error ? 502 : 200)
                         durationMs:(CFAbsoluteTimeGetCurrent() - startedAt) * 1000.0
                              usage:usage
                             source:@"local_gateway_stream"];
        [self appendDebugLine:[NSString stringWithFormat:@"<-- STREAM done provider=%@ status=%ld bytes=%lu error=%@",
                               provider[@"name"] ?: @"",
                               (long)(finalStatus > 0 ? finalStatus : (error ? 502 : 200)),
                               (unsigned long)(capturedData ?: NSData.data).length,
                               error.localizedDescription ?: @""]];
        dispatch_semaphore_signal(semaphore);
    };

    NSURLSessionConfiguration *configuration = NSURLSessionConfiguration.ephemeralSessionConfiguration;
    configuration.timeoutIntervalForRequest = UpstreamRequestTimeoutSeconds;
    configuration.timeoutIntervalForResource = UpstreamRequestTimeoutSeconds + 30;
    NSURLSession *session = [NSURLSession sessionWithConfiguration:configuration delegate:bridge delegateQueue:nil];
    task = [session dataTaskWithRequest:urlRequest];
    [task resume];

    long waitResult = dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW, (int64_t)((UpstreamRequestTimeoutSeconds + 35) * NSEC_PER_SEC)));
    if (waitResult != 0) {
        [task cancel];
        [session invalidateAndCancel];
        if (!wroteResponseHeaders) {
            [self writeJSON:@{@"error": @"Upstream stream timed out before completion",
                              @"provider": provider[@"name"] ?: @"",
                              @"baseURL": provider[@"baseURL"] ?: @"",
                              @"model": model ?: @""}
                     status:504
                   toClient:client];
        } else if (clientWritable) {
            [self finishChunkedResponseToClient:client];
        }
        [_usageStore recordProvider:provider[@"name"]
                              model:model ?: ProviderSelectedCatalogModel(provider)
                             status:504
                         durationMs:(CFAbsoluteTimeGetCurrent() - startedAt) * 1000.0
                              usage:@{}
                             source:@"local_gateway_stream"];
        return;
    }
    [session finishTasksAndInvalidate];
    (void)finalError;
    (void)originalPath;
}

- (void)streamAdaptedResponsesRequest:(NSDictionary *)request provider:(NSDictionary *)provider toClient:(int)client {
    CFAbsoluteTime startedAt = CFAbsoluteTimeGetCurrent();
    NSData *bodyData = nil;
    NSString *originalPath = nil;
    NSString *errorText = nil;
    NSMutableURLRequest *urlRequest = [self upstreamURLRequestForRequest:request provider:provider bodyData:&bodyData originalPath:&originalPath errorText:&errorText];
    NSString *apiFormat = ProviderAPIFormat(provider);
    NSString *codexRequestedModel = [self requestedModelFromBody:request[@"body"]] ?: @"";
    NSString *model = [self requestedModelFromBody:bodyData] ?: [self selectedUpstreamModelForProvider:provider];
    NSString *routeSignature = [self routeSignatureForProvider:provider upstreamModel:model];
    if (!urlRequest) {
        [self writeJSON:@{@"error": errorText ?: @"Upstream request could not be created",
                          @"provider": provider[@"name"] ?: @"",
                          @"baseURL": provider[@"baseURL"] ?: @"",
                          @"model": model ?: @""}
                 status:[errorText isEqualToString:@"Provider API Key is unavailable"] ? 503 : 500
               toClient:client];
        return;
    }

    [self appendDebugLine:[NSString stringWithFormat:@"--> ADAPTED_STREAM %@ %@ provider=%@ api=%@ selectedModel=%@ upstreamModel=%@ codexRequestedModel=%@ bodyBytes=%lu",
                           request[@"method"] ?: @"",
                           urlRequest.URL.absoluteString ?: @"",
                           provider[@"name"] ?: @"",
                           apiFormat ?: @"",
                           ProviderSelectedCatalogModel(provider),
                           model ?: @"",
                           codexRequestedModel ?: @"",
                           (unsigned long)bodyData.length]];

    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    __block BOOL wroteResponseHeaders = NO;
    __block BOOL clientWritable = YES;
    __block NSInteger finalStatus = 502;
    __block NSError *finalError = nil;
    __block NSURLSessionDataTask *task = nil;
    __block NSMutableString *lineBuffer = [NSMutableString string];

    NSString *responseId = [@"resp_" stringByAppendingString:NSUUID.UUID.UUIDString];
    __block BOOL wroteResponseStart = NO;
    __block BOOL textStarted = NO;
    __block NSString *textItemId = [@"msg_" stringByAppendingString:NSUUID.UUID.UUIDString];
    __block NSUInteger nextOutputIndex = 0;
    __block NSNumber *textOutputIndex = nil;
    __block NSMutableString *fullText = [NSMutableString string];
    __block NSMutableString *fullReasoningContent = [NSMutableString string];
    __block NSMutableArray *completedItems = [NSMutableArray array];
    __block NSMutableDictionary<NSNumber *, NSMutableDictionary *> *toolStateByIndex = [NSMutableDictionary dictionary];
    __block NSMutableDictionary<NSNumber *, NSMutableDictionary *> *anthropicBlockStateByIndex = [NSMutableDictionary dictionary];

    BOOL (^emitEvent)(NSString *, NSDictionary *) = ^BOOL(NSString *event, NSDictionary *payload) {
        if (!clientWritable) return NO;
        clientWritable = [self writeChunkString:[self responsesSSEEvent:event payload:payload ?: @{}] toClient:client];
        if (!clientWritable) [task cancel];
        return clientWritable;
    };

    void (^emitResponseStart)(void) = ^{
        if (wroteResponseStart) return;
        wroteResponseStart = YES;
        [self rememberResponseId:responseId routeSignature:routeSignature];
        NSDictionary *response = [self responseObjectWithId:responseId model:model status:@"in_progress" text:@"" itemId:nil];
        emitEvent(@"response.created", @{@"response": response});
        emitEvent(@"response.in_progress", @{@"response": response});
    };

    void (^ensureTextStarted)(void) = ^{
        emitResponseStart();
        if (textStarted) return;
        textStarted = YES;
        textOutputIndex = @(nextOutputIndex++);
        emitEvent(@"response.output_item.added", @{@"output_index": textOutputIndex, @"item": @{
            @"id": textItemId,
            @"type": @"message",
            @"status": @"in_progress",
            @"role": @"assistant",
            @"content": @[]
        }});
        emitEvent(@"response.content_part.added", @{@"item_id": textItemId, @"output_index": textOutputIndex, @"content_index": @0, @"part": @{@"type": @"output_text", @"text": @"", @"annotations": @[]}});
    };

    void (^emitTextDelta)(NSString *) = ^(NSString *delta) {
        NSString *text = [delta isKindOfClass:NSString.class] ? delta : @"";
        if (text.length == 0) return;
        ensureTextStarted();
        [fullText appendString:text];
        emitEvent(@"response.output_text.delta", @{@"item_id": textItemId, @"output_index": textOutputIndex ?: @0, @"content_index": @0, @"delta": text});
    };

    void (^finishTextIfNeeded)(void) = ^{
        if (!textStarted) return;
        NSMutableDictionary *doneItem = [@{
            @"id": textItemId,
            @"type": @"message",
            @"status": @"completed",
            @"role": @"assistant",
            @"content": @[@{@"type": @"output_text", @"text": fullText ?: @"", @"annotations": @[]}]
        } mutableCopy];
        if (fullReasoningContent.length > 0) doneItem[@"reasoning_content"] = [fullReasoningContent copy];
        emitEvent(@"response.output_text.done", @{@"item_id": textItemId, @"output_index": textOutputIndex ?: @0, @"content_index": @0, @"text": fullText ?: @""});
        emitEvent(@"response.content_part.done", @{@"item_id": textItemId, @"output_index": textOutputIndex ?: @0, @"content_index": @0, @"part": @{@"type": @"output_text", @"text": fullText ?: @"", @"annotations": @[]}});
        emitEvent(@"response.output_item.done", @{@"output_index": textOutputIndex ?: @0, @"item": doneItem});
        [completedItems addObject:doneItem];
        textStarted = NO;
    };

    NSMutableDictionary *(^ensureToolState)(NSNumber *, NSString *, NSString *) = ^NSMutableDictionary *(NSNumber *upstreamIndex, NSString *callId, NSString *name) {
        NSNumber *safeIndex = upstreamIndex ?: @0;
        NSMutableDictionary *state = toolStateByIndex[safeIndex];
        if (state) {
            if (callId.length > 0) state[@"callId"] = callId;
            if (name.length > 0) state[@"name"] = name;
            return state;
        }

        emitResponseStart();
        NSString *itemId = [@"fc_" stringByAppendingString:NSUUID.UUID.UUIDString];
        NSNumber *outputIndex = @(nextOutputIndex++);
        NSString *safeCallId = callId.length > 0 ? callId : [@"call_" stringByAppendingString:NSUUID.UUID.UUIDString];
        state = [@{
            @"itemId": itemId,
            @"outputIndex": outputIndex,
            @"callId": safeCallId,
            @"name": name ?: @"",
            @"arguments": [NSMutableString string]
        } mutableCopy];
        toolStateByIndex[safeIndex] = state;
        emitEvent(@"response.output_item.added", @{@"output_index": outputIndex, @"item": @{
            @"id": itemId,
            @"type": @"function_call",
            @"status": @"in_progress",
            @"call_id": safeCallId,
            @"name": name ?: @"",
            @"arguments": @""
        }});
        return state;
    };

    void (^emitToolArgumentsDelta)(NSNumber *, NSString *, NSString *, NSString *) = ^(NSNumber *upstreamIndex, NSString *callId, NSString *name, NSString *delta) {
        NSMutableDictionary *state = ensureToolState(upstreamIndex, callId, name);
        NSString *text = [delta isKindOfClass:NSString.class] ? delta : @"";
        if (text.length == 0) return;
        [(NSMutableString *)state[@"arguments"] appendString:text];
        emitEvent(@"response.function_call_arguments.delta", @{@"item_id": state[@"itemId"], @"output_index": state[@"outputIndex"], @"delta": text});
    };

    void (^finishToolStates)(void) = ^{
        NSArray *keys = [[toolStateByIndex allKeys] sortedArrayUsingSelector:@selector(compare:)];
        for (NSNumber *key in keys) {
            NSMutableDictionary *state = toolStateByIndex[key];
            NSString *arguments = [(NSMutableString *)state[@"arguments"] copy] ?: @"{}";
            if (arguments.length == 0) arguments = @"{}";
            NSString *name = TrimString(state[@"name"]);
            NSMutableDictionary *doneItem = [@{
                @"id": state[@"itemId"] ?: [@"fc_" stringByAppendingString:NSUUID.UUID.UUIDString],
                @"type": @"function_call",
                @"status": @"completed",
                @"call_id": state[@"callId"] ?: [@"call_" stringByAppendingString:NSUUID.UUID.UUIDString],
                @"name": name,
                @"arguments": arguments
            } mutableCopy];
            NSString *reasoningContent = TrimString(state[@"reasoning_content"] ?: fullReasoningContent);
            if (reasoningContent.length > 0) {
                doneItem[@"reasoning_content"] = reasoningContent;
                [self rememberReasoningContent:reasoningContent forCallId:doneItem[@"call_id"]];
            }
            emitEvent(@"response.function_call_arguments.done", @{@"item_id": doneItem[@"id"], @"name": name, @"output_index": state[@"outputIndex"] ?: @0, @"arguments": arguments});
            emitEvent(@"response.output_item.done", @{@"output_index": state[@"outputIndex"] ?: @0, @"item": doneItem});
            [completedItems addObject:doneItem];
        }
        [toolStateByIndex removeAllObjects];
    };

    void (^processChatJSON)(NSDictionary *) = ^(NSDictionary *payload) {
        NSArray *choices = payload[@"choices"];
        NSDictionary *choice = [choices isKindOfClass:NSArray.class] ? choices.firstObject : nil;
        NSDictionary *delta = [choice[@"delta"] isKindOfClass:NSDictionary.class] ? choice[@"delta"] : nil;
        if (!delta) return;

        NSString *content = [delta[@"content"] isKindOfClass:NSString.class] ? delta[@"content"] : nil;
        if (content.length > 0) emitTextDelta(content);

        NSString *reasoningDelta = [delta[@"reasoning_content"] isKindOfClass:NSString.class] ? delta[@"reasoning_content"] : nil;
        if (reasoningDelta.length > 0) {
            [fullReasoningContent appendString:reasoningDelta];
        }

        NSArray *toolCalls = delta[@"tool_calls"];
        if ([toolCalls isKindOfClass:NSArray.class]) {
            for (NSDictionary *toolCall in toolCalls) {
                if (![toolCall isKindOfClass:NSDictionary.class]) continue;
                NSNumber *upstreamIndex = [toolCall[@"index"] respondsToSelector:@selector(integerValue)] ? toolCall[@"index"] : @0;
                NSDictionary *function = [toolCall[@"function"] isKindOfClass:NSDictionary.class] ? toolCall[@"function"] : nil;
                NSString *callId = TrimString(toolCall[@"id"]);
                NSString *name = TrimString(function[@"name"]);
                NSString *argumentsDelta = [function[@"arguments"] isKindOfClass:NSString.class] ? function[@"arguments"] : @"";
                NSMutableDictionary *state = ensureToolState(upstreamIndex, callId, name);
                if (callId.length > 0) state[@"callId"] = callId;
                if (name.length > 0) state[@"name"] = name;
                if (fullReasoningContent.length > 0) state[@"reasoning_content"] = [fullReasoningContent copy];
                if (argumentsDelta.length > 0) emitToolArgumentsDelta(upstreamIndex, callId, name, argumentsDelta);
            }
        }
    };

    void (^processAnthropicJSON)(NSDictionary *) = ^(NSDictionary *payload) {
        NSString *type = TrimString(payload[@"type"]);
        NSNumber *index = [payload[@"index"] respondsToSelector:@selector(integerValue)] ? payload[@"index"] : @0;
        if ([type isEqualToString:@"content_block_start"]) {
            NSDictionary *block = [payload[@"content_block"] isKindOfClass:NSDictionary.class] ? payload[@"content_block"] : nil;
            NSString *blockType = TrimString(block[@"type"]);
            if ([blockType isEqualToString:@"text"]) {
                ensureTextStarted();
                NSString *text = TrimString(block[@"text"]);
                if (text.length > 0) emitTextDelta(text);
            } else if ([blockType isEqualToString:@"tool_use"]) {
                NSString *callId = TrimString(block[@"id"]);
                NSString *name = TrimString(block[@"name"]);
                NSMutableDictionary *state = ensureToolState(index, callId, name);
                state[@"anthropicBlockType"] = @"tool_use";
                id input = block[@"input"];
                if ([input isKindOfClass:NSDictionary.class] && ((NSDictionary *)input).count > 0) {
                    NSString *inputText = JSONString(input);
                    emitToolArgumentsDelta(index, callId, name, inputText);
                }
                anthropicBlockStateByIndex[index] = state;
            }
            return;
        }

        if ([type isEqualToString:@"content_block_delta"]) {
            NSDictionary *delta = [payload[@"delta"] isKindOfClass:NSDictionary.class] ? payload[@"delta"] : nil;
            NSString *deltaType = TrimString(delta[@"type"]);
            if ([deltaType isEqualToString:@"text_delta"]) {
                emitTextDelta(delta[@"text"]);
            } else if ([deltaType isEqualToString:@"input_json_delta"]) {
                NSMutableDictionary *state = anthropicBlockStateByIndex[index] ?: ensureToolState(index, @"", @"");
                emitToolArgumentsDelta(index, state[@"callId"], state[@"name"], delta[@"partial_json"]);
            }
            return;
        }
    };

    void (^processSSELine)(NSString *) = ^(NSString *rawLine) {
        NSString *line = [rawLine stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
        if (![line hasPrefix:@"data:"]) return;
        NSString *jsonText = [[line substringFromIndex:5] aks_trimmed];
        if (jsonText.length == 0 || [jsonText isEqualToString:@"[DONE]"]) return;
        NSData *jsonData = [jsonText dataUsingEncoding:NSUTF8StringEncoding] ?: NSData.data;
        NSDictionary *payload = [NSJSONSerialization JSONObjectWithData:jsonData options:NSJSONReadingMutableContainers error:nil];
        if (![payload isKindOfClass:NSDictionary.class]) return;
        if ([apiFormat isEqualToString:APIFormatChatCompletions]) {
            processChatJSON(payload);
        } else if ([apiFormat isEqualToString:APIFormatAnthropicMessages]) {
            processAnthropicJSON(payload);
        }
    };

    void (^processDataChunk)(NSData *) = ^(NSData *data) {
        NSString *text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
        if (text.length == 0) return;
        [lineBuffer appendString:text];
        NSArray<NSString *> *lines = [lineBuffer componentsSeparatedByCharactersInSet:NSCharacterSet.newlineCharacterSet];
        [lineBuffer setString:lines.lastObject ?: @""];
        for (NSUInteger index = 0; index + 1 < lines.count; index++) {
            processSSELine(lines[index]);
        }
    };

    void (^finishAdaptedStream)(void) = ^{
        if (lineBuffer.length > 0) {
            processSSELine(lineBuffer);
            [lineBuffer setString:@""];
        }
        finishTextIfNeeded();
        finishToolStates();
        emitResponseStart();
        NSDictionary *completed = [self responseObjectWithId:responseId model:model outputItems:completedItems ?: @[]];
        emitEvent(@"response.completed", @{@"response": completed});
    };

    AKSStreamingBridge *bridge = [[AKSStreamingBridge alloc] init];
    bridge.onResponse = ^(NSHTTPURLResponse *response) {
        finalStatus = response.statusCode;
        if (finalStatus < 200 || finalStatus >= 300) {
            [self appendDebugLine:[NSString stringWithFormat:@"<-- ADAPTED_STREAM upstream status=%ld", (long)finalStatus]];
            return;
        }
        NSDictionary *headers = @{
            @"Content-Type": @"text/event-stream",
            @"Access-Control-Allow-Origin": @"http://127.0.0.1",
            @"X-AI-Key-Switcher-Provider": provider[@"name"] ?: @"",
            @"X-AI-Key-Switcher-Base-URL": provider[@"baseURL"] ?: @"",
            @"X-AI-Key-Switcher-API-Format": apiFormat ?: @"",
            @"X-AI-Key-Switcher-Model": model ?: @""
        };
        wroteResponseHeaders = [self writeChunkedHeadersStatus:200 headers:headers toClient:client];
        clientWritable = wroteResponseHeaders;
        if (wroteResponseHeaders) emitResponseStart();
    };
    bridge.onData = ^(NSData *data) {
        if (finalStatus < 200 || finalStatus >= 300) return;
        if (!clientWritable) return;
        processDataChunk(data);
    };
    bridge.onComplete = ^(NSError *error, NSData *capturedData) {
        finalError = error;
        [self recordResponseRoutesFromData:capturedData ?: NSData.data routeSignature:routeSignature];
        if (!wroteResponseHeaders) {
            NSString *bodyText = [[NSString alloc] initWithData:capturedData ?: NSData.data encoding:NSUTF8StringEncoding] ?: @"";
            if (bodyText.length > 500) bodyText = [[bodyText substringToIndex:500] stringByAppendingString:@"..."];
            [self writeJSON:@{@"error": error.localizedDescription ?: bodyText ?: @"Upstream stream failed",
                              @"provider": provider[@"name"] ?: @"",
                              @"baseURL": provider[@"baseURL"] ?: @"",
                              @"model": model ?: @""}
                     status:error ? 502 : (finalStatus > 0 ? finalStatus : 502)
                   toClient:client];
        } else if (clientWritable) {
            finishAdaptedStream();
            [self finishChunkedResponseToClient:client];
        }

        NSDictionary *usage = [self normalizedUsageFromData:capturedData ?: NSData.data];
        [_usageStore recordProvider:provider[@"name"]
                              model:model ?: ProviderSelectedCatalogModel(provider)
                             status:finalStatus > 0 ? finalStatus : (error ? 502 : 200)
                         durationMs:(CFAbsoluteTimeGetCurrent() - startedAt) * 1000.0
                              usage:usage
                             source:@"local_gateway_adapted_stream"];
        [self appendDebugLine:[NSString stringWithFormat:@"<-- ADAPTED_STREAM done provider=%@ status=%ld bytes=%lu error=%@",
                               provider[@"name"] ?: @"",
                               (long)(finalStatus > 0 ? finalStatus : (error ? 502 : 200)),
                               (unsigned long)(capturedData ?: NSData.data).length,
                               error.localizedDescription ?: @""]];
        dispatch_semaphore_signal(semaphore);
    };

    NSURLSessionConfiguration *configuration = NSURLSessionConfiguration.ephemeralSessionConfiguration;
    configuration.timeoutIntervalForRequest = UpstreamRequestTimeoutSeconds;
    configuration.timeoutIntervalForResource = UpstreamRequestTimeoutSeconds + 30;
    NSURLSession *session = [NSURLSession sessionWithConfiguration:configuration delegate:bridge delegateQueue:nil];
    task = [session dataTaskWithRequest:urlRequest];
    [task resume];

    long waitResult = dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW, (int64_t)((UpstreamRequestTimeoutSeconds + 35) * NSEC_PER_SEC)));
    if (waitResult != 0) {
        [task cancel];
        [session invalidateAndCancel];
        if (!wroteResponseHeaders) {
            [self writeJSON:@{@"error": @"Upstream stream timed out before completion",
                              @"provider": provider[@"name"] ?: @"",
                              @"baseURL": provider[@"baseURL"] ?: @"",
                              @"model": model ?: @""}
                     status:504
                   toClient:client];
        } else if (clientWritable) {
            finishAdaptedStream();
            [self finishChunkedResponseToClient:client];
        }
        [_usageStore recordProvider:provider[@"name"]
                              model:model ?: ProviderSelectedCatalogModel(provider)
                             status:504
                         durationMs:(CFAbsoluteTimeGetCurrent() - startedAt) * 1000.0
                              usage:@{}
                             source:@"local_gateway_adapted_stream"];
        return;
    }
    [session finishTasksAndInvalidate];
    (void)finalError;
    (void)originalPath;
}

- (void)forwardRequest:(NSDictionary *)request toClient:(int)client {
    NSDictionary *primaryProvider = [self providerForRequestBody:request[@"body"]];
    if (!primaryProvider) {
        [self writeJSON:@{@"error": @"No active provider"} status:503 toClient:client];
        return;
    }

    if (![NSUserDefaults.standardUserDefaults boolForKey:@"failoverEnabled"] &&
        [self canStreamNativeResponsesRequest:request provider:primaryProvider]) {
        [self streamNativeResponsesRequest:request provider:primaryProvider toClient:client];
        return;
    }

    if (![NSUserDefaults.standardUserDefaults boolForKey:@"failoverEnabled"] &&
        [self canStreamAdaptedResponsesRequest:request provider:primaryProvider]) {
        [self streamAdaptedResponsesRequest:request provider:primaryProvider toClient:client];
        return;
    }

    NSMutableArray<NSDictionary *> *candidates = [NSMutableArray arrayWithObject:primaryProvider];
    if ([NSUserDefaults.standardUserDefaults boolForKey:@"failoverEnabled"]) {
        for (NSDictionary *provider in _store.providers) {
            if (![provider[@"id"] isEqual:primaryProvider[@"id"]]) [candidates addObject:provider];
        }
    }

    NSDictionary *result = nil;
    NSDictionary *usedProvider = primaryProvider;
    for (NSDictionary *provider in candidates) {
        usedProvider = provider;
        result = [self upstreamResultForRequest:request provider:provider];
        NSDictionary *usage = [self normalizedUsageFromData:result[@"usageData"]];
        [_usageStore recordProvider:provider[@"name"]
                              model:result[@"model"] ?: ProviderSelectedCatalogModel(provider)
                             status:[result[@"status"] integerValue]
                         durationMs:[result[@"durationMs"] doubleValue]
                              usage:usage
                             source:@"local_gateway"];
        if (![result[@"retryable"] boolValue]) break;
        if (provider != candidates.lastObject) {
            [self appendDebugLine:[NSString stringWithFormat:@"<-- failover from provider=%@ status=%@", provider[@"name"] ?: @"", result[@"status"] ?: @0]];
        }
    }

    NSInteger status = [result[@"status"] integerValue];
    NSString *errorText = result[@"error"];
    if (errorText.length > 0) {
        [self writeJSON:@{@"error": errorText,
                          @"provider": usedProvider[@"name"] ?: @"",
                          @"baseURL": usedProvider[@"baseURL"] ?: @"",
                          @"model": result[@"model"] ?: ProviderSelectedCatalogModel(usedProvider)}
                   status:status > 0 ? status : 502
                 toClient:client];
        return;
    }

    [self writeData:result[@"data"] ?: NSData.data status:status headers:@{
        @"Content-Type": result[@"contentType"] ?: @"application/json",
        @"Access-Control-Allow-Origin": @"http://127.0.0.1",
        @"X-AI-Key-Switcher-Provider": usedProvider[@"name"] ?: @"",
        @"X-AI-Key-Switcher-Base-URL": usedProvider[@"baseURL"] ?: @"",
        @"X-AI-Key-Switcher-API-Format": result[@"apiFormat"] ?: ProviderAPIFormat(usedProvider),
        @"X-AI-Key-Switcher-Model": result[@"model"] ?: ProviderSelectedCatalogModel(usedProvider)
    } toClient:client];
}

- (NSString *)requestedModelFromBody:(NSData *)body {
    if (body.length == 0) return nil;
    NSDictionary *payload = [NSJSONSerialization JSONObjectWithData:body options:0 error:nil];
    if (![payload isKindOfClass:NSDictionary.class]) return nil;
    return TrimString(payload[@"model"]);
}

- (NSDictionary *)providerForRequestBody:(NSData *)body {
    NSString *requestedModel = [self requestedModelFromBody:body];
    NSDictionary *currentProvider = [_store currentProvider];
    if (!currentProvider) return nil;
    if (requestedModel.length > 0) {
        for (NSDictionary *model in ProviderModels(currentProvider)) {
            NSString *customName = ModelCustomName(model);
            NSString *upstreamModel = TrimString(model[@"model"]);
            NSString *catalogSlug = ProviderCatalogSlug(currentProvider, model);
            if ([requestedModel isEqualToString:catalogSlug] || [requestedModel isEqualToString:customName] || [requestedModel isEqualToString:upstreamModel]) {
                return currentProvider;
            }
        }
    }
    return currentProvider;
}

- (NSString *)upstreamPathForPath:(NSString *)path provider:(NSDictionary *)provider {
    if ([path isEqualToString:@"/responses"]) {
        NSString *apiFormat = ProviderAPIFormat(provider);
        if ([apiFormat isEqualToString:APIFormatChatCompletions]) {
            return [self openAICompatibleEndpointPath:@"/chat/completions" provider:provider];
        }
        if ([apiFormat isEqualToString:APIFormatAnthropicMessages]) {
            return [self versionedEndpointPath:@"/messages" provider:provider];
        }
        return [self versionedEndpointPath:@"/responses" provider:provider];
    }
    return path;
}

- (BOOL)baseURLHasPathPrefix:(NSString *)baseURL {
    NSURL *url = [NSURL URLWithString:baseURL ?: @""];
    NSString *path = [url.path stringByTrimmingCharactersInSet:[NSCharacterSet characterSetWithCharactersInString:@"/"]];
    return path.length > 0;
}

- (NSString *)versionedEndpointPath:(NSString *)endpoint provider:(NSDictionary *)provider {
    NSString *baseURL = provider[@"baseURL"] ?: @"";
    if ([self baseURLHasPathPrefix:baseURL]) return endpoint;
    return [@"/v1" stringByAppendingString:endpoint ?: @""];
}

- (NSString *)openAICompatibleEndpointPath:(NSString *)endpoint provider:(NSDictionary *)provider {
    NSString *baseURL = provider[@"baseURL"] ?: @"";
    if ([self baseURLHasPathPrefix:baseURL]) return endpoint;
    return [@"/v1" stringByAppendingString:endpoint ?: @""];
}

- (NSString *)debugLogPath {
    return AppSupportPath(@"proxy-debug.log");
}

- (void)appendDebugLine:(NSString *)line {
    NSString *path = [self debugLogPath];
    NSString *entry = [NSString stringWithFormat:@"%@ %@\n", NSDate.date, line ?: @""];
    NSData *data = [entry dataUsingEncoding:NSUTF8StringEncoding] ?: NSData.data;
    NSFileManager *fileManager = NSFileManager.defaultManager;
    if (![fileManager fileExistsAtPath:path]) {
        [data writeToFile:path atomically:YES];
        [fileManager setAttributes:@{NSFilePosixPermissions: @0600} ofItemAtPath:path error:nil];
        return;
    }
    NSDictionary *attributes = [fileManager attributesOfItemAtPath:path error:nil];
    if ([attributes fileSize] > MaxDebugLogBytes) {
        NSString *rotatedPath = [path stringByAppendingString:@".1"];
        [fileManager removeItemAtPath:rotatedPath error:nil];
        [fileManager moveItemAtPath:path toPath:rotatedPath error:nil];
        [fileManager setAttributes:@{NSFilePosixPermissions: @0600} ofItemAtPath:rotatedPath error:nil];
        [data writeToFile:path atomically:YES];
        [fileManager setAttributes:@{NSFilePosixPermissions: @0600} ofItemAtPath:path error:nil];
        return;
    }
    NSFileHandle *handle = [NSFileHandle fileHandleForWritingAtPath:path];
    [handle seekToEndOfFile];
    [handle writeData:data];
    [handle closeFile];
    [fileManager setAttributes:@{NSFilePosixPermissions: @0600} ofItemAtPath:path error:nil];
}

- (BOOL)requestBodyWantsStream:(NSData *)body {
    if (body.length == 0) return NO;
    NSDictionary *payload = [NSJSONSerialization JSONObjectWithData:body options:0 error:nil];
    if (![payload isKindOfClass:NSDictionary.class]) return NO;
    id stream = payload[@"stream"];
    return [stream respondsToSelector:@selector(boolValue)] ? [stream boolValue] : NO;
}

- (NSString *)responsesSSEEvent:(NSString *)type payload:(NSDictionary *)payload {
    NSMutableDictionary *eventPayload = [payload mutableCopy];
    eventPayload[@"type"] = type;
    return [NSString stringWithFormat:@"event: %@\ndata: %@\n\n", type, JSONString(eventPayload)];
}

- (NSDictionary *)responseObjectWithId:(NSString *)responseId model:(NSString *)model status:(NSString *)status text:(NSString *)text itemId:(NSString *)itemId {
    NSString *safeResponseId = responseId.length > 0 ? responseId : [@"resp_" stringByAppendingString:NSUUID.UUID.UUIDString];
    NSMutableDictionary *response = [@{
        @"id": safeResponseId,
        @"object": @"response",
        @"created_at": @((long long)NSDate.date.timeIntervalSince1970),
        @"status": status ?: @"completed",
        @"model": model ?: @"",
        @"output": @[]
    } mutableCopy];
    if (text.length > 0) {
        response[@"output"] = @[@{
            @"id": itemId ?: [@"msg_" stringByAppendingString:NSUUID.UUID.UUIDString],
            @"type": @"message",
            @"status": @"completed",
            @"role": @"assistant",
            @"content": @[@{@"type": @"output_text", @"text": text, @"annotations": @[]}]
        }];
    }
    return response;
}

- (NSDictionary *)responseObjectWithId:(NSString *)responseId model:(NSString *)model outputItems:(NSArray *)outputItems {
    return @{
        @"id": responseId ?: [@"resp_" stringByAppendingString:NSUUID.UUID.UUIDString],
        @"object": @"response",
        @"created_at": @((long long)NSDate.date.timeIntervalSince1970),
        @"status": @"completed",
        @"model": model ?: @"",
        @"output": outputItems ?: @[]
    };
}

- (NSString *)outputTextFromResponseOutputItem:(NSDictionary *)item {
    if (![item isKindOfClass:NSDictionary.class]) return @"";
    NSArray *content = item[@"content"];
    if (![content isKindOfClass:NSArray.class]) return [self textFromResponsesContent:item[@"text"] ?: item[@"output_text"]];

    NSMutableString *text = [NSMutableString string];
    for (NSDictionary *part in content) {
        if (![part isKindOfClass:NSDictionary.class]) continue;
        NSString *partText = [self textFromResponsesContent:part[@"text"] ?: part[@"output_text"] ?: part[@"content"]];
        if (partText.length > 0) [text appendString:partText];
    }
    return text;
}

- (NSDictionary *)messageItemForStreamAddedFromItem:(NSDictionary *)item itemId:(NSString *)itemId {
    return @{
        @"id": itemId ?: [@"msg_" stringByAppendingString:NSUUID.UUID.UUIDString],
        @"type": @"message",
        @"status": @"in_progress",
        @"role": item[@"role"] ?: @"assistant",
        @"content": @[]
    };
}

- (NSDictionary *)messageItemForStreamDoneFromItem:(NSDictionary *)item itemId:(NSString *)itemId text:(NSString *)text {
    return @{
        @"id": itemId ?: [@"msg_" stringByAppendingString:NSUUID.UUID.UUIDString],
        @"type": @"message",
        @"status": @"completed",
        @"role": item[@"role"] ?: @"assistant",
        @"content": @[@{@"type": @"output_text", @"text": text ?: @"", @"annotations": @[]}]
    };
}

- (NSString *)textFromResponsesContent:(id)content {
    if ([content isKindOfClass:NSString.class]) return content;
    if ([content isKindOfClass:NSArray.class]) {
        NSMutableString *text = [NSMutableString string];
        for (id part in (NSArray *)content) {
            if ([part isKindOfClass:NSString.class]) {
                [text appendString:part];
            } else if ([part isKindOfClass:NSDictionary.class]) {
                NSString *partText = [self textFromResponsesContent:part[@"text"] ?: part[@"content"] ?: part[@"input_text"] ?: part[@"output_text"]];
                if (partText.length > 0) [text appendString:partText];
            }
        }
        return text;
    }
    if ([content isKindOfClass:NSDictionary.class]) {
        NSDictionary *dict = (NSDictionary *)content;
        return [self textFromResponsesContent:dict[@"text"] ?: dict[@"content"] ?: dict[@"input_text"] ?: dict[@"output_text"]];
    }
    return @"";
}

- (NSData *)responsesSSEFromOutputItems:(NSArray *)items model:(NSString *)model {
    NSString *responseId = [@"resp_" stringByAppendingString:NSUUID.UUID.UUIDString];
    NSMutableString *output = [NSMutableString string];
    [output appendString:[self responsesSSEEvent:@"response.created" payload:@{@"response": [self responseObjectWithId:responseId model:model status:@"in_progress" text:@"" itemId:nil]}]];
    [output appendString:[self responsesSSEEvent:@"response.in_progress" payload:@{@"response": [self responseObjectWithId:responseId model:model status:@"in_progress" text:@"" itemId:nil]}]];

    for (NSUInteger index = 0; index < items.count; index++) {
        NSDictionary *item = items[index];
        if (![item isKindOfClass:NSDictionary.class]) continue;
        NSString *itemId = TrimString(item[@"id"]);
        if (itemId.length == 0) itemId = [@"item_" stringByAppendingString:NSUUID.UUID.UUIDString];

        if ([item[@"type"] isEqualToString:@"message"]) {
            NSString *text = [self outputTextFromResponseOutputItem:item];
            [output appendString:[self responsesSSEEvent:@"response.output_item.added" payload:@{@"output_index": @(index), @"item": [self messageItemForStreamAddedFromItem:item itemId:itemId]}]];
            [output appendString:[self responsesSSEEvent:@"response.content_part.added" payload:@{@"item_id": itemId, @"output_index": @(index), @"content_index": @0, @"part": @{@"type": @"output_text", @"text": @"", @"annotations": @[]}}]];
            if (text.length > 0) {
                [output appendString:[self responsesSSEEvent:@"response.output_text.delta" payload:@{@"item_id": itemId, @"output_index": @(index), @"content_index": @0, @"delta": text}]];
            }
            [output appendString:[self responsesSSEEvent:@"response.output_text.done" payload:@{@"item_id": itemId, @"output_index": @(index), @"content_index": @0, @"text": text ?: @""}]];
            [output appendString:[self responsesSSEEvent:@"response.content_part.done" payload:@{@"item_id": itemId, @"output_index": @(index), @"content_index": @0, @"part": @{@"type": @"output_text", @"text": text ?: @"", @"annotations": @[]}}]];
            [output appendString:[self responsesSSEEvent:@"response.output_item.done" payload:@{@"output_index": @(index), @"item": [self messageItemForStreamDoneFromItem:item itemId:itemId text:text]}]];
            continue;
        }

        if ([item[@"type"] isEqualToString:@"function_call"]) {
            NSString *arguments = TrimString(item[@"arguments"]);
            NSMutableDictionary *addedItem = [item mutableCopy];
            addedItem[@"id"] = itemId;
            addedItem[@"arguments"] = @"";
            [output appendString:[self responsesSSEEvent:@"response.output_item.added" payload:@{@"output_index": @(index), @"item": addedItem}]];
            if (arguments.length > 0) {
                [output appendString:[self responsesSSEEvent:@"response.function_call_arguments.delta" payload:@{@"item_id": itemId, @"output_index": @(index), @"delta": arguments}]];
            }
            [output appendString:[self responsesSSEEvent:@"response.function_call_arguments.done" payload:@{@"item_id": itemId, @"name": item[@"name"] ?: @"", @"output_index": @(index), @"arguments": arguments.length > 0 ? arguments : @"{}"}]];
            NSMutableDictionary *doneItem = [item mutableCopy];
            doneItem[@"id"] = itemId;
            doneItem[@"arguments"] = arguments.length > 0 ? arguments : @"{}";
            [output appendString:[self responsesSSEEvent:@"response.output_item.done" payload:@{@"output_index": @(index), @"item": doneItem}]];
            continue;
        }

        if ([item[@"type"] isEqualToString:@"custom_tool_call"]) {
            NSString *input = TrimString(item[@"input"]);
            NSMutableDictionary *addedItem = [item mutableCopy];
            addedItem[@"id"] = itemId;
            addedItem[@"input"] = @"";
            [output appendString:[self responsesSSEEvent:@"response.output_item.added" payload:@{@"output_index": @(index), @"item": addedItem}]];
            if (input.length > 0) {
                [output appendString:[self responsesSSEEvent:@"response.custom_tool_call_input.delta" payload:@{@"item_id": itemId, @"output_index": @(index), @"delta": input}]];
            }
            [output appendString:[self responsesSSEEvent:@"response.custom_tool_call_input.done" payload:@{@"item_id": itemId, @"name": item[@"name"] ?: @"", @"output_index": @(index), @"input": input ?: @""}]];
            NSMutableDictionary *doneItem = [item mutableCopy];
            doneItem[@"id"] = itemId;
            doneItem[@"input"] = input ?: @"";
            [output appendString:[self responsesSSEEvent:@"response.output_item.done" payload:@{@"output_index": @(index), @"item": doneItem}]];
            continue;
        }

        NSMutableDictionary *fallbackItem = [item mutableCopy];
        fallbackItem[@"id"] = itemId;
        [output appendString:[self responsesSSEEvent:@"response.output_item.added" payload:@{@"output_index": @(index), @"item": fallbackItem}]];
        [output appendString:[self responsesSSEEvent:@"response.output_item.done" payload:@{@"output_index": @(index), @"item": fallbackItem}]];
    }

    NSDictionary *completed = [self responseObjectWithId:responseId model:model outputItems:items ?: @[]];
    [output appendString:[self responsesSSEEvent:@"response.completed" payload:@{@"response": completed}]];
    return [output dataUsingEncoding:NSUTF8StringEncoding] ?: NSData.data;
}

- (NSData *)responsesSSEFromText:(NSString *)text model:(NSString *)model {
    NSString *responseId = [@"resp_" stringByAppendingString:NSUUID.UUID.UUIDString];
    NSString *itemId = [@"msg_" stringByAppendingString:NSUUID.UUID.UUIDString];
    NSMutableString *output = [NSMutableString string];
    NSString *fullText = text ?: @"";

    [output appendString:[self responsesSSEEvent:@"response.created" payload:@{@"response": [self responseObjectWithId:responseId model:model status:@"in_progress" text:@"" itemId:itemId]}]];
    [output appendString:[self responsesSSEEvent:@"response.in_progress" payload:@{@"response": [self responseObjectWithId:responseId model:model status:@"in_progress" text:@"" itemId:itemId]}]];
    [output appendString:[self responsesSSEEvent:@"response.output_item.added" payload:@{@"output_index": @0, @"item": @{@"id": itemId, @"type": @"message", @"status": @"in_progress", @"role": @"assistant", @"content": @[]}}]];
    [output appendString:[self responsesSSEEvent:@"response.content_part.added" payload:@{@"item_id": itemId, @"output_index": @0, @"content_index": @0, @"part": @{@"type": @"output_text", @"text": @"", @"annotations": @[]}}]];
    if (fullText.length > 0) {
        [output appendString:[self responsesSSEEvent:@"response.output_text.delta" payload:@{@"item_id": itemId, @"output_index": @0, @"content_index": @0, @"delta": fullText}]];
    }
    [output appendString:[self responsesSSEEvent:@"response.output_text.done" payload:@{@"item_id": itemId, @"output_index": @0, @"content_index": @0, @"text": fullText}]];
    [output appendString:[self responsesSSEEvent:@"response.content_part.done" payload:@{@"item_id": itemId, @"output_index": @0, @"content_index": @0, @"part": @{@"type": @"output_text", @"text": fullText, @"annotations": @[]}}]];
    [output appendString:[self responsesSSEEvent:@"response.output_item.done" payload:@{@"output_index": @0, @"item": @{@"id": itemId, @"type": @"message", @"status": @"completed", @"role": @"assistant", @"content": @[@{@"type": @"output_text", @"text": fullText, @"annotations": @[]}]}}]];
    [output appendString:[self responsesSSEEvent:@"response.completed" payload:@{@"response": [self responseObjectWithId:responseId model:model status:@"completed" text:fullText itemId:itemId]}]];
    return [output dataUsingEncoding:NSUTF8StringEncoding] ?: NSData.data;
}

- (NSArray *)normalizedOutputItemsFromNativeResponsesPayload:(NSDictionary *)payload model:(NSString *)model {
    NSArray *outputItems = payload[@"output"];
    if ([outputItems isKindOfClass:NSArray.class] && outputItems.count > 0) return outputItems;

    NSString *outputText = TrimString(payload[@"output_text"]);
    if (outputText.length > 0) {
        return @[@{
            @"id": [@"msg_" stringByAppendingString:NSUUID.UUID.UUIDString],
            @"type": @"message",
            @"status": @"completed",
            @"role": @"assistant",
            @"content": @[@{@"type": @"output_text", @"text": outputText, @"annotations": @[]}]
        }];
    }
    return @[];
}

- (NSData *)responsesSSEFromNativeResponsesData:(NSData *)data model:(NSString *)model {
    NSDictionary *payload = [NSJSONSerialization JSONObjectWithData:data ?: NSData.data options:0 error:nil];
    if (![payload isKindOfClass:NSDictionary.class]) {
        NSString *text = [[NSString alloc] initWithData:data ?: NSData.data encoding:NSUTF8StringEncoding] ?: @"";
        return [self responsesSSEFromText:text model:model];
    }

    NSArray *items = [self normalizedOutputItemsFromNativeResponsesPayload:payload model:model];
    if (items.count > 0) return [self responsesSSEFromOutputItems:items model:model ?: payload[@"model"]];

    NSDictionary *error = payload[@"error"];
    if ([error isKindOfClass:NSDictionary.class]) {
        NSString *message = TrimString(error[@"message"]);
        if (message.length > 0) return [self responsesSSEFromText:message model:model ?: payload[@"model"]];
    }
    return [self responsesSSEFromText:@"" model:model ?: payload[@"model"]];
}

- (NSData *)responsesDataFromNativeResponsesData:(NSData *)data model:(NSString *)model contentType:(NSString *)contentType forceStream:(BOOL)forceStream {
    if (forceStream && [contentType.lowercaseString rangeOfString:@"text/event-stream"].location == NSNotFound) {
        return [self responsesSSEFromNativeResponsesData:data model:model];
    }
    return data ?: NSData.data;
}

- (NSString *)selectedUpstreamModelForProvider:(NSDictionary *)provider {
    NSDictionary *selectedModel = ProviderSelectedModel(provider);
    NSString *upstreamModel = TrimString(selectedModel[@"model"]);
    if (upstreamModel.length > 0) return upstreamModel;
    NSString *selected = TrimString(provider[@"model"]);
    return selected.length > 0 ? selected : ProviderSelectedCatalogModel(provider);
}

- (NSString *)routeSignatureForProvider:(NSDictionary *)provider upstreamModel:(NSString *)upstreamModel {
    NSString *providerId = TrimString(provider[@"id"]);
    NSString *apiFormat = ProviderAPIFormat(provider);
    NSString *model = TrimString(upstreamModel);
    if (model.length == 0) model = [self selectedUpstreamModelForProvider:provider];
    return [NSString stringWithFormat:@"%@|%@|%@", providerId ?: @"", apiFormat ?: @"", model ?: @""];
}

- (BOOL)shouldDropPreviousResponseId:(NSString *)responseId routeSignature:(NSString *)routeSignature {
    NSString *safeResponseId = TrimString(responseId);
    NSString *safeRouteSignature = TrimString(routeSignature);
    if (safeResponseId.length == 0 || safeRouteSignature.length == 0) return NO;

    @synchronized (_routeSignatureByResponseId) {
        NSString *previousRouteSignature = _routeSignatureByResponseId[safeResponseId];
        if (previousRouteSignature.length == 0) return YES;
        return ![previousRouteSignature isEqualToString:safeRouteSignature];
    }
}

- (void)collectResponseIdsFromJSONObject:(id)object into:(NSMutableSet<NSString *> *)responseIds {
    if ([object isKindOfClass:NSArray.class]) {
        for (id item in (NSArray *)object) {
            [self collectResponseIdsFromJSONObject:item into:responseIds];
        }
        return;
    }

    if (![object isKindOfClass:NSDictionary.class]) return;

    NSDictionary *dictionary = (NSDictionary *)object;
    NSDictionary *response = [dictionary[@"response"] isKindOfClass:NSDictionary.class] ? dictionary[@"response"] : nil;
    if (response) {
        [self collectResponseIdsFromJSONObject:response into:responseIds];
    }

    NSString *responseId = TrimString(dictionary[@"id"]);
    NSString *objectType = TrimString(dictionary[@"object"]);
    if (responseId.length > 0 && ([objectType isEqualToString:@"response"] || dictionary[@"output"])) {
        [responseIds addObject:responseId];
    }
}

- (void)recordResponseRoutesFromData:(NSData *)data routeSignature:(NSString *)routeSignature {
    NSString *safeRouteSignature = TrimString(routeSignature);
    if (data.length == 0 || safeRouteSignature.length == 0) return;

    NSMutableSet<NSString *> *responseIds = [NSMutableSet set];
    id json = [self jsonObjectFromData:data];
    if (json) {
        [self collectResponseIdsFromJSONObject:json into:responseIds];
    } else {
        NSString *text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"";
        NSArray<NSString *> *lines = [text componentsSeparatedByCharactersInSet:NSCharacterSet.newlineCharacterSet];
        for (NSString *line in lines) {
            if (![line hasPrefix:@"data: "]) continue;
            NSString *jsonText = [[line substringFromIndex:6] aks_trimmed];
            if (jsonText.length == 0 || [jsonText isEqualToString:@"[DONE]"]) continue;
            NSData *lineData = [jsonText dataUsingEncoding:NSUTF8StringEncoding];
            id eventJSON = [self jsonObjectFromData:lineData];
            [self collectResponseIdsFromJSONObject:eventJSON into:responseIds];
        }
    }

    if (responseIds.count == 0) return;
    @synchronized (_routeSignatureByResponseId) {
        for (NSString *responseId in responseIds) {
            _routeSignatureByResponseId[responseId] = safeRouteSignature;
        }
        if (_routeSignatureByResponseId.count > 500) {
            [_routeSignatureByResponseId removeAllObjects];
        }
    }
}

- (void)rememberResponseId:(NSString *)responseId routeSignature:(NSString *)routeSignature {
    NSString *safeResponseId = TrimString(responseId);
    NSString *safeRouteSignature = TrimString(routeSignature);
    if (safeResponseId.length == 0 || safeRouteSignature.length == 0) return;

    @synchronized (_routeSignatureByResponseId) {
        _routeSignatureByResponseId[safeResponseId] = safeRouteSignature;
        if (_routeSignatureByResponseId.count > 500) {
            [_routeSignatureByResponseId removeAllObjects];
        }
    }
}

- (void)removeUnsupportedCodexMetadataFromJSONObject:(id)object {
    if ([object isKindOfClass:NSMutableArray.class]) {
        for (id item in (NSMutableArray *)object) {
            [self removeUnsupportedCodexMetadataFromJSONObject:item];
        }
        return;
    }

    if (![object isKindOfClass:NSMutableDictionary.class]) return;

    NSMutableDictionary *dictionary = (NSMutableDictionary *)object;
    [dictionary removeObjectForKey:@"namespace"];

    for (id value in dictionary.allValues) {
        [self removeUnsupportedCodexMetadataFromJSONObject:value];
    }
}

- (BOOL)responsesItemPayloadValueHasContent:(id)value {
    if ([value isKindOfClass:NSString.class]) return ((NSString *)value).length > 0;
    if ([value isKindOfClass:NSArray.class]) return ((NSArray *)value).count > 0;
    if ([value isKindOfClass:NSDictionary.class]) return ((NSDictionary *)value).count > 0;
    return value != nil && value != NSNull.null;
}

- (BOOL)responsesReasoningItemHasReplayableContent:(NSDictionary *)item {
    return [self responsesItemPayloadValueHasContent:item[@"summary"]] ||
           [self responsesItemPayloadValueHasContent:item[@"content"]] ||
           [self responsesItemPayloadValueHasContent:item[@"encrypted_content"]];
}

- (NSString *)responsesFunctionCallItemIdFromId:(NSString *)itemId {
    NSString *safeItemId = TrimString(itemId);
    if ([safeItemId hasPrefix:@"fc_"] || [safeItemId hasPrefix:@"fc-"]) return safeItemId;
    return [@"fc_" stringByAppendingString:NSUUID.UUID.UUIDString];
}

- (void)makeResponsesInputPortableAfterRouteChangeInPayload:(NSMutableDictionary *)payload {
    id input = payload[@"input"];
    if (![input isKindOfClass:NSMutableArray.class]) return;

    NSMutableArray *portableInput = [NSMutableArray array];
    NSUInteger droppedReasoningItems = 0;
    NSUInteger rewrittenFunctionCallIds = 0;
    NSUInteger removedItemIds = 0;

    for (id rawItem in (NSArray *)input) {
        if (![rawItem isKindOfClass:NSMutableDictionary.class]) {
            [portableInput addObject:rawItem];
            continue;
        }

        NSMutableDictionary *item = (NSMutableDictionary *)rawItem;
        NSString *type = TrimString(item[@"type"]);

        [item removeObjectForKey:@"encrypted_content"];
        [item removeObjectForKey:@"reasoning_content"];

        if ([type isEqualToString:@"reasoning"]) {
            droppedReasoningItems++;
            continue;
        }

        if ([type isEqualToString:@"function_call"]) {
            NSString *previousItemId = TrimString(item[@"id"]);
            NSString *nextItemId = [self responsesFunctionCallItemIdFromId:previousItemId];
            if (![previousItemId isEqualToString:nextItemId]) rewrittenFunctionCallIds++;
            item[@"id"] = nextItemId;
        } else if ([type isEqualToString:@"function_call_output"]) {
            NSString *callId = TrimString(item[@"call_id"] ?: item[@"tool_call_id"]);
            if (callId.length == 0) {
                NSString *legacyId = TrimString(item[@"id"]);
                if (legacyId.length > 0) item[@"call_id"] = legacyId;
            }
            if (item[@"id"]) {
                [item removeObjectForKey:@"id"];
                removedItemIds++;
            }
        } else if (item[@"id"]) {
            [item removeObjectForKey:@"id"];
            removedItemIds++;
        }

        [portableInput addObject:item];
    }

    payload[@"input"] = portableInput;
    if (droppedReasoningItems > 0 || rewrittenFunctionCallIds > 0 || removedItemIds > 0) {
        [self appendDebugLine:[NSString stringWithFormat:@"-- portable replay sanitized input droppedReasoning=%lu rewrittenFunctionCallIds=%lu removedItemIds=%lu",
                               (unsigned long)droppedReasoningItems,
                               (unsigned long)rewrittenFunctionCallIds,
                               (unsigned long)removedItemIds]];
    }
}

- (BOOL)normalizeResponsesInputItemForUpstream:(NSMutableDictionary *)item {
    if (![item isKindOfClass:NSMutableDictionary.class]) return YES;

    NSString *type = TrimString(item[@"type"]);
    id content = item[@"content"];

    if ([type isEqualToString:@"reasoning"]) {
        return [self responsesReasoningItemHasReplayableContent:item];
    }

    if ([type isEqualToString:@"function_call_output"]) {
        if (TrimString(item[@"output"]).length == 0) {
            NSString *output = [self textFromResponsesContent:content];
            if (output.length > 0) item[@"output"] = output;
        }
        [item removeObjectForKey:@"content"];
        return YES;
    }

    if (type.length > 0 && ![type isEqualToString:@"message"]) {
        if ([content isKindOfClass:NSArray.class] && ((NSArray *)content).count > 0) {
            item[@"content"] = @[];
        }
        return YES;
    }

    if (![content isKindOfClass:NSMutableArray.class]) return YES;

    NSMutableArray *normalizedContent = [NSMutableArray array];
    for (id part in (NSArray *)content) {
        if ([part isKindOfClass:NSString.class]) {
            if (((NSString *)part).length > 0) [normalizedContent addObject:part];
            continue;
        }

        if (![part isKindOfClass:NSMutableDictionary.class]) continue;
        NSMutableDictionary *partDictionary = (NSMutableDictionary *)part;
        NSString *partType = TrimString(partDictionary[@"type"]);
        NSString *partText = TrimString(partDictionary[@"text"] ?: partDictionary[@"input_text"] ?: partDictionary[@"output_text"]);
        BOOL hasStructuredPayload = partDictionary[@"image_url"] || partDictionary[@"file_id"] || partDictionary[@"file_data"];
        BOOL isKnownTextPart = [partType isEqualToString:@"input_text"] || [partType isEqualToString:@"output_text"] || [partType isEqualToString:@"refusal"] || partType.length == 0;
        BOOL isKnownMediaPart = [partType isEqualToString:@"input_image"] || [partType isEqualToString:@"input_file"];
        if ((isKnownTextPart && partText.length > 0) || (isKnownMediaPart && hasStructuredPayload)) {
            [normalizedContent addObject:partDictionary];
        }
    }

    item[@"content"] = normalizedContent;
    return YES;
}

- (void)normalizeResponsesInputForUpstreamInPayload:(NSMutableDictionary *)payload {
    id input = payload[@"input"];
    if (![input isKindOfClass:NSMutableArray.class]) return;

    NSMutableArray *normalizedInput = [NSMutableArray array];
    for (id item in (NSArray *)input) {
        if (![item isKindOfClass:NSMutableDictionary.class]) {
            [normalizedInput addObject:item];
            continue;
        }

        NSMutableDictionary *itemDictionary = (NSMutableDictionary *)item;
        if (![self normalizeResponsesInputItemForUpstream:itemDictionary]) {
            continue;
        }
        NSString *type = TrimString(itemDictionary[@"type"]);
        NSString *role = TrimString(itemDictionary[@"role"]);
        NSArray *content = [itemDictionary[@"content"] isKindOfClass:NSArray.class] ? itemDictionary[@"content"] : nil;
        if ([type isEqualToString:@"message"] && content.count == 0 && ![role isEqualToString:@"assistant"]) {
            continue;
        }
        [normalizedInput addObject:itemDictionary];
    }
    payload[@"input"] = normalizedInput;
}

- (NSData *)requestBodyByApplyingActiveModel:(NSData *)body provider:(NSDictionary *)provider {
    if (body.length == 0) return body;

    id json = [NSJSONSerialization JSONObjectWithData:body options:NSJSONReadingMutableContainers error:nil];
    if (![json isKindOfClass:NSMutableDictionary.class]) return body;

    NSMutableDictionary *payload = (NSMutableDictionary *)json;
    NSString *codexRequestedModel = TrimString(payload[@"model"]);
    NSString *model = [self selectedUpstreamModelForProvider:provider];
    if (model.length == 0) model = codexRequestedModel;
    if (model.length == 0) return body;
    [self removeUnsupportedCodexMetadataFromJSONObject:payload];
    [self normalizeResponsesInputForUpstreamInPayload:payload];

    NSString *routeSignature = [self routeSignatureForProvider:provider upstreamModel:model];
    NSString *previousResponseId = TrimString(payload[@"previous_response_id"]);
    BOOL routeChanged = NO;
    if ([self shouldDropPreviousResponseId:previousResponseId routeSignature:routeSignature]) {
        [payload removeObjectForKey:@"previous_response_id"];
        routeChanged = YES;
        [self appendDebugLine:[NSString stringWithFormat:@"-- dropped previous_response_id=%@ for provider=%@ upstreamModel=%@",
                               previousResponseId ?: @"",
                               provider[@"name"] ?: @"",
                               model ?: @""]];
    }

    payload[@"model"] = model;
    if (codexRequestedModel.length > 0 && ![codexRequestedModel isEqualToString:model]) {
        [payload removeObjectForKey:@"previous_response_id"];
        routeChanged = YES;
    }
    if (routeChanged) {
        [self makeResponsesInputPortableAfterRouteChangeInPayload:payload];
    }
    return [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil] ?: body;
}

- (NSData *)requestBodyByForcingStream:(BOOL)stream body:(NSData *)body {
    if (body.length == 0) return body;
    id json = [NSJSONSerialization JSONObjectWithData:body options:NSJSONReadingMutableContainers error:nil];
    if (![json isKindOfClass:NSMutableDictionary.class]) return body;
    NSMutableDictionary *payload = (NSMutableDictionary *)json;
    payload[@"stream"] = @(stream);
    return [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil] ?: body;
}

- (void)writeJSON:(NSDictionary *)json status:(NSInteger)status toClient:(int)client {
    NSData *data = [NSJSONSerialization dataWithJSONObject:json options:0 error:nil] ?: NSData.data;
    [self writeData:data status:status headers:@{@"Content-Type": @"application/json", @"Access-Control-Allow-Origin": @"http://127.0.0.1"} toClient:client];
}

- (BOOL)sendAllData:(NSData *)data toClient:(int)client {
    const uint8_t *bytes = data.bytes;
    NSUInteger remaining = data.length;
    while (remaining > 0) {
        ssize_t sent = send(client, bytes, remaining, 0);
        if (sent <= 0) return NO;
        bytes += sent;
        remaining -= (NSUInteger)sent;
    }
    return YES;
}

- (BOOL)writeChunkedHeadersStatus:(NSInteger)status headers:(NSDictionary *)headers toClient:(int)client {
    NSString *reason = status == 400 ? @"Bad Request" : status == 401 ? @"Unauthorized" : status == 413 ? @"Payload Too Large" : status == 500 ? @"Internal Server Error" : status == 502 ? @"Bad Gateway" : status == 503 ? @"Service Unavailable" : status == 504 ? @"Gateway Timeout" : @"OK";
    NSMutableString *headerText = [NSMutableString stringWithFormat:@"HTTP/1.1 %ld %@\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n", (long)status, reason];
    for (NSString *key in headers) {
        NSString *lower = key.lowercaseString;
        if ([lower isEqualToString:@"content-length"] || [lower isEqualToString:@"transfer-encoding"] || [lower isEqualToString:@"connection"]) continue;
        [headerText appendFormat:@"%@: %@\r\n", key, headers[key]];
    }
    [headerText appendString:@"\r\n"];
    NSData *headerData = [headerText dataUsingEncoding:NSUTF8StringEncoding] ?: NSData.data;
    return [self sendAllData:headerData toClient:client];
}

- (BOOL)writeChunk:(NSData *)data toClient:(int)client {
    if (data.length == 0) return YES;
    NSString *prefix = [NSString stringWithFormat:@"%lx\r\n", (unsigned long)data.length];
    NSData *prefixData = [prefix dataUsingEncoding:NSUTF8StringEncoding] ?: NSData.data;
    NSData *suffixData = [@"\r\n" dataUsingEncoding:NSUTF8StringEncoding] ?: NSData.data;
    return [self sendAllData:prefixData toClient:client] &&
           [self sendAllData:data toClient:client] &&
           [self sendAllData:suffixData toClient:client];
}

- (BOOL)writeChunkString:(NSString *)text toClient:(int)client {
    NSData *data = [text dataUsingEncoding:NSUTF8StringEncoding] ?: NSData.data;
    return [self writeChunk:data toClient:client];
}

- (BOOL)finishChunkedResponseToClient:(int)client {
    NSData *endData = [@"0\r\n\r\n" dataUsingEncoding:NSUTF8StringEncoding] ?: NSData.data;
    return [self sendAllData:endData toClient:client];
}

- (void)writeData:(NSData *)data status:(NSInteger)status headers:(NSDictionary *)headers toClient:(int)client {
    NSString *reason = status == 204 ? @"No Content" : status == 400 ? @"Bad Request" : status == 401 ? @"Unauthorized" : status == 413 ? @"Payload Too Large" : status == 502 ? @"Bad Gateway" : status == 503 ? @"Service Unavailable" : status == 504 ? @"Gateway Timeout" : @"OK";
    NSMutableString *headerText = [NSMutableString stringWithFormat:@"HTTP/1.1 %ld %@\r\nContent-Length: %lu\r\nConnection: close\r\n", (long)status, reason, (unsigned long)data.length];
    for (NSString *key in headers) {
        [headerText appendFormat:@"%@: %@\r\n", key, headers[key]];
    }
    [headerText appendString:@"\r\n"];

    NSData *headerData = [headerText dataUsingEncoding:NSUTF8StringEncoding];
    if (![self sendAllData:headerData toClient:client]) return;
    if (data.length > 0) [self sendAllData:data toClient:client];
}
@end
