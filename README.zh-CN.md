# Codex Key Switcher

[English](README.md) | [简体中文](README.zh-CN.md)

Codex Key Switcher 是一个跨平台桌面应用，用于管理 Codex 兼容的 AI 供应商配置、本地网关路由、直连供应商配置、模型选择、诊断信息和用量统计。

项目基于 TypeScript、Next.js、Electron 和共享 workspace 包构建。整体架构重点关注业务逻辑可测试、平台能力隔离，以及渲染进程不直接接触本地密钥。

当前稳定版本：`v1.0.1`。

## 功能特性

- 在一个桌面应用中管理多个 AI 供应商配置。
- 为 Codex 工作流切换当前启用的供应商和模型。
- 运行本地网关，负责供应商路由和协议适配。
- 支持直连供应商模式，将 Responses 格式供应商直接写入 Codex 配置。
- 支持 Responses、OpenAI 兼容 Chat Completions，以及 Anthropic Messages 风格的供应商。
- 通过桌面主进程保存供应商凭据，避免渲染进程直接接触密钥。
- 启动、状态栏和配置列表只读取配置元数据，不主动解密本地 API Key。
- 查看本地网关诊断信息和本地用量统计。
- 支持用量统计开关、保留天数和最大记录数。
- 在桌面层和 UI 层之间复用核心业务逻辑。

## 项目结构

```text
apps/web       Next.js 渲染层 UI
apps/desktop   Electron 主进程、preload bridge 和本地服务
packages/core  供应商、网关、Codex 配置和用量统计业务逻辑
packages/shared 共享类型和 IPC 契约
docs           用户指南、治理规则和项目文档
scripts        仓库维护脚本
```

## 环境要求

- Node.js 22 或更高版本
- pnpm 9.15.0 或更高版本

包管理器版本已在 `package.json` 中固定。

## 本地开发

安装依赖：

```bash
pnpm install
```

启动桌面开发环境：

```bash
pnpm dev
```

提交 Pull Request 前运行质量检查：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## 构建

构建所有 workspace 包：

```bash
pnpm build
```

打包桌面应用：

```bash
pnpm --filter @codex-key-switcher/desktop dist
```

平台相关的打包命令可查看 `apps/desktop/package.json`。

## 更新与发布

桌面应用支持通过 GitHub Releases 手动检查更新。由于当前安装包未签名，应用只会打开当前平台匹配的安装包下载页面，不会自动下载安装并执行安装包。

`v1.0.1` 是当前稳定发布版本。Release tag 应使用 `v1.0.1`，应用内版本号和安装包版本号应使用 `1.0.1`。

必须上传的 Release 资源：

- `Codex-Key-Switcher-1.0.1-arm64.dmg`，用于 macOS Apple Silicon。
- `Codex-Key-Switcher-1.0.1-x64.dmg`，用于 macOS Intel。
- `Codex-Key-Switcher-Setup-1.0.1-x64.exe`，用于 Windows x64。

完整发布检查清单请查看 [发布流程](docs/RELEASE.zh-CN.md)。

## 数据与隐私

- API Key 只保存在本机应用数据目录，并通过 Electron `safeStorage` 加密。
- 渲染进程不会直接读取 API Key 明文。
- 首次打开应用、展示配置列表和刷新状态栏不会主动解密 API Key。
- 只有检测模型、切换需要校验的供应商、启用直连、网关转发请求、导出包含 Key 的配置时，才会读取本地 Key。
- 用量统计只记录本地路由请求的供应商、模型、Token、状态码和耗时，不记录请求正文、响应正文或 API Key。

## 安全

Codex Key Switcher 会处理供应商 API Key 和本地网关流量。不要提交真实 API Key、包含凭据的供应商导出文件、本地应用数据、带有授权请求头的诊断日志，或环境变量文件。

安全敏感区域包括：

- 凭据存储和导入导出。
- 本地网关授权。
- 上游请求转发和请求头处理。
- 用量日志和诊断输出。
- 发布签名、公证和安装包构建。

漏洞报告方式请查看 [SECURITY.md](SECURITY.md)。

## 文档

- [中文使用说明](docs/USER_GUIDE.zh-CN.md)
- [English User Guide](docs/USER_GUIDE.en-US.md)
- [贡献指南](CONTRIBUTING.md)
- [开源治理](docs/OPEN_SOURCE_GOVERNANCE.md)

## 贡献

所有进入受保护分支的变更都必须通过 Pull Request。Pull Request 应通过 CI，说明用户可见影响，并明确标注是否涉及产品规则、安全行为、发布行为或用户数据处理。

完整贡献流程请查看 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

本项目基于 [MIT License](LICENSE) 开源。
