# Codex Key Switcher 发布检查清单

英文版：[RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md)

## 应用防护

- 首次运行引导需要说明：应用会把 Codex 配置指向本地路由代理。
- 新用户默认启用本地路由。
- 本地路由默认只允许监听 `127.x.x.x` 地址。公开版本不应在没有明确高级风险提示的情况下启用局域网监听。
- 未授权请求访问网关状态时，需要隐藏供应商 Base URL、模型列表等敏感细节。
- CORS 响应限制为 `http://127.0.0.1`，不能使用通配来源。
- 已接入的客户端 socket 需要禁用 SIGPIPE，避免客户端提前断开时导致应用崩溃。
- 设置 > 路由需要提供手动端口检测；当端口已被其他进程占用时禁止保存。
- 应用启动前需要检查同端口监听冲突，并在 20 次尝试范围内自动切换到下一个可用端口。
- 设置 > 诊断需要展示网关状态、Codex 代理状态、恢复备份状态、当前供应商、当前模型和相关路径。
- 设置 > 诊断需要提供恢复、重新同步、打开恢复脚本目录、复制诊断信息等操作。
- 复制环境变量前需要二次确认，并在 2 分钟后自动清空剪贴板。
- 供应商元数据和用量统计文件需要以当前用户只读写权限保存。

## 自动化检查

- 打包前运行 `scripts/run-release-checks.sh`。
- 公开分发前需要清理所有静态分析警告。
- 检查脚本允许本地开发继续使用 `local.*` Bundle ID，但公开发布前必须替换。

## 公开分发前

- 使用 `scripts/build-release.sh` 构建应用。
- 使用 `scripts/package-dmg.sh` 打包 DMG。
- 公开发布前需要把 `local.ai-key-switcher` 替换为稳定的反向域名 Bundle ID。
- 设置 `CODEX_KEY_SWITCHER_SIGN_IDENTITY`，使用 Developer ID Application 证书签名。非 ad-hoc 构建会启用 hardened runtime 和 timestamp 签名。
- 设置 `APPLE_NOTARY_ID`、`APPLE_TEAM_ID`、`APPLE_NOTARY_PASSWORD` 后，使用 `scripts/notarize-dmg.sh` 提交公证并 staple DMG。
- 大范围分发前需要接入签名的自动更新通道，例如 Sparkle。
- 使用干净的 macOS 用户账号验证恢复流程。
- 卸载应用前验证 Codex 原配置可以恢复。
- 测试缺失 `.codex`、缺失 `auth.json`、缺失 `models_cache.json`、端口被占用、供应商配置文件损坏等场景。
- 测试供应商失败场景：401/403、Responses / Chat Completions / Anthropic Messages 端点 404、429 限流、5xx 故障转移、流式连接中断、非流式输出转回 Responses 后 Codex 能正常展示，以及 Chat Completions / Anthropic Messages 的真实流式文本和工具调用转换。

## 安全注意事项

- 日志、截图、崩溃报告、诊断信息里不能包含 API Key。
- 本地 JSON Key 存储可以避免反复弹出钥匙串授权，但它不等同于硬件级密钥保护。
- 面向企业或大范围分发时，需要增加可选 Keychain 存储后端，并提供从本地 JSON 迁移的能力。
- `~/Library/Application Support/AIKeySwitcher/api-keys.json` 应被视为敏感用户数据。
- 不要要求用户把 API Key 粘贴到 issue、聊天或公开反馈里。
