#import "ProviderPresets.h"

@implementation ProviderPresets
+ (NSArray<NSDictionary *> *)allPresets {
    return @[
        @{
            @"title": @"OpenAI",
            @"name": @"OpenAI 官方",
            @"baseURL": @"https://api.openai.com/v1",
            @"apiFormat": APIFormatResponses,
            @"tag": @"官方",
            @"models": @[
                @{@"customName": @"gpt-4.1", @"model": @"gpt-4.1"}
            ]
        },
        @{
            @"title": @"Qwen",
            @"name": @"千问 Qwen",
            @"baseURL": @"https://dashscope.aliyuncs.com/compatible-mode/v1",
            @"apiFormat": APIFormatChatCompletions,
            @"tag": @"国产",
            @"models": @[
                @{@"customName": @"qwen3-coder-plus", @"model": @"qwen3-coder-plus"},
                @{@"customName": @"qwen3-coder-flash", @"model": @"qwen3-coder-flash"}
            ]
        },
        @{
            @"title": @"Doubao",
            @"name": @"火山豆包",
            @"baseURL": @"https://ark.cn-beijing.volces.com/api/v3",
            @"apiFormat": APIFormatChatCompletions,
            @"tag": @"国产",
            @"models": @[
                @{@"customName": @"doubao-seed-2-0-pro", @"model": @"doubao-seed-2-0-pro-260215"},
                @{@"customName": @"doubao-seed-2-0-lite", @"model": @"doubao-seed-2-0-lite-260215"}
            ]
        },
        @{
            @"title": @"DeepSeek",
            @"name": @"DeepSeek",
            @"baseURL": @"https://api.deepseek.com",
            @"apiFormat": APIFormatChatCompletions,
            @"tag": @"国产",
            @"models": @[
                @{@"customName": @"deepseek-v4-flash", @"model": @"deepseek-v4-flash"},
                @{@"customName": @"deepseek-v4-pro", @"model": @"deepseek-v4-pro"}
            ]
        },
        @{
            @"title": @"MiniMax",
            @"name": @"MiniMax",
            @"baseURL": @"https://api.minimax.chat/v1",
            @"apiFormat": APIFormatResponses,
            @"tag": @"国产",
            @"models": @[
                @{@"customName": @"MiniMax-M2", @"model": @"MiniMax-M2"},
                @{@"customName": @"MiniMax-M1", @"model": @"MiniMax-M1"}
            ]
        },
        @{
            @"title": @"LongCat",
            @"name": @"美团 LongCat",
            @"baseURL": @"https://api.longcat.chat/openai/v1",
            @"apiFormat": APIFormatResponses,
            @"tag": @"国产",
            @"models": @[
                @{@"customName": @"LongCat-2.0", @"model": @"LongCat-2.0"}
            ]
        },
        @{
            @"title": @"自定义",
            @"name": @"自定义 Responses",
            @"baseURL": @"https://example.com/v1",
            @"apiFormat": APIFormatResponses,
            @"tag": @"自定义",
            @"models": @[
                @{@"customName": @"my-model", @"model": @"my-model"}
            ]
        }
    ];
}
@end
