# 参与贡献

感谢你关注 CodexEverywhere。项目目前处于 Alpha 阶段，接口、配置和存储格式仍可能变化。开始较大的实现前，请先创建 Issue 说明问题、目标和预期边界，避免重复工作或与架构方向冲突。

## 开发准备

需要 Node.js 20.20.0 或更高版本，以及 pnpm 10.34.5：

```bash
corepack enable
pnpm install --frozen-lockfile
```

仓库以中文维护产品与架构文档；代码、协议字段、schema 和标识符使用英文。实现前请阅读 [README](README.md)、[架构文档](docs/architecture.zh-CN.md) 和 [AGENTS.md](AGENTS.md)。

## 变更原则

- Codex app-server 是 thread、turn、审批、工具活动和执行状态的唯一事实源。
- 不新增 Web Terminal、SSH 密码处理、通用调度器或中心化用户业务数据库。
- 每个跨组件消息都必须有协议版本；未知 Codex 事件必须作为 generic event 向前兼容。
- 所有 workspace 路径先解析真实路径，再验证 root 包含关系和符号链接逃逸。
- 不得提交提示词、文件内容、凭据、恢复码、配对秘密、代理密码、真实主机名或解密后的 Relay payload。
- 安全、生命周期、Queue、路径或协议行为发生变化时，同步更新测试和文档。

## 本地验证

提交 Pull Request 前至少运行：

```bash
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

如果修改了 Codex app-server 适配层，并且本机有仓库固定版本的 Codex，还应运行：

```bash
pnpm test:app-server
```

## Pull Request

Pull Request 应保持目标单一，并说明：

- 用户问题和解决方式；
- 协议、存储、安全边界或兼容性变化；
- 已运行的验证命令；
- 尚未覆盖的风险或后续工作。

不要在 Issue、Pull Request、截图或测试夹具中提交真实凭据和部署信息。安全问题请按 [SECURITY.md](SECURITY.md) 私密报告。

除非贡献者另有明确书面说明，提交到本项目并被接受的贡献按照 [Apache License 2.0](LICENSE) 第 5 节授权。目前不要求额外签署 CLA。
