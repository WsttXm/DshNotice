/**
 * Host half of `dsh-notice`.
 *
 * The whole feature lives in the browser half (`./client`), because only a
 * renderer can hand a notification to the operating system under the
 * application's own identity: the Desktop window runs on the `dsh-app://app`
 * origin, where the shell's permission handler grants the `notifications`
 * permission, so macOS delivers the banner as "DeepSeek Harness" — with the
 * application icon, in Notification Center, and honouring that application's
 * settings in System Settings. Anywhere else the same Web Notifications API
 * falls back to the browser's own permission prompt.
 *
 * This half is still required: `dsh-client-modules` discovers browser bundles
 * by scanning the host Loader's entries for packages that declare `dsh.client`,
 * so the package must be mounted as an ordinary host row before its
 * `exports["./client"]` bundle is served to `window.__ModuleLoader__`.
 *
 * There is deliberately nothing else here. In particular the plugin never
 * touches the `approval/request` or `user-questions/request` waterfalls: it
 * observes the Session status projection instead, so it can never intercept,
 * answer, or delay a request that belongs to the user and to the UI plugins
 * that own those composers.
 */

/** Loader identity; the profile patch row id is what users edit. */
const name = "notice";

/**
 * Mount the host half.
 *
 * No service is required, so the row activates on every surface. Surfaces
 * without a browser client (headless, SDK, ACP) mount this no-op and are
 * otherwise unaffected.
 */
function apply() {}

export { apply, name };
