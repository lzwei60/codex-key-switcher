# 发布流程

Codex Key Switcher 通过 GitHub Releases 分发未签名桌面安装包。应用不会执行静默自动更新。用户在应用内检查更新后，打开当前平台匹配的 Release 资源，手动下载安装。

## 支持的安装包

每个公开版本都必须上传以下安装包资源：

| 平台 | 构建命令 | 必须使用的资源文件名格式 |
| --- | --- | --- |
| macOS Apple Silicon | `pnpm --filter @codex-key-switcher/desktop dist:mac:arm64` | `Codex-Key-Switcher-<version>-arm64.dmg` |
| macOS Intel | `pnpm --filter @codex-key-switcher/desktop dist:mac:x64` | `Codex-Key-Switcher-<version>-x64.dmg` |
| Windows x64 | `pnpm --filter @codex-key-switcher/desktop dist:win` | `Codex-Key-Switcher-Setup-<version>-x64.exe` |

应用内更新功能会根据文件名选择安装包。除非同一个版本同步修改 `apps/desktop/src/main/main.ts` 中的匹配逻辑，否则不要手动重命名 Release 资源。

## 版本规则

1. 更新 `apps/desktop/package.json` 中的 `version`。
2. 使用匹配的 Git tag，例如 `v1.0.0`。
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

3. 构建三个平台安装包：

```bash
pnpm --filter @codex-key-switcher/desktop dist:mac:arm64
pnpm --filter @codex-key-switcher/desktop dist:mac:x64
pnpm --filter @codex-key-switcher/desktop dist:win
```

4. 创建 GitHub Release，tag 必须匹配桌面端版本号，例如 `v1.0.0`。
5. 上传 `release/` 目录下的三个安装包资源。
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
