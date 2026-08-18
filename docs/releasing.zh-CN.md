# 发布流程

本文档定义 CodexEverywhere 的公开发布流程。当前准备发布的版本为 `v0.4.0-alpha.3`。GitHub Release 从 tag 的干净 checkout 构建 Web、Agent、Relay 和 HPC 部署工具，不发布 npm 包；生产环境只消费这些不可变制品，不从开发工作区重新构建。

发布与部署是两个阶段：公开仓库负责把源码变成可验证制品，生产运维环境负责选择版本、保存部署秘密并消费制品。真实域名、主机、SSH 参数、credential 和环境 inventory 不进入公开仓库。

## 分支与历史

- 公开仓库的默认分支为 `main`。
- 所有功能分支都从公开 `main` 创建并通过 Pull Request 合并；不得把旧的私人 `main` 合并回公开历史。
- `main` 是唯一可信源码主线；功能分支、PR head、本地提交和脏工作区不得作为生产部署输入。
- Release tag 是已发布版本的唯一不可变标识。已经推送的 tag 不得移动或复用。
- 提交 author 邮箱是公开元数据，可以使用有意公开的个人邮箱或 GitHub noreply 邮箱，不作为安全检查或发布门槛。Issue、PR、提交说明和测试数据不得包含真实部署身份、主机名、域名、路径或凭据。

## 版本规则

项目使用语义化版本：

- 不稳定版本使用 `vMAJOR.MINOR.PATCH-alpha.N`；
- 稳定版本使用 `vMAJOR.MINOR.PATCH`；
- 根目录、Agent、Relay、Web、Kernel、Crypto、Protocol 和 Testing package 保持相同项目版本；
- `codex-app-server-schema` 独立使用生成该编译基线的 Codex CLI 版本号，不跟随项目版本，也不构成运行时白名单。

每次发布必须同步更新：

1. 所有项目 package 的 `version`；
2. [CHANGELOG.md](../CHANGELOG.md)；
3. README 中的公开版本和兼容性说明；
4. 使用发布时的 npm 最新稳定版 Codex 重新生成 schema、更新基线版本并运行集成测试。

## 发布前检查

从准备发布的 commit 执行：

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm format:check
pnpm check:architecture
pnpm check:test-runtime
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
pnpm check:web-budget
pnpm test:app-server
git diff --check
```

干净发布候选应优先用以下命令执行同一组门禁并在源码仓库外生成 0600 脱敏 receipt：

```bash
pnpm verify:v0.4 -- --with-model --receipt /absolute/private/path/candidate.json
```

不带 `--with-model` 的运行会明确保留订阅模型门槛；`--allow-dirty` 只允许本地开发核对，其 receipt 不能作为发布证据。完整多用户证据必须另行通过 `pnpm staging:receipt -- validate <receipt>`，流程见 [v0.4 staging 验收手册](staging-v0.4.zh-CN.md)。

`test:app-server` 需要本机安装发布时的 npm 最新稳定版 Codex；不得用跳过集成测试的方式发布 Codex 适配层变更。若项目声明额外的兼容版本，也应分别运行，但运行时不得仅按版本号拒绝用户已有的 Codex。

同时人工确认：

- `LICENSE`、`NOTICE`、README、CHANGELOG 和版本号一致；
- 没有 `.env`、`auth.json`、证书、私钥、数据库、日志或运行目录；
- 示例只使用 `example.com`、`example`、`invalid`、loopback 地址及 `alice`/`bob` 等虚构身份；
- 依赖许可证仍与 Apache-2.0 兼容；
- 当前变更不新增部署域名或秘密；提交 author 邮箱不在此限制内。已有公开提交即使改写也不能视为完成秘密撤回，发现凭据时必须先轮换；
- GitHub CI 在目标 commit 上通过。
- v0.4 全新初始化、旧 CE 目录隔离、`~/.codex`/app-server 保留和观察窗制品恢复测试通过；
- Direct 与 Relay 使用同一 Gateway v2 合同测试，未知方法、错误身份、缺失 operation key 和版本不匹配均失败关闭；
- 390px 手机与桌面 Playwright 核心流程通过，PWA 更新不会刷新 outcome-unknown mutation；
- Web 首始用户路由 JS gzip 不超过 250 KiB、CSS gzip 不超过 40 KiB；Markdown、KaTeX 与代码高亮保持独立懒加载；
- candidate receipt 已通过，目标 commit 与 CI commit 相同；staging 使用的 alpha.14 保留 release、两个非生产用户和管理员控制面已经准备好。多用户 staging 必须消费尚待创建的不可变 Prerelease 制品，因此不是创建候选 tag 的前置条件，而是 production 批准的前置条件。

## 候选 Prerelease 与 staging

v0.4 staging 必须验证 GitHub Release 的原始制品，而 Release workflow 又只能从 tag 构建。因此采用以下两阶段门槛，避免“没有 tag 就没有制品、没有制品又不能 staging”的循环依赖：

1. candidate receipt、公开 CI 和人工源码检查通过后，在 `main` 的同一 commit 创建 annotated alpha tag；
2. Release workflow 生成带 provenance 的 Prerelease，至此只表示“制品已冻结”，不表示允许 production；
3. staging 下载该 Prerelease，记录 manifest SHA-256，完成旧 CE 状态隔离、v0.4 全新初始化、核心业务验收和制品指针回滚/再激活；
4. staging receipt 通过后，才批准 production 以该 manifest SHA-256 部署同一组字节；
5. 不重新构建、不移动 tag，也不把另一 commit 的制品冒充已经 staging 的版本。

Alpha tag/Prerelease 可以公开供测试，但发布说明必须明确 staging 状态。若 staging 失败，保留失败证据并发布新的 prerelease 序号；不得覆盖旧 tag 或旧 Release。

## 首次公开

在 GitHub 创建一个空仓库，不自动生成 README、LICENSE 或 `.gitignore`。然后把本地无父提交分支推为公开默认分支：

```bash
git remote add public git@github.com:<owner>/CodexEverywhere.git
git push -u public codex/public-release:main
```

在 GitHub 将 `main` 设为默认分支，并至少启用：

- 合并前要求 `CI / verify` 通过；
- 禁止 force push 和删除 `main`；
- Dependabot alerts 与 security updates；
- Secret scanning 与 push protection；
- Private Vulnerability Reporting；
- 自动删除已合并分支。

确认公开页面、README、许可证识别、安全报告入口、candidate receipt 和目标 commit CI 正常后再创建候选 tag：

```bash
git tag -a v0.4.0-alpha.3 main \
  -m "CodexEverywhere v0.4.0-alpha.3"
git push public v0.4.0-alpha.3
```

Tag 推送后，[Release workflow](../.github/workflows/release.yml) 会重新执行格式、架构、类型、单元测试、Playwright 和构建检查，安装并记录当时 npm 最新稳定版 Codex CLI，再运行真实 app-server contract 集成测试。任何一项失败都不会生成制品。带连字符的版本会自动标记为 prerelease；该状态冻结 staging 输入，但不构成 production 批准。

Release workflow 还会验证 tag commit 属于公开 `main`，并生成：

```text
codex-everywhere-web-<tag>.tar.gz
codex-everywhere-agent-<tag>.tar.gz
codex-everywhere-relay-<tag>.tar.gz
codex-everywhere-hpc-tools-<tag>.tar.gz
manifest.json
SHA256SUMS
```

`manifest.json` 记录统一版本、完整 commit、协议版本、Node.js 要求以及每个制品的名称、大小和 SHA-256。GitHub Actions 同时为制品生成 provenance attestation。消费端不仅验证制品签名属于目标仓库，还将 signer workflow 固定为 `.github/workflows/release.yml`，并要求 source ref 等于请求的 tag、source digest 等于 manifest commit；缺少这些 CLI 能力时失败关闭。Release 已存在时 workflow 不覆盖或移动它。

## 后续发布

1. 从公开 `main` 创建发布准备分支；
2. 更新版本、CHANGELOG 和文档；
3. 通过 Pull Request 完成 CI 和审阅；
4. 合并后在本地同步公开 `main`；
5. 创建并推送 annotated tag；
6. 检查自动生成的 GitHub Release、安装文档和源代码归档；
7. 检查 manifest、SHA-256、provenance attestation 的 workflow/tag/commit 身份约束，以及 Release 摘要中记录的 Codex app-server contract 基线；
8. 由独立 staging 运维环境消费 Prerelease，完成全新安装、重复安装恢复、安装内容漂移拒绝、升级和严格 inventory 回滚演练，并记录获批 `manifest.json` SHA-256；
9. staging receipt 验证通过并人工批准后，由 production 安装器以该获批摘要为信任根部署同一组制品，不重新构建。

不要把 GitHub Actions 的生产 SSH 私钥放进公开源码仓库。个人或单集群部署推荐由服务器上的无特权专用账号主动下载 Release，并把真实配置保留在服务器本地；多环境团队才需要私有 ops 仓库或带 Environment 审批的独立部署工作流。公开仓库的 CI 只构建和发布，绝不 SSH 到生产环境。架构边界见[部署与升级](deployment.zh-CN.md)，逐项命令见[操作手册](operator-runbook.zh-CN.md)。

## 撤回与修复

- 不修改或覆盖已经发布的 tag。
- 普通缺陷发布新的 patch 或 prerelease 序号。
- 严重安全问题先将 Release 标记说明风险，通过 GitHub Security Advisory 协调修复，再发布新版本。
- 如果发布物包含凭据，必须先轮换凭据，再清理公开历史和缓存；仅删除 GitHub Release 不足以消除泄漏。
