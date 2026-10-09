# Tauri 迁移：阶段 2 类型安全桥接层

**状态：开发中，尚未完成阶段 2。**

## 当前实现

- `apps/web/src/lib/desktop-api.ts` 按环境选择实现：优先使用 Electron 的 `window.desktopAPI`，其次使用 Tauri `__TAURI_INTERNALS__`，普通浏览器继续使用独立的 Web 预览实现。
- `apps/web/src/lib/tauri-desktop-api.ts` 实现同一 `DesktopApi` 类型，使用 `@tauri-apps/api/core` 调用已注册的 Rust Command。供应商基础保存/删除/选择/模型切换、偏好、启动项和独立目录设置已接入；新增的 Codex 同步/恢复仅允许预览数据目录下的 `codex-sandbox`，真实用户目录仍不可写。
- `apps/desktop/src-tauri/src/commands.rs` 提供隔离预览状态：应用启动信息、预览应用数据目录中的界面偏好/用量设置与供应商元数据只读列表、未运行的网关状态和预览诊断。用量统计现在读取预览目录中已有的 SQLite，支持清理该库日志。已注册命令以 Rust 函数名（snake_case）调用；预览壳不开放通用文件系统、Shell 和凭据权限。存储切片详见 `docs/TAURI_STAGE3.zh-CN.md`。
- 当前没有 Node sidecar。现有 Electron 业务入口未改，Tauri 预览壳不会读取 Electron profile，不写真实 Codex 配置，不启动本地网关。

## 验证与后续

前端单测覆盖环境选择、命令名/参数以及未迁移写操作拒绝；Rust 单测验证预览状态不声称网关运行、用量字段结构。构建和测试结果以本轮最终命令为准。

**尚未接入：**真实用户 Codex 目录、Windows 启动项和正式安装包验收。Tauri Preview 已支持隔离 Codex 沙箱、供应商凭据与元数据、SQLite 用量、网关协议转发、直连供应商、供应商/模型变更后的自动同步、更新/诊断和显式凭据迁移；其它未迁移写操作会收到“尚未迁移”错误。凭据迁移仍需真实平台 keyring 和升级数据目录演练。

阶段 1 的截图/跨平台安装包验收也仍未关闭。Tauri 预览壳不得作为正式可用版本发布。
