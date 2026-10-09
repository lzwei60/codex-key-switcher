# Tauri 迁移：阶段 4 Rust 网关

**状态：开发中；已接入 Responses 非流式与原生 SSE 转发、故障转移、熔断状态机和多 attempt 用量记录，完整阶段 4 未完成。**

## 已完成切片

- `apps/desktop/src-tauri/src/gateway.rs` 提供独立的 Rust TCP 监听器，默认绑定 `127.0.0.1:0`，由操作系统分配隔离临时端口。
- `gateway_start`、`gateway_stop`、`gateway_status` 已注册为 Tauri Command；前端 Tauri 适配器已调用启动/停止命令。
- `/__health` 和 `/v1/__health` 返回预览健康信息；`/__status` 返回空当前供应商状态。
- 普通请求先校验独立 Tauri 数据目录中的本地网关 Token；未认证返回 401。`POST /v1/responses`（或 `/responses`）按请求读取当前供应商、候选供应商和独立 keyring 中的 API Key，通过 `reqwest` 向 Responses、Chat Completions 或 Anthropic Messages 上游转发；非 Responses 协议的请求体、非流式响应和基础 SSE 文本/tool-call 事件会转换回 Responses 格式。原生 Responses 事件 chunk 保持不变；Rust 追踪 `response.completed/failed/incomplete/error` 终止事件，若上游提前结束则在已发内容后追加带原 response ID 的 `response.failed`，不伪造成功终止。故障转移按供应商 priority 和备用模型映射处理凭据错误、网络/超时和未发送响应字节的 5xx；4xx 和已开始流式输出的请求不重试。
- 上游客户端使用 HTTPS 证书校验、请求总超时、禁用环境代理和自动重定向；上游返回 3xx 时不跟随跳转，避免携带 API Key 前往其他地址。请求体限制 8 MiB，上游响应读取限制 64 MiB；错误响应不记录或返回凭据。主供应商支持 upstream 名称、显示别名和 `ks-{providerId}-{model}` catalog slug，未知模型仍返回 400；完整模型目录字段和所有 Electron 别名兼容仍未完成，因此不能替代 Electron 的完整网关。
- 网关请求解析已增加完整 `Content-Length` 读取、32 KiB 请求头上限、8 MiB 请求体上限；缺失或重复长度、`Transfer-Encoding` 返回 400，超限返回 413。拆分发送的请求体也会完整读取；仅通过认证、协议和模型校验的非流式 Responses 请求进入上游转发。
- Tauri Preview 已使用保存的 `listenPort` 绑定固定回环端口；端口检测通过专用 Command 执行，端口占用返回稳定错误码。运行中的端口变更会先恢复沙箱、重新绑定新端口并同步，失败时按旧端口回滚。
- 监听器使用固定的 8 个请求工作线程上限；慢上游不会阻塞 accept 循环或健康检查，满载连接会被有界拒绝。停止时会等待已接受的请求结束。上游转发使用异步 reqwest，在客户端 EOF/断开时取消上游 future；取消专项测试已覆盖，不再等待 120 秒总超时。
- 启动具有幂等性，停止会通知监听线程退出；应用显式退出时停止网关线程。

## 测试验收

- Rust 测试覆盖临时回环端口、健康检查、无供应商 503、重复启动、请求解析、本地模拟上游的 Bearer 认证、模型校验、状态码和 JSON 响应、重定向拒绝及未迁移协议拒绝。
- SSE 事件语义使用 Electron/Rust 共用 fixture 对照：覆盖原生 created/delta/completed、failed/incomplete/error、CRLF、心跳、多字节 UTF-8 任意字节边界和截断终止。Rust 对完整原生流字节透传；上游只发文本 delta 或 completed-only 文本时，Rust 补齐 Responses message 生命周期及 completed output；从 completed usage 解析 input/output/cached token 并放回修复后的 completed payload；文本修复流会按 output item id 合并 function call，避免 completed payload 与 `output_item.done` 重复。认证后的非流式和 SSE Responses 尝试已写入隔离 SQLite 并接入统计服务；客户端断开记录为 499，凭据错误记录为 503，正文和凭据不入库。故障转移 attempt 也分别记录，最终 attempt 才参与汇总。
- 当前仍需补充：更完整的 Responses/Chat/Anthropic 边缘字段与全部 tool-call 事件语义、模型目录与真实 Electron/Codex 缓存的全字段对照、上游超时细粒度错误映射。本轮已建立共享 `protocol-blackbox.json` 和 `model-catalog-blackbox.json`，Rust 与 Electron 均验证相同的 Catalog 版本、ETag、缓存模板继承、直连/网关 slug、推理能力和图片输入覆盖；本机 Codex CLI 的隔离 app-server 已验证生成目录字段及部分真实 `turn/start` 流程（文本、简单工具、短会话与单张 PNG），但未验证真实账户缓存的全字段。熔断状态只存在当前 Tauri Preview 网关进程内，重启后清零，不写入 SQLite；当前每个请求占用一个固定工作线程，不能作为正式可用网关发布。
- Tauri Preview UI 已接通隔离网关启停、直连供应商模式、故障转移开关、更新下载、诊断报告复制、准备卸载和恢复目录打开；活动模式下的供应商/模型变更会自动同步 Codex 沙箱。尚未迁移的包含 Key 导出入口会显式禁用，不再制造点击后失败的死流程。
- 供应商表单的模型在线检测、上游模型列表拉取、更新下载和诊断报告复制均已通过 Rust Command 接入。
- 供应商元数据导出/导入已接入 Tauri 原生文件对话框并在 Preview UI 开放；普通导出不包含 API Key，包含 Key 的导出使用加密迁移包。
- 已增加真实隔离网关端到端测试：GatewayState 启动、Bearer 认证、mock 上游 Responses 转发、SQLite 用量记录、停止和存储重开恢复均在同一用例内验证。
- 网关与 Codex 沙箱已完成联合验证：启动操作只在网关成功监听后把隔离 loopback endpoint 和 token 写入 `codex-sandbox`，停止操作先停止网关再恢复原文件；恢复失败会尝试重启并重新同步，避免 Codex 继续指向已停止的 Preview 网关。`autoStart` 在 Preview 重启时也复用同一生命周期。
- 阶段 3 的真实平台凭据迁移和跨平台验收也尚未关闭。预览应用继续使用独立标识，不会修改真实 `~/.codex`。

2026-09-30 本轮验收：Rust 测试 95 项通过（需允许绑定本机临时回环端口）；Web 10 项、Core 16 项、Desktop 77 项通过，Desktop 另有 1 项既有跳过；lint、typecheck、Rust 格式检查和完整构建通过。补齐网关启停与 Codex 沙箱同步/恢复事务、Preview 自动启动恢复、更新与诊断 Command、固定回环端口、端口占用检测和端口变更回滚，接入基础直连供应商生命周期、Rust 模型 Catalog 生成/契约测试、加密凭据导出和 macOS/Linux 启动项配置。上游使用本地模拟服务；按请求未进行安装发布验收，真实 Keychain、Windows 启动项和正式签名仍需目标环境验证。

2026-10-08 协议对照补验：新增 Electron/Rust 共用的 Responses 上游兼容用例。Rust 现在与 Electron 一样，对非 OpenAI 上游移除不支持的托管工具及对应选择、把过小的输出 token 上限提高到 16，并递归移除 Codex 内部 `namespace` 元数据；OpenAI 上游保留托管工具与原 token 上限。Chat/Anthropic 转换器遇到图片或文件历史时明确返回 400，不再静默丢弃附件。全仓 lint、typecheck、TypeScript 测试（Web 10、Core 16、Desktop 79 通过及 1 跳过）、Rust 格式检查与 97 项 Rust 测试通过。这里证明的是共享 fixture 和本地模拟服务行为；当时尚未完成 app-server 模型目录字段及全部流式事件验收，也未证明 Windows/Linux 安装应用兼容。

2026-10-08 模型目录补验：使用本机 `codex-cli 0.142.0` 的 app-server、独立临时 `HOME`/`CODEX_HOME` 和不可达的模拟上游，验证 Electron 与 Rust 生成的无缓存及缓存模板目录，并覆盖本地网关和直连两种 slug。校验 `model/list` 中的 slug、名称、描述、可见性、默认/支持推理档位和输入模态，再逐个执行不产生模型请求的 `thread/start`。测试子进程不继承 API Key 或正式 Codex 配置；没有执行 `turn/start`。桌面端 80 项、Rust 98 项测试通过，桌面 lint/typecheck、Rust 格式检查与既有 macOS arm64 Preview bundle 静态验证通过。这是本机 CLI 兼容性证据，不代表桌面 Codex 应用、真实登录态或跨平台安装验收。

2026-10-08 最小真实轮次补验：新增 `verify-codex-turn.mjs`，用临时 `HOME`/`CODEX_HOME`、合成 API Key、本机模拟 Responses SSE 上游验证 app-server 的 `thread/start` → `turn/start` → 助手文本 `item/completed` → `turn/completed`，并检查上游请求的模型、Bearer 和流式开关。Electron 与 Rust 生成的本地网关模型目录均通过这条最小文本轮次；Desktop 80 项、Rust 98 项全量测试通过。app-server 的 `turn/completed` 只返回 `itemsView: notLoaded`，文本须从 `item/completed` 读取。此测试没有经过 Tauri 网关本体，不覆盖工具调用、多模态、故障转移或全部 SSE 事件；阶段 4 仍未完成。

2026-10-08 网关联合补验：另增 Rust 隔离测试，使用临时 PreviewStore、内存凭据后端和合成 Key，将 Codex app-server 的 `turn/start` 真正接到 Tauri 网关，再到本机模拟 Responses SSE 上游。测试检查上游收到真实模型名与流式请求，app-server 收到完整助手文本和 5/1 token 用量，并在结束后停止网关、恢复隔离 Codex 配置。此前的 app-server 直连模拟测试仍保留。Desktop 80 项和 Rust 99 项全量测试通过。此链路尚未覆盖工具调用、图片/文件、全部错误事件、故障转移与真实平台 Keyring，不构成阶段 4 或发布验收完成。

2026-10-09 流式失败联合补验：同一隔离链路增加 `response.failed` 情景。模拟上游始终返回失败终止事件，允许 app-server 自身重试后确认最终 `turn/completed.status=failed`，且不会产生伪造的成功助手消息；成功情景仍核对文本和用量。直连模拟上游及经过 Tauri 网关两条路径都通过。Codex 0.142.0 对此类失败会重试约数秒，故该可选冒烟用例使用独立测试超时。其他流式错误形态和工具调用仍需继续验收。

2026-10-09 工具调用联合补验：使用 Codex 0.142.0 实际公布的 `exec_command` schema，让模拟上游返回 `function_call` 请求；app-server 仅在临时工作目录运行 `pwd`，以 `function_call_output` 发起第二次模型请求，再收到最终助手文本。直连模拟上游和经 Tauri 网关两条链路均检查调用 ID、真实临时目录输出、最终消息；测试进程禁用插件和应用功能，避免后台插件写入造成清理竞态。此证据只覆盖单个无副作用命令，不代表并行工具调用、长会话、图片/文件或真实用户环境完成验收。

2026-10-09 并行工具联合补验：模拟上游在同一 Responses 轮次返回两个 `exec_command` 调用（临时目录 `pwd` 和无文件写入的 `printf`）。Codex app-server 分别完成命令，并在同一个后续请求中带回两个不同 `call_id` 的 `function_call_output`；直连模拟上游与 Tauri 网关路径都验证了各自的真实输出和最终助手消息。这里仅覆盖两个简单命令及单次后续请求，不代表多轮并发、取消、审批或其他工具类型完成验收。

2026-10-09 同线程多轮联合补验：在同一 `threadId` 连续执行两次 `turn/start`，按各自 `turn.id` 等待完成通知，并核对两轮不同的助手文本。直连模拟上游和经 Tauri 网关的模拟上游都检查第二次请求包含首轮用户消息、首轮助手回复及第二轮用户消息，证明短会话上下文能够经网关传递。仅覆盖两轮文本会话；长会话压缩、取消/恢复、跨进程持久化及图片/文件仍未验收。

2026-10-09 图片输入联合补验：通过 app-server `localImage` 把仓库内的有效 PNG 复制到隔离临时目录，再经直连和 Tauri 网关两条路径向本机模拟 Responses 上游发起 `turn/start`。两侧均检查上游收到 `input_image` 数据 URL，解码字节与原 PNG 完全相同，并收到最终助手消息。最初使用的手写 1 像素样本无法被 Codex 处理，已改用仓库现有有效图片；该用例不会接触用户图片。这里只覆盖单张 PNG 的原生 Responses 透传，不包含远程图片、文件附件、图片历史、格式/尺寸边界或 Chat/Anthropic 转换。

2026-10-09 图片历史联合补验：在同一线程首轮发送隔离的有效 PNG，第二轮只发送追问文本。直连模拟上游与 Tauri 网关联合测试均确认第二次上游请求保留首轮用户文字及 `input_image`，PNG 解码字节与原图完全一致，同时包含首轮助手回复和第二轮追问；两次 `turn.id` 各自完成。网关已有通用 8 MiB 请求体上限与 413 测试，同样适用于包含图片的 JSON 请求，但本用例未测试超限图片、远程图片、多图、文件附件及长会话压缩。

2026-10-09 多图历史联合补验：首轮在隔离目录提交两张内容不同的有效 PNG，第二轮只发追问。直连模拟上游及经 Tauri 网关的模拟上游，均检查两次请求中 `input_image` 数量为 2、顺序不变且各自解码字节与对应原图一致；第二轮还保留首轮用户文字、助手回复及追问。这里仅证明两张小型本地 PNG 的短会话历史，不覆盖图片超限、其他格式、远程图片、文件附件和长会话压缩。

历史记录：先前锁文件虽含 `reqwest` 间接依赖，本机没有对应源码且 crates.io 访问失败，因此仅保留监听器/认证切片。本轮已下载并锁定 `reqwest` 的 rustls 依赖，采用成熟客户端完成非流式切片；未恢复手写 TCP 上游转发。

## 风险

当前仅支持受限的 Responses 非流式/SSE 转发，不能将 `gateway_start` 的成功理解为 Codex 已可以完整通过 Tauri 路由访问上游。上一轮短暂尝试的手写 TCP 上游转发已移除；本轮使用成熟 HTTP 客户端处理 HTTPS。完整黑盒协议对照和安装应用验收通过前，不会进入发布或阶段 5。
