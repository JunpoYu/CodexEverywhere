# 版本记录

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构，并使用[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Fixed

- Web 打开活动会话时使用显式的历史初始化状态，分页结果确定前不会启动完整历史 snapshot；新会话从首个 turn 起使用有界分页同步，延迟到达的 legacy 完整快照也不能覆盖最近 20 个 turn。后台 repair 会保留分页响应返回的更早历史 cursor；旧 app-server 不支持 `thread/turns/list` 时，新会话会自动降级到 legacy repair。legacy 完整结果仍只向 DOM 提交最近 20 个 turn，但待确认发送使用未截断结果做安全对账，不再把窗口外的已完成操作误判为缺失。
- Web 时间线会用 `clientUserMessageId` 或同一 turn 的生命周期身份合并用户消息，并在助手流式 item 的 ID 被权威完成项替换时用 turn、类型和完整文本做唯一匹配；快照、完成通知和乐观卡片乱序到达时不再显示重复的用户消息或首条 Codex 回复，存在多个同文候选时则保守保留而不猜测。流式卡片只有在权威 turn 仍为 `inProgress` 时才能覆盖快照；完成通知会清理同 turn 的残留流式卡，repair 窗口之外的旧卡也会结束动画，避免会话已经空闲却永久显示闪烁光标。

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
