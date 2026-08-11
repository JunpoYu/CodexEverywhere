# CodexEverywhere：架构与产品规格

面向 Linux/HPC、可信小团队的自托管 Codex Web/PWA 控制平台。

> 当前状态：`v0.3` 核心会话体验首批能力已经实现并在兼容目标环境完成验证。本文档同时是当前实现说明、产品规格和后续路线的事实源。

项目尚未发布稳定版，不承诺兼容早期配置、Host Profile、配对文档或内部协议。实现应直接采用当前最优方案；发生协议或存储结构变化时，升级部署可以显式迁移或重新初始化测试数据，不保留长期双栈兼容代码。

## 0. 当前可用范围

当前版本已经形成从浏览器到真实 Codex app-server 的可用闭环：

- 每个 Linux 用户一个独立 Agent 和长期 app-server，使用自己的 `~/.codex` 登录状态。
- 管理员只需创建一个无特权专用部署账号并完成一次固定全局 launcher 安装；共享运行时、版本化 Agent 和宿主机 provisioner 此后都由该账号维护。任何能够通过现有 HPC 策略 SSH 登录、可由 NSS 查询且 home/shell 合规的 Linux 用户，都可直接执行 `ce device pair` 自行初始化，无需管理员逐个开通或调用 sudo。
- Agent 可在 Codex 尚未安装时启动；PWA 首次使用向导可选择直连或用户代理，使用当前账号中任何能够正常报告版本的 Codex，或把 npm 最新稳定版安装到 `~/.local`，并通过官方设备码流程完成登录。已登录用户也可从设置中更新；安装不会立即中断运行中的 app-server，用户在任务空闲时明确确认重启后才应用。安装过程通过端到端加密会话显示“准备、下载与安装、验证、完成”的阶段进度；不向浏览器转发可能包含代理或凭据的 npm 原始输出，也不伪造无法可靠获取的字节百分比。Codex 登录页以分步卡片突出官方验证入口和一次性代码，支持一键复制；页面以 app-server 的 `account/login/completed` / `account/updated` 通知为完成信号并以状态轮询兜底，授权完成后自动进入工作区。已经在本机登录 Codex 的用户也可使用标准位置 `~/.codex/auth.json`：PWA 将标准路径作为主入口并支持一键复制，同时保留按钮式的其他来源文件入口。macOS 文件窗口默认隐藏 `.codex`，界面必须提示用户先复制 `~/.codex/`，再在文件窗口按 `⌘⇧G` 打开“前往文件夹”、粘贴目录并选择 `auth.json`；浏览器安全模型仍要求用户在系统文件窗口确认一次。PWA 只在当前页面内存中读取文件，经过现有端到端加密通道直接原子写入该 Linux 用户的 `~/.codex/auth.json`，随后重启 app-server；Relay 不可见，浏览器不持久化文件内容、访问句柄或回显内容。
- PWA 将日常登录与首次初始化完全分开：老用户首页只保留已保存设备或“用户名 + Passkey”的主路径，密码、临时设备和 Direct 地址作为次级入口；专用密码登录默认不记住设备且不要求设备名称，只有用户显式勾选保存新设备时才显示命名输入，当前浏览器已有同一用户记录时沿用原名称；每个已保存入口同时显示用户自定义的设备名和对应 Linux 用户名，避免同一浏览器保存多个 HPC 账号时混淆；新用户按“建立 Web 身份 → 网络 → 安装 → Codex 登录”逐步完成引导。
- Direct WSS 或可选无状态 Relay；两种模式都在应用层使用 Noise IK 端到端加密。
- Noise 加密传输会在记录层自动分片并重组大型响应与事件；每个重组同时受单消息大小、跨会话总内存、片间 idle timeout 和不可续期 absolute deadline 限制。恢复长会话或出现大型工具输出时不会受单条 Noise 消息的 65,535 字节上限影响，slow-drip 分片也不能长期占住共享预算。
- 浏览器在 HPC 内网或宿主机具有安全公网入口时直接连接 Agent；只有宿主机不可达时才经过 Relay。
- 同一个 Agent 可同时运行 Direct Gateway 和 Relay 出站连接；PWA 保存双端点并按 Direct、Relay 顺序连接。
- Direct Gateway 提供 `/.well-known/codex-everywhere` 标准发现文档，并只接受已配置 PWA Origin 的浏览器请求。
- 一次性设备配对、可信设备撤销、宿主机本地 Passkey 验证和一次性恢复码。
- Relay 在线登录名查询、未知设备预认证、Passkey 与 CodexEverywhere 专用密码双登录。
- 密码使用 OPAQUE PAKE，不向 Relay 或静态 Web 服务暴露；临时模式不持久化设备资料。
- 已认证用户可添加 Passkey、设置专用密码并轮换只显示一次的恢复码。
- 新注册的 Passkey 使用 Linux 用户名作为 WebAuthn 账户标识，并使用“用户名 · 宿主机名”作为显示名，不向用户暴露 `unix:<uid>`；WebAuthn 的稳定二进制用户句柄保持不变。浏览器或系统密码管理器可能采用自己的展示样式，已有 Passkey 的名称不会被远程改写。
- workspace 白名单、真实路径与符号链接逃逸防护。
- PWA 使用移动优先的会话列表与会话详情导航，支持按 workspace 分组和搜索 thread。
- PWA 默认跟随操作系统的浅色/深色外观，也可在顶栏手动固定浅色或深色；选择仅保存在当前浏览器，并同步更新浏览器/PWA 的主题色。
- 左侧栏将“会话范围”与 thread 自身的工作目录明确分离：用户可直接按已注册 workspace 或全部 workspace 筛选会话，并通过清晰的“管理工作区”按钮进入目录管理；筛选范围覆盖多个实际 `cwd` 时，会话按相对工作目录折叠分组，搜索自动展开命中分组，当前会话所在分组保持展开；新会话优先使用当前筛选 workspace。切换筛选不会修改已打开 thread 的 `cwd`，两者不一致时界面必须明确提示并提供一键切回。
- 工作目录支持宿主机目录浏览器：管理目录时可从当前 Linux 用户的主目录或已允许 workspace 逐层查看子目录并填入路径；新建会话时可在已允许 workspace 内继续选择任意子目录，不要求用户记住完整绝对路径。手动输入绝对路径仍保留，用于主目录和既有 workspace 之外的 HPC 路径。
- 新建会话使用独立对话框，模型与 reasoning effort 从 app-server 动态读取，目录、sandbox 和 approval policy 可在启动前选择。
- PWA 通过 `thread/read` 快照和增量 notification 结构化显示用户消息、Codex 回复、plan、命令、文件修改、MCP、subagent、错误和未知 generic event。每张时间线卡片显示相对时间并以本地精确时间作为辅助信息；快照优先使用 turn 起止时间，实时卡片使用 item 生命周期时间，缺失旧数据时从 UUIDv7 turn id 恢复近似创建时间。reasoning item 及其增量事件不进入 Web 时间线，Web 也不覆盖 Codex 的 reasoning summary 配置。
- 尚未选择会话时，会话时间线保持空白，不消费 app-server 通知；`configWarning`、`remoteControl/status/changed` 和账号状态等宿主机级事件即使在会话打开后也不作为原始 JSON 混入对话。MCP 启动失败使用不含 Transport 堆栈的结构化提示，并区分网络失败与需要重新授权；正常启动状态不写入时间线。当前 thread 的未知事件仍作为 generic event 显示，以保持协议向前兼容。
- app-server 重启后，发送消息会自动将 `notLoaded` 的磁盘 thread 恢复到内存，不要求用户手动执行 `thread/resume`。
- 日常工作区采用高密度会话侧栏、结构化时间线和固定底部输入器；提供加载骨架、状态动效、操作 Toast、输入失败恢复、移动端底部会话面板，以及 `Enter` 发送、`Shift+Enter` 换行、`Cmd/Ctrl+K` 搜索和 `Cmd/Ctrl+N` 新建会话。
- 输入器以经过回归测试的 Codex `0.144.1` 官方发布清单作为 Web 斜杠指令基线，并注册 `/pet`、`/clean` 别名；它不是 CLI 运行版本白名单。用户输入 `/` 时显示按官方顺序排列、可搜索且支持方向键、Tab、Enter 和触控的补全菜单；执行前在 Web 本地解析，绝不把未知指令、无效参数或忙碌期禁止执行的指令当作普通 prompt 或 Queue 消息。`/compact`、`/review`、`/rename`、`/new`、`/archive`、`/delete`、`/resume`、`/fork`、`/init`、`/goal`、`/skills`、`/mcp`、`/status`、`/usage`、`/copy`、`/theme`、`/logout` 等调用受限 app-server 方法或现有 Web 界面；依赖 TUI 本地状态、IDE、通用 Shell 或特定操作系统的指令仍被识别，并给出 SSH TUI 或平台限制说明。Web 网关不会为了 `/diff` 暴露任意命令执行接口；新版 CLI 新增指令需要后续 Web adapter 更新，但不会阻止其余兼容能力运行。
- 对话时间线是内容区内唯一的纵向滚动容器；会话头和输入器始终留在视口中，Codex 回复完成后自动滚动到最新消息。
- 已完成初始化的用户登录后直接进入工作区；Codex 直连/代理配置位于设置菜单，修改前明确提示会中断活动 turn，保存后重启 app-server 并自动重新连接。
- 会话头以紧凑状态区根据 app-server 增量事件实时显示正在思考、回复、执行命令、修改文件、调用工具、等待操作、完成或异常，而不是只显示笼统的 active 状态；完整会话设置保留明确的图标入口，常用的权限与模型设置同时在输入框状态栏中直接可见、可修改。
- Agent 在首次读取或列出 thread 时完成 workspace 授权并缓存结果；同一连接中的后续 delta notification 立即转发，workspace root 变化时清空缓存，避免逐条 `thread/read` 阻塞流式回复。notification、server request 与 Queue event 的异步 revision 复核均在回调边界消费 rejection；状态库瞬时读取失败时本次事件失败关闭，server request 返回授权不可验证错误，不得形成可能终止 Node 进程的未处理 Promise rejection。
- 活动会话以 app-server delta notification 为实时主通道；PWA 在短时间收不到事件时自动读取并合并最新 `thread/read` 快照，结束后立即停止同步，避免通知偶发丢失时必须手动点击会话刷新。
- 输入器以 app-server 的真实 thread 状态决定发送语义：空闲时启动 turn，活动或等待审批时默认持久加入宿主机 Queue。排队项不写入或临时插入历史时间线，而是在输入框上方的固定 Queue 托盘中显示数量、正文以及暂停、投递中或结果待核对状态；重新打开会话后从宿主机恢复。同一 thread 仅队首且尚未投递的项可在活动 turn 结束前原子转换为 Steer；尚未投递的项可安全移除，结果待核对项只能在用户核对权威历史并确认重复风险后放弃记录。发送失败会恢复输入内容，活动 turn 的停止按钮与发送操作同处输入器右侧。
- 命令、文件与权限审批，以及 `requestUserInput` 回答。
- 命令、网络、文件修改、额外权限审批和 `requestUserInput` 在输入框上方使用固定审批托盘显示人类可读摘要，不向普通用户倾倒协议 JSON，也不写入或临时插入历史时间线。多个并发请求按 request id 独立跟踪，一次只展开当前项，处理成功后短暂显示结果并自动推进；不提供批量允许。其他 Web/TUI 客户端先处理时同步更新托盘。存在审批时 Queue 压缩为可手动展开的单行摘要，全部处理后立即退出等待状态。
- 打开已有会话使用 `thread/resume` 而非只读 `thread/read`，确保当前浏览器连接订阅该 thread 的增量事件，并同时取得模型、推理强度、审批策略和 sandbox 设置。
- Web 为刚发送的用户消息创建乐观卡片，但以 `turn/start` 返回的 turn id 绑定身份；如果 `turn/started` 通知和后台快照先到达，绑定阶段必须立即移除已经存在权威用户消息的乐观副本。assistant 流式卡片除 item id 外还记录 turn id 与消息类型；快照或完成事件在生命周期阶段出现不同 item id 时，按同一 turn 内的类型归并并以权威完成项收口，禁止保留刷新后才消失的重复卡片。
- PWA 切换会话或返回会话列表时调用 `thread/unsubscribe` 释放旧订阅；Agent 级 Queue 在队列耗尽或暂停后也释放自己的订阅。释放订阅不 interrupt 活动 turn，最后一个订阅者离开后由 app-server 自身的无订阅宽限期决定何时卸载内存状态，不另设 24 小时保留定时器或用户“卸载”按钮。
- 已有会话可修改模型、推理强度、审批策略和文件/命令权限；PWA 通过原生 `thread/settings/update` 保存设置，并用 `thread/settings/updated` 同步其他已订阅客户端。设置由 app-server 用于后续 turn，活动 turn 不会被静默中断；若用户安装的 Codex 尚不提供该方法，adapter 必须返回明确的能力错误。
- 用户级全局设置集中在右上角设置中心。新会话默认 sandbox 与审批策略通过版本化 `preferences/read`、`preferences/session-permissions/update` 协议保存在该 Linux 用户自己的宿主机状态库中，浏览器只负责展示与修改；初始值为 `workspace-write + on-request`。创建 Web 会话时会明确展示并带入当前默认值，但设置更新不得改写已有 thread，也不得覆盖已有会话级权限。由于 app-server 重启后不会从 rollout 恢复审批设置，Agent 只额外保存每个 thread 在受支持的 start、fork、resume、settings 与带权限 turn 请求成功后确认的审批策略、审批 reviewer 与可由 `thread/resume` 表达的 sandbox 模式，并在后续 resume 中把缺失或为 `null` 的字段逐项补回。跨 Agent/TUI 进程以宿主机持久代次和 per-thread coordination fence 串行化 app-server 权限副作用与状态提交，不依赖墙上时钟；无 server revision 的设置广播只用于实时 UI，不作为持久覆盖来源。`externalSandbox`、新版未知字段或缺失字段不会使其他可恢复字段丢失，也不会用旧值覆盖 Codex。会话内容、turn 和运行状态仍完全以 app-server 为唯一事实源。外观偏好仍只保存在当前浏览器，代理秘密仍只保存在宿主机专用配置中。
- 会话页不再用独立信息卡占用 timeline 上方空间；输入框 footer 以紧凑状态栏常驻显示 sandbox 与审批策略、模型与推理强度，以及 app-server 实时上报的当前上下文窗口和占用比例。权限与模型标签可直接进入对应设置区域；上下文使用环形进度并在 70% 与 90% 分级提示，完整用量保留在可访问文本与悬停说明中。运行中修改设置时显示“下一轮”，设置弹窗必须适配窄屏和低高度视口并可完整滚动。
- Agent 级持久 Queue，不依赖浏览器连接推进；turn 正常完成后自动启动下一项，失败或中断时暂停。Queue dispatch 与 Steer 在 app-server 副作用前共用永久一次性消费 claim；claim 前失败可恢复原状态，claim 后任何错误都进入结果待核对并禁止自动重试。
- 写请求幂等、Agent/app-server 分离生命周期、官方 remote TUI 接力。
- CentOS 7 友好的纯 WASM SQLite、PID/文件锁、tmux + crontab watchdog 和 `ce doctor`。

以下能力仍属于后续版本，不应被误认为已经完成：完整 Queue 编辑与排序管理、文件浏览与传输、Schedule、Web Push、加密离线对话缓存、二维码引导和完整生产部署自动化。一次性宿主机 provisioner、用户自助初始化、最小宿主机管理员控制面，以及通过斜杠指令执行 thread 重命名/归档/删除已经实现；当前 PWA 的 Service Worker 只缓存完整应用外壳，离线时不能操作 Codex。

### 本地构建与验证

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm test:app-server
```

### 宿主机初始化

管理员或部署脚本只需在目标 Linux 账号下构建 CodexEverywhere；不要求用户预先安装或登录 Codex：

```bash
node apps/agent/dist/cli.js agent init
node apps/agent/dist/cli.js workspace add /public/home/user/project
node apps/agent/dist/cli.js auth configure https://codex.example.com
```

Direct 模式需要在可信 TLS 入口后转发到 Agent Gateway：

```bash
node apps/agent/dist/cli.js transport direct \
  wss://host.example.com/gateway \
  --listen-host 127.0.0.1 --listen-port 7345
```

Direct 与 Relay 配置不会互相覆盖。依次执行两条 `ce transport` 命令后，Agent 会同时监听 Direct 并维持 Relay 连接；PWA 先尝试 Direct，不可达时再使用 Relay。

Agent 自身只监听本地 HTTP/WS，不直接管理 TLS。将 [`deploy/nginx/direct-host.conf`](../deploy/nginx/direct-host.conf) 中的 `__DIRECT_HOST__`、`__AGENT_PORT__` 和 `__PWA_ROOT__` 替换为实际值，通过 Nginx 暴露 HTTPS 发现文档和 WSS Gateway。禁止将 app-server socket 或端口放入反向代理。

Relay 模式先由 Relay 运维者在 VPS 签发自包含 capability：

```bash
node apps/relay/dist/cli.js init
node apps/relay/dist/cli.js issue-route \
  --login-name user --expires-days 365
node apps/relay/dist/cli.js serve \
  --installation-id <installation-id> \
  --host 127.0.0.1 --port 7346 \
  --trust-loopback-proxy
```

用户只把签发结果中的 capability 配置到自己的 Codex 宿主机；Relay 不创建用户记录：

```bash
node apps/agent/dist/cli.js transport relay \
  wss://relay.example.com \
  --capability '<issued capability>'
```

最后启动并配对：

```bash
node apps/agent/dist/cli.js doctor
node apps/agent/dist/cli.js agent start
node apps/agent/dist/cli.js device pair
```

将 `apps/web/dist` 部署在前面配置的 HTTPS origin，把 `device pair` 输出的 JSON 粘贴到 PWA 的“首次初始化”区域。首次连接会创建 Passkey，并在专用对话框中显示一个只出现一次的恢复码；用户可以一键复制，剪贴板权限不可用时也可以手动选择复制。该流程只用于建立用户的第一个 Web 身份，不是日常新设备准入或旧版兼容机制。稳定运行时可执行 `ce agent install-service` 安装不覆盖既有条目的用户 crontab watchdog。

### 多用户公共安装

正式向多个 HPC 用户开放时，不得共享任何个人用户的 Agent、app-server、Relay capability、`~/.codex` 或 `~/.codex-everywhere`。推荐创建无 sudo 权限、无业务数据的专用 Unix 账号 `codexeverywhere`；它只持有共享只读发行版、Node.js/tmux runtime、宿主机 provisioner credential 与最小用户登记状态。普通用户只读取共享程序，所有用户 Agent 与 app-server 始终以用户自己的 Unix UID 运行。

CentOS 7 的系统 Node.js 不满足要求时，用兼容 conda 在专用账号下创建 Node.js 20 + tmux runtime。发布端通过专用脚本构建仅含生产文件的自包含 bundle；安装脚本在移动前拒绝组/全局可写文件、路径逃逸符号链接和开发机坏链接，再同文件系统原子切换 `current`：

```bash
deploy/hpc/prepare-agent-bundle.sh /tmp/codex-everywhere-agent

# 以下命令以 codexeverywhere 执行
deploy/hpc/create-rootless-runtime.sh /path/to/conda
deploy/hpc/install-rootless-agent.sh /path/to/agent-bundle <release-id>
```

默认安装位置为 `/public/home/codexeverywhere/software/codex-everywhere`。安装脚本将专用账号 home 设为 `0711`：其他用户只能穿越到已知共享程序路径，不能列出 home；`.ssh`、provisioner credential 等私有目录仍为 `0700`，私有文件为 `0600`。root 最后只执行一次 `install-rootless-global-shim.sh`，创建 root 所有的 `/usr/local/bin/ce` 固定 launcher；launcher 会拒绝 UID 0，避免 root 意外执行专用账号可更新的代码。以后安装、升级、回滚和 provisioner 保活都由专用账号完成，不再需要 root。程序按实际调用者 UID 使用各自的 home、`/tmp/codex-everywhere-$UID`、crontab 和 tmux。

Relay 运维者只为整台 Codex 宿主机签发一次有期限的 provisioner credential，而不是逐个签发用户 capability。credential 含有只对一个 `installationId` 和有效期生效的派生签名密钥，不包含 Relay 主密钥；它必须通过受保护通道和不回显的标准输入直接交给专用账号，不能出现在 shell 参数、历史、发布包、普通用户文件或日志中：

```bash
# Relay 宿主机：输出通过安全管道直接进入下一条命令
ce-relay issue-provisioner --installation-id <installation-id> --expires-days 3650

# HPC 专用部署账号
ce provisioner install \
  --origin https://codex.example.com \
  --relay-endpoint wss://codex.example.com/relay \
  --default-codex-proxy http://proxy.example.com:8080 \
  --credential-stdin
ce provisioner install-service
```

credential 到期是 Relay 运维者对这台宿主机授权的安全边界，不是浏览器页面、Noise 会话或 tunnel 的空闲 TTL。`ce provisioner status` 会提前显示到期时间；运维者必须在到期前至少 30 天以相同 `installationId` 签发新 credential，并再次通过 `ce provisioner install ... --credential-stdin` 安装。普通用户永远不能读取 credential，也不能自行延长宿主机授权。

rootless provisioner 首次为用户签发 capability 时，把密码学随机 route ID 与请求文件的内核 owner UID、NSS username/UID/home tuple 和 installation ID 写入专用账号私有的原子 route registry。续签请求仍通过临时 Noise 通道，并再次按请求文件 owner UID 查询 NSS；服务只读取 registry 中已经绑定的 route，不接受用户 payload 指定或替换 route ID。因此重新签发 capability 不改变浏览器 SavedHost。UID、username 或 home 任一发生变化都会拒绝继承；完全相同的 UID/username/home tuple 按 Unix 文件权限模型视为同一安全主体，所以账号生命周期管理不得把保留 home 的原 UID 原用户名直接转授给另一自然人。升级前已经存在但尚未登记的 route 只能在旧 capability 和对应旧 credential 都仍有效时迁入：provisioner 对 installation、principal、login、route、签名与有效期做完整验证；安装新 credential 时只把仍有效的旧 credential 作为迁移验签材料保留到其原始到期时间，后台随后删除，不能用于签发或延长旧授权。越过此窗口后必须由 Relay 运维者在核验用户身份和旧 route ID 后显式恢复，不能降级为“相信用户声明 routeId”。

Agent 在 capability 有效期剩余 30 天时开始 same-route 自助续签；若运维者尚未轮换宿主机 credential，会无限次持续重试并由 `ce doctor` 预警，剩余超过 7 天时重试间隔至多 12 小时、剩余 1–7 天时至多 1 小时、最后 1 天及过期后至多 5 分钟。每档间隔按随机 route 确定性抖动，批量发布或重启不会让所有 UID 同相位冲击 provisioner；任何正剩余寿命还会额外预留 45 秒完成 provisioner 请求、原子写入与 control 注册，进入最后 45 秒时立即尽力，不会让分档延迟跨过截止时间。Administrator Controller 复用同一窗口与退避算法，但使用独立的 `renew-admin-relay` 加密操作和私有 admin-route registry；签发前同时核对请求文件内核 owner UID、当前 NSS tuple、root-owned `O_NOFOLLOW` 单链接 0644 version 2 注册记录中的 runAs 身份、admin handle、installation 与 route，因此拿到别处 capability 的 Unix 用户不能把管理员 route 永久绑定给自己，Controller 也无需持有 provisioner credential。新 capability 都先原子写入所属配置，随后只替换 Relay control 注册并原地延长 route 授权；活动 tunnel、浏览器 SavedHost、Controller 进程内恢复票据不受影响。普通 Agent 在注册帧成功发送后就把已持久化的新 capability 作为后续重连目标；若 Relay 已提交新授权但确认帧丢失，不会退回已被高水位拒绝的旧 capability。Host 配置的 transport、Passkey origin 与 Codex 网络字段都通过同一个跨进程协调锁，在锁内重新读取最新文件后合并写入；用户保存代理与后台 capability 续签并发时不会互相覆盖。control 切换失败时仍按内存中旧 capability 的剩余寿命重试，不会因为新 capability 已落盘而错误延后；Controller 启动还会在取得单实例锁后重读配置，避免并发续签写入后继续使用过期快照。相同 owner 的 capability 代次只能单调前进，延迟到达的旧 control 不能缩短新截止时间或关闭已有 tunnel。rootless descriptor 显式声明普通与管理员续签 feature，新客户端连接旧 provisioner 时失败关闭，不会让旧服务按初始化语义随机生成另一个 route。首次升级必须先重启 provisioner，再滚动重启 Agent；旧管理员安装还需由 root 原参数重跑一次 `ce admin install-controller` 发布 version 2 注册，并在旧 credential 到期前完成 route registry 迁移。若宿主机 credential 本身到期且运维者没有重新授权，续签必须失败；Relay 会在 route 的绝对授权截止时间关闭 control、未完成建连与全部 active tunnel，页面继续重试并在重新授权后恢复。这是明确的部署授权边界，不是页面闲置超时。

`--default-codex-proxy` 是可选的非秘密部署默认值。若集群在 Codex 宿主机上统一提供本地代理，provisioner 会在 self-provision grant 中携带该默认网络配置，普通用户进程只在自己的配置尚无网络选择时写入；它不会覆盖已有的 `direct` 或 `proxy` 选择。专用账号以后可用 `ce provisioner set-default-proxy <url>` 更新后续初始化的默认值而不接触 credential。命令行参数不得承载代理用户名或密码；带凭据的代理仍由用户通过 E2EE Web 设置写入。

安装完成后，每位用户只需在自己的 SSH shell 执行 `ce device pair`。若尚未初始化，普通用户进程在 mode `1733` 的 sticky、不可列目录中以 `O_EXCL | O_NOFOLLOW` 创建单链接请求文件；provisioner 从已打开文件的 `fstat.uid` 获取内核认证的调用者 UID，而不信任 JSON 中的用户名。服务再通过 `getent passwd <uid>` 验证账号不是 root、具有登录 shell、home 是绝对路径且由该 UID 所有。请求和响应使用每请求临时 Noise 握手加密，并将 request ID、时间戳和 provisioner 静态公钥绑定进认证上下文；其他用户即使猜中响应文件名也不能解密或替换 grant。

provisioner 只签发绑定该 Unix 用户的初始化资料，不写用户目录、不启动用户 Agent，也不接触 Codex。随后普通用户进程写入自己的 `~/.codex-everywhere`、安装自己的 crontab watchdog、启动自己的 Agent 并输出配对 JSON。用户不能用该入口为别人初始化。root-owned sudo helper 仅作为旧部署迁移回退；新部署不安装它。

若 rootless provisioner 未运行，`ce device pair` 会明确提示完成宿主机配置；旧安装存在固定 sudo helper 时可兼容回退，但认证或权限异常绝不降级到 sudo 路径。`ce admin bootstrap-user` 仍保留为迁移或应急工具，不是正常准入流程。管理员可在 `/admin` 本地控制面停用、移除或恢复用户；这些操作不改变 Linux/SSH 账号，也不能读取用户业务数据。由于普通专用账号不能越过 Unix 权限，跨 UID 强制停止、写系统停用标记或删除仍属于可选的特权管理扩展，不是日常发布和自助初始化的前提。

首次初始化不是首页上的展开面板，而是一条独立的顺序流程。PWA 提供一键复制 `ce device pair` 初始化指令；用户在单独页面粘贴指令输出、注册 Passkey 并保存恢复码。建立 Web 身份后，PWA 自动进入宿主机初始化向导。未配置网络必须与用户明确选择的 `direct` 区分，不能用隐式直连跳过选择；部署可以显式配置非秘密的宿主机代理默认值，此时该选择来自 provisioner 并可由用户随后修改。检测到已有 Codex 时也必须展示实际版本，再由用户确认继续：

1. 用户选择 Codex 直接访问互联网，或填写 Codex 宿主机能够访问的 HTTP/HTTPS/SOCKS 代理。浏览器电脑上的 `127.0.0.1` 代理通常不能被 HPC 使用。代理输入框使用可见文本，方便用户核对完整 URL；代理通过 E2EE 通道提交，只保存在该用户的 `~/.codex-everywhere/config.json`，PWA 保存后立即清空输入，Relay 永远无法看到。状态接口只披露 `direct` 或 `proxy`，不回传代理 URL、用户名或密码。
2. Agent 先检查 `~/.local/bin/codex`，再检查自身 `PATH`，并接受任何能够正常执行 `codex --version` 且返回语义版本号的安装。用户可显式让 Agent 使用现有 Node.js/npm 将官方 `@openai/codex@latest` 安装或更新到 `~/.local`，不使用 root，也不修改其他位置、共享安装或系统级 Node/npm。安装下载复用上一步的用户代理；若 app-server 已运行，新版本只在用户明确重启后应用。
3. Agent 按需启动用户自己的 app-server。PWA 调用 app-server 的 `account/login/start` 设备码登录，向用户显示官方验证地址和一次性代码；成功后认证材料由 Codex 自己写入 `~/.codex`，app-server 的登录完成通知会驱动页面自动继续。作为官方支持的无头登录替代路径，用户也可使用自己电脑标准位置的 `~/.codex/auth.json`，或选择从其他位置获得的 `auth.json`，经 E2EE 直接导入当前 Linux 账号；普通网页不能静默读取本机固定路径，因此系统文件窗口的一次确认不可省略，也不得持久化文件访问句柄。导入前必须明确确认替换，Agent 校验 JSON、大小、目录所有权和符号链接边界，以 `0700` 目录和 `0600` 文件权限原子落盘，并重启 app-server。
4. 登录完成后进入 workspace。后续同一 Linux 用户始终复用自己的 Codex、`~/.codex` 和 app-server，不会共享其他用户的账号或额度。

代理配置只影响 Codex 的安装、登录和模型请求，不改变 PWA 到宿主机的 Direct/Relay 传输选择。`direct` 模式会主动清除 Agent 继承到的代理变量；`proxy` 模式会设置大小写两套 `HTTP_PROXY`、`HTTPS_PROXY`、可选 `ALL_PROXY`/`NO_PROXY`，并始终让 `localhost`、`127.0.0.1` 和 `::1` 绕过代理。修改代理时若 app-server 已在运行，界面会提示重启 app-server 后生效，避免静默中断活动 turn。

首次连接后，应在安全设置中设置 CodexEverywhere 专用密码，并添加一个新版 Passkey。此后用户可从任意新设备打开统一 PWA 入口，输入登录名并选择 Passkey 或专用密码登录；不再需要为每台设备执行 HPC 配对。临时设备取消“记住此设备”即可，密码不会写入 PWA 存储。

丢失原设备时，新浏览器可在同一登录页输入登录名和一次性恢复码，不需要旧设备密钥。恢复码先只做校验，直到系统 Passkey 注册成功才在同一宿主机事务中消费；用户取消 Passkey 弹窗不会浪费恢复码。恢复成功会签发新恢复码，并同时撤销旧 Passkey、CodexEverywhere 专用密码、可信设备、Push subscription 和当前活动 Web 会话；新设备仅在认证成功后按用户选择登记。

在 HPC 内网或已知宿主机公网入口时，可在登录页填写 Direct 宿主机 HTTPS 地址，例如 `https://hpc.example.com`。PWA 读取 `/.well-known/codex-everywhere` 后直接建立 E2EE WSS 通道，不查询或连接 Relay。已保存的 host profile 同时具有两个端点时会自动 Direct 优先、Relay 回退，并在顶栏显示当前连接路径。

为已有 route 增加登录名时，Relay 运维者使用原 route ID 重新签发 capability，Agent 更新配置后重新上线；route ID 不变，现有设备不会失效：

```bash
node apps/relay/dist/cli.js issue-route \
  --route-id '<existing route ID>' \
  --login-name user --expires-days 365
```

## 1. 为什么要做

Codex 已经通过 app-server 提供 thread、turn、流式事件、审批、工具调用和远程 TUI 等底层能力。CodexEverywhere 不重新实现 Codex，而是在其上提供适合 HPC 的完整 Web 体验：

- 从手机或桌面浏览器查看和控制运行在 HPC 上的 Codex。
- 同时管理多个工作目录和多个长期会话。
- 在 Web 与官方 Codex TUI 之间无中断接力。
- 接收完成、失败、审批和用户输入通知。
- 持久化下一轮消息队列和定时任务。
- 让可信团队中的每位成员使用自己的 Linux 和 ChatGPT/Codex 身份。
- 会话、代码、身份、配置、队列和自动化都留在真正运行 Codex 的宿主机。
- 公网服务器只提供无状态密文中继，以及可替换、无用户状态的静态 PWA 分发；宿主机也可以自行分发同一 PWA。浏览器能够从内网或公网安全到达 Codex 宿主机时，业务连接必须直接进入该宿主机，完全绕过 VPS Relay。

产品判断以“用户能否随时随地、用尽可能少的步骤进入 HPC 上的 Codex”为第一优先级。安全机制应尽量对用户不可见；管理员只负责一次宿主机安装，以及必要的停用、移除和访问恢复，不逐个批准已有 SSH 用户，也不把项目扩展成通用组织治理平台。

HAPI 和 OpenAI Remote 可作为交互与工程参考，但不是本项目的依赖。CodexEverywhere 的定位不是另一个 Agent，也不是通用远程终端，而是面向 Linux/HPC 的自托管 Codex 控制层。

## 2. 目标与非目标

### 目标

- 响应式 Web/PWA，可安装到手机桌面。
- 首次初始化后可在任意地点从新设备使用 Passkey 或 CodexEverywhere 专用密码登录，不依赖 HPC CLI 或已有设备批准。
- 一个入口管理多个 workspace 和并行 thread。
- 实时展示 Agent 消息、计划、Goal、命令、工具调用、文件修改和状态。
- 支持创建、恢复、归档、命名和搜索 thread。
- 支持审批、用户输入、Steer、Queue、Interrupt 和断线恢复。
- 支持工作区浏览、文本与图片预览、上传、下载和 diff。
- 支持一次性、固定间隔和 cron 自动化。
- 支持可信小团队中的多个独立 Linux 用户，但不建立中心化租户数据库。
- 提供不接触 Codex 和用户业务数据的宿主机本地管理员能力，只用于一次公共安装，以及停用、移除 CodexEverywhere 和执行 Web 凭据恢复；现有 SSH 用户默认自行初始化。
- 浏览器与 HPC Agent 之间使用端到端加密。

### 非目标

- 不实现模型、thread 或 turn 状态机。
- 不替代 Codex CLI、app-server、skills、plugins 或 MCP。
- 不提供通用 Web Terminal、SSH 控制台或在线 IDE。
- 不重新实现 Slurm、tmux 或集群资源调度。
- 不让多个成员共享同一个 Linux 执行账号或 OpenAI 凭据。
- 第一阶段不提供跨用户会话分享、协作控制、公共 SaaS、计费、资源配额或复杂 RBAC。
- 第一阶段不开发原生移动或桌面客户端。

## 3. 身份与隔离

每位用户拥有三套独立身份：

1. **CodexEverywhere 身份**：使用由 Codex 宿主机验证的 Passkey 或独立专用密码登录 Web/PWA。
2. **Linux 身份**：在 HPC 使用自己的 Unix 账号、文件权限和用户目录。
3. **ChatGPT/Codex 身份**：通过 PWA 设备码向导、在自己的 Linux 账号下执行 `codex login`，或由用户本人将已登录设备的 `~/.codex/auth.json` 导入自己的 HPC 账号；凭据始终保存在自己的 `~/.codex`。

```text
用户 Passkey / CodexEverywhere 专用密码
    ↓
用户自己的 CodexEverywhere Agent
    ↓
用户自己的 Linux 账号
    ↓
用户自己的 ~/.codex
    ↓
用户自己的 ChatGPT/Codex 账号与额度
```

Passkey 和 CodexEverywhere 专用密码只负责宿主机范围内的 Web 登录，不能替代、代理或共享 ChatGPT/Codex 登录。PWA 默认调用用户自己 app-server 的官方设备码接口，不接触 ChatGPT 密码；用户显式选择本机 `auth.json` 时，文件包含 OpenAI token，系统必须将其视同密码，只允许经已认证的 E2EE 会话直接写入同一用户的 `~/.codex`，禁止日志、Relay 解密、浏览器持久化、内容回显和通用附件复用。专用密码要求至少 9 个字符并同时包含字母和数字，不强制特殊字符；它与 SSH/Linux 密码完全独立，系统禁止收集、转发或验证 SSH 密码。VPS 不保存 Passkey、密码验证记录、恢复码、代理配置、OpenAI 凭据或用户账号。一个用户退出 Codex、重新登录或耗尽额度，不得影响其他用户。

CodexEverywhere 用户必须一对一映射到 HPC 已有的 SSH/Linux 用户。管理员完成一次宿主机安装后，rootless provisioner 以请求文件的内核所有者 UID 为身份依据，并通过系统 NSS（例如 `getent passwd <uid>`，兼容本地 `/etc/passwd`、LDAP 或其他 NSS 后端）确认账号存在、不是 root、具有绝对 home 路径和可登录 shell，并验证 home 由该 UID 所有。CodexEverywhere 不创建或修改 Unix 账号、不读取 `shadow`、不检查或保存 SSH 密码，也不能绕过 `sshd` 的 AllowUsers、AllowGroups、密钥和集群侧访问策略。能够 SSH 登录并通过上述本机校验，就是默认自助初始化资格，不再要求第二次人工开通。

CodexEverywhere 设置最小的宿主机本地管理员入口，但不设置能够查看所有数据的超级用户。管理员只管理公共安装、宿主机 provisioner，以及用户的停用、移除和 Web 凭据恢复；角色只有管理员和普通用户，不实现通用 RBAC。管理员不能创建 Linux 用户。管理员没有 ChatGPT/Codex 身份，不启动 app-server，不显示 workspace/thread，也不能读取提示词、文件、`~/.codex` 或代替用户操作 Codex。Linux 文件权限始终是底层授权边界。

管理员控制面和审计状态保存在 Codex 宿主机，不放在 Relay。Administrator Controller 以指定的现有运维 Unix 账号长期运行，仅持有独立管理员 Web 身份和 route。专用部署账号能够执行发布、回滚、签发首次初始化 grant 和维护自身登记状态，但 Unix 权限不允许它强制操作其他用户目录或进程；需要停用 Agent、写系统访问策略或到期删除时，仍由可选的固定无参数特权 helper 执行。helper 不提供 shell、任意路径或任意命令，Controller 不连接用户 app-server。

首次初始化流程：

1. 管理员创建无特权 `codexeverywhere` 专用账号；该账号安装公共运行时、`ce` 和 rootless provisioner。root 仅一次性安装拒绝 UID 0 的固定全局 launcher；此时不创建任何个人 Agent。
2. 已有 SSH 用户运行 `ce device pair`；provisioner 依据请求文件的真实所有者 UID 和 NSS 自助签发该用户的 Relay route，随后用户进程初始化并启动自己的 Agent。此时 Codex 可以尚未安装。
3. 用户在 PWA 完成一次性 Web 身份引导，核对宿主机指纹、注册第一个 Passkey，并保存只显示一次的恢复码。
4. 用户在 PWA 选择 Codex 直连或自己的代理；代理配置只写入其宿主机目录。
5. PWA 检测并按需安装 Codex，然后通过官方设备码完成该用户自己的 ChatGPT/Codex 登录。
6. 用户可在安全设置中添加独立的 CodexEverywhere 专用密码、轮换恢复码或注册更多 Passkey。

初始化后的日常登录流程：

1. 在任意设备打开统一 PWA 入口，输入自己的 HPC SSH/Unix 用户名，例如 `alice`。
2. 选择“使用 Passkey”或“使用 CodexEverywhere 密码”。SSH 密码永远不是选项。
3. Passkey 模式由宿主机验证 WebAuthn assertion；密码模式只建立当前会话，PWA 不保存密码。
4. 新设备不需要 HPC CLI、个人访问链接、旧设备批准或预先加入白名单。
5. 用户可选择记住个人设备，或启用不持久化设备私钥、Host Profile、会话和离线缓存的临时模式。

## 4. 总体架构

```text
手机/桌面 PWA
    │
    ├── Direct：WSS 直连具有安全公网入口的 Codex 宿主机
    │
    └── Relay：经可选 VPS 转发 Noise 端到端密文
                    ▲
                    └── Agent 主动建立出站连接

Codex 宿主机：每个 Linux 用户独立运行
├── CodexEverywhere Agent
├── Passkey / device trust / workspace / queue / schedule / push
└── codex app-server（私有 Unix socket）
      ├── CodexEverywhere Agent 连接
      ├── ce tui 临时权限协调代理连接
      └── 绕过 ce tui 的 codex --remote 连接（不参与权限 coordination）
```

### 核心原则

- 每个 Linux 用户运行一个长期 app-server。
- 单个 app-server 管理该用户的多个工作目录和多个 thread。
- app-server 是 thread、turn、审批、工具和执行状态的唯一事实源。
- Agent 负责协议适配、E2EE、持久 Queue、自动化、文件访问边界和通知。
- 身份验证、设备授权、恢复码、Push subscription 和业务状态都由宿主机 Agent 保存。
- Direct 与 Relay 使用同一套 E2EE 应用协议；连接方式不得改变上层行为。
- Direct 是首选数据路径，Relay 只是 NAT/防火墙导致宿主机不可达时的连接回退，不得成为身份、存储或运行依赖。
- Relay 不理解 Codex 消息，不保存用户或节点数据库。Agent 在线时注册短期的登录名到 opaque route 映射，Relay 只在内存中用它定位连接，并根据自包含 route capability 转发密文。
- 宿主机具备 HTTPS/WSS 公网入口时，PWA 直接连接 Agent Gateway，Relay 完全退出数据路径；永远不得直接暴露 app-server。
- PWA 当前只离线缓存应用外壳；离线会话内容缓存尚未实现，断网时不允许发送、审批或读取未在页面内存中的业务数据。

### 两种连接模式

**Direct** 适合浏览器可通过内网或公网到达、并具有域名和可信 TLS 证书的 Codex 宿主机。Nginx 将 `/.well-known/codex-everywhere` 和 `/gateway` 转发给仅监听 loopback 的 Agent；Gateway 只接受配置的 PWA Origin，并在 E2EE 握手完成前保持预认证权限。app-server Unix socket 始终保持本地私有。

**Relay** 适合 HPC、NAT 或防火墙后的宿主机。Agent 主动连接 Relay 并注册一个稳定的 opaque route ID；浏览器通过相同 route ID 找到在线 Agent。每个 Relay 进程必须通过 `--installation-id` 固定服务一个宿主机 installation，v3/v4 provisioned capability 的 installation 不精确匹配时在注册和 tunnel accept 两条路径都失败关闭；需要服务多个 installation 时应部署彼此隔离的 Relay 实例和入口，不能在一个进程中做首次到达者决定。Relay 重启后不恢复任何用户数据库，由 Agent 重新注册在线路由。生产示例由 Nginx 限制单 IP 连接与建连速率；Relay 只在 loopback 反向代理模式下信任 `X-Real-IP`，并在进程内限制单地址 socket、登录名查询与 tunnel 建连速率、每 route 并发和 tunnel 待发送字节。地址 rate bucket 有硬上限，满表时只检查最老项并失败关闭；转发数据同时预留跨 tunnel 共享的进程级 pending-byte 预算，发送完成或 tunnel 关闭时幂等释放。达到任一预算时连接会失败关闭，而不是无界积压内存。

单用户或兼容路径仍可用 `ce-relay issue-route` 逐个签发由 Relay 主密钥签名的 v1/v2 legacy route capability。多用户公共安装改用 `ce-relay issue-provisioner`：Relay 从主签名密钥派生只对一个 `installationId` 和有效期生效的宿主机签名密钥，HPC 专用部署账号只保存该派生 credential，不能还原 Relay 主密钥或为其他 installation 签名。rootless provisioner 为内核认证的请求文件所有者生成 v4 user route capability，并把随机 route 与 UID/NSS tuple 私有绑定以支持同路由续签；管理员安装流程生成 v4 host-admin route capability。v3/v4 的登录发现 namespace 和在线 route owner 同时绑定 installation、principal 与规范登录名；同一个 route 的后续注册和 tunnel accept 必须匹配首次已验签的 owner tuple。user 与 host-admin 即使登录名相同也不能互相发现或替换。Relay 重启后映射由 Agent 或 Controller 重建，不落盘；已有随机 route ID 的 v3/v4 capability 保持可用且升级不会改写 route，主密钥签名的 v1/v2 兼容 route 仍可使用。provisioner credential 的轮换仍由 Relay 运维者完成，普通用户的自动续签只消费当前有效 credential，不会绕过该安全边界。

后续若要让一个 Relay 安全承载多个 installation，必须把不可选择的随机 nonce 与 owner tuple 一起纳入新版 capability，并升级到 v5 后由 Relay 重算 route commitment；不能在 v4 中偷换 route ID 语义。该迁移还需定义旧 SavedHost 的重发现和 capability 轮换流程，当前版本不宣称支持多 installation Relay。

PWA 可以保存多个 host profile，每个 profile 独立记录 direct endpoint、可选 Relay endpoint、route ID、设备密钥和本地缓存。新设备无需预存 profile：可以填写 Direct 地址直接获取公开宿主机资料，也可以通过登录名从 Relay 找到在线 Agent。两种方式都在预认证协议中验证宿主机身份。只要 profile 含 Direct 地址，PWA 就先直连，失败后才回退 Relay。

Passkey 绑定 PWA Origin，而不是 WSS 数据路径。推荐保持一个稳定的 PWA Origin，并让不同网络环境只改变 Direct Gateway 的解析或地址；若在 Direct 宿主机自行分发 PWA，必须将该 HTTPS Origin 配置给 `ce auth configure`。同一域名的 split-horizon DNS 可以让内网解析到 Direct 宿主机、外网解析到公共 PWA/Relay，同时保持 Passkey RP 稳定。

## 5. HPC 运行模型

首个目标环境为 CentOS 7、glibc 2.17、Node.js 20，无用户级 systemd。只有登录节点具备外网访问，集群节点共享 `/public`。

### 目录

```text
~/.codex/                         # Codex 自己的认证、配置和历史
~/.local/bin/codex                # 可选的 CodexEverywhere 用户级安装
~/.codex-everywhere/              # CodexEverywhere 持久状态
├── config.json
├── state.sqlite
├── keys/
└── logs/

/tmp/codex-everywhere-$UID/       # 0700，仅当前用户可访问
├── app-server.sock
├── agent.pid
└── agent.lock
```

### 生命周期

- `ce agent ensure` 使用文件锁检查 Agent 和 app-server。
- Agent 不依赖 Codex/app-server 才能上线；安装、网络和登录初始化完成后，第一次 Codex 业务请求才按需确保 app-server。
- app-server 冷启动以 60 秒为上限；Unix WebSocket 在建立前超时或失败时始终消费 transport error，不得形成未处理事件并终止 Agent。认证会话只对同一次 inner 建连做 singleflight，失败或已建立 transport 随后关闭时会清除缓存，使后续请求在不重新 Passkey 的情况下重连。
- `ce app-server status` 只读报告 healthy / starting / live-unresponsive / stale-artifacts / stopped；`ce app-server recover --expected-pid <pid> --force` 在 supervisor lock 内重新核对持久进程身份后才终止并替换 owner。live-unresponsive 无法权威证明活动 turn 已结束，因此不会被 watchdog 自动杀死，强制恢复仍是用户明确承担中断风险的操作。
- `ce agent install-service` 安装带唯一注释标记的用户 crontab watchdog。
- watchdog 定期确保专用 tmux 会话存在；tmux 中保留实时可查看日志，同时写入轮转日志文件。
- 日志达到轮转阈值时，watchdog 先停止 Agent 并关闭旧日志文件描述符，再轮转并重启 Agent；独立 app-server 不因此被终止，活动 turn 继续运行。
- Agent 重启时连接已有 app-server socket，不杀死健康的 app-server，也不 interrupt 活动 turn。
- Queue 由 Agent 级 dispatcher 订阅和推进，不依赖某个浏览器 WebSocket；浏览器关闭后，正常完成的 turn 仍会启动下一条排队消息。新版 add 从同一事务起就令兼容 `queue_items.status='done'`，仅在 additive `queue_item_states` 中推进 pending / paused / running；旧 Agent 回滚后会忽略该表并隐藏这些消息。dispatch、Gateway fallback 与 Steer 共用按 queue item ID 唯一的消费 claim；副作用前同事务写 claim 并删除逻辑状态。当前 Agent 从 claim 合成 `delivering`，崩溃重启则把未完成 claim 合成为 `indeterminate`。每次状态库打开都会隔离任何物理非 `done` 行，因此回滚期间由旧 Agent 新建、派发或 Steer 后恢复的项也不能在再次升级时重放。
- Web、TUI 和 Queue dispatcher 只在实际观看或推进 thread 时保留各自的 app-server 订阅；Web 切换/离开会话及 Queue 耗尽/暂停时执行 `thread/unsubscribe`。活动 turn 不因取消某个客户端订阅而终止；当全部订阅者离开后，使用 app-server 内置的无订阅宽限期自动卸载，磁盘历史和 thread ID 保持不变，重新打开时按需 `thread/resume`。
- Relay 控制连接使用 ping/pong 检测半开 WebSocket；心跳失联或新隧道建立失败时，Agent 主动清理旧 route 并重新注册，避免 Relay 仍可查询用户但连接持续超时。
- Direct Gateway、Agent 的 Relay control 与 Relay 的数据 bridge 都以 15 秒为心跳周期，只有连续 4 个周期没有 pong 才判定半开；一次抖动或后台调度延迟不会立即断线。浏览器页面对 transport 恢复不设尝试次数上限，退避最高固定为 30 秒；普通 RPC deadline 只把该请求标为“结果未知”，不关闭仍有心跳的 WebSocket。
- Relay route authorization 使用 capability 与 provisioner credential 两者中更早的绝对截止时间；same-route 续签只允许截止时间和签发代次单调前进，并保留已经建立的 tunnel。授权真正到期时 Relay 统一关闭 route control、pending/setup 与 active tunnel，防止“窗口一直开着”绕过运维撤权；这与检测闲置连接的心跳超时是不同边界。
- Relay 数据隧道使用两阶段就绪：Relay 先确认 Agent 已安装 Noise 握手监听器，再向浏览器发送 `relay/ready`，避免浏览器 hello 与隧道 ready 同批到达时被丢弃。
- sql.js 状态存储在每次操作前重新载入最新的原子落盘文件，并使用用户级跨进程事务锁；Agent 运行期间执行 `ce device pair`、workspace 管理或凭据恢复时，长期进程会立即看到 CLI 写入且并发写入不会互相覆盖。
- app-server 升级前默认等待所有 thread idle；强制升级必须明确警告可能中断活动任务。
- socket 放在登录节点本地 `/tmp`，持久数据放在共享用户目录；重启后自动重建 socket。

Codex 访问计算、SMP 或 GPU 节点时，继续遵守用户自己的 `~/.codex/AGENTS.md`。CodexEverywhere 不维护第二份硬件拓扑或任务调度规则。

## 6. TUI 接力

提供 `ce tui` 包装命令。默认打开共享 app-server 中当前 workspace 的会话恢复选择器；也可以用 Web 中的 thread ID 直接进入同一个对话。只有显式传入 `--new` 才会新建对话：

```bash
ce tui /public/home/user/project
ce tui /public/home/user/project --thread <thread-id>
ce tui /public/home/user/project --new
```

它完成：

1. 确认用户 Agent 和 app-server 已运行。
2. 校验目录位于允许的 workspace root 内。
3. 创建用户私有的临时权限协调代理，再调用官方 TUI；默认恢复已有会话，指定 thread 时直接接力。下面的随机 socket 由 `ce tui` 生成，不是供用户绕过包装器手工连接的稳定入口：

   ```bash
   codex resume <thread-id> \
     --include-non-interactive \
     --remote unix:///tmp/codex-everywhere-$UID/tui-<random>/app-server.sock \
     -C /public/home/user/project
   ```

Web Agent、后台 Queue 和多个经 `ce tui` 代理的 TUI 分别连接同一个 app-server。app-server 原生广播 thread、设置和审批事件，并在客户端 resume 时重放未处理的服务器请求。官方 TUI 在恢复 remote thread 时会携带当前 TUI 进程的审批与 sandbox 启动默认值；所有 `ce tui` 启动因此都经过一个用户私有的临时 Unix WebSocket 透传层，它从 `thread/resume` 和普通 `turn/start` 移除这些隐式权限覆盖字段，再逐项补回 Host 中已有的会话权限，并在 per-thread coordination fence 内按 app-server 对 start、resume、fork、delete 与显式 `/permissions` 的成功响应或原始请求 payload 提交最小权限元数据。代理不保存会话内容、不改写其他方法，并在 TUI 退出后删除。Web Gateway 与 Queue Dispatcher 使用同一 Host 权限注册表、持久代次和恢复规则。这样 Web、Queue 与经 `ce tui` 代理的 TUI 连接动作不会互相覆盖，app-server 重启也不会使权限回落；无因果版本的广播仍实时转发给各客户端，但不会反向覆盖已确认的恢复状态。直接以 `codex --remote` 连接原始 app-server socket 的客户端绕过该代理和 coordination fence，虽然可使用官方协议能力，但不在会话权限一致性保证范围内。

Web 会话头以高对比按钮提供“SSH 接力”入口，并在会话信息下方展示“SSH 可访问同一会话、切换不会中断任务”的说明条；用户可选择“不再提示”，该非敏感界面偏好只保存在当前浏览器，说明条永久隐藏后顶部接力按钮仍始终可用。入口不能只隐藏在会话设置、弱提示或省略菜单中。接力弹窗先以“SSH 登录 HPC → 复制并运行命令 → 在官方 TUI 中继续”的步骤说明建立使用预期，再给出两条路径：包含当前 workspace 与 thread ID 的精确 `ce tui ... --thread ...` 命令可以直接进入当前会话；更短、可长期记住的 `ce tui <workspace>` 会打开官方恢复选择器，用户以后无需先打开 Web，即可从该目录的历史会话中选择要继续的会话。只有显式使用 `--new` 才新建会话。由于进入后的交互界面属于官方 Codex TUI，CodexEverywhere 不 fork 或修改其内部 UI；Web 接力弹窗和 `ce tui --help` / 启动提示必须明确说明退出语义：任务忙碌时输入 `/quit` 或 `/exit` 只关闭当前 TUI 客户端，宿主机上的活动 turn 继续运行；`Esc` 会中断活动 turn，不应作为“仅离开 TUI”的操作。SSH 终端失去响应时，可以在新行输入 `~.` 断开 SSH，活动 turn 仍由长期 app-server 承载。

成功标准是：Web、TUI 或网络连接断开不会导致 thread ID、turn ID、Goal 或正在运行的命令发生变化；用户不需要猜测如何在不中断任务的前提下从 Web 接力到 TUI，或从 TUI 返回 Web。

## 7. Monorepo 与技术栈

使用 pnpm workspace、严格 TypeScript 和共享协议类型：

```text
apps/
├── web/       # 严格 TypeScript + Vite PWA
├── relay/     # 无状态 WebSocket 密文 Relay，可选部署
└── agent/     # HPC Agent、Codex adapter、Queue、Scheduler、文件服务

packages/
├── protocol/  # 版本化跨组件消息
├── crypto/    # Noise、配对、帧加密、重放保护
└── testing/   # app-server 与 relay 测试工具
```

Monorepo 只负责源码协作和跨组件测试，不是生产部署目录。公开 `main` 是唯一可信源码主线；GitHub Release 从属于 `main` 的不可变 tag 构建 Web、Agent 和 Relay 制品，生产运维环境只消费 Release 的 manifest、校验和与制品。真实域名、主机、SSH 参数和 credential 位于独立私有 ops 环境。合并、发布和部署是三个独立审批点，功能分支或本地工作区不能直接成为生产输入。详细流程见[部署与升级](deployment.zh-CN.md)。

### 兼容策略

- Codex CLI 运行版本不设白名单；仓库内生成的 app-server schema 是编译与回归测试基线，不是运行时版本门槛。CodexEverywhere 发版时应持续用 npm 最新稳定版执行真实集成测试并刷新 schema，以支持新字段和方法。
- 启动 app-server 前必须验证实际 CLI 能执行并报告可解析的语义版本；这只证明安装可用，不代表所有新增 app-server 能力已被当前 Web 结构化支持。初始化或方法调用不兼容时必须返回清晰错误，不能静默降级或阻止用户使用其他仍兼容的能力。
- 使用 `codex app-server generate-ts` 生成版本匹配的协议类型，并在 adapter 层隔离版本差异。
- 默认只使用稳定 app-server API；实验性能力必须放在 feature flag 后。
- 未知 notification 或 item 作为 generic event 透传，不能导致 Agent 或 Web 崩溃。
- HPC Agent 避免依赖要求新 glibc 的原生 Node 模块。

## 8. CLI 接口

计划提供以下命令：

```text
ce agent init
ce agent start|stop|status|ensure
ce agent install-service
ce provisioner install --origin <https-origin> --relay-endpoint <wss-endpoint> [--default-codex-proxy <url>] --credential-stdin
ce provisioner install-service|status|stop
ce provisioner set-default-proxy <url>
ce admin inspect-user <username>
ce admin install-provisioner --origin <https-origin> --relay-endpoint <wss-endpoint> [--default-codex-proxy <url>] --credential-stdin
ce admin set-provisioner-default-proxy <url>
ce admin bootstrap-user <username> --origin <https-origin> --relay-endpoint <wss-endpoint> --capability-stdin
ce admin install-controller <run-as-user> --handle <admin-handle>
ce admin web start|stop|restart|status|pair
ce transport direct|relay|status
ce workspace add|remove|list
ce device pair|list|revoke
ce auth configure
ce auth reset-recovery-codes
ce doctor
ce tui [directory]
```

`ce transport direct` 配置宿主机的 HTTPS/WSS 入口；`ce transport relay` 配置 Relay URL 和自包含 route capability。两条命令分别更新自己的连接配置并保留另一条，二者同时存在时状态为 `hybrid`。`ce doctor` 至少检查：Node/Codex 版本、Codex 登录状态、目录权限、socket、tmux、crontab、当前 transport、workspace roots、密钥权限和 app-server 健康状态。

`ce provisioner install` 是专用部署账号只需执行一次的宿主机自助初始化配置；可选的 `--default-codex-proxy` 只为尚无网络选择的用户提供首次初始化默认值，`ce provisioner set-default-proxy` 可在不重新输入 credential 的情况下更新它。`install-service` 通过该账号自己的 crontab + tmux 保活服务。旧的 `ce admin install-provisioner` 和内部 `ce admin self-provision` 只用于 root-owned 部署迁移兼容，不是新部署或普通用户命令。`ce admin bootstrap-user` 仅作为迁移和应急后备。`ce admin install-controller` 以 root 安装需要跨 UID 强制执行的可选管理员 route、Controller 配置、固定 `ce-admin-helper`、最小 sudoers 和 cron 保活；日常使用指定运维账号执行 `ce admin web pair`，再在 `/admin` 完成管理员 Passkey 和可选 OPAQUE 管理密码设置。`ce auth reset-recovery-codes` 只用于用户本人本机应急；Web 管理恢复改用 10 分钟短时交接码，管理员不会看到兑换后生成的新恢复码。Relay 包另外提供 `ce-relay serve`、`ce-relay issue-provisioner`、兼容命令 `ce-relay issue-route` 和 `ce-relay inspect-key`。

## 9. 身份登录与端到端加密

### 首次引导与日常登录

- 首次初始化仍使用一次性、高熵、短时有效的引导资料，以核对宿主机身份、注册第一个 Passkey 并设置 CodexEverywhere 专用密码；这是建立身份的引导步骤，不是每台设备的准入流程。
- HPC Unix 用户名用于定位在线 Agent，不是秘密。Relay 签发 capability 时将区分大小写的规范用户名转换为 keyed opaque login ID 并绑定 route；Agent 上线时只能注册 capability 中的 login ID。Relay 不持久化、不得记录明文用户名或向其他用户枚举映射。单个部署中 Web 登录名必须与 NSS 返回的 Unix 用户名完全一致，不向普通用户暴露集群后缀或 route ID。
- 新浏览器先生成临时设备密钥，与目标 Agent 建立严格限权的预认证通道。预认证通道只允许 Passkey、专用密码和恢复流程，不能访问任何 Codex 或宿主机数据。
- Passkey 模式由 Agent 发出与预认证通道绑定的 WebAuthn challenge，并在宿主机本地验证 assertion。
- WebAuthn 注册/认证 challenge、恢复授权与 OPAQUE server login state 都是当前预认证连接中的一次性中间态，最晚 5 分钟过期；共享的最早到期 timer 会主动擦除敏感值，认证成功、会话撤销或连接关闭也会立即清空。这个限制只约束尚未完成的身份操作，不是已认证页面会话 TTL。
- 密码模式使用经过公开审查的增强型 PAKE 协议，在不向 PWA 静态服务器或 Relay 暴露密码的前提下完成双向认证并绑定 Agent 公钥；禁止自行设计密码加密协议或直接在普通 WebSocket/Noise XX 通道中发送密码。
- Agent 只保存 PAKE registration record，不保存可还原的密码。密码与 SSH/Linux 密码完全独立；密码与恢复尝试使用跨 WebSocket 共享的 Agent 级账户限流，重新连接不能清零，Gateway 和 Relay 另设总连接数、待连接数与单 route 上限。
- Passkey 或密码验证成功后才能创建业务会话；不要求该设备已配对，也不要求旧设备批准。
- 个人设备可在 Passkey 登录后登记为已记住设备，用于设备名称、通知、加密缓存和撤销管理。设备记录是体验与安全管理对象，不是用户身份的替代品。
- Passkey、密码或恢复注册完成后，Agent 为当前页面签发 256-bit 随机恢复票据。票据绑定 principal、node ID、Unix user ID、device ID、Noise remote static key 和 remembered/temporary 域；Agent 进程只保存带 `ce-page-session-v1` 域分隔的 SHA-256 摘要，浏览器只保存在 `GatewayClient` 私有内存。票据可重复 resume，避免握手响应丢失把页面锁死；同一设备最多保留 16 个独立页面票据、Agent 全局最多 1024 个，并在成功 resume 时刷新 LRU。它不是可信设备身份，也不会绕过 Passkey/密码的首次认证。
- 已打开页面在 Direct/Relay transport 被回收后优先用该票据静默恢复；无效、凭据恢复后撤销或 remembered device 被撤销的票据会在 Noise 认证的握手结果中返回结构化 `REAUTH_REQUIRED`，不能依赖可能被代理剥离的 WebSocket close reason。后台页面收到该结果后只等待重新可见，不调用 WebAuthn；可见后至多自动发起一次 Passkey 认证，取消、选择错误或交互后的网络不确定结果都会停止自动弹窗并保留原设备身份进入显式登录界面。凭据恢复撤销所有活动 Web 身份和票据；设备撤销只清理该 Noise device ID 的 remembered 域，之后显式 Passkey 登录建立的 temporary 域仍可用。新 transport 对 remembered 状态执行不缓存的持久查询；已打开会话由 Agent 每 10 秒主动复查并复用 5 秒成功缓存，即使后台页面不发 RPC 也会停止向已撤销设备推送业务事件，同时避免高频 thread RPC 在 HPC 共享 home 上为每次请求重载 SQLite。I/O 暂时失败只使当前检查失败而不永久销毁票据，后续周期继续重试。
- 临时模式下密码和设备私钥只存在于页面内存，不写入 IndexedDB，不启用离线缓存；退出、登出或关闭页面后失效。PWA 自身不得保存密码，但浏览器或密码管理器的保存行为仍由用户控制。
- 应允许用户注册多个 Passkey，优先使用可跨设备同步的 Passkey，并支持浏览器提供的“使用另一台设备上的 Passkey”。
- 恢复码首次注册时由 Agent 生成并通过 E2EE 会话直接一次性展示给用户，管理员不参与日常发放；Agent 只保存哈希，无法重新显示原码。
- 已认证用户可以自行轮换恢复码；任一时刻仅有一个当前恢复码，轮换会使旧码立即失效，并再次只展示一次新码。
- 用户遗失全部登录方式和恢复码时，管理员在完成线下身份核验后签发 10 分钟有效的 `CEAR-…` 交接码。签发前停止 Web Agent 以关闭活动管理通道并使全部旧恢复码失效；用户在普通登录页完成新 Passkey 注册时才消费交接码，随后生成的新恢复码只通过用户 E2EE 会话展示，管理员界面不能读取。
- 使用恢复码注册替代 Passkey 后，旧 Passkey、专用密码、可信设备、Push subscription 和活动 Web 会话全部撤销。恢复流程不影响 Linux、SSH 或 ChatGPT/Codex 凭据。
- Web 凭据替换、添加 Passkey、轮换恢复码和保存 OPAQUE password record 在所有用户 Gateway 会话共享的 Agent 协调器内串行，并以 challenge/start 时捕获的认证代次在最终写入前做 CAS：先完成的旧 mutation 会随后被 recovery 删除，先完成的 recovery 会阻止旧会话 mutation 落盘。支持的管理员交接只签发持久 handoff ticket，真正的凭据替换仍由用户 Agent 完成；直接绕过 CLI/Agent 修改 SQLite 不属于受支持的并发边界。

### 通道

- 已记住设备使用 Noise IK 固定密钥建立通道；新设备使用与宿主机公钥绑定的预认证握手，并在 Passkey 成功前保持最小权限。具体握手模式必须在协议中显式版本化。
- 协议 prologue 包含协议版本、user ID、node ID 和 device ID，防止跨上下文复用。
- 每个加密帧包含 session ID、严格递增序号和认证密文。
- 拒绝密文篡改、重复帧、跨会话重放、未认证业务请求和跨用户路由；未知设备只能进入严格限流的预认证状态。
- Direct 与 Relay 通道使用相同加密帧。Relay envelope 只能暴露完成路由所必需的 opaque route、连接标识和密文长度。
- 禁止在 Relay、Agent 和浏览器日志中记录解密内容、配对秘密或私钥。

### PWA 安全边界

E2EE 保证正常运行的 Relay、日志和网络观察者无法读取业务内容。Direct 模式也保留 E2EE，不仅依赖 TLS。但是 PWA 的代码仍由 Web 服务器分发；如果静态资源服务器被完全攻陷并主动替换前端代码，新加载的浏览器可能受到攻击。第一阶段接受并明确披露这一 Web 交付边界，不额外开发原生客户端。

## 10. 数据存储

### 宿主机管理员控制面

当前管理员入口由 `/admin` PWA、Administrator Controller 和固定 root helper 组成。管理员使用独立 Passkey 或 OPAQUE 管理密码登录；管理员 route、Noise user ID、Passkey user handle、OPAQUE user identifier、SQLite 和浏览器 Host Profile 均与普通用户分域。root-only SQLite 仅登记已经由 NSS 验证或自助初始化的 `uid / username / home / status / revision` 与管理审计，不复制 Unix 账号库，不保存业务数据。

管理员可精确检查/登记现有 Unix 用户、停用或重新启用 Web、发起短时恢复交接、计划或取消 24 小时延迟移除。停用写入可由普通用户只读检查的 `/etc/codex-everywhere-access/$UID.disabled` 并停止 Agent；用户 watchdog 和 Agent 启动入口都会拒绝重启，但独立 app-server、SSH、TUI 和活动 turn 不受影响。到期移除只删除安全校验后的用户自有 `~/.codex-everywhere`，保留 `~/.codex`、工作区与 Linux/SSH 账号。所有变更要求客户端提供当前 revision、按 request ID 幂等，并写入不含提示词或文件内容的审计。

### Codex 宿主机 Agent

为避免 CentOS 7 原生模块问题，Agent 使用纯 WASM SQLite。数据库规模保持很小，每次事务后导出到临时文件、`fsync` 并原子重命名：

- Passkey credential public keys、PAKE password record 与恢复码哈希
- workspace roots
- 可信设备
- direct/relay transport 配置与 route capability
- 普通业务请求的 24 小时持久幂等结果，以及 `thread/start`、`turn/start`、`queue/add` 独立且不自动过期的 durable mutation claim。后者在调用 app-server 或写入 Queue 前落盘，并向旧版 Agent 使用的普通幂等表同步永久 fail-closed tombstone/result。永久安全指纹仅包含方法，以及 turn/queue 所需的 `threadId` 与 `clientUserMessageId`，不包含或直接散列 prompt、文件内容和整包 payload。`thread/start` 可保存经验证且不含 prompt 的成功响应；`turn/start` 与 `queue/add` 的完整成功响应只在 tombstone 已提交后返回当前进程内首次调用及其并发等待者，两个永久表始终只保存 `IDEMPOTENCY_OUTCOME_INDETERMINATE`。claim 发布后的任何 handler 拒绝、不可验证响应或结果提交失败同样永久失败关闭。这使升级或回滚后的旧 Agent 对相同幂等键继续返回安全结果或拒绝自动重放；新版 Web 以 `clientUserMessageId` 权威对账，无法确认时交给用户核对。短期未发布的 `thread_start_claims` 表会迁入通用表并以 SQLite `secure_delete` 物理清除旧整包 payload 哈希。若连 Web 也回滚到不识别结构化错误的旧版，用户仍可能手动以新键再次提交。`auth/*`、`codex/account/login/start` 和 `admin/recovery/start` 的原响应只在当前 transport 的 128 项有界内存中保留 5 分钟，请求 payload 只留内存中的 SHA-256 指纹，关闭连接或定时到期后清除。升级迁移同样以 SQLite `secure_delete` 物理清理可能包含 recovery code、resume token、OPAQUE response、device code 或 handoff code 的历史结果
- Queue 的 additive 逻辑状态，以及 dispatch / Steer 共用的永久 queue item 消费 claim。新 add 同事务写入物理 `done` 的兼容行与不含内容的 pending 状态；pause / reserve 只更新 `queue_item_states`。begin consumption 要求物理行仍为 `done` 且逻辑状态为 running，再同事务写 claim、删除逻辑状态。claim 仅保存 item ID、方法、thread ID、`clientUserMessageId`、结果状态与经验证的 turn ID，不复制或散列 prompt、附件和完整请求；新 Agent 从它合成 `delivering` / `indeterminate`。claim 已发布但 indeterminate 标记因瞬时存储错误失败时，生命周期内的 repair coordinator 只重试标记事务：同 item 合并、单计时器调度、指数退避封顶，绝不重跑 app-server mutation；关闭先取消后续 timer 并等待当前修复，重启时再由 startup repair 接管。若 begin 明确未发布且修复查询确认 claim 不存在，则恢复为 paused；若已经确认跨界但 claim 异常缺失，则只创建不含内容的最小 indeterminate tombstone，不能恢复为可投递。结果未知项阻断同 thread 后续投递，只能显式确认放弃；确认操作把 claim 标为 `abandoned` 后删除原 Queue 行并重新唤醒 dispatcher。schema 仍保持旧 Agent 可打开的版本，但每次打开状态库都要求不存在物理非 `done` 行；发现此类行时删除其逻辑状态，并在未完成/未放弃 claim 之外保守写入 legacy indeterminate claim 后恢复物理 `done`。因此首次升级和后续 new → old → new 回滚都失败关闭；新版 pending 项因物理行一直是 `done` 而不会被误隔离。
- Schedule 与运行记录
- Push subscription 与通知规则
- 本地安全审计事件
- 最小 thread 索引缓存

完整对话历史继续由 Codex 管理，不在 Agent 中复制一份新的权威历史。

### Relay

Relay 不使用用户数据库。磁盘上只允许存在服务自身的部署配置、TLS 材料、Relay 签名密钥和不包含业务标识的运行日志。它在内存中维护在线 route 到 WebSocket 的短期映射，并通过自包含、可验证的 route capability、固定 installation 边界和 owner tuple 检查防止跨 installation 或跨 principal/login 的在线路由抢占。未认证 lookup/connect 仍会暴露必要的连接元数据，因此入口同时使用反向代理、硬上限地址 bucket 和进程内资源限额；业务密文转发同时受单 tunnel 与全进程 pending-byte 背压预算约束。进程重启后映射清空，由在线 Agent 自动重新注册。

Relay 不保存用户、Passkey、密码验证记录、恢复码、设备、节点、Push subscription、workspace、thread、Queue 或 Schedule。它只在内存中维护在线登录名和 opaque route 的短期映射。Relay 不可用只影响远程连接，不影响 Agent、本地 TUI、自动化或正在运行的 Codex turn。

### 浏览器

PWA 在用户选择“记住此设备”时使用 IndexedDB 保存 host profile 和设备静态密钥，不使用 `localStorage`。设备密钥只发送其公钥，私钥不离开浏览器。页面恢复票据无论 remembered 或 temporary 都不进入 IndexedDB、Service Worker、`localStorage` 或 URL；同一页面内可跨 WebSocket 重连复用，刷新、关闭页面或 Agent 重启后丢失并回到正常认证。临时模式也不写入 host profile、设备私钥或对话缓存。对话的设备级加密离线缓存尚未实现；当前 Vite 构建生成完整 asset manifest，Service Worker 在安装时预缓存 HTML、全部 hash JS/CSS（包括尚未调用的动态 import）、字体、manifest 与图标等应用外壳，运行时只缓存同源静态资源。激活新 worker 时会通过 `MessageChannel` 查询所有活动窗口正在运行的缓存版本；只有全部窗口响应后才删除无人使用的旧版本，任一旧页面无法响应时保守保留全部版本。脚本或样式请求若因原发布目录切换得到 404，或被 SPA fallback 错误返回 HTML，会在所有保留的版本缓存中查找，因此其他标签页不必为更新立即丢弃草稿、一次性凭据或页面内待核对状态。

## 11. 内部协议

Direct 模式直接承载加密帧；Relay 模式在加密帧外增加最小路由 envelope。两种模式内部都使用相同的版本化 request/response/event 消息：

```ts
type RequestEnvelope = {
  version: 1;
  requestId: string;
  idempotencyKey: string;
  method: string;
  payload: unknown;
};

type ResponseEnvelope = {
  version: 1;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; retryable?: boolean };
};

type EventEnvelope = {
  version: 1;
  eventId: string;
  cursor: string;
  type: string;
  payload: unknown;
};
```

当前跨组件 wire 协议只接受精确的 v1，并未实现 n/n-1 协商。浏览器会在 Noise 握手回复、加密帧以及解密后的 response/event envelope 上同时校验消息类型、版本和必要字段；resume 拒绝作为 Noise 加密 payload 中的结构化 `REAUTH_REQUIRED` 传递，WebSocket close code/reason 只作辅助。Relay 与 Agent 也使用同一组 Relay v1 消息类型和版本解析边界。版本不受支持、字段畸形或 response/event 身份歧义时连接立即 fail closed，未决写请求继续按“结果未知”处理，不得隐式重发。这里的 wire fail-closed 与 Codex app-server 事件的向前兼容是两层边界：通过合法 `EventEnvelope` 到达的未知 Codex 事件仍作为 generic event 保留和展示。

能力分组：

- node、workspace、runtime health
- thread、turn、Goal 和 model
- stream event 与 event cursor
- approval 与 requestUserInput
- queue
- files 与 diff
- schedule 与 run history
- notification

所有会改变状态的请求都必须具有幂等键。浏览器断线重试不得重复创建 turn、重复审批、重复上传或重复创建定时任务。`thread/start`、`turn/start` 与 `queue/add` 的 durable claim 一旦发布，handler 抛错、app-server 断连、后续本地落盘失败、durable result 提交失败，以及不可验证的响应都返回非重试的 `IDEMPOTENCY_OUTCOME_INDETERMINATE`。成功形状按方法验证：thread/turn 必须具有非空 ID；queue 必须具有非空 queue ID、`pending` 状态，并且 `threadId` 和 `turnPayload.clientUserMessageId` 与安全请求身份一致。thread 的安全创建结果可以永久 replay；turn/queue 为避免复制消息内容，只在永久 indeterminate tombstone 成功提交后对当前内存调用返回原响应，任何后继同 key 或旧 Agent 回滚路径都只得到不可判定并靠 operation ID 对账。即使最终值无法再次落盘，执行前已发布的 NULL claim 与永久旧版镜像仍会阻止同 key 重放。Web 只能使用唯一 ID 查看权威状态或要求用户显式放弃本地 pending，不能按 cwd、时间或消息文本猜测对应结果。

## 12. Workspace 与文件安全

- 用户必须显式登记 workspace roots。
- 用户可在 PWA 中添加和移除宿主机上已存在的绝对目录，并选择保存在宿主机状态库中的默认 root；新任务可临时选择该 root 下的子目录，临时子目录不改写默认 root。
- 目录浏览只以当前 Linux 用户主目录和已注册 workspace 为锚点；Web 只能列出和选择这些锚点的真实子目录，越界符号链接不显示。浏览不改变 workspace 白名单，只有显式“添加”后才注册新 root。
- 每次文件操作都重新执行 `realpath` 和包含关系检查。
- 拒绝 `..`、NUL、越界绝对路径和符号链接逃逸。
- 文件列表设置数量、深度和响应大小限制。
- 文本与图片预览设置 MIME 和大小限制。
- 上传先写入同目录临时文件，完成校验后原子重命名。
- 覆盖已有文件必须显式确认。
- 下载必须重新授权并流式传输，不能把本地路径暴露成公网 URL。
- 不提供通用在线编辑和任意 shell。

## 13. Thread 与消息行为

### 创建和恢复

- thread 按 workspace 分组，并显示 idle、active、waiting、failed、archived 等状态。
- 新 thread 可选择 model、reasoning effort、sandbox 和 approval policy；默认继承用户 Codex 配置。
- app-server 负责持久历史、resume、fork、archive 和最终 item 状态。
- 中途连接的客户端以 `thread/read`/`thread/resume` 返回值和后续 `item/completed` 校准，不假设所有历史 delta 都会重放。

### Steer 与 Queue

与官方 Codex 语义一致：

- **Steer**：使用 `turn/steer` 将消息加入当前活动 turn，必须携带 `expectedTurnId`。
- **Queue**：由 CodexEverywhere 持久化，在当前 turn 完成后调用新的 `turn/start`。

thread 忙碌时默认 Queue。每条排队消息固定显示在输入框上方的 Queue 托盘中；活动 turn 仍存在时，同一 thread 的队首未投递项提供“转为 Steer”按钮。dispatch 与 Steer 对同一 queue item 竞争同一份永久消费 claim；claim 之前的 workspace、thread 或输入校验失败可以把预留项恢复原排队状态，claim 发布后则已经跨过 app-server 副作用边界，任何拒绝、断连、不可验证响应、权限保存或 claim 完成失败都永久标记为结果待核对，禁止再次 dispatch 或 Steer。

Queue 的推进属于长期 Agent，而不是创建队列项的浏览器连接。如果当前 turn 以 `completed` 正常完成，Agent 自动启动下一项；如果 turn 失败或被中断，所有尚未启动的相关队列项暂停并通知用户，避免异常后连续执行。`delivering` 项不提供操作；`indeterminate` 项及同 thread 后续项保持锁定，用户必须先核对 app-server 权威历史，再通过明确的重复风险确认放弃该记录。成功确认后 dispatcher 被重新唤醒；普通暂停队首也会阻止后续项越序。

### 审批

- Web 和 TUI 都可以响应同一个 app-server 审批。
- Web 将待审批请求固定在输入框上方的审批托盘中，按 `requestId` 分别处理；只展开当前项，其余折叠，完成后自动推进，不提供批量允许。其他客户端先响应时，本页通过 resolved 事件同步收起。
- 第一份有效响应生效。
- `serverRequest/resolved` 到达后，所有设备立即禁用对应操作。
- MCP elicitation 使用 app-server 定义的 `action/content/_meta` 响应结构，不能套用普通审批的 `decision` 字段。
- 过期、已解决或 turn 不匹配的响应必须安全失败。

## 14. 自动化

支持：

- 一次性时间点。
- 固定间隔。
- cron 表达式与明确时区。
- 向已有 thread 排队。
- 在指定 workspace 创建新 thread。

执行规则：

- 目标 thread 忙碌时一律 Queue，绝不自动 Steer。
- 默认使用 `workspace-write` 和 `on-request`。
- 遇到审批或用户输入时暂停并推送通知，不自动批准。
- 用户可以为单项任务显式选择更严格权限或 `never`；危险配置必须二次确认。
- Agent 停机期间错过的单次任务，可在用户设定的截止时间内补跑一次。
- 周期任务不补齐停机期间的历史次数，只记录错过并计算下一个未来触发时间。
- 同一定时任务必须使用确定性触发 ID，防止重启和时钟抖动造成重复执行。

## 15. PWA 体验

核心工作区交互参考 [HAPI](https://github.com/tiann/hapi) 的移动优先信息架构、会话启动流程和结构化工具卡片，但不复制其 Hub/Runner 状态模型，也不将 HAPI 作为依赖。CodexEverywhere 必须直接使用 Codex app-server 的 thread、turn、item、审批和状态作为事实源。HAPI 中与本项目边界冲突的 Web Terminal、多 Agent 统一抽象、中心 Hub 数据库和自建会话状态机不采用。

本节描述产品体验约束，同时包含当前实现和后续目标；凡明确写为“后续”的能力均不属于当前 PWA。当前能力边界以本文第 0 节和 README 状态表为准。

### 核心信息架构

- 登录和首次初始化完成后，首页是会话列表，不在同一页面顶部堆叠新建表单、安全配置和连接配置。
- 桌面端采用“会话列表 + 当前会话”双栏；移动端采用“会话列表 → 全屏会话”的单层导航，并保留明确的返回入口。
- 会话列表按 workspace 分组，行内显示标题、状态、最近活动时间、目录和等待用户操作标记；支持服务端分页、搜索、active/archived 过滤和归档恢复。重命名、归档和删除当前通过受限斜杠指令执行，后续再补行内菜单。
- 安全、Passkey、密码、网络、Codex 安装和工作目录进入独立设置区域，不占用日常会话页面的主要空间；可信设备撤销与完整设备管理仍是后续能力。

### 启动会话

- “新建会话”使用独立页面或对话框。主路径只要求选择目录并填写第一条消息；模型和 reasoning effort 默认继承 Codex 配置及上次成功选择。
- 目录选择提供已登记 workspace、最近目录和受限目录浏览；Agent 必须对最终目录重新执行 `realpath` 与 workspace root 校验。
- 高级设置当前折叠展示 model、reasoning effort、sandbox 和 approval policy；后续接入 service tier 与 personality 时，选项必须来自 app-server 的实际能力，不硬编码不存在的模型或策略。
- 点击创建后依次执行 `thread/start` 和首个 `turn/start`，界面立即进入新 thread，并以幂等键避免重复创建。claim 之前可证明的明确失败会保留表单内容和错误；claim 发布并开始处理后，如果 app-server 断连、返回不可验证内容、Agent 在结果落盘前崩溃、durable result 提交失败，或创建响应后的本地授权/权限保存失败，均可能留下没有首个 turn 的空白 thread。此时系统返回不可判定结果并禁止自动重放，也不会猜测任意候选会话；若最终结果未能落盘，执行前的 NULL claim 与永久旧版镜像继续承担 fail-closed tombstone。从请求发起前到结果明确或用户显式放弃，同一标签页还以固定版本的 opaque `sessionStorage` 标记跨刷新保留“待核对”状态，不写入 prompt、cwd、operation ID、身份或 Host Profile，并注册离开页面提示；存储 API 失败不得让页面崩溃。界面先刷新会话列表供用户人工核对，只有用户显式确认放弃后才清除本地标记并允许用新操作编号再次创建。

### 会话显示与操作

- 通过一个按 `thread/read` 快照和增量 notification 归并的前端 reducer 渲染会话，不直接把 app-server payload 作为 JSON 展示。
- 用户消息、assistant Markdown、计划、命令执行、文件修改、MCP 调用、subagent、审批、用户问题、错误和未知 generic event 使用不同的结构化组件；reasoning item 不在 Web 中展示。
- 命令与工具默认显示紧凑摘要、运行/成功/失败状态和耗时，展开后查看输入输出；文件修改优先显示文件名、增删统计和 diff。
- 审批和 `requestUserInput` 在输入框上方固定托盘内处理，同时在会话列表标记“需要操作”；多设备回答后所有界面同步为已处理。托盘不会触发时间线滚动，也不会抢走用户正在阅读的历史位置。
- 会话头显示标题、目录、状态，输入区状态栏显示模型、reasoning effort 和上下文使用量；重命名、归档、删除和 fork 当前由受限斜杠指令提供，后续再补行内菜单与 export。
- 输入区固定在底部，明确区分发送、Steer、Queue 和 interrupt。运行中默认 Queue；排队内容固定在输入框上方的 Queue 托盘中，同一 thread 仅队首未投递项可点击“转为 Steer”立即补充到当前 turn。出现审批时审批托盘优先，Queue 自动压缩但仍可展开查看。
- `turn/start` 或 `queue/add` 的响应结果未知时，当前页面保留原 operation/idempotency key 并先做权威对账。两种方法在 Agent 侧都已有副作用前 durable claim；若同 key 到达已完成的永久 tombstone，Agent 返回 `IDEMPOTENCY_OUTCOME_INDETERMINATE` 而不会再次执行，页面立即停止自动重试并保留人工核对状态。新版分页接口以有界近期 turn 为主：只要命中 operation ID 即可正向确认；只有完整页，或该页仍包含发送前记录的最新 turn ID 边界时，才能以“未找到”驱动同键重试。旧 app-server 的回退完整快照可在当前页面缓存，但缓存永远只用于 operation ID 的正向命中，不能与以后轮次恢复的 Queue 快照拼成负证据；Queue 负向对账必须在同一轮先成功读取 `queue/list`，再成功读取新的完整 `thread/read`。完整历史读取按 client/operation 总计最多 3 次或 30 秒，Queue 当轮缺失时的成功读取也消耗一次；失败或退避时可用缓存正向收口，耗尽则停止自动 mutation replay 并要求人工刷新核对或风险确认后显式放弃。
- 上述发送 operation key、待确认状态和快照缓存只存在于当前已加载页面的内存，不写入 `sessionStorage`，也不持久化 prompt 或其他业务数据；手动刷新会丢失这些状态，页面因此在仍有待确认发送时注册离开提示。该边界不同于 `thread/start`：只有会话创建使用不含业务内容的 opaque 跨刷新标记来强制人工核对。
- 输入区当前只发送文本，不提供图片或文件附件上传。Gateway 必须拒绝 Web 客户端构造的 `localImage` 输入，避免绕过受限文件服务读取宿主机路径。
- 后续提供受 workspace 限制的文件树、文件预览和完整 diff 浏览，但不提供 Web Terminal 或任意命令入口。当前仅结构化显示 app-server 已返回的文件修改与 unified diff。

主要页面：

- Host profile、配对、Passkey 和恢复。
- 宿主机与 direct/relay 连接状态。
- workspace 和 thread 列表。
- 实时会话页。
- 审批与待回答问题收件箱。
- Queue 管理。
- 文件与完整 diff 浏览（后续）。
- Schedule 与运行历史（后续）。
- Passkey 与安全设置；可信设备撤销和通知设置后续补充。

通知默认覆盖：

- turn 完成或失败
- 等待审批
- 等待用户输入
- Queue 因失败暂停
- 定时任务完成、失败或错过
- 用户 Agent 长时间离线

Push subscription 保存在宿主机，Agent 直接调用浏览器 Push service。通知正文针对目标设备加密，不经过 Relay 的业务数据库；Relay 不是 Push 的必要组件。

## 16. 实施阶段

### Phase 0：文档与风险验证

- 建立本文档和 `AGENTS.md`。
- 固化 app-server 多客户端、审批广播和 pending request replay 的契约测试。
- 验证 Noise 实现在 Node 20 与目标浏览器中的兼容性。
- 验证纯 WASM SQLite 的原子持久化和崩溃恢复。
- 验证 Direct/Relay transport 行为一致、Relay 无状态重启和 route capability。
- 验证宿主机直发 PWA Push 与 IndexedDB 加密缓存。

### Phase 1：本地执行核心

- 建立 monorepo、共享协议和 CI。
- 实现 Agent、app-server 生命周期、协议 adapter 和 `ce` CLI。
- 实现 workspace roots、TUI 包装、健康检查和本地状态。

### Phase 2：身份与安全通道

- 在 Agent 中实现 Passkey、恢复码、设备配对和 host profile 管理。
- 实现 Direct Gateway、可选无状态 Relay、E2EE 和连接恢复。
- 验证跨用户隔离、篡改与重放防护。
- 已将新设备强制配对改为统一入口的 Passkey/专用密码双登录，并实现在线登录名路由、OPAQUE 预认证、临时设备模式、多 Passkey 管理和用户自助恢复码轮换。
- 已实现一次性宿主机 provisioner 安装、现有 SSH 用户安全自助初始化，以及最小的停用/移除、短时恢复交接和安全审计。不创建 Linux 用户，不实现配额或通用 RBAC，管理员路径不得初始化或调用 Codex app-server。

### Phase 3：核心 PWA

- 已重构为移动优先的会话列表/会话详情导航，并将新建会话从当前会话页拆分为独立流程。
- 已实现 thread 快照与 notification reducer，以及用户消息、assistant、plan、tool、diff、approval、requestUserInput 和 generic event 的结构化渲染；reasoning 事件会被有意忽略。
- 已完成会话搜索、状态提示、创建、服务端分页、active/archived 过滤与归档恢复；重命名、归档、删除、恢复和 fork 可通过受限斜杠指令执行，行内操作菜单仍待实现。
- 已完成 model、reasoning effort 的 app-server 动态选项和 sandbox、approval 启动设置；service tier 与 personality 仍待接入实际能力。
- 已实现 Steer、持久 Queue、interrupt、等待操作提示和断线重同步；Service Worker 当前只缓存应用外壳，设备级加密离线会话缓存仍待实现。
- 会话输入器当前仅支持文本；图片和文件附件上传不属于当前 PWA 实现，受限文件服务仍属于 Phase 4。

### Phase 4：完整平台能力

- 文件浏览、上传、下载和 diff。
- 自动化、执行历史和 missed-run 策略。
- 加密 Web Push、设备与安全设置。

### Phase 5：部署与试运行

- 在 Mac 完成自动化端到端测试。
- 在首个测试集群以普通 Linux 用户完成部署。
- 在公网 VPS 部署无状态 Relay；业务配置和身份数据仍全部留在 HPC。
- 在具有安全公网入口的测试宿主机验证无 VPS 的 Direct 模式。
- 稳定后让第二个 Linux 用户独立初始化 Agent，验证不同 ChatGPT/Codex 账号与 Linux 权限隔离。

## 17. 测试与验收

### 协议与生命周期

- 两个 workspace、至少三个 thread 可并行运行且状态不串扰。
- TUI 与 Web 同时订阅同一 thread，实时看到用户消息、回复、工具和最终状态。
- TUI 恢复包含多 MB 历史或工具输出的 thread 时，Web 连接保持在线并能重组完整事件。
- 任一客户端断线时活动 turn 继续；重连后 thread ID 和 turn ID 不变。
- Web 切换或离开会话、Queue 耗尽或暂停后会释放对应订阅；没有订阅者的 thread 可由 app-server 自动卸载，重新打开后历史完整且无需用户手工管理卸载。
- Agent 重启重新附着 app-server，不 interrupt 活动任务。
- 未知 app-server event 不导致崩溃。

### 消息与审批

- Steer 使用正确的 `expectedTurnId`，完成竞态时不误投递。
- Queue 在重连、刷新和 Agent 重启后仍存在且不重复执行；关闭创建 Queue 的浏览器后，Agent 仍能在前一 turn 正常完成时继续执行。
- Queue 转 Steer 成功后只执行一次；消费 claim 前失败时消息保留原状态，claim 后失败或结果未知时进入人工核对且 dispatch / Steer 都不能重放。同 thread 的结果未知或暂停队首会阻断后续项，显式放弃/移除队首后才恢复推进；失败或中断的前一 turn 不触发下一项。
- 多设备同时审批只有第一份生效，其他客户端收到 resolved。
- 所有写请求在重试时保持幂等。

### 安全与隔离

- 两个 Linux 用户分别登录不同 ChatGPT/Codex 账号，模型权限、额度、配置和退出登录互不影响。
- 用户无法枚举或读取其他用户节点、workspace、thread、文件和通知。
- Relay 重启前后磁盘均不存在用户数据库；日志和抓包中不出现用户身份、明文路径、提示词、回复或文件内容。
- Direct 与 Relay 对 thread、审批、Queue、文件和自动化表现一致；切换 transport 不改变业务状态。
- 路径穿越、符号链接逃逸、未认证业务请求、密文篡改和重放全部失败关闭；未知设备只能调用限流的登录与恢复方法。
- 私钥、恢复码和配对秘密具有正确权限且不进入日志。
- 首次初始化后，全新浏览器从统一 PWA 首页输入登录名并选择有效 Passkey 或专用密码即可登录，不需要个人访问链接、HPC CLI 或旧设备批准。
- 临时设备退出后不保留 host profile、设备私钥、业务会话或离线对话缓存。
- 首次注册和用户主动轮换时，恢复码只直接展示给用户一次；数据库、日志和管理员界面均不能读取原码。
- 管理员重新签发恢复码会使旧码全部失效并产生审计；使用新码恢复后撤销旧 Passkey、专用密码、设备、Push subscription 和 Web 会话，新 Passkey 注册取消时不提前消费恢复码。
- 管理员可以启停和移除 CodexEverywhere 用户，但无法列出或操作任何用户的 workspace、thread、文件、Codex 凭据或 app-server 方法。

### 自动化与 PWA

- 忙碌 thread 的计划消息进入 Queue 而非 Steer。
- 审批暂停、单次补跑和周期跳过规则正确。
- 离线 PWA 只能打开应用外壳并保留当前页面内存中已经呈现的内容，不能读取未加载会话、发送或审批；设备级加密业务缓存仍待实现。
- 网络恢复后增量同步且不重复显示事件。
- Push subscription 与通知规则只存在宿主机，Push 内容保持设备级密文。

### 环境

- Agent 在 CentOS 7、glibc 2.17、Node.js 20 下运行。
- 不依赖用户级 systemd。
- crontab watchdog 不覆盖用户已有内容，也不会启动重复实例。
- 公网断开不影响已经运行的 Codex turn。

## 18. 当前决策

- 项目名：CodexEverywhere。
- CLI：`ce`。
- 文档：中文为主。
- 发布方式：先私有开发。
- 用户模型：可信小团队中的独立 Linux 用户，无中心化租户或账号数据库。
- 管理模型：宿主机本地管理员完成一次公共安装，此后符合条件的现有 SSH 用户自行初始化；管理员只额外负责停用、移除和恢复，不创建 Linux 用户，也不拥有 Codex 身份或用户业务数据访问权。
- 执行身份：每人自己的 Linux 账号。
- Codex 身份：每人自己的 ChatGPT/Codex 账号。
- 后端：每个用户一个长期 app-server。
- 客户端：Web/PWA + 官方 TUI，不开发原生客户端。
- 身份与配置：管理员目录、Passkey、PAKE password record、恢复码哈希、设备、workspace、Queue、Schedule 和通知配置全部保存在 Codex 宿主机。
- 数据：宿主机保存全部用户数据与配置；Relay 无状态且只转发密文。
- 连接：HPC 内网可达或宿主机有安全公网入口时使用 Direct；只有宿主机不可达时使用可选 Relay。
- 传输：端到端加密，并披露 PWA 代码分发边界。
- 忙碌期默认行为：Queue；同一 thread 的队首未投递消息可在活动 turn 结束前原子转换为 Steer，投递中或结果待核对项会阻断后续转换。
- 文件：浏览、预览、上传、下载、diff；不在线编辑。
- 自动化：安全配置、等待审批、单次补跑、周期跳过。
- Web Terminal：不提供。
- 首个目标环境：CentOS 7 HPC，架构允许未来增加其他主机。

PWA 静态地址通过 `PUBLIC_ORIGIN` 配置，Agent 连接通过独立的 `DIRECT_ENDPOINT` 或 `RELAY_ENDPOINT` 配置。宿主机可自行提供 PWA 与 WSS，从而完全不使用 VPS。文档示例统一使用 `https://codex.example.com`，代码和协议不得硬编码具体域名。
