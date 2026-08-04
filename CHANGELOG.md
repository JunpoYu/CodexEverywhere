# 版本记录

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构，并使用[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.3.0-alpha.1] - 2026-08-04

首个公开 Alpha 版本。

### Added

- Linux/HPC 用户级 Agent、长期 Codex app-server 和官方 TUI 接力。
- 响应式 Web/PWA 会话界面、审批、工作区管理和深浅色主题。
- 持久 Queue、Queue 转 Steer、Interrupt 和断线恢复。
- Direct Gateway 与可选无状态端到端加密 Relay。
- Passkey、OPAQUE 专用密码、恢复码和临时设备模式。
- Codex 用户级安装、设备码登录与显式 `auth.json` 导入。
- 多用户 HPC 共享安装和现有 SSH 用户自助初始化。

### Security

- Unix 用户级业务数据与进程隔离。
- workspace `realpath`、root 包含关系和符号链接逃逸检查。
- Noise 加密帧、重放保护和不持久化业务数据的 Relay。
- 公开发布前的身份标识与高置信凭据扫描。

### Known limitations

- 仍处于 Alpha 阶段，不保证早期配置、协议和存储结构兼容。
- 尚未提供稳定预构建包、容器镜像或 npm 发布物。
- thread 归档/删除、完整文件浏览、Schedule 和 Web Push 尚未完成。
