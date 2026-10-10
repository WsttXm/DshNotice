# 贡献指南

欢迎提 issue 和 PR。这份文档说明怎么在本地跑起来、改完之后要验证什么，
以及这个项目不接受哪一类改动。

## 环境要求

- macOS（只有 macOS 能端到端验证系统通知）
- Node.js ≥ 20（测试用 `node:test`，无第三方依赖，不需要 `npm install`）
- DeepSeek Harness 桌面版，且至少启动过一次

## 本地开发

```bash
git clone https://github.com/WsttXm/DshNotice.git
cd DshNotice

npm test                      # 40 条用例，两秒内跑完
node plugin.mjs install       # 装进本机的 desktop profile
node plugin.mjs status        # 确认两行都是 yes
```

改代码之后：

| 改了什么 | 怎么让它生效 |
|---|---|
| `packages/dsh-notice/lib/client.js` | 重启 Harness 应用；想省掉重启就把 profile patch 里的 `hmr` 行改成 `config: { root: ["."] }` 让 HMR 也监视模块文件 |
| `packages/dsh-notice/lib/index.js` | 同上（host 半边是空实现，一般不需要动） |
| `plugin.mjs` | 直接重跑，脚本是幂等的 |
| `README*.md` | 预览即可 |

> HMR 默认只监视配置文件（`root: []`），所以改了 `lib/client.js` 之后光刷新窗口是没用的，
> 一定要重启应用或者打开源码监视。

## 提交前必须做的三件事

1. **`npm test` 全绿。** 新增行为要带用例。测试不碰真实浏览器，全部在 `node:vm` 里跑，
   所以用例应该是确定性的、不依赖当前时间或网络。
2. **在真实应用里手动过一遍受影响的路径。** 测试的假 `Notification` 只能证明我们*调用了*
   通知 API，不能证明 macOS 真的把横幅画出来了。至少验证一次：
   切到别的应用 → 触发对应场景 → 几秒内出现横幅 → 点横幅能切回 Harness。
3. **改动 `plugin.mjs` 时补上 `test/plugin.test.mjs` 里对应的用例**，并确认 `node plugin.mjs install --dry-run`
   的输出符合预期。

## 代码风格

- 制表符缩进，行宽控制在 120 列以内（见 `.editorconfig`）。
- 注释解释**为什么**，不复述代码在做什么。
- `lib/client.js` 是**发布态 bundle**，不是 ES module：没有 `import`、没有 `require`、
  没有可选链之外的新语法糖，整体包在 `window.__ModuleLoader__.load({ id, factory })` 里。
  它由 `dsh-client-modules` 原样下发给渲染进程，任何打包器都帮不上忙。
- 不允许为了"顺手"引入运行时依赖。这个包目前是零依赖的，希望保持下去。

## 设计上的红线

这几条不是风格偏好，是拒绝 PR 的理由：

- **不碰 `approval/request` 和 `user-questions/request` 这两条 Cordis waterfall。**
  挂上去就意味着插件有机会拦截、延迟甚至代答属于用户的请求。本插件只被动读取
  `sessionStatus` 投影。想加"从通知里直接批准"这种功能，请先开 issue 讨论，不要直接提 PR。
- **不为子代理会话发通知。** 用户看不见的内部工作不该打扰用户。
- **不在页面加载时补发历史通知。** 挂载时先静默播种一次，只对*挂载之后*发生的状态跃迁提醒。

## 提交信息

用一句话说清楚改了什么、为什么。中英文都可以。

```
fix: 应用语言为中文时不再发出英文横幅

渲染进程的 navigator.language 恒为 en-US，改为优先读 DSH 的 locale 服务。
```

## 提 PR

1. Fork，从 `main` 切一个分支；
2. 改完确保 `npm test` 全绿，并在真实应用里验证过；
3. PR 描述里写清楚：现象、根因、验证方式（最好附上 `window.__DSH_NOTICE__.state()` 的输出）。

---

## For English-speaking contributors

Issues and pull requests are welcome in English. The short version of the rules
above: run `npm test` first, verify the change in the real application (a fake
`Notification` proves nothing about macOS), never touch the `approval/request`
or `user-questions/request` waterfalls, and never notify for subagent sessions.
