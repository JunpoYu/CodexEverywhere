# 版本记录

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构，并使用[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.4.0-alpha.12] - 2026-08-25

### Changed

- 将模型、推理强度、文件访问和审批策略从对话页顶部移到 Composer 附近：宽屏时使用输入框左侧空白区，窄屏与移动端自动折叠到输入框上方；完全文件访问与从不询问的组合会得到明确的高权限提示。
- Composer 改为按 Enter 直接发送，任务运行中则加入 Queue；Shift + Enter 保留换行，并避免中文输入法确认候选时误发送。
- 使用 npm 最新稳定版 Codex CLI `0.149.1` 重新生成完整 app-server TypeScript 与 notification schema，并通过真实 app-server contract 检查。

### Fixed

- Agent 状态 repository 仅在原子状态文件 revision 确实变化时重建内存中的 sql.js 数据库，避免每次查询重复创建、关闭 WASM 数据库；跨进程写入仍通过文件锁、inode/revision 检测和权威重载可见。
- Noise 握手遇到不可恢复的 WASM runtime trap 时按安全阶段记录控制事件并在有界清理后非零退出；tmux watchdog 只对异常退出自动重启，正常停止不会形成重启循环。
- `ce agent start` 在已安装 watchdog 时通过 tmux 服务入口启动 Agent，避免 detached 进程与 crontab watchdog 竞争并产生“PID 存活但 Relay 已离线”的假健康状态。
- 推进 PWA 缓存代次，确保已安装的 alpha.11 页面能够发现并安全激活 alpha.12 Web 版本。

## [0.4.0-alpha.11] - 2026-08-22

### Added

- 新增按已加载用户消息生成的对话大纲：桌面端使用不挤压主对话宽度的覆盖式抽屉，移动端使用底部 Sheet；支持本地筛选、当前位置高亮、稳定 item ID 跳转和显式加载更早大纲。

### Changed

- 任务中心默认汇总全部已授权工作区的任务，并在任务卡和桌面端最近任务中明确显示所属工作区；用户可按工作区筛选，筛选不会隐式修改全局默认工作区。
- 对话页移除常驻右侧属性栏，把模型、推理强度、文件访问和审批策略收拢到页头下方的紧凑上下文栏；Interaction 就近保留在输入区上方，当前任务的 Queue 数量移到输入区下方。
- Agent 进一步收紧模块边界：Direct discovery、Noise socket 生命周期和设备认证拆分为独立 adapter，Gateway 业务 handler 从 composition root 移入领域 registry；thread 权威投影、设置转换以及 resume/权限一致性分别由纯投影模块、设置模块和 `ThreadSessionCoordinator` 负责。
- Web 将任务列表、任务上下文和设置页面样式迁入就近 CSS Modules，将任务设置冲突与 patch 计算提取为不依赖 React 的纯模型；架构检查会阻止这些边界重新回流到全局样式或巨型 composition root。
- 任务首开与历史分页统一限制为每页 50 个 timeline item；命令输出、diff、MCP 结果和 generic payload 只在用户展开时挂载大型 DOM，长会话 ScenarioGateway 也使用与真实 Agent 相同的稳定游标分页。
- 使用 npm 最新稳定版 Codex CLI `0.149.0` 重新生成并核对 app-server TypeScript 与 notification schema，生成结果与当前编译基线一致。

### Fixed

- 文件修改事件中的超长路径现在限制在卡片内部并可独立横向滚动，不再撑破时间线和对话页面边框；完整路径仍可通过悬停标题和键盘聚焦读取。
- 修复并发或快速切换任务时可能重复 `thread/open`、对同一 lease 重复 `thread/resume`、旧异步结果关闭新任务，或在旧 app-server client 尚未释放时创建同任务新 client 的竞态；lease 释放现在等待底层 client 完整关闭，且正在释放的 lease 继续计入容量。
- Composer 草稿、发送失败和结果未知状态按 thread ID 隔离；切换任务不会串用草稿，迟到的重命名、归档、删除、TUI 接力或中断结果也不会覆盖当前页面反馈。
- Queue mutation 与 `mutation/status` 对账保持单飞，并区分仍在轮询的“对账中”和需要人工确认的终态“结果未知”；刷新和实时通知不会取消正在跟踪的 operation key，只有终态才重新开放人工刷新与处置。
- Thread actor 会显式处理 lease failure，并把 open/close 目标绑定到 effect generation；设置面板在 revision 冲突后的 patch 重放与失败恢复不再依赖页面组件中的分散分支。
- 修复进入任务后停留在当前历史窗口顶部、加载更早记录导致 Composer 短暂不可用、同任务刷新丢失已加载旧页，以及流式更新强制打断旧消息阅读的问题；时间线现在首开自动滚底，旧页插入保持可见锚点，用户上滚后可显式“回到最新”。只有用户显式分页引入的稳定 item ID 才能跨最新窗口刷新保留，因此滑动窗口持续前进也不会让 DOM 无界增长；并发刷新会合并为一次尾随权威读取，明确的 `thread/compacted` 通知会清除压缩前历史，即使新旧窗口仍有 item ID 重叠也不会保留陈旧前缀。
- lease 的 notification、interaction 和 client-close 回调统一通过受观察的后台清理入口释放资源；底层 disposer 即使失败也只产生去敏的 `lease-disposal-failed` 控制面事件，不再泄漏为 Node.js 未处理 Promise rejection。
- 推进 PWA 缓存代次，确保已安装的 alpha.10 页面能够发现并安全激活 alpha.11 Web 版本。

## [0.4.0-alpha.10] - 2026-08-21

### Changed

- 重塑 Web 的产品视觉语言：采用更克制的中性色与蓝紫强调色、统一的间距和层级、精简宿主机入口，并让桌面侧栏、任务工作台和 390px 移动导航共享一致的响应式结构。
- 任务页改为对话主区与上下文侧栏组成的工作台；当前权限、Queue 状态和常用操作保持可见，任务操作收拢到明确的主次层级。
- 时间线按消息、计划、命令、文件修改、MCP、Subagent、错误与向前兼容 generic event 分别呈现，命令输出、diff 和结构化详情默认折叠，降低长任务中的视觉噪声。
- 使用 npm 最新稳定版 Codex CLI `0.149.0` 重新生成完整 app-server TypeScript 与 notification schema。

### Fixed

- 任务设置保存成功后在任务页提供就近反馈，同时继续以宿主机返回的新 revision 作为生效依据。
- 推进 PWA 缓存代次，确保已安装的 alpha.9 页面能够发现并安全激活 alpha.10 Web 版本。

## [0.4.0-alpha.9] - 2026-08-20

### Changed

- 使用 npm 最新稳定版 Codex CLI `0.148.0` 重新生成完整 app-server TypeScript 与 notification schema，使编译基线和真实发布工具保持一致。
- Release 制品构建现在也校验 Kernel package 版本，确保文档声明的所有 CE 组件与根项目版本完全一致。
- v0.4 production 的实机 staging 门槛聚焦一个真实用户的完整链路；多用户并发、跨用户隔离与管理员控制面保留为后续里程碑，不再阻塞当前单用户版本发布。
- 新建任务表单会显示实际采用的全局 Sandbox 与审批默认值，允许在发送第一条消息前仅覆盖本次任务，并对降低隔离或审批保护的组合给出风险提示。
- Web 全局设置从不明显的选择即保存改为显式“保存全局设置”，就近显示未保存、保存中、结果对账、成功和失败状态；修改只影响后续新任务。

### Fixed

- 推进 PWA 缓存代次，确保已安装的 alpha.8 页面能够发现并安全激活 alpha.9 Web 版本。
- 新任务权限覆盖改为 Sandbox 与审批策略分别记录来源；只覆盖一项时，另一项仍继承创建时的权威全局值，不再把页面加载时的旧默认值伪装成显式覆盖。
- `thread/start` 输入提升为 fail-closed payload version 2，并强制携带 `expectedPreferencesRevision`；缓存旧 PWA 缺少 revision 时会在 schema 边界被拒绝。采用任何继承字段创建任务时，Agent 使用现有状态协调锁把 revision 读取稳定到 Codex 接受 `thread/start`，关闭偏好更新的 TOCTOU 窗口，且未引入偏好轮询、全局订阅或第二套状态机。
- ScenarioGateway 与故障注入参数移入开发态动态入口，生产构建门禁会拒绝任何 Scenario 源码进入制品；生产 Host 页面不能再用查询参数开启测试后端。
- PWA 安全刷新会识别表单显式 dirty 标记，设置页和任务权限面板只有 select/radio 草稿时也会阻止刷新；保存或放弃后标记随即清除。
- 任务设置发生 revision 冲突后，尚未保存的最小 patch 会跨连续尾随 `thread/open` 刷新持续重放，直到保存、放弃或权威设置已经包含相同值，不再在第一次刷新后静默丢失草稿。
- 全局设置冲突若是另一设备已经应用了相同值，会直接同步最新 revision、应用权威主题并明确报告无需重试，不再留下无改动却要求再次保存的死状态。
- `thread/settings/updated` 在任务打开或刷新期间到达时不再被时间窗口直接丢弃；Web 会把同步窗口内的通知合并成一次尾随权威刷新，既避免递归 `thread/open`，也不会漏掉其他 Web 设备或 TUI 的真实权限更新。
- 任务设置遇到 `REVISION_CONFLICT` 后会锁定旧 revision 的重复提交，读取宿主机最新设置，并把用户尚未保存的 patch 重放到新 revision；刷新失败时必须先显式重新同步。
- Workspace durable mutation 与后续 `workspace/list` 查询分别呈现结果；mutation 已完成而列表刷新失败时仍明确报告成功、清理已提交表单，并单独提示当前列表可能过期，避免诱导使用新 operation key 重复副作用。

## [0.4.0-alpha.8] - 2026-08-19

### Changed

- 重建 Web 的视觉与交互语言：统一设计 token、SVG 图标、状态反馈、焦点与触控目标，优化桌面侧栏、390px 底部导航、任务时间线、Composer、设置、Workspace、Queue、初始化和管理端；危险的任务删除改用应用内确认对话框。
- 任务权限改为独立响应式设置面板，以卡片解释 sandbox 与审批策略；保存按钮只在存在有效改动时启用，并明确呈现保存中、结果对账、成功与失败状态，成功后面板保持打开，可继续修改。

### Fixed

- 修复任务设置保存后按 revision 重建组件，导致面板突然关闭、按钮很快恢复却无法再次提交且没有成功提示的问题；确认结果现在直接写入 Thread actor 的权威设置快照。
- 抑制 `thread/open` 同步期间 app-server 的 `thread/settings/updated` acknowledgement 递归触发新一轮刷新，避免任务页持续显示同步并让发送按钮反复切换可用状态。
- 设置、Workspace、审批与设备码流程补齐一致的忙碌、成功和失败反馈；Composer 在空草稿时禁用发送，并支持 `Ctrl/⌘ + Enter` 且在提交入口再次校验状态。
- 推进 PWA 缓存代次，确保已安装的 alpha.7 页面能够发现并安全激活 alpha.8 Web 版本。

## [0.4.0-alpha.7] - 2026-08-19

### Fixed

- CE Agent 创建的所有 lease-owned app-server client 现在会在 `initialize` 时显式启用 `experimentalApi`，使 Web 的 sandbox 与审批策略更新能够调用 Codex `thread/settings/update`，不再被 app-server 以缺少 capability 拒绝。
- 新增 supervisor 装配回归测试，并以 Codex CLI `0.148.0` 重新生成 app-server notification schema、通过真实无模型合约测试。
- 推进 PWA 缓存代次，确保已安装的 alpha.6 页面能够发现并安全激活 alpha.7 Web 版本。

## [0.4.0-alpha.6] - 2026-08-19

### Fixed

- 修复 Agent 已返回 `MUTATION_OUTCOME_UNKNOWN` 或 `MUTATION_PENDING` 时，Web 把英文错误直接显示而未按原 operation key 查询 `mutation/status` 的问题；明确的 Codex JSON-RPC 拒绝现在记录为确定失败，transport 丢失仍保持结果未知保护。
- 任务设置只发送实际变化字段，不再因仅修改 sandbox/审批策略而顺带重写模型与推理强度；补齐 `max`、`ultra` 显示，并在结果无法证明时刷新权威设置后给出中文人工核对提示。
- Web 与 `ce tui` 的同任务权限更新共用持久 coordination fence，任务刷新会合并 repository 中较新的 sandbox/approval 权限，避免并发或跨进程更新被旧运行时快照覆盖。
- CI 与 Release 使用 GitHub Ubuntu runner 预装的 Google Chrome 和 Playwright `chrome` channel，避免外部浏览器下载卡住发布；本地与 staging 仍可按需安装无 channel 的 headless Chromium shell。
- 推进 PWA 缓存代次，确保已安装的 alpha.5 页面能够发现并安全激活 alpha.6 Web 版本。

## [0.4.0-alpha.5] - 2026-08-19

### Fixed

- 修复打开任务后 `thread/resume` 产生的目标用量、目标清理等元数据通知反复触发 `thread/open`，导致页面持续显示 `syncing`、发送按钮不断切换可用状态的问题。
- 同一任务 lease 只在首次打开时执行 `thread/resume`，后续权威刷新改用无通知回放的 `thread/read`；内容通知采用尾随防抖，未知通知继续作为 generic event 本地保留。
- 后台权威刷新现在保留任务的实际运行状态，不再把普通内容同步暴露为阻断输入的 `syncing` 状态；ScenarioGateway 也改为使用与真实 app-server 一致的已知 item 通知完成流式收口。
- 推进 PWA 缓存代次，确保已安装的 alpha.4 页面能够发现并安全激活 alpha.5 Web 版本。

## [0.4.0-alpha.4] - 2026-08-18

### Fixed

- 修复旧任务的 Codex `preview` 超过 Gateway 标题上限时，`thread/list` 整页被输出 schema 拒绝并显示 `Gateway handler returned an invalid result` 的问题；Agent 现在会在协议边界安全截断摘要，并避免切断 UTF-16 代理对。
- 推进 PWA 缓存代次，确保已安装的 alpha.3 页面能够发现并激活 alpha.4 Web 版本。

## [0.4.0-alpha.3] - 2026-08-18

### Fixed

- 修复用户在首次空 Workspace 查询后添加授权根，任务列表仍保留空缓存且进入任务页不重新同步的问题；Workspace 变更和重新进入任务页现在会按当前筛选读取 app-server 权威列表，加载与失败状态也会明确显示。
- 推进 PWA 缓存代次，使已安装的 alpha.2 页面能够发现 alpha.3 Web 更新并继续通过安全刷新门槛激活，不依赖用户清除站点数据。

## [0.4.0-alpha.2] - 2026-08-18

### Added

- 新增一键 v0.4 候选版本门禁和 0600 脱敏 receipt；默认拒绝脏工作区，真实订阅模型调用必须显式开启。
- 新增机器执行的首屏 JS/CSS gzip 预算检查，并验证 Markdown、KaTeX 与代码高亮仍处于任务页懒加载边界。
- 新增严格的多用户 staging receipt 初始化与校验器，只接受限定字段、布尔验收结果和 SHA-256，不允许记录主机名、用户名、路径或自由文本，并要求浏览器、Agent 与 Relay 的 NTP 时钟完成同步。
- 新增供人和后续 Agent 执行的部署、升级与回滚操作手册，明确非秘密交接输入、只读预检、停止条件、Release 验证、Direct/Relay/Controller、v0.4 全新初始化和验收输出。

### Fixed

- 修复 SimpleWebAuthn 返回的可选 `undefined` 兼容字段在 JSON 序列化前被 Gateway typed client 拒绝，导致首次配对、添加 Passkey 或 Passkey 登录显示 schema 错误的问题；客户端输入错误现在同时标明安全的方法名和字段路径。
- 修正 v0.3→v0.4 全新切换遗漏宿主 rootless provisioner 旧 admin 状态库的问题；文档要求在首次 v0.4 配对前隔离旧库并保留 credential/密钥，Agent 对不兼容 schema 返回可操作且不泄密的错误。
- 修复发布门槛要求 staging 消费 Release、同时又禁止在 staging 前创建 tag 的循环依赖；alpha tag/Prerelease 现在只冻结候选字节，staging receipt 仍是 production 批准的硬门槛。
- v0.4 改为全新初始化边界：删除 v0.3 正反迁移、迁移 CLI、旧 schema 转换器和数据回滚承诺；切换时归档旧 CE 状态并重新配对，`~/.codex` 与 app-server 任务不属于清理范围。

## [0.4.0-alpha.1] - 2026-08-16

### Added

- 新增纯 TypeScript 内核：类型化 `ServiceRegistry`、层级 `Scope`、`TypedEventBus` 和 generation-safe `Actor`；Agent 与 React Web 使用静态 composition root，不加载第三方代码。
- 新增加密后的 Gateway API v2、Zod 运行时 schema、类型化 client、声明式 handler registry 和统一版本、身份、权限、capability 与幂等校验。`mutation/status` 为 durable 副作用提供 `missing | pending | completed | indeterminate` 权威对账。
- 新增 `IdentityService`、`SetupService`、`WorkspaceService`、`CodexSupervisor`、`CodexClientFactory`、`ThreadLeaseManager`、`InteractionBroker`、`QueueService`、`PreferencesService` 和隔离的 `AdminService`。同一 thread 支持多 viewer、单 lease、审批竞争和断线后权威重开。
- 新增 React、React Router、actor/`useSyncExternalStore` 和 CSS Modules PWA，覆盖 Host/Auth、Onboarding、任务、结构化时间线、Interaction、Composer、Queue、Workspace、Settings 与独立 Admin 路由；User 与 Admin 使用互斥的 composition root，Markdown、KaTeX 和高亮按任务页懒加载。
- 新增用户与管理员分离的 v0.4 SQLite schema、repository 边界和专用 `application_id`；旧 CE 状态不会被 v0.4 二进制隐式打开或转换。
- 新增架构检查、Gateway 合同测试、schema fuzz、Actor 乱序测试、无模型 app-server fixture，以及 Direct/Relay 行为一致性测试。

### Changed

- Codex app-server 明确成为 thread、turn、审批、工具活动和执行状态的唯一事实源；断线恢复统一为重新认证、`thread/open`、稳定 ID 合并、interaction 同步和 mutation 对账。
- durable operation key 绑定完整 schema 校验后输入的 canonical SHA-256，数据库不保存提示词、Queue 文本、路径内容或凭据；一次性秘密结果只允许在每用户 Agent 内存中按同 key 有界重放。
- Queue 使用持久 delivery claim 和 at-most-once 边界；无法证明 app-server 副作用结果时进入显式 `indeterminate`，不会静默重投。
- Noise handshake、Relay wire、Host Profile、设备密钥和 pairing document 继续使用 version 1；Gateway API 独立升级为 version 2。Web/Agent 不匹配时明确要求升级，不静默降级，也不要求重新配对设备。
- UI 将 app-server `thread` 显示为“任务”；内部协议与代码仍使用 `thread`。

### Removed

- 从 v0.4 活跃协议和产品入口移除 Side、`thread/fork`、连续事件 ACK/buffer、Side capability 和浏览器 `auth.json` 导入。
- Schedule、Push、完整文件管理和第三方插件加载器不进入 v0.4 首版；v0.3 旧库整体隔离，不被 v0.4 读取或部分导入。

### Security

- 恢复码授权消费与整组替换在同一数据库事务中完成；旧码全部失效。Passkey、CE 密码、恢复码和临时登录均不复用 SSH/Linux 密码。
- Workspace 继续先 `realpath` 再校验授权 root；Direct 与 Relay 共用 Noise E2EE，Relay 不接触业务明文；临时模式禁止持久化设备私钥、Host Profile、票据和业务缓存。
- Router 与 repository 成为协议和 SQL 的单一边界；日志禁止提示词、Queue 文本、文件内容、路径内容、凭据、恢复码和已解密 Relay payload。

### Fixed

- 修复相同 operation key 与相同 thread ID、不同提示词可能被错误当作同一 durable mutation 的问题。
- 修复恢复、配对或 WebAuthn 完成响应在 transport 丢失后无法用同 operation key 安全取回的问题；配对握手成功后先保存已可信设备，避免一次性 pairing 被消费后留下不可恢复页面。
- 修复旧 generation 的异步连接、任务、Composer 或 Queue 结果覆盖用户较新选择的问题。
- 修复输入、通知等纯状态事件错误取消当前 Actor effect，导致连接、任务打开或 mutation 永久停留在中间状态的问题。
- 修复首个 turn 在 lease 建立前启动时，审批或用户问题可能先于任务页订阅到达并丢失的问题。
- 修复等待用户输入时 Composer 不能把后续消息加入 Queue，以及未知 Codex notification 不能稳定保留为 `codex/generic` 时间线项的问题。
- 修复原生 `<dialog>` 继承页面静态定位后可能渲染到移动端视口外的问题。

## [0.3.0-alpha.14] - 2026-08-17

### Fixed

- fresh root-owned Agent 安装现在与 rootless 安装和 shared rollback 一样，原子发布 `current` 后同时创建跟随它的 `active-release` receipt；首次启用 Controller 后可直接按操作手册核对活动版本，不再需要额外执行一次 shared activator 补齐该指针。

## [0.3.0-alpha.13] - 2026-08-17

### Added

- `install-release.sh` 支持从 `CE_RELEASE_ASSET_DIRECTORY` 消费已在联网操作机验证并转交到 HPC 的原始 Release 文件；受限宿主机仍必须提供 staging 批准的 manifest SHA-256，并会重新校验 manifest、制品、build metadata、归档路径和完整 release inventory。

### Changed

- rootless 与 root-owned runtime 创建器显式覆盖继承的 Conda channel 列表，只从 `conda-forge` 解析固定的 Node.js 20.20.2 和 tmux，避免 root 或站点 `.condarc` 意外混入无关 channel。

### Fixed

- Release inventory 不再把 Linux 上无语义且跨文件系统不稳定的符号链接 mode 当作内容身份；旧 schema v1 inventory 中该字段继续兼容，但链接路径、目标以及目标文件内容仍严格校验。修复 Parastor 上的 verified rootless release 复制到 XFS root-owned 安装时因 `0755`/`0777` 差异被误拒绝的问题。

## [0.3.0-alpha.12] - 2026-08-17

### Added

- 新增供人和后续 Agent 执行的部署、升级与回滚操作手册，明确非秘密交接输入、只读预检、停止条件、Release 验证、Direct/Relay/Controller 和验收输出。
- Release 的 HPC tools 现在包含首次 bootstrap、rootless/root-owned 安装及两类 inventory 回滚所需脚本。
- 操作手册补充 root-owned Miniforge 的固定版本、双重 SHA-256 校验和隔离安装步骤，避免 Controller 部署时让 root 执行部署账号可写的 Conda、Node.js 或安装脚本。

### Changed

- 发布规范明确提交 author 邮箱属于有意公开的 Git 元数据，可以使用个人邮箱或 GitHub noreply 邮箱，不作为安全检查或发布门槛；凭据和真实部署端点仍禁止进入公开仓库。

### Fixed

- Noise transport 与 Relay wire 继续保持 version 1，但握手现在显式声明独立的 Gateway API version。v0.3 Web 遇到已升级为 Gateway API v2 的 Agent 时会显示明确的客户端升级提示，并立即绕过浏览器默认周期检查 Service Worker 更新；真正激活仍经过现有的一次性凭据、草稿和结果未知安全门槛。
- 修复 HPC 安装器在 `umask 077` 下把非秘密 release inventory 创建为 `0600`，随后又因要求精确 `0644` 而拒绝安装或回滚的问题；inventory 先以私有模式写入，再通过同一文件句柄发布为固定权限。
- 修复 rootless 全局启动器拒绝 root、但 Administrator Controller 安装与 helper 又必须执行 root CLI 的部署死锁；root 现在只进入同 tag、root-owned 且经 inventory 校验的独立副本，普通用户继续进入无特权副本。

## [0.3.0-alpha.11] - 2026-08-14

### Fixed

- Web 创建和修复 ephemeral Side 时不再调用 app-server 明确禁止的 `thread/read(includeTurns:true)` 或 `thread/turns/list`，也不再把 `thread/resume` 返回的 `no rollout found` 当成 Side 已消失。新分叉使用有界 `thread/fork` 内存快照，当前页面再用完整 turn 事件更新该快照，并只通过 `thread/read(includeTurns:false)` 核对实时状态；暂时读取失败保留 Side，只有 app-server 实例代次明确变化才安全返回主会话。

## [0.3.0-alpha.10] - 2026-08-13

### Changed

- Web 不再用对话页顶栏按钮填入 Side 命令；输入框只在首字符开始的 `/`、`/s`、`/si`、`/sid` 或 `/side` 显示单项补全，并支持点击、Tab 或 Enter 完成 `/side `。只有绝对位于输入首部、带斜杠且包含非空问题的 `/side <问题>` 才会触发临时分叉，前导空格、普通 `side` 和正文中的 `/side` 均按普通消息处理。

### Fixed

- Web 创建空闲 ephemeral Side 后不再立即把它当作磁盘 rollout 调用 `thread/resume`，避免成功分叉后报 `no rollout found for thread id`、首条 Side 问题未发送并停在骨架屏。新分叉直接使用有界 `thread/fork` 内存快照；重连时先只读检查内存 thread，只有仍在运行的 Side 才调用 resume 重新订阅事件。确定 Side 已不存在时停止同步并安全返回主会话，不再以短周期、不同幂等键持续缓存失败的 resume 结果并放大 Host SQLite。

## [0.3.0-alpha.9] - 2026-08-13

### Changed

- 移除 Web 中复制 Codex TUI 完整清单的斜杠指令补全和手工 adapter，仅新增经过独立设计的 `/side <问题>`：Web 先从 Noise 加密握手协商 `side-fork-v1`，并在断线重试前重新核对，旧 Agent 缺少能力时在副作用前失败关闭；后端再调用原生 `thread/fork` 并要求 `ephemeral: true`，前端以明确的 Side 顶栏、主会话返回入口和移动端布局隔离临时支线。Side 分叉响应只携带版本化继承边界与不透明 app-server 实例代次，边界参与幂等身份；连接中断后用原幂等键恢复，返回成功前会向当前 app-server 验证临时 thread 仍存在。同宿主机重新认证和静默重连均保留 Side 与人工核对状态，暂时重开失败不丢弃唯一 Side handle；只有 app-server 实例代次明确变化才安全返回父 thread，原 Side 待确认消息会在父 thread 中继续显示为可显式放弃的人工核对项。Side 内待确认消息会阻止主动离开，Agent 也在协议层拒绝持久 Queue。Side 不进入会话列表，继承历史只作为模型上下文而不重复渲染；其他 `/` 输入继续失败关闭。

### Fixed

- Web 打开活动会话时使用显式的历史初始化状态，分页结果确定前不会启动完整历史 snapshot；初始化请求瞬时失败后会继续重试 `thread/resume`，并绕过普通 repair 的 1.25 秒实时静默门槛，所有 turn 完成/空闲路径也会保留初始化计时器，不会永久停在不可修复的 `initializing` 状态。新会话从首个 turn 起使用有界分页同步，延迟到达的 legacy 完整快照也不能覆盖最近 20 个 turn。后台 repair 会为尚未建立分页状态的新会话保留更早历史 cursor；用户已经加载到历史尽头时，只要 repair 页仍覆盖当时已加载的最新边界就保持 exhaustion，若边界已被更多新 turn 推出窗口则重新建立 cursor，使漏失的中间 turn 仍可分页到达。旧 app-server 不支持 `thread/turns/list` 时，新会话会自动降级到 legacy repair。legacy 完整结果仍只向 DOM 提交最近 20 个 turn，但待确认发送使用未截断结果做安全对账，不再把窗口外的已完成操作误判为缺失。
- Web 时间线只用 item ID 或 `clientUserMessageId` 精确合并用户消息，不能把同 turn 中任意已有用户消息当成 Steer 新消息已同步的证据。助手只在 item 完成阶段把 ID 变化的流式 item 与权威项做 turn、类型和完整文本唯一匹配；新的 `item/started` 不会误覆盖同 turn 中上一条漏失完成通知的流式输出，权威 item 自身已存在时也不会跨 ID 删除同文 sibling stream。快照、完成通知和乐观卡片乱序到达时不再显示重复的用户消息或首条 Codex 回复，存在多个同文候选时则保守保留而不猜测。流式卡片只有在权威 turn 仍为 `inProgress` 时才能覆盖快照；repair 窗口之外的旧卡会在原位置结束动画并保留 turn、类型与原文身份，之后分页或迟到完成事件加载权威 turn 时会精确清理该 loose 卡，避免会话空闲后永久闪烁、把旧回复移动到最新位置或再次显示重复回复。

## [0.3.0-alpha.8] - 2026-08-12

### Fixed

- 真实 Codex app-server 合同测试清理临时目录时会对 Linux 上短暂存在的后台插件 clone 文件执行有界重试，避免把已通过的协议合同误报为 `ENOTEMPTY` 发布失败。

## [0.3.0-alpha.7] - 2026-08-12

### Fixed

- 用户名 Passkey 登录和恢复票据失效后的重新认证会请求宿主机返回已登记 credential ID 的 `allowCredentials`，不再错误地要求现有 Passkey 必须是可发现凭据；普通模式、无痕模式和跨设备认证均可使用注册时允许的服务端凭据。
- 登录页的已有设备“继续”和 Passkey 登录按钮在验证期间会立即锁定，并显示“正在验证…”与加载动画；管理员登录操作使用相同反馈，避免移动端卡顿时重复触发多个 WebAuthn 请求。

### Changed

- README 重组为面向开源用户的项目入口，并移除非真实产品界面示意图；在能够提供真实、可脱敏截图前不展示产品截图。

## [0.3.0-alpha.6] - 2026-08-11

### Added

- 对话时间线为用户、Codex、工具与系统消息显示自动更新的相对时间；悬停可查看本地精确时间，历史记录优先使用 turn 时间并兼容 UUIDv7 回退。
- 会话列表新增服务端分页、最近/归档过滤和归档恢复；`/resume` 可跨两类列表搜索，并对精确 thread ID 使用权威读取。
- Relay 新增进程内单来源 socket、登录查询和 tunnel 建连预算，以及 tunnel 待发送字节上限；生产反向代理示例同步限制 WebSocket 建连速率。
- rootless provisioner 新增 UID/NSS 绑定的私有随机 route registry 与 feature-negotiated same-route capability renewal；Agent 从到期前 30 天开始无限次重试，并把间隔按剩余寿命限制为至多 12 小时、1 小时或 5 分钟，同时按随机 route 做确定性抖动，`ce doctor` 和 `ce provisioner status` 提前显示授权到期风险。Administrator Controller 使用独立的 root-registered host-admin route binding、相同的续签窗口与分级退避，新 capability 原子落盘后只轮换 control，且不会取得 provisioner credential。

### Fixed

- Codex app-server Unix WebSocket 在 upgrade 前超时不再因移除 `error` listener 后调用 `terminate()` 而触发未处理异常并杀死 Agent；冷启动窗口从 15 秒扩展到 60 秒，并发请求会等待同一个受控启动完成，Web 重启请求覆盖完整的停止与冷启动窗口。启动保留记录持续到协议探测成功，因此 `status` 不会把正常慢启动误报为无响应；失败或运行中断开的 lazy inner session 会从当前 Host 会话清除并允许后续请求无须重新 Passkey 即可重连。新增 `ce app-server status` 与要求匹配 PID、显式 `--force` 的安全恢复入口，watchdog 对可能仍承载活动 turn 的 live-unresponsive owner 继续失败关闭而不擅自终止；缺少 Linux 不可变进程身份的平台在 `SIGTERM` 无效后拒绝升级为 `SIGKILL`。
- HPC/NFS/FUSE 文件系统在原子 rename/link 已发布后若以 `EINVAL`、`ENOTSUP` 或 `EOPNOTSUPP` 表示不支持目录 `fsync`，Host 配置、SQLite 状态、Noise 身份、Codex `auth.json`、provisioner 私有配置与进程记录不再误报失败；文件 `fsync` 以及目录 `EIO`/`EPERM` 等真实错误仍会失败关闭。
- 已打开页面不再因固定会话 TTL、单次心跳抖动或普通 RPC deadline 被迫离线：Direct、Relay control 与 tunnel 统一容忍连续 4 个 15 秒心跳周期，页面以最高 30 秒间隔无限重建 transport，并用绑定 Noise 身份的页面内存票据静默恢复已认证状态；普通用户和管理员的 `host/ping` 仅请求超时时会保留健康 client 并稍后复查，只有真实 transport 丢失或明确 Host 拒绝才进入恢复。同设备多窗口票据彼此独立，失效或已撤销设备通过加密握手中的结构化 `REAUTH_REQUIRED` 可靠回退，后台不触发 WebAuthn，可见后的单次交互若取消或失败会进入显式登录而不是无限重弹，反向代理清除 WebSocket close reason 也不会造成坏票据死循环。管理员页面静默恢复会继承原登录时间，不会刷新危险操作要求的五分钟 recent-auth 窗口。
- 凭据恢复现在以认证 challenge 开始时的代次做 CAS，并与添加 Passkey、轮换恢复码和设置专用密码串行；恢复完成会撤销活动会话与全部页面票据。CLI 撤销可信设备后，新的 resume 会重新读取持久设备状态并使该设备全部 remembered 多窗口票据失效，同时不误伤之后经 Passkey 建立的临时页面会话。
- turn 完成、后台近期 turn 合并及 snapshot 同步都会保留每个 item 已收到的准确生命周期时间，不再把 Codex 与工具卡片重置为 turn 起止时间；消息时间在明暗主题下使用满足小字号可读性的高对比配色。
- 会话创建时或之后明确修改的审批策略、审批 reviewer 与 sandbox 权限会保存在该 Linux 用户自己的 Host 状态中；Web、后台 Queue 和所有 `ce tui` 入口以跨进程持久代次、CAS 与 per-thread coordination fence 串行化权限副作用和保存，合法的长时间权限修复可等待前一 owner 完成并在关闭时取消，不再复用普通事务的十秒 acquisition deadline；Agent 或 Codex app-server 重启后不再回落为“按需审批 + 可写工作目录”。resume 的 `null`/缺失字段按继承处理，未知新版权限值和无版本广播仍会正常转发，但不会清空其他字段或以旧值覆盖 Codex。
- 本次权限协调格式升级要求先重启用户 Agent，再让升级前已经运行的 `ce tui` 退出并重连；关闭 TUI 不会终止活动 turn。旧进程已加载的 JavaScript 无法被新版本的持久代次和 coordination fence 追溯约束，完成重连前不承诺新并发语义。
- `turn/start` 或 `queue/add` 在连接中断后不再把“结果未知”误报为失败并恢复成可重复发送的草稿；页面保留原 operation/idempotency key，并优先用有界的最近 turn 分页与 Queue 快照确认是否已经提交。完整分页，或包含发送前已观察到的最新 turn 边界的近期页，才能用“未找到”驱动同键重试；边界已被更多新 turn 挤出时继续等待。旧 app-server 的完整历史快照缓存只用于按 operation ID 正向确认，不能跨轮与后来的 Queue 快照组合成负证据；Queue 的负向对账必须在同轮先成功读取 Queue，再成功读取新的完整历史。每个 client/operation 的完整读取总计最多 3 次或持续 30 秒，Queue 当轮缺失时的成功读取也计数，失败或退避期间缓存仍只用于正向确认；耗尽后停止自动重试并展示人工刷新核对与风险确认后的显式放弃入口。发送 operation key、待确认状态和快照缓存只存在于当前页面内存，离开或刷新时会提示但不会持久化业务内容。
- `thread/start`、`turn/start` 与 `queue/add` 在副作用前持久化不自动过期的安全操作身份和 durable claim，并向旧 Agent 的普通幂等表写入永久 fail-closed 镜像。指纹不包含 prompt、文件内容或整包 payload 哈希；`thread/start` 只保存可验证且不含 prompt 的成功结果，`turn/start` 与 `queue/add` 的内容型成功响应仅在 tombstone 落盘后返回当前内存调用，永久表始终只保留 `IDEMPOTENCY_OUTCOME_INDETERMINATE`，后续同 key 不会重放并改由 `clientUserMessageId` 对账。handler 拒绝、响应不可验证或结果提交失败同样永久失败关闭；升级还会安全迁移并物理清除短期未发布旧表中的 payload 哈希。thread 创建待核对时，Web 要求用户刷新会话列表并显式放弃本地记录，不会按目录或时间猜测结果；同一标签页的 `sessionStorage` 只保存不含业务内容、目录或 Host 信息的固定版本 opaque 标记，并在离开页面前提示。
- Host Queue 新增旧版可忽略的 additive 逻辑状态：新版 add 从同一事务起让兼容 Queue 行始终保持物理 `done`，pending / paused / running 仅在新表中推进，因此回滚旧 Agent 仍可启动，但看不到或重派新版消息。后台 `turn/start`、Gateway fallback 与 Queue 转 `turn/steer` 按稳定 queue item 身份共用一份永久消费 claim；副作用前同事务写 claim、删除逻辑状态，且不保存或散列 prompt/附件。accepted 后断连、权限保存失败、响应不可验证或 claim 完成失败都会永久显示为“结果待核对”，重启和旧 Agent 回滚均不能再次投递；indeterminate 标记遇到瞬时存储失败时由生命周期内的单计时器 repair coordinator 按 item 去重并指数退避，只重试状态落盘、绝不重跑 app-server 请求，关闭后仍由下次启动接管。该项同时阻断同 thread 后续 dispatch/Steer，只有用户核对权威历史并显式确认风险后才能标记放弃、删除记录并唤醒后续队列。每次打开状态库都会把任何物理非 `done` 行视为旧 Agent 在回滚期间创建或恢复的不可证明结果并保守隔离，修复了 consumption 表已存在时 new → old → new 仍可能重放的升级缺口；正常新版 pending 项跨重启保持可投递。
- Service Worker 更新改为用户确认后的安全激活，不再因 `skipWaiting` 和 `controllerchange` 强制刷新而丢失草稿或一次性恢复码；Vite 构建清单中的所有 hash chunk（包括延迟加载的 OPAQUE）会随外壳预缓存，激活时只删除没有活动旧标签页声明使用的版本缓存，网络返回 SPA fallback HTML 时也会优先从对应旧缓存恢复脚本。管理员页面同样会在休眠、断网和重新上线后恢复连接。
- 首个 Passkey 的最终写入增加事务内空表断言；WebAuthn 注册/认证 challenge、恢复授权与 OPAQUE 登录中间态变为五分钟内一次性使用，并在成功、撤销、关闭或定时到期时主动清除，避免并发首次注册和陈旧认证状态。
- Host 状态迁移与事务统一使用带所有权证明、租约和安全接管的跨进程锁；进程锁和 app-server supervisor 不再仅凭可复用 PID 判断身份，也不会在释放时删除后继 owner。锁存活性只比较 PID、启动时间、boot ID 与 UID，不再因运行期间 Node 可执行路径或命令行显示变化而误回收；可变字段仅在发信号前作为显式目标校验。app-server supervisor 会在 spawn 前原子发布带 boot identity 的启动保留记录，再原子发布 child 的不可变进程身份；即使 supervisor 在两者之间崩溃，后继也会失败关闭而不会启动第二实例。
- 移除 workspace 会持久推进授权 revision；已打开的 Web 会话、待处理审批和后台 Queue 在继续转发或响应前重新验证 thread 的真实 cwd，撤权后暂停并释放订阅。
- Web Gateway 失效时会立即释放 Noise 分片重组缓冲，而不是等待 assembly timer；Agent 的 notification、server request 与 Queue event 异步授权复核也会在状态库读取失败时失败关闭并消费 rejection，避免瞬时 I/O 错误升级成 Node 未处理 Promise rejection。
- 首屏主题初始化移出内联脚本以符合生产 CSP；流式 Markdown 增量按绘制帧合并，item 更新使用精确 DOM 定位，避免每个传输 delta 重解析累计全文和扫描完整时间线。
- provisioned Relay capability 续签先原子保存新凭据，再只轮换 control 注册而保留已建立 tunnel；普通用户不能提交或替换 route ID。升级前 route 只允许在旧 capability 与对应旧 credential 仍有效时完整验签迁入，过期验签材料会自动删除。
- Relay control 轮换在注册帧发送后即把已持久化的新 capability 作为重连目标，即使 Relay 已接受注册但确认帧丢失，也不会回退到会被授权高水位拒绝的旧 capability。宿主机 transport、Passkey origin 与 Codex 网络设置统一在跨进程协调锁内重新读取并合并最新配置，续签与用户代理修改不再以陈旧整文件快照互相覆盖。
- Relay 现在按 capability 与 provisioner credential 的更早绝对截止时间撤销 route，统一清理 control、pending/setup 和 active tunnel；same-route 续签会原地延长授权且拒绝旧 capability 回滚 deadline，临近截止的 Agent 调度会预留 45 秒并在不足该窗口时立即续签。

### Changed

- 移除对话页顶部重复的会话设置齿轮；权限、模型与思考强度继续从输入框状态栏直接进入设置。
- HPC Release 安装必须由显式批准的 manifest SHA-256，或绑定目标仓库、Release workflow、tag ref、manifest commit 与 GitHub-hosted runner 的 attestation 建立独立信任根；manifest、制品、build-info、project、协议、Node 版本及安装树 inventory 写完后才原子切换 `current`。
- Release CI 会运行真实 Codex app-server adapter 合同测试；本地制品脚本拒绝脏工作树、错误 commit 和不匹配 tag。生产回滚与重复安装会重新验证完整文件 inventory 并拒绝内容漂移，development 回滚需要显式开关，旧目录不会被静默补证。
- Relay v1 wire 常量与解析器集中到共享协议包；当前 Agent/Web/Relay 明确采用严格 v1 fail-closed，而不是声称尚未实现的滚动版本协商。

### Security

- 页面恢复票据使用 256-bit 随机值，Agent 只在进程内保存绑定完整 Noise/身份域的 SHA-256 摘要并实行每设备与全局 LRU 上限。恢复码、票据、OPAQUE 响应、设备登录码和管理员交接码不再写入持久幂等表；同 transport 只在最多 128 项、5 分钟的有界内存中保留原响应用于处理响应丢失，到期即使没有后续请求也主动清除，迁移同时以 SQLite secure-delete 清理历史敏感结果。
- Web 对握手、cipher、response/event 和 Relay 控制消息执行版本、形状、大小和 user/admin 身份域校验；合法未知 Codex event 仍按 generic event 向前兼容。
- Noise 接收端增加单消息上限、独立的片间 idle timeout 与不可续期 absolute deadline、跨会话共享重组内存预算和显式释放，slow-drip 分片不能长期占用 Agent 内存。
- Relay 只在显式启用且来源为 loopback 代理时信任合法 `X-Real-IP`；地址 rate bucket 采用硬上限和单次常数工作量清理，转发同时受单 tunnel 与跨 tunnel 全进程 pending-byte 预算约束并在发送或关闭后释放；新签发 legacy route capability 必须明确设置有效期。
- 管理员所有用户变更在副作用前重新核对 NSS username/UID、home realpath 与目录所有者；同 request ID 并发请求合并，不同输入拒绝，UID 或用户名复用不能静默接管原登记。

## [0.3.0-alpha.5] - 2026-08-09

### Added

- 新增统一设置中心和宿主机持久化的新会话默认权限；Queue、停止操作和顺序审批托盘固定在输入框附近，持续回复时仍保持可见。

### Changed

- 对话页将权限、模型、思考强度和上下文占用压缩到输入器状态栏，并使用可访问的环形进度显示上下文使用情况。
- 浏览器从后台恢复或网络重新上线时会探测 Host 并协调重连；Relay 为浏览器 tunnel 增加 ping/pong 心跳，避免继续复用休眠或网络切换后形成的半开 WebSocket。
- Codex app-server TypeScript schema 编译基线更新至 `0.147.0`；运行时仍接受任何能够正常报告语义版本的 Codex CLI。

### Fixed

- Codex 网络设置在复制内容或触发原生取消事件时不再意外关闭。
- Queue 消息、审批状态和运行中 turn 的停止入口不再被流式回复刷出可见区域，审批提交期间会锁定按钮以防重复操作。
- 实时事件、本地乐观消息和后台快照现在按 turn/item 身份归并，避免用户消息及首次助手回复临时重复显示。
- WebSocket 被证明失败后会废弃旧 tunnel；单个 Host 请求超时不会再杀死健康 transport。状态变更请求保留原幂等键并先核对权威结果，防止 Host 已执行时产生重复副作用。

## [0.3.0-alpha.4] - 2026-08-07

### Fixed

- rootless Agent 安装器不再把目标已限制在 bundle 内的标准 pnpm 符号链接按 Linux 固定的 `0777` 链接模式误判为全局可写；链接目标本身仍继续接受路径逃逸与写权限检查。

## [0.3.0-alpha.3] - 2026-08-07

### Fixed

- HPC Release 安装器在 GitHub Release CDN 跳转或 TLS 连接短暂中断时会使用兼容 CentOS 7 旧版 curl 的有界重试，并通过临时文件避免把不完整下载误当成可校验制品。

### Changed

- 公开仓库新增自动卫生检查，拒绝跟踪运行状态、凭据文件、私钥标记、真实用户 home、公网 IP，以及在公开 CI 中使用 SSH/rsync 部署；部署文档明确个人或单集群的生产配置默认只保存在对应服务器，私有 ops 仓库仅作为多环境协作选项。
- 文档与测试不再使用特定集群的本地代理端口，统一改为 `example.com` 占位符；真实代理默认值只属于宿主机 provisioner 配置。
- rootless HPC 安装与回滚会在服务器安装根目录原子记录 `active-release`，并为正式 Release 保存已验证的 manifest；生产版本 inventory 不再依赖开发仓库或人工命名的备份目录。

## [0.3.0-alpha.2] - 2026-08-07

### Added

- 新增由 GitHub tag 的干净 checkout 生成 Web、Agent、Relay 和 HPC 工具不可变制品的 Release pipeline；每个 Release 附带组件版本、commit、协议版本、文件大小、SHA-256 校验和与 GitHub provenance attestation。
- 新增只消费 GitHub Release 的 rootless HPC 安装入口；专用部署账号会下载并交叉校验 manifest、校验和与 Agent 制品，再复用原子 release 安装器完成升级或回滚。
- 新增由无特权 `codexeverywhere` 专用账号运行的 rootless provisioner、tmux/crontab watchdog、原子发行版安装/回滚脚本和一次性 root-safe 全局 launcher；日常部署与现有 SSH 用户自助初始化不再依赖 sudo。
- 新增独立 `/admin` 宿主机管理页面、Administrator Controller 和固定 root helper，支持现有 Unix 用户登记、Web 停用/启用、10 分钟恢复交接码、24 小时可撤销移除和最小安全审计。
- 管理员身份支持 Passkey 与独立 OPAQUE 管理密码；管理员密码不复用或验证 SSH 密码。
- 对话页新增基于用户消息的右侧大纲，支持当前位置提示和点击平滑跳转；窄屏以侧滑面板呈现，避免压缩消息与输入区域。

### Changed

- 开发、发布和部署正式解耦：功能分支只通过 PR 进入受保护的公开 `main`，生产环境只接受属于 `main` 的不可变 tag/Release 制品，不再从本地工作区或功能分支直接构建。
- Agent 与 Relay CLI 的 `--version` 现在读取各自发布包版本；Relay production bundle 限制为运行时 `dist`、package metadata、许可证和生产依赖，不再夹带源码、测试或 TypeScript 配置。
- 生产 Agent/Relay bundle 使用隔离的现代 pnpm deploy，不再把开发工作区依赖切换为 production；制品只保留运行所需文件，并在安装前拒绝组/全局可写路径、逃逸符号链接和泄漏开发机路径的坏链接。
- Codex 探测不再锁定单一 CLI 版本；任何能正常报告语义版本的现有安装都可运行，PWA 初始化和设置页可将 npm 最新稳定版安装或更新到用户自己的 `~/.local`，并在 app-server 正在运行时把重启应用留给用户确认。
- Codex 版本设置现在分别显示宿主机当前安装版本与 npm 最新稳定版，明确标记可更新、已是最新或本机版本更高；npm 查询失败不会遮住已安装版本。
- HPC 共享 Agent 安装器会规范化 release 目录的只读权限，避免从严格 umask 构建目录部署时普通用户无法加载 CLI。
- Web 对话页现在安全渲染 Codex 代码围栏，并将 `fileChange` 的结构化 kind、实时 `patchUpdated` 和 unified diff 显示为可展开的逐行差异，避免对象字符串、原始事件 JSON 和整段单色 diff。
- 文件修改卡片中的逐行差异默认收起，只在用户明确展开后显示；同一文件在流式更新或后台快照刷新时会保留用户当前的展开状态。
- Codex 回复改用关闭原始 HTML、禁用 KaTeX trust 并经 DOMPurify 二次清理的 Markdown 管线，支持标题、强调、列表、引用、表格、链接、代码块，以及 `$…$`、`$$…$$`、`\\(…\\)`、`\\[…\\]` LaTeX 公式。
- 会话页为 header、权限概览、SSH 提示、timeline 和输入框使用固定 Grid 区域；隐藏可选提示或持续接收长回复时，timeline 只在自己的滚动区域增长，不再把底部输入框挤出视口。
- Web 会将重叠的历史刷新合并为 single-flight，并使用 app-server 状态库快速列出 CLI、VS Code 和 Web thread；状态库尚未建立索引或旧 Codex 拒绝快速参数时会自动回退传统扫描，Agent 对重复 cwd 只执行一次工作区边界校验，并为 app-server 列表请求设置有界等待与不含业务内容的慢请求耗时日志，避免 HPC 共享文件系统延迟导致 `thread/list` 排队超时或永久占住队列。
- 审批与用户问答按钮会在提交后立即锁定并显示确认进度，成功、跨客户端处理和失败重试均提供明确的卡片内状态，避免重复提交。
- Web 公式渲染器与样式表固定使用同一 KaTeX 版本，样式随应用入口统一加载；块级公式使用独立滚动外壳，并为 KaTeX 根号最小化保留必要的 SVG 图元，避免帽号、上下标、分式、根号和运算符因缓存错配、纵向裁切或安全清理而错位。
- 围栏代码块不再继承行内代码的浅色背景，深色代码面板中的正文恢复为高对比度配色。
- Codex 流式回复和后台 snapshot 修复仅在用户接近 timeline 底部时自动跟随；用户向上阅读历史后保持当前位置，并可通过“回到最新消息”恢复跟随。
- 桌面端对话大纲现在从侧栏标题直接收起，并通过对话区右缘的贴边标签恢复，收起后消息与输入区域自动恢复整宽；窄屏继续使用顶部入口和可关闭的侧滑面板。
- 长会话首次打开只读取最近 20 个 turn，并提供保持阅读位置的“加载更早消息”；后台同步仅获取元数据和最近 5 个 turn，收起的命令输出与文件差异延迟到展开时渲染，旧版 Codex 不支持分页时自动回退完整历史。
- Web 不再把 TUI 终端交互、hook、MCP 进度、实时音频和其他内部生命周期通知显示为原始 JSON；真正的 Codex 错误与警告仍以可读提示呈现。
- 实时事件产生的临时消息卡与后台 turn 快照按 turn/item ID 合并；本地乐观用户消息在对应正式 turn 出现后移除，并主动清理同一 item 的残留副本，避免发送一次却临时显示两条、刷新后才恢复。

### Security

- GitHub CI、制品上传/下载与 provenance actions 升级到官方当前版本并固定完整 commit SHA，避免可变 action tag 和已弃用 Actions Node runtime 进入发布信任链。
- rootless self-provision 以请求文件的内核所有者 UID 为身份依据，通过 NSS 复核 Unix 账号，并用绑定 request ID、时效和 provisioner 公钥的 Noise 握手加密每个 grant；认证异常不会降级到旧 sudo helper。
- 管理员与普通用户使用不同的 Relay principal、route capability purpose、keyed login ID、Noise user ID、Passkey/OPAQUE 身份域、状态库和浏览器 Host Profile。
- 管理变更采用 revision 并发保护、request ID 幂等和 root-only 审计；停用 Agent 不会停止用户的 Codex app-server、SSH、TUI 或活动 turn。
- 生产 Nginx CSP 仅通过 `style-src-attr` 放行 KaTeX 动态生成的布局属性，修复线上公式错位，同时继续禁止内联脚本和内联 `<style>` 元素。

## [0.3.0-alpha.1] - 2026-08-04

首个公开 Alpha 版本。

### Added

- Linux/HPC 用户级 Agent、长期 Codex app-server 和官方 TUI 接力。
- 响应式 Web/PWA 会话界面、审批、工作区管理和深浅色主题。
- 持久 Queue、Queue 转 Steer、Interrupt 和断线恢复。
- Direct Gateway 与可选无状态端到端加密 Relay。
- Passkey、OPAQUE 专用密码、恢复码和临时设备模式。
- Codex 用户级安装、设备码登录与显式 `auth.json` 导入。
- 多用户 HPC 共享安装和现有 SSH 用户自助初始化。

### Security

- Unix 用户级业务数据与进程隔离。
- workspace `realpath`、root 包含关系和符号链接逃逸检查。
- Noise 加密帧、重放保护和不持久化业务数据的 Relay。
- 公开发布前的身份标识与高置信凭据扫描。

### Known limitations

- 仍处于 Alpha 阶段，不保证早期配置、协议和存储结构兼容。
- 尚未提供稳定预构建包、容器镜像或 npm 发布物。
- thread 归档/删除、完整文件浏览、Schedule 和 Web Push 尚未完成。
