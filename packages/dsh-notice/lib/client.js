/**
 * Browser half of `dsh-notice`: turns Session status transitions into native
 * operating-system notifications through the Web Notifications API.
 *
 * The Desktop application runs its renderer on the `dsh-app://app` origin and
 * installs a permission handler that grants every non-media permission, so a
 * `Notification` created here is delivered by macOS as a notification from
 * "DeepSeek Harness" itself — with the application icon, in Notification
 * Center, and honouring the per-application settings in System Settings.
 * An ordinary browser tab falls back to the same API behind its own
 * permission prompt.
 *
 * Everything is passive: the plugin only observes the Session status store, so
 * it can never intercept or answer an approval or a question. It never
 * replaces the composer takeover that belongs to the owning UI plugins.
 *
 * This file is a published client bundle, not an ES module: `dsh-client-modules`
 * serves it to `window.__ModuleLoader__`, which calls `factory(require)` and
 * mounts the returned `apply`/`inject` pair as a Cordis plugin. It therefore
 * has no imports and declares no `dsh.client.external` entries.
 */
window.__ModuleLoader__.load({
	id: "dsh-notice",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		//#region copy
		/** Chinese notification copy. */
		const COPY_ZH = {
			approvalTitle: "需要你的授权",
			approvalBody: (label, tool) => `${label ? `「${label}」` : "当前会话"}想要执行 ${tool || "受保护的操作"}，请回到应用确认。`,
			questionTitle: "需要你的回答",
			questionBody: (label, question) => question ? `${label ? `「${label}」` : ""}${question}` : `${label ? `「${label}」` : "当前会话"}正在等待你的回答。`,
			reviewTitle: "等待你审阅计划",
			reviewBody: (label) => `${label ? `「${label}」` : "当前会话"}提交了一份计划，等待你确认。`,
			genericTitle: "需要你的操作",
			genericBody: (label) => `${label ? `「${label}」` : "当前会话"}正在等待你继续。`,
			doneTitle: "任务已完成",
			doneBody: (label) => `${label ? `「${label}」` : "当前会话"}已完成本轮任务。`,
			readyTitle: "通知已开启",
			readyBody: "需要你确认、回答问题，或一轮任务完成时，会在这里提醒你。"
		};
		/** English notification copy. */
		const COPY_EN = {
			approvalTitle: "Approval needed",
			approvalBody: (label, tool) => `${label ? `"${label}"` : "This session"} wants to run ${tool || "a protected action"}. Return to the app to decide.`,
			questionTitle: "Your answer is needed",
			questionBody: (label, question) => question ? `${label ? `"${label}" · ` : ""}${question}` : `${label ? `"${label}"` : "This session"} is waiting for your answer.`,
			reviewTitle: "Plan awaiting review",
			reviewBody: (label) => `${label ? `"${label}"` : "This session"} submitted a plan for your approval.`,
			genericTitle: "Action needed",
			genericBody: (label) => `${label ? `"${label}"` : "This session"} is waiting for you to continue.`,
			doneTitle: "Task finished",
			doneBody: (label) => `${label ? `"${label}"` : "This session"} finished this turn.`,
			readyTitle: "Notifications are on",
			readyBody: "You will be notified here when the agent needs a decision, asks a question, or finishes a turn."
		};
		/**
		 * The copy table in force. Replaced by {@link followLocale} rather than
		 * frozen at load, because the user can change the application language at
		 * any time and the next banner must follow it.
		 */
		let COPY = COPY_EN;
		/**
		 * Read the language the application itself is using.
		 *
		 * The application's own locale service is authoritative and comes first.
		 * `navigator.language` is only a last resort: a Desktop renderer reports
		 * Chromium's own default there, while the language the user picked travels
		 * separately through the locale plugin's native bootstrap — reading
		 * `navigator` alone yields English copy inside a Chinese application.
		 * @param ctx - client root context.
		 * @returns the active locale id, or undefined where nothing declares one.
		 */
		function appLocale(ctx) {
			try {
				const active = ctx?.get?.("locale")?.getSnapshot?.()?.active;
				if (typeof active === "string" && active !== "") return active;
			} catch {
				/* an absent or not-yet-loaded locale service falls through */
			}
			try {
				const declared = globalThis.document?.documentElement?.lang;
				if (typeof declared === "string" && declared !== "") return declared;
			} catch {
				/* a document without a lang attribute falls through */
			}
			try {
				const languages = globalThis.navigator?.languages;
				const first = Array.isArray(languages) ? languages[0] : undefined;
				return first ?? globalThis.navigator?.language;
			} catch {
				return undefined;
			}
		}
		/**
		 * Point {@link COPY} at the language to notify in: the user's explicit
		 * preference when set, otherwise whatever the application is using.
		 * @param ctx - client root context.
		 */
		function followLocale(ctx) {
			const preference = prefs.language;
			if (preference === "zh") COPY = COPY_ZH;
			else if (preference === "en") COPY = COPY_EN;
			else COPY = String(appLocale(ctx) ?? "").toLowerCase().startsWith("zh") ? COPY_ZH : COPY_EN;
		}
		/**
		 * Record what the language decision saw, and keep the record stable so it
		 * only rewrites when something actually changes. A banner in the wrong
		 * language is otherwise indistinguishable from one with the wrong text,
		 * and this is the only evidence reachable without developer tools.
		 * @param ctx - client root context.
		 */
		function recordLocale(ctx) {
			try {
				const storage = globalThis.localStorage;
				if (storage === undefined) return;
				const summary = JSON.stringify({
					locale: appLocale(ctx) ?? null,
					copy: COPY === COPY_ZH ? "zh" : "en",
					preference: prefs.language,
					navigatorLanguage: globalThis.navigator?.language ?? null,
					navigatorLanguages: globalThis.navigator?.languages ?? null,
					documentLanguage: globalThis.document?.documentElement?.lang ?? null
				});
				if (storage.getItem(DIAG_KEY) !== summary) storage.setItem(DIAG_KEY, summary);
			} catch {
				/* a full or unavailable storage only costs the diagnostic */
			}
		}
		//#endregion

		//#region preferences
		/** Storage key for user preferences; absent means the defaults below. */
		const PREFS_KEY = "dsh-notice:prefs";
		/** Storage key recording that the welcome banner was already shown on this machine. */
		const ANNOUNCED_KEY = "dsh-notice:announced";
		/** Storage key holding the last locale detection, so a wrong-language banner can be explained. */
		const DIAG_KEY = "dsh-notice:diag";
		/** Shipped defaults: notify for both moments, only while the window is not on that Session. */
		const DEFAULT_PREFS = Object.freeze({
			enabled: true,
			onInteraction: true,
			onComplete: true,
			sound: true,
			onlyWhenUnfocused: true,
			announceOnFirstRun: true,
			language: "auto"
		});
		/** Read the stored preference overlay, tolerating unavailable or corrupt storage. */
		function loadPrefs() {
			try {
				const raw = globalThis.localStorage?.getItem(PREFS_KEY);
				const stored = raw ? JSON.parse(raw) : undefined;
				return stored && typeof stored === "object" ? { ...DEFAULT_PREFS, ...stored } : { ...DEFAULT_PREFS };
			} catch {
				return { ...DEFAULT_PREFS };
			}
		}
		/** Persist the current preference overlay; storage failure is not fatal. */
		function savePrefs(prefs) {
			try {
				globalThis.localStorage?.setItem(PREFS_KEY, JSON.stringify(prefs));
			} catch {
				/* private mode or a full quota: the in-memory overlay still applies */
			}
		}
		//#endregion

		//#region notification channel
		/** Notification permission states we act on; anything else disables delivery. */
		const GRANTED = "granted";
		/** Resolve the constructor, or undefined where the platform has no Notifications API. */
		function notificationCtor() {
			const ctor = globalThis.Notification;
			return typeof ctor === "function" ? ctor : undefined;
		}
		/** Whether the current environment can deliver a notification right now. */
		function deliverable() {
			const ctor = notificationCtor();
			return ctor !== undefined && ctor.permission === GRANTED;
		}
		/**
		 * Ask for notification permission when the platform still reports the
		 * `default` state. Browsers may ignore a request made without a user
		 * gesture, so the caller arms {@link armGestureRequest} as well.
		 * @returns whether permission is granted once the request settles.
		 */
		function requestPermission() {
			const ctor = notificationCtor();
			if (ctor === undefined) return Promise.resolve(false);
			if (ctor.permission === GRANTED) return Promise.resolve(true);
			if (ctor.permission === "denied") return Promise.resolve(false);
			try {
				const outcome = ctor.requestPermission();
				return Promise.resolve(outcome).then((value) => value === GRANTED, () => false);
			} catch {
				return Promise.resolve(false);
			}
		}
		/**
		 * Retry the permission request on the next user gesture, which is the only
		 * moment a browser is guaranteed to honour it. Listeners are once-only and
		 * are removed as soon as either fires.
		 * @param onGranted - called when the gesture-time request succeeds.
		 */
		function armGestureRequest(onGranted) {
			const ctor = notificationCtor();
			if (ctor === undefined || ctor.permission !== "default") return;
			const target = globalThis.document;
			if (target === undefined) return;
			const once = () => {
				target.removeEventListener("pointerdown", once, true);
				target.removeEventListener("keydown", once, true);
				requestPermission().then((granted) => {
					if (granted) onGranted();
				});
			};
			target.addEventListener("pointerdown", once, true);
			target.addEventListener("keydown", once, true);
		}
		/** Truncate notification body copy to the length macOS shows without eliding the point. */
		function clip(text, limit = 140) {
			const flat = String(text).replace(/\s+/gu, " ").trim();
			return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
		}
		/**
		 * Post one native notification.
		 * @param title - banner title.
		 * @param body - banner body.
		 * @param options - `tag` coalesces repeats; `onClick` runs after the window is focused.
		 * @returns the created notification, or undefined when delivery is unavailable.
		 */
		function post(title, body, options = {}) {
			if (!deliverable()) return undefined;
			try {
				const notification = new (notificationCtor())(title, {
					body,
					tag: options.tag,
					silent: !options.sound
				});
				notification.onclick = () => {
					try {
						globalThis.focus?.();
					} catch {
						/* focusing is best effort */
					}
					try {
						options.onClick?.();
					} catch {
						/* a click handler must never break the notification */
					}
					try {
						notification.close();
					} catch {
						/* closing is best effort */
					}
				};
				return notification;
			} catch {
				return undefined;
			}
		}
		//#endregion

		//#region session facts
		/** Read a Cordis service without throwing when the composition omits it. */
		function service(ctx, name) {
			try {
				return ctx.get?.(name);
			} catch {
				return undefined;
			}
		}
		/** Read one Session list row, or undefined when the list service is absent. */
		function sessionRow(ctx, id) {
			const list = service(ctx, "sessions")?.list;
			if (list === undefined || typeof list.getSnapshot !== "function") return undefined;
			try {
				return list.getSnapshot()?.byId?.[id];
			} catch {
				return undefined;
			}
		}
		/** Display label for a Session: its durable title, else its project directory basename. */
		function sessionLabel(ctx, id) {
			const row = sessionRow(ctx, id);
			if (row === undefined) return undefined;
			if (typeof row.title === "string" && row.title.trim() !== "") return clip(row.title.trim(), 24);
			const segments = String(row.cwd ?? "").split("/").filter((segment) => segment !== "");
			return segments.length > 0 ? segments[segments.length - 1] : undefined;
		}
		/**
		 * Whether a Session is a user-facing conversation. Subagent Sessions are
		 * internal work that the user never sees, so they never raise a banner;
		 * an unknown Session is treated as user-facing rather than silently dropped.
		 */
		function isUserFacing(ctx, id) {
			const row = sessionRow(ctx, id);
			if (row === undefined) return true;
			return row.parentSessionId === undefined && row.blank !== true;
		}
		/** Identity of the Session the main view currently shows, when one is bound. */
		function activeSessionId(ctx) {
			const ui = ctx.uiSession;
			const source = ui?.adapter?.current ?? ui?.current;
			if (source === undefined || typeof source.getSnapshot !== "function") return undefined;
			try {
				return source.getSnapshot()?.key;
			} catch {
				return undefined;
			}
		}
		/** Whether this window is visible and frontmost, so the user is already looking at it. */
		function windowFocused() {
			const target = globalThis.document;
			if (target === undefined) return false;
			try {
				return target.visibilityState === "visible" && target.hasFocus();
			} catch {
				return false;
			}
		}
		/** First question's text from a pending question batch, for the banner body. */
		function firstQuestionText(pending) {
			const questions = pending?.questions;
			if (!Array.isArray(questions) || questions.length === 0) return undefined;
			const first = questions[0];
			const text = typeof first === "string" ? first : first?.question ?? first?.text ?? first?.header ?? first?.prompt;
			return typeof text === "string" && text.trim() !== "" ? clip(text) : undefined;
		}
		//#endregion

		//#region state machine
		/** Preferences shared by the state machine and the debug surface. */
		const prefs = loadPrefs();
		/** Facts about the attached runtime, published on `window.__DSH_NOTICE__`. */
		const runtime = { attached: false, permission: "unsupported", last: [], delivered: 0 };
		/** Fold one Session status snapshot into the transition index. */
		function indexOf(snapshot) {
			const index = new Map();
			for (const [id, status] of snapshot) {
				const pending = status?.pendingInteraction;
				index.set(id, {
					running: status?.running === true,
					pendingKey: pending?.key,
					pending
				});
			}
			return index;
		}
		/** Copy for one pending interaction, chosen by its domain discriminator. */
		function describeInteraction(pending, label) {
			const kind = pending?.kind;
			if (kind === "approval") return { title: COPY.approvalTitle, body: COPY.approvalBody(label, pending.toolName) };
			if (kind === "plan-review") return { title: COPY.reviewTitle, body: COPY.reviewBody(label) };
			if (kind === "question") return { title: COPY.questionTitle, body: COPY.questionBody(label, firstQuestionText(pending)) };
			return { title: COPY.genericTitle, body: COPY.genericBody(label) };
		}
		/**
		 * Build the observer that watches the Session status store.
		 * @param ctx - client root context.
		 * @returns teardown that unsubscribes the store listener.
		 */
		function observe(ctx) {
			const status = ctx.uiSession?.sessionStatus;
			if (status === undefined || typeof status.getSnapshot !== "function" || typeof status.subscribe !== "function") return () => {};
			let previous = new Map();
			let disposed = false;
			/** Read the store defensively; a throwing read must not break the subscription. */
			const snapshot = () => {
				try {
					return status.getSnapshot();
				} catch {
					return new Map();
				}
			};
			/** Publish one event as a native notification, honouring preferences and focus. */
			const dispatch = (event) => {
				if (!prefs.enabled || !isUserFacing(ctx, event.id)) return;
				// Resolve the copy here rather than at load: the language can change
				// between banners, and the locale service may arrive after this plugin.
				followLocale(ctx);
				recordLocale(ctx);
				const active = activeSessionId(ctx);
				if (prefs.onlyWhenUnfocused && event.id === active && windowFocused()) return;
				// Name the Session only when the banner is about work the user is not
				// already looking at. On the Session in front of them the title adds
				// nothing but length — and a title derived from the opening prompt is a
				// whole sentence.
				const label = event.id === active ? undefined : sessionLabel(ctx, event.id);
				const message = event.kind === "interaction"
					? describeInteraction(event.pending, label)
					: { title: COPY.doneTitle, body: COPY.doneBody(label) };
				if (event.kind === "interaction" ? !prefs.onInteraction : !prefs.onComplete) return;
				const delivered = post(message.title, message.body, {
					tag: `dsh-notice-${event.kind}-${event.id}`,
					sound: prefs.sound
				});
				runtime.last.push({ kind: event.kind, sessionId: event.id, title: message.title, body: message.body, at: Date.now(), delivered: delivered !== undefined });
				if (runtime.last.length > 20) runtime.last.splice(0, runtime.last.length - 20);
				if (delivered !== undefined) runtime.delivered += 1;
			};
			/** Diff the store against the last snapshot and publish the transitions. */
			const reconcile = () => {
				const next = indexOf(snapshot());
				const events = [];
				for (const [id, current] of next) {
					const last = previous.get(id);
					if (last === undefined) continue;
					if (current.pendingKey !== undefined && current.pendingKey !== last.pendingKey) {
						events.push({ kind: "interaction", id, pending: current.pending });
						continue;
					}
					if (last.running === true && !current.running && current.pendingKey === undefined && last.pendingKey === undefined) {
						events.push({ kind: "complete", id });
					}
				}
				previous = next;
				for (const event of events) dispatch(event);
			};
			// Seed without publishing: state that predates this page load is not news.
			previous = indexOf(snapshot());
			const off = status.subscribe(() => {
				if (!disposed) reconcile();
			});
			runtime.attached = true;
			return () => {
				disposed = true;
				runtime.attached = false;
				try {
					off?.();
				} catch {
					/* the store may already be torn down with the Controller generation */
				}
			};
		}
		//#endregion

		//#region debug surface
		/** Context captured at {@link apply}, used by the debug surface to read the live locale. */
		let host;

		/** Publish a small inspection and control surface for users, scripts, and this package's tests. */
		function publishDebugSurface() {
			const api = {
				get prefs() {
					return { ...prefs };
				},
				/** Merge a preference patch and persist it. */
				set(patch) {
					Object.assign(prefs, patch ?? {});
					savePrefs(prefs);
					return { ...prefs };
				},
				/** Restore the shipped defaults. */
				reset() {
					Object.assign(prefs, DEFAULT_PREFS);
					savePrefs(prefs);
					return { ...prefs };
				},
				/** Report environment facts that explain why a banner may not appear. */
				state() {
					const ctor = notificationCtor();
					return {
						prefs: { ...prefs },
						attached: runtime.attached,
						permission: ctor === undefined ? "unsupported" : ctor.permission,
						delivered: runtime.delivered,
						language: COPY === COPY_ZH ? "zh" : "en",
						detectedLocale: appLocale(host),
						recent: runtime.last.slice()
					};
				},
				/** Ask for permission now; resolves to the resulting availability. */
				request() {
					return requestPermission();
				},
				/** Fire a sample notification so a user can verify the channel end to end. */
				async test(kind = "interaction") {
					const granted = await requestPermission();
					if (!granted) return { delivered: false, reason: "permission" };
					followLocale(host);
					const message = kind === "complete"
						? { title: COPY.doneTitle, body: COPY.doneBody("dsh-notice") }
						: { title: COPY.approvalTitle, body: COPY.approvalBody("dsh-notice", "test") };
					const delivered = post(message.title, message.body, { tag: `dsh-notice-test-${kind}`, sound: prefs.sound });
					return { delivered: delivered !== undefined, ...message };
				}
			};
			try {
				globalThis.__DSH_NOTICE__ = api;
			} catch {
				/* a frozen global only costs the debug surface */
			}
			return api;
		}
		//#endregion

		/**
		 * Show the one-time welcome banner that proves the channel works end to
		 * end, and record that it was shown. A user who has never seen a
		 * notification otherwise has no way to tell an installed plugin from a
		 * blocked one, because both stay silent until the agent needs them.
		 */
		function announceOnce() {
			if (!prefs.enabled || !prefs.announceOnFirstRun) return;
			try {
				if (globalThis.localStorage?.getItem(ANNOUNCED_KEY) != null) return;
				globalThis.localStorage?.setItem(ANNOUNCED_KEY, new Date().toISOString());
			} catch {
				return;
			}
			post(COPY.readyTitle, COPY.readyBody, { tag: "dsh-notice-ready", sound: false });
		}

		/** Required service: Session status and the main-view binding both live on the Session UI adapter. */
		const inject = ["uiSession"];

		/**
		 * Attach the notification observer and publish the debug surface.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			host = ctx;
			followLocale(ctx);
			recordLocale(ctx);
			publishDebugSurface();
			requestPermission().then((granted) => {
				if (granted) {
					followLocale(ctx);
					announceOnce();
				} else armGestureRequest(() => {
					followLocale(ctx);
					announceOnce();
				});
			});
			ctx.effect(() => observe(ctx), "dsh-notice: Session status observer");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
