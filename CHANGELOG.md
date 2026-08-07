# 版本记录

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构，并使用[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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
