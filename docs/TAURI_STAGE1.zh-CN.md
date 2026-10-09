# Tauri 迁移：阶段 1 桌面壳

**状态：开发中。macOS Apple Silicon 基础构建与生命周期验证通过，尚未达到跨平台完成标准。**

## 范围与隔离

Tauri 2 预览壳位于 `apps/desktop/src-tauri`。它使用独立的应用标识 `com.codexkeyswitcher.tauri.preview`、产品名 `Codex Key Switcher Tauri Preview`，与现有 Electron 安装包并行存在。保留 `pnpm dev` 和 `dev:electron` 的原有行为；Tauri 入口使用 `pnpm --filter @codex-key-switcher/desktop dev:tauri`，构建使用 `pnpm --filter @codex-key-switcher/desktop build:tauri`。

预览壳只加载现有 `apps/web` 的 Next.js 静态导出。窗口尺寸沿用 Electron（1180 × 760、最小 920 × 620），关闭窗口时隐藏，托盘菜单提供打开主界面与退出，重复启动聚焦已有窗口。当前没有任何业务 Command、preload 或 Node sidecar；UI 将使用浏览器预览数据。**预览模式的供应商、网关、统计等操作是模拟行为，不会配置真实 Codex，不能作为功能迁移验收。**

Tauri capability 当前只赋予主窗口 `core:default`，不提供通用文件系统、Shell、网络或凭据权限；网关和凭据仍由 Electron 正式版负责。开发时不要同时启动多个前端开发服务器占用 3340 端口；Tauri CLI 会自动启动前端服务。预览应用使用独立标识，不应使用正式版本的数据目录作为测试目录。

## 本机准备

- Node.js 22、pnpm 9 和 Rust stable（本次 macOS 构建使用 Rust 1.98.1）。
- macOS 需 Xcode Command Line Tools；Windows 需 WebView2 和 MSVC 工具链；Linux 需 WebKitGTK 等 Tauri 2 系统依赖。以 Tauri 2 官方对应平台的依赖清单为准。
- 当前 macOS 图标复用 `apps/desktop/build` 中的 `icon.png`、`icon.icns`、`icon.ico`，打包使用 `src-tauri/icons` 中的副本。更改原图标时需同步更新这三份预览图标。

```bash
pnpm install
pnpm --filter @codex-key-switcher/desktop dev:tauri
pnpm --filter @codex-key-switcher/desktop build:tauri
```

macOS 在不配置开发者证书时，可先执行 `pnpm --filter @codex-key-switcher/desktop exec tauri build --bundles app --no-sign` 验证产物，再对隔离预览 `.app` 做本地 ad-hoc 签名和 `codesign --verify`。这种签名不能代替发布签名/公证，不应上传为正式安装包。

## 验收记录与未完成项目

- macOS Apple Silicon：Next.js 静态导出和 Tauri release 二进制编译成功；预览 `.app` 构建成功（约 15 MB），独立 bundle identifier 正确。预览 DMG 成功生成。本地 ad-hoc 签名验证通过，通过 `open` 启动后进程持续运行。`tauri dev` 启动成功，页面请求返回 HTTP 200；点击预览窗口关闭按钮后窗口数为 0 而进程仍存活，重新启动同标识 debug 程序后原窗口恢复为 1 个，仍只有一个预览进程。原有 Electron 的 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 均通过。
- 当前机器未授予屏幕录制权限，截图助手还遇到 Swift 编译器与 SDK 版本不匹配，因此无法确认 WebView 页面像素、布局与交互。窗口可见性仅通过 macOS 系统进程检查确认，不能替代截图验收。
- 托盘菜单点击“打开主界面”/“退出”、DMG 安装后启动，以及 Windows NSIS、Linux AppImage/deb 尚未在对应环境中完成端到端验收。阶段 1 暂不标记完成，待这些检查通过后再改状态。
- CI 已增加 macOS arm64 `.app`、Windows x64 NSIS、Linux x64 AppImage/deb 的 Tauri 构建矩阵，使用 `tauri build --ci --no-sign` 非交互构建，先执行 bundle 结构/架构检查，再上传未签名验收产物。该矩阵只证明对应 runner 能完成编译/打包，不等同于安装后启动、托盘、系统密钥库或升级回滚验收；当前工作区没有 GitHub Actions 运行结果可读取，远端矩阵尚未确认通过。
- CI 同时运行 `scripts/verify-tauri-bundle.mjs` 检查平台 bundle 是否产出；macOS 会校验 Preview `Info.plist`、arm64 Mach-O 和独立 bundle identifier，Linux 会校验 x86_64 ELF AppImage/deb，Windows 会校验 PE/NSIS 文件头。该脚本只做产物结构检查，不代替平台安装启动冒烟。
- 本机 macOS arm64 Preview 冒烟已验证：未签名 `.app` 可启动，进程来自 bundle 内 arm64 二进制，Bundle Identifier 为 `com.codexkeyswitcher.tauri.preview`，按 identifier 激活后窗口和设置页真实渲染。通过 Retina 坐标换算点击“深色”主题后，隔离目录写入 `settings.json`，退出并重启 Preview 后深色主题恢复。WebView 内部控件未暴露给 macOS Accessibility，不能使用无障碍元素定位，只能使用已人工校准的屏幕坐标；本轮未填写供应商 Key，也未访问真实 `~/.codex`。

阶段 2 才会引入类型安全的 Tauri Command，接入真实桌面业务。预览壳的手动模拟操作不会持久化为正式数据，也不能作为凭据/网关迁移验证。
