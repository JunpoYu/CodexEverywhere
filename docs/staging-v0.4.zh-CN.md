# CodexEverywhere v0.4 staging 验收手册

本文档把 `v0.4.0-alpha.1` 上线前仍需真实基础设施的门槛转换为可执行流程和严格 receipt。目标不是收集业务日志，而是证明同一候选 commit、同一 Release manifest 和至少两个测试用户完成了升级、业务验证和回滚。

## 1. 安全边界

- 只使用非生产测试用户和专用 staging Codex 登录；不得复制生产数据库。
- candidate receipt 和 staging receipt 必须位于源码仓库、Issue、CI artifact 和公开日志之外，权限为 0600。
- receipt 只能保存版本、commit、受限 operator alias、布尔结果和 SHA-256；不得保存主机名、Unix 用户名、真实路径、prompt、Queue 文本、恢复码或日志正文。
- 数据库备份、migration receipt 和 Agent 日志始终留在对应宿主机。只把其 SHA-256 写入 staging receipt。
- 整轮演练结束且回滚窗口关闭前禁止执行 `migration-finalize`。

## 2. 需要准备的真实环境

开始前需要准备：

1. 一台符合首个目标的 CentOS 7、glibc 2.17、Node.js 20 staging 宿主机；
2. 至少两个可通过 NSS 查询、具有 home/shell 且可按现有 SSH 策略登录的非生产 Linux 用户；
3. 一个隔离的 Administrator Controller 和管理员 Web 身份；
4. 可用的 Direct HTTPS/WSS 入口和无状态 Relay route；
5. 桌面浏览器与 390px 移动端浏览器或等价真实设备；
6. staging 专用 Codex 订阅登录；
7. 可原子切换且已验证的 v0.3 maintenance 与 v0.4 Release 制品。

不要把 SSH/Linux 密码、Codex 凭据、Passkey 私钥或 Relay 私钥交给自动化脚本。

开始迁移前还必须确认浏览器、Agent 宿主机与 Relay 的 UTC 时钟均由健康的 NTP 源同步，任意两者的实测偏差不超过 30 秒。CentOS 7 至少检查 `timedatectl status`、`chronyc tracking` 和 `chronyc sources`：不能只看到 `chronyd` 进程存活，还要确认最近参考时间持续更新、Leap status 正常且没有陈旧的唯一上游。可从操作机在一次 SSH 往返中读取远端 `date -u +%s`，以往返中点估算偏差。修复时间源后才能将 `environment.clock-synchronized` 标记为 `true`。

## 3. 候选 commit 自动门禁

在干净 checkout 中安装依赖、Playwright Chromium 和本机 Codex CLI，然后运行：

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
umask 077
CE_STAGING_EVIDENCE_DIR="${XDG_STATE_HOME:-${HOME}/.local/state}/codex-everywhere-staging"
mkdir -p "${CE_STAGING_EVIDENCE_DIR}"
chmod 0700 "${CE_STAGING_EVIDENCE_DIR}"
pnpm verify:v0.4 -- \
  --with-model \
  --receipt "${CE_STAGING_EVIDENCE_DIR}/candidate.json"
sha256sum "${CE_STAGING_EVIDENCE_DIR}/candidate.json"
```

该命令依次执行公开仓库检查、格式、架构、本地 listener 能力、类型、unit/protocol/migration、构建、Web bundle 预算、Playwright、真实 app-server contract、部署脚本语法和 diff 检查。命令输出不会写入 receipt；receipt 只记录每项状态和耗时。完整验证必须允许测试进程绑定 loopback TCP 和 Unix socket；受限沙箱会在测试前明确失败，不能用跳过 socket 测试代替。

默认拒绝脏工作区。`--allow-dirty` 仅用于开发中的本地复核，生成的 receipt 会标记 `dirty: true`，不能用于发布。没有 `--with-model` 时 app-server 无模型合同仍会运行，但 receipt 会保留 `subscription-model-integration` 外部门槛。

## 4. 初始化 staging receipt

```bash
pnpm staging:receipt -- init "${CE_STAGING_EVIDENCE_DIR}/staging.json"
```

初始化文件为 0600，全部检查默认为 `false`。填写时：

- `operatorAlias` 只能使用不指向真实身份的短 alias；
- `testUserCount` 至少为 2，`adminControlPlane` 必须为 `true`；
- `manifestSha256` 来自本轮实际消费的 Release manifest；
- `candidateReceiptSha256` 来自上一节 candidate receipt；
- `sourceBackupSha256s` 至少包含每个测试用户和管理员库的源备份摘要；
- 三组 migration receipt SHA-256 分别对应首次正向、反向和第二次正向迁移，每组至少包含每个测试用户和管理员库；
- 只有完成对应步骤后才能把 `checks` 中的布尔值改为 `true`；不得新增自由文本字段。

## 5. 首次正向迁移

1. 在 v0.3 maintenance 上验证两个用户分别能够登录、读取任务、读取 Queue/Workspace，并确认恢复入口有效。
2. 退出所有 Side，等待 turn、interaction、Queue delivery、mutation 和登录流程全部结束。
3. 分别以每个测试用户身份执行：

   ```bash
   ce agent stop
   ce upgrade preflight --to v0.4
   ce state migrate --to v0.4 --dry-run
   ce state migrate --to v0.4
   ```

4. 单独停止 Administrator Controller，对管理员库执行相同命令并添加 `--admin`。
5. 核对输出中的备份 SHA-256、owner、0600 mode、receipt 和领域计数，再原子切换 v0.4 制品。
6. 启动 v0.4 Agent/Controller；健康 app-server 不应因程序切换被终止。

任何 preflight、dry-run、计数、owner、mode 或 SHA-256 不一致都必须停止演练，不能通过人工修改数据库继续。

## 6. v0.4 业务与故障场景

两个用户必须分别验证 Direct 和 Relay，桌面与 390px 移动端至少各覆盖一轮，并完成 receipt 中的全部检查。重点包括：

- 首次设备、已保存设备和临时设备；Passkey、CE 密码和恢复码；
- 全新安装引导与已 ready 用户；任务 idle、流式 running、waiting-input、审批竞争、用户问答、MCP、interrupt 和 TUI 接力；
- 浏览器断线、Agent 重启和 app-server 重启后的权威 `thread/open` 恢复；
- Queue add/remove/Steer，以及结果未知后的明确 acknowledge；
- outcome-unknown 时 PWA 只提示更新，v1/v2 不匹配时明确阻断；
- 管理端 inspect、disable/enable、恢复交接、移除计划与审计；
- 两个用户之间的任务、Workspace、Queue、身份和运行状态不可互见；管理员页面不得出现用户业务数据。

Queue 精确 crash window 由同 commit 的确定性自动化测试覆盖；staging 还必须在存在 Queue 工作时重启一次 Agent，确认没有重复投递。只有 candidate receipt 通过且 staging 重启未重复，才能勾选 `queue.crash-indeterminate-acknowledge`。

日志检查只记录“未发现敏感字段”这一布尔结论。不要把日志正文粘贴进 receipt、仓库或 Issue。

## 7. 反向迁移和制品回滚

在 v0.4 写入可由 v0.3 表达的 Workspace、偏好、权限、认证和 Queue 变化。不要使用自定义 Workspace label、非 `system` 主题、非 `zh-CN` locale、pending/indeterminate mutation 或其他 v0.3 无法表达的数据作为回滚样本。

1. 等待所有 lease idle，并确认没有 delivering Queue、pending mutation 或登录流程；
2. 停止 v0.4 Agent/Controller；
3. 每个用户与管理员库分别运行反向 `--dry-run` 和正式迁移；
4. 原子切回同一轮已验证的 v0.3 maintenance 制品；
5. 验证登录、Workspace、偏好、权限、Queue rollback barrier 和可表达审计；
6. 再次停止服务，重复正向 preflight、dry-run 和正式迁移，切回 v0.4；
7. 确认所有源备份仍存在，不执行 finalize。

完整迁移错误处理见 [v0.4 迁移手册](migration-v0.4.zh-CN.md)。

## 8. 验证 receipt

完成所有字段后，把 `completedAt` 设置为规范 UTC ISO 时间，把 `status` 改为 `passed`，再执行：

```bash
chmod 0600 "${CE_STAGING_EVIDENCE_DIR}/staging.json"
pnpm staging:receipt -- validate "${CE_STAGING_EVIDENCE_DIR}/staging.json"
sha256sum "${CE_STAGING_EVIDENCE_DIR}/staging.json"
```

校验器会拒绝：检查项缺失或为 false、少于两个用户、缺少管理员、错误的目标 OS/Node/glibc、重复或非法 hash、未知字段、自由文本扩展、非规范时间、符号链接和非 0600 文件。

只有 candidate receipt 与 staging receipt 都通过，并且 GitHub CI 对同一 commit 为绿色，才允许创建 `v0.4.0-alpha.1` tag。首次发布仍应只开放给少量测试用户；观察窗口结束后再扩大范围和 finalize 备份。
