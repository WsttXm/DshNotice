#!/usr/bin/env node
/**
 * Install, uninstall, or inspect the `dsh-notice` plugin row in a DSH profile.
 *
 * The plugin is a *plain* Cordis plugin — it declares no `dsh.bundle.patch` — so
 * `dsh plugin --profile <name> add` would only install a dependency and print a
 * warning; the loader row is the user's to write. This script writes exactly
 * that row, and nothing else:
 *
 *   1. links `packages/dsh-notice` into `<profile>/node_modules/dsh-notice`, so
 *      the row can name the package the way any other plugin is named;
 *   2. appends a marker-delimited `insert` entry to `<profile>/cordis.patch.yml`
 *      that mounts row `notice` from that package.
 *
 * Both steps are idempotent and reversible, and the patch file is backed up
 * before the first write. Running `install` again repairs a link left dangling
 * by a working copy that moved. `dsh-base` enables `@deepseek-ai/dsh-hmr` for
 * every profile, and HMR watches `cordis.patch.yml`, so a running application
 * recomposes on its own a few seconds after the file settles: no restart is
 * needed. A browser window still has to be reloaded to pick up the new client
 * module, because `window.__DSH_BOOT__` is computed per page load.
 *
 * Usage:
 *   node plugin.mjs install   [--profile desktop] [--home ~/.dsh] [--dry-run]
 *   node plugin.mjs uninstall [--profile desktop] [--home ~/.dsh]
 *   node plugin.mjs status    [--profile desktop] [--home ~/.dsh]
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root, derived from this script's own location. */
const ROOT = dirname(fileURLToPath(import.meta.url));
/** The plugin package this script installs. */
const PACKAGE_NAME = "dsh-notice";
/** Absolute path of the plugin package directory. */
const PACKAGE_DIR = join(ROOT, "packages", PACKAGE_NAME);
/** Loader row id written into the profile patch; stable across reinstalls. */
const ROW_ID = "notice";
/** Opening marker that delimits the block this script owns. */
const BEGIN = `# >>> ${PACKAGE_NAME} (managed by plugin.mjs — edit the script, not this block) >>>`;
/** Closing marker that delimits the block this script owns. */
const END = `# <<< ${PACKAGE_NAME} <<<`;

/**
 * Read the `--flag value` command line into a plain object.
 * @param argv - arguments after the subcommand.
 * @returns the recognised options.
 */
function parseOptions(argv) {
	const options = { dryRun: argv.includes("--dry-run") };
	for (let index = 0; index < argv.length; index++) {
		if (argv[index] === "--profile") options.profile = argv[++index];
		else if (argv[index] === "--home") options.home = argv[++index];
	}
	return options;
}

/**
 * Resolve the Harness home and the target profile directory.
 * @param options - parsed options.
 * @returns absolute profile directory, patch path, and link path.
 */
function locateProfile(options) {
	const home = resolve(options.home ?? process.env.DSH_HOME ?? join(homedir(), ".dsh"));
	const profileDir = join(home, "profiles", options.profile ?? "desktop");
	return {
		home,
		profileDir,
		patchPath: join(profileDir, "cordis.patch.yml"),
		linkPath: join(profileDir, "node_modules", PACKAGE_NAME)
	};
}

/**
 * Refuse to touch anything that is not the profile patch this script expects.
 * A profile is identified by its own `package.json`, which also guarantees the
 * directory is a DSH profile rather than an arbitrary path a flag produced.
 * @param location - resolved profile paths.
 */
function assertProfile(location) {
	if (!existsSync(join(location.profileDir, "package.json"))) {
		throw new Error(`not a DSH profile (no package.json): ${location.profileDir}`);
	}
	const resolved = resolve(location.patchPath);
	if (resolved !== join(location.profileDir, "cordis.patch.yml")) throw new Error(`refusing to write ${resolved}`);
	return resolved;
}

/** Verify the plugin package is complete before installing anything. */
function assertPackage() {
	for (const file of ["package.json", "lib/index.js", "lib/client.js"]) {
		if (!existsSync(join(PACKAGE_DIR, file))) throw new Error(`plugin package is incomplete, missing ${file}`);
	}
	const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8"));
	if (manifest.name !== PACKAGE_NAME) throw new Error(`plugin package is named ${manifest.name}, expected ${PACKAGE_NAME}`);
	if (manifest.dsh?.client?.platform !== "web") throw new Error("plugin package declares no web client half");
	return manifest;
}

/**
 * Resolve a symlink's destination, or undefined when it dangles. A checkout
 * that moved leaves one behind, and `existsSync` reports a dangling link as
 * absent while `lstat` still reports a symlink — which is exactly the state the
 * installer has to repair rather than trip over.
 * @param path - the link to resolve.
 * @returns the resolved destination, or undefined.
 */
function linkDestination(path) {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

/**
 * Describe the profile's link to this working copy.
 * @param location - resolved profile paths.
 * @returns `yes` when it resolves, `broken` when it dangles, or why not.
 */
function linkState(location) {
	const stats = lstatSync(location.linkPath, { throwIfNoEntry: false });
	if (stats === undefined) return "no";
	if (!stats.isSymbolicLink()) return "not a symlink";
	return linkDestination(location.linkPath) === undefined ? "broken" : "yes";
}

/**
 * Where `<profile>/node_modules/dsh-notice` should point.
 *
 * A relative link survives moving the working copy and the Harness home
 * together, but it has to be derived from *physical* directories: the kernel
 * resolves the `..` in a symlink target against the real tree, so a profile
 * reached through a symlinked prefix — macOS `/var` is really `/private/var`,
 * and a home directory can be a symlink too — would otherwise be handed a link
 * that dangles the instant it is created.
 * @param location - resolved profile paths.
 * @returns the symlink target to write.
 */
function linkTarget(location) {
	if (process.platform === "win32") return PACKAGE_DIR;
	const from = join(realpathSync(location.profileDir), "node_modules");
	const to = realpathSync(PACKAGE_DIR);
	return relative(from, to) || to;
}

/**
 * Point `<profile>/node_modules/dsh-notice` at the working copy, so the profile
 * resolves the package exactly as it resolves its bundles. Any previous link is
 * replaced — including a stale one left by a checkout that moved. An entry that
 * is not a symlink is never overwritten.
 * @param location - resolved profile paths.
 * @param dryRun - report instead of writing.
 * @returns a line describing what happened.
 */
function linkPackage(location, dryRun) {
	const existing = lstatSync(location.linkPath, { throwIfNoEntry: false });
	if (existing !== undefined && !existing.isSymbolicLink()) {
		throw new Error(`${location.linkPath} exists and is not a symlink; remove it yourself first`);
	}
	if (existing?.isSymbolicLink() && linkDestination(location.linkPath) === realpathSync(PACKAGE_DIR)) {
		return `link already correct: ${location.linkPath} -> ${PACKAGE_DIR}`;
	}
	const note = existing === undefined ? "" : " (replacing a stale link)";
	const target = linkTarget(location);
	if (dryRun) return `link would be written: ${location.linkPath} -> ${target}${note}`;
	mkdirSync(dirname(location.linkPath), { recursive: true });
	if (existing !== undefined) rmSync(location.linkPath, { force: true });
	symlinkSync(target, location.linkPath, "dir");
	return `link written: ${location.linkPath} -> ${target}${note}`;
}

/**
 * Splice the managed block into the profile patch, replacing any previous copy.
 * Everything outside the markers — including patches the user wrote before or
 * after this block — is preserved byte for byte.
 * @param location - resolved profile paths.
 * @param block - replacement block text, or undefined to remove the block.
 * @param dryRun - report instead of writing.
 * @param backup - where to save the previous file, when there is one to save.
 * @returns a line describing what happened, plus the backup path once written.
 */
function writePatch(location, block, dryRun, backup) {
	const patchPath = assertProfile(location);
	const original = existsSync(patchPath) ? readFileSync(patchPath, "utf8") : "[]\n";
	const start = original.indexOf(BEGIN);
	const end = original.indexOf(END);
	let next;
	let action;
	if (start !== -1 && end !== -1 && end > start) {
		const before = original.slice(0, start);
		const after = original.slice(end + END.length).replace(/^\n+/u, "");
		next = block === undefined
			? `${before.replace(/\n+$/u, "\n")}${after}`
			: `${before}${block}${after}`;
		action = block === undefined ? "block removed from" : "block replaced in";
	} else if (start !== -1 || end !== -1) {
		throw new Error(`${patchPath} has an unbalanced ${PACKAGE_NAME} marker block; repair it by hand`);
	} else if (block === undefined) {
		return `no ${PACKAGE_NAME} block in ${patchPath}; nothing to remove`;
	} else {
		const base = original.replace(/\s*$/u, "");
		next = `${base === "" || base === "[]" ? "[]" : base}\n\n${block}`;
		action = "block appended to";
	}
	if (next === original) return `patch already current: ${patchPath}`;
	if (dryRun) return `${action.slice(0, -3)} would be applied to ${patchPath}`;
	// Back up only on a write that actually happens, so a repeated install does
	// not litter the profile with identical copies.
	const saved = backup !== undefined && existsSync(patchPath) ? backup : undefined;
	if (saved !== undefined) writeFileSync(saved, original);
	writeFileSync(patchPath, next);
	return `${action} ${patchPath}${saved === undefined ? "" : `\nbackup: ${saved}`}`;
}

/** Render the managed block for the current working copy. */
function managedBlock() {
	return [
		BEGIN,
		"# Mounts the DSH notification plugin. The row names the package linked into",
		"# <profile>/node_modules by this script; the package's own ./client bundle",
		"# supplies the browser half.",
		"- insert:",
		`    - id: ${ROW_ID}`,
		`      name: '${PACKAGE_NAME}'`,
		END,
		""
	].join("\n");
}

/** Report whether Node resolves the row's package name from the profile. */
function verifyResolution(location) {
	if (!existsSync(join(location.profileDir, "package.json"))) return "profile missing";
	const require = createRequire(join(location.profileDir, "package.json"));
	try {
		const manifestPath = require.resolve(`${PACKAGE_NAME}/package.json`);
		return `resolves from the profile: ${manifestPath}`;
	} catch (error) {
		return `NOT resolvable from the profile: ${error.message}`;
	}
}

const [command = "status", ...rest] = process.argv.slice(2);
const options = parseOptions(rest);
const location = locateProfile(options);

try {
	if (command === "install") {
		assertPackage();
		assertProfile(location);
		const hadPatch = existsSync(location.patchPath);
		const backup = `${location.patchPath}.${PACKAGE_NAME}-backup-${Date.now()}`;
		console.log(linkPackage(location, options.dryRun));
		console.log(writePatch(location, managedBlock(), options.dryRun, hadPatch ? backup : undefined));
		console.log(verifyResolution(location));
		console.log("");
		console.log("The running application watches cordis.patch.yml and recomposes within a few seconds.");
		console.log("Reload the window (⌘R) to load the new client module, then confirm with:");
		console.log("  window.__DSH_NOTICE__.test()      // fire a sample banner");
		console.log("  window.__DSH_NOTICE__.state()     // permission, attachment, recent banners");
	} else if (command === "uninstall") {
		console.log(writePatch(location, undefined, options.dryRun));
		const stats = lstatSync(location.linkPath, { throwIfNoEntry: false });
		if (stats?.isSymbolicLink()) {
			if (options.dryRun) console.log(`link would be removed: ${location.linkPath}`);
			else {
				rmSync(location.linkPath, { force: true });
				console.log(`link removed: ${location.linkPath}`);
			}
		} else if (stats !== undefined) {
			console.log(`link left alone, it is not a symlink this script wrote: ${location.linkPath}`);
		}
		console.log("Reload the window (⌘R) or restart the application to unload the plugin.");
	} else if (command === "status") {
		const patch = existsSync(location.patchPath) ? readFileSync(location.patchPath, "utf8") : "";
		console.log(`profile        : ${location.profileDir}`);
		console.log(`patch file     : ${location.patchPath}${existsSync(location.patchPath) ? "" : " (absent)"}`);
		console.log(`row installed  : ${patch.includes(BEGIN) ? "yes" : "no"}`);
		console.log(`package linked : ${linkState(location)}`);
		console.log(verifyResolution(location));
	} else {
		console.error(`unknown command: ${command}`);
		console.error("usage: node plugin.mjs <install|uninstall|status> [--profile desktop] [--home ~/.dsh] [--dry-run]");
		process.exitCode = 2;
	}
} catch (error) {
	console.error(`plugin.mjs: ${error.message}`);
	process.exitCode = 1;
}
