# v0.3 与 v0.4 状态迁移手册

本文档说明 CodexEverywhere v0.3 schema 4 与 v0.4 schema 1 之间的正式状态迁移。迁移只转换 CE 自有状态；Codex thread、turn 和工具活动仍由 Codex app-server 保存和恢复。

实际宿主机切换顺序、rootless/root-owned 双 release、watchdog 静止方式和 Web/Relay 回滚见[部署、升级与回滚操作手册](operator-runbook.zh-CN.md)。

> [!WARNING]
> Gateway API v2 和 v0.4 SQLite 都不兼容 v0.3 二进制。不能让 v0.3 Agent 打开 v0.4 数据库，也不能只切换程序制品而跳过迁移。

## 1. 迁移保证

迁移器执行以下安全步骤：

1. 检查运行时和持久状态已经静止；
2. 取得与正常状态写入相同的跨进程文件锁；
3. 严格校验源库版本、`application_id`、必需表、文件所有者和 `0600` 权限；
4. 在内存中构建版本化逻辑快照，不把快照、凭据或业务内容写入 JSON 或日志；
5. 在临时路径创建目标数据库并校验记录计数、领域不变量和 SQLite 完整性；
6. 为原库创建 `0600` 备份并记录 SHA-256；
7. `fsync` 后原子替换状态文件，再以只读方式重新打开并 smoke check；
8. 写入只含迁移元数据、文件名和摘要的 `0600` receipt。

任何发布后的验证失败都会在文件锁内自动恢复源库。正向和反向迁移都保留源库备份，直到运维者显式 finalize。

## 2. 正向迁移前置条件

对每个待升级的 Unix 用户确认：

- v0.3 Agent 已停止；停止 Agent 不会停止健康的 Codex app-server；
- app-server 中没有 `active` thread，即没有运行中的 turn；
- 没有未解决的审批、用户问题或 MCP elicitation；
- 没有正在投递的 Queue item 或未完成 Queue claim；
- 没有 pending mutation 或正在进行的登录流程；
- 所有 Side 页面已经退出。v0.3 无法从进程外列举 Side，因此预检把“旧 Agent 仍运行”直接视为 Side blocker；
- `schedules`、`schedule_runs` 和 `push_subscriptions` 均为空。

Schedule、Schedule run 或 Push 数据不属于 v0.4 首版。迁移器只报告各类记录数量并失败关闭，不打印记录内容，也不会静默删除。

## 3. 用户库正向迁移

先部署 v0.4 程序制品，但不要启动 v0.4 Agent。随后以该 Unix 用户执行：

```bash
ce agent stop
ce upgrade preflight --to v0.4
ce state migrate --to v0.4 --dry-run
ce state migrate --to v0.4
```

`preflight` 和 `--dry-run` 都不会创建备份或修改状态。正式命令成功后会输出：

- `sourceSha256`；
- 迁移后的各领域记录计数；
- `backupPath`；
- `receiptPath`。

记录这些非秘密元数据，然后启动 v0.4 Agent：

```bash
ce agent start
ce agent status
ce app-server status
```

在 Web 中至少完成一次只读 smoke test：登录、列出 Workspace、打开既有任务、查看 Queue 和身份状态。确认前不要执行 migration finalize。

## 4. 管理员库正向迁移

Administrator Controller 使用独立数据库和文件所有者。先停止 Controller，再以有权读取管理员状态的安装身份执行带 `--admin` 的命令；生产安装通常需要 root：

```bash
ce admin web stop
ce upgrade preflight --to v0.4 --admin
ce state migrate --to v0.4 --admin --dry-run
ce state migrate --to v0.4 --admin
ce admin web start
ce admin web status
```

v0.3 的 Controller 身份库与 privileged admin 状态可能位于两个文件。迁移器会同时锁定、备份、合并和验证两者；任一文件失败时不会发布部分管理员状态。

## 5. 数据转换规则

正向迁移保留：

- Passkey、CE 密码记录、恢复码哈希、可信设备和仍有效的身份状态；
- Workspace、默认 Workspace、偏好和 thread 权限 revision；
- pairing/recovery handoff 中仍有效且可表达的数据；
- 未完成 Queue item、delivery claim 和结果未知状态；
- 仍有效的 mutation receipt；
- 用户最小安全审计、managed users 和管理员审计。

以下数据不迁移：

- `thread_cache`；任务历史从 Codex app-server 重建；
- 已过期的 pairing、recovery handoff 和幂等结果；
- v0.3 仅驻内存的 Side 状态；
- Schedule、Schedule run 和 Push subscription。只要这些表非空，迁移整体失败。

迁移输出和 receipt 不包含密码记录、Passkey、恢复哈希、Queue 文本、提示词、文件内容或路径内容。

## 6. 回滚到 v0.3

回滚既包括程序制品切换，也包括正式反向数据库迁移。先停止 v0.4 Agent，并确认：

- 所有 thread lease 已 idle；
- 没有运行中的 turn、未解决 interaction、delivering Queue、pending mutation 或登录流程；
- v0.4 数据能够由 v0.3 完整表达。

以下状态会使反向迁移失败关闭：

- pending 或 indeterminate mutation receipt；
- delivering Queue item；
- v0.3 无法表达的自定义 Workspace label；
- 非 `system` 主题或非 `zh-CN` locale；
- 缺少 v0.3 durable receipt 所需 rollback fingerprint 的记录；
- 任何无法无损转换的新领域数据。

执行：

```bash
ce agent stop
ce state migrate --to v0.3 --dry-run
ce state migrate --to v0.3
```

管理员库使用相同命令并添加 `--admin`。反向迁移会重建完整 schema 4，并为 v0.4 Queue 状态写入旧版 rollback barrier，避免旧 Agent 重复投递。发布后还会重新读回 schema 4 并核对语义计数。

迁移成功后，原子切换到已验证的 v0.3 Release，再启动对应 Agent/Controller。不要在反向迁移完成前启动旧二进制。

## 7. 备份、恢复与 finalize

迁移结果中的 `backupPath` 是原始 SQLite 文件副本，文件名标记源版本；`receiptPath` 与状态库位于同一目录。只要没有 finalize，就可以结合已验证的旧程序制品进行回滚演练。

若正式迁移命令报错：

1. 不要启动目标版本；
2. 保存完整错误码、记录数量、receipt 路径和 SHA-256，但不要收集数据库或业务内容到普通日志；
3. 检查状态文件仍能由源版本只读打开；迁移器在原子发布后失败时会自动恢复备份；
4. 若怀疑文件系统或进程并发写入，保持 Agent/Controller 停止并重新运行 dry-run；
5. 只有在核对 state path、backup path、owner、mode 和 SHA-256 后，才可进行人工恢复。

在 staging 和 production 都完成业务验证、回滚窗口结束后，按迁移输出的确切 receipt 路径执行：

```bash
ce state migration-finalize /absolute/path/to/migration-<id>.receipt.json
```

管理员 receipt 添加 `--admin`。finalize 会删除该 receipt 引用的源库备份并在 receipt 中记录 `finalizedAt`；它不会删除 receipt。该操作不可逆，不应被安装脚本或定时任务自动执行。

## 8. 多用户 staging 演练

发布 `v0.4.0-alpha.1` 前至少选择两个非生产测试用户和一个管理员控制面，完成：

1. v0.3 基线登录、任务、Queue、Workspace 和恢复码检查；
2. 停止各自 Agent/Controller，分别运行 preflight、dry-run 和正式正向迁移；
3. 启动 v0.4，验证 Direct 与 Relay、手机与桌面、审批竞争、断线恢复和 Queue；
4. 在 v0.4 写入可回滚的 Workspace、偏好、权限、身份和 Queue 变化；
5. 停止服务，运行反向 dry-run 和正式迁移；
6. 原子切回 v0.3 制品并验证业务语义与 Queue rollback barrier；
7. 再次正向迁移并切回 v0.4；
8. 记录 Release manifest SHA-256、源库 SHA-256、receipt、用时和结果；
9. 只有验收通过且回滚窗口结束后才 finalize。

测试数据库、备份和 receipt 都属于敏感宿主机状态，不得复制到源码仓库、Issue、CI artifact 或公开日志。

完整的候选版本门禁、场景布尔项和脱敏证据格式见 [v0.4 staging 验收手册](staging-v0.4.zh-CN.md)。
