# DshNotice

> 让 **DeepSeek Harness 桌面版**在需要你介入时，用 **macOS 系统通知**把你叫回来。

[English](README.en.md) · **简体中文**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/WsttXm/DshNotice/actions/workflows/ci.yml/badge.svg)](https://github.com/WsttXm/DshNotice/actions/workflows/ci.yml)
[![Platform](https://img.shields.io/badge/platform-macOS%20%C2%B7%20DSH%20Desktop-lightgrey.svg)](#环境要求)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#工作原理简要)

把 Harness 丢在后台跑长任务，然后去干别的事——需要你点确认、需要你回答问题、或者这一轮跑完的时候，
横幅会自己找到你。点一下横幅，Harness 窗口就回到前台。

```
┌────────────────────────────────────────────────────┐
│  DeepSeek Harness                                  │
│  需要你的授权                                      │
│  「重构登录流程」想要执行 bash，请回到应用确认。   │
└────────────────────────────────────────────────────┘
```

---

## 特性

- **三种时刻会提醒**：请求授权、向你提问、提交计划待审；外加**一轮任务完成**。
- **通知的署名就是 DeepSeek Harness**：走应用自己的通知身份，带应用图标、进通知中心、
  遵守「系统设置 → 通知 → DeepSeek Harness」里的开关——不是伪装成脚本编辑器的野通知。
- **绝不碰你的审批和回答**：插件只旁读会话状态，不挂任何请求回调，不存在"通知插件把审批吞了"
  这种可能。
- **不打扰**：子代理的内部工作不提醒；你已经盯着那个会话看的时候也不提醒。
- **中英文自动跟随应用语言**，也可以手动锁定。
- **零依赖、零构建**：没有 `npm install`，没有打包步骤，一个文件就是全部逻辑。
- **安装可逆**：写配置前自动备份，卸载后不留残余。

## 快速开始

### 环境要求

| 项目 | 要求 |
|---|---|
| 系统 | macOS（已在 arm64 上验证） |
| 应用 | DeepSeek Harness 桌面版，**且至少启动过一次**（安装脚本要往 `~/.dsh/profiles/desktop` 里写东西，这个目录由应用首次启动时创建） |
| 运行时 | Node.js ≥ 20（安装脚本和测试都只用 Node 内置模块） |

### 三步装好

```bash
git clone https://github.com/WsttXm/DshNotice.git
cd DshNotice
node plugin.mjs install        # 等价于 npm run plugin:install
```

然后回到 Harness 窗口按一次 **⌘R** 刷新。

**看到「通知已开启」横幅就成功了。** 这条欢迎横幅只在首次安装时弹一次，它的意义就是让你在
系统层面确认整条链路是通的——包括 macOS 有没有真的把横幅画出来。

> 装完不会立刻生效的那几秒是正常的：应用在监视 `cordis.patch.yml`，文件稳定后会自己重新
> 组合插件树。如果刷新后仍然没有横幅，重启一次应用即可。

安装脚本是**幂等**的，重复跑不会写坏任何东西；它也**不会**碰你 profile 里原有的任何配置，
只追加一段带标记的、自己能认出来的块。

### 确认装好了

```bash
node plugin.mjs status
```

```
profile        : /Users/you/.dsh/profiles/desktop
patch file     : /Users/you/.dsh/profiles/desktop/cordis.patch.yml
row installed  : yes
package linked : yes
resolves from the profile: /path/to/DshNotice/packages/dsh-notice/package.json
```

两行都是 `yes` 就说明安装到位。

也可以在 Harness 窗口里按 **⌥⌘I** 打开开发者工具，在控制台里主动试一发：

```js
window.__DSH_NOTICE__.test()              // 立刻弹一条样例横幅
window.__DSH_NOTICE__.test("complete")    // 弹"任务已完成"那条
window.__DSH_NOTICE__.state()             // 权限、挂载状态、最近发出的通知
```

### 升级

```bash
cd DshNotice
git pull
```

改动只在 `lib/client.js` 里，拉完重启一次 Harness 应用就生效了，不需要重装。

### 卸载

```bash
node plugin.mjs uninstall      # 移除配置行与软链，保留备份
```

然后刷新窗口或重启应用，让 client 模块从页面里卸载掉。

---

## 配置

所有偏好都存在渲染进程的 `localStorage` 里（键名 `dsh-notice:prefs`），**改完立即生效，不需要刷新**。

### 怎么改

在 Harness 窗口按 **⌥⌘I** 打开控制台：

```js
window.__DSH_NOTICE__.set({ sound: false })               // 静音，只留横幅
window.__DSH_NOTICE__.set({ onComplete: false })          // 只在需要我介入时提醒，跑完别打扰
window.__DSH_NOTICE__.set({ onlyWhenUnfocused: false })   // 前台也提醒（默认不提醒）
window.__DSH_NOTICE__.set({ language: "zh" })             // 锁定中文文案
window.__DSH_NOTICE__.set({ enabled: false })             // 全部关掉

window.__DSH_NOTICE__.prefs                               // 看当前配置
window.__DSH_NOTICE__.reset()                             // 恢复出厂默认
```

### 配置项

| 配置项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关。`false` 时以下所有通道全部静默 |
| `onInteraction` | boolean | `true` | 请求授权 / 向你提问 / 计划待审时提醒 |
| `onComplete` | boolean | `true` | 一轮任务结束时提醒 |
| `sound` | boolean | `true` | 横幅是否带系统提示音 |
| `onlyWhenUnfocused` | boolean | `true` | 窗口在前台、且当前显示的正是要通知的那个会话时**不**提醒 |
| `announceOnFirstRun` | boolean | `true` | 首次安装时弹一条欢迎横幅（用来验证链路） |
| `language` | `"auto"` \| `"zh"` \| `"en"` | `"auto"` | 通知文案语言。`auto` = 跟随应用界面语言 |

> `sound` 只决定本插件发出的通知要不要响，与「系统设置 → 通知 → DeepSeek Harness」里的
> 声音开关互不影响。

### 什么时候会提醒

插件把每个会话的状态折成一个索引，只对**状态跃迁**做出反应，不会因为刷新页面补发旧通知。

| 跃迁 | 横幅 |
|---|---|
| 出现待审批请求 | **需要你的授权** — `「会话名」想要执行 <工具名>，请回到应用确认。` |
| 出现待回答的问题 | **需要你的回答** — 直接显示问题正文 |
| 出现待审阅的计划 | **等待你审阅计划** — `「会话名」提交了一份计划，等待你确认。` |
| 一轮任务从运行中变为结束，且没有待处理交互 | **任务已完成** — `「会话名」已完成本轮任务。` |
| 一轮结束时正好又要你介入（比如收尾时向你提问） | 只发**一条**，且发「需要你…」那条 |

会话名只在有必要时出现：当横幅讲的就是你正盯着的那个会话时，标题不重复出现在正文里。

### 什么时候故意不提醒

命中任意一条就不发，这是设计，不是 bug：

- `enabled` 为 `false`；
- 对应通道被关掉（`onInteraction` / `onComplete`）；
- 该会话是**子代理**或空白会话——你看不见的内部工作不该打扰你；
- **窗口在前台，且正显示着要通知的那个会话**——输入框就在你眼前，再弹横幅是噪音。
  把 `onlyWhenUnfocused` 设为 `false` 可以关掉这条规则。

> 另外，macOS 本身在应用处于前台时通常也不画横幅（只静默进通知中心），这是系统行为，
> 不是插件能决定的。

### 语言

默认 `language: "auto"`，跟随**应用界面语言**——`auto` 读的是 DSH 自己的语言设置，
而不是渲染进程的 `navigator.language`（桌面版里后者恒为 `en-US`，曾经导致中文应用弹出英文通知）。

想固定成某一种语言：

```js
window.__DSH_NOTICE__.set({ language: "en" })   // 永远英文
window.__DSH_NOTICE__.set({ language: "auto" }) // 回到跟随应用
```

排查语言问题时，`window.__DSH_NOTICE__.state()` 里的 `language` 是实际生效的文案语言，
`detectedLocale` 是检测到的应用语言，两者对不上就能立刻定位。

### 手动安装（不想跑脚本时）

安装脚本只做两件简单的事，你完全可以自己来：

```bash
# 1. 把包链接进 profile，让它能像自带 bundle 一样被解析
ln -s /path/to/DshNotice/packages/dsh-notice \
      ~/.dsh/profiles/desktop/node_modules/dsh-notice
```

```yaml
# 2. 在 ~/.dsh/profiles/desktop/cordis.patch.yml 末尾追加这一行
- insert:
    - id: notice
      name: 'dsh-notice'
```

偏好设置是每个存储分区独立的，桌面版窗口固定用同一个分区，所以配置是持久的。

---

## 常见问题

| 现象 | 原因与处理 |
|---|---|
| 装完没有任何横幅 | 先按 ⌘R 刷新窗口；再不行重启应用。然后在控制台跑 `window.__DSH_NOTICE__.state()` |
| 控制台里没有 `__DSH_NOTICE__` | client 模块没进页面。`node plugin.mjs status` 确认两行都是 `yes`，然后重启应用 |
| `status` 显示 `package linked : broken` | 仓库被移动或删除了，软链指向了不存在的位置。在**新位置**重跑 `node plugin.mjs install` 即可修复 |
| `state()` 里 `attached: false` | `uiSession` 服务没就绪，通常是插件树还没组合完，等一下或重启 |
| `state()` 里 `permission` 不是 `granted` | 通知权限没拿到，检查系统设置的授权弹窗 |
| `delivered: true` 但屏幕上没横幅 | 系统层面拦掉了。打开「系统设置 → 通知 → DeepSeek Harness」，确认允许通知且样式不是「无」 |
| 应用在前台时不弹 | 系统行为 + 插件的前台抑制，见上一节。把 `onlyWhenUnfocused` 设为 `false` 可以只绕过后半条 |
| 横幅文字是英文，但界面是中文 | 用 `set({ language: "zh" })` 锁定，并欢迎提 issue 附上 `state()` 的输出 |
| 后台会话完成时不提醒 | 预期行为，见「什么时候故意不提醒」 |
| 卸载后还在提醒 | 需要刷新窗口或重启应用来卸载 client 模块 |
| 改完配置想撤销 | `window.__DSH_NOTICE__.reset()` 恢复默认偏好；`node plugin.mjs uninstall` 彻底移除插件 |

想连 profile 配置一起恢复出厂状态：

```bash
ls ~/.dsh/profiles/desktop/cordis.patch.yml.dsh-notice-backup-*   # 找到备份
cp <备份> ~/.dsh/profiles/desktop/cordis.patch.yml
```

---

## 工作原理（简要）

插件由两半组成，加起来不到 600 行：

| 半边 | 文件 | 职责 |
|---|---|---|
| Host | `packages/dsh-notice/lib/index.js` | 空实现。唯一作用是让这个包成为一条 Loader 行——`dsh-client-modules` 只扫描 host 侧的插件行来发现带 `dsh.client` 的包，没有这一行，浏览器那一半不会被下发 |
| Client | `packages/dsh-notice/lib/client.js` | 全部功能。订阅会话状态投影，在状态跃迁时调用 Web Notifications API |

两个值得一说的决定：

- **用 Web Notifications，而不是 `osascript -e 'display notification'`。** 桌面版窗口运行在
  `dsh-app://app` 源上，Electron 主进程为该源安装的权限处理器对所有非媒体权限一律放行，
  所以 `new Notification(...)` 会被交给 macOS，**以 "DeepSeek Harness" 的身份发出**：带应用
  图标、进通知中心、遵守该应用在系统设置里的开关。而 `osascript` 发出的通知署名是
  Script Editor、图标是通用图标、点了也无法聚焦应用。
- **只被动读状态，不挂请求回调。** `approval/request` 和 `user-questions/request` 是 Cordis
  waterfall，挂上去就能接管请求。本插件完全不碰这两条链路，因此不可能吞掉、延迟或误答一个
  属于你的请求。

更细的插件 API 调研笔记见 [`docs/DSH-PLUGIN-API-REFERENCE.md`](docs/DSH-PLUGIN-API-REFERENCE.md)。

---

## 开发

```bash
npm test     # 40 条用例，两秒内跑完，无第三方依赖
```

测试分两套，都不需要浏览器或真实应用：

- **`packages/dsh-notice/test/client.test.mjs`（26 条）** 用 `node:vm` 复刻了一个渲染进程式的
  Realm：在里面真实执行发布态的 `lib/client.js`，捕获 `window.__ModuleLoader__.load` 的调用，
  挂到一个假的 Cordis 上下文上，然后驱动会话状态投影走各种跃迁，断言"该提醒的提醒、该安静的
  安静"。状态文案、子代理过滤、前台抑制、语言选择、权限缺失降级、卸载时的反订阅都在覆盖范围内。
- **`test/plugin.test.mjs`（14 条）** 拿临时目录当 profile，端到端跑安装脚本：链接能不能被解析、
  重复安装是否幂等、备份是否只在真正改动时产生、卸载后配置文件是否原样、把仓库挪走后能不能
  自我修复。

改完 `lib/client.js` 想在应用里验证的话，**重启应用**（HMR 默认只监视配置文件，不监视模块文件）。

贡献流程和设计红线见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

## 目录结构

```
DshNotice/
├── README.md                           # 中文说明（默认）
├── README.en.md                        # English
├── plugin.mjs                          # 安装 / 卸载 / 状态，唯一的入口脚本
├── package.json                        # 工作区脚本：npm test、npm run plugin:install 等
├── test/plugin.test.mjs                # 14 条安装脚本用例
├── .github/workflows/ci.yml            # CI：Node 20 / 22 / 24 跑测试
├── packages/dsh-notice/
│   ├── package.json                    # 声明 dsh.client（platform / inject）与 ./client 导出
│   ├── lib/index.js                    # host 半边（空实现，只为占一行 Loader 行）
│   ├── lib/client.js                   # client 半边（全部逻辑）
│   └── test/client.test.mjs            # 26 条插件用例
├── docs/DSH-PLUGIN-API-REFERENCE.md    # DSH 插件 API 调研笔记
├── CHANGELOG.md
├── CONTRIBUTING.md
└── LICENSE
```

## 许可证

[MIT](LICENSE)
