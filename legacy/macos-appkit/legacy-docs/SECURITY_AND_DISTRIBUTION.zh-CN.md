# 安全与分发说明

英文版：[SECURITY_AND_DISTRIBUTION.md](SECURITY_AND_DISTRIBUTION.md)

## 本地代理

Codex Key Switcher 会运行一个本地 Responses 兼容代理。这样 Codex 可以始终使用一个稳定的 `base_url`，而应用负责切换上游供应商和模型。上游供应商可以使用原生 Responses、OpenAI 兼容 Chat Completions 或 Anthropic Messages，代理会把请求和响应转换回 Codex 期望的 Responses 形态。

公开版本应保持监听地址为 `127.x.x.x`。如果把代理暴露到 `0.0.0.0` 或局域网 IP，可能泄露供应商元数据，也会让同一网络中的其他设备访问到本地网关。

模型请求必须携带授权 token。状态接口在未授权访问时只返回脱敏信息，不返回完整 Base URL 和模型列表。

## API Key 存储

默认情况下，API Key 保存到：

`~/Library/Application Support/AIKeySwitcher/api-keys.json`

该文件和父目录会限制为当前 macOS 用户可读写。这种方式可以避免反复弹出钥匙串权限确认，但它仍然是本地文件存储，不是硬件级密钥保护。

如果要面向更大范围或企业用户分发，建议增加可选 Keychain 存储后端，并提供从本地 JSON 文件迁移到 Keychain 的能力。

## Codex 配置变更

启用本地路由时，应用会更新用户选择的 Codex 配置目录中的这些文件：

- `config.toml`
- `auth.json`
- 存在时更新 `models_cache.json`

应用会创建受管理的备份文件，并生成一个独立恢复脚本：

`~/Library/Application Support/AIKeySwitcher/restore-codex-config.command`

用户卸载应用前应先恢复 Codex 原配置。如果应用被直接删除且没有恢复配置，可以手动运行该恢复脚本。

## 发布签名

本地开发构建可以使用 ad-hoc 签名。公开发布必须使用：

- 稳定的反向域名 Bundle ID
- Developer ID Application 签名
- hardened runtime
- timestamp 签名
- 已公证并 staple 的 DMG
- 大范围分发前接入签名的自动更新通道

推荐发布流程：

1. 运行 `scripts/run-release-checks.sh`
2. 运行 `scripts/package-dmg.sh`
3. 设置 Apple 公证相关环境变量后运行 `scripts/notarize-dmg.sh`

## 用户支持注意事项

- 让用户提供诊断信息时，应使用应用内“复制诊断信息”功能。
- 不要要求用户提供完整 API Key。
- 让用户卸载前先在“设置 > 诊断”里恢复 Codex 原配置。
- 如果用户已经删除应用但 Codex 仍指向本地代理，让用户运行 `restore-codex-config.command`，或手动恢复 `config.toml` 和 `auth.json`。
