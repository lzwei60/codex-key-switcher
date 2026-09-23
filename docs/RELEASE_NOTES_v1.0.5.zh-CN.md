# v1.0.5 发布说明

## 新增内容

- 支持配置本地网关故障转移最大尝试次数、总超时、连续失败阈值、冷却时间和半开状态并发数。
- 支持配置供应商优先级，以及每个备用供应商的故障转移模型映射。
- 每次故障转移尝试都会记录请求 ID、尝试次数、最终尝试状态、错误分类、供应商、模型、状态码和耗时。

## 修复与优化

- 修改网关监听地址或端口后会重启本地网关，不再继续使用旧监听器。
- 关闭故障转移时清理旧熔断状态，避免重新开启后使用过期状态。
- 备用供应商读取凭据失败时继续尝试后续供应商，同时记录凭据错误。
- 无论请求正常结束还是抛出异常，都会释放半开熔断许可。
- 升级过程中保留已有供应商、凭据、用量统计和连接设置。

## 升级与风险提示

- 旧连接设置会保留；缺失的新故障转移配置会使用保守默认值。
- Chat Completions 和 Anthropic 模型需要本地路由模式；直连模式要求 Responses。
- 当前安装包未签名、未 notarize。请只从本仓库 GitHub Releases 页面下载。

## 安装包

- macOS Apple Silicon：`Codex-Key-Switcher-1.0.5-arm64.dmg`
- macOS Intel：`Codex-Key-Switcher-1.0.5-x64.dmg`
- Windows x64：`Codex-Key-Switcher-Setup-1.0.5-x64.exe`
- Linux x64：`Codex-Key-Switcher-1.0.5-x86_64.AppImage` 和 `Codex-Key-Switcher-1.0.5-amd64.deb`

为保证升级覆盖，应用包名称保持固定：macOS 为 `Codex Key Switcher.app`，Windows 安装包内为 `codex-key-switcher.exe`，Linux 包内为 `codex-key-switcher`。
