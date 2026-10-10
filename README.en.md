# DshNotice

> Native **macOS notifications** for the **DeepSeek Harness desktop app** — so a long-running
> agent can call you back when it needs you.

**English** · [简体中文](README.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/WsttXm/DshNotice/actions/workflows/ci.yml/badge.svg)](https://github.com/WsttXm/DshNotice/actions/workflows/ci.yml)
[![Platform](https://img.shields.io/badge/platform-macOS%20%C2%B7%20DSH%20Desktop-lightgrey.svg)](#requirements)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#how-it-works-in-brief)

Leave Harness running a long task in the background and go do something else. When it needs an
approval, asks you a question, or finishes a turn, a banner finds you. Click it and the Harness
window comes back to the front.

```
┌────────────────────────────────────────────────────┐
│  DeepSeek Harness                                  │
│  Approval needed                                   │
│  "Refactor login flow" wants to run bash.          │
│  Return to the app to decide.                      │
└────────────────────────────────────────────────────┘
```

---

## Features

- **Four moments that notify**: an approval request, a question, a plan awaiting review, and a
  finished turn.
- **The notification comes from DeepSeek Harness itself** — its own identity, its own icon, in
  Notification Center, honouring the per-app switches in System Settings. Not a generic banner
  masquerading as Script Editor.
- **It never touches your approvals or answers.** The plugin only reads session state; it hooks no
  request callback, so "the notifier swallowed my approval" cannot happen.
- **Quiet by design.** Subagent work never notifies, and neither does the session you are already
  looking at.
- **Chinese and English copy**, following the application language automatically — or pinned by hand.
- **Zero dependencies, zero build step.** No `npm install`, no bundler; one file is the whole
  feature.
- **Reversible install.** The profile patch is backed up before it is written, and uninstall leaves
  nothing behind.

## Quick start

### Requirements

| | |
|---|---|
| OS | macOS (verified on arm64) |
| App | DeepSeek Harness Desktop, **launched at least once** — the installer writes into `~/.dsh/profiles/desktop`, which the app creates on first launch |
| Runtime | Node.js ≥ 20 (the installer and the tests use Node built-ins only) |

### Three commands

```bash
git clone https://github.com/WsttXm/DshNotice.git
cd DshNotice
node plugin.mjs install        # same as: npm run plugin:install
```

Then go back to the Harness window and press **⌘R** once.

**If you see the "Notifications are on" banner, you are done.** That welcome banner fires only on
first install, and its whole purpose is to let you confirm the chain end to end — including whether
macOS actually draws banners for this app.

> A few seconds of delay after installing is normal: the app watches `cordis.patch.yml` and
> recomposes its plugin tree once the file settles. If a reload still shows nothing, restart the app.

The installer is **idempotent** — running it twice changes nothing — and it **never** touches the
rest of your profile: it appends one marked block that it can recognise again later.

### Confirm it worked

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

Two `yes` lines mean the install is in place.

You can also open DevTools in the Harness window with **⌥⌘I** and fire one yourself:

```js
window.__DSH_NOTICE__.test()              // fire a sample banner now
window.__DSH_NOTICE__.test("complete")    // the "Task finished" variant
window.__DSH_NOTICE__.state()             // permission, attachment, recent banners
```

### Updating

```bash
cd DshNotice
git pull
```

Changes live entirely in `lib/client.js`; restart the Harness app afterwards and you are on the new
version. No reinstall needed.

### Uninstalling

```bash
node plugin.mjs uninstall      # removes the row and the symlink, keeps the backup
```

Then reload the window or restart the app so the client module unloads.

---

## Configuration

Every preference lives in the renderer's `localStorage` (key `dsh-notice:prefs`) and takes effect
**immediately — no reload required**.

### How to change it

Open the console in the Harness window with **⌥⌘I**:

```js
window.__DSH_NOTICE__.set({ sound: false })               // silence the banner sound
window.__DSH_NOTICE__.set({ onComplete: false })          // only tell me when you need me
window.__DSH_NOTICE__.set({ onlyWhenUnfocused: false })   // notify even in the foreground
window.__DSH_NOTICE__.set({ language: "en" })             // pin the copy to English
window.__DSH_NOTICE__.set({ enabled: false })             // turn everything off

window.__DSH_NOTICE__.prefs                               // read the current settings
window.__DSH_NOTICE__.reset()                             // restore the shipped defaults
```

### Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Master switch. `false` silences every channel below |
| `onInteraction` | boolean | `true` | Notify on approval requests, questions, and plan reviews |
| `onComplete` | boolean | `true` | Notify when a turn finishes |
| `sound` | boolean | `true` | Whether the banner plays the system sound |
| `onlyWhenUnfocused` | boolean | `true` | Do **not** notify while the window is frontmost *and* already showing that session |
| `announceOnFirstRun` | boolean | `true` | Show the one-time welcome banner that proves the channel works |
| `language` | `"auto"` \| `"zh"` \| `"en"` | `"auto"` | Copy language; `auto` follows the application UI language |

> `sound` is about this notification itself, not about macOS's "play notification sound" setting.
> Turning it off here does not affect anything else.

### When it notifies

The plugin folds each session's status into an index and reacts only to **transitions**, so
reloading a page never replays old news.

| Transition | Banner |
|---|---|
| A pending approval appears | **Approval needed** — `"<session>" wants to run <tool>. Return to the app to decide.` |
| A pending question appears | **Your answer is needed** — carrying the question text itself |
| A plan awaits review | **Plan awaiting review** — `"<session>" submitted a plan for your approval.` |
| A running turn ends with nothing pending | **Task finished** — `"<session>" finished this turn.` |
| Both at once | Exactly **one** banner, and it is the "needs you" one |

The session name appears only when it earns its place: when the banner is about the session you are
already looking at, the title is not repeated in the body.

### When it deliberately stays quiet

Any one of these suppresses the banner. This is the design, not a bug:

- `enabled` is `false`;
- the channel is off (`onInteraction` / `onComplete`);
- the session is a **subagent** or a blank session — invisible internal work should not interrupt you;
- **the window is frontmost and already showing the notifying session** — the composer is right
  there, and a banner would just be noise. Set `onlyWhenUnfocused` to `false` to drop this rule.

> On top of that, macOS itself usually will not draw a banner while the app is frontmost (it goes
> straight to Notification Center). That is system behaviour, not something the plugin controls.

### Language

The default `language: "auto"` follows the **application's** language. `auto` reads DSH's own locale
service rather than the renderer's `navigator.language`, which is permanently `en-US` inside the
desktop shell and once made a Chinese UI raise English notifications.

To pin it:

```js
window.__DSH_NOTICE__.set({ language: "zh" })   // always Chinese
window.__DSH_NOTICE__.set({ language: "auto" }) // back to following the app
```

When the language looks wrong, `window.__DSH_NOTICE__.state()` tells you which one is in force:
`language` is the copy actually used, `detectedLocale` is what was detected. If they disagree, you
have your answer.

### Manual install (if you would rather not run the script)

The installer only does two simple things:

```bash
# 1. Link the package into the profile so it resolves like a bundled one
ln -s /path/to/DshNotice/packages/dsh-notice \
      ~/.dsh/profiles/desktop/node_modules/dsh-notice
```

```yaml
# 2. Append this row to ~/.dsh/profiles/desktop/cordis.patch.yml
- insert:
    - id: notice
      name: 'dsh-notice'
```

Preferences are per browser storage partition; the desktop window always uses the same partition, so
they persist.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| No banner at all after installing | Press ⌘R to reload the window; if that fails, restart the app. Then run `window.__DSH_NOTICE__.state()` in the console |
| `__DSH_NOTICE__` is undefined | The client module never reached the page. Check that `node plugin.mjs status` reports `yes` twice, then restart the app |
| `status` reports `package linked : broken` | The checkout was moved or deleted, so the symlink points at nothing. Re-run `node plugin.mjs install` from the new location to repair it |
| `state()` shows `attached: false` | The `uiSession` service was not ready — usually the plugin tree is still composing. Wait, or restart |
| `state()` shows `permission` other than `granted` | The notification permission was not obtained; check for a system permission prompt |
| `delivered: true` but nothing on screen | Something blocked it at the OS level. Open System Settings → Notifications → DeepSeek Harness and make sure notifications are allowed and the style is not "None" |
| Nothing while the app is frontmost | System behaviour plus the plugin's foreground suppression (above). `onlyWhenUnfocused: false` only bypasses the second half |
| Copy is English but the UI is Chinese | Pin it with `set({ language: "zh" })`, and please open an issue with the output of `state()` |
| A background session finishing does not notify | Expected; see "When it deliberately stays quiet" |
| Still notifying after uninstall | The window has to be reloaded, or the app restarted, to unload the client module |
| Want to undo a settings change | `window.__DSH_NOTICE__.reset()` restores the default preferences; `node plugin.mjs uninstall` removes the plugin |

To restore the profile configuration itself:

```bash
ls ~/.dsh/profiles/desktop/cordis.patch.yml.dsh-notice-backup-*   # find the backup
cp <backup> ~/.dsh/profiles/desktop/cordis.patch.yml
```

---

## How it works (in brief)

Two halves, under 600 lines in total:

| Half | File | Role |
|---|---|---|
| Host | `packages/dsh-notice/lib/index.js` | A deliberate no-op. Its only job is to make this package a Loader row — `dsh-client-modules` discovers packages declaring `dsh.client` by scanning host-side plugin rows, and without that row the browser half is never served |
| Client | `packages/dsh-notice/lib/client.js` | Everything. Subscribes to the session status projection and calls the Web Notifications API on transitions |

Two decisions worth stating:

- **Web Notifications, not `osascript -e 'display notification'`.** The desktop window runs on the
  `dsh-app://app` origin, and the permission handler the Electron main process installs for that
  origin grants every non-media permission. So `new Notification(...)` is handed to macOS **as
  "DeepSeek Harness"**: its icon, in Notification Center, honouring that app's switches in System
  Settings. An `osascript` notification is attributed to Script Editor, gets a generic icon, and
  cannot focus the app when clicked.
- **Passive observation, no request hooks.** `approval/request` and `user-questions/request` are
  Cordis waterfalls; anything mounted on them can take over the request. This plugin never touches
  either, so it cannot swallow, delay, or mis-answer a request that belongs to you.

Deeper plugin-API research notes live in
[`docs/DSH-PLUGIN-API-REFERENCE.md`](docs/DSH-PLUGIN-API-REFERENCE.md).

---

## Development

```bash
npm test     # 40 cases, finishes in under two seconds, no third-party dependencies
```

There are two suites, and neither needs a browser or the real app:

- **`packages/dsh-notice/test/client.test.mjs` (26 cases)** builds a renderer-like realm with
  `node:vm`, evaluates the *published* `lib/client.js` inside it, captures the
  `window.__ModuleLoader__.load` call, mounts the result against a fake Cordis context, and drives
  the session status projection through the transitions that must and must not notify. Copy,
  subagent filtering, foreground suppression, language selection, degraded delivery without
  permission, and unsubscribe-on-dispose are all covered.
- **`test/plugin.test.mjs` (14 cases)** runs the installer end to end against throw-away profiles:
  whether the link resolves, whether a repeated install is a no-op, whether a backup is written only
  when the patch really changes, whether uninstall restores the file byte for byte, and whether a
  moved checkout repairs itself.

After editing `lib/client.js`, **restart the app** to see it live — HMR watches configuration files
only, not module sources.

Contribution workflow and design red lines: [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Layout

```
DshNotice/
├── README.md                           # Chinese docs (the default)
├── README.en.md                        # English docs
├── plugin.mjs                          # install / uninstall / status — the only entry script
├── package.json                        # workspace scripts: npm test, npm run plugin:install, …
├── test/plugin.test.mjs                # 14 installer cases
├── .github/workflows/ci.yml            # CI: tests on Node 20 / 22 / 24
├── packages/dsh-notice/
│   ├── package.json                    # declares dsh.client (platform / inject) and the ./client export
│   ├── lib/index.js                    # host half (a no-op that occupies the Loader row)
│   ├── lib/client.js                   # client half (all of the logic)
│   └── test/client.test.mjs            # 26 plugin cases
├── docs/DSH-PLUGIN-API-REFERENCE.md    # DSH plugin API research notes
├── CHANGELOG.md
├── CONTRIBUTING.md
└── LICENSE
```

## License

[MIT](LICENSE)
