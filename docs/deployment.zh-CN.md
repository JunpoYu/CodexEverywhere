# 部署与升级

本文档定义 CodexEverywhere 的生产部署边界。部署系统是 GitHub Release 的消费者，不是第二套构建系统。

需要实际执行首次安装、补丁升级、v0.4 全新切换或回滚时，使用[部署、升级与回滚操作手册](operator-runbook.zh-CN.md)。该手册同时规定后续 Agent 的输入、停止条件、rootless/root-owned 双 CLI、验证和交付格式；本文只解释为什么必须遵守这些边界。

## 1. 信任链

```text
功能分支 → Pull Request → CI → main → annotated tag
         → GitHub Release 制品 + manifest + SHA-256 + provenance
         → staging → 人工批准 → production
```

生产部署只接受语义版本 tag，例如 `v0.4.0-alpha.5`。禁止从功能分支、PR head、本地路径、未提交工作区或服务器上的 Git checkout 构建生产文件。生产服务器不需要 clone 本项目，也不得通过 `git pull`、`pnpm install` 或 `pnpm build` 完成升级。

公开仓库保存通用代码、模板和安装器。个人与单集群部署默认把真实配置保存在对应服务器的本地受限目录；只有多环境、多人运维或需要配置审阅时，才需要额外建立私有 ops 仓库。两种方式都不得把生产配置复制回公开开发仓库。

配置归属如下：

| 内容                               | 权威位置                        | 进入公开 Git |
| ---------------------------------- | ------------------------------- | ------------ |
| 源码、测试、通用安装器             | 公开仓库                        | 是           |
| Nginx、systemd 示例                | 公开仓库                        | 仅占位符模板 |
| Web、Agent、Relay 程序             | GitHub Release 与服务器版本目录 | 仅 Release   |
| 域名、主机、SSH 参数、代理默认值   | 对应生产服务器                  | 否           |
| Relay credential、TLS/SSH 私钥     | 对应服务器受限目录              | 否           |
| 用户 Passkey、密码记录、Codex 凭据 | 用户自己的 HPC home             | 否           |
| 当前部署版本、时间与回滚记录       | 服务器本地 inventory            | 否           |

服务器本地至少记录：

- staging/production inventory；
- 域名、主机地址和 SSH 参数；
- Relay、TLS、GitHub Environment 等 secret；
- 每个环境当前选择的 Release 版本；
- 部署时间、操作者和回滚记录。

## 2. Release 制品

每个 GitHub Release 同时发布 Web 静态文件、Agent production bundle、Relay production bundle、HPC 部署工具、`manifest.json` 和 `SHA256SUMS`。三个组件使用同一个项目版本；安装器要求 `manifest.json` 的项目名、版本、commit、Node.js 下限和 `protocolVersion` 与当前安装器支持范围一致，并把 Agent 内部的 `build-info.json` 与 manifest 再次对账。

Release 制品由 GitHub Actions 从 tag 的干净 checkout 构建一次。制品脚本自身也会拒绝脏工作区、未跟踪文件、`HEAD`/传入 commit 不一致或 tag 未指向该 commit，避免本地误用时把一份源码标成另一份 commit。部署时不得执行 `pnpm build`，也不得重新打包制品。

## 3. v0.3 到 v0.4 的全新切换

v0.4 是协议不兼容的全新初始化，不提供 v0.3 数据库转换或反向迁移。Noise transport 和 Relay wire 保持 version 1，加密后的 Gateway API 使用 version 2。旧浏览器与新 Agent、新浏览器与旧 Agent 都明确失败，不静默降级。

切换时必须停止旧 Agent/Controller，但保持健康的 Codex app-server；完整改名保留旧 `~/.codex-everywhere` 与 `CE_ADMIN_HOME`。宿主级 rootless provisioner 也有独立的 admin 状态库：必须在任何 v0.4 用户配对前停止 provisioner，将旧 `admin-state.sqlite` 改名保留，再用 v0.4 创建新库；root-owned fallback 的同名库若存在也按相同规则处理。provisioner 的 `config.json`、credential 和身份密钥必须保留。Passkey、CE 密码、恢复码、Host Profile、Relay route、Workspace、偏好和 Queue 都重新初始化。`~/.codex`、Codex 登录和 app-server 任务不属于清理范围。

多用户 staging 仍要验证隔离、Direct/Relay、Controller、新设备配对和制品指针回滚，但不再执行正反数据迁移。观察窗内可通过停止 v0.4、将新 CE 目录留存、原子恢复旧目录并切回 alpha.14 来恢复；两份状态不得合并。

完整步骤见 [v0.4 全新初始化与切换手册](migration-v0.4.zh-CN.md)。Service Worker 更新期间，如果页面存在 outcome-unknown mutation、未保存秘密或草稿，只提示新版本，不自动刷新。

## 4. HPC

首次宿主机 bootstrap 使用专用无 sudo 部署账号、共享 Node.js/tmux runtime、rootless provisioner，以及 root 所有的固定 `/usr/local/bin/ce`。启用 Administrator Controller 时，还必须从同一份 verified Agent release 安装独立的 root-owned CLI；全局启动器只让 root 进入该副本，绝不能让 root 执行部署账号可写的 JavaScript 或 runtime。两个副本必须保持同一 tag。这是宿主机安装，不属于普通版本发布，完整命令见[操作手册](operator-runbook.zh-CN.md)。

宿主机 provisioner credential 具有独立有效期。生产监控应执行 `ce provisioner status`，并在到期前至少 30 天由 Relay 运维者以原 `installationId` 重新运行 `ce-relay issue-provisioner --installation-id <id> --expires-days <days>`，再通过受保护标准输入重复执行 `ce provisioner install ... --credential-stdin`。这一步是授权续期，不能由普通 Unix 用户自动完成；用户 Agent 只会在当前有效 credential 下为 UID/NSS 已绑定的随机 route 自动换发 capability。Administrator Controller 使用独立的 host-admin route registry：root 发布的 version 2 注册记录、请求文件内核 owner UID、当前 NSS tuple、admin handle 和 route ID 必须全部一致，provisioner 才会续签同一路由，Controller 不接触 credential。Agent 与 Controller 都会无限次重试，间隔上限依次为 12 小时、1 小时和 5 分钟，并按随机 route 做确定性抖动；该机制不会延长已经到期的 provisioner credential。

v0.4 全新初始化会通过当前 rootless provisioner 签发新 route，不尝试把 v0.3 capability 迁入新 registry，也不覆盖旧 route ID。切换前先按全新初始化手册隔离 provisioner 的旧 admin 状态库，再重启当前 Release 的 provisioner 并核对 descriptor/credential；不得删除或重建 provisioner credential、`config.json` 或身份密钥。随后停止旧 Agent、隔离旧 CE 目录和重新配对。

后续版本由专用账号执行。先从 Release 下载并验证 `codex-everywhere-hpc-tools-<tag>.tar.gz`，然后在解压目录运行。安装机已配置支持所需约束参数的 GitHub CLI 时，安装器会验证 GitHub provenance attestation，并把签名者限定为本仓库 `.github/workflows/release.yml`、source ref 限定为请求的 tag、source digest 限定为 manifest 中的 commit，同时拒绝 self-hosted runner provenance：

```bash
hpc-tools/install-release.sh <tag>
```

生产环境也可以把 staging 已批准的 `manifest.json` SHA-256 作为独立信任根传入；这种方式不要求安装 GitHub CLI，并保证 production 消费与 staging 完全相同的 manifest：

```bash
hpc-tools/install-release.sh \
  <tag> \
  example/CodexEverywhere \
  /srv/codex-everywhere \
  /srv/codex-everywhere/runtime \
  <approved-manifest-sha256>
```

也可通过 `CE_APPROVED_MANIFEST_SHA256` 提供同一摘要。安装器拒绝“既没有经批准摘要，也无法验证 GitHub attestation”的安装；仅从同一 Release 下载 manifest、校验和与 tarball 后彼此对账不构成独立真实性证明。

安装器会下载 Agent tarball、`manifest.json` 和 `SHA256SUMS`，验证信任根并交叉检查版本、commit、协议、Node.js、文件名、哈希与 bundle 构建信息，拒绝不安全归档路径，然后安装到：

```text
<install-root>/releases/<tag>
```

验证完成后，安装器先把 manifest、release ID、build-info 和程序一起写入版本目录，并记录每个目录、文件、符号链接、mode、大小与内容哈希，最后原子切换 `current`。`active-release` 通过 `current/release-id` 跟随同一个权威指针。重复安装同一份完整制品时会把传入 bundle 的 inventory 与已安装目录逐项比较；回滚前也会重新计算并验证，残缺、被修改或同名但内容不一致的目录均被拒绝。共享 runtime 不随每个版本重复安装。`/usr/local/bin/ce` 始终指向专用账号的稳定 wrapper。

这份 inventory 是部署账号未失陷前提下的本地内容漂移检测基线，不是新的制品签名或独立信任根。若专用部署账号、其 runtime 或 HPC 工具本身可能已被攻陷，应停止本地回滚，从重新认证的 Release 制品恢复安装。

回滚不下载或重建任何内容：

```bash
hpc-tools/activate-rootless-release.sh \
  <old-tag> \
  /srv/codex-everywhere
```

启用 Controller 的宿主机还要使用 `activate-shared-release.sh` 切换 root-owned 副本，并重新生成双路全局启动器；不能让 root 临时回退到 rootless release。首次 bootstrap、普通升级和回滚所需脚本都随 `codex-everywhere-hpc-tools-<tag>.tar.gz` 发布。

该命令默认只接受由正式 Release 安装路径生成的 `verified` inventory。开发 bundle 由 `install-rootless-agent.sh` 记录为 `development`；若确需在非生产环境切回，必须显式执行 `activate-rootless-release.sh <id> <install-root> <runtime-directory> --allow-development`。升级前遗留且没有 `release-inventory.json` 的目录一律拒绝，不会因为其中恰好存在 `dist/cli.js` 就补写 release ID 或宣称已经验证；需要继续使用时应从可信制品重新安装为新目录。

切换 `current` 后重启 provisioner 和用户 Agent 才会加载新代码；健康 app-server 和活动 turn 不应停止。普通补丁升级可让既有官方 TUI 继续连接，但若 Release 说明包含跨进程状态代次、锁或 app-server 权限协调迁移，所有升级前启动的 `ce tui` 也必须在对应用户 Agent 重启后退出并用新 Release 重连；退出 TUI 不会中断 app-server 中仍在运行的 turn。已加载旧 JavaScript 的 Agent/TUI 无法被新代码的 coordination fence 追溯约束，混用期间不提供新版本的并发一致性保证。生产运维应记录尚未重启的用户 Agent 与尚未重连的 TUI，并采用滚动方式完成切换。

## 5. Web

Web 服务器推荐使用版本目录和原子软链接：

```text
/srv/codex-everywhere/web/
├── releases/<tag>/web/
└── current -> releases/<tag>/web
```

部署过程只解压已经验证的 Web 制品，检查 `index.html`、CSP 和静态资源，再切换 `current`。Nginx 永远指向 `current`。回滚只切回旧目录，不重新构建。

## 6. Relay

Relay 使用类似目录：

```text
/opt/codex-everywhere/relay/
├── releases/<tag>/relay/
└── current -> releases/<tag>/relay
```

systemd 或其他 supervisor 使用稳定的 `current/dist/cli.js`。`ce-relay serve` 必须显式传入 `--installation-id`，并与该 Relay 接受的 host provisioner credential 完全一致；一个进程只允许一个 installation，需要多个 installation 时使用隔离的实例、入口和运维配置，禁止以首次注册者作为动态归属。部署前验证 manifest 和哈希，切换后重启 Relay 并检查健康状态。Relay credential、TLS 和监听配置保存在 systemd EnvironmentFile、secret manager 或私有 ops 配置中，绝不进入 Release。

从旧版升级时，必须先将 systemd 模板中的 `__INSTALLATION_ID__` 替换为现有 provisioner 的 ID；保留占位符会因 ID 格式非法而启动失败。该升级只增加 Relay 的 fail-closed installation 边界和 installation-scoped 登录发现，不轮换已有 v3/v4 route ID，Agent、Administrator Controller 与浏览器中已保存的 Host Profile 可继续使用。主密钥签名的 v1/v2 capability 仅作为明确的运维兼容路径保留。

## 7. 环境与审批

推荐至少维护 `staging` 与 `production`：

- PR 不能部署任何生产环境；
- 合并 `main` 不等于发布；
- tag/Release 不等于生产部署；
- staging 验证的是 GitHub Release 原始制品，并记录获批 manifest SHA-256；
- production 必须把该摘要传给安装器，部署 staging 验证过的同一份 manifest 与制品；
- production 需要人工批准；
- 失败时回滚到上一 Release，不在服务器直接修代码。

服务器本地 inventory 可以保存如下非秘密版本选择；文件不放在程序 Release 目录内，升级时不得覆盖：

```json
{
  "environment": "production",
  "version": "<tag>",
  "components": {
    "web": "<tag>",
    "relay": "<tag>",
    "agent": "<tag>"
  }
}
```

个人部署可以直接把 inventory 保存在只有部署账号可写的本地文件中，并通过项目目录之外的加密备份保护。私有 ops 仓库只是可选的多环境协作层；真实 secret 始终使用服务器文件权限、GitHub Environments 或专用 secret manager，不提交到任何 Git 历史。

## 8. 配置与备份

程序、配置和状态必须分离：

- `releases/<tag>` 与 `current` 只保存可重新下载的程序；
- HPC provisioner 配置保存在专用账号 home，用户状态分别保存在各自的 `~/.codex-everywhere` 与 `~/.codex`；
- Relay credential 与状态保存在 `/var/lib` 或显式的 `CE_RELAY_HOME`；
- Nginx、systemd、TLS 和环境文件保存在服务器 `/etc`；
- 备份不得写入源码 checkout、Release 目录或公开仓库。

升级前备份配置和 inventory，升级后确认其 inode、权限或内容未被安装器替换。敏感备份必须加密并设置保留期。Release 制品无需备份，可随时从 GitHub 重新下载。

## 9. 兼容与可观测性

v0.4 不兼容 Gateway API v1。Web 与 Agent 版本不一致时必须返回 `CLIENT_UPGRADE_REQUIRED` 或 `AGENT_UPGRADE_REQUIRED` 并阻断业务请求；禁止把协议错误当成离线、重试副作用或自动降级。Relay 继续只转发 version 1 密文帧，不依赖 Gateway 业务结构，因此无需与每个用户的数据库迁移同步重启。

Web 设置、Agent 状态和 Relay 健康端点应显示项目版本、commit、Gateway API、Noise 和 Relay wire 版本；生产 inventory 同时记录三个组件的 Release。v0.4 后的兼容策略必须由协议合同明确声明，不能默认“当前版与上一版兼容”。
