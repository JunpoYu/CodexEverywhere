# CodexEverywhere v0.4 staging 验收手册

本文把 `v0.4.0-alpha.6` 上线前仍需真实基础设施的门槛转换为可执行流程和严格 receipt。v0.4 采用全新初始化，不进行 v0.3 数据库正向或反向迁移。

## 1. 安全边界

- 使用至少两个非生产测试用户和 staging 专用 Codex 登录，不复制生产数据库。
- candidate receipt 与 staging receipt 位于源码仓库、Issue、CI artifact 和公开日志之外，权限为 0600。
- receipt 只保存版本、commit、受限 operator alias、布尔结果和 SHA-256；不保存主机名、Unix 用户名、真实路径、prompt、Queue 文本、恢复码或日志正文。
- 旧 CE 目录只在对应宿主机改名保留，不导入 v0.4，也不写入 receipt。
- `~/.codex`、Codex 登录和 app-server 任务不属于 CE 状态重建范围。

## 2. 真实环境

开始前需要：

1. CentOS 7、glibc 2.17、Node.js 20 staging 宿主机；
2. 至少两个符合 NSS/SSH 策略的非生产 Unix 用户；
3. 隔离的 Administrator Controller 与管理员 Web 身份；
4. Direct HTTPS/WSS 入口和无状态 Relay；
5. 桌面与 390px 移动端浏览器；
6. staging 专用 Codex 订阅登录；
7. verified alpha.14 与目标 v0.4 Release 制品，可原子切换 release 指针。

浏览器、Agent 宿主机与 Relay 必须使用健康时间源，任意两者实测 UTC 偏差不超过 30 秒。CentOS 7 检查 `timedatectl status`、`chronyc tracking` 和 `chronyc sources`；不能只依据 `chronyd` 进程存在。

## 3. candidate 自动门禁

在干净 checkout 中运行：

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

该命令依次执行公开仓库检查、格式、架构、本地 listener 能力、类型、unit/protocol、构建、Web bundle 预算、Playwright、真实 app-server contract、部署脚本语法和 diff 检查。`--allow-dirty` 只用于开发核对；生成的 receipt 不能作为发布证据。未使用 `--with-model` 时会保留订阅模型外部门槛。

## 4. staging receipt

```bash
pnpm staging:receipt -- init "${CE_STAGING_EVIDENCE_DIR}/staging.json"
```

填写规则：

- `operatorAlias` 使用不指向真实身份的短 alias；
- `testUserCount` 至少为 2，`adminControlPlane` 必须为 `true`；
- `manifestSha256` 来自实际消费的 Release；
- `candidateReceiptSha256` 来自上一节 candidate receipt；
- 只有完成对应步骤后才把 `checks` 设为 `true`，不得新增自由文本字段。

## 5. 全新切换演练

对每个测试用户：

1. 在 alpha.14 记录 app-server PID 和健康状态；
2. 确认 turn、interaction、Queue delivery、mutation 与登录流程静止；
3. 停止 Agent，但保持 app-server；
4. 将完整 `~/.codex-everywhere` 改名为唯一的保留目录；
5. 切换 v0.4 rootless/privileged release 与 Web；
6. 运行 `ce device pair`，重新注册 Web 身份与恢复码；
7. 重新添加 Workspace 并启动 Agent；
8. 确认 app-server PID 未变化，已有任务可从 app-server 重新打开；
9. 确认旧 CE 目录未被读取、写入或部分导入。

Controller 使用独立 `CE_ADMIN_HOME` 执行同样的整目录隔离与全新安装。旧 CE 数据库、配置或 capability 不得复制进 v0.4 状态。

完成后将以下检查设为 `true`：

- `cutover.v0.3-state-retained`；
- `cutover.v0.4-state-fresh`；
- `cutover.codex-home-untouched`。

## 6. 产品与故障场景

两个用户分别覆盖 Direct/Relay、桌面/390px 移动端，并完成：

- 首次设备、已保存设备、临时设备；Passkey、CE 密码和恢复码；
- onboarding、任务 idle/streaming/waiting-input、审批竞争、用户问答、MCP、interrupt 和 TUI 接力；
- 浏览器断线、Agent 重启和 app-server 重启后的权威 `thread/open` 恢复；
- Queue add/remove/Steer 与结果未知 acknowledge；
- outcome-unknown 时 PWA 更新保护和 Gateway 版本不匹配提示；
- 管理端 inspect、disable/enable、恢复交接、移除与审计；
- 两个用户之间的任务、Workspace、Queue、身份和运行状态不可互见；管理员看不到用户业务数据。

Queue crash window 由同 commit 的确定性测试覆盖；staging 还要在 Queue 工作存在时重启一次 Agent，确认没有静默重复。日志检查只记录“未发现敏感字段”的布尔结论。

## 7. 制品指针回滚与再激活

本步骤只验证部署制品和观察窗口恢复路径，不转换数据：

1. 停止 v0.4 Agent/Controller；
2. 将 v0.4 CE 目录改名留存；
3. 原子恢复对应的 alpha.14 CE 保留目录；
4. 切回 alpha.14 rootless/privileged/Web 指针并验证旧状态可用；
5. 再次停止 alpha.14，将旧目录重新归档；
6. 恢复之前留存的 v0.4 CE 目录并切回同一 v0.4 Release；
7. 验证 v0.4 身份、Workspace、任务打开和 Queue 状态仍一致。

两份目录不得合并，任一旧二进制不得打开另一版本数据库。完成后设置 `cutover.artifact-rollback` 与 `cutover.v0.4-reactivation`。

## 8. 验证 receipt

填写 `completedAt` 和 `status: "passed"` 后运行：

```bash
chmod 0600 "${CE_STAGING_EVIDENCE_DIR}/staging.json"
pnpm staging:receipt -- validate "${CE_STAGING_EVIDENCE_DIR}/staging.json"
sha256sum "${CE_STAGING_EVIDENCE_DIR}/staging.json"
```

校验器拒绝检查项缺失、少于两个用户、缺少管理员、错误的目标 OS/Node/glibc、非法 hash、未知字段、非规范时间、符号链接和非 0600 文件。

candidate receipt 与 GitHub CI 对同一 commit 为绿色后，才创建 alpha tag/Prerelease 冻结制品。staging 必须消费该 Release 原始制品；只有 staging receipt 通过后，才批准 production 使用同一 manifest。观察窗口结束前保留旧 CE 目录；只有操作者再次批准精确删除目标后才能清理。
