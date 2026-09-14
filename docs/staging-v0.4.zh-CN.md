# CodexEverywhere v0.4 staging 验收手册

本文把 `v0.4.0-alpha.18` 上线前仍需真实基础设施的单用户门槛转换为可执行流程和严格 receipt。v0.4 采用全新初始化，不进行 v0.3 数据库正向或反向迁移。多用户并发、跨用户隔离和 Administrator Controller 的实机验收延后，不阻塞当前单用户版本。

## alpha.18 补丁验收范围

alpha.17 → alpha.18 不迁移数据库，用户库保持 schema 2。本次使用 alpha.17 作为回退制品：在隔离的测试用户状态目录中验证同一 schema-2 数据库可依次由 alpha.17、alpha.18、alpha.17、alpha.18 打开，数据与权限不变；记录目标制品 manifest 摘要。手机端验证配置折叠、展开设置和触控发送，部署后检查 Web 静态资源、Service Worker、Relay 与原 app-server 健康状态。下文 schema 1→2 及加密数据库恢复步骤仅适用于仍从 alpha.16 升级的环境；不得为 alpha.18 的无迁移补丁伪造 schema 1→2 检查通过记录。

本路径使用 `pnpm staging:receipt -- init-patch <仓库外 receipt.json>` 创建专用 version-2 补丁记录，再用 `pnpm staging:receipt -- validate <receipt.json>` 验证。它只接受 alpha.17/schema 2 → alpha.18/schema 2，要求制品校验、同库升级/回退/再激活、生产状态未触碰及同一 candidate 的桌面/手机检查证据。补丁演练可由现有用户在独立的 `CE_HOME`、`CE_RUNTIME_DIR` 中使用测试数据执行，不启动或连接生产 app-server；它不声称全新账号、Direct 或 schema 1 迁移已完成实机验收。以下完整初始化环境要求适用于原 `init` 路径，不能混用两种记录的检查项。

## 1. alpha.17 → alpha.18 补丁执行步骤

1. 在目标 main commit 完成 `pnpm verify:v0.4 -- --with-model --receipt <仓库外 candidate.json>`，确认同 commit 的 CI 与代码审查通过，记录 candidate 文件 SHA-256。
2. 下载该 commit 的不可变 alpha.18 Release，验证 SHA256SUMS、manifest 和 provenance 的 workflow/tag/commit；保留 verified alpha.17 回退制品。检查 CentOS 7、glibc 2.17、Node.js 20 与宿主机时钟。
3. 创建专用补丁记录：

   ```bash
   pnpm staging:receipt -- init-patch /absolute/private/staging-alpha18.json
   ```

4. 在独立 `CE_HOME`、`CE_RUNTIME_DIR` 中以 alpha.17 创建测试数据，依次使用 alpha.18、alpha.17、alpha.18 的真实制品打开同一状态目录。每次验证 schema 2、SQLite integrity、所有者、0600 权限、身份及工作区/旁支测试数据不变；不触碰生产状态，不连接生产 app-server。
5. 将已完成的证据写入补丁记录：`operatorAlias` 使用匿名短名，`environment.testUserCount` 至少 1，`evidence` 填实际 manifest 和 candidate 文件的 SHA-256。逐项确认 `checks` 后设为 true，填写规范 ISO `completedAt` 和 `status: "passed"`。禁止填写未执行的 schema 1 迁移、Direct 或全新账号验收项。
6. 验证记录并部署同一组字节：

   ```bash
   chmod 0600 /absolute/private/staging-alpha18.json
   pnpm staging:receipt -- validate /absolute/private/staging-alpha18.json
   ```

   通过后按操作手册切换 alpha.18，检查 Agent、Relay、Web、Service Worker 和原 app-server 健康。需要回退时停止 CE 写入、切回 alpha.17 制品并重启 CE 服务；本路径不恢复数据库。保留回退制品与验收记录。

## 附录：完整初始化与 schema 1 迁移验收

以下 A1–A8 仅用于完整初始化或从 alpha.16 开始的 schema 1 迁移，使用 version-1 完整记录。已经运行 alpha.17 的本次补丁只执行上面的步骤 1–6，不执行下面的 `init` 命令，也不复制这些检查结果到补丁记录。

## A1. 安全边界

- 使用一个非生产测试用户和 staging 专用 Codex 登录，不复制生产数据库。
- candidate receipt 与 staging receipt 位于源码仓库、Issue、CI artifact 和公开日志之外，权限为 0600。
- receipt 只保存版本、commit、受限 operator alias、布尔结果和 SHA-256；不保存主机名、Unix 用户名、真实路径、prompt、Queue 文本、恢复码或日志正文。
- 旧 CE 目录只在对应宿主机改名保留，不导入 v0.4，也不写入 receipt。
- `~/.codex`、Codex 登录和 app-server 任务不属于 CE 状态重建范围。

## A2. 真实环境

开始前需要：

1. CentOS 7、glibc 2.17、Node.js 20 staging 宿主机；
2. 一个符合 NSS/SSH 策略的非生产 Unix 用户；
3. Administrator Controller 可选，不属于当前 staging 硬门槛；
4. Direct HTTPS/WSS 入口和无状态 Relay；
5. 桌面与 390px 移动端浏览器；
6. staging 专用 Codex 订阅登录；
7. verified `v0.4.0-alpha.17` 回退制品与目标 `v0.4.0-alpha.18` Release 制品，可原子切换 release 指针。

浏览器、Agent 宿主机与 Relay 必须使用健康时间源，任意两者实测 UTC 偏差不超过 30 秒。CentOS 7 检查 `timedatectl status`、`chronyc tracking` 和 `chronyc sources`；不能只依据 `chronyd` 进程存在。

## A3. candidate 自动门禁

在干净 checkout 中运行：

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm exec playwright install --only-shell chromium
umask 077
CE_STAGING_EVIDENCE_DIR="${XDG_STATE_HOME:-${HOME}/.local/state}/codex-everywhere-staging"
mkdir -p "${CE_STAGING_EVIDENCE_DIR}"
chmod 0700 "${CE_STAGING_EVIDENCE_DIR}"
pnpm verify:v0.4 -- \
  --with-model \
  --receipt "${CE_STAGING_EVIDENCE_DIR}/candidate.json"
sha256sum "${CE_STAGING_EVIDENCE_DIR}/candidate.json"
```

该命令依次执行公开仓库检查、格式、架构、本地 listener 能力、类型、unit/protocol、构建、Web bundle 预算、Playwright、真实 app-server contract、部署脚本语法和 diff 检查。`--allow-dirty` 只用于开发核对；生成的 receipt 不能作为发布证据。未使用 `--with-model` 时会保留订阅模型外部门槛。

## A4. 完整初始化记录（不适用于本次 alpha.18 补丁路径）

```bash
pnpm staging:receipt -- init "${CE_STAGING_EVIDENCE_DIR}/staging.json"
```

填写规则：

- `operatorAlias` 使用不指向真实身份的短 alias；
- `testUserCount` 至少为 1；`adminControlPlane` 必须是布尔值，但允许为 `false`；
- `manifestSha256` 来自实际消费的 Release；
- `candidateReceiptSha256` 来自上一节 candidate receipt；
- 只有完成对应步骤后才把 `checks` 设为 `true`，不得新增自由文本字段。

## A5. alpha.16 → alpha.17 数据库升级演练（仅从 alpha.16 升级时必做）

全新初始化不能替代本节。只使用测试用户自己的 alpha.16 数据库，不复制生产用户状态：

1. 在 alpha.16 创建测试 CE 身份、工作区和 Queue，记录必要的布尔/计数基线及 app-server PID，不输出业务正文或秘密。
2. 按操作手册暂停该用户 CE watchdog、Agent 与 TUI 写入，保持 app-server 运行。加密备份 schema-1 数据库，验证可解密、SQLite integrity check 与 `user_version = 1`。
3. 使用已验证的 alpha.17 Release 制品启动同一测试用户、同一个 CE 状态目录，不能隔离旧目录后重新初始化。确认 schema 升级为 2，原身份、工作区和 Queue 保留，创建/收起/删除旁支正常，app-server PID 未变。
4. 暂停 CE 写入，保留 schema-2 数据库的加密副本；按操作手册原子恢复升级前 schema-1 备份，再切回 alpha.16 制品。验证旧身份、工作区和 Queue 可用。
5. 再次暂停 CE 写入，保留旧库后原子恢复刚才留存的 schema-2 数据库，切回同一 alpha.17 制品，验证身份、工作区、Queue 和旁支元数据一致。两份数据库不得合并，`~/.codex` 不得恢复或清理。
6. 分别完成后才能设置 `upgrade.schema-1-backup-verified`、`upgrade.schema-1-to-2`、`upgrade.schema-1-rollback-restored`、`upgrade.schema-2-reactivated` 为 true。receipt 校验器将拒绝缺少或未完成这些检查的记录。

### A5.1 v0.3 → v0.4 全新初始化演练

下面保留跨协议代际的全新初始化检查；它不能作为上方 schema 1 → 2 升级的证据。

对测试用户：

1. 在 `v0.4.0-alpha.16` 记录 app-server PID 和健康状态；
2. 确认 turn、interaction、Queue delivery、mutation 与登录流程静止；
3. 停止 Agent，但保持 app-server；
4. 将完整 `~/.codex-everywhere` 改名为唯一的保留目录；
5. 切换 v0.4 rootless/privileged release 与 Web；
6. 运行 `ce device pair`，重新注册 Web 身份与恢复码；
7. 重新添加 Workspace 并启动 Agent；
8. 确认 app-server PID 未变化，已有任务可从 app-server 重新打开；
9. 确认旧 CE 目录未被读取、写入或部分导入。

如果本次环境已经启用 Controller，使用独立 `CE_ADMIN_HOME` 执行同样的整目录隔离与全新安装；未启用时跳过。旧 CE 数据库、配置或 capability 不得复制进 v0.4 状态。

完成后将以下检查设为 `true`：

- `cutover.v0.3-state-retained`；
- `cutover.v0.4-state-fresh`；
- `cutover.codex-home-untouched`。

## A6. 产品与故障场景

同一测试用户依次覆盖 Direct/Relay、桌面/390px 移动端，并完成：

- 首次设备、已保存设备、临时设备；Passkey、CE 密码和恢复码；
- onboarding、任务 idle/streaming/waiting-input、审批竞争、用户问答、MCP、interrupt 和 TUI 接力；
- 浏览器断线、Agent 重启和 app-server 重启后的权威 `thread/open` 恢复；
- Queue add/remove/Steer 与结果未知 acknowledge；
- outcome-unknown 时 PWA 更新保护和 Gateway 版本不匹配提示；
- 授权 Workspace 内的正常访问，以及路径穿越、未授权 sibling root 和符号链接逃逸拒绝。

如果环境已经启用 Controller，可以额外观察 inspect、disable/enable、恢复交接、移除与审计，但这些结果不进入当前必填 receipt。多用户之间的业务隔离留到后续里程碑。

Queue crash window 由同 commit 的确定性测试覆盖；staging 还要在 Queue 工作存在时重启一次 Agent，确认没有静默重复。日志检查只记录“未发现敏感字段”的布尔结论。

## A7. 全新初始化观察窗的制品指针回滚与再激活

本步骤针对全新初始化观察窗；alpha.16 → alpha.17 的升级回退必须额外完成第 5 节数据库恢复演练，不能只切换指针：

1. 停止 v0.4 Agent/Controller；
2. 将 v0.4 CE 目录改名留存；
3. 原子恢复对应的 alpha.17 CE 保留目录；
4. 切回 alpha.17 rootless/privileged/Web 指针并验证旧状态可用；
5. 再次停止 alpha.17，将旧目录重新归档；
6. 恢复之前留存的 v0.4 CE 目录并切回同一 v0.4 Release；
7. 验证 v0.4 身份、Workspace、任务打开和 Queue 状态仍一致。

两份目录不得合并，任一旧二进制不得打开另一版本数据库。完成后设置 `cutover.artifact-rollback` 与 `cutover.v0.4-reactivation`。

## A8. 验证 receipt

填写 `completedAt` 和 `status: "passed"` 后运行：

```bash
chmod 0600 "${CE_STAGING_EVIDENCE_DIR}/staging.json"
pnpm staging:receipt -- validate "${CE_STAGING_EVIDENCE_DIR}/staging.json"
sha256sum "${CE_STAGING_EVIDENCE_DIR}/staging.json"
```

校验器拒绝检查项缺失、没有真实测试用户、`adminControlPlane` 非布尔值、错误的目标 OS/Node/glibc、非法 hash、未知字段、非规范时间、符号链接和非 0600 文件。

candidate receipt 与 GitHub CI 对同一 commit 为绿色后，才创建 alpha tag/Prerelease 冻结制品。staging 必须消费该 Release 原始制品；只有 staging receipt 通过后，才批准 production 使用同一 manifest。观察窗口结束前保留旧 CE 目录；只有操作者再次批准精确删除目标后才能清理。
