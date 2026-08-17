# v0.4 全新初始化与切换手册

v0.4 不迁移 v0.3 的 CE 状态，也不提供反向数据迁移。本文保留原文件名，避免旧链接失效；这里的“切换”只归档旧 CE 目录、启用 v0.4 制品并重新初始化 CE，不转换数据库内容。

## 1. 数据边界

| 内容                               | v0.4 切换行为               |
| ---------------------------------- | --------------------------- |
| `~/.codex`、Codex 登录与官方任务   | 保留，不读取或改写          |
| 健康的 Codex app-server            | 保持运行，不因 CE 切换重启  |
| `~/.codex-everywhere`              | 整目录改名保留，不导入 v0.4 |
| Passkey、CE 密码、恢复码、设备信任 | 重新注册                    |
| Host Profile 与 Relay route        | 重新配对、重新签发          |
| Workspace、偏好与任务权限          | 重新配置                    |
| Queue 与 mutation receipt          | 丢弃，不重放                |
| 管理员 Controller 状态             | 重新初始化                  |

任务、turn、审批和工具活动始终以 Codex app-server 为事实源。重新打开任务时由 v0.4 从 app-server 读取权威状态；CE 不从旧数据库重建任务历史。

## 2. 停止条件

出现下列任一情况时停止切换：

- 目标 Release、manifest、checksum、provenance 或 inventory 校验失败；
- 浏览器、Agent 宿主机或 Relay 的 UTC 偏差超过 30 秒；
- 仍有运行中的 turn、未解决 interaction、delivering Queue、pending mutation 或登录流程；
- Agent 停止后 app-server 不健康；
- 旧 CE 目录不是目标 Unix 用户所有、权限异常或保留目标已存在；
- 需要用户完成 Passkey、恢复码或 Codex 设备码操作，但用户不在场；
- v0.4 初始化尝试读取或修改旧 CE 数据库。

## 3. 切换前检查

1. 记录当前 v0.3 tag、commit、manifest SHA-256、rootless/privileged/Web/Relay 指针和 inventory 结论。
2. 验证 v0.4 candidate receipt、CI、Release manifest、checksum 与 provenance。
3. 确认 alpha.14 的 verified release 目录仍完整，作为观察窗口内的程序回退点。
4. 确认 rootless provisioner 已运行且 credential 有效。
5. 退出旧 Side，清空或明确放弃旧 Queue，等待副作用静止。
6. 记录 app-server PID，并确认 `ce app-server status` 为 healthy。

不得把旧数据库、配置、capability、恢复码或配对资料复制到日志、Issue、PR 或 staging receipt。

## 4. 用户状态切换

先停止 Agent。停止命令不得停止 app-server：

```bash
sudo -iu <username> /usr/local/bin/ce agent stop
sudo -iu <username> /usr/local/bin/ce app-server status
```

为本次窗口选择一个不会与现有路径冲突的规范 UTC 时间戳，然后按精确路径改名。命令中的占位符必须先替换：

```bash
sudo -iu <username> sh -eu -c '
  retained="$HOME/.codex-everywhere.v0.3-retained.<UTC-timestamp>"
  test -d "$HOME/.codex-everywhere"
  test ! -e "$retained"
  mv "$HOME/.codex-everywhere" "$retained"
  chmod 0700 "$retained"
'
```

这一步不接触 `~/.codex` 和 `/tmp` 中仍健康的 app-server socket/PID。随后切换 v0.4 rootless/privileged release 与 Web，再由用户执行：

```bash
ce device pair
ce workspace add /absolute/path/to/project
ce agent start
ce agent status
ce app-server status
ce doctor
```

在 PWA 中使用新的配对资料，重新注册 Passkey 或 CE 密码并离线保存新恢复码。旧 Host Profile、旧 CE 恢复码和旧 Queue 均不再有效。

## 5. 管理员控制面

没有 Controller 时直接按当前 v0.4 操作手册全新安装。已有 Controller 时：

1. 停止 Controller；
2. 核对 rootless 与 privileged CLI 为同一 v0.4 tag；
3. 将现有 `CE_ADMIN_HOME` 整目录改名保留，不合并其数据库；
4. 重新执行 `ce admin install-controller`；
5. 以 Controller 账号生成新配对资料；
6. 操作者本人在 `/admin` 注册新管理员 Passkey/CE 密码并保存恢复码；
7. 验证管理员只能看到宿主控制面，不能看到用户业务数据。

## 6. 验收

至少验证：

- app-server PID 在切换前后不变且健康；
- 新 CE 状态库具有 v0.4 application ID、schema 和 0600 权限；
- 能重新打开 app-server 中已有任务；
- Direct 与 Relay、桌面与 390px 移动端均可用；
- Passkey、CE 密码、恢复码和临时登录符合预期；
- Workspace 越界被拒绝；
- interaction、interrupt、Queue 与 TUI 接力可用；
- 日志不包含提示词、Queue 文本、路径内容、凭据或解密 payload。

## 7. 观察窗口内回退

不存在 v0.4→v0.3 数据转换。若 v0.4 验收失败：

1. 停止 v0.4 Agent/Controller；
2. 将新建的 v0.4 CE 目录改名留存，不与旧目录合并；
3. 把原 v0.3 保留目录原子改回 `~/.codex-everywhere`；
4. 原子切回 alpha.14 rootless/privileged/Web 制品；
5. 启动 alpha.14 Agent，并验证 app-server、Relay 和旧 Web 身份；
6. 明确告知操作者：v0.4 期间新建的 CE 身份、Workspace、Queue 和偏好不会回到 v0.3。

只有当 v0.4 被明确接受、观察窗口结束且操作者再次批准精确删除目标后，旧 CE 保留目录才可删除。不得由安装器、Agent 或定时任务自动删除。
