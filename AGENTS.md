# CodexEverywhere

## 项目目标

- 构建面向 Linux/HPC 的自托管 Codex Web/PWA 控制平台。
- 产品优先级是让用户随时随地、以最少步骤使用 HPC 上的 Codex；不建设通用组织治理、计费、资源配额或复杂 RBAC。
- 将 Codex app-server 作为 thread、turn、审批、工具活动和执行状态的唯一事实源，不重新实现 Codex Agent 状态机。
- 项目独立于 HAPI。可以研究 HAPI 和 OpenAI Remote，但不得将其作为运行依赖或架构前提。

## 架构原则

- 每位用户在自己的 Linux 账号下运行 CodexEverywhere Agent 和 Codex app-server。
- CodexEverywhere 只能供可通过 NSS 查询、具有登录 home/shell 且能够通过 HPC 现有 SSH 策略登录的 Linux 用户使用；管理员完成一次宿主机安装后，这些用户应能自行初始化，不得要求管理员逐个开通，也不得创建、修改或复用系统账号。
- 每位用户使用自己的 ChatGPT/Codex 账号认证，凭据保存在自己的 `~/.codex`。
- CodexEverywhere 应能在用户自己的 `~/.local` 中安装 Codex，并通过 app-server 设备码流程在 PWA 内引导登录；不得要求 root 或代管 OpenAI 凭据。
- Codex 出网方式由每位用户选择直连或代理。代理配置只保存在 Codex 宿主机，只注入该用户的 Codex 安装、登录和运行进程，不进入 Relay 或浏览器持久存储。
- CodexEverywhere Passkey 由 Codex 宿主机验证，只用于该宿主机的 Web 身份，不能替代或代理 `codex login`。
- CodexEverywhere Web 身份同时支持 Passkey 和独立的 CodexEverywhere 密码；不得复用、收集或验证 SSH/Linux 密码。
- 完成首次引导后，新设备不得依赖 HPC CLI、旧设备批准或预先加入设备白名单才能登录；临时模式不得持久化密码、设备私钥、Host Profile 或业务缓存。
- Workspace、会话、文件、Queue、Schedule、Codex 凭据和运行状态仅归所有者可见。
- 宿主机本地管理员账户只管理 CodexEverywhere 的一次性宿主机安装，以及现有 SSH 用户的停用、移除和 Web 凭据恢复；不得创建 Linux 用户、拥有 Codex 身份、启动 app-server、读取用户业务数据或代替用户操作 Codex。
- 恢复码首次注册时直接一次性展示给用户，宿主机只保存哈希；用户可在已认证会话中轮换，管理员只能在身份核验后触发重新签发，旧码必须全部失效且操作必须审计。
- 业务数据和配置默认保存在真正运行 Codex 的宿主机；可选公网 Relay 必须无状态，只转发端到端密文。
- 宿主机具有安全公网入口时允许浏览器直接连接，Relay 不得成为强制依赖。
- 每个 Linux 用户只运行一个长期 app-server，由它承载多个 workspace 和 thread。
- Agent 必须能在 Codex 尚未安装或尚未登录时独立启动，以提供安全的首次安装、网络配置和登录引导。
- 通过 `codex --remote` 保留官方 TUI；设备切换不得中断活动 turn。

## 环境约束

- 首个兼容目标环境为 CentOS 7、Node.js 20、glibc 2.17。
- 只有登录节点可以访问外网；计算与 GPU 节点使用共享 `/public` 文件系统和现有 HPC 工作流。
- 用户级 systemd 不可用；用户服务必须兼容 tmux、crontab watchdog、PID 文件和文件锁。
- 避免依赖新 glibc 或目标环境无法构建的原生运行库。
- 不实现 Web Terminal 或第二套 HPC 调度器；集群操作遵循各用户现有的 `~/.codex/AGENTS.md`。

## 工程规则

- 文档以中文为主，代码、schema、协议字段和标识符使用英文。
- 实现前阅读 `README.md`；产品、协议、安全或架构决定变化时同步更新它。
- 使用严格 TypeScript，并为所有跨组件协议消息设置版本。
- 所有路径先解析真实路径，再校验 workspace root；拒绝路径穿越和符号链接逃逸。
- 禁止记录提示词、文件内容、凭据、恢复码、配对秘密或已解密的 Relay payload。
- 将未知 Codex 事件作为向前兼容的 generic event 处理，不得崩溃或静默丢弃。
- 交付前运行 `README.md` 规定的相关类型检查、单元测试、协议测试和端到端测试。
