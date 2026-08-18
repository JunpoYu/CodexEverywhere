# 部署、升级与回滚操作手册（供人和 Agent 执行）

本文档是 CodexEverywhere 的可执行运维入口。它把[部署边界](deployment.zh-CN.md)、[发布流程](releasing.zh-CN.md)、[v0.4 全新初始化](migration-v0.4.zh-CN.md)和 [staging 验收](staging-v0.4.zh-CN.md)转换为有停止条件的操作顺序。后续接手的 Agent 必须先完整阅读本文，再开始任何写操作。

本文中的 `<占位符>` 必须替换后才能执行。填好的主机名、用户名、路径和 inventory 只能保存在对应服务器或私有运维环境，不能提交到公开仓库。命令输出不得粘贴业务日志、数据库、配对资料、恢复码、Relay capability、Codex 凭据或解密 payload。

## 1. Agent 执行契约

接手部署的 Agent 必须遵守以下顺序：

1. 只读采集当前版本、release 指针、服务状态、时钟、磁盘和回滚制品；
2. 向操作者复述目标版本、影响用户、Direct/Relay/Web/Controller 范围和回滚点；
3. 在得到本次变更的明确授权后才下载、安装、切换、重启或重建 CE 状态；
4. 每个阶段先验证再进入下一阶段，失败时停止，不在服务器 checkout 中临时修代码；
5. 结束时报告版本、commit、manifest SHA-256、服务健康和未完成事项，但不报告敏感内容。

下列情况必须停止并请求人工处理：

- tag 不属于公开 `main`、CI 未通过、Release 缺少 manifest/checksum/provenance，或版本/commit 不一致；
- production 没有 staging 批准的 `manifest.json` SHA-256；
- 浏览器、Agent 宿主机或 Relay 的 UTC 偏差超过 30 秒，或 NTP 未同步；
- 目标或回滚 release 不完整、inventory 校验失败、安装目录发生内容漂移；
- v0.4 全新切换前仍有运行中 turn、未解决 interaction、delivering Queue、pending mutation、登录流程或 Side；
- 旧 CE 目录不能以原子改名的方式完整隔离，或保留目标已存在；
- 需要首次 Passkey、恢复码或 Codex 设备码登录，但对应的人不在场；
- 命令要求把 secret 放入参数、shell history、Git、Issue 或普通日志。

## 2. 交接输入

操作者应把以下非秘密信息交给 Agent。没有 Administrator Controller 时，`controllerUser` 和 `privilegedRoot` 可以省略；production 的 `approvedManifestSha256` 不能为空。

```yaml
schemaVersion: 1
operation: inspect | fresh-install | patch-upgrade | clean-v0.4-cutover | rollback
environment: staging | production
repository: example/CodexEverywhere
targetTag: v0.4.0-alpha.5
rollbackTag: v0.3.0-alpha.14
approvedManifestSha256: <64 个小写十六进制字符>
pwaOrigin: https://codex.example.com
relayEndpoint: wss://codex.example.com/relay
directEndpoint: wss://direct.example.com/gateway
installationId: <稳定的 Relay installation ID>
deployUser: codexeverywhere
controllerUser: ce-admin
rootlessRoot: /srv/codex-everywhere
privilegedRoot: /opt/codex-everywhere-privileged
rootCondaRoot: /opt/codex-everywhere-bootstrap
miniforgeTag: <固定的官方 Miniforge release tag>
miniforgeAsset: <该 tag 的 Linux 架构安装器完整文件名>
miniforgeSha256: <从官方 release 固定并复核的 64 位小写十六进制摘要>
webRoot: /srv/codex-everywhere-web
relayRoot: /opt/codex-everywhere-relay
affectedUsers:
  - alice
  - bob
```

这份交接记录不能包含密码、私钥、capability、配对 JSON、恢复码或 Codex token。Secret 只能通过受限的 `0600` 文件、secret manager 或命令的标准输入传递。

## 3. 角色和安装树

多用户 HPC 使用两个彼此分离的 Agent 程序副本：

| 副本               | 所有者             | 用途                                                                    |
| ------------------ | ------------------ | ----------------------------------------------------------------------- |
| rootless release   | 专用无特权部署账号 | 普通用户 CLI、Agent 和 rootless provisioner                             |
| privileged release | `root:root`        | Administrator Controller helper、maintenance 和其他明确要求 root 的 CLI |

`/usr/local/bin/ce` 是 root 拥有的双路启动器：非 root 进入 rootless release；root 只能进入独立的 root-owned release。禁止让 root 直接执行部署账号可写的 JavaScript、Node runtime 或 shell script。启用 Controller 的宿主机必须保证两个副本使用同一 tag。

推荐目录：

```text
<rootlessRoot>/
├── runtime/
├── releases/<tag>/
├── current -> releases/<tag>
└── bin/ce

<privilegedRoot>/
├── runtime/
├── releases/<tag>/
├── current -> releases/<tag>
└── bin/ce
```

Web、Relay、配置、状态和备份必须位于各自独立的目录，不能放进上述 release 目录。

## 4. 只读预检

先记录当前 UTC 和同步状态：

```bash
date -u +%Y-%m-%dT%H:%M:%SZ
timedatectl status
chronyc tracking
chronyc sources
```

从操作机在一次 SSH 往返中读取 `date -u +%s`，按往返中点估算偏差。浏览器所在设备也必须使用自动时间。任何关键节点偏差超过 30 秒都先修时钟。

再检查身份、空间和现有版本：

```bash
id <deployUser>
id <controllerUser>
sudo -n true
df -h <rootlessRoot> <privilegedRoot> <webRoot>
/usr/local/bin/ce --version
readlink -f <rootlessRoot>/current
cat <rootlessRoot>/active-release
```

启用 root-owned CLI 后还应执行：

```bash
sudo -n /usr/local/bin/ce --version
readlink -f <privilegedRoot>/current
sudo -n cat <privilegedRoot>/active-release
```

两个版本必须相同。未启用 Controller 的纯 rootless 安装中，`sudo /usr/local/bin/ce ...` 应明确拒绝执行，而不是进入部署账号的 release。

分别以真实运行身份检查服务：

```bash
sudo -iu <deployUser> /usr/local/bin/ce provisioner status
sudo -iu <affectedUser> /usr/local/bin/ce agent status
sudo -iu <affectedUser> /usr/local/bin/ce app-server status
sudo -iu <affectedUser> /usr/local/bin/ce doctor
sudo -iu <controllerUser> env CE_ADMIN_HOME=<controller-home> \
  /usr/local/bin/ce admin web status
```

状态检查可以报告路径，但不得把真实路径复制到公开日志。全新切换前还要在 Web 中确认 turn、interaction、Queue、mutation 和登录流程已经静止。

## 5. 获取并验证 Release

生产服务器不能 `git pull`、`pnpm install` 或 `pnpm build`。只消费 GitHub Release 中的以下文件：

```text
codex-everywhere-web-<tag>.tar.gz
codex-everywhere-agent-<tag>.tar.gz
codex-everywhere-relay-<tag>.tar.gz
codex-everywhere-hpc-tools-<tag>.tar.gz
manifest.json
SHA256SUMS
```

在受控操作机或部署账号下创建仓库外临时目录并下载全部制品：

```bash
umask 077
CE_ASSET_DIR=$(mktemp -d "${TMPDIR:-/tmp}/ce-assets.XXXXXX")
chmod 0700 "$CE_ASSET_DIR"
gh release download <tag> --repo <owner/repository> --dir "$CE_ASSET_DIR"
(cd "$CE_ASSET_DIR" && sha256sum -c SHA256SUMS)
```

读取 manifest 中的 commit，并对 `SHA256SUMS`、manifest 和每个 tarball 验证 GitHub provenance：

```bash
CE_RELEASE_COMMIT=$(node -e '
  const fs = require("fs");
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!/^[0-9a-f]{40}$/.test(manifest.commit)) process.exit(1);
  process.stdout.write(manifest.commit);
' "$CE_ASSET_DIR/manifest.json")

for CE_ASSET in "$CE_ASSET_DIR"/SHA256SUMS \
  "$CE_ASSET_DIR"/manifest.json "$CE_ASSET_DIR"/*.tar.gz
do
  gh attestation verify "$CE_ASSET" \
    --repo <owner/repository> \
    --signer-workflow <owner/repository>/.github/workflows/release.yml \
    --source-ref refs/tags/<tag> \
    --source-digest "$CE_RELEASE_COMMIT" \
    --deny-self-hosted-runners
done
```

production 还必须把 manifest 与 staging 批准值对账：

```bash
CE_MANIFEST_SHA256=$(sha256sum "$CE_ASSET_DIR/manifest.json" | awk '{print $1}')
test "$CE_MANIFEST_SHA256" = '<approvedManifestSha256>'
```

如果安装机的 GitHub CLI 不支持上述全部约束，不能放宽验证；Agent 安装改用 staging 批准的 manifest SHA-256 作为独立信任根。解压前拒绝绝对路径和 `..`：

```bash
if tar -tzf "$CE_ASSET_DIR/codex-everywhere-hpc-tools-<tag>.tar.gz" \
  | grep -Eq '(^/|(^|/)\.\.(/|$))'
then
  echo 'unsafe release archive' >&2
  exit 1
fi
```

任何将由 root 执行的 HPC 工具必须先从已验证的 archive 解压到 root 拥有、非组/全局可写的版本目录；禁止 `sudo` 执行部署账号或源码 checkout 中可修改的脚本。

### 5.1 无法直连 GitHub 的 HPC

联网操作机必须先按上一节完成全部 checksum 和 provenance 验证，再通过站点批准的 SSH/SCP 通道原样传输六个 Release 文件。HPC 上的交接目录应为仓库和业务状态目录之外的 `0700` 目录，并由 `<deployUser>` 拥有；传输后先重新执行 `sha256sum -c SHA256SUMS`，再把 manifest 摘要与批准值对账。不能把“通过 SSH 传输”本身当作 Release 身份证明。

alpha.13 及以后可以让同一个安装器从该目录读取，不需要 HPC 访问 GitHub：

```bash
sudo -iu <deployUser> env \
  CE_RELEASE_ASSET_DIRECTORY=<absoluteTransferredAssetDirectory> \
  <root-owned-hpc-tools>/install-release.sh \
  <tag> <owner/repository> <rootlessRoot> <rootlessRoot>/runtime \
  <approvedManifestSha256>
```

本地目录模式只接受普通文件，不接受 symlink；安装器会把文件复制到私有临时目录，并重新验证批准的 manifest 摘要、`SHA256SUMS`、Agent 大小和摘要、manifest/build identity、归档路径以及安装后的完整 inventory。`<root-owned-hpc-tools>` 仍必须来自同一个已验证的 HPC tools archive：先把 archive 复制到 root-owned 路径并再次核对摘要，再检查归档路径、解压、`chown -R root:root` 和 `chmod -R go-w`。不得让 root 直接执行交接目录中的脚本。

如果只在 bootstrap 时借助 SSH/FRP 提供临时出网，应把代理绑定在 HPC 的 loopback，并只注入该次安装命令：

```bash
ssh -R 127.0.0.1:<remoteProxyPort>:127.0.0.1:<localProxyPort> <host> \
  'sudo env -i HOME=<rootCondaRoot>/conda-home PATH=/usr/bin:/bin \
    HTTP_PROXY=http://127.0.0.1:<remoteProxyPort> \
    HTTPS_PROXY=http://127.0.0.1:<remoteProxyPort> \
    <root-owned-hpc-tools>/create-shared-runtime.sh \
    <rootCondaRoot>/miniforge3/bin/conda <privilegedRoot>/runtime'
```

该代理不得写入 CE、用户 home、Relay 或浏览器配置；SSH 会话结束即撤销监听。若本地代理、远端端口或站点策略不明确，停止并由管理员提供批准的传输方式。

## 6. 首次安装多用户 HPC

### 6.1 准备运行时和 rootless release

按站点规则准备一个专用、无 sudo 的部署账号。它不是 Codex 用户，也不拥有任何用户的 `~/.codex`。以该账号创建 Node.js 20.20/tmux runtime：

```bash
sudo -iu <deployUser> <root-owned-hpc-tools>/create-rootless-runtime.sh \
  <conda-binary> <rootlessRoot>/runtime
```

安装经过验证的 Agent release；第五个参数是 staging 批准的 manifest SHA-256：

```bash
sudo -iu <deployUser> <root-owned-hpc-tools>/install-release.sh \
  <tag> <owner/repository> <rootlessRoot> <rootlessRoot>/runtime \
  <approvedManifestSha256>
```

staging 如果没有已批准摘要，可以让安装器使用具备完整 identity constraint 的 GitHub attestation；production 必须传入已批准摘要。

### 6.2 安装 root-owned CLI（启用 Controller 时必须）

root-owned runtime 不能复用或直接执行 `<deployUser>`、普通用户或源码 checkout 中可写的 Conda/Node.js。站点已经提供 root-owned、目录链不可写且兼容 glibc 2.17 的 Conda 时可以直接使用；否则先按以下步骤安装独立 Miniforge。

先确认架构和 glibc。Miniforge 的[官方兼容性与安装说明](https://github.com/conda-forge/miniforge#requirements-and-installers)是唯一允许的下载入口；交接清单必须固定具体 release tag、完整 asset 名和预期 SHA-256，禁止使用 `latest` 重定向：

```bash
uname -m
getconf GNU_LIBC_VERSION

umask 077
CE_MINIFORGE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/ce-miniforge.XXXXXX")
chmod 0700 "$CE_MINIFORGE_DIR"

gh release download <miniforgeTag> \
  --repo conda-forge/miniforge \
  --dir "$CE_MINIFORGE_DIR" \
  --pattern '<miniforgeAsset>' \
  --pattern '<miniforgeAsset>.sha256'

(cd "$CE_MINIFORGE_DIR" && sha256sum -c '<miniforgeAsset>.sha256')
printf '%s  %s\n' '<miniforgeSha256>' \
  "$CE_MINIFORGE_DIR/<miniforgeAsset>" | sha256sum -c -
```

官方 `.sha256` 文件与交接清单中的独立固定摘要必须同时匹配。然后把安装器复制到 root-owned、非组/全局可写的路径，并在复制后以 root 再校验一次；不得通过 `sudo bash "$CE_MINIFORGE_DIR/..."` 直接执行操作账号可写文件：

```bash
sudo install -d -o root -g root -m 0755 <rootCondaRoot>
sudo install -d -o root -g root -m 0700 <rootCondaRoot>/conda-home
sudo install -o root -g root -m 0700 \
  "$CE_MINIFORGE_DIR/<miniforgeAsset>" \
  <rootCondaRoot>/<miniforgeAsset>

printf '%s  %s\n' '<miniforgeSha256>' \
  '<rootCondaRoot>/<miniforgeAsset>' | sudo sha256sum -c -

sudo env -i HOME=<rootCondaRoot>/conda-home PATH=/usr/bin:/bin \
  /bin/bash <rootCondaRoot>/<miniforgeAsset> \
  -b -p <rootCondaRoot>/miniforge3

sudo chown -R root:root <rootCondaRoot>/miniforge3
sudo chmod -R go-w <rootCondaRoot>/miniforge3
sudo <rootCondaRoot>/miniforge3/bin/conda --version
```

安装器和 Miniforge 根目录都不是业务状态，可以作为本次部署的供应链审计材料保留；不得放入用户 home、rootless release 或公开日志。runtime 创建器会用 `--override-channels --channel conda-forge` 忽略继承的 channel 列表，避免 root 或站点 `.condarc` 混入无关来源。随后使用隔离的 root-owned home 创建独立 runtime，再从已经验证并带 inventory 的 rootless release 复制同一 CE tag：

```bash
sudo env -i HOME=<rootCondaRoot>/conda-home PATH=/usr/bin:/bin \
  <root-owned-hpc-tools>/create-shared-runtime.sh \
  <rootCondaRoot>/miniforge3/bin/conda <privilegedRoot>/runtime

sudo <root-owned-hpc-tools>/install-shared-agent.sh \
  <rootlessRoot>/releases/<tag> <tag> \
  <privilegedRoot> <privilegedRoot>/runtime verified
```

最后安装双路全局启动器：

```bash
sudo <root-owned-hpc-tools>/install-rootless-global-shim.sh \
  <rootlessRoot> <deployUser> <privilegedRoot>/bin/ce
```

立即验证非 root 与 root 都报告同一版本。若 root 进入了 `<rootlessRoot>`，或两个版本不同，停止部署。

不启用 Controller 时省略 privileged release，并执行：

```bash
sudo <root-owned-hpc-tools>/install-rootless-global-shim.sh \
  <rootlessRoot> <deployUser>
```

此模式下 root 调用 `ce` 必须失败关闭。

### 6.3 Relay 与 provisioner

Relay 使用独立服务账号、独立 `CE_RELAY_HOME` 和稳定 `installationId`。首次执行 `ce-relay init` 创建签名密钥；升级绝不能重新初始化或轮换该密钥。systemd 模板中的 `__INSTALLATION_ID__`、用户、路径和监听地址必须在启用前替换并核对：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now codex-everywhere-relay
sudo systemctl status codex-everywhere-relay
```

在 Relay 运维身份下签发 host provisioner credential，并通过受限文件或标准输入交给部署账号；不要把 JSON 输出交给对话 Agent：

```bash
ce-relay issue-provisioner \
  --installation-id <installationId> \
  --expires-days <days>
```

部署账号安装并启动 rootless provisioner：

```bash
sudo -iu <deployUser> /usr/local/bin/ce provisioner install \
  --origin <pwaOrigin> \
  --relay-endpoint <relayEndpoint> \
  --credential-stdin < <private-credential-file>
sudo -iu <deployUser> /usr/local/bin/ce provisioner install-service
sudo -iu <deployUser> /usr/local/bin/ce provisioner status
```

credential 到期前至少 30 天按相同 `installationId` 续签并重新执行 `provisioner install`；不得借此更换 installation 或用户 route。

### 6.4 Administrator Controller

Controller 运行账号必须是现有非 root Unix 账号。root 执行安装，root-owned CLI 会创建受限 helper、sudoers 和 cron：

```bash
sudo /usr/local/bin/ce admin install-controller \
  <controllerUser> --handle <admin-handle>
```

按命令输出的 `CE_ADMIN_HOME`，以 Controller 账号生成一次性配对资料：

```bash
sudo -iu <controllerUser> env CE_ADMIN_HOME=<controller-home> \
  /usr/local/bin/ce admin web pair
```

配对资料不得进入日志或交给 Agent。操作者本人在 `<pwaOrigin>/admin` 完成首次 Passkey/CE 密码注册并离线保存恢复码。随后验证：

```bash
sudo -iu <controllerUser> env CE_ADMIN_HOME=<controller-home> \
  /usr/local/bin/ce admin web status
```

### 6.5 普通用户初始化

CE 只接受已有、符合站点 SSH 策略的 NSS 用户；不得由 CE 创建、修改或复用系统账号。管理员可只读检查：

```bash
sudo /usr/local/bin/ce admin inspect-user <username>
```

每位用户自行执行 `ce device pair`，在浏览器注册自己的 CE Web 身份，再通过 PWA 的官方 Codex 设备码流程登录自己的订阅。管理员不能代替用户登录 Codex，也不能接收用户恢复码。

### 6.6 Web、Direct 与 FRP

Web tarball 解压到 `<webRoot>/releases/<tag>/web`，检查 `build-info.json`、`index.html`、CSP 和所有者后，用临时软链接加 `mv -T` 原子更新 `<webRoot>/current`。Nginx 永远指向 `current`；执行 `nginx -t` 成功后才 reload。

Passkey Origin 必须是稳定 HTTPS Origin。Direct/FRP 将每个 Agent 的 loopback 端口映射到对应 WSS 入口，但不能改变浏览器看到的 Origin，也不能把 Agent 监听端口直接暴露为明文公网服务。至少验证：

- `/.well-known/codex-everywhere` 可达；
- `/gateway` 能完成 WebSocket upgrade；
- `/relay` 只连接无状态 Relay；
- TLS 证书、SNI、`X-Forwarded-Proto` 和 WebSocket timeout 正确；
- Direct 与 Relay 都能打开同一任务，Relay 日志不含解密 payload。

## 7. 普通补丁升级

补丁升级不迁移状态，但仍必须保留回滚 release。推荐顺序：

1. 完成第 4、5 节预检，确认旧 tag 的 rootless/privileged/Web/Relay 目录和 inventory 可用；
2. 在维护窗口安装新的 rootless release；这会原子切换 `<rootlessRoot>/current`；
3. 启用 Controller 时，从新的 verified rootless release 安装同 tag 的 privileged release，并重新安装双路启动器；
4. 重启 rootless provisioner，并检查 credential/descriptor；
5. 逐用户停止并启动 Agent，确认健康 app-server 未被停止；
6. 重启 Administrator Controller，确认 root/non-root CLI 仍是同一 tag；
7. Relay wire 兼容时独立切换 Relay，并保留签名密钥、installation ID 和 route；
8. 最后原子切换 Web；检查旧页面能明确提示更新，Service Worker 不丢失 outcome-unknown mutation；
9. 完成 Direct、Relay、任务打开、审批和 Queue smoke test。

服务命令：

```bash
sudo -iu <deployUser> /usr/local/bin/ce provisioner stop
sudo -iu <deployUser> /usr/local/bin/ce provisioner install-service
sudo -iu <deployUser> /usr/local/bin/ce provisioner status

sudo -iu <username> /usr/local/bin/ce agent stop
sudo -iu <username> /usr/local/bin/ce agent start
sudo -iu <username> /usr/local/bin/ce agent status
sudo -iu <username> /usr/local/bin/ce app-server status

sudo -iu <controllerUser> env CE_ADMIN_HOME=<controller-home> \
  /usr/local/bin/ce admin web restart
```

如果 Release 说明包含跨进程权限协调或锁格式变化，升级前已经运行的 `ce tui` 必须在 Agent 重启后退出并重新连接；退出 TUI 不会中断 app-server 中的 turn。

## 8. v0.3 → v0.4 全新切换

v0.4 不提供 v0.3 状态迁移器，也不允许旧库被新二进制隐式升级。切换会重建 CE 自有的 Web 身份、可信设备、Workspace 登记、偏好、权限和 Queue；不删除、移动或改写 `~/.codex`，也不停止健康的 Codex app-server。任务历史仍以 app-server 为权威来源。

切换前：

1. 保留 alpha.14 的 verified rootless/privileged/Web/Relay 目录、manifest SHA-256 和 inventory；
2. 确认浏览器、Agent 宿主机和 Relay 时钟偏差不超过 30 秒；
3. 等待 turn、interaction、Queue delivery、mutation 和登录流程静止；
4. 停止用户 Agent 和 Controller，但保持健康 app-server；
5. 将每个用户完整的 `~/.codex-everywhere` 原子改名为不存在的带时间戳保留目录，权限保持 0700；不得覆盖旧保留目录；
6. 对已存在的 Controller 同样保留其 `CE_ADMIN_HOME`；本次未安装 Controller 时跳过；
7. 切换 v0.4 rootless/privileged release；在任何用户配对前停止 rootless provisioner，确认请求目录为空，将 `<deployHome>/.codex-everywhere-provisioner/admin-state.sqlite` 精确改名为带时间戳的 0600 保留文件；root-owned fallback 的 `/etc/codex-everywhere/admin-state.sqlite` 若存在也由 root 同样处理；
8. 保留 provisioner `config.json`、credential 和 `keys/`，用 v0.4 重新执行 `provisioner install-service/status`；新 admin 库必须为 application ID `0x43454134`、`user_version = 1` 和 0600；
9. 原子切换 Web，随后才允许用户执行 `ce device pair`。若出现 `Host provisioning state is incompatible with this release`，停止配对并复核第 7、8 步。

示例（占位符和时间戳必须先确认）：

```bash
sudo -iu <username> /usr/local/bin/ce agent stop
sudo -iu <username> sh -eu -c '
  retained="$HOME/.codex-everywhere.v0.3-retained.<UTC-timestamp>"
  test -d "$HOME/.codex-everywhere"
  test ! -e "$retained"
  mv "$HOME/.codex-everywhere" "$retained"
  chmod 0700 "$retained"
'
sudo -iu <username> /usr/local/bin/ce device pair
```

`ce device pair` 通过 rootless provisioner 创建新的 v0.4 Host 配置和 Relay route。操作者在 PWA 中完成新设备配对、Passkey/CE 密码与恢复码保存，然后重新添加 Workspace 并启动 Agent。旧 Host Profile、CE 恢复码和 Queue 不得继续使用。

任何用户初始化失败都停止整轮切换，不让共享 Web 长期服务于混合 Gateway v1/v2 Agent。旧 CE 目录在观察窗结束前只读保留，不导入 v0.4，也不输出到日志或 JSON。

## 9. 回滚

### 9.1 普通补丁回滚

先停止对应服务，再从本地已安装且 inventory 完整的旧 release 原子切回：

```bash
sudo -iu <deployUser> <root-owned-hpc-tools>/activate-rootless-release.sh \
  <old-tag> <rootlessRoot> <rootlessRoot>/runtime

sudo <root-owned-hpc-tools>/activate-shared-release.sh \
  <old-tag> <privilegedRoot> <privilegedRoot>/runtime

sudo <root-owned-hpc-tools>/install-rootless-global-shim.sh \
  <rootlessRoot> <deployUser> <privilegedRoot>/bin/ce
```

随后恢复旧 Web/Relay 原子指针，按第 7 节重启并 smoke test。inventory 失败时禁止回滚到该目录，应重新从可信 Release 安装。

### 9.2 v0.4 切换失败后恢复 alpha.14

没有数据反向迁移。只能在旧 CE 保留目录仍完整时，先停止 v0.4 Agent/Controller，将新 v0.4 CE 目录改名留存，再把原 v0.3 目录原子改回 `~/.codex-everywhere`，最后切回 alpha.14 制品并启动服务。回复时不得合并两个目录、不得让 alpha.14 打开 v0.4 数据库，也不得把 v0.4 Queue 复制回旧库。v0.4 切换后新产生的 CE 身份、Workspace、Queue 和偏好不会出现在 alpha.14 中。

## 10. 验收和交付记录

Agent 完成后应向操作者报告：

- environment、目标 tag、完整 commit 和 manifest SHA-256；
- rootless、privileged、Web、Relay 当前 tag 是否一致；
- provisioner、Controller、各用户 Agent 和 app-server 是否健康；
- Direct/Relay、桌面/移动端、任务打开、interaction 和 Queue smoke 是否通过；
- 是否发生回滚，哪些旧 CE 保留目录仍在观察窗内；
- 仍需用户亲自完成的 Passkey、恢复码保存或 Codex 设备码登录。

不要报告真实 prompt、Queue 文本、文件/Workspace 内容、数据库、恢复码、Passkey 数据、capability 或凭据。旧 CE 保留目录只有在观察窗结束、production 被明确接受且操作者再次确认后才能按精确路径删除；Agent 不得自动删除。
