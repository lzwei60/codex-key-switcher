# Codex Key Switcher：从 Electron 迁移到 Tauri 的设计方案

> 本文件是 planning-gate 阶段的工作文档，当前内容为设计方案，不是具体实施计划。

## 方案决策

采用分阶段迁移，并设置临时兼容架构：

1. 保留现有 Next.js 静态渲染层和 TypeScript 领域逻辑。
2. 引入 Tauri 2 作为并行桌面壳，将 Electron preload/IPC 替换为类型安全的 Tauri 适配层。
3. 按边界逐步将平台能力和持久化服务迁移到 Rust。
4. 在通过协议行为黑盒回归测试之后，再将本地网关迁移到 Rust。
5. 只有当 Tauri/Rust 版本通过完整验收矩阵后，才移除 Electron、Node 桌面依赖和临时 TypeScript 原生运行时。

最终目标是 Tauri 2 + Rust 后端 + Next.js 静态前端。渲染层继续使用 TypeScript/React；原生能力通过经过白名单限制的小型 Command API 暴露，渲染层不能直接访问文件系统或执行 Shell 命令。

## 采用原因

当前仓库已经将 UI、共享契约、核心业务逻辑和 Electron 服务进行了拆分。迁移中风险最高的并不是窗口本身，而是凭据处理、Codex 配置备份/恢复、协议转换、流式响应、故障转移以及退出时清理。如果一次性重写所有模块，将很难区分 Tauri 引入的问题和业务逻辑回归。

分阶段设计可以在桌面壳迁移期间保留现有用户数据格式和公开的 `DesktopApi` 行为。同时它提供了真实的回滚路径：在 Tauri 版本通过安装包测试之前，当前 Electron 版本可以继续作为生产环境的回退版本。

已否决的替代方案：

- 一次性重写为 Rust：长期 Node 运行时体积最低，但功能和安全回归风险最高。
- 永久保留 Node 子进程：短期迁移最快，但无法实现移除 Node 桌面运行时的目标，同时会增加打包、进程监管和凭据归属的复杂度。
- 在本次迁移中同时更换 Next.js 前端：与当前目标无关，并会引入不必要的 UI 风险。

## 目标

- 保留现有供应商管理、本地网关、直连供应商、诊断、用量统计、导入/导出、托盘、开机启动和更新检查行为。
- 用户输入的 API Key 只在表单和显式保存/校验请求中短暂停留渲染层；普通元数据读取不返回明文，也不主动解密凭据。
- 保留现有 `providers.json`、`api-keys.json`、`settings.json`、`usage.sqlite`、旧版用量迁移、Codex 备份以及恢复脚本行为。
- 使用类型安全的 Tauri Command 替代 Electron IPC，同时不暴露通用文件系统或 Shell 命令。
- 继续产出 macOS、Windows 和 Linux 安装包，并建立明确的发布与回滚流程。
- 最终打包后的桌面应用不再依赖 Electron，也不需要 Node 进程运行。

## 非目标

- 不重新设计 React/Next.js UI。
- 不改变供应商协议语义和故障转移策略。
- 除非有明确记录的数据迁移要求，否则不改变用户数据结构。
- 本次迁移不新增静默自动更新；继续以现有 GitHub Releases 手动更新流程为基准。
- 不增加当前项目尚未打包支持的平台。

## 当前边界评估

| 当前职责 | 当前代码位置 | 迁移目标 |
| --- | --- | --- |
| React 渲染层和静态导出 | `apps/web` | 保留 `apps/web` 中的 Next.js 静态导出 |
| Electron 窗口、preload、IPC | `apps/desktop/src/main`、`src/preload` | `apps/desktop/src-tauri` 中的 Rust Command 和 Tauri 插件 |
| 共享契约 | `packages/shared` | 继续作为 TypeScript UI 契约；通过契约测试生成或同步 Rust DTO |
| 供应商和核心业务编排 | `packages/core` 以及 Electron 回调 | 第一阶段保留 TypeScript，之后只迁移原生边界所需的编排逻辑 |
| 本地网关和协议转换 | `apps/desktop/src/services/local-gateway-runtime.ts`、`gateway-protocol-adapter.ts` | 第一阶段保留 TypeScript，最终迁移到 Rust HTTP/流式运行时 |
| JSON 文件和 Codex 配置 | `apps/desktop/src/services` | 迁移到 Rust 文件服务，保留原子写入和权限处理 |
| API Key 加密 | `CredentialFileStore` 和 Electron `safeStorage` | Rust keyring/操作系统凭据存储；保留导入兼容性并增加一次性迁移 |
| SQLite 用量数据 | 使用 `sql.js` 的 `UsageFileRepository` | Rust SQLite（`rusqlite` 或同类方案），并增加 Schema 与迁移测试 |
| 托盘、单实例、开机启动 | Electron main | Tauri 核心能力，以及 `tauri-plugin-single-instance`、`tauri-plugin-autostart` 和托盘支持 |
| 对话框、Shell、剪贴板、通知 | Electron main | Tauri dialog、opener、clipboard、notification 插件 |
| 手动更新检查 | Electron `main.ts` | 第一阶段使用 TypeScript API 适配层；未来如引入签名更新，再考虑 Tauri updater |

## 架构设计

### 过渡架构：Tauri 桌面壳 + TypeScript 原生运行时

第一个可用的 Tauri 版本应采用以下结构：

```text
Next.js renderer
  -> desktop-api.ts 适配层
  -> Tauri invoke(command, payload)
  -> Rust Command 桥接层
  -> TypeScript 运行时兼容服务（临时）
       -> 现有 packages/core 和 apps/desktop/src/services
```

该临时桥接层只允许在过渡期以本地回环服务或受监管的 sidecar 形式存在。它必须被视为内部兼容层，具备版本化的 Command 契约、明确的生命周期监管，并且不能被渲染层直接访问。它不能成为最终架构。

推荐先将现有 Electron main 中的业务逻辑提取为与框架无关的 TypeScript 应用服务。过渡期间，Electron 和 Tauri 都调用同一套应用服务。这样可以减少 `main.ts` 中的逻辑，并让后续迁移 Rust 变成替换边界，而不是围绕 UI 进行整体重写。

### 最终架构：Tauri 2 + Rust 后端

```text
Next.js static renderer
  -> `desktop-api.ts` 类型安全适配层
  -> Tauri `invoke` Command / 指定事件
  -> Rust 应用服务
       -> 供应商仓库
       -> 操作系统 keyring 凭据存储
       -> Codex 配置适配器
       -> SQLite 用量仓库
       -> 本地网关和协议适配器
       -> 托盘/启动项/对话框/更新集成
```

Command 按能力分组，使用经过校验的 DTO，返回可序列化的结果类型。除非存在针对具体能力的显式校验规则，否则不能接受任意路径或 Shell 命令。

## Command 契约

在可行的情况下保持公开 TypeScript `DesktopApi` 结构稳定，仅替换其内部实现为 `invoke` 调用。下表的 kebab-case 名称是原设计草案；阶段 2 当前注册的 Tauri Command 使用 Rust 函数名（snake_case），实际映射见 `apps/web/src/lib/tauri-desktop-api.ts`。正式接入剩余能力前，须确定唯一命名规则并同步前后端，不能将草案名称当作已注册命令。

| 能力 | Tauri Command 分组 | 敏感信息处理 |
| --- | --- | --- |
| 应用设置 | `app-get-startup-settings`、`app-save-startup-settings`、`app-get-preferences`、`app-save-preferences`、`app-get-codex-directory`、`app-save-codex-directory`、`app-choose-codex-directory`、`app-check-updates`、`app-open-update-download` | 不返回敏感信息 |
| 供应商 | `providers-list`、`providers-save`、`providers-delete`、`providers-set-current`、`providers-set-selected-model`、`providers-validate-model`、`providers-list-upstream-models`、`providers-export`、`providers-import` | 明文 Key 只允许出现在显式保存、校验、直连、网关转发以及包含 Key 的导出流程中 |
| 网关 | `gateway-status`、`gateway-start`、`gateway-stop`、`gateway-get-settings`、`gateway-save-settings`、`gateway-check-port` | 绝不返回当前供应商 API Key |
| 诊断 | `diagnostics-read`、`diagnostics-resync-codex-config`、`diagnostics-stop-and-restore`、`diagnostics-prepare-uninstall`、`diagnostics-open-restore-directory`、`diagnostics-copy-report` | 报告必须脱敏 Key 和认证请求头 |
| 用量 | `usage-stats`、`usage-clear-logs`、`usage-get-settings`、`usage-save-settings` | 永远不持久化请求体和响应体 |

使用统一错误信封，例如 `{ code, message, retryable }`，不要直接序列化任意 Rust 错误。UI 可以继续根据稳定的错误码进行本地化。所有输入必须在 Rust 中再次校验，渲染层校验只能用于改善交互体验。

事件只用于难以通过轮询高效获取的状态变化，例如网关状态变化、退出/恢复完成或单实例聚焦请求。普通 CRUD 操作继续使用请求/响应式 Command。

## 数据与兼容性

### 用户数据

Tauri 应用必须使用经过明确记录的应用标识和数据目录。在发布第一个迁移版本前，需要在每个平台上核对目标目录与现有 Electron `app.getPath('userData')` 的实际值。如果应用标识发生变化，必须实现显式的数据发现/导入步骤，不能静默地以空数据启动。

需要保留以下文件及其语义：

- `settings.json`：设置 Key 继续可读；只有在完成向后兼容解析后，才增加 Schema/版本标记。
- `providers.json`：供应商元数据和当前选中项保持兼容。
- `api-keys.json`：迁移期间继续读取旧格式，但新的写入使用操作系统 keyring 或 Rust 管理的加密格式。
- `usage.sqlite`：保留 Schema、保留策略、聚合结果以及旧版 JSON 迁移能力。
- Codex 的 `config.toml`、`auth.json`、受管理备份和恢复脚本：保留原子写入和回滚行为。

### 凭据迁移

不要通过猜测格式的方式在 Rust 中解码 Electron `safeStorage` 密文。应采用以下受控迁移方式：

1. 过渡期的 Electron 进程在用户显式选择导出路径后读取旧凭据文件，通过一次性迁移包和 Tauri Command 将凭据写入 Rust keyring；Tauri 目标目录必须为空，不允许静默覆盖已有预览数据。
2. 如果操作系统 keyring 不可用，新凭据的安全写入必须失败并提供修复路径，不能静默降级为明文存储。
3. 保存迁移标记和每个供应商的迁移状态，使中断后的迁移可以安全续作。
4. 绝不能在日志、诊断报告、崩溃报告或普通 Command 结果中包含明文 API Key。

### 版本和回滚

使用独立于应用版本的数据迁移版本。只备份即将转换的文件，采用原子写入，并在新存储成功打开和校验前保留旧数据。Tauri 启动失败时不能覆盖 Electron 兼容的数据存储。

## 网关迁移策略

网关是风险最高的子系统。在迁移实现之前，必须先通过黑盒测试保护现有行为：

- 本地网关 Token 和供应商 Key 的认证行为；
- 默认回环监听和显式 LAN 监听；
- 请求大小限制和超时限制；
- Responses、Chat Completions、Anthropic Messages 协议转换；
- 非流式响应；
- 正常流式响应、截断流式响应和客户端断开；
- 工具调用、历史消息转发、不支持的附件以及 `previous_response_id` 错误；
- 故障转移尝试顺序、熔断打开/冷却、截止时间和用量记录；
- Codex 配置同步，以及停止/退出时的恢复行为。

按以下切片迁移网关：

1. 先实现 Rust 监听器和健康检查接口，暂不转发上游请求。
2. 迁移 Rust 供应商选择、凭据读取和非流式 Responses 转发。
3. 按协议格式逐个迁移流式响应和协议转换。
4. 迁移故障转移、熔断和用量记录。
5. 最后完成与路由设置、Codex 配置、托盘和退出流程的完整生命周期集成。

在 Rust 网关通过同一套黑盒 fixture 测试之前，通过 feature flag 保留旧 TypeScript 网关。两个网关绝不能同时监听同一个配置端口。

## 安全与权限

- 使用 Tauri capabilities，只允许主窗口访问实际需要的 Command 和插件。
- 不启用宽泛的文件系统权限或 Shell 权限。
- 在后端校验所有用户输入的 URL、路径、端口、供应商 ID 和更新地址。
- 默认只监听回环地址；监听 LAN 必须由用户显式开启。
- 只有在认证和路由配置校验通过后，才允许绑定本地网关。
- 从错误和诊断信息中脱敏 `Authorization`、`x-api-key`、供应商 Key 以及敏感文件内容。
- 使用原子文件写入、系统支持时的严格文件权限以及安全临时文件。
- 将恢复脚本视为敏感可执行文件，生成前必须校验其目标路径。
- 发布前检查 Tauri CSP、外部导航、自定义协议以及发布产物内容。

## 组件与目录结构

过渡期目标结构：

```text
apps/
  web/
    ... 现有 Next.js 应用 ...
    src/lib/desktop-api.ts       # Tauri/Electron/浏览器预览适配层
  desktop/
    src/                         # 临时 TypeScript 应用服务和测试
    src-tauri/
      Cargo.toml
      tauri.conf.json
      capabilities/
        default.json
      icons/
      src/
        main.rs
        commands/
        state/
        error.rs
```

最终目标结构（位于 `src-tauri/src`）：

```text
commands/        # 只放 DTO 校验和 Command 处理器
domain/          # 供应商、路由、诊断、用量领域契约
services/        # 业务编排和事务工作流
storage/         # 设置、供应商、凭据、SQLite
codex/           # 配置 TOML/auth/备份/恢复适配器
gateway/         # 监听器、认证、协议转换、故障转移
platform/        # 托盘、启动项、对话框、剪贴板、通知
updates/         # Release 元数据和允许访问的 URL 处理
```

Command 中不应包含业务工作流。Command 只负责获取受管理状态、调用服务，并将错误映射为统一错误信封。

## 迁移阶段

### 阶段 0：基线与业务提取

**状态：已完成（2026-09-23，源码验收通过）。** 实际交付和验证记录见 `docs/TAURI_STAGE0.zh-CN.md`。Tauri 开发入口和双端切换开关需等阶段 1 创建可运行的 `src-tauri` 后接入；本阶段已保留显式的 `dev:electron` 入口。新源码的安装包级冒烟测试尚未执行，不计入本阶段源码验收。

- 使用现有单元测试和已安装 Electron 冒烟测试，冻结当前行为基线。
- 从 `apps/desktop/src/main/main.ts` 中提取与 Electron 无关的应用编排逻辑。
- 定义 DTO、错误契约和数据目录发现规则。
- 增加开发期选择 Electron 或 Tauri 的 feature flag。

退出标准：当前 Electron 构建和测试套件保持通过；用户可见行为没有变化。

### 阶段 1：Tauri 桌面壳

**状态：开发中（macOS Apple Silicon 的原生构建、预览 DMG 与窗口/单实例基础验证已通过）。** 详细验收记录与跨平台待办见 `docs/TAURI_STAGE1.zh-CN.md`。

- 增加 Rust 工具链和 `apps/desktop/src-tauri`。
- 将现有 `apps/web` 静态构建产物纳入 Tauri resources。
- 增加窗口尺寸、托盘、单实例、关闭到托盘、启动行为和各平台图标。
- 保留浏览器预览 fallback，保持现有 UI 不变。

退出标准：Tauri 开发应用和未签名安装包可以在各支持平台启动，并渲染相同 UI。

### 阶段 2：类型安全的 Tauri 桥接层

**状态：开发中。** 已接入隔离预览壳的只读 Command 和界面偏好，敏感写操作尚未迁移，见 `docs/TAURI_STAGE2.zh-CN.md`。当前尚不满足本阶段“所有 UI 工作流通过 Tauri Command”的退出标准。

- 用 Tauri 实现的 `DesktopApi` 替换 `contextBridge` 实现。
- 增加 Rust Command 注册和临时兼容服务调用。
- 通过白名单 capabilities 实现对话框、剪贴板、opener、通知和托盘交互。
- 在完成行为一致性验证前，保留 Electron 适配层。

退出标准：所有现有 UI 工作流都通过 Tauri Command 执行；渲染层不再导入 Electron 或 Node API。

### 阶段 3：Rust 存储与平台服务

**状态：开发中。** 已完成隔离预览目录的设置持久化、供应商基础 Command 接线、keyring 写入边界、SQLite 统计/清理、网关用量写入及旧 JSON 启动迁移，并接入受限 Codex 沙箱同步/恢复。Electron 凭据迁移已具备加密交接闭环，但真实 keyring、真实 Codex 目录、供应商变更自动同步和平台能力尚未完成。阶段 4 已在隔离预览中并行推进，阶段 5 尚未开始，见 `docs/TAURI_STAGE3.zh-CN.md`。

- 将设置、供应商元数据、原子 JSON 文件、Codex 配置、备份/恢复、对话框、剪贴板、启动项和更新 URL 校验迁移到 Rust。
- 增加到操作系统 keyring 或 Rust 加密存储的凭据迁移。
- 迁移 SQLite 用量仓库，并验证旧数据库兼容性。

退出标准：除网关外的所有操作都可以在没有 TS 原生 sidecar 的情况下由 Tauri 执行；数据通过升级和回滚测试。

### 阶段 4：Rust 网关

**状态：开发中。** 已完成 Rust 监听器、认证、Responses 非流式与原生 SSE 转发、Chat/Anthropic 基础非流式与 SSE 转换、共享协议 blackbox fixture 对照、opaque history 校验、并行 tool-call 合并、停止原因失败映射、客户端断开取消、固定并发、SSE 终止修复、故障转移、进程内熔断、catalog slug 解析、基础多 output/tool-call 合并和 SQLite 多 attempt 用量记录。完整模型目录字段、全部 tool-call 事件语义和 Codex 生命周期同步尚未完成。详细记录见 `docs/TAURI_STAGE4.zh-CN.md`。阶段 3 退出标准仍未达到，因此阶段 4 仅限隔离开发。

- 按前述切片迁移网关。
- 复用协议 fixture 的输入/输出，对比 TypeScript 和 Rust 实现。
- 增加长连接流式响应、取消、超时和端口重绑定测试。

退出标准：Rust 网关通过完整黑盒测试套件和真实安装应用冒烟场景。

### 阶段 5：移除 Electron 和 Node 运行时

- 删除 Electron 依赖、preload、Electron main 入口、Electron builder 配置和临时兼容运行时。
- 保留 Next.js export，并将现有脚本替换为 Tauri build/bundle 命令。
- 更新 README、迁移文档、安全文档、用户指南、发布流程、CI 和产物名称。
- 移除所有 Electron 专用的版本、safeStorage 和安装测试假设。

退出标准：Tauri 打包产物不包含 Electron 二进制、Node sidecar 或无用 Node 运行时文件，并通过发布校验。

## 测试与验收证明

### 契约测试

- TypeScript DTO fixture 反序列化后的语义值必须与 Rust DTO 一致。
- 错误码和可选字段必须保持稳定。
- 含敏感信息的 Command 必须有明确测试，证明元数据响应中不包含 Key。

### 存储测试

- 现有 JSON fixture 可以无变化加载。
- 原子写入中断时不会损坏旧文件。
- SQLite Schema、保留策略、聚合、清理和旧版 JSON 迁移结果与当前实现一致。
- 凭据迁移具备幂等性，并且可以断点续作。

### 网关测试

- 保留现有协议适配器测试，并增加跨运行时 fixture 对比。
- 使用同一套请求样本分别调用 TypeScript 和 Rust 网关实现。
- 校验状态码、请求头、响应体、SSE 事件顺序、用量记录和错误分类。

### 安装应用测试

在可用的 macOS、Windows 和 Linux 环境中执行：

- 使用隔离的用户配置和隔离的 Codex 目录启动；
- 验证单实例聚焦和关闭到托盘；
- 新增、编辑、删除和切换供应商及模型；
- 验证直连供应商模式和本地网关模式；
- 通过模拟上游服务验证所有支持协议的流式响应；
- 停止/退出应用，并验证 Codex 配置恢复；
- 验证渲染层无错误，诊断输出不包含明文敏感信息；
- 检查安装包内容和产物架构。

## 发布与回滚

使用分阶段发布渠道，或使用清晰区分的预发布 Tag：

1. Electron stable 继续作为回滚目标。
2. Tauri 内部构建在 QA 期间使用隔离的用户数据。
3. Tauri beta 使用迁移标记，并支持按文档回退到 Electron。
4. 只有数据、网关和安装应用验收全部通过后，才发布 Tauri stable。

如果没有明确的所有权锁，不允许 Electron 和 Tauri stable 同时修改正在使用的网关/配置状态。Beta 期间要求用户完全退出其中一个应用后再启动另一个，或者使用共享的单实例/数据锁。

打包目标继续保持为 macOS DMG、Windows NSIS、Linux AppImage/deb。签名和公证应与功能迁移分开配置；在具备签名能力前，未签名安装包继续保留当前的手动下载安全提示。

## 风险

- Electron `safeStorage` 数据不能直接透明地迁移到 Rust keyring 实现。
- Tauri 插件 API 以及各平台的启动项/托盘行为会因操作系统和版本而不同。
- Rust 的 HTTP/SSE 取消机制和字节级流行为可能与 Node 不同。
- 如果不在打包模式下测试，Tauri CSP、capabilities 和外部导航可能破坏现有更新/对话框流程。
- 应用标识会影响数据目录、keyring 命名空间以及安装包升级行为。
- 临时 sidecar 保留过久可能形成两个事实来源。
- 更换 SQLite 实现可能改变数字/null 聚合等边界行为。
- 退出时 Codex 配置恢复失败，可能导致外部工具仍然指向已经停止的网关。

缓解措施：迁移前锁定契约；执行双运行时 fixture 对比；让 feature flag 临时存在且可观测；保留回滚副本；删除 Electron 前必须通过安装应用验证。

## 待决问题

以下问题不阻塞当前架构，但必须在开始实施前确定：

- 最终 Tauri 版本使用 Rust keyring 存储，还是使用由平台密钥管理 API 支持的加密文件。
- 手动 GitHub 更新检查是否长期保留，还是未来引入签名的 Tauri updater。
- 当前有哪些 macOS、Windows 和 Linux CI runner 可用于安装应用测试。
- 第一个 Tauri beta 是否可以使用独立的应用标识和用户配置，还是必须支持从 Electron 原地升级。
