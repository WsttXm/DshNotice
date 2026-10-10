> **版本提示：** 本文基于 npm 上 `@deepseek-ai/*` 的 **0.1.5-rc.2**（2026-09-18）提取树整理；本机安装的桌面版是 **0.2.0-rc.2**，个别标识符可能已变化。文中凡是本插件实际依赖的接口，都已用 0.2.0-rc.2 的 `app.asar` 复核过。
>
> 这是本项目的调研笔记，不是 DeepSeek 官方文档。代码片段摘自上述 npm 包，仅用于说明接口形状，版权归原作者所有。

# DSH host-side plugin authoring reference

**Source of truth:** the extracted npm tree at
`<npm cache>/node_modules/@deepseek-ai/`
(241 packages, version **0.1.5-rc.2**). The installed desktop app is 0.2.0-rc.2, so
anything below is *0.1.5-rc.2 behaviour* unless stated. Every snippet is copied
verbatim from `lib/*.js`, `lib/types/*.d.ts`, or `README.md` in that tree.

The single richest source of truth is the shipped **`.d.ts`** files: every
package that extends cordis does so with declaration merging, e.g.
`declare module '@deepseek-ai/cordis' { interface Events { ... } }` and
`declare module '@deepseek-ai/cordis' { interface Context { ... } }`. Grepping
`interface Events` / `interface Context` across `**/*.d.ts` gives the complete
event + service surface.

---

## 1. Plugin module shape

### 1.1 The three accepted shapes

`cordis/lib/types/registry.d.ts`:

```ts
/** Supported plugin entrypoint shapes. */
export type Plugin<T = any> = Plugin.Function<T> | Plugin.Constructor<T> | Plugin.Object<T>;

export namespace Plugin {
    interface Base<T = any> {
        /** Display name used for fiber diagnostics and logger names. */
        name?: string;
        /** Standard-schema validator applied to config before the plugin starts. */
        Config?: StandardSchemaV1<any, T>;
        /** Services the plugin requires; it only loads while all are available. */
        inject?: Inject;
        /** Service name(s) the plugin provides (read by `Service` and by loaders). */
        provide?: string | string[];
        /** Service names whose intercept config the plugin declares it consumes. */
        intercept?: Dict<boolean>;
    }
    interface Function<T = any> extends Base<T> { (ctx: Context, config: T): any; }
    interface Constructor<T = any> extends Base<T> { new (ctx: Context, config: T): any; }
    interface Object<T = any> extends Base<T> { apply(ctx: Context, config: T): any; }
}
```

Resolution is literally `typeof plugin === 'function' ? plugin : plugin.apply`
(`cordis/lib/index.js:1532`), and the metadata is read straight off the object
you pass (`cordis/lib/index.js:1618-1634`):

```js
plugin(plugin, config, getOuterStack = buildOuterStack()) {
    const callback = this.resolve(plugin);
    if (!callback) throw new Error("invalid plugin, expect function or object with an \"apply\" method, received " + typeof plugin);
    ...
    let name = plugin.name;
    if (name === "apply") name = void 0;
    runtime = { name, callback, fibers: new DisposableList(), Config: plugin.Config };
    ...
    const fiber = new Fiber(this.ctx, config, Inject.resolve(plugin.inject), runtime, getOuterStack);
```

**Consequence:** because the DSH loader imports a package's ESM module namespace
and passes it to `ctx.plugin()`, a package whose module namespace has named
exports `name`, `Config`, `inject`, `apply` works directly. That is the DSH
convention.

### 1.2 Shape A — function/object plugin with named exports (`dsh-tool-todo`)

`dsh-tool-todo/lib/index.js` (verbatim, 196 lines total):

```js
import z from "@deepseek-ai/schemastery";
import { z as z$1 } from "zod";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region lib/types/index.js
/**
* Model-facing whole-list replacement. ... Named exports preserve loader injection metadata.
* @module @deepseek-ai/dsh-tool-todo
*/
const name = "tool-todo";
const inject = ["tools", "sessionProjections"];
/** The valid {@link TodoItem} statuses, as a runtime set for input narrowing. */
const STATUSES = [ "pending", "in_progress", "completed" ];
/** Schemastery configuration for the todo tool consumer. */
const Config = z.object({ allowParallelInProgress: z.boolean().required() });
...
function apply(ctx, config) {
	const allowParallel = config.allowParallelInProgress;
	ctx.sessionProjections.register({ ... });
	ctx.tools.register(defineTool({ name: "todo_write", ... }));
}
//#endregion
export { Config, apply, inject, name };
```

Note the explicit comment: **"Named exports preserve loader injection metadata."**
This is the canonical minimal shape.

### 1.3 Shape B — `Service` subclass as default export (`dsh-credentials`)

`dsh-credentials/lib/index.js`:

```js
import { Service } from "@deepseek-ai/cordis";
...
var CredentialProvider = class extends Service {
	constructor(ctx) {
		super(ctx, "credentials");
	}
	notifyUpdated(ref) { this.fanOut("credentials/reference-updated", ref); }
	notifyRecordUpdated(key) { this.fanOut("credentials/record-updated", key); }
	...
};
//#endregion
export { CredentialProvider, CredentialProvider as default, credentialKey, credentialKeyId, credentialKeyScope, credentialRef, isCredentialKeySegment, isCredentialRefName, parseCredentialKey };
```

Because the module namespace also has `default`, and the loader convention is to
name the class export, both work: `export default CredentialProvider` and
`export { CredentialProvider as default }` plus the named alias.

### 1.4 Shape C — `Service` subclass with `static Config` (`dsh-user-approval`)

`dsh-user-approval/lib/index.js`:

```js
var ApprovalService = class extends Service {
	config;
	static Config = z.object({ policy: z.union(["ask", "never"]).default("ask") });
	constructor(ctx, config) {
		super(ctx, "approval");
		this.config = config;
		const effective = (agent) => this.effectivePolicy(agent.session);
		ctx.inject(["systemPrompt"], (scope) => {
			scope.systemPrompt.context({ name: "approval:policy", order: scope.systemPrompt.getContextOrder("APPROVAL_POLICY"), text: (context) => { ... } });
		});
	}
	...
};
//#endregion
export { APPROVAL_POLICIES, ApprovalRequestId, ApprovalService, ApprovalService as default, setApprovalPolicy };
```

### 1.5 Config schema: schemastery (not zod) for plugin/settings config

Two libraries are in play and the split is consistent across the tree:

| Purpose | Library | Example |
|---|---|---|
| Plugin `Config`, settings namespace schema | `@deepseek-ai/schemastery` | `z.object({ allowParallelInProgress: z.boolean().required() })` |
| Tool parameter/output schemas, wire/projection payloads | `zod` (`import { z } from "zod"`) | `z$1.union([z$1.array(...), z$1.null()])` |

cordis enforces only `StandardSchemaV1` (`cordis/lib/index.js:955`):

```js
function resolveConfig(runtime, config) {
	if (!runtime.Config) return config;
	const result = runtime.Config["~standard"].validate(config);
	if ("then" in result) throw new TypeError("Async config validation is not supported");
	if (result.issues) throw new ValidationError(result.issues);
	else return result.value;
}
```

Both schemastery 3.18.2 and zod 4 implement `~standard`, so both technically
work, but **every** in-tree `Config` uses schemastery. Schemastery API seen in
real configs: `z.object({...})`, `z.string()`, `z.number()`, `z.boolean()`,
`z.array(x)`, `z.dict(x)`, `z.union([...])`, `z.const(x)`, `.default(v)`,
`.required()`, `.min(n)`, `.max(n)`, `.step(n)`. Real example
(`dsh-agent-loop/lib/index.js`):

```js
	agents: z.array(z.object({
		id: z.string().required(),
		provider: z.string(),
		model: z.string(),
		reasoningEffort: z.string().min(1),
		maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
		cwd: z.string(),
		resumeSessionId: z.string()
	})).default([])
```

### 1.6 `package.json` fields DSH requires

The `dsh` key is **optional for a plain plugin** — none of
`dsh-tool-todo`, `dsh-user-approval`, `dsh-credentials`, `dsh-schedule`,
`dsh-jobs-local` declare it. The full `dsh` schema
(`dsh-package-manifest/lib/types/types.d.ts`) is:

```ts
export interface DshManifest {
    bundle?: DshBundleManifest;      // { patch: string }
    profile?: DshProfileManifest;    // { bundles?: string[]; patchReload?: 'live' | 'startup' }
    client?: DshClientManifest;      // { platform: string; inject?: string[]; immediately?: boolean; external?: string[] }
    configTrees?: DshConfigTreeDeclaration[];
    sessionFormatMigration?: DshSessionFormatMigrationManifest;
    moduleFallback?: DshModuleFallbackManifest; // @internal, launcher-generated
}
export interface DshBundleManifest { patch: string; }   // path relative to the package root
```

The npm fields that matter (`dsh-tool-todo/package.json`, verbatim):

```json
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./invariant": { "types": "./lib/types/invariant.d.ts", "default": "./lib/invariant.js" },
    "./client": { "types": "./lib/types/client.d.ts", "default": "./lib/types/client.js" },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "files": [ "lib/index.js", "lib/invariant.js", "lib/types/**/*.js", "lib/types/**/*.d.ts" ],
  "license": "MIT",
  "dependencies": { "zod": "^4.4.3", "@deepseek-ai/schemastery": "^3.18.2" },
  "peerDependencies": {
    "@deepseek-ai/dsh-agent": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-invariants": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-session": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-session-projection": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-tools": "^0.1.5-rc.2",
    "@deepseek-ai/cordis": "^4.0.2"
  }
```

Key points:
* `"@deepseek-ai/cordis": "^4.0.2"` is a **peerDependency** in every plugin
  package. DSH does not bundle a second cordis instance.
* Every DSH capability package you touch (`dsh-agent`, `dsh-session`,
  `dsh-tools`, …) is declared as a **peerDependency** too, with the matching
  `devDependencies` entry for local type-checking.
* The loader imports the package by name; `exports["."]` must resolve to the
  built ESM entry.

### 1.7 Minimal complete host plugin package

`package.json`:

```json
{
  "name": "@your-scope/dsh-notice",
  "version": "0.1.0",
  "description": "…",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./package.json": "./package.json"
  },
  "files": ["lib/index.js", "lib/types/**/*.d.ts"],
  "license": "MIT",
  "dependencies": { "@deepseek-ai/schemastery": "^3.18.2" },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.2",
    "@deepseek-ai/dsh-agent": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-session": "^0.1.5-rc.2"
  }
}
```

`lib/index.js` (a runnable, self-contained shape — every API used here is
verified in §2/§3/§4):

```js
import z from '@deepseek-ai/schemastery'

/** Loader metadata: logger/fiber name, required services, validated config. */
export const name = 'notice'
export const inject = ['agents']

export const Config = z.object({
  /** Report every agent that reaches idle. */
  reportIdle: z.boolean().default(true),
})

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {z.infer<typeof Config>} config
 */
export function apply(ctx, config) {
  ctx.logger.info('notice: starting with %o', config)

  // Listener + cleanup, both owned by this plugin's fiber.
  ctx.effect(
    () => ctx.on('agent/status', ({ agent, status }) => {
      if (!config.reportIdle || status !== 'idle') return
      ctx.logger.info('agent %s is idle', agent.id)
    }),
    'notice: agent/status',
  )
}
```

---

## 2. Lifecycle / context API

### 2.1 `ctx` composition

A context is a proxy over a service store; `ctx.on`, `ctx.emit`, `ctx.parallel`,
`ctx.serial`, `ctx.bail`, `ctx.waterfall`, `ctx.get`, `ctx.set`, `ctx.provide`,
`ctx.accessor`, `ctx.mixin`, `ctx.inject`, `ctx.plugin`, `ctx.runtime`,
`ctx.effect` are **mixins** installed by cordis core
(`cordis/lib/index.js`, `ReflectService` constructor:
`this.mixin("reflect", ["get","set","provide","accessor","mixin"])`,
`this.mixin("fiber", ["runtime","effect"])`,
`this.mixin("registry", ["inject","plugin"])`,
`this.mixin("events", ["on","once","parallel","emit","serial","bail","waterfall"])`).

### 2.2 Event dispatch modes

`cordis/lib/types/events.d.ts`:

```ts
export type DispatchMode = 'emit' | 'parallel' | 'serial' | 'bail' | 'waterfall';
```

| Call | Semantics (verbatim from the JSDoc) |
|---|---|
| `ctx.emit(name, ...args)` | "Dispatch an event synchronously, ignoring listener return values." |
| `ctx.parallel(name, ...args)` | "Dispatch an event, running all listeners concurrently." → `Promise<void>` |
| `ctx.serial(name, ...args)` | "awaiting listeners in order until one bails." |
| `ctx.bail(name, ...args)` | "calling listeners in order until one bails." |
| `ctx.waterfall(name, ...args, next)` | "Each listener wraps the rest of the chain: calling `next()` invokes the next listener (finally the built-in behavior); **not calling it vetoes**." |

Every mode has an overload taking an explicit `thisArg` first — this is what
**agent-scoped dispatch** uses (`ctx.waterfall(scopeTarget(agent, agent), 'approval/request', req, next)`).

`ctx.on` returns a disposer and registers through `ctx.fiber.effect`, so it is
automatically removed on unload:

```ts
on<K extends keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean;
once<K extends keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean;

export interface EventOptions {
    prepend?: boolean;   // Add the listener before existing listeners for the same event.
    global?: boolean;    // Receive the event regardless of context filter checks.
}
```

### 2.3 `ctx.effect` — the cleanup primitive

`cordis/lib/types/fiber.d.ts`:

```ts
export type Disposable<T = any> = () => T;
export type Effect<T = any> = SyncEffect<T> | AsyncEffect<T>;

/**
 * Register a cleanup-aware effect on this fiber.
 *
 * `execute` runs immediately; the disposers it produces are collected and
 * run (in reverse order) either when the returned disposer is called or
 * when the fiber unloads, whichever comes first. Calling the disposer twice
 * is a no-op. Throws `CordisError('INACTIVE_EFFECT')` if the fiber is
 * already disposed, and `TypeError` if `execute` returns an invalid shape.
 */
effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>;
effect(execute: () => Effect, label?: string): AsyncDisposable<Promise<void>>;
```

Label convention in the tree is `"<plugin>: <what>"`, e.g.
`"api-remotes: forwarded Cordis event source"`, `"agentLoop.transactions()"`,
`"ui-goal: dictionaries"`. Labels show up in `fiber.getEffects()` diagnostics.

Real usage (`dsh-user-approval` uses `ctx.inject` for a later-bound service;
`dsh-schedule`/`dsh-tools` use plain `ctx.effect`):

```js
ctx.effect(() => ctx.agents.setFactory(this), "agentLoop.setFactory()");
ctx.effect(() => ctx.fileUploads.registerAgentResolver(async (sessionId) => { ... }), "session-controller: file-upload Agent resolver");
```

### 2.4 `inject` — declaring service dependencies

Two forms (`cordis/lib/types/registry.d.ts`):

```ts
export type Inject<M = Dict> = (keyof M)[] | { [K in keyof M]?: M[K] };
```

1. **Static, on the plugin object** — `export const inject = ['tools', 'sessionProjections']`.
   The fiber stays `PENDING` until every named service is provided, and unloads
   when one goes away. This is the normal host-plugin form.
2. **Imperative, `ctx.inject(deps, callback)`**:
   ```ts
   /**
    * Run a callback once the requested services are available.
    *
    * Shorthand for `ctx.plugin({ inject, apply: callback })`: the callback
    * is unloaded and re-run whenever a required service changes.
    */
   inject(deps: Inject, callback: Plugin.Function<void>): Fiber & PromiseLike<Fiber>;
   ```
   Real usage, `dsh-user-approval`:
   ```js
   ctx.inject(["systemPrompt"], (scope) => {
       scope.systemPrompt.context({ name: "approval:policy", order: scope.systemPrompt.getContextOrder("APPROVAL_POLICY"), text: (context) => { ... } });
   });
   ```
   This is the idiomatic way to consume an *optional* service without making it
   a hard dependency of the whole plugin.

### 2.5 `ctx.get` / `ctx.set` / `ctx.provide`

```ts
/**
 * Read a service from the store without the inject requirement.
 * @param name — the service name.
 * @param strict — when `true` (default), only return implementations whose providing fiber is currently active.
 */
get<K extends string & keyof this>(name: K, strict?: boolean): undefined | this[K];
get(name: string, strict?: boolean): any;

/**
 * Overwrite a provided service's value.
 * Only the fiber that provided the service may set it; setting an unprovided name throws.
 */
set<K extends string & keyof this>(name: K, value: undefined | this[K]): void;

/**
 * Register a service implementation owned by the current fiber.
 * ... it is unregistered (waking dependents) when the returned disposer runs or the fiber unloads.
 * Throws if the name is already provided in this scope or declared as an accessor.
 */
provide<K extends string & keyof this>(name: K, value: undefined | this[K]): () => void;
```

`ctx.get('name')` for an optional service is used pervasively, e.g.
`dsh-tools/lib/index.js:3314`:

```js
async serviceAsk(exec, ask) {
    const approval = this.ctx.get("approval");
    if (approval === void 0) return { decision: { kind: "deny", reason: ... }, approvalCancelled: false };
```

Real `ctx.provide` (`dsh-cmdline/lib/index.js:29-31`):

```js
	ctx.provide("cmdlineArgs", { get: () => snapshot });
	ctx.provide("appExit", host.exit);
	if (host.ready !== void 0) ctx.provide("appReady", host.ready);
```

`ctx.set` had **no** in-tree call site outside cordis itself in this snapshot —
it exists for a provider to update its own service value. I could not confirm a
real DSH consumer of `ctx.set`.

### 2.6 `ctx.logger`

`cordis/lib/types/logger.d.ts`:

```ts
export interface LoggerMethod { (format: any, ...param: any[]): void }
export type LoggerType = 'error' | 'info' | 'warn' | 'debug';
export interface LoggerService extends Record<LoggerType, LoggerMethod> {
    (name?: string): Logger;
}
```

"Call `ctx.logger()` to create a named logger, or call `ctx.logger.info()`
directly to log with the current fiber-derived name." printf-style placeholders
are supported (`%s`, `%o`, `%d`). Real usage:

```js
this.ctx.logger.warn("credentials: a %s listener for \"%s\" failed", event, subject);
ctx.logger.warn(`agent event "${name}" listener rejected: ${String(error)}`);
```

### 2.7 `Service` base class

```ts
export declare abstract class Service<out T = never> {
    static readonly init: unique symbol;
    static readonly check: unique symbol;
    static readonly config: unique symbol;
    static readonly invoke: unique symbol;
    static readonly extend: unique symbol;
    static readonly tracker: unique symbol;
    static readonly resolveConfig: unique symbol;
    name: string;
    /**
     * Register this instance as `name` in the current context.
     * Calls `ctx.reflect.provide(name, this, this[Service.check])`, so the
     * service is unregistered automatically when the owning fiber unloads.
     */
    constructor(ctx: Context, name: string);
}
```

`[Service.init]` is an async-initialisation hook. `dsh-settings/lib/index.js:246`:

```js
	async *[Service.init]() {
		yield async () => {
			this.stopped = true;
			await Promise.allSettled([...this.writeQueues.values(), ...this.pendingTails]);
		};
		this.publish(await this.load());
	}
```

Providers with their own init "delegate here first via `yield* super[Service.init]()`".

### 2.8 Unload / cleanup

* `ctx.plugin(plugin, config)` returns `Fiber & PromiseLike<Fiber>`; `fiber.dispose()`
  is "Dispose this fiber: unload the plugin, then settle once cleanup finished."
* Unload runs **all** disposers in reverse registration order; async disposers
  are awaited (`fiber.dispose(): Promise<void>`, `FiberState.UNLOADING`).
* Everything registered through `ctx.effect`, `ctx.on`, `ctx.provide`,
  `ctx.accessor`, `ctx.mixin`, `ctx.inject`, `ctx.plugin` is fiber-owned and
  removed automatically.
* `fiber.update(config, noSave?)` re-validates and restarts the plugin with new
  config; `fiber.restart()` disposes and reloads.
* Loader-driven unload emits `internal/plugin(fiber)` and `internal/status(fiber, oldValue)`.

---

## 3. Agent lifecycle events

All `agent/*` events are declared in
`dsh-agent/lib/types/runtime-types.d.ts` inside
`declare module '@deepseek-ai/cordis' { interface Events { ... } }`.
**`agent/*` events are agent-scoped**: their `this` is `Scoped<Agent>`, so a
listener registered on `agent.ctx` sees only that agent. The dispatcher is
`agentEvents(ctx, agent)` in `dsh-agent/lib/types/dispatch.js`:

```js
export function agentEvents(ctx, agent, carrier = agentCarrier(agent)) {
    const fused = (payload) => ({ ...payload, agent });
    return {
        emit(name, payload) {
            const args = [carrier, name, fused(payload)];
            const callbacks = ctx.events.dispatch('emit', args);
            for (const callback of callbacks) {
                try {
                    const returned = callback(...args);
                    void Promise.resolve(returned).catch((error) => {
                        ctx.logger.warn(`agent event "${name}" listener rejected: ${String(error)}`);
                    });
                }
                catch (error) {
                    ctx.logger.warn(`agent event "${name}" listener threw: ${String(error)}`);
                }
            }
        },
        async serial(name, payload) { return await ctx.serial(carrier, name, fused(payload)); },
        waterfall(name, payload, ...rest) { return ctx.waterfall(carrier, name, fused(payload), ...rest); },
    };
}
```

Note: the `agent` field is **injected** by the dispatcher, so a listener
declaration's payload type omits it and the runtime payload always has it.

### 3.1 The complete `agent/*` vocabulary

| Event | Mode | Payload (beyond the injected `agent: Agent`) | Emitted at |
|---|---|---|---|
| `agent/created` | emit | `{ agent }` | `dsh-agent/lib/index.js:543` (registry `announce`) |
| `agent/disposed` | emit | `{ agent }` | `dsh-agent/lib/index.js:516` |
| `agent/status` | emit | `{ agent, status: 'idle' \| 'running' }` | `dsh-agent-loop/lib/index.js:781` |
| `agent/session-start` | emit | `{ agent, source: SessionStartSource }` | agent-loop creation path |
| `agent/inbox/inserted` | emit | `{ agent, message: UserMessage }` | `dsh-agent-loop/lib/index.js:208` |
| `agent/inbox/claimed` | emit | `{ agent, message: UserMessage, turn: number }` | `dsh-agent-loop/lib/index.js:107` |
| `agent/inbox/discarded` | emit | `{ agent, message: UserMessage }` | `dsh-agent-loop/lib/index.js:207` |
| `agent/pre-step` | **waterfall** | `{ agent, messages: UserMessage[], turn, step, signal: AbortSignal }` → `PreStepDecision` | `dsh-agent-loop/lib/index.js:894` |
| `agent/request` | **waterfall** | `{ agent, turn, step, signal }` → `LlmCallConfig` | `dsh-agent-loop/lib/index.js:1143` |
| `agent/request-error` | **waterfall** | `{ agent, turn, step, provider, failure: LlmFailure, retryPolicy, signal }` → `{ kind: 'retry' } \| undefined` | `dsh-agent-loop/lib/index.js:1088` |
| `agent/assistant-stream` | emit | `{ agent, frame: AssistantStreamFrame }` | `dsh-agent-loop/lib/index.js:1032` |
| `agent/turn-stopping` | **serial** | `{ agent, turn, signal }` | `dsh-agent-loop/lib/index.js:967` |
| `agent/error` | emit | `{ agent, turn, step, error: unknown }` | `dsh-agent-loop/lib/index.js:863` |

Verbatim declarations for the interception points:

```ts
        /**
         * Reject a proposed step or replace the messages that enter it. Calling
         * `next()` preserves the current messages.
         * @mode waterfall
         */
        'agent/pre-step'(this: Scoped<Agent>, payload: {
            agent: Agent;
            messages: UserMessage[];
            turn: number;
            step: number;
            signal: AbortSignal;
        }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>;

        /**
         * The turn is about to close: the model owes no response (no live tool
         * calls, no fresh steering). Awaited before the boundary commits — a
         * listener that objects steers (`agent.steer(...)`) and the machine
         * re-reads its inbox: fresh steering runs another step, none closes the
         * turn. Data decides, so listener order cannot change the outcome.
         * @mode serial
         */
        'agent/turn-stopping'(this: Scoped<Agent>, payload: {
            agent: Agent;
            turn: number;
            signal: AbortSignal;
        }): Promise<void> | void;

        /**
         * A step or turn errored. The machine reports a failure here even when
         * the error has no in-turn position for a durable record.
         * @mode emit
         */
        'agent/error'(this: Scoped<Agent>, payload: {
            agent: Agent;
            turn: number;
            step: number;
            error: unknown;
        }): void;
```

`PreStepDecision` and `AgentStatus`:

```ts
/** Whether and with which messages the loop enters a proposed step. */
export type PreStepDecision = { kind: 'reject'; } | {
    kind: 'enter';
    messages: UserMessage[];
    /** Start a distinct model-message series before this step's admitted messages. */
    startsRequestSeries?: true;
};

/**
 * An agent's lifecycle state, emitted on every transition as `agent/status`:
 * `idle` means no driver is active; `running` begins when waking input starts
 * cancellable pre-step processing and lasts while the driver drains,
 * closes, or checkpoints turns. Disposal removes the agent from its registry;
 * it is not a third observable status.
 */
export type AgentStatus = 'idle' | 'running';
```

**"A session going idle" == `agent/status` with `status: 'idle'`.**
**"The agent loop finishing" == the same** (`fiber`/`handle.dispose()` is
separate). There is no `agent/idle` or `agent/turn-end` cordis event —
turn/step boundaries are *durable session events* (§3.3).

### 3.2 Tool-call lifecycle

`dsh-tools/lib/types/index.d.ts`, `interface Events`:

| Event | Mode | Signature |
|---|---|---|
| `tools/pre-execute` | waterfall | `(exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>` — "Allow, deny, or ask before dispatch. `next()` delegates to allow; missing approval support turns `ask` into denial." |
| `tools/execute` | waterfall | `(exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>) => Promise<ToolExecutionResult>` — "Around-dispatch waterfall for timeout, retry, or metrics." |
| `tools/post-execute` | waterfall | `(exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>) => Promise<PostToolDecision>` |
| `tools/ptc-dispatch-log` | waterfall | `(dispatch: PtcDispatchLog, next: () => Promise<ContentBlock[]>) => Promise<ContentBlock[]>` |
| `tools/result` | emit | `(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => undefined` — "Observe the frozen, lossless-JSON final outcome." |
| `tools/change` | emit | `() => void` — "A tool was registered or unregistered, or a scoped restriction changed" (**unfiltered registry-subject notification**) |

`ToolExecution` (the payload of pre/post-execute):

```ts
export interface ToolExecutionInput {
    readonly callId: ToolCallId;
    readonly rootCallId?: ToolCallId;
    readonly name: string;
    readonly arguments: unknown;
    readonly agent?: Agent;
    readonly parent?: ToolExecutionToken;
    readonly signal: AbortSignal;
}
export interface ToolExecution extends ToolExecutionInput {
    readonly rootCallId: ToolCallId;
    readonly token: ToolExecutionToken;
}
```

Emit sites: `tools/change` at `dsh-tools/lib/index.js:2593`, `tools/pre-execute`
at `:3116`, `tools/execute` at `:3213`, `tools/post-execute` at `:3378`,
`tools/ptc-dispatch-log` at `:2971`.

**There is no plain `tool/call-start` / `tool/call-end` emit.** The closest
"tool call started" observation points are `tools/pre-execute` (before dispatch)
and `tools/result` (after), plus the durable `tool/call` / `tool/result` session
events.

### 3.3 Durable session events (the `session/*` + `turn/*` + `step/*` taxonomy)

Declared in `dsh-session/lib/types/types.d.ts` as
`export interface SessionEventMap { ... }` (merge-extensible — plugins add their
own keys with `declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { ... } }`).

```ts
    /**
     * Opens turn `turn` before the loop claims queued input or runs pre-step.
     * ...
     */
    'turn/start': { turn: number; };
    /**
     * Closes turn `turn` with the {@link TurnEndReason} that ended it. A turn
     * with no entered step has no `step/start` or `step/end`. ...
     */
    'turn/end': { turn: number; reason: TurnEndReason; };
    /** Opens step `step` of turn `turn` — one model call plus the tool executions it requested. */
    'step/start': { turn: number; step: number; };
    /** Closes step `step` of turn `turn`. */
    'step/end': { turn: number; step: number; };
    'user/message': UserMessage;
    'system/message': { turn: number; step: number; message: SystemMessage; };
    'assistant/message': { turn: number; step: number; message: AssistantMessage; stream: AssistantStreamRecord[]; usage?: TokenUsage; interrupted?: true; };
    'assistant/attempt': { turn: number; step: number; stream: AssistantStreamRecord[]; };
    'tool/call': { turn: number; step: number; callId: ToolCallId; name: string; arguments: string; };
    'tool/result': { turn: number; step: number; message: ToolResultMessage; error?: { name: string; code: string; }; meta?: JsonValue; };
    'request/header': { header: EpochHeader; reason: RequestHeaderReason; startsSeries?: true; };
    'request/context': RequestContext;
    'session/end-seed': { inherited?: true; };
```

`TurnEndReason` (`TurnEndReasonMap`):

```ts
export interface TurnEndReasonMap {
    completed: { kind: 'completed'; };
    /** A cancellation request interrupted the live turn. */
    aborted: { kind: 'aborted'; reason: TurnEndCancelCause; };
    blocked: { kind: 'blocked'; };
    /**
     * The turn failed. `error` is always a structured failure: the `LlmError`
     * facts verbatim, or `{ message: errorChain(error), code: 'UNKNOWN' }`
     * flattened from any other error.
     */
    error: { kind: 'error'; error: LlmFailure; };
    /** At least one step reached its output-token ceiling, even if a plugin continued the turn. */
    'max-tokens': { kind: 'max-tokens'; };
    interrupted: { kind: 'interrupted'; };
}
```

`AgentCancelCause`:

```ts
export type AgentCancelCause = { readonly kind: 'user'; } | { readonly kind: 'parent'; }
    | { readonly kind: 'hook'; readonly reason: string; } | { readonly kind: 'disposed'; };
```

Emit (append) sites, all in `dsh-agent-loop/lib/index.js`:
`turn/start` :926 · `step/start` :951 · `step/end` :960 · `turn/end` :994 ·
`user/message` :1028 · `assistant/message` :1050 and :1108 · `assistant/attempt` :1085 ·
`tool/call` :688 (`appendToolCall`) · `tool/result` :703 (`appendToolResult`).

The **cordis** `session/*` events (a different namespace — live notifications,
not log entries) are in `dsh-session/lib/types/index.d.ts`:

```ts
        'session/created'(this: Scoped<Session>, session: Session): void;
        'session/disposed'(this: Scoped<Session>, session: Session): void;
        /**
         * Post-commit, fire-and-forget append feed. ...
         * @mode emit
         */
        'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void;
        /**
         * Awaited parallel durability checkpoint ...
         * @mode parallel
         */
        'session/flush'(this: Scoped<Session>, session: Session): Promise<void> | void;
```

**`ctx.on('session/event', (session, event) => …)` is the single cheapest way to
observe every durable fact (turns, steps, tool calls, approvals, goal changes).**

### 3.4 Host→client forwarding events (`api-session/*`)

`dsh-api-session-controller` re-emits agent/session facts under a
session-id-keyed, client-safe namespace (`dsh-api-session-controller/lib/index.js:2750-2782`):

```js
			ctx.on("session/created", (session) => {
				ctx.emit("api-session/added", this.listState.summaryFor(session));
			});
			ctx.on("session/disposed", (session) => {
				ctx.emit("api-session/removed", session.id);
			});
			ctx.on("agent/status", ({ agent, status }) => {
				ctx.emit("api-session/status", agent.id, status === "running");
			});
			ctx.on("agent/error", ({ agent, error }) => {
				ctx.emit("api-session/error", agent.id, errorChain(error));
			});
			ctx.on("session/event", (session, event) => {
				...
				if (event.type !== "user/message" || event.data.source.kind !== "user") return;
				ctx.emit("api-session/activity", session.id, event.time);
			});
```

Declarations:

```ts
        'api-session/added'(summary: SessionSummary): void;
        'api-session/removed'(sessionId: SessionId): void;
        'api-session/status'(sessionId: SessionId, running: boolean): void;
        'api-session/activity'(sessionId: SessionId, updatedAt: number): void;
        'api-session/error'(sessionId: SessionId, message: string): void;
```

---

## 4. User-interaction points (the "agent needs the user" hooks)

There are exactly **two** hosted "ask the human" waterfalls in 0.1.5-rc.2. Both
are agent-scoped **waterfalls** — you answer by returning a value from a
listener, which claims the request; calling `next()` delegates further down the
chain.

### 4.1 Approvals — `@deepseek-ai/dsh-user-approval`

**Service:** `ctx.approval` (`super(ctx, "approval")`).
Config: `z.object({ policy: z.union(["ask", "never"]).default("ask") })`.

**Public API** (`dsh-user-approval/lib/index.js`):

```js
	async request(req) {
		const session = req.agent.session;
		if (!hasOpenTurn(session)) throw new Error("approval.request() outside an open turn: the approval/asked + approval/decided audit pair must be turn-enclosed (a bare event between turns is crash-tail garbage on reload). Ask from inside the turn that needs the decision.");
		const id = ApprovalRequestId(randomUUID());
		session.append("approval/asked", {
			id,
			toolName: req.toolName,
			...req.callId !== void 0 ? { callId: req.callId } : {},
			...req.reason !== void 0 ? { reason: req.reason } : {}
		});
		const outcome = await this.decide(req, session);
		session.append("approval/decided", { id, outcome });
		return outcome;
	}
```

Also: `setPolicy(agent, policy)`, `effectivePolicy(session)`, `overrideOf(session)`,
and the free functions `setApprovalPolicy(session, policy)`,
`ApprovalRequestId(id)`. Exported constants `APPROVAL_POLICIES = ["ask", "never"]`,
`OUTCOMES = ["allowed-once", "rejected", "cancelled", "unavailable"]`.

**The answerer event** — `approval/request`, declared in
`dsh-user-approval/lib/types/types.d.ts`:

```ts
/** Client-safe payload declared for the approval answerer waterfall. */
export interface ApprovalRequestEvent {
    /** Agent identity projected to the corresponding Client Context in transit. */
    readonly agent: Agent;
    /** Tool whose operation requires a decision. */
    readonly toolName: string;
    /** Exact tool call being decided, when available. */
    readonly callId?: ToolCallId;
    /** Human-readable reason supplied by the asker. */
    readonly reason?: string;
    /** Cancellation lifetime of the pending request. */
    readonly signal?: AbortSignal;
}
declare module '@deepseek-ai/cordis' {
    interface Events {
        /**
         * Ask composed answerers for one decision. Return an outcome to claim the
         * request or call `next()` to delegate. Scope-filtered dispatch
         * (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
         * @mode waterfall
         */
        'approval/request'(this: Scoped<Agent>, req: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome>;
    }
}
```

`ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`.

**Emission site** (`dsh-user-approval/lib/index.js:179`) — note the scope carrier
and the fail-closed default:

```js
		const answer = Promise.resolve().then(() => this.ctx.waterfall(scopeTarget(req.agent, req.agent), "approval/request", req, () => Promise.resolve("unavailable"))).then((outcome) => OUTCOMES.includes(outcome) ? outcome : "unavailable", () => "unavailable");
```

Early exits before the waterfall: `signal?.aborted → 'cancelled'`;
`effectivePolicy(session) === 'never' → 'rejected'`.

**Who triggers an ask** — `dsh-tools/lib/index.js:3330` (`serviceAsk`):

```js
		const outcome = await approval.request({
			agent: exec.agent,
			toolName: exec.name,
			callId: exec.callId,
			...ask.reason !== void 0 ? { reason: ask.reason } : {},
			signal: exec.signal
		});
```

The `ask` decision comes from a `tools/pre-execute` listener (typically the
sandbox/permission policy). Outcome mapping (verbatim, same file): `allowed-once`
→ allow; `rejected` → deny with `the user rejected tool "<name>"`; `cancelled`
→ deny + `approvalCancelled: true`; `unavailable` → deny with
`tool "<name>" requires approval, but no approval channel is available`.

**Durable audit events** — these are **session** events, declared in the same
`.d.ts` via `declare module '@deepseek-ai/dsh-session/types'`:

```ts
        'approval/asked': { id: ApprovalRequestId; toolName: string; callId?: ToolCallId; reason?: string; };
        'approval/decided': { id: ApprovalRequestId; outcome: ApprovalOutcome; };
```

JSDoc: *"An approval question was put to the answerer chain — log-only audit
(like `hook/*`; NOT a surface event, carries no `surfaceOp`). `id` pairs it with
the `approval/decided` that always follows."*

So there is **no `approval/requested` cordis emit**. To observe approvals
without answering them:

```js
ctx.on('session/event', (session, event) => {
  if (event.type === 'approval/asked')   { /* event.data.id, .toolName, .callId, .reason */ }
  if (event.type === 'approval/decided') { /* event.data.id, .outcome */ }
});
```

…or answer them by registering on the `approval/request` waterfall.

**Reference answerers in-tree:** `dsh-acp/lib/index.js:1115`
(`ctx.on("approval/request", (request, next) => …)`), and the browser bridge
`dsh-client-ui-approval/lib/client.js:282`
(`ctx.remote.$on("approval/request", function(request, next) { … })`).

### 4.2 User questions — `@deepseek-ai/dsh-user-questions`

**Service:** `ctx.userQuestions` (`super(ctx, "userQuestions")`).

```js
	async ask(request) {
		if (request.signal?.aborted) throw abortedQuestion();
		if (request.questions.length === 0) throw new UserQuestionError("ask_user_question requires at least one question", "EMPTY_QUESTIONS");
		const agent = request.agent;
		if (agent !== void 0) {
			const agents = this.ctx.get("agents");
			if (agents === void 0 || agents.get(agent.id) !== agent) throw new UserQuestionError("human interaction requires the exact live calling agent when an agent is supplied", "CALLER_NOT_LIVE");
			if (!agents.roots().includes(agent)) throw new UserQuestionError("human interaction is unavailable while the calling agent is owned by another live agent; include the unresolved question or decision in the child agent's final result", "DELEGATED_CALLER");
		}
		...
		const noAnswerer = () => Promise.reject(new UserQuestionError("no user-questions answerer accepted the request", "NO_PROVIDER"));
		try {
			return await (agent === void 0 ? this.ctx.waterfall("user-questions/request", request, noAnswerer) : this.ctx.waterfall(scopeTarget(agent, agent), "user-questions/request", { ...request, agent }, noAnswerer));
		} catch (error) { ... }
	}
```

Stable error codes: `ASK_ABORTED`, `EMPTY_QUESTIONS`, `CALLER_NOT_LIVE`,
`DELEGATED_CALLER`, `NO_PROVIDER`, `BAD_INTENT`.

**The answerer event** — `user-questions/request`
(`dsh-user-questions/lib/types/types.d.ts`):

```ts
/** Client-safe payload declared for the user-question answerer waterfall. */
export interface AskUserQuestionRequestEvent {
    /** Questions to display. */
    questions: AskUserQuestionItem[];
    /** Agent identity projected to the corresponding Client Context in transit. */
    agent?: Agent;
    /** Cancellation lifetime of the pending request. */
    signal?: AbortSignal;
}
declare module '@deepseek-ai/cordis' {
    interface Events {
        /**
         * Ask composed answerers for structured user input. Return an answer to
         * claim the request or call `next()` to delegate.
         * @mode waterfall
         */
        'user-questions/request'(this: Scoped<Agent>, request: AskUserQuestionRequestEvent, next: () => Promise<AskUserQuestionAnswer>): Promise<AskUserQuestionAnswer>;
    }
}
```

Payload/answer shapes:

```ts
export interface AskUserQuestionOption { label: string; description?: string; }
export interface AskUserQuestionItem {
    id: string; question: string; detail?: string; header?: string;
    options?: AskUserQuestionOption[]; multiSelect?: boolean;
    intent?: AskUserQuestionIntent;
}
export type AskUserQuestionIntent = { kind: 'plan-review'; approve: string; };
export interface AskUserQuestionAnswerItem { id: string; selected: string[]; custom?: string; }
export interface AskUserQuestionAnswer { answers: AskUserQuestionAnswerItem[]; }
```

The model-facing tool is `ask_user_question` in `dsh-tool-ask-user`
(`const name = "tool-ask-user"; const inject = ["tools", "userQuestions"];`,
tool `name: "ask_user_question"`), which calls
`await ctx.userQuestions.ask({ ... })` (`dsh-tool-ask-user/lib/index.js:97`).

**Answerers in-tree:** `dsh-client-ui-user-questions/lib/client.js:880`
(`ctx.remote.$on("user-questions/request", function(request, next) { … })`).
On the host side I found **no** in-tree host answerer other than the ACP bridge —
the web answerer lives in the browser and reaches the host through the API
remotes bridge (§4.4).

### 4.3 Goals and jobs

**Goals** (`dsh-goal`) — two cordis events, no answerer waterfall:

`dsh-goal/lib/types/domain.d.ts`:

```ts
declare module '@deepseek-ai/cordis' {
    interface Events {
        /**
         * Goal mutation accepted by one live agent. The matching `goal/change`
         * session event has already committed. Listener failures are contained.
         * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
         * @mode emit
         */
        'goal/changed'(this: import('@deepseek-ai/dsh-scope').Scoped<Agent>, payload: {
            agent: Agent;
            change: GoalChanged;
        }): void;
    }
}
```

```ts
/** Live notification after one durable goal mutation commits. */
export interface GoalChanged {
    readonly operation: GoalOperation;   // 'create'|'edit'|'pause'|'resume'|'complete'|'block'|'clear'
    readonly ref: GoalRef;               // { id: GoalId; revision: number }
    /** Absent for a clear tombstone. */
    readonly goal?: GoalView;
}
```

`dsh-goal/lib/types/types.d.ts`:

```ts
export interface GoalActivationChanged {
    readonly sessionId: SessionId;
    readonly goal?: { readonly id: GoalId; readonly revision: number; readonly activation: GoalActivation; };
}
export type GoalActivation = 'armed' | 'disarmed';
...
        /**
         * Process-local goal activation changed for one session.
         * @mode emit
         */
        'goal/activation-changed'(payload: GoalActivationChanged): void;
```

Emit sites: `goal/activation-changed` at `dsh-goal/lib/index.js:798`;
`goal/changed` at `dsh-goal/lib/index.js:877`
(`agentEvents(this.ctx, agent).emit("goal/changed", { change: notification });`).
The durable session event is `goal/change` (payload `GoalChangeMeta`).

**Goal rounds have no dedicated event.** `dsh-goal-round-driver/README.md`:
*"With an exact live agent idle, an active armed goal, and remaining capacity,
the driver queues one goal-round prompt."* and *"A round starts only at
whole-agent idle"*. So a goal round is observable as
`agent/status → 'idle'` + a `user/message` whose `source.kind === 'goal'`
(`GoalMessageSource = { kind: 'goal'; goalId; revision; round }`) on
`session/event`. I could **not** find any `goal/round` cordis event.

**Jobs** (`dsh-jobs` / `dsh-jobs-local`) — **not** a cordis event; a service
callback API on `ctx.jobs`:

```ts
    /**
     * Register an effect-scoped completion listener. It receives the settlements
     * of the owners its registering context's scope covers; each listener is
     * contained; returned promises are observed but not awaited. No listener runs
     * after service disposal.
     * @param listener - receives each terminal snapshot and its exact owner.
     * @returns disposer that unregisters the listener.
     */
    abstract onJobDone(listener: JobDoneListener): () => void;
    abstract onJobsChanged(listener: JobsChangedListener): () => void;
```

```ts
export type JobDoneListener = (snapshot: JobSnapshot, owner: Agent | undefined) => void | PromiseLike<void>;
export type JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed';
export interface JobSnapshot {
    id: JobId; kind: JobKind; label: string; outputLimitBytes?: number;
    ownerSession?: SessionId; status: JobStatus; detail?: string;
    startedAt: number; finishedAt?: number; reported: boolean;
}
```

Implementation (`dsh-jobs-local/lib/index.js:261`):

```js
	onJobDone(listener) {
		return this.layers.effect(this.ctx, (layer) => layer.listeners.append(listener), { label: "jobs.onJobDone()" });
	}
```

Usage: `ctx.jobs.onJobDone((snapshot, owner) => { ... })`.

### 4.4 How these reach the browser (the bridge you may need to extend)

`dsh-api-remotes/lib/index.js` holds the **one** forwarded-Host-event
allowlist. Both the host forwarding loop and the client's `ctx.remote.$on` key
face read it. Verbatim (order preserved):

```js
const API_REMOTE_FORWARDED_EVENTS = [
	{ event: "agent-preset/selected", mode: "emit" },
	{ event: "approval/request", mode: "waterfall" },
	{ event: "api-session/activity", mode: "emit" },
	{ event: "api-session/added", mode: "emit" },
	{ event: "api-session/error", mode: "emit" },
	{ event: "api-session/removed", mode: "emit" },
	{ event: "api-session/status", mode: "emit" },
	{ event: "commands/change", mode: "emit" },
	{ event: "credentials/reference-updated", mode: "emit" },
	{ event: "goal/activation-changed", mode: "emit" },
	{ event: "cordis/request-run", mode: "emit" },
	{ event: "cordis/request-run-resolved", mode: "emit" },
	{ event: "cordis/dynamic-package", mode: "emit" },
	{ event: "cordis/dynamic-retract", mode: "emit" },
	{ event: "cordis/inspect-query", mode: "emit" },
	{ event: "cordis/inspect-query-resolved", mode: "emit" },
	{ event: "llm/adapters-updated", mode: "emit" },
	{ event: "settings/document-updated", mode: "emit" },
	{ event: "user-questions/request", mode: "waterfall" }
];
```

Waterfall entries carry an extra host-side check
(`dsh-api-remotes/lib/index.js`, after the array):

```js
			return ctx.on(event, (function(request, next) {
				const carrierAgent = carrierKeyOf(this);
				if (carrierAgent === void 0) return next();
				const agent = request.agent;
				if (agent === void 0 || agent !== carrierAgent) throw new TypeError(`forwarded scoped event ${JSON.stringify(event)} must carry its Agent directly`);
				return forwardWaterfall(queue, event, request, { ... });
```

**Implication:** a *new* host event you invent will **not** reach the browser
unless it is added to this allowlist (a fork of `dsh-api-remotes` or your own
`typertGateway.registerRemoteEvents(...)` registration — look at `apply` there:

```js
const inject = ["typertGateway"];
function apply(ctx) {
	ctx.effect(() => ctx.typertGateway.registerRemoteEvents(remoteEventSource(ctx), { home: homedir() }), "api-remotes: forwarded Cordis event source");
}
```
).

---

## 5. Settings

### 5.1 Service

`ctx.settings`, registered by `SettingsProvider` (abstract) in `dsh-settings`.
Providers implement `load()` / `persist()`; the base owns registration,
resolution, validation, change detection, and the `settings/updated` event.
`dsh-settings-file` is the file-backed provider.

**Resolution order:** schema defaults → the registrant's composition `base` →
the user document section.

### 5.2 Registration API (exact signature)

```ts
    /**
     * Register a namespace schema and receive its owner scope. The registration
     * is an effect on the calling plugin's fiber: disposing that fiber removes
     * the namespace and its observers. An invalid stored section fails the
     * registration itself — the earliest point where the schema can judge it.
     * @param ns - unique namespace; duplicate registration fails loud.
     * @param schema - schemastery schema resolving this namespace's value.
     * @param options - composition `base` layer and effect timing.
     * @returns the owner scope for reads, observation, and updates.
     * @throws {TypeError} when `ns` is not a lowercase hyphenated identifier.
     */
    register<const Namespace extends string, T>(
        ns: Namespace & SettingsNamespaceInput<Namespace>,
        schema: z<T>,
        options?: SettingsRegisterOptions<T>,
    ): SettingsScope<T>;
```

```ts
export interface SettingsRegisterOptions<T> {
    /** Composition-layer values resolved below the user layer (entry-config subset). */
    base?: Partial<T>;
    /** Owner's effect timing, surfaced to configuration UIs; defaults to `live`. */
    applies?: SettingsApplies;   // 'live' | 'restart'
    /**
     * Reject a resolved section the owner could not act on, for constraints its
     * schema cannot express ...
     * @param value - the resolved section, schema-valid by construction.
     */
    validate?: (value: T) => void;
}

/** Owner-facing handle for one registered namespace. */
export interface SettingsScope<T> {
    /** Current resolved value: schema defaults, then `base`, then the user layer. */
    get(): T;
    /**
     * Observe committed changes to this namespace's resolved value. ...
     * @returns the disposer removing this observer.
     */
    watch(callback: (next: T, prev: T) => void | Promise<void>): () => void;
    /** Merge a partial patch into this namespace's user layer and persist it. */
    update(patch: object): Promise<void>;
    /** Replace this namespace's user section wholesale ... (`replace({})` resets all). */
    replace(section: object): Promise<void>;
}
```

**Note the namespace grammar:** `SettingsNamespaceInput` accepts only
`[a-z][a-z0-9-]*` (lowercase letters, digits, hyphen; must start with a letter).
`"agent-default-model"` is valid; `"myPlugin"` is not.

The provider-side (admin/UI) API:

```ts
    describe(options?: SettingsDescribeOptions): SettingsDescriptor[];
    get<const Namespace extends string>(ns: ...): unknown;
    update<const Namespace extends string>(ns, patch: object, expectedRevision?: number): Promise<void>;
    replace<const Namespace extends string>(ns, section: object, expectedRevision?: number): Promise<void>;
    mutate<const Namespace extends string>(ns, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>;
```

`register` is the plugin-facing entry point; `define` does **not** exist —
I confirmed no `settings.define(` anywhere in the tree. `installSection` is the
variant for a plugin that must keep working when `settings` is absent:

```ts
    /**
     * Attach one optional-settings consumer to this provider. The consumer
     * registers its composition entry as the base layer while this provider is
     * present, then falls back to that entry if the provider detaches.
     */
    installSection<const Namespace extends string, T>(
        owner: Context,
        ns: Namespace & SettingsNamespaceInput<Namespace>,
        schema: z<T>,
        entry: T,
        hooks: SettingsSectionHooks<T>,
    ): void;

export interface SettingsSectionHooks<T> {
    /** Receive the active configuration source: the resolved settings scope while one is attached, the composition entry otherwise. Called before the matching `onChange` at attach and at detach. */
    setSource(current: () => T): void;
    /** Re-judge anything derived from the source — registration-level facts, memoized resolutions — after an attach, a detach, or a committed change. */
    onChange(): void;
    validate?: (value: T) => void;
}
```

### 5.3 Real usage — the complete, smallest example

`dsh-agent-default-model/lib/index.js` (whole file, verbatim):

```js
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
//#region lib/types/index.js
/**
* Default model selection for an Agent without a session-specific selection.
*
* @module @deepseek-ai/dsh-agent-default-model
*/
/** Settings namespace carrying the default model selection for future Agents. */
const AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE = "agent-default-model";
/** Schema of the default Agent model settings section. */
const AGENT_DEFAULT_MODEL_SETTINGS_SCHEMA = z.object({
	provider: z.string().required(),
	model: z.string().required(),
	reasoningEffort: z.string()
});
...
var AgentDefaultModelConfig = class extends Service {
	static Config = z.object({
		provider: z.string().required(),
		model: z.string().required()
	});
	source;
	constructor(ctx, config) {
		super(ctx, "agentDefaultModel");
		const entry = { provider: config.provider, model: config.model };
		this.source = () => entry;
		ctx.inject(["settings"], (settingsCtx) => {
			settingsCtx.settings.installSection(ctx, AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE, AGENT_DEFAULT_MODEL_SETTINGS_SCHEMA, entry, {
				setSource: (current) => { this.source = current; },
				onChange: () => {}
			});
		});
	}
	currentSelection() { return selection(this.source()); }
	async saveSelection(next) {
		await this.ctx.get("settings")?.replace(AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE, {
			provider: next.provider,
			model: next.model,
			...next.reasoningEffort === void 0 ? {} : { reasoningEffort: String(next.reasoningEffort) }
		});
	}
};
//#endregion
export { AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE, AGENT_DEFAULT_MODEL_SETTINGS_SCHEMA, AgentDefaultModelConfig, AgentDefaultModelConfig as default };
```

The pattern is identical in `dsh-agent-loop/lib/index.js:1520` (with `validate`),
`dsh-llm-deepseek/lib/index.js:2080` (with `onChange: ensureRegistrationFacts`),
`dsh-llm-pi-ai`, `dsh-permission-presets`, `dsh-web-search-deepseek`,
`dsh-bash-local`, `dsh-pwsh-local`, plus pure `register` calls in
`dsh-agent-presets/lib/index.js:1312`:

```js
				this.settings = settingsCtx.settings.register(SETTINGS_NAMESPACE, AgentPresetSettingsSchema, { base: { default: config.default } });
```

`dsh-agent-loop` version with `validate`:

```js
		ctx.inject(["settings"], (settingsCtx) => {
			settingsCtx.settings.installSection(ctx, AGENT_LOOP_SETTINGS_NAMESPACE, AGENT_LOOP_SETTINGS_SCHEMA, entry, {
				validate: (value) => void resolveMaxParallelToolCalls(value.maxParallelToolCalls),
				setSource: (current) => { source = current; },
				onChange: () => {}
			});
		});
```

**Relationship to plugin `Config`:** there is no automatic bridge. The
composition entry value is used as the `base` (or `entry`) layer, and the
plugin reads settings through the hooks. A plugin that wants live settings must
opt in with `ctx.inject(['settings'], …)`.

### 5.4 Focused alternative: `settings/updated`

```ts
        /**
         * Committed change to one registered namespace's resolved value. ...
         * @param ns - the namespace whose resolved value changed.
         * @param next - the new resolved value.
         * @param prev - the previous resolved value.
         * @param source - whether the change entered through `update()` or the provider.
         * @mode emit
         */
        'settings/updated'(ns: SettingsNamespace, next: unknown, prev: unknown, source: SettingsUpdateSource): void;
        /**
         * One registered namespace's RAW user section changed, whether or not the
         * resolved value did. ...
         * @mode emit
         */
        'settings/document-updated'(ns: SettingsNamespace, revision: number): void;
```

### 5.5 Client-side settings UI — **not** automatic

`dsh-client-ui-settings-plugins/README.md` is explicit:

> "The tab reads which settings namespaces the Host serves and dispatches one
> slot key per namespace, so what renders is the intersection of two ledgers:
> the namespaces a live Host plugin registered, and the cards registered under
> those keys. **A served namespace no card claims renders nothing**, and a card
> whose namespace this deployment does not serve is never dispatched."

So registering a namespace on the host gives you **no UI by itself**. To get a
form you ship a client half that registers a card under
`settings.plugin.item`, keyed by your namespace
(`dsh-client-ui-settings-plugins/lib/types/client/slot-contract.d.ts`):

```ts
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface SlotMap {
        /** One plugin's card inside the plugin configuration section (see module JSDoc). */
        'settings.plugin.item': {
            kind: 'keyed';
            scope: 'root';
            owner: SettingsPluginItemOwnerProps;
        };
    }
}
```

The helper you would use is `CardForm` (`card-form.d.ts`), whose `CardFieldSpec`
is `{ field: string; format: (value: unknown) => string; parse: (text: string) => FieldWrite | undefined }`
with `FieldWrite = { kind: 'set'; value: unknown } | { kind: 'clear' }`, plus
`textField(field)` / `numberField(field)` factories. A settings section itself
is registered in the client at slot `settings.section`, e.g.
`dsh-client-ui-settings-general/lib/client.js:651`:

```js
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "general",
				order: 0,
				label: () => t("general.nav"),
				locale: NS,
				children: { "settings.general.item": { kind: "list", scope: "root" } }
			}, GeneralSection));
```

---

## 6. Client (browser) plugins

### 6.1 Declaration: `dsh.client` + a `./client` export

`dsh-client-modules/README.md`:

> "A browser plugin package declares `dsh.client` in its `package.json` with
> `platform: 'web'`, exports a `./client` bundle, and lists any non-baseline
> module requests under `dsh.client.external`. The host half turns each
> declaration into a served bundle under `/plugins`, ordered so dynamic
> providers load before their consumers."

`dsh-client-ui-goal/package.json` (verbatim excerpt):

```json
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "dsh": {
    "client": {
      "inject": [
        "@deepseek-ai/dsh-api-remotes",
        "@deepseek-ai/dsh-api-session-controller",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-chat",
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-renderer",
        "@deepseek-ai/dsh-client-ui-session"
      ],
      "platform": "web"
    }
  },
  "license": "MIT",
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.2" },
  "files": [ "lib/index.js", "lib/client.js", "lib/types/**/*.d.ts" ],
  "scripts": { "bundle": "tsdown", "watch": "tsdown --watch" }
```

`DshClientManifest` (from `dsh-package-manifest`):

```ts
export interface DshClientManifest {
    /** Client platform identifier; the Web consumer selects `web`. */
    platform: string;
    /** Informational package-name dependencies, not Cordis service injection. */
    inject?: string[];
    /** Boot phase-one registration barrier; absent means the shared application batch. */
    immediately?: boolean;
    /** Exact module-table requests beyond the implicit client baseline, including subpaths such as `<pkg>/client`; absent means baseline externals only. */
    external?: string[];
}
```

**Critical distinction:** `dsh.client.inject` is a list of **package names**
(graph edges), *not* cordis service names. The cordis service list is the
`inject` export inside `lib/client.js`.

### 6.2 The bundle format

`lib/client.js` is **not** an ES module. It is a "lazy CJS" registration against
a page global. `dsh-client-modules/lib/types/client/manifest.d.ts`:

```ts
/** One client bundle's factory registration submitted through `window.__ModuleLoader__.load`. */
export interface ClientBundleRegistration {
    /** Plugin id (package name) — the registration key; must match the graph row being executed. */
    id: string;
    /**
     * Closure factory holding the whole bundle body: receives the synchronous
     * require bound to the module table and returns the bundle's exports. Runs
     * once, at materialization.
     */
    factory: (require: (spec: string) => unknown) => Record<string, unknown>;
}
```

Real file, `dsh-client-ui-schedule/lib/client.js` (the whole 306-line file's
skeleton, verbatim):

```js
window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-schedule",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let react_dom = require("react-dom");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region ...CSS module...
		const css = ".-\\34 LnlG_root{...}";
		const tagId = "@deepseek-ai/dsh-client-ui-schedule/ScheduleCatalogAction.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-schedule";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		...
		/** Required services for locale registration and header-slot contribution. */
		const inject = ["slots", "locale"];
		/** Register the dictionaries and Session-header catalog action. */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-schedule: dictionaries");
			ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
				name: "conversation.session.header.actions",
				id: "schedule-catalog",
				order: 10,
				locale: NS
			}, ScheduleCatalogAction));
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
```

**Export shape: `exports.apply` (+ optional `exports.inject`, `exports.Config`?)**
— confirmed identical in `dsh-client-ui-goal` (`exports.apply = apply;
exports.inject = inject;` plus extra named exports `GoalBar`, `GoalDock`) and in
every other `dsh-client-*` bundle I inspected. I found **no** client bundle with
a `Config` export.

**Build requirement:** `dsh-client-modules/README.md`: *"The host serves built
client bundles, so `pnpm run build` must have produced each `lib/client.js`
before launch; a missing bundle fails activation loudly with one build
instruction and a package/path list."* The build tool is `tsdown`
(`"bundle": "tsdown"`, `"watch": "tsdown --watch"`).

**Shared module baseline:** *"The shell seeds a frozen module table
(`PLATFORM_MODULES`: React, Cordis, and static UI libraries); every dynamic
bundle resolves its externals against exactly that baseline."*

**Module identity:** *"`<id>/client` and the bare id resolve to the same exports,
because a plugin bundle is its package's client half."*

### 6.3 Client-side `ctx` and slots

Client services I could confirm by name:

| Service | Registered by | Declared as |
|---|---|---|
| `ctx.slots` | `dsh-client-ui-renderer/lib/client.js:995` (`super(ctx, "slots")`) | `SlotRegistry` |
| `ctx.locale` | `dsh-client-locale` | dictionary registration |
| `ctx.uiSession` | `dsh-client-ui-session/lib/client.js:99` | pending-interaction + session state |
| `ctx.uiConversation` | `dsh-client-ui-conversation/lib/client.js:2584` | conversation events/registration |
| `ctx.conversation` | `dsh-client-ui-conversation/lib/client.js:2857` | scope-addressed send/cancel/history |
| `ctx.remote` | via `dsh-api-gateway`/`dsh-api-remotes` | `ctx.remote.$on(event, fn)`, `ctx.remote.<domain>.<method>(...)` |
| `ctx.modules` | `dsh-client-modules/lib/client.js` | `ClientModuleLoader` |

`ctx.slots` surface (`dsh-client-ui-renderer/lib/types/client/registry.d.ts`):

```ts
export declare class SlotRegistry extends Service {
    /**
     * The single registration API. The typed face IS the core's register
     * (both overloads reused verbatim — one authority, no structural copy;
     * see SlotCore.register for children declaration, store seat, inject
     * face, load-time validation, and the unload cascade). This layer adds:
     * disposal through the caller's ctx.effect (fiber unload = cascade), ...
     */
    readonly register: SlotCore['register'];
    /**
     * Install an effect for each declaration lifetime of a slot. ...
     * @param key - declared SlotMap key to depend on.
     * @param callback - creates one disposer or an iterable of disposers.
     * @returns idempotent disposer for the wait and active effect.
     */
    inject(key: keyof SlotMap & string, callback: () => SlotInjectionEffect): () => void;
    install(renderer: SlotRenderer): void;
    installLocale(face: LocaleFace): void;
    provideRoot(contribution: RootStandardSourceContribution): () => void;
    installScope(scope: Exclude<SlotScope, 'root' | 'session-maybe'>, adapter: SlotScopeAdapter): void;
    bindStoreScope(binding: Pick<ScopedStandardSourceBinding, 'key' | 'ctx'>): void;
    renderSlot<K extends keyof SlotMap & string>(key: K, owner: OwnerOf<K>): ReturnType<SlotRenderer['renderRoot']>;
    entries(key: keyof SlotMap & string): readonly StoredEntry[];
    entriesOfSlot(key: keyof SlotMap & string): readonly StoredEntry[];
    snapshot(root?: string): LiveSlotNode[];
    onEntryError(fn: (key: string, entry: StoredEntry, error: unknown, info: { abdicated: boolean }) => void): () => void;
    spec<K extends keyof SlotMap & string>(key: K): SlotSpec<SlotMap[K]> | undefined;
    subscribe(key: keyof SlotMap & string, fn: () => void): () => void;
    getVersion(key: keyof SlotMap & string): number;
}
```

**⚠️ I could not verify `SlotCore.register`'s exact signature**: the
`@deepseek-ai/dsh-client-ui-slots` package (which owns `SlotCore`) is a
**build/dev-only dependency and is NOT present** in the extracted tree
(along with `dsh-client-ui-primitives`). What I can confirm are the real call
shapes from compiled bundles:

```js
// dsh-client-ui-schedule/lib/client.js
ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
    name: "conversation.session.header.actions",
    id: "schedule-catalog",
    order: 10,
    locale: NS
}, ScheduleCatalogAction));

// dsh-client-ui-goal/lib/client.js — with an `inject` prop factory
ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
    name: "conversation.input.dock",
    id: "goal",
    order: 10,
    locale: NS,
    inject: (sessionId) => { ... return { hooks: {...}, onEdit: ..., onClear: ... }; }
}, GoalDock));

// dsh-client-ui-approval/lib/client.js — `select` projector + declared children
ctx.slots.inject("conversation.composer", () => ctx.slots.register({
    name: "conversation.composer",
    priority: 1,
    select: ({ pendingInteraction }) => pendingInteraction instanceof PendingApproval ? pendingInteraction : null,
    locale: NS,
    children: { "conversation.approval.detail": { kind: "single", scope: "session" } }
}, ApprovalPanel));

// dsh-client-ui-goal/lib/client.js — keyed list entry
ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
    name: "conversation.chat.node",
    key: "command-input",
    locale: NS
}, GoalCommandInputView));
```

Observed option keys: `name` (slot key, required), `id` / `key` (entry identity),
`order` / `priority` (ordering), `locale` (dictionary namespace),
`select` (projector), `children` (child slot declarations), `inject` (owner-props
factory), `store` (a snapshot store handle).

**Real slot keys present in this build** (harvested from `slots.inject("...")`
call sites in `dsh-client-*/lib/client.js`, frequency in parentheses):

`conversation.chat.node` (17) · `tool.call.toolview` (13) ·
`sidebar.right.tab.document` (6) · `settings.general.item` (6) ·
`settings.section` (4) · `sidebar.right.pane.tab` (3) ·
`sidebar.right.pane.tab.title` (3) · `conversation.input.overlay` (3) ·
`conversation.input.dock` (3) · `conversation.composer` (3) ·
`sidebar.workspaces.directoryFlow` (2) · `settings.plugins.tab` (2) ·
`settings.onboarding` (2) · `conversation.view` (2) ·
`conversation.session.header.utilities` (2) ·
`conversation.session.header.actions` (2) ·
`conversation.hero.workspace.directoryFlow` (2) · `tool.call.images` (1) ·
`sidebar`, `sidebar.workspaces`, `sidebar.settings`, `sidebar.footer.action`,
`sidebar.brand.name`, `sidebar.brand.mark`, `main`, `rightbar`,
`settings.trigger`, `settings.plugin.item`, `settings.header`, `settings.close`,
`settings.action`, `conversation.trajectory.images`,
`conversation.session.header.lineage`, `conversation.session.header.corner`,
`conversation.message.images`, `conversation.input.plan`,
`conversation.input.model`, `conversation.input.attachments`,
`conversation.hero.workspace`, `conversation.composer.dock` (1 each).

`'root'` is declared by the renderer itself and **must not be registered into**:

> "DO NOT register here. This is a single slot, so a second entry does not sit
> beside the frame — it shadows it ... For a surface of your own that floats
> over the whole app, register into `shell.overlay` instead (a list slot:
> additive, and click-through until your entry opts into pointer events)."

`shell.overlay` is declared by `dsh-client-ui-layout`
(`dsh-client-ui-layout/lib/types/client/index.d.ts:80`).

Registration is change-notified through `ctx.emit("slots/changed", key)`
(`dsh-client-ui-renderer/lib/client.js:997`).

### 6.4 Browser APIs — Notifications: **absent**

I grepped the whole extracted tree (`*.js`, `*.ts`, `*.json`, excluding
`dsh-web-frontend/dist`) for `new Notification(`, `Notification.requestPermission`,
and `Notification`:

* **No use of the Web Notifications API anywhere.** Zero hits for
  `new Notification(` and `Notification.requestPermission`.
* All `Notification` hits are unrelated identifiers: the ACP SDK's
  `SessionNotification`, `dsh-api-gateway`'s `publishNotification` (remote
  journal frames), `dsh-sdk-protocol`'s `SessionEventNotification` /
  `SessionStatusNotification`, `dsh-typert-protocol` notifications.
* No `osascript`, `afplay`, or sound/attention API either.

**`localStorage` IS used** — both in `dsh-client-ui-conversation/lib/client.js`.
Verbatim:

```js
		function readConversationViewPreference(sessionId) {
			if (typeof localStorage === "undefined") return null;
			try {
				const raw = localStorage.getItem(`${CONVERSATION_STORE_KEY}.${sessionId}`);
				if (raw === null) return null;
				const stored = JSON.parse(raw);
				if (typeof stored !== "object" || stored === null || !("view" in stored)) return null;
				return typeof stored.view === "string" ? stored.view : null;
			} catch {
				return null;
			}
		}
```

```js
		function readWidthPreference() {
			const raw = localStorage.getItem(WIDTH_PREF_KEY);
			if (raw === null) return null;
			const value = Number(raw);
			return Number.isFinite(value) && value > 0 ? value : null;
		}
```

```js
			const onHandleCommit = (0, react.useCallback)((width) => {
				const root = rootEl.current;
				if (root === null) return;
				localStorage.setItem(WIDTH_PREF_KEY, `${resolveContentWidth(root.offsetWidth, width)}`);
			}, []);
```

No `sessionStorage` usage found. So: **`window.localStorage` is available and
precedented; `new Notification(...)` is not used by any shipped plugin and would
be a new capability you introduce yourself** (and would need
`Notification.requestPermission()` from a user gesture).

The nearest shipped "notify the user" primitive is a React `Toast` from
`@deepseek-ai/dsh-client-ui-primitives` (not present in this tree), used as
`(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Toast, { text: toast.text, ... })`
in `dsh-client-ui-model-selection/lib/client.js:772`.

### 6.5 Client↔host

* `ctx.remote.$on(event, fn)` subscribes to a **host-forwarded** event (only
  events in the `API_REMOTE_FORWARDED_EVENTS` allowlist, §4.4).
  `fn` receives `(payload, next)` for `waterfall` entries.
* `ctx.remote.<domain>.<method>(...)` calls a host RPC domain, e.g.
  `ctx.remote.goals.get(sessionId)`, `ctx.remote.goals.edit(sessionId, ref, { objective })`.
* `ctx.on("connection/reset", listener)` observes transport resets
  (`dsh-client-ui-goal/lib/client.js`).
* Session state/projection reads go through `ctx.sessions`:
  `sessions.binding(sessionId)?.session.projections.faceOf("goal")?.getSnapshot()`.

---

## 7. Adding a plugin to a profile

### 7.1 The command

`dsh/README.md`:

| Command | Purpose |
|---|---|
| `dsh plugin --profile <name> <pnpm args>` | Manage a profile's plugins by forwarding to pnpm in the profile directory. |

Implementation, `dsh/lib/plugin-Ddi42qoW.js` (whole file is 130 lines):

```js
/**
* `dsh plugin --profile <name> <args...>` — profile plugin management as a
* thin pnpm forwarder: initialize the profile on first use, run
* `pnpm <args...>` in the profile directory, then reconcile the
* `dsh.profile.bundles` layer list against the installed state (a dependency
* resolving to a package that declares `dsh.bundle` joins the layer stack; a
* removed or bundle-less dependency leaves it). ...
* @module @deepseek-ai/dsh/plugin
*/
...
function runPlugin(profile, args) {
	const dir = resolveProfileDir(profile);
	if (!existsSync(join(dir, "package.json"))) {
		const template = PROFILE_TEMPLATES[profile];
		initProfile(dir, template?.bundles ?? DEFAULT_PROFILE_BUNDLES, template?.patchReload);
		process.stderr.write(`${NAME}: initialized profile ${profile} at ${dir}\n`);
	}
	const before = readProfileManifest(NAME, dir);
	const result = spawnSync("pnpm", args.map((argument) => anchorPathSpec(argument, process.cwd())), {
		cwd: dir, stdio: "inherit", shell: process.platform === "win32"
	});
	...
	const exitCode = result.status ?? 1;
	if (exitCode === 0) reconcilePlugins(before, dir);
	...
}
```

So the CLI takes **raw pnpm arguments**. Concrete commands:

```sh
# local directory, absolute path
dsh plugin --profile web add /Users/me/src/dsh-notice

# local directory, relative to the INVOKING cwd (not the profile)
cd /Users/me/src && dsh plugin --profile web add ./dsh-notice

# explicit file:/link: forms
dsh plugin --profile web add file:/Users/me/src/dsh-notice
dsh plugin --profile web add link:../dsh-notice

# registry / git
dsh plugin --profile web add @scope/dsh-notice
dsh plugin --profile web add github:me/dsh-notice
dsh plugin --profile web install
dsh plugin --profile web remove @scope/dsh-notice
```

Local-path handling is explicit (`anchorPathSpec`):

```js
/**
* Rewrite relative filesystem specs against the user's invoking directory.
* pnpm runs with cwd = the profile directory, so a bare `.` or `../plugin`
* (or their `file:`/`link:` forms) would silently resolve inside the profile
* — `add .` from a plugin checkout would self-link the profile. Absolute
* specs, registry names, and every other pnpm argument pass through
* untouched.
*/
function anchorPathSpec(argument, cwd) {
	const match = /^(?<prefix>(?:file|link):)?(?<path>\.{1,2}(?:[/\\].*)?)$/.exec(argument);
	if (match?.groups?.path === void 0) return argument;
	return `${match.groups.prefix ?? ""}${resolve(cwd, match.groups.path)}`;
}
```

Note the bare-`.`/`..` regex only matches a spec that is *exactly* a dot-path;
`./dsh-notice` matches `\.{1,2}(?:[/\\].*)?` → anchored. Requires `pnpm` on
PATH (otherwise exit 127 with `pnpm not found on PATH — install pnpm to manage
profile plugins`).

For git-hosted plugins: *"git-hosted plugins build on install via their prepare
script, which pnpm blocks until allowed — add the exact key pnpm printed above
under allowBuilds in `<profile>/pnpm-workspace.yaml`, then re-run"*.

### 7.2 Profile layout on disk

`dsh-app-boot/lib/index.js`:

```js
/** Directory under the Harness home holding every profile. */
const PROFILES_DIR = "profiles";
/** The user patch layer inside a profile directory (hot-reloaded on long-lived surfaces). */
const PROFILE_PATCH_FILENAME = "cordis.patch.yml";
/** Profile-private package links projected into its pnpm-managed node_modules. */
const PROFILE_MODULE_FALLBACK_DIR = ".dsh-module-fallback";

function resolveProfileDir(name, home = resolveDshHome()) {
	if (name === "" || name.includes("/") || name.includes("\\") || name === "." || name === ".." || name === "node_modules") throw new Error(`dsh: invalid profile name ${JSON.stringify(name)}`);
	return join(home, PROFILES_DIR, name);
}
```

`dsh-home-paths`: `DSH_HOME_DIR_NAME = ".dsh"`, `DSH_HOME_ENV = "DSH_HOME"`,
precedence "an explicit configured path, `$DSH_HOME`, then `~/.dsh`".

So a profile lives at **`$DSH_HOME/profiles/<name>/`** (default `~/.dsh/profiles/<name>/`)
and contains exactly:

* `package.json` — out-of-tree plugin dependencies + the profile manifest `dsh.profile`
* `cordis.patch.yml` — the user's own patch layer
* `pnpm-workspace.yaml` — `packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n`

Initialization (`initProfile`):

```js
function initProfile(dir, bundles, patchReload = DEFAULT_PROFILE_PATCH_RELOAD) {
	mkdirSync(dir, { recursive: true });
	const manifestPath = join(dir, "package.json");
	if (!existsSync(manifestPath)) {
		const manifest = {
			name: `dsh-profile-${basename(dir)}`,
			private: true,
			dependencies: {},
			dsh: { profile: { bundles: [...bundles], patchReload } }
		};
		writeFileSync(manifestPath, JSON.stringify(manifest, void 0, 2) + "\n");
	}
	const patchPath = join(dir, PROFILE_PATCH_FILENAME);
	if (!existsSync(patchPath)) writeFileSync(patchPath, PROFILE_PATCH_TEMPLATE);
	const workspacePath = join(dir, "pnpm-workspace.yaml");
	if (!existsSync(workspacePath)) writeFileSync(workspacePath, PROFILE_PNPM_WORKSPACE);
}
```

`PROFILE_PATCH_TEMPLATE` (the initial `cordis.patch.yml`):

```js
const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`;
```

Shipped templates:

```js
const PROFILE_TEMPLATES = {
	acp:          { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app"],  patchReload: "startup" },
	web:          { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],  patchReload: "live" },
	headless:     { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"], patchReload: "startup" },
	sdk:          { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-sdk-app"],  patchReload: "startup" },
	"sdk-minimal":{ bundles: ["@deepseek-ai/dsh-sdk-minimal"],                        patchReload: "startup" }
};
const DEFAULT_PROFILE_BUNDLES = ["@deepseek-ai/dsh-base"];
const DEFAULT_PROFILE_PATCH_RELOAD = "live";
```

Composition order (`dsh/README.md`):

> The tree composes over an empty root:
> - each bundle's patch in `dsh.profile.bundles` order
> - then the profile's `cordis.patch.yml`, then the home-level `$DSH_HOME/cordis.patch.yml`
> - then `--patch` overlays

### 7.3 What the CLI writes

**It writes `dependencies` via pnpm, then reconciles `dsh.profile.bundles`:**

```js
function reconcilePlugins(before, profileDir) {
	const after = readProfileManifest(NAME, profileDir);
	const beforeDeps = new Set(Object.keys(before.dependencies ?? {}));
	const dependencies = Object.keys(after.dependencies ?? {});
	const plugins = after.dsh?.profile?.bundles ?? [];
	let changed = false;
	for (const packageName of dependencies) {
		const isBundle = exportsPatch(packageName, profileDir);
		if (isBundle && !plugins.includes(packageName)) {
			plugins.push(packageName);
			changed = true;
		} else if (!isBundle && !beforeDeps.has(packageName)) process.stderr.write(`${NAME}: warning: ${packageName} declares no dsh.bundle — installed as a plain dependency, not a profile layer (a later update that gains one activates it automatically)\n`);
	}
	...
	after.dsh = { ...after.dsh, profile: { ...after.dsh?.profile, bundles: plugins } };
	writeProfileManifest(profileDir, after);
}
```

`exportsPatch` is what decides "is this a profile layer":

```js
function exportsPatch(packageName, profileDir) {
	let dir;
	try { dir = resolveBundleDir(NAME, packageName, INSTALL_ANCHOR, profileDir); } catch { return false; }
	return readProfileManifest(NAME, dir).dsh?.bundle?.patch !== void 0;
}
```

**This is the single most important fact for local plugin installation:**

* If your local package declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`,
  `dsh plugin --profile web add /abs/path` **appends its package name to
  `dsh.profile.bundles`** — no hand editing. Your package must then ship a
  `cordis.patch.yml` at that path whose rows insert your plugin row(s).
* If it is a **plain plugin** (no `dsh.bundle`), pnpm installs it as an ordinary
  dependency and the CLI only prints:
  `dsh: warning: <pkg> declares no dsh.bundle — installed as a plain dependency, not a profile layer (a later update that gains one activates it automatically)`.
  You must then **hand-edit `<profile>/cordis.patch.yml`** to add a row that
  names the package.

The row `id` is **not derived by the CLI** — it comes from the `id:` field in
your own `cordis.patch.yml` (or the user's). This is exactly the `dsh-base`
convention quoted in §7.4.

### 7.4 Resulting file shapes

Profile `package.json` after `dsh plugin --profile web add /Users/me/src/dsh-notice`
(plain plugin, no `dsh.bundle`):

```json
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {
    "@your-scope/dsh-notice": "file:/Users/me/src/dsh-notice"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
      "patchReload": "live"
    }
  }
}
```

…and you add to `<profile>/cordis.patch.yml`:

```yaml
- insert:
    - id: notice
      name: '@your-scope/dsh-notice'
      config:
        reportIdle: true
```

If instead your package **is** a bundle (has `dsh.bundle.patch`), the same
command yields `dependencies` *plus* `"bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@your-scope/dsh-notice"]`
appended automatically, and no `cordis.patch.yml` edit is needed.

Bundle patch row schema (verbatim byte-for-byte from
`dsh-base/cordis.patch.yml`, the authoritative example):

```yaml
- insert:
    - id: timer
      name: '@deepseek-ai/cordis-plugin-timer'

    # Module reload is opt-in per profile. `patchReload: live` config watching
    # uses the launcher's watch-only fallback and does not require this row.
    - id: hmr
      name: '@deepseek-ai/cordis-plugin-hmr'
      disabled: true
      config:
        root: ['.']

    - id: llm
      name: '@deepseek-ai/dsh-llm'
    ...
    - id: agent-default-model
      name: '@deepseek-ai/dsh-agent-default-model'
      config:
        provider: deepseek-official
        model: deepseek-flash
```

Row keys observed: **`id`**, **`name`** (package name), optional **`disabled`**,
optional **`config`** (free-form, becomes the plugin's validated `Config`).
`group:` also exists in the loader (`cordis-plugin-loader`) for nested groups;
I did not see it used in `dsh-base/cordis.patch.yml`.

The patch file header documents the composition rule:

```yaml
# A patch replaces the targeted row's whole `config` rather than merging into
# it, so a row whose value differs by mode does NOT live here: it belongs to
# each mode bundle, keeping any single row down to one bundle layer plus the
# user's. ...
# Row order carries no load semantics (activation is service-availability
# driven); the grouping is for readers.
```

Two more CLI notes from `dsh/README.md`: the `desktop` profile name is
**reserved for the Electron-owned profile** and the CLI rejects boot,
config-dump, and plugin-management requests for it; and `--dump-default-config`
/ `--dump-config` inspect the composed tree without booting it.

### 7.5 Local-plugin install caveat for a *dev* workflow

`dsh-client-modules` requires each client bundle at `lib/client.js` to exist at
launch. For a local plugin you `pnpm add` by path, pnpm's `file:` spec **copies**
(or hard-links) into the profile's `node_modules` by default; `link:` symlinks.
For iterative development, `link:` is the one that keeps edits live, and
`patchReload: live` plus the HMR row then picks up `cordis.patch.yml` changes.
I could **not confirm** from this snapshot whether the desktop app's profile is
at `~/.dsh/profiles/desktop` or managed elsewhere — the CLI explicitly refuses
`desktop`.

### 7.6 Plugin inventory

`dsh-host-plugin-inventory` exists, plus `dsh-client-ui-settings-plugin-inventory`
and `dsh-plugin-package-inventory-deepseek`. The manifest fields it can read are
exactly the `DshManifest` keys in §1.6 (`bundle`, `client`, `profile`,
`configTrees`, `sessionFormatMigration`). I read the package list and its
`Context` augmentation, but did **not** enumerate its scanning logic in detail —
treat this section as "the mechanism exists; the manifest schema above is what
it consumes".

---

## 8. Practical summary for a new host plugin

**Skeleton:** §1.7.

**To observe without interfering** (recommended first move):

```js
export const name = 'notice'
export const inject = ['agents', 'jobs']   // only the services you actually read

export function apply(ctx, config) {
  ctx.effect(() => ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') { /* the agent finished working */ }
  }), 'notice: agent idle')

  ctx.effect(() => ctx.on('agent/error', ({ agent, turn, step, error }) => { /* … */ }),
    'notice: agent error')

  ctx.effect(() => ctx.on('session/event', (session, event) => {
    // turn/start, turn/end (with reason), step/start, step/end,
    // tool/call, tool/result, approval/asked, approval/decided,
    // goal/change, user/message …
  }), 'notice: session events')

  ctx.effect(() => ctx.jobs.onJobDone((snapshot, owner) => {
    // snapshot.status ∈ running|stopping|completed|killed|failed
  }), 'notice: jobs done')
}
```

**To *answer* the agent** (i.e. be the approver/question answerer) — register on
the waterfall and return a value without calling `next()`:

```js
export const inject = ['approval']   // or 'userQuestions'

export function apply(ctx) {
  ctx.effect(() => ctx.on('approval/request', async (req, next) => {
    // req = { agent, toolName, callId?, reason?, signal? }  (+ req.agent injected)
    if (!shouldHandle(req)) return next()
    return 'allowed-once'   // | 'rejected' | 'cancelled' | 'unavailable'
  }), 'notice: approval answerer')

  ctx.effect(() => ctx.on('user-questions/request', async (req, next) => {
    // req = { questions, agent?, signal? }
    if (!shouldHandle(req)) return next()
    return { answers: [{ id: req.questions[0].id, selected: ['Allow'] }] }
  }), 'notice: question answerer')
}
```

**Gotchas to remember:**
1. `approval.request()` throws if called outside an open turn — the ask must
   happen inside a turn.
2. `userQuestions.ask()` rejects with `DELEGATED_CALLER` for a subagent; only a
   runtime root can ask a human.
3. A waterfall answerer that returns an out-of-vocabulary value is normalized to
   fail-closed (`unavailable`) for approvals.
4. `agent/*` events are agent-scoped; a listener registered at the app root sees
   every agent, and `payload.agent` is always present at runtime.
5. Durable facts are session events, not cordis events — use `session/event`.
6. New custom host events do **not** reach the browser unless added to
   `API_REMOTE_FORWARDED_EVENTS` in `dsh-api-remotes`.
7. Registering a settings namespace gives no UI; a client card under
   `settings.plugin.item` is required.
8. `Notification` / `requestPermission` are unused anywhere in DSH — a
   notification plugin introduces that capability itself.
