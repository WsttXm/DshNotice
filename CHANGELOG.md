# 更新日志

本文件记录本项目的所有重要变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

## [0.1.0] - 2026-10-10

首个可用版本。

### 新增

- **系统通知**：agent 需要你介入（请求授权、向你提问、提交计划待审）或一轮任务完成时，
  通过 macOS 原生通知横幅提醒。点击横幅把 Harness 窗口切回前台。
- **两种交互类型分别成文**：授权请求显示工具名，提问显示问题正文，计划审阅单独成文。
- **偏好设置**：`enabled`、`onInteraction`、`onComplete`、`sound`、`onlyWhenUnfocused`、
  `announceOnFirstRun`、`language`，改完立即生效并持久化在 `localStorage`。
- **中英文文案**，默认跟随应用语言（读取 DSH 自身的 locale 服务，而不是渲染进程的
  `navigator.language`——后者在桌面版里恒为 `en-US`）。可用 `language` 偏好强制指定。
- **子代理会话过滤**：只有用户可见的会话会提醒，子代理的内部工作保持安静。
- **前台抑制**：窗口在前台、且显示的正是发出通知的那个会话时不提醒，避免噪音。
- **一次性欢迎横幅**：安装后首次挂载时静默弹一条，让用户在系统层面确认整条链路是通的。
- **调试与自测接口**：`window.__DSH_NOTICE__` 暴露 `state()`、`test()`、`set()`、`reset()`、
  `request()`。
- **安装脚本** `plugin.mjs`：`install` / `uninstall` / `status`，支持 `--profile`、`--home`、
  `--dry-run`；写入前自动备份 profile patch，卸载后不留残余；仓库挪走后重跑一次即可自我修复，
  且只在配置真正改动时才产生备份。
- **测试**：40 条用例。26 条用 `node:vm` 复刻渲染进程环境，直接执行发布态的 `lib/client.js`；
  14 条拿临时目录当 profile，端到端验证安装脚本的幂等、备份与回滚。

[未发布]: https://github.com/WsttXm/DshNotice/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/WsttXm/DshNotice/releases/tag/v0.1.0
