# Tauri 迁移：阶段 0 基线与兼容边界

**状态：阶段 0 已完成（源码验收通过；2026-09-23）。**

验收记录：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 及 `git diff --check` 均通过；测试结果为核心 16 项通过、桌面 71 项通过、1 项跳过。事务提取前后的 Electron 调用顺序和回滚分支已复核，没有发现阶段 0 引入的行为差异。

阶段 0 不引入 Tauri 运行时。当前默认 `pnpm dev` 仍启动 Electron，也可以显式执行 `pnpm --filter @codex-key-switcher/desktop dev:electron`。阶段 1 创建可运行的 `src-tauri` 后再增加 `dev:tauri`；在此之前不提供会启动失败的 Tauri 开关。

## 应用服务与契约

- `apps/desktop/src/application/provider-application-service.ts` 承担供应商保存、删除、切换和模型切换的事务编排。`route-application-service.ts` 承担路由设置切换与失败回滚。Electron 主进程通过注入端口提供配置同步、状态刷新、通知和直连校验；这两个模块不导入 Electron。
- `packages/shared/src/index.ts` 中的 `DesktopApi` 是现有 UI/preload 契约。`desktop-command-contract.ts` 基于它定义请求参数、返回值和错误结构；阶段 2 应逐一映射 IPC，不应让渲染层直接访问凭据或文件系统。
- Rust Command 名称在设计文档中只是目标清单，不代表此阶段已经注册 Command。后续生成双端 DTO 时应验证 JSON 字段名、可选字段和错误码一致。
- 用户在表单中输入 API Key 时，明文会短暂经过渲染层和显式的保存/校验请求；供应商列表、诊断等普通读取不得返回明文。凭据的持久化与按需解密继续由桌面进程负责。

## 数据目录发现规则

数据路径由桌面壳显式传入 `desktopPaths(userData, home)`，不根据包名或 Tauri identifier 猜测目录；相对路径直接拒绝。Electron 当前使用 `app.getPath('userData')` 和 `app.getPath('home')`。在隔离 profile 下，`userData` 可能被启动参数覆盖，必须保留这个能力供安装应用测试使用。

| 文件 | Electron 相对路径 | 说明 |
| --- | --- | --- |
| 设置 | `userData/settings.json` | 包含路由、语言、配置目录等设置 |
| 供应商 | `userData/providers.json` | 元数据和当前选择 |
| 凭据 | `userData/api-keys.json` | `safeStorage` 密文；不能仅靠复制文件完成跨壳迁移 |
| 用量 | `userData/usage.sqlite` | 当前 `sql.js` 数据库 |
| Codex | `home/.codex` | 仅默认位置，可通过 `codexConfigDir` 改为自定义目录 |

迁移前需要在 macOS、Windows、Linux 分别记录实际 `userData` 目录，以及 Tauri 目标目录和安装包 identifier。不得在未发现旧目录时默默创建空配置；不得在两个应用同时运行时共享写入。凭据迁移必须通过旧版可解密进程完成，不得猜测密文格式或写入明文。数据迁移/回滚细节在阶段 3 实现。

## 基线与后续验收

修改前基线：`pnpm typecheck` 通过；`pnpm test` 在允许绑定本机端口的环境中通过（核心 16 项、桌面 59 项，1 项跳过）。受限沙箱运行网关测试会因 `listen EPERM 127.0.0.1` 失败，不是功能故障。

后续每阶段必须运行 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`；网关测试需允许本地回环监听。现有 `scripts/verify-installed-mac.mjs` 为 Electron 安装包冒烟脚本，必须在隔离 profile 和 Codex 目录下运行，不得指向真实用户目录。阶段 1/2 增加 Tauri 安装包测试后再对比两套实现；目前不能声称已经完成 Tauri 安装包验证。

当前的安装应用脚本使用 `/Applications` 中已安装的 Electron 版本；它无法验证本轮尚未打包安装的代码。本轮通过现有单元测试、类型检查、lint 和源码构建验收，安装包级验证仍需单独在隔离环境中执行。
