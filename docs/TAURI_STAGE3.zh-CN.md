# Tauri 迁移：阶段 3 Rust 存储与平台服务

**状态：开发中；设置/元数据、供应商基础事务、隔离 SQLite 统计与清理已接入，阶段 3 整体未完成。**

## 已实现

- Rust `PreviewStore` 由 Tauri `app.path().app_data_dir()` 初始化，只读写独立预览应用标识 `com.codexkeyswitcher.tauri.preview` 对应的数据目录。它不扫描或复制 Electron `userData`，也不读 `~/.codex`；不会在未获授权时把正式版数据带入预览应用。
- `settings.json` 继续使用旧版扁平键名。界面语言/主题、用量设置已接到 Rust Command，支持重启后读取；写操作在当前进程内串行化、通过同目录临时文件替换，Unix 设目录 `0700`、文件 `0600`。文件损坏、路径异常或权限错误时失败，不静默覆盖旧数据。
- `providers.json` 只读解析 `{ providers, currentId }` 的旧结构。按 `Provider` 元数据字段白名单和类型过滤；忽略历史内嵌 Key 与未知字段。Tauri Command 已接入供应商保存、删除、设置当前供应商和切换模型；API Key 写入独立系统 keyring，元数据原子写入独立 Tauri 数据目录。旧 Electron 内嵌凭据会拒绝重写，避免误覆盖。
- 用量设置按范围归一化后返回。Rust 使用 `rusqlite` 读取独立预览目录的 `usage.sqlite`，并已从受限的 Responses 非流式/SSE 网关记录结构化状态、耗时和 token usage；默认关闭时不创建数据库。数据对齐最终尝试汇总、8 天趋势、供应商/模型聚合和日志分页；保留天数与最大条数裁剪在现有 recorder 中执行。`usage_clear_logs` 仅清除预览目录中已存在的 SQLite 记录。当前已支持受限故障转移，每次 attempt 分别记录，统计汇总只计算最终 attempt；熔断状态机尚未迁移。
- `SystemKeyring` 使用独立的 `com.codexkeyswitcher.tauri.preview.credentials` 服务名，提供读写删除凭据的 Rust 接口；目前没有生产调用方，没有触碰真实系统 Keychain。系统密钥库不可用时预设为失败关闭，不回退明文文件。
- 已增加显式凭据迁移闭环：Electron 仅在用户通过设置页输入迁移口令并选择导出路径后，使用现有 `safeStorage` 解密并生成 AES-256-GCM/PBKDF2 v2 加密包；Tauri 通过文件选择器和口令读取后，由 Rust 校验供应商元数据和凭据关联，写入独立 keyring，再原子保存供应商元数据和完成标记。迁移只允许写入空的 Tauri 目标供应商目录，避免覆盖已有预览数据；导入失败会恢复元数据并删除本轮写入的 keyring 条目，回滚失败会返回独立错误码，重复导入会被拒绝。迁移包不会自动上传或写入普通日志。导入成功后由用户确认关闭旧版 Electron 并手动删除迁移包，避免应用擅自删除用户文件。
- Rust `save_provider` 服务先校验供应商，再保存凭据与元数据；元数据失败时恢复旧凭据，同进程并发保存串行化。网关运行期间，供应商保存、删除、切换当前供应商和切换模型会自动同步隔离 Codex 沙箱；同步失败会恢复供应商元数据与本轮凭据，避免网关和 Codex 状态分叉。
- Rust `ManagedCodexFiles` 使用 TOML/JSON 解析器改写模型、目标供应商地址及 `auth.json`。`CodexState` 已连接 Tauri Command，可在用户显式创建的 `PreviewStore/codex-sandbox` 内测试 Responses 直连配置同步、网关配置同步、首次备份、重复应用和恢复；默认 `~/.codex` 与任何外部目录都会被拒绝写入。网关启停和供应商/模型变更会在网关运行期间自动同步，诊断页仍提供手动重同步/恢复，显式退出时尝试恢复。尚未证明与 Electron 模型目录和配置转换行为完全一致，也未接入真实 Codex 目录。
- 旧 `usage-records.json` 迁移已接入 Tauri Preview 启动，只检查独立的 `app_data_dir`，不扫描 Electron 数据目录。旧文件不存在时正常跳过且不创建数据库；有效旧文件可在首次启动时创建 `usage.sqlite` 并事务导入，提交后写迁移标记，重复启动不会重复导入，也不会覆盖已有 `.migrated` 归档。损坏旧 JSON 会保留原文件、记录本地错误并继续启动，且不会新建或改动数据库；已有 SQLite 无法通过完整性或 schema 校验时阻止启动，避免继续写入可疑数据库。历史用量的全部真实格式仍未完成对照验证。
- Windows 文件替换有单独的条件编译路径；当前只在 macOS Apple Silicon 上执行 Rust 测试，Windows 实机覆盖替换语义之前不能视为跨平台验收。

## 2026-09-30 生命周期补齐

- Tauri 网关启动、停止和保存路由设置现在共用同一事务边界：启动后自动同步隔离 `codex-sandbox` 的 `config.toml`/`auth.json`，停止时先停止监听再恢复备份。
- 启动同步失败会停止本轮新建的网关并恢复路由设置；停止恢复失败会尝试重启网关并重新同步，避免 Codex 留在已停止的端点上。
- `autoStart=true` 且路由启用时，Preview 重启会自动启动网关并同步沙箱；更新下载 Command 已补充到 Tauri 注册表。
- Rust 网关测试在允许本机临时回环监听的环境中 93 项全部通过；浏览器桥接测试 9 项全部通过，前端 typecheck/lint 通过。
- 供应商变更回归已接入 Command：网关运行时保存、删除、切换当前供应商和切换模型会同步沙箱；同步失败会恢复原供应商文档和凭据，运行中的网关不会允许删除最后一个供应商。
- 网关路由设置中的回环监听端口已经真正接入 Rust 监听器；修改运行中端口会执行停止、恢复、重新绑定和同步，失败时回滚到旧端口，端口检测不再返回 `NOT_MIGRATED`。
- Tauri 已支持 `direct_provider` 生命周期：直连模式停止本地监听，将当前 Responses 供应商的 Base URL、Key 和模型写入隔离 Codex 沙箱；切回本地路由或停用时恢复原配置，供应商/模型变更会自动重写直连配置。
- Rust 已生成隔离模型 Catalog：按连接模式使用真实上游模型名或 `ks-{providerId}-{alias}` slug，读取隔离 `models_cache.json` 模板，写入私有 `model-catalogs/current.json` 并在 `config.toml` 顶层设置 `model_catalog_json`。
- 新增共享 `apps/desktop/fixtures/model-catalog-blackbox.json`，Electron 与 Rust 都执行 Catalog 契约测试，覆盖版本/ETag、缓存模板继承、模式 slug、推理能力和图片输入字段。
- Tauri 更新下载、发布说明打开、诊断报告复制、准备卸载和打开隔离恢复目录已接入；更新地址限制在本项目 GitHub Releases，恢复目录只允许 Preview 私有数据目录。
- Tauri 凭据迁移导出已接入：从隔离 Keyring 读取 Key，使用 AES-256-GCM/PBKDF2 v2 加密并通过原生保存对话框独占创建文件；导出结果不写明文 Key。

## 风险与后续

- `settings.json` 并发写保护目前是单进程锁。预览壳有单实例插件，但未来如果引入 sidecar 或多进程存储，必须补跨进程所有权锁。
- 已有用户数据格式兼容只在**隔离样本**上验证；真实 Electron `safeStorage` 密文不能直接交给 Rust 解码。需要设计明确的解密迁移/回滚流程，且在 macOS、Windows、Linux 上分别验证数据目录与密钥命名空间。
- 供应商内部事务已与 Tauri UI 接线；Electron `safeStorage` 凭据一次性迁移和进程内失败回滚已实现，但仍需在 macOS、Windows、Linux 的真实 keyring 上验证，并补充 Electron/Tauri 两端真实用户数据目录的升级演练。模型目录对照、真实 Codex 目录的显式授权/恢复脚本、旧 `usage-records.json` 完整格式对照、系统对话框/真实启动项能力仍未完成。完成它们之前，不得将 Tauri 预览版作为正式可用版本发布。
- Windows、Linux 原生编译及安装包验证、阶段 1 截图/托盘验收均仍待补齐。

## 本轮验证

### 加密交接与中断恢复

- 迁移文件使用 v2 加密信封：Node `crypto` 加密、Rust `ring` 解密，AES-256-GCM、PBKDF2-SHA256（600000 次）、随机 16 字节盐和 12 字节 nonce，固定附加认证数据。完整供应商数据与 API Key 均在密文内；口令不写入文件。导入 Command 拒绝 v1 明文信封，旧文件须从 Electron 重新导出。
- 口令要求至少 16 个 Unicode 字符、不超过 1024 UTF-8 字节。前端限制文件 6 MiB，Rust 限制密文和解密后数据大小。PBKDF2 在后台线程执行。口令、损坏文件与认证失败统一返回脱敏错误，不输出解密内容。
- 导出使用独占创建，不覆盖已有文件、不修改用户所选父目录权限；供应商缺失凭据或列表为空时拒绝导出。失败的部分输出仍只有密文，不会回退明文。
- 新增私有 `credential-migration-journal.json`：写凭据之前持久化本轮拥有的 ID 与空目标元数据快照，不记录 API Key。下次显式提交有效加密包时，锁内先恢复日志：未提交事务删除本轮凭据并恢复原元数据后重新导入，已提交事务仅清理日志，不删除已提交凭据。恢复失败保留日志，供应商修改和 Codex 凭据读取均拒绝继续。
- 重启恢复是“显式重试时回滚再导入”，不是启动时自动读取凭据，也不是逐条断点续传。日志保护依赖单实例进程和独立 keyring 命名空间；同用户外部进程恶意修改数据不在该保护边界内。测试模拟重开存储与中断位置，尚未完成真实断电、Windows/Linux 文件持久化和系统 keyring 故障演练。
- 本轮 Rust 51 项通过，含 Node/Rust 加密互通、错误口令、篡改与旧明文拒绝、中断后重试、提交后清理。TypeScript Web 8、Core 16、Desktop 73 项通过，1 项跳过；lint/typecheck 通过。口令仍会短暂存在于 UI/IPC/原生内存，不能宣称所有副本均能可靠清零。加密安全性依赖强口令，不能与迁移文件一同分享口令。

### 2026-09-28 原生验证补验

- 更正此前“本机未安装 Rust”的判断：工具链已安装在 `$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin`，但未加入 `PATH`。本轮使用该路径执行原生验证，没有操作真实 Keychain 或 `~/.codex`。
- 修复迁移完成标记的 Rust 括号错误，以及 `ProviderInput` 将前端 `baseURL` 错误映射为 `baseUrl` 的跨端契约错误；新增真实 JSON 输入反序列化测试。
- 迁移增加锁内完成状态复查、原始目标元数据检查、缺少凭据拒绝及目标 keyring 同名凭据冲突拒绝。将写入后报错的凭据也纳入回滚，避免部分写入遗漏；补充第二次 keyring 写入失败、回滚删除失败和完成标记写入失败测试。
- 修复 macOS 接受连接可能继承非阻塞模式引起的间歇性 Broken pipe，新增连接后延迟发送和拆分请求头回归测试。
- 退出时不再吞掉停止/恢复错误：任一步失败均取消退出并显示主窗口，保留备份。该分支尚未完成原生窗口交互验收。
- `cargo test --locked --offline`：48 项通过（需允许本机回环监听）；`cargo fmt --check`、`pnpm lint`、`pnpm typecheck` 通过；TypeScript 测试 Web 8 项、Core 16 项、Desktop 71 项通过，1 项跳过。
- `cargo build --release --features custom-protocol --locked --offline` 成功产出 macOS arm64 原生二进制，未打包或启动安装应用。仍有用量写入/迁移未接线的 `dead_code` 警告；本机 `rust-objcopy` 缺少 `libLLVM.dylib`，调试信息裁剪发出警告但构建退出码为 0，后续发布前需修复工具链并复验产物。
- 新增 `test:rust`、`check:rust-format`、`build:rust` 桌面脚本；CI 新增手动触发和原生 release 编译。当前验证结果来自本机，未提交或推送代码，未触发远端 CI。

复现原生验证（macOS Apple Silicon 当前机器）：

```sh
export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"
pnpm --filter @codex-key-switcher/desktop check:rust-format
pnpm --filter @codex-key-switcher/desktop test:rust
pnpm --filter @codex-key-switcher/desktop build:rust
```

### 2026-09-29 用量启动迁移

- Tauri Preview 启动时在独立数据目录自动检查旧 `usage-records.json`。缺失文件保持无操作，默认关闭用量记录时仍不会无故创建 SQLite。
- 迁移在解析完整旧 JSON 后才创建或打开数据库；损坏 JSON 不改动数据库。已有数据库执行 `PRAGMA quick_check` 和必需列校验，失败时阻止预览应用继续启动；已有 `.migrated` 文件不会被覆盖。
- Rust 测试新增首次建库迁移、缺失文件无操作、损坏文件不建库和异常 SQLite 不改动等覆盖；完整原生套件 92 项通过（需允许绑定本机临时回环端口）。`cargo check --locked --offline` 通过；本轮 macOS arm64 Rust release 编译和未签名 `.app` bundle 构建成功，bundle identifier 为 `com.codexkeyswitcher.tauri.preview`，未签名 `codesign --verify` 不通过符合预期。CI 已增加 macOS arm64、Windows x64、Linux x64 Tauri 构建矩阵；Windows/Linux 安装后启动、系统密钥库、正式签名和真实 Electron 数据目录升级演练仍未完成。
- 本机 `.app` 已实际启动并按独立 Bundle Identifier 置前，窗口和设置页完成视觉渲染检查；macOS Accessibility 未暴露 WebView 内部控件，设置页自动点击/持久化尚未完成可重复的机器验证。
- 本机已通过人工校准 Retina 坐标完成深色主题持久化：Preview 写入隔离 `settings.json`，退出重启后主题恢复；未填写供应商 Key，未访问真实 `~/.codex`。
- Tauri Preview UI 已解锁隔离本地网关、故障转移、更新、诊断和凭据迁移；供应商切换后网关状态返回当前供应商/模型。仍保留禁用的仅是包含 Key 的普通配置导出，凭据继续走加密迁移包。
- 模型在线检测已接入 Tauri Rust Command，支持 Responses、Chat Completions、Anthropic Messages 三种协议；检测 Key 只在原生内存中使用，响应仅返回状态、耗时和截断摘要，不写入请求日志。
- 上游模型列表拉取已接入 Tauri Rust Command，支持常见 `data/models` 嵌套返回和 `id/name/model` 字段去重；响应限制 8 MiB、超时 20 秒、禁止重定向，Key 不写入日志或返回结果。
- 供应商元数据导出/导入已接入 Tauri 原生文件对话框：普通导出不包含 API Key，使用独占创建且不覆盖已有文件；导入限制 JSON 文件大小、拒绝符号链接/目录、内嵌明文 Key、重复 ID 和覆盖已有供应商。包含 Key 的迁移导出使用 AES-256-GCM/PBKDF2 加密包，并通过独占创建写入用户选择的文件。
- 供应商业务闭环已补齐当前状态反馈：保存、删除、切换当前供应商后会刷新网关状态；编辑供应商留空 API Key 会保留隔离凭据。Tauri Preview 继续只使用隔离 Keyring 和数据目录。
- Tauri Preview 已接入模型连通性检测：按供应商协议向 Responses/Chat Completions/Anthropic endpoint 发送最小请求，Key 只在 Rust 内存中使用，返回状态、耗时和截断摘要，不写入请求日志。
- 新增供应商生命周期回归：保存两个供应商、切换当前供应商、重新打开 PreviewStore、编辑时留空 API Key，元数据/currentId/原隔离凭据均保持一致。
- 新增隔离网关端到端回归：真实 GatewayState 启动本机监听，向 mock Responses 上游发送请求，记录 SQLite usage，停止网关后重新打开 PreviewStore，供应商元数据和 currentId 仍保持一致。
- 当前业务闭环已覆盖供应商保存/切换/重开、隔离网关真实请求和 SQLite 用量记录；下一步是把 Codex 沙箱同步/恢复与网关启停做成同一条可验收流程。
- Codex 沙箱联合闭环已完成：隔离网关启动后同步 loopback endpoint 和本地 gateway token 到沙箱配置，诊断状态按网关 endpoint 判断；停止网关后恢复原始 config.toml/auth.json 并清理备份。

仍未关闭的安全与发布条件：加密迁移包仍依赖用户强口令，口令不能与文件一同分享；口令会短暂存在于 UI/IPC/原生内存，不能宣称所有副本均能可靠清零。进程恢复是显式重试回滚，不是完整断点续传。真实 Keychain、Windows/Linux、安装包和跨进程所有权仍需验收；模型目录和供应商 CRUD 后自动同步尚未接入。

### 历史记录

- 2026-09-24 最新验收：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`cargo test --locked`、`cargo fmt --check`、Tauri release 无安装包构建与 `git diff --check` 均通过。TypeScript 测试 Web 6 项、Core 16 项、Desktop 71 项通过，另 1 项跳过；Rust 35 项通过。供应商 Command 接线后，Tauri release 与 Electron 构建均串行通过。
- `.github/workflows/ci.yml` 已加入 macOS 前端静态构建、Rust 格式与单元测试作业；本轮仅本地执行，远端 CI 运行结果尚未验证。
- Electron 与 Tauri 构建不能并发执行：两者都会运行 `next build` 并写同一个 `apps/web/.next`。本轮并发验证时 Electron 构建曾缺少 `middleware-manifest.json`；待 Tauri 构建结束后串行重跑 `pnpm build` 已通过。这是构建命令争用同一输出目录，不计为源码编译回归；CI 必须串行或隔离 Next.js 输出目录。
- Rust 测试在临时目录中覆盖设置、并发供应商保存、凭据失败回滚、故障转移设置保留、Codex 备份/恢复与中途写入失败、旧 JSON 用量启动迁移与幂等性、SQLite 统计/清理/网关记录及隔离写入保留策略，以及使用内存替身的 keyring 接口。真实旧 JSON 格式全量对照、平台 keyring 和跨平台验收仍未关闭。
- 尚未在真实 Windows/Linux、真实 Keychain 或本轮已安装预览包中验证，也未验证 Electron 凭据迁移及真实 Codex 配置恢复。用量写入、JSON 迁移、Codex 文件服务仍有未接线的 `dead_code` 警告。阶段 3 退出标准未达到；阶段 4 已开始但仅完成监听器/健康检查基座，尚未进入真实协议转发。
- 本轮新增迁移包契约、Electron 导出入口、Tauri 导入 Command、完成标记和隔离测试；本机没有 `cargo`，Rust 测试尚未重新执行，需由 macOS CI 或安装 Rust stable 后补跑 `cargo fmt --check` 与 `cargo test --locked`。
- Tauri 已接入 macOS/Linux 当前用户开机自启配置和 `--hidden` 启动参数；Windows 当前返回不支持，不伪造成功状态。真实系统启动项和 Keychain 仍需目标平台实机验收。
