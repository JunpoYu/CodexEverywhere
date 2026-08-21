# CodexEverywhere v0.4 架构与产品规格

本文档是 v0.4 的架构事实源。协议字段、schema 和标识符使用英文；产品界面把 app-server `thread` 称为“任务”。

## 1. 目标与非目标

CE 的目标是在 Linux/HPC 上提供最短路径的 Codex Web/PWA 控制面，并保留现有 Unix、SSH、文件系统和 Codex 安全边界。

必须保持：

- Codex app-server 是 thread、turn、工具、审批和执行状态的唯一事实源；
- 每位 Unix 用户运行一个 Agent 和一个长期 app-server；
- 用户各自持有 `~/.codex` 和 ChatGPT/Codex 身份；
- Direct 和无状态 E2EE Relay 均可使用，Direct 不依赖 Relay；
- Web/TUI/Queue 可同时引用同一任务，设备切换不停止活动 turn；
- CentOS 7、Node.js 20、glibc 2.17、tmux/crontab watchdog 可运行。

明确不做：

- 第二套 AgentLoop、组织治理、计费、资源配额或复杂 RBAC；
- Web Terminal 或第二套 HPC 调度器；
- Cordis 或第三方插件加载器；
- Side 临时支线、`thread/fork`、浏览器 `auth.json` 上传；
- v0.4 首版的 Schedule、Push 和完整文件管理。

## 2. 系统拓扑

```mermaid
flowchart TB
  Browser["React PWA"]
  Direct["Direct WebSocket + Noise"]
  Relay["无状态 Relay\n只见密文"]
  Agent["用户 UID 下的 CE Agent"]
  AppServer["唯一长期 Codex app-server"]
  UserDb["UserStateDatabase"]
  AdminBrowser["独立 Admin PWA 路由"]
  AdminRelay["host-admin Relay route"]
  Controller["无特权 Admin Controller"]
  Helper["高层级 sudo helper"]
  AdminDb["AdminStateDatabase"]

  Browser --> Direct --> Agent
  Browser --> Relay --> Agent
  Agent --> AppServer
  Agent --> UserDb
  AdminBrowser --> AdminRelay --> Controller
  Controller --> Helper
  Helper --> AdminDb
```

Relay wire protocol 和 Noise transport handshake 继续使用 version 1。业务明文只存在于浏览器和目标 Agent 的 Noise 会话内；Relay 不拥有 Gateway Router、用户数据库或解密密钥。

## 3. 轻量内核

`packages/kernel` 只提供四项通用能力：

### 3.1 ServiceRegistry

- 使用类型化 token 注册和读取服务；
- 重复注册、seal 后写入、缺失服务立即抛错；
- 模块由 composition root 显式装配，不扫描目录或动态加载用户代码。

### 3.2 Scope

- 每个 scope 拥有 AbortSignal、子 scope、timer、listener 和 disposer；
- `close()` 幂等，按注册逆序异步释放；
- disposer 聚合失败，但继续释放其余资源；
- Agent 的 app-server client、Gateway session、lease、循环和 Web actor effect 都必须有明确 scope owner。

### 3.3 TypedEventBus

- 事件名和 payload 由 `EventMap` 在编译期约束；
- 只用于控制面瞬时事件，不持久化 app-server 会话状态；
- 订阅取消由所属 scope 管理。

### 3.4 Actor

- reducer 是纯函数，只返回新状态和 effect；
- 会启动、替换或终止异步工作的事件递增 generation，并取消上一代 effect scope；
- reducer 可将不产生 effect 的输入、通知等纯状态事件显式标记为 `preserveEffects`，避免误取消当前工作；
- 旧 generation 的异步结果不能 dispatch 到新状态；
- React 通过 `useSyncExternalStore` 订阅，不使用 Redux 或 XState。

## 4. Gateway API v2

`packages/protocol/src/v2` 是 Agent 与 Web 的共享契约。Zod schema 是运行时边界，TypeScript input/output 从 schema 推导。

每个方法必须声明：

| 字段          | 取值                           | 语义                               |
| ------------- | ------------------------------ | ---------------------------------- |
| `access`      | `pre-auth \| user \| admin`    | Router 统一鉴权                    |
| `kind`        | `query \| mutation`            | query 禁止 operation key           |
| `idempotency` | `none \| ephemeral \| durable` | mutation 必须有 UUID operation key |
| `capability`  | 可选字符串                     | 握手协商后才开放特性               |

Router 在 handler 前依次完成 envelope 版本、方法、input schema、当前设备/票据、access、capability 和 operation key 校验；handler output 也必须通过 schema。未知方法、错误身份域或缺少 mutation key 均失败关闭。

### 4.1 方法组

- `host/*`：连通性和 Gateway 版本；
- `auth/*`：Passkey、OPAQUE 密码、恢复码、状态和轮换；
- `setup/*`：网络、Codex 安装/版本、设备码登录、退出、app-server 重启；
- `workspace/*`：授权 root、浏览、增删和默认项；
- `thread/*`：列表、打开、历史、创建、关闭、命名、归档、删除、设置和 TUI handoff；
- `turn/*`：发送与中断；
- `interaction/*`：审批、用户问题和 MCP elicitation；
- `queue/*`：全局/任务列表、添加、移除、Steer 和 indeterminate 确认；
- `preferences/*`：用户偏好；
- `mutation/status`：durable mutation 权威对账；
- `admin/*`：宿主状态、NSS 精确检查、登记、启停、移除、恢复交接和审计。

v2 registry 永久排除 `thread/fork`、全部 `side/*` 和 `setup/codex/auth/import`。

### 4.2 版本协商

- Noise handshake：version 1；
- Relay wire protocol：version 1；
- 加密 Gateway envelope：version 2；
- CE 自有 payload：默认内部 `version: 1`；单个方法发生不兼容安全演进时提升自己的 payload version，当前 `thread/start` 为 version 2，并要求 `expectedPreferencesRevision`；
- Host Profile、pairing document 和设备密钥：现有 version 1 格式。

Agent 不接受 v1 业务 envelope，返回 `CLIENT_UPGRADE_REQUIRED`；v2 Web 连接旧 Agent 时显示 `AGENT_UPGRADE_REQUIRED`。不允许静默降级。PWA Service Worker 等待用户确认，并在一次性秘密、草稿或 outcome-unknown mutation 存在时阻止刷新。

ScenarioGateway 是开发和 Playwright fixture，只能从 `import.meta.env.DEV` 分支动态装配；生产 Host 页面不解析 Scenario 故障参数，bundle manifest 门禁还会拒绝 Scenario 入口或实现进入生产制品。

### 4.3 Codex 事件

已知 app-server notification 使用由固定 schema 基线生成的校验器。未知 notification 包装为：

```ts
type CodexGenericEvent = {
  version: 1;
  method: string;
  params: JsonValue;
};
```

未知事件必须向前兼容地传到任务时间线，不能导致 Agent 崩溃或静默丢弃。

## 5. Agent 服务

用户 Agent composition root 装配：

| 服务                 | 职责                                                        |
| -------------------- | ----------------------------------------------------------- |
| `IdentityService`    | Passkey、密码、恢复码、设备信任、临时会话                   |
| `SetupService`       | 网络、用户级 Codex 安装、设备码登录、版本和 app-server 运维 |
| `WorkspaceService`   | realpath、root 授权、浏览和 revision                        |
| `CodexSupervisor`    | 唯一 app-server 的串行 ensure/inspect/restart               |
| `CodexClientFactory` | 按 scope 创建独立 JSON-RPC client                           |
| `ThreadLeaseManager` | 每任务一个共享 lease，管理 viewer/Queue 引用                |
| `InteractionBroker`  | 当前 client 上未解决的 app-server server request            |
| `QueueService`       | repository、dispatcher、Steer、crash window 和结果未知      |
| `PreferencesService` | 用户默认设置和 revision                                     |
| `AdminService`       | 独立管理员领域，不导入用户业务服务                          |

连接层分为三个显式 seam：`DirectTransportV2` 只拥有 HTTP/WebSocket listener、连接上限和公开发现；`RelayConnector` 只拥有 Relay v1 控制连接与密文 tunnel；`GatewaySocketConnection` 统一拥有单个 Direct/Relay tunnel 上的 Noise 握手、心跳、分片预算、请求队列和 Scope 生命周期。设备模式与信任状态由不接触 Noise 私钥、Router 或 repository 的 `GatewayPeerAuthentication` 解析，再把最小设备绑定和认证上下文交给 session factory。业务校验与 dispatch 进入同一个 Gateway v2 Router。Direct 与 Relay composition 只能向单连接模块传递最小 `GatewaySocketConnectionOptions`；Relay 注册只能接收 Host 公钥，不接收静态私钥对象。

Direct 的未加密 HTTP Host Discovery 是独立、只读的 adapter，只输出公开 Host Profile 并负责 Origin、CORS/PNA 与 no-store 响应；它不得接触 Gateway session、Router、设备私钥内容或用户业务服务。Noise 握手 hello 与 cipher frame 必须使用共享 protocol parser，在进入密码学和路由处理前完成版本、长度、标识符、序号及 base64url 校验，Agent 不维护更宽松的私有解析器。恢复握手必须在创建 Gateway session 前拒绝已撤销设备；连接关闭必须通过 Scope 释放 session、listener、timer 和未完成分片预算。

Agent composition root 只构造服务、绑定 Scope、连接控制面事件并完成静态装配，不直接声明业务 handler。用户 Gateway 方法在独立的 core handler registry 中按 host、workspace、thread、Queue 和 preferences 分组；Identity 与 Setup 使用各自的 handler map。`ThreadService` 是 thread 用例 facade，只编排 client、lease、workspace 和偏好锁；`ThreadSessionCoordinator` 独占每任务的权限 coordination fence、每 lease 一次 resume 和运行设置缓存。Codex JSON 运行时边界、权威 thread 到 CE timeline/summary 的纯投影、以及 thread settings 的双向转换分别位于独立模块。投影和设置转换模块不得保存会话状态或发起 app-server 请求，session coordinator 不得反向依赖 Gateway、Queue 或展示投影。

### 5.1 Thread lease

同一 Agent 中每个 thread 最多一个 lease，可被多个浏览器 viewer 和 Queue dispatcher 引用。lease 拥有：

- 独立 app-server client；
- notification/server-request 订阅；
- `InteractionBroker`；
- 当前 turn、thread 状态与 workspace path；
- viewer/Queue 引用计数和子 scope。

浏览器断线立即释放 viewer；活动 turn、待处理 interaction 或 Queue 引用继续保留 lease。无引用且 idle 时立即关闭。Gateway session 会合并同一连接内并发的 `thread/open`，并在 close 完成后才允许同任务重新 open；viewer Scope 的异步释放必须一直等待到底层 app-server client 关闭。Manager 把正在释放的 lease 计入容量，同一任务的旧 client 未完成关闭前不得创建新 client。最多保留 128 个 lease，达到上限时拒绝创建，不驱逐活动任务。

`thread/open` 总是返回 app-server 权威快照、历史边界、当前状态、thread settings 和未解决 interaction。多个设备回答同一 interaction 时，broker 原子取出待处理项，第一个合法回答成功，其余设备收到 `interaction/resolved` 或明确失败。

Web Thread actor 不维护独立的 `openedThreadId` 影子变量；切换和关闭目标由 reducer 写入 generation-bound effect。旧 `thread/open` 即使在取消后才返回，也不能改写后续 close 目标或把旧任务重新暴露为当前任务。Composer actor 只保存按 thread ID 隔离的内存草稿及 mutation 对账状态；草稿不是会话事实源，不能跨任务复用，失败反馈也必须归属到原任务。

Web 首开任务和每次向前分页都只请求 50 个 timeline item。历史加载使用独立的 `historyStatus`，不能把任务运行状态改成 `syncing` 或阻断 Composer。历史请求或权威刷新期间到达的同任务刷新只合并为一次尾随读取，不能取消当前分页，也不能丢失刷新。最新窗口与已加载历史只按稳定 item ID 的重叠边界合并：重叠点之前的显式旧页保留，重叠区域以最新权威项为准；完全无重叠时视为窗口漂移并替换为最新页，不能按正文猜测。收到明确的 `thread/compacted` notification 后，即使新旧窗口仍有稳定 ID 重叠，也必须在下一次权威读取时丢弃压缩前的历史前缀。

`TimelineViewport` 只拥有页面级几何状态：首次进入滚底、接近底部时跟随最新、用户上滚后的 detached 状态、旧页插入锚点和大纲跳转。它不持久化消息，不解析 Gateway，也不成为会话事实源。异步 Markdown 布局变化只在 following 状态维持底部；detached 状态显示“回到最新”且不得抢夺阅读位置。命令输出、diff、MCP 结果和 generic payload 在原生 `details` 打开前不挂载大型 DOM。

对话大纲是当前已加载用户消息的纯展示投影，不是 Codex `plan`，也不能通过 `MutationObserver` 扫描渲染 DOM 反建状态。大纲条目使用稳定 item ID 跳转；桌面覆盖式抽屉和移动底部 Sheet 只保存打开、筛选和当前位置等局部 UI 状态。存在更早 cursor 时用户可显式加载下一页，大纲本身不得后台穷举历史。

Agent/app-server 重启后不恢复旧 server-request callback；旧 interaction 显示失败。thread 本身通过 app-server 重新打开。

### 5.2 Mutation

durable mutation 流程：

```mermaid
sequenceDiagram
  participant W as Web
  participant R as Router/Middleware
  participant D as MutationReceiptRepository
  participant S as Service
  W->>R: mutation(operationKey)
  R->>D: claim(method, canonical input hash)
  D-->>R: execute / pending / completed / indeterminate
  R->>S: execute once
  R->>D: complete(result or definitive error)
  R-->>W: response
  W->>R: mutation/status(operationKey)
  R->>D: read status
  D-->>W: authoritative outcome
```

request fingerprint 是完整、已验证 input 的 canonical SHA-256；数据库不保存 prompt、路径、Queue 文本或凭据。相同 key 与不同 input 必须返回 `OPERATION_KEY_REUSED`。transport 丢失以及 Agent 明确返回的 `MUTATION_PENDING` / `MUTATION_OUTCOME_UNKNOWN` 都进入同一 `mutation/status` 对账路径；Codex app-server 明确返回的 JSON-RPC error 则作为确定失败保存，不误标为结果未知。进程启动时残留 `pending` claim 转为 `indeterminate`，禁止自动重放。

任务设置只把用户实际修改的字段发送给 app-server。Web 设置面板以 Gateway 返回的 `ThreadSettings` 和新 revision 直接更新 Thread actor，不能通过盲目重开任务伪造成功；面板在保存期间保持打开，明确区分 dirty、saving、reconciling、saved 和 error，并在新改动出现前保持成功反馈。结果未知或确定拒绝时才重新读取权威设置。`thread/open` 同步期间收到的 `thread/settings/updated` acknowledgement 必须抑制递归刷新，避免页面持续显示同步并反复切换 Composer 可用状态。

新任务的 sandbox 与 approval 分别记录为“继承全局”或“本次覆盖”。Web 只在至少一个字段继承时于提交边界重读一次 `preferences/read`，把该次读取的 `expectedPreferencesRevision` 和仅含显式覆盖字段的 settings 交给 `thread/start`。Agent 使用状态库现有的跨进程 coordination lock，在锁内读取并校验 revision、解析所有继承字段，并一直持有到 app-server 接受 `thread/start`；`preferences/update` 使用同一把锁，因此不能插入读取与 Codex 接受之间。两个字段都显式覆盖时不读取或锁定默认偏好。这里不引入偏好轮询、全局事件订阅、通用协调框架或浏览器影子事实源。

revision 冲突只保留仍与权威状态不同的最小 patch。patch 计算、权威 revision rebase 和失败恢复分类位于独立纯模型模块，React 对话框只持有草稿与展示反馈。尾随 `thread/open` 刷新必须继续在新 revision 上重放该 patch，直到权威值已经包含它、用户放弃或保存成功；若其他设备已经应用相同偏好，Web 直接同步并报告完成，不要求提交空 patch。

CE 的 lease-owned app-server client 在 `initialize` 时显式声明 `capabilities.experimentalApi: true`，因为 `thread/settings/update` 属于实验 API；未完成该能力协商时必须把 Codex 的拒绝当作确定失败，不得伪造本地设置成功。Web 与 `ce tui` 的同任务权限写入共用持久 coordination fence；每次打开任务还会把 repository 中较新的 sandbox/approval 权限合并回运行视图，避免旧内存快照覆盖跨进程更新。

包含恢复码、handoff code 或 resume token 的方法只能使用有界内存 `ephemeral` 重放；协议测试和 middleware metadata 校验共同阻止它们进入 SQLite。

### 5.3 Queue

Queue item 和 delivery claim 在同一用户库中。dispatcher 在 app-server 副作用前写入 claim；确定完成后记录 turn ID。若崩溃发生在外部副作用边界，恢复为 `indeterminate`，不重新调用 app-server。该状态会阻塞同任务后续派发，直到用户显式选择 retry 或 dismiss。Web Queue actor 在 mutation/receipt 对账期间拒绝启动第二个 Queue mutation；实时 `queue/changed` 可以合并展示，但页面刷新不得取消仍在跟踪的 mutation generation。用户在结果未知状态显式刷新权威 Queue 后，才能对具体 indeterminate item 选择 retry 或 dismiss。

## 6. 身份与隔离

四类身份互不替代：

1. Unix/SSH 身份：由现有 NSS 和 SSH 策略决定；
2. CE Web 身份：Passkey 或 CE 专用 OPAQUE 密码；
3. Codex 身份：用户自己的官方设备码登录和 `~/.codex`；
4. 宿主机管理员 Web 身份：独立数据库、route、Passkey/密码和 principal。

设备密钥只证明 Noise 端点持有对应私钥；Router 每次已认证请求仍重新验证设备未撤销。临时会话只使用当前页面内存里的设备密钥和 resume ticket，Web 不写 IndexedDB/localStorage 业务状态。

管理员只能对精确 NSS 用户执行登记、禁用、启用、移除计划和恢复交接。恢复交接码只返回给当前管理员页面一次，数据库保存哈希并记录不含秘密的审计事件。管理员 composition root 不能导入 thread、workspace、Queue 或用户 repository。

## 7. React PWA

依赖边界：React、React DOM、React Router、内核 Actor、CSS Modules、原生语义控件和 `<dialog>`。不使用 Redux、XState、Tailwind 或大型 UI 框架。

功能组件的样式必须与组件就近放置为 `*.module.css`；`global.css` 只允许由 bootstrap 导入，并只承载 design token、reset、跨页面共享原语及尚待逐步收敛的旧公共样式。已迁出的 feature selector 不得重新写回全局样式。E2E 使用语义角色、可访问名称或稳定的 `data-*` 契约，不依赖 CSS Module 生成类名。

页面组件只持有局部表单草稿和就近交互反馈；跨路由连接与执行生命周期继续由既有 actor/Scope 管理，一致性由 Gateway/service/repository 边界承担。新增 bug 修复不得通过页面轮询、全局业务 store、第二套会话状态机或无真实复用方的通用框架扩张 Web composition root。

主要 actor：

| Actor      | 关键状态                                                                         |
| ---------- | -------------------------------------------------------------------------------- |
| Connection | disconnected、connecting、authenticating、online、reconnecting、upgrade-required |
| Onboarding | inspect、network、install、codex-login、ready                                    |
| TaskList   | loading、ready、paginating、failed                                               |
| Thread     | closed、opening、syncing、idle、running、waiting-input、reconnecting、failed     |
| Composer   | idle、submitting、outcome-unknown、reconciling、manual-review                    |
| Queue      | loading、ready、mutating、indeterminate                                          |
| Admin      | signed-out、authenticating、ready、mutating                                      |

路由：`/hosts`、`/setup`、`/tasks`、`/tasks/:threadId`、`/queue`、`/workspaces`、`/settings`、`/admin/*`。未完成 onboarding 时 user route gate 强制进入 `/setup`。

桌面使用左侧导航/任务列表、中间任务内容和按需操作区；390px 移动端使用任务、Queue、工作区、设置四项底部导航。Markdown、KaTeX 和代码呈现只在任务页懒加载，并继续经 DOMPurify 清洗。

交互状态使用统一的成功、警告、错误和信息反馈组件；异步按钮必须在请求期间锁定并显示进行中语义，表单提交按钮还要由 dirty/valid 状态控制。只由 select/radio 产生且无法从文本字段推断的局部草稿，必须在所属表单设置 `data-pwa-draft="true"`，让 Service Worker 安全刷新门槛在保存或放弃前阻止刷新。常用触控目标不小于 44px，移动端主要操作不依赖 hover；任务删除使用可访问的应用内确认对话框，不依赖浏览器原生 confirm。状态名称面向用户本地化，内部 actor 状态不得直接显示为英文枚举。

`GatewayPort` 是 React 唯一远端边界。顶层身份边界只创建一个 runtime：普通用户进入 `UserWebRuntime`，管理员进入 `AdminWebRuntime`。两者使用独立 context、actor 和路由；Admin runtime 不导入或实例化 thread、workspace、Queue 等用户业务 actor。`ReconnectingGatewayPort` 热切换 Direct/Relay transport，actor 和组件不会持有 WebSocket。恢复后用户 runtime 重新读取 onboarding、任务、Queue、当前 `thread/open`，并对账 composer operation key。

## 8. 状态数据库

用户和管理员库从 `user_version = 1` 开始，并使用不同 `application_id`：

- `UserStateDatabase`：metadata、workspace、preferences、thread permissions、identity、mutation receipts、Queue、最小安全审计；
- `AdminStateDatabase`：管理员 identity、managed users、admin audit 和 admin mutation receipts。

repository 之外禁止 import `sql.js`。状态文件继续使用跨进程锁、真实 UID、0600、文件 fsync、目录 durability 和原子 rename。`StateSnapshotV1` 只是 repository 内部的类型化数据形状，不对外提供 v0.3 转换或 JSON 导出。密码记录、恢复哈希和 Queue 内容不进入日志。

v0.3 切换采用整目录隔离和全新初始化，不导入旧数据库。规则见[全新初始化与切换手册](migration-v0.4.zh-CN.md)。

## 9. 日志与敏感数据

禁止记录：

- prompt、回复、Queue 文本和文件内容；
- workspace/path 内容；
- Passkey、OPAQUE 消息、Codex 凭据、设备私钥；
- pairing secret、恢复码、handoff code、resume ticket；
- 已解密 Relay payload 或完整 Gateway input/output。

允许记录有限的结构化控制字段，例如固定事件名、协议错误码、耗时、计数和不含业务内容的随机 request ID。错误向浏览器返回稳定 code 和去敏 message。

## 10. 工程门禁

`pnpm check:architecture` 检查：

- v0.4 source graph 无循环依赖；
- kernel 不依赖其他 CE package；
- React v4 不导入旧 monolith、Agent 或 SQL；
- v2 非 repository 不直接 import `sql.js`；
- raw Gateway envelope 只存在于 gateway adapter；
- v2/v4 活跃源码不出现 Side、`thread/fork` 或 `auth/import` 方法。
- Agent composition root 不直接注册业务 handler；
- Direct listener、Relay connector、单个加密 Socket 生命周期和公开 Host Discovery 保持独立；
- Web 功能样式使用 CSS Modules，`global.css` 只有 bootstrap 可导入，已迁出的任务与设置 feature selector 不得回流；
- 对话大纲纯模型不得依赖 React、Gateway 或 runtime；时间线视口不得使用 DOM mutation 扫描生成消息状态；
- 生产 Web manifest 不包含 ScenarioGateway 或故障注入入口。

发布前必须通过 format、architecture、typecheck、unit/protocol、build、Direct/Relay integration 和真实 app-server contract。模型调用测试使用显式环境开关。用户路由初始 JS gzip 上限 250 KiB，CSS gzip 上限 40 KiB；Markdown/KaTeX 必须保持独立懒加载。
