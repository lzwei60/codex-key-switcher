# 发布流程

Codex Key Switcher 通过 GitHub Releases 分发未签名桌面安装包。应用不会执行静默自动更新。用户在应用内检查更新后，打开当前平台匹配的 Release 资源，手动下载安装。

## 支持的安装包

每个公开版本都必须上传以下安装包资源：

| 平台 | 构建命令 | 必须使用的资源文件名格式 |
| --- | --- | --- |
| macOS Apple Silicon | `pnpm --filter @codex-key-switcher/desktop dist:mac:arm64` | `Codex-Key-Switcher-<version>-arm64.dmg` |
| macOS Intel | `pnpm --filter @codex-key-switcher/desktop dist:mac:x64` | `Codex-Key-Switcher-<version>-x64.dmg` |
| Windows x64 | `pnpm --filter @codex-key-switcher/desktop dist:win` | `Codex-Key-Switcher-Setup-<version>-x64.exe` |
| Linux x64 | `pnpm --filter @codex-key-switcher/desktop dist:linux` | `Codex-Key-Switcher-<version>-x86_64.AppImage` 和 `Codex-Key-Switcher-<version>-amd64.deb` |

应用内更新功能会根据文件名选择安装包。除非同一个版本同步修改 `apps/desktop/src/main/main.ts` 中的匹配逻辑，否则不要手动重命名 Release 资源。

## 版本规则

1. 更新 `apps/desktop/package.json` 中的 `version`。
2. 使用匹配的 Git tag，例如 `v1.0.4`。
3. GitHub Release 的 latest 版本必须使用同一个 tag。

更新检查会用 `app.getVersion()` 和 GitHub 最新 Release 的 tag 或 release name 对比版本号，并自动去掉开头的 `v`。

## 发布检查清单

1. 确认发布变更已经通过 Pull Request 合并到受保护分支。
2. 运行质量检查：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

3. 构建所有支持平台安装包：

```bash
pnpm --filter @codex-key-switcher/desktop dist:mac:arm64
pnpm --filter @codex-key-switcher/desktop dist:mac:x64
pnpm --filter @codex-key-switcher/desktop dist:win
pnpm --filter @codex-key-switcher/desktop dist:linux
```

4. 创建 GitHub Release，tag 必须匹配桌面端版本号，例如 `v1.0.4`。
5. 上传 `release/` 目录下的四个平台安装包资源组。
6. 将该 GitHub Release 标记为 latest。
7. 安装上一个桌面版本，并验证“设置 -> 更新”：
   - 能检测到最新版本。
   - 当前平台显示正确。
   - 匹配安装包名称正确。
   - “下载安装包”能打开对应 GitHub Release 资源。
   - “查看发布说明”能打开 GitHub Release 页面。

## 未签名安装包说明

当前项目有意使用未签名安装包发布，因此：

- macOS 首次启动时可能出现 Gatekeeper 提示。
- Windows 首次启动时可能出现 SmartScreen 提示。
- 应用不应自动下载安装并执行安装包。
- Release notes 应明确告知用户安装包未签名，并要求用户只从本仓库 GitHub Releases 页面下载。

在面向正式产品级公开分发前，应补充代码签名和 macOS notarization。

## v1.0.4 Release Notes

### 版本定位

`v1.0.4` 是基于 `v1.0.3` 的模型能力、协议适配和稳定性版本。该版本支持同一供应商下按请求模型选择不同协议，补强 Codex 模型 Catalog 生成与校验，修复流式响应异常完成和网关超时问题，并完善供应商配置与中英文界面。

### 新增内容

- 支持在同一供应商下为不同模型配置独立的 API 格式：Responses、Chat Completions 或 Anthropic Messages。
- 支持为模型单独配置推理参数能力和图片输入能力，并提供“继承供应商”选项。
- 支持从上游拉取模型列表、逐模型检测，以及保存前对未检测模型进行提示。
- 支持按 Codex 请求中的 `model` 选择当前供应商下的实际模型，不再要求切换供应商才能切换模型。
- 新增更完整的模型 Catalog 字段补全，减少 Codex `model/list` 或 `thread/start` 因字段缺失导致的兼容问题。
- 新增本地网关协议转换回归测试、模型 Catalog 校验测试和超时/断流场景测试。
- 补充桌面端托盘菜单、诊断、供应商、设置和用量提示的中英文显示。

### 修复内容

- 修复原生 Responses 流直接以文本增量开始或提前结束时，网关可能返回不完整事件序列的问题；异常结束现在会返回 `response.failed`，不会伪造 `response.completed`。
- 修复 Chat Completions 与 Anthropic Messages 的工具调用历史、系统指令和完整消息历史转换问题。
- 修复跨协议请求只携带 `previous_response_id` 或 `conversation` 时可能静默丢失历史的问题；现在会在请求上游前明确返回 400。
- 修复不支持图片或文件历史的模型被错误转发的问题，避免附件被静默丢弃。
- 修复上游响应头等待、普通请求、流式空闲和请求体读取缺少分阶段超时的问题，超时会记录为失败并返回对应错误状态。
- 修复正常读取请求体后 `IncomingMessage.destroyed` 导致网关误判客户端断开的问题。
- 修复 DeepSeek 等 OpenAI 兼容上游的协议入口、模型映射和请求头适配问题。
- 修复模型别名重复、模型能力配置未保留，以及模型校验后修改仍被误认为已校验的问题。

### 优化内容

- 优化模型编辑器，将基础字段与协议、推理、图片能力配置分组展示，并在窄屏下改为单列布局。
- 优化供应商列表、诊断页、更新页和用量页的运行时错误本地化，减少直接向用户暴露内部英文错误。
- 优化模型 Catalog 模板匹配：优先按真实上游模型复用缓存模板，缺失时使用完整默认字段补全，不再按数组索引复用不相关模型模板。
- 优化默认模型切换提示，明确区分默认模型更新与已有会话中显式模型的选择，避免误解为正在运行的会话会热切换。
- 优化网关流式转发的背压、客户端断开清理和失败状态记录，降低长连接泄漏和错误统计为成功的风险。

### 升级说明

- 本版本保留已有供应商、凭据、用量统计和连接设置；旧模型配置中的可选能力字段会按供应商默认值兼容处理。
- 修改供应商、模型或连接模式后，需要重新加载 Codex 的模型列表；切换器的默认模型不会覆盖已有会话明确指定的模型。
- Chat Completions 和 Anthropic 模型需要本地路由模式；直连模式要求所有模型最终使用 Responses 协议。
- 跨协议继续会话时，客户端需要提交完整可见历史；只提交 Responses 专属的响应 ID 不会被转换器强行恢复。
- 当前安装包仍未签名、未 notarize。请只从本仓库 GitHub Releases 页面下载。

### 安装包

- macOS Apple Silicon：`Codex-Key-Switcher-1.0.4-arm64.dmg`
- macOS Intel：`Codex-Key-Switcher-1.0.4-x64.dmg`
- Windows x64：`Codex-Key-Switcher-Setup-1.0.4-x64.exe`
- Linux x64：`Codex-Key-Switcher-1.0.4-x86_64.AppImage` 和 `Codex-Key-Switcher-1.0.4-amd64.deb`

### 已知限制

- 当前跨协议适配器只保证文本和函数工具历史；Chat Completions 或 Anthropic 路径收到图片/文件历史时会明确拒绝。
- Windows 和 Linux 安装包在 macOS 宿主机上只能完成交叉构建，公开发布前仍需在目标系统做安装、启动和升级冒烟验证。

## v1.0.3 Release Notes

### 版本定位

`v1.0.3` 是基于 `v1.0.2` 稳定版本线的安全加固与打包版本。该版本重点改进 Codex 模型 Catalog 同步、本地网关安全、文件持久化可靠性、连接设置回滚、Linux 打包和发布元数据一致性。

### 修复与优化

- 新增 Codex 模型 Catalog 自动生成能力，通过 `model_catalog_json` 写入当前供应商模型，并与当前连接模式保持一致。
- 新增本地路由模型稳定 slug、冲突处理和到真实上游模型名的反向映射。
- 加固本地网关授权、请求体大小限制、客户端断开处理、流式响应清理和监听地址收敛逻辑。
- 本地 JSON 和 Codex 配置写入改为原子写入，并为 Codex 配置、认证文件、备份和应用数据文件设置更严格的 POSIX 权限。
- 供应商保存或连接设置变更发生部分持久化失败时，会自动尝试回滚旧状态。
- 新增 Electron 单实例保护，重复启动时聚焦已有窗口，避免多个实例竞争写入网关和 Codex 配置。
- 新增 Linux x64 AppImage/deb 打包支持和更新安装包匹配逻辑。
- 扩展模型 Catalog、模型 slug 映射与冲突、网关协议适配、配置备份恢复和供应商持久化回滚测试。

### 升级说明

- 本版本保留已有供应商、凭据、用量统计和连接设置。
- 切换供应商、模型或连接模式后，需要完全退出并重启 Codex，使其重新加载生成的模型 Catalog 和连接配置。
- 本地路由默认只监听本机回环地址；只有显式开启局域网监听时才允许对外监听。
- 当前安装包仍未签名、未 notarize。请只从本仓库 GitHub Releases 页面下载。

### 安装包

- macOS Apple Silicon：`Codex-Key-Switcher-1.0.3-arm64.dmg`
- macOS Intel：`Codex-Key-Switcher-1.0.3-x64.dmg`
- Windows x64：`Codex-Key-Switcher-Setup-1.0.3-x64.exe`
- Linux x64：`Codex-Key-Switcher-1.0.3-x86_64.AppImage` 和 `Codex-Key-Switcher-1.0.3-amd64.deb`

### 注意事项

- macOS 首次打开可能出现 Gatekeeper 安全提示；Windows 首次打开可能出现 SmartScreen 提示。
- Windows 和 Linux 跨平台安装包在公开发布前，应在对应目标系统上做启动冒烟验证。

## v1.0.2 Release Notes

### 版本定位

`v1.0.2` 是 `v1.0.1` 稳定版本线的补丁版本。该版本修复第三方 Responses 兼容网关不支持 OpenAI 托管工具类型时，本地路由转发失败的问题，例如 `web_search`。

### 修复与优化

- 修复 Codex 请求经本地路由转发到 `https://api.xiaomimimo.com/v1` 等第三方 Responses 网关时，可能出现 `tool type 'web_search' is not supported by this gateway phase` 的问题。
- 本地路由现在会在转发给非 OpenAI 上游前过滤不受支持的 Responses 托管工具，同时保留普通 function tools。
- 当托管工具被过滤时，同步移除对应的不受支持 `tool_choice`，避免上游继续因为参数组合不合法而拒绝请求。
- OpenAI 官方 Responses API 仍保持托管工具原样透传。
- 新增单元测试覆盖第三方网关过滤和 OpenAI 透传行为。

### 升级说明

- 本版本保留已有供应商、凭据、用量统计和连接设置。
- 该修复仅在 Codex 流量经过本地路由模式时生效。直连供应商模式会绕过本地路由，无法改写不受支持的工具 payload。
- 模型 Catalog 和 Codex 配置会在 Codex 启动时加载。切换供应商、模型或连接模式后，必须完全退出并重启 Codex。

### 安装包

- macOS Apple Silicon：`Codex-Key-Switcher-1.0.2-arm64.dmg`
- macOS Intel：`Codex-Key-Switcher-1.0.2-x64.dmg`
- Windows x64：`Codex-Key-Switcher-Setup-1.0.2-x64.exe`
- Linux x64：`Codex-Key-Switcher-1.0.2-x64.AppImage` 和/或 `.deb`

### 注意事项

- 当前安装包仍未签名、未 notarize。请只从本仓库 GitHub Releases 页面下载。
- macOS 首次打开可能出现 Gatekeeper 安全提示；Windows 首次打开可能出现 SmartScreen 提示。

## v1.0.1 Release Notes

### 版本定位

`v1.0.1` 是 `v1.0.0` 稳定版本线的补丁版本。该版本修复本地路由自动启动状态持久化、直连模式状态残留、连接设置保存时不必要的重启，以及发布版本信息一致性问题。

### 修复与优化

- 修复打开 App 自动启动本地路由/自动应用直连配置不生效的问题。退出 App 时会停止运行时并恢复 Codex 配置，但不会把用户保存的连接启用状态写成关闭。
- 修复停用直连配置、诊断停止路由、Web 预览模拟停用路由时旧直连 Session 状态残留的问题。
- 修复路由本来已停用时退出 App 仍尝试恢复备份并可能弹出误导性失败提示的问题。
- 优化连接设置保存逻辑，只修改自动启动等非 Codex 配置项时不再重启本地路由，也不再重写 Codex 配置。
- 新增可测试的路由设置变更规划逻辑，覆盖运行时重启和 Codex 配置同步的判断。
- 修复 Web 预览 fallback 版本展示，改为通过 Next 配置从根 package 版本注入。
- 修复干净环境或并发构建时 Web typecheck 可能因为 `.next/types` 缺失而失败的问题。

### 升级说明

- 本版本保留已有供应商、凭据、用量统计和连接设置。
- 如果之前已经开启自动启动，安装并启动 `v1.0.1` 后会重新应用已保存的连接设置。
- 已打开的 Codex 会话可能继续使用旧配置；如未立即生效，请新开会话或重启 Codex。

### 安装包

- macOS Apple Silicon：`Codex-Key-Switcher-1.0.1-arm64.dmg`
- macOS Intel：`Codex-Key-Switcher-1.0.1-x64.dmg`
- Windows x64：`Codex-Key-Switcher-Setup-1.0.1-x64.exe`

### 注意事项

- 当前安装包仍未签名、未 notarize。请只从本仓库 GitHub Releases 页面下载。
- macOS 首次打开可能出现 Gatekeeper 安全提示；Windows 首次打开可能出现 SmartScreen 提示。

## v1.0.0 Release Notes

### 版本定位

`v1.0.0` 是 Codex Key Switcher 的首个稳定版本。该版本完成从旧 macOS AppKit 实现到 TypeScript、Next.js、Electron 架构的迁移，统一桌面端版本来源，并补齐供应商管理、本地路由、直连模式、诊断、用量统计、更新检查和发布打包流程。

### 主要功能

- 多供应商配置管理：支持添加、编辑、删除供应商，并为每个供应商维护多个模型别名和上游模型映射。
- 本地路由模式：Codex 固定连接本机地址，由应用负责切换供应商、切换模型、协议适配和故障转移。
- 直连供应商模式：支持将 Responses 格式供应商直接写入 Codex 配置，不启动本地监听。
- 协议支持：支持 Responses、OpenAI 兼容 Chat Completions、Anthropic Messages，并通过本地网关完成协议转换。
- 状态栏工作流：支持查看当前连接模式、路由地址、供应商、模型，并在状态栏内快速切换。
- 诊断与恢复：支持重新同步 Codex 配置、停止路由并恢复原配置、准备卸载、复制诊断报告和打开恢复脚本目录。
- 用量统计：记录经过本地路由的真实请求数、Token、状态码、耗时、供应商和模型维度聚合。
- 更新检查：支持从 GitHub Releases 检查最新版本，并打开当前平台匹配的安装包资源。

### 修复与优化

- 修复直连供应商模式下可从状态栏切换到 Chat Completions 供应商的问题；现在会给出通知提示并阻止切换。
- 修复旧版本或导入配置升级后，供应商切换可能误报“该配置缺少本地 API Key”的问题；现在会在真正使用 Key 时自动兼容旧 Key 存储格式。
- 修复安装后首次打开应用可能触发 macOS 本机密码/钥匙串授权的问题；启动、状态栏和配置列表不再主动解密 API Key。
- 配置列表改为只读展示模型，供应商和模型修改必须进入编辑流程，避免误操作。
- 统一应用版本展示，关于页、诊断信息、更新检查和安装包版本均以桌面端 `app.getVersion()` 为准。
- 更新检查增加 GitHub Releases 页面兜底解析，降低 GitHub API 403 或限流导致检查失败的概率。
- 优化用量记录落盘方式，避免每条用量记录都导出并重写整个 SQLite 文件。
- 优化流式响应处理，改为增量解析 usage，避免完整缓存流式响应到内存。
- 优化统计页性能，增加聚合缓存和懒加载，减少对全历史的重复聚合。
- 优化单个网关请求的供应商查找路径，避免重复查找并解密全部供应商。
- 优化统计数据刷新，移除无效预加载和重复刷新。
- 优化安装包体积，打包时只携带 `sql.js` 运行必需文件。

### 数据与隐私

- API Key 只保存在本机应用数据目录，并通过 Electron `safeStorage` 加密。
- 渲染进程不会直接读取 API Key 明文。
- 首次打开、状态栏刷新和配置列表展示不会主动解密 API Key。
- 只有检测模型、供应商切换校验、启用直连、网关请求转发、导出包含 Key 的配置时，才会读取本地 Key。
- 用量统计不会记录请求正文、响应正文或 API Key。
- 支持关闭本地用量记录，并配置保留天数和最大记录数。

### 升级说明

- 从旧版本升级后，应用会兼容旧版 `providerId:keyId`、`apiKey`、`apiKeys` 等 Key 存储格式。
- 如果本机安全存储无法解密旧 Key，仍需要进入编辑流程重新填写 API Key。
- 如果当前 Codex 会话仍使用旧配置，切换供应商、模型或连接模式后请打开新会话；必要时重启 Codex。

### 安装包

- macOS Apple Silicon：`Codex-Key-Switcher-1.0.0-arm64.dmg`
- macOS Intel：`Codex-Key-Switcher-1.0.0-x64.dmg`
- Windows x64：`Codex-Key-Switcher-Setup-1.0.0-x64.exe`

### 注意事项

- 当前安装包仍未签名、未 notarize。请只从本仓库 GitHub Releases 页面下载。
- macOS 首次打开可能出现 Gatekeeper 安全提示；Windows 首次打开可能出现 SmartScreen 提示。
- 直连供应商模式仅支持 Responses 格式供应商；Chat Completions 和 Anthropic Messages 供应商请使用本地路由模式。
- 直连供应商模式不会记录本地请求日志和 Token 统计。
- 当前仅已在本机生成 macOS Apple Silicon 安装包；macOS Intel 和 Windows 安装包需要在对应环境或 CI 中补充构建验证。
