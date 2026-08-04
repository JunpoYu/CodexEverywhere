# 发布流程

本文档定义 CodexEverywhere 的公开发布流程。当前公开版本为 `v0.3.0-alpha.1`，在稳定版之前只发布源代码，不发布 npm 包、容器镜像或未经独立验证的预构建 HPC bundle。

## 分支与历史

- 公开仓库的默认分支为 `main`。
- 初次发布必须从当前清理后的无父提交分支 `codex/public-release` 建立公开 `main`，不得推送包含私人部署信息的旧本地历史。
- 公开后，所有功能分支都从公开 `main` 创建；不得把旧的私人 `main` 合并回公开历史。
- Release tag 是已发布版本的唯一不可变标识。已经推送的 tag 不得移动或复用。
- 提交使用 GitHub noreply 邮箱，Issue、PR、提交说明和测试数据不得包含真实部署身份、主机名、域名、路径或凭据。

## 版本规则

项目使用语义化版本：

- 不稳定版本使用 `vMAJOR.MINOR.PATCH-alpha.N`；
- 稳定版本使用 `vMAJOR.MINOR.PATCH`；
- 根目录、Agent、Relay、Web、Crypto、Protocol 和 Testing package 保持相同项目版本；
- `codex-app-server-schema` 独立使用与固定 Codex CLI 对应的版本号，不跟随项目版本。

每次发布必须同步更新：

1. 所有项目 package 的 `version`；
2. [CHANGELOG.md](../CHANGELOG.md)；
3. README 中的公开版本和兼容性说明；
4. 如 Codex 版本变化，同步生成 schema、更新固定版本并运行集成测试。

## 发布前检查

从准备发布的 commit 执行：

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm test:app-server
git diff --check
```

`test:app-server` 需要本机安装仓库固定版本的 Codex；不得用跳过集成测试的方式发布 Codex 适配层变更。

同时人工确认：

- `LICENSE`、`NOTICE`、README、CHANGELOG 和版本号一致；
- 没有 `.env`、`auth.json`、证书、私钥、数据库、日志或运行目录；
- 示例只使用 `example.com`、`example`、`invalid`、loopback 地址及 `alice`/`bob` 等虚构身份；
- 依赖许可证仍与 Apache-2.0 兼容；
- Git 历史不含私人邮箱、旧部署域名和秘密；
- GitHub CI 在目标 commit 上通过。

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

确认公开页面、README、许可证识别和安全报告入口正常后再创建 tag：

```bash
git tag -a v0.3.0-alpha.1 codex/public-release \
  -m "CodexEverywhere v0.3.0-alpha.1"
git push public v0.3.0-alpha.1
```

Tag 推送后，[Release workflow](../.github/workflows/release.yml) 会重新执行格式、类型、测试和构建检查，并创建 GitHub Release。带连字符的版本会自动标记为 prerelease。

## 后续发布

1. 从公开 `main` 创建发布准备分支；
2. 更新版本、CHANGELOG 和文档；
3. 通过 Pull Request 完成 CI 和审阅；
4. 合并后在本地同步公开 `main`；
5. 创建并推送 annotated tag；
6. 检查自动生成的 GitHub Release、安装文档和源代码归档；
7. 在测试宿主机完成一次全新安装与升级演练。

## 撤回与修复

- 不修改或覆盖已经发布的 tag。
- 普通缺陷发布新的 patch 或 prerelease 序号。
- 严重安全问题先将 Release 标记说明风险，通过 GitHub Security Advisory 协调修复，再发布新版本。
- 如果发布物包含凭据，必须先轮换凭据，再清理公开历史和缓存；仅删除 GitHub Release 不足以消除泄漏。
