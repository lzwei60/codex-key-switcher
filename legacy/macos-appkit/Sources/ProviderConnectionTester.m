#import "ProviderConnectionTester.h"

@implementation ProviderConnectionTester
+ (NSURL *)URLByAppendingPath:(NSString *)path toBaseURL:(NSString *)baseURL {
    NSString *trimmedBaseURL = [baseURL aks_trimTrailingSlashes];
    NSString *normalizedPath = [path hasPrefix:@"/"] ? path : [@"/" stringByAppendingString:path];
    return [NSURL URLWithString:[trimmedBaseURL stringByAppendingString:normalizedPath]];
}

+ (BOOL)baseURLHasPathPrefix:(NSString *)baseURL {
    NSURL *url = [NSURL URLWithString:baseURL ?: @""];
    NSString *path = [url.path stringByTrimmingCharactersInSet:[NSCharacterSet characterSetWithCharactersInString:@"/"]];
    return path.length > 0;
}

+ (NSURL *)URLByAppendingVersionedPath:(NSString *)path toBaseURL:(NSString *)baseURL {
    NSString *normalizedPath = [path hasPrefix:@"/"] ? path : [@"/" stringByAppendingString:path];
    if (![self baseURLHasPathPrefix:baseURL]) {
        normalizedPath = [@"/v1" stringByAppendingString:normalizedPath];
    }
    return [self URLByAppendingPath:normalizedPath toBaseURL:baseURL];
}

+ (NSURL *)URLByAppendingOpenAICompatiblePath:(NSString *)path toBaseURL:(NSString *)baseURL {
    NSString *normalizedPath = [path hasPrefix:@"/"] ? path : [@"/" stringByAppendingString:path];
    if (![self baseURLHasPathPrefix:baseURL]) {
        normalizedPath = [@"/v1" stringByAppendingString:normalizedPath];
    }
    return [self URLByAppendingPath:normalizedPath toBaseURL:baseURL];
}

+ (NSMutableURLRequest *)requestWithURL:(NSURL *)url apiKey:(NSString *)apiKey method:(NSString *)method apiFormat:(NSString *)apiFormat {
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:12];
    request.HTTPMethod = method;
    [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
    if ([ProviderAPIFormat(@{@"apiFormat": apiFormat ?: @""}) isEqualToString:APIFormatAnthropicMessages]) {
        [request setValue:apiKey forHTTPHeaderField:@"x-api-key"];
        [request setValue:@"2023-06-01" forHTTPHeaderField:@"anthropic-version"];
    } else {
        [request setValue:[NSString stringWithFormat:@"Bearer %@", apiKey] forHTTPHeaderField:@"Authorization"];
    }
    return request;
}

+ (NSString *)messageForStatus:(NSInteger)status body:(NSData *)body fallback:(NSString *)fallback {
    NSString *bodyText = body.length > 0 ? [[NSString alloc] initWithData:body encoding:NSUTF8StringEncoding] : nil;
    NSDictionary *payload = body.length > 0 ? [NSJSONSerialization JSONObjectWithData:body options:0 error:nil] : nil;
    NSString *serverMessage = nil;
    if ([payload isKindOfClass:NSDictionary.class]) {
        id error = payload[@"error"];
        if ([error isKindOfClass:NSDictionary.class]) {
            serverMessage = TrimString(error[@"message"] ?: error[@"code"] ?: error[@"type"]);
        } else if ([error isKindOfClass:NSString.class]) {
            serverMessage = TrimString(error);
        } else {
            serverMessage = TrimString(payload[@"message"]);
        }
    }
    if (serverMessage.length > 0) bodyText = serverMessage;
    if (bodyText.length > 260) {
        bodyText = [[bodyText substringToIndex:260] stringByAppendingString:@"..."];
    }
    NSString *reason = nil;
    if (status == 400) reason = @"请求格式不兼容，供应商可能不是原生 Responses 格式，或模型参数不支持。";
    else if (status == 401 || status == 403) reason = @"API Key 无效、权限不足，或账号未开通该模型。";
    else if (status == 404 || status == 405) reason = @"Base URL 或所选 API 端点不正确。";
    else if (status == 408 || status == 504) reason = @"连接超时，请检查网络、代理或供应商服务状态。";
    else if (status == 409 || status == 422) reason = @"模型名称或请求参数可能不被供应商接受。";
    else if (status == 429) reason = @"请求被限流，可能是余额、并发或速率限制。";
    else if (status >= 500) reason = @"供应商服务异常，可以稍后重试或启用故障转移。";

    if (reason.length > 0 && bodyText.length > 0) {
        return [NSString stringWithFormat:@"连接检测失败，HTTP %ld：%@\n服务返回：%@", (long)status, reason, bodyText];
    }
    if (reason.length > 0) {
        return [NSString stringWithFormat:@"连接检测失败，HTTP %ld：%@", (long)status, reason];
    }
    if (bodyText.length > 0) {
        return [NSString stringWithFormat:@"连接检测失败，HTTP %ld：%@", (long)status, bodyText];
    }
    return fallback;
}
+ (NSString *)messageForNetworkError:(NSError *)error {
    if (!error) return @"连接检测失败。";
    if ([error.domain isEqualToString:NSURLErrorDomain]) {
        if (error.code == NSURLErrorTimedOut) return @"连接检测超时：供应商响应过慢、网络不可达，或 Base URL 无法访问。";
        if (error.code == NSURLErrorCannotFindHost || error.code == NSURLErrorCannotConnectToHost) return @"无法连接到供应商：请检查 Base URL 域名、端口和网络代理。";
        if (error.code == NSURLErrorSecureConnectionFailed || error.code == NSURLErrorServerCertificateUntrusted) return @"HTTPS 证书校验失败：请检查供应商证书或 Base URL。";
        if (error.code == NSURLErrorNotConnectedToInternet || error.code == NSURLErrorNetworkConnectionLost) return @"网络连接不可用或中断，请检查本机网络。";
    }
    return [NSString stringWithFormat:@"连接检测失败：%@", error.localizedDescription ?: @"未知网络错误"];
}

+ (void)finish:(void (^)(BOOL ok, NSString *message))completion ok:(BOOL)ok message:(NSString *)message {
    dispatch_async(dispatch_get_main_queue(), ^{
        completion(ok, message);
    });
}

+ (void)testResponsesWithBaseURL:(NSString *)baseURL apiKey:(NSString *)apiKey model:(NSString *)model completion:(void (^)(BOOL ok, NSString *message))completion {
    NSURL *url = [self URLByAppendingVersionedPath:@"/responses" toBaseURL:baseURL];
    if (!url) {
        [self finish:completion ok:NO message:@"Base URL 无法组成有效的 responses 地址。"];
        return;
    }

    NSMutableURLRequest *request = [self requestWithURL:url apiKey:apiKey method:@"POST" apiFormat:APIFormatResponses];
    NSDictionary *payload = @{
        @"model": model ?: @"",
        @"input": @[
            @{
                @"role": @"user",
                @"content": @[
                    @{@"type": @"input_text", @"text": @"ping"}
                ]
            }
        ],
        @"max_output_tokens": @1,
        @"stream": @NO
    };
    request.HTTPBody = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];

    NSURLSessionDataTask *task = [NSURLSession.sharedSession dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        if (error) {
            [self finish:completion ok:NO message:[self messageForNetworkError:error]];
            return;
        }

        NSInteger status = [(NSHTTPURLResponse *)response statusCode];
        if (status <= 0) {
            [self finish:completion ok:NO message:@"连接检测失败：供应商没有返回有效 HTTP 状态码。"];
            return;
        }
        if (status >= 200 && status < 300) {
            [self finish:completion ok:YES message:@"Responses 连接检测通过。"];
            return;
        }

        if (status == 404 || status == 405) {
            [self finish:completion ok:NO message:@"未检测到可用的 /responses 端点，请填写原生 Responses API 的 Base URL。"];
            return;
        }

        [self finish:completion ok:NO message:[self messageForStatus:status body:data fallback:@"Responses 连接检测失败，请检查 API Key、Base URL 和模型名称。"]];
    }];
    [task resume];
}

+ (void)testBaseURL:(NSString *)baseURL apiKey:(NSString *)apiKey model:(NSString *)model apiFormat:(NSString *)apiFormat completion:(void (^)(BOOL ok, NSString *message))completion {
    NSString *format = ProviderAPIFormat(@{@"apiFormat": apiFormat ?: @""});
    if ([format isEqualToString:APIFormatChatCompletions]) {
        [self testChatCompletionsWithBaseURL:baseURL apiKey:apiKey model:model completion:completion];
        return;
    }
    if ([format isEqualToString:APIFormatAnthropicMessages]) {
        [self testAnthropicMessagesWithBaseURL:baseURL apiKey:apiKey model:model completion:completion];
        return;
    }
    [self testResponsesWithBaseURL:baseURL apiKey:apiKey model:model completion:completion];
}

+ (void)testChatCompletionsWithBaseURL:(NSString *)baseURL apiKey:(NSString *)apiKey model:(NSString *)model completion:(void (^)(BOOL ok, NSString *message))completion {
    NSURL *url = [self URLByAppendingOpenAICompatiblePath:@"/chat/completions" toBaseURL:baseURL];
    if (!url) {
        [self finish:completion ok:NO message:@"Base URL 无法组成有效的 /chat/completions 地址。"];
        return;
    }

    NSMutableURLRequest *request = [self requestWithURL:url apiKey:apiKey method:@"POST" apiFormat:APIFormatChatCompletions];
    NSDictionary *payload = @{
        @"model": model ?: @"",
        @"messages": @[@{@"role": @"user", @"content": @"ping"}],
        @"max_tokens": @1,
        @"stream": @NO
    };
    request.HTTPBody = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];

    NSURLSessionDataTask *task = [NSURLSession.sharedSession dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        if (error) {
            [self finish:completion ok:NO message:[self messageForNetworkError:error]];
            return;
        }

        NSInteger status = [(NSHTTPURLResponse *)response statusCode];
        if (status >= 200 && status < 300) {
            [self finish:completion ok:YES message:@"Chat Completions 连接检测通过。"];
            return;
        }
        if (status == 404 || status == 405) {
            [self finish:completion ok:NO message:@"未检测到可用的 /chat/completions 端点，请检查 Base URL 是否已包含供应商的版本路径。"];
            return;
        }
        [self finish:completion ok:NO message:[self messageForStatus:status body:data fallback:@"Chat Completions 连接检测失败，请检查 API Key、Base URL 和模型名称。"]];
    }];
    [task resume];
}

+ (void)testAnthropicMessagesWithBaseURL:(NSString *)baseURL apiKey:(NSString *)apiKey model:(NSString *)model completion:(void (^)(BOOL ok, NSString *message))completion {
    NSURL *url = [self URLByAppendingVersionedPath:@"/messages" toBaseURL:baseURL];
    if (!url) {
        [self finish:completion ok:NO message:@"Base URL 无法组成有效的 /v1/messages 地址。"];
        return;
    }

    NSMutableURLRequest *request = [self requestWithURL:url apiKey:apiKey method:@"POST" apiFormat:APIFormatAnthropicMessages];
    NSDictionary *payload = @{
        @"model": model ?: @"",
        @"max_tokens": @1,
        @"messages": @[@{@"role": @"user", @"content": @"ping"}]
    };
    request.HTTPBody = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];

    NSURLSessionDataTask *task = [NSURLSession.sharedSession dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        if (error) {
            [self finish:completion ok:NO message:[self messageForNetworkError:error]];
            return;
        }

        NSInteger status = [(NSHTTPURLResponse *)response statusCode];
        if (status >= 200 && status < 300) {
            [self finish:completion ok:YES message:@"Anthropic Messages 连接检测通过。"];
            return;
        }
        if (status == 404 || status == 405) {
            [self finish:completion ok:NO message:@"未检测到可用的 /v1/messages 端点，请检查 Base URL。"];
            return;
        }
        [self finish:completion ok:NO message:[self messageForStatus:status body:data fallback:@"Anthropic Messages 连接检测失败，请检查 API Key、Base URL 和模型名称。"]];
    }];
    [task resume];
}
@end
