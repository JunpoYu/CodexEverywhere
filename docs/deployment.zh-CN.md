# 部署与升级

本文档定义 CodexEverywhere 的生产部署边界。部署系统是 GitHub Release 的消费者，不是第二套构建系统。

## 1. 信任链

```text
功能分支 → Pull Request → CI → main → annotated tag
         → GitHub Release 制品 + manifest + SHA-256 + provenance
         → staging → 人工批准 → production
```

生产部署只接受语义版本 tag，例如 `v0.3.0-alpha.5`。禁止从功能分支、PR head、本地路径、未提交工作区或服务器上的 Git checkout 构建生产文件。生产服务器不需要 clone 本项目，也不得通过 `git pull`、`pnpm install` 或 `pnpm build` 完成升级。

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

每个 GitHub Release 同时发布 Web 静态文件、Agent production bundle、Relay production bundle、HPC 部署工具、`manifest.json` 和 `SHA256SUMS`。三个组件使用同一个项目版本；`manifest.json` 的 `protocolVersion` 用于部署前兼容性检查。每个组件内部还包含 `build-info.json`，记录版本、完整 commit 和协议版本，便于运行环境与 Release 对账。

Release 制品由 GitHub Actions 从 tag 的干净 checkout 构建一次。部署时不得执行 `pnpm build`，也不得重新打包制品。

## 3. HPC

首次宿主机 bootstrap 仍按 README 创建无 sudo 权限的 `codexeverywhere` 账号、共享 Node.js/tmux runtime、rootless provisioner，以及 root 所有的固定 `/usr/local/bin/ce`。这是宿主机安装，不属于普通版本发布。

后续版本由专用账号执行。先从 Release 下载并验证 `codex-everywhere-hpc-tools-<tag>.tar.gz`，然后在解压目录运行：

```bash
hpc-tools/install-release.sh <tag>
```

也可以显式指定 fork 和安装位置：

```bash
hpc-tools/install-release.sh \
  <tag> \
  example/CodexEverywhere \
  /srv/codex-everywhere \
  /srv/codex-everywhere/runtime
```

安装器会下载 Agent tarball、`manifest.json` 和 `SHA256SUMS`，交叉验证版本、文件名与哈希，拒绝不安全归档路径，然后安装到：

```text
<install-root>/releases/<tag>
```

验证后原子切换 `current`。安装器同时把经过验证的 manifest 保存为该版本的 `release-manifest.json`，并原子更新安装根目录的 `active-release`；它们是不含 secret 的服务器本地 inventory。共享 runtime 不随每个版本重复安装。`/usr/local/bin/ce` 始终指向专用账号的稳定 wrapper。

回滚不下载或重建任何内容：

```bash
hpc-tools/activate-rootless-release.sh \
  <old-tag> \
  /srv/codex-everywhere
```

切换 `current` 后重启 provisioner 和用户 Agent 才会加载新代码；健康 app-server、官方 TUI 和活动 turn 不应停止。生产运维应记录尚未重启的用户 Agent，并采用滚动方式完成切换。

## 4. Web

Web 服务器推荐使用版本目录和原子软链接：

```text
/srv/codex-everywhere/web/
├── releases/<tag>/web/
└── current -> releases/<tag>/web
```

部署过程只解压已经验证的 Web 制品，检查 `index.html`、CSP 和静态资源，再切换 `current`。Nginx 永远指向 `current`。回滚只切回旧目录，不重新构建。

## 5. Relay

Relay 使用类似目录：

```text
/opt/codex-everywhere/relay/
├── releases/<tag>/relay/
└── current -> releases/<tag>/relay
```

systemd 或其他 supervisor 使用稳定的 `current/dist/cli.js`。部署前验证 manifest 和哈希，切换后重启 Relay 并检查健康状态。Relay credential、TLS 和监听配置保存在 systemd EnvironmentFile、secret manager 或私有 ops 配置中，绝不进入 Release。

## 6. 环境与审批

推荐至少维护 `staging` 与 `production`：

- PR 不能部署任何生产环境；
- 合并 `main` 不等于发布；
- tag/Release 不等于生产部署；
- staging 验证的是 GitHub Release 原始制品；
- production 必须部署 staging 验证过的同一哈希；
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

## 7. 配置与备份

程序、配置和状态必须分离：

- `releases/<tag>` 与 `current` 只保存可重新下载的程序；
- HPC provisioner 配置保存在专用账号 home，用户状态分别保存在各自的 `~/.codex-everywhere` 与 `~/.codex`；
- Relay credential 与状态保存在 `/var/lib` 或显式的 `CE_RELAY_HOME`；
- Nginx、systemd、TLS 和环境文件保存在服务器 `/etc`；
- 备份不得写入源码 checkout、Release 目录或公开仓库。

升级前备份配置和 inventory，升级后确认其 inode、权限或内容未被安装器替换。敏感备份必须加密并设置保留期。Release 制品无需备份，可随时从 GitHub 重新下载。

## 8. 兼容与可观测性

Web 和 Agent 的版本可能在滚动升级期间短暂不一致，因此协议变更至少保持当前版与上一版兼容。Relay 尽量只转发密文，不依赖业务消息结构。

最终应在 Web 设置、Agent 状态和 Relay 健康端点显示项目版本、commit 与协议版本；生产 inventory 同时记录三个组件的已部署 Release。版本不一致应提示，但不能在兼容范围内阻断用户。
