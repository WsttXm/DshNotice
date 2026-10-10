/**
 * Headless harness for the `dsh-notice` client bundle.
 *
 * The bundle is a published artifact loaded by `window.__ModuleLoader__` inside
 * the renderer, so this test reproduces exactly that contract: it evaluates the
 * real `lib/client.js` in a `node:vm` context whose `window` captures the load
 * call, mounts the returned plugin against a fake Cordis context, and drives the
 * Session status store through the transitions that must and must not notify.
 *
 * Run with: node --test packages/dsh-notice/test/client.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";
import vm from "node:vm";

const BUNDLE = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js");

/**
 * Deep-clone a value that crossed the `node:vm` realm boundary. The bundle's
 * arrays and objects are instances of the sandbox realm's intrinsics, so
 * `deepStrictEqual` reports them as "same structure but not reference-equal";
 * comparing a plain-data copy keeps the assertions realm-agnostic.
 * @param value - a structured-cloneable value produced inside the sandbox.
 * @returns the host-realm copy.
 */
function tick() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function plain(value) {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** One recorded notification. */
class FakeNotification {
	static permission = "granted";
	static requestPermission = async () => FakeNotification.permission;
	static instances = [];

	constructor(title, options = {}) {
		this.title = title;
		this.body = options.body;
		this.tag = options.tag;
		this.silent = options.silent;
		this.onclick = undefined;
		this.closed = false;
		FakeNotification.instances.push(this);
	}

	close() {
		this.closed = true;
	}

	/** Fire the click handler the way a real notification would. */
	click() {
		this.onclick?.();
	}

	static reset() {
		FakeNotification.instances = [];
		FakeNotification.permission = "granted";
	}
}

/**
 * Evaluate the published bundle in a fresh renderer-like realm.
 * @param options - `focused` controls whether the fake window reports itself
 *   frontmost, which is the condition that suppresses banners outright;
 *   `storage` seeds the fake `localStorage`, which by default records that the
 *   one-time welcome banner was already shown.
 * @returns the captured `__ModuleLoader__.load` specification.
 */
function loadBundle({ focused = false, storage = new Map([["dsh-notice:announced", "2026-01-01T00:00:00.000Z"]]) } = {}) {
	const loaded = [];
	const sandbox = {
		window: { __ModuleLoader__: { load: (specification) => loaded.push(specification) } },
		Notification: FakeNotification,
		// A Desktop renderer reports Chromium's own default here; the language the
		// user actually picked reaches the page through the locale service instead.
		navigator: { language: "en-US", languages: ["en-US", "en"] },
		localStorage: new Map(),
		document: { visibilityState: "visible", hasFocus: () => focused, addEventListener() {}, removeEventListener() {} },
		focus() {
			sandbox.__focused = true;
		}
	};
	sandbox.__storage = storage;
	sandbox.localStorage = {
		getItem: (key) => (storage.has(key) ? storage.get(key) : null),
		setItem: (key, value) => storage.set(key, String(value)),
		removeItem: (key) => storage.delete(key)
	};
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(readFileSync(BUNDLE, "utf8"), sandbox, { filename: BUNDLE });
	assert.equal(loaded.length, 1, "the bundle registers exactly one client module");
	assert.equal(loaded[0].id, "dsh-notice");
	sandbox.__focused = false;
	return { specification: loaded[0], sandbox };
}

/**
 * Build the smallest Cordis-like client context the plugin consumes.
 * @param rows - Session list rows keyed by session id.
 * @param activeId - Session currently bound to the main view.
 */
function makeContext(rows, activeId, { locale = "zh" } = {}) {
	const listeners = new Set();
	const store = {
		snapshot: new Map(),
		getSnapshot() {
			return this.snapshot;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}
	};
	/** Publish one status snapshot and notify subscribers. */
	const publish = (entries) => {
		store.snapshot = new Map(Object.entries(entries));
		for (const listener of [...listeners]) listener();
	};
	const disposers = [];
	const ctx = {
		uiSession: {
			sessionStatus: store,
			adapter: { current: { getSnapshot: () => ({ key: activeId }) } }
		},
		get: (name) => {
			if (name === "sessions") return { list: { getSnapshot: () => ({ byId: rows }) } };
			if (name === "locale") return { getSnapshot: () => ({ active: locale, locales: [], revision: 0 }) };
			return undefined;
		},
		effect: (run, label) => {
			assert.equal(typeof label, "string", "every effect carries a label");
			disposers.push(run());
		}
	};
	return { ctx, publish, listeners, disposers };
}

/** Mount the plugin and return its context plus the status publisher. */
function mount(rows = {}, activeId = "s1", options = {}) {
	const { specification, sandbox } = loadBundle(options);
	FakeNotification.reset();
	const exported = specification.factory(() => {
		throw new Error("the bundle must not require any module");
	});
	assert.deepEqual(plain(exported.inject), ["uiSession"]);
	const { ctx, publish, disposers, listeners } = makeContext(rows, activeId, options);
	exported.apply(ctx);
	return { publish, disposers, listeners, sandbox, api: sandbox.__DSH_NOTICE__ };
}

const ROOT_ROW = { sessionId: "s1", title: "重构登录流程" };

test("attaching publishes the debug surface and requires only uiSession", () => {
	const { api } = mount({ s1: ROOT_ROW });
	assert.ok(api, "window.__DSH_NOTICE__ is published for scripts and users");
	assert.equal(api.state().attached, true);
	assert.equal(api.state().permission, "granted");
	assert.deepEqual(plain(api.prefs), {
		enabled: true,
		onInteraction: true,
		onComplete: true,
		sound: true,
		onlyWhenUnfocused: true,
		announceOnFirstRun: true,
		language: "auto"
	});
});

test("a fresh installation announces itself exactly once", async () => {
	const storage = new Map();
	const first = mount({ s1: ROOT_ROW }, "s1", { storage });
	await tick();
	assert.equal(FakeNotification.instances.length, 1, "the welcome banner fires on first attach");
	assert.equal(FakeNotification.instances[0].title, "通知已开启");
	assert.equal(FakeNotification.instances[0].silent, true, "the welcome banner never makes a sound");
	assert.ok(storage.has("dsh-notice:announced"), "the announcement is remembered");
	// A reload in the same installation must stay quiet: mounting resets the
	// recorder, so a remembered announcement leaves the list empty.
	mount({ s1: ROOT_ROW }, "s1", { storage });
	await tick();
	assert.equal(FakeNotification.instances.length, 0);
	assert.equal(first.api.prefs.announceOnFirstRun, true);
});

test("the welcome banner can be switched off before it ever fires", async () => {
	const storage = new Map([["dsh-notice:prefs", JSON.stringify({ announceOnFirstRun: false })]]);
	mount({ s1: ROOT_ROW }, "s1", { storage });
	await tick();
	assert.equal(FakeNotification.instances.length, 0);
});

test("state that predates the page load is not news", () => {
	const { publish } = mount({ s1: ROOT_ROW });
	// A refresh while an approval is already pending must stay silent.
	publish({ s1: { running: false, pendingInteraction: { key: "approval:1", kind: "approval", toolName: "bash" } } });
	assert.equal(FakeNotification.instances.length, 0);
	// ...and the same pending request still never re-notifies.
	publish({ s1: { running: false, pendingInteraction: { key: "approval:1", kind: "approval", toolName: "bash" } } });
	assert.equal(FakeNotification.instances.length, 0);
});

test("an approval request on the Session in view names the tool, not the Session", () => {
	const { publish } = mount({ s1: { ...ROOT_ROW, parentSessionId: undefined }, s2: undefined });
	publish({ s1: { running: true, pendingInteraction: undefined } });
	publish({ s1: { running: false, pendingInteraction: { key: "approval:7", kind: "approval", toolName: "bash" } } });
	assert.equal(FakeNotification.instances.length, 1);
	const [banner] = FakeNotification.instances;
	assert.equal(banner.title, "需要你的授权");
	assert.match(banner.body, /bash/u);
	assert.doesNotMatch(banner.body, /重构登录流程/u, "the Session the user is looking at needs no name");
	assert.equal(banner.tag, "dsh-notice-interaction-s1");
});

test("a user question raises a banner carrying the question text", () => {
	const { publish } = mount({ s1: ROOT_ROW });
	publish({ s1: { running: true, pendingInteraction: undefined } });
	publish({ s1: { running: false, pendingInteraction: { key: "q:1", kind: "question", questions: [{ id: "a", question: "选择哪个数据库？" }] } } });
	assert.equal(FakeNotification.instances.length, 1);
	assert.equal(FakeNotification.instances[0].title, "需要你的回答");
	assert.match(FakeNotification.instances[0].body, /选择哪个数据库？/u);
});

test("a plan review is announced as a review, not as a question", () => {
	const { publish } = mount({ s1: ROOT_ROW });
	publish({ s1: { running: true, pendingInteraction: undefined } });
	publish({ s1: { running: false, pendingInteraction: { key: "p:1", kind: "plan-review", questions: [] } } });
	assert.equal(FakeNotification.instances.length, 1);
	assert.equal(FakeNotification.instances[0].title, "等待你审阅计划");
});

test("a turn ending raises the completion banner", () => {
	const { publish } = mount({ s1: ROOT_ROW });
	publish({ s1: { running: true, pendingInteraction: undefined } });
	publish({ s1: { running: false, pendingInteraction: undefined } });
	assert.equal(FakeNotification.instances.length, 1);
	assert.equal(FakeNotification.instances[0].title, "任务已完成");
	assert.doesNotMatch(FakeNotification.instances[0].body, /重构登录流程/u);
});

test("a background Session's banner names it, clipped to a readable length", () => {
	const long = "这是一个特意写得非常长的会话标题用来验证截断行为是否生效";
	const { publish } = mount({ s1: ROOT_ROW, s2: { sessionId: "s2", title: long } }, "s1");
	publish({ s2: { running: true, pendingInteraction: undefined } });
	publish({ s2: { running: false, pendingInteraction: undefined } });
	assert.equal(FakeNotification.instances.length, 1);
	const body = FakeNotification.instances[0].body;
	assert.match(body, /「.{23}…」/u, "the Session name is clipped to 24 characters");
	assert.ok(!body.includes(long), "the full title never reaches the banner");
});

test("a turn that ends by asking the user notifies once, as a request", () => {
	const { publish } = mount({ s1: ROOT_ROW });
	publish({ s1: { running: true, pendingInteraction: undefined } });
	publish({ s1: { running: false, pendingInteraction: { key: "approval:9", kind: "approval", toolName: "write" } } });
	assert.equal(FakeNotification.instances.length, 1);
	assert.equal(FakeNotification.instances[0].title, "需要你的授权");
});

test("subagent sessions never raise a banner", () => {
	const rows = { s1: ROOT_ROW, sub: { sessionId: "sub", title: "子代理", parentSessionId: "s1" } };
	const { publish } = mount(rows);
	publish({ sub: { running: true, pendingInteraction: undefined } });
	publish({ sub: { running: false, pendingInteraction: undefined } });
	assert.equal(FakeNotification.instances.length, 0);
});

test("a focused window suppresses only the Session it is already showing", () => {
	const rows = { s1: ROOT_ROW, s2: { sessionId: "s2", title: "另一个会话" } };
	const { publish } = mount(rows, "s2", { focused: true });
	// s2 is on screen and the window has focus: the composer is already visible.
	publish({ s1: { running: true, pendingInteraction: undefined }, s2: { running: true, pendingInteraction: undefined } });
	publish({ s1: { running: false, pendingInteraction: undefined }, s2: { running: false, pendingInteraction: undefined } });
	assert.equal(FakeNotification.instances.length, 1, "only the background Session notifies");
	assert.match(FakeNotification.instances[0].body, /重构登录流程/u, "a background Session is named");
});

test("a focused window on the notifying Session suppresses the request banner too", () => {
	const { publish } = mount({ s1: ROOT_ROW }, "s1", { focused: true });
	publish({ s1: { running: true, pendingInteraction: undefined } });
	publish({ s1: { running: false, pendingInteraction: { key: "approval:8", kind: "approval", toolName: "bash" } } });
	assert.equal(FakeNotification.instances.length, 0);
});

test("onlyWhenUnfocused: false notifies even while the Session is on screen", () => {
	const { publish, api } = mount({ s1: ROOT_ROW }, "s1", { focused: true });
	api.set({ onlyWhenUnfocused: false });
	publish({ s1: { running: true, pendingInteraction: undefined } });
	publish({ s1: { running: false, pendingInteraction: undefined } });
	assert.equal(FakeNotification.instances.length, 1);
});

test("the application locale decides the copy, not the renderer's navigator language", () => {
	// The bug this guards: a Desktop renderer reports `en-US` through navigator
	// while the application itself is running in Chinese.
	const { publish, api } = mount({ s1: ROOT_ROW }, "s1", { locale: "zh" });
	assert.equal(plain(api.state()).language, "zh");
	assert.equal(plain(api.state()).detectedLocale, "zh");
	publish({ s1: { running: true, pendingInteraction: undefined } });
	publish({ s1: { running: false, pendingInteraction: undefined } });
	assert.equal(FakeNotification.instances[0].title, "任务已完成");
});

test("the language decision is recorded for diagnosis without developer tools", () => {
	const storage = new Map([["dsh-notice:announced", "2026-01-01T00:00:00.000Z"]]);
	mount({ s1: ROOT_ROW }, "s1", { storage, locale: "en" });
	const record = JSON.parse(storage.get("dsh-notice:diag"));
	assert.equal(record.locale, "en");
	assert.equal(record.copy, "en");
	assert.equal(record.preference, "auto");
	assert.deepEqual(record.navigatorLanguages, ["en-US", "en"]);
});

test("an English application still gets English copy", () => {
	const { publish, api } = mount({ s1: ROOT_ROW }, "s1", { locale: "en" });
	assert.equal(plain(api.state()).language, "en");
	publish({ s1: { running: true, pendingInteraction: undefined } });
	publish({ s1: { running: false, pendingInteraction: undefined } });
	assert.equal(FakeNotification.instances[0].title, "Task finished");
});

test("an explicit language preference overrides the application locale", () => {
	const forced = mount({ s1: ROOT_ROW }, "s1", { locale: "en" });
	forced.api.set({ language: "zh" });
	forced.publish({ s1: { running: true, pendingInteraction: undefined } });
	forced.publish({ s1: { running: false, pendingInteraction: undefined } });
	assert.equal(FakeNotification.instances[0].title, "任务已完成", "language: zh wins over an English application");

	const reversed = mount({ s1: ROOT_ROW }, "s1", { locale: "zh" });
	reversed.api.set({ language: "en" });
	reversed.publish({ s1: { running: true, pendingInteraction: undefined } });
	reversed.publish({ s1: { running: false, pendingInteraction: undefined } });
	assert.equal(FakeNotification.instances[0].title, "Task finished", "language: en wins over a Chinese application");
});

test("the completion channel can be switched off while requests keep working", () => {
	const { publish, api } = mount({ s1: ROOT_ROW });
	api.set({ onComplete: false });
	publish({ s1: { running: true, pendingInteraction: undefined } });
	publish({ s1: { running: false, pendingInteraction: undefined } });
	assert.equal(FakeNotification.instances.length, 0);
	publish({ s1: { running: false, pendingInteraction: { key: "approval:2", kind: "approval", toolName: "bash" } } });
	assert.equal(FakeNotification.instances.length, 1);
});

test("the master switch stops every banner", () => {
	const { publish, api } = mount({ s1: ROOT_ROW });
	api.set({ enabled: false });
	publish({ s1: { running: true, pendingInteraction: undefined } });
	publish({ s1: { running: false, pendingInteraction: { key: "approval:3", kind: "approval", toolName: "bash" } } });
	assert.equal(FakeNotification.instances.length, 0);
});

test("clicking a banner focuses the window and closes the banner", () => {
	const { publish, sandbox } = mount({ s1: ROOT_ROW });
	publish({ s1: { running: true, pendingInteraction: undefined } });
	publish({ s1: { running: false, pendingInteraction: undefined } });
	const banner = FakeNotification.instances[0];
	banner.click();
	assert.equal(sandbox.__focused, true);
	assert.equal(banner.closed, true);
});

test("sound follows the preference", async () => {
	const { api } = mount({ s1: ROOT_ROW });
	await api.test("complete");
	assert.equal(FakeNotification.instances.length, 1);
	assert.equal(FakeNotification.instances[0].silent, false);
	api.set({ sound: false });
	await api.test("complete");
	assert.equal(FakeNotification.instances[1].silent, true);
});

test("delivery is skipped, not thrown, while permission is not granted", async () => {
	const { publish, api } = mount({ s1: ROOT_ROW });
	FakeNotification.permission = "denied";
	publish({ s1: { running: true, pendingInteraction: undefined } });
	publish({ s1: { running: false, pendingInteraction: undefined } });
	assert.equal(FakeNotification.instances.length, 0);
	assert.deepEqual(plain(await api.test()), { delivered: false, reason: "permission" });
	FakeNotification.permission = "granted";
});

test("disposing the plugin unsubscribes the status store", () => {
	const { disposers, listeners } = mount({ s1: ROOT_ROW });
	assert.equal(disposers.length, 1);
	assert.equal(listeners.size, 1);
	disposers[0]();
	assert.equal(listeners.size, 0);
});

test("a host without the Notification API degrades to a no-op", async () => {
	const { specification, sandbox } = loadBundle();
	delete sandbox.Notification;
	FakeNotification.reset();
	const exported = specification.factory(() => {
		throw new Error("unreachable");
	});
	const { ctx, publish } = makeContext({ s1: ROOT_ROW }, "s1");
	exported.apply(ctx);
	publish({ s1: { running: true, pendingInteraction: undefined } });
	publish({ s1: { running: false, pendingInteraction: undefined } });
	assert.equal(FakeNotification.instances.length, 0);
	assert.equal(sandbox.__DSH_NOTICE__.state().permission, "unsupported");
	assert.deepEqual(plain(await sandbox.__DSH_NOTICE__.test()), { delivered: false, reason: "permission" });
});

test("a composition without the Session list service still notifies", () => {
	const { specification } = loadBundle();
	FakeNotification.reset();
	const exported = specification.factory(() => {
		throw new Error("unreachable");
	});
	const listeners = new Set();
	const store = {
		snapshot: new Map(),
		getSnapshot() {
			return this.snapshot;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}
	};
	exported.apply({
		uiSession: { sessionStatus: store, adapter: { current: { getSnapshot: () => ({ key: undefined }) } } },
		get: (name) => (name === "locale" ? { getSnapshot: () => ({ active: "zh" }) } : undefined),
		effect: (run) => {
			run();
		}
	});
	store.snapshot = new Map([["s1", { running: true, pendingInteraction: undefined }]]);
	for (const listener of [...listeners]) listener();
	store.snapshot = new Map([["s1", { running: false, pendingInteraction: undefined }]]);
	for (const listener of [...listeners]) listener();
	assert.equal(FakeNotification.instances.length, 1);
	assert.equal(FakeNotification.instances[0].title, "任务已完成");
});
