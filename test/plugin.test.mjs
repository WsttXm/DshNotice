/**
 * Tests for the installer CLI (`plugin.mjs`).
 *
 * The installer is the only thing users run by hand, so its two promises are
 * worth pinning down: it writes exactly one link plus one marker-delimited
 * block, and it can always take both back without disturbing whatever else the
 * profile patch contains.
 *
 * Run with: node --test test/plugin.test.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "plugin.mjs");
const PACKAGE_DIR = join(ROOT, "packages", "dsh-notice");
const DANGLING = "/nowhere/at/all/dsh-notice";

/** Patch content that must survive an install/uninstall round trip untouched. */
const PREEXISTING = [
	"# a patch the user wrote",
	"- id: something-else",
	"  config:",
	"    keep: me",
	""
].join("\n");

/**
 * Run the installer against a throw-away profile.
 * @param home - the fake Harness home.
 * @param args - arguments after the subcommand.
 * @returns stdout of the command.
 */
function run(home, ...args) {
	return execFileSync(process.execPath, [SCRIPT, ...args, "--home", home], { cwd: ROOT, encoding: "utf8" });
}

/**
 * Create a fake Harness home holding one desktop profile.
 * @param options - `patch` seeds the profile patch (undefined leaves it absent);
 *   `viaSymlink` reaches the home through a link, the way macOS reaches `/tmp`
 *   through `/var` — the case that used to produce a dangling link.
 * @returns the home, the paths under test, and a cleanup callback.
 */
function makeHome({ patch = PREEXISTING, viaSymlink = false } = {}) {
	const base = mkdtempSync(join(tmpdir(), "dsh-notice-test-"));
	const real = join(base, "real");
	mkdirSync(join(real, "profiles", "desktop"), { recursive: true });
	writeFileSync(join(real, "profiles", "desktop", "package.json"), `${JSON.stringify({ name: "desktop", private: true })}\n`);
	const home = viaSymlink ? join(base, "home") : real;
	if (viaSymlink) symlinkSync(real, home, "dir");
	return {
		home,
		requireFrom: join(home, "profiles", "desktop", "package.json"),
		patchPath: join(home, "profiles", "desktop", "cordis.patch.yml"),
		linkPath: join(home, "profiles", "desktop", "node_modules", "dsh-notice"),
		writePatch: () => writeFileSync(join(home, "profiles", "desktop", "cordis.patch.yml"), patch),
		cleanup: () => rmSync(base, { recursive: true, force: true })
	};
}

/** Assert that the profile can resolve the plugin package by bare name. */
function assertResolvable(profile) {
	assert.equal(
		createRequire(profile.requireFrom).resolve("dsh-notice/package.json"),
		join(PACKAGE_DIR, "package.json")
	);
}

test("install writes a resolvable link and one marker-delimited row", () => {
	const profile = makeHome();
	try {
		profile.writePatch();
		assert.match(run(profile.home, "install"), /link written:/u);

		// The link has to resolve from the profile, not merely exist.
		assert.equal(lstatSync(profile.linkPath).isSymbolicLink(), true);
		assertResolvable(profile);

		const patch = readFileSync(profile.patchPath, "utf8");
		assert.match(patch, /- insert:\n {4}- id: notice\n {6}name: 'dsh-notice'\n/u);
		assert.match(patch, /# >>> dsh-notice/u);
		assert.match(patch, /# <<< dsh-notice <<</u);
		// The user's own patch is preserved verbatim, ahead of ours.
		assert.ok(patch.startsWith(PREEXISTING.trimEnd()), "the pre-existing patch moved");
	} finally {
		profile.cleanup();
	}
});

test("the link resolves even when the home is reached through a symlink", () => {
	const profile = makeHome({ viaSymlink: true });
	try {
		profile.writePatch();
		// A relative target is interpreted against the physical directory, so a
		// logical `..` count lands in the wrong tree and the link dangles.
		run(profile.home, "install");
		assert.equal(existsSync(profile.linkPath), true);
		assertResolvable(profile);
	} finally {
		profile.cleanup();
	}
});

test("install is idempotent and leaves a byte-identical patch", () => {
	const profile = makeHome();
	try {
		profile.writePatch();
		run(profile.home, "install");
		const first = readFileSync(profile.patchPath, "utf8");
		const second = run(profile.home, "install");
		assert.match(second, /link already correct:/u);
		assert.match(second, /patch already current:/u);
		assert.equal(readFileSync(profile.patchPath, "utf8"), first);
		// A second run must not stack a second block.
		assert.equal(first.match(/# >>> dsh-notice/gu)?.length, 1);
	} finally {
		profile.cleanup();
	}
});

test("a backup is written only when the patch actually changes", () => {
	const profile = makeHome();
	const backups = () => readdirSync(dirname(profile.patchPath)).filter((name) => name.includes("dsh-notice-backup"));
	try {
		profile.writePatch();
		const first = run(profile.home, "install");
		assert.match(first, /block appended to/u);
		assert.match(first, /backup: .*cordis\.patch\.yml\.dsh-notice-backup-\d+/u);
		assert.equal(backups().length, 1);
		// The backup holds the file exactly as it was before the block went in.
		assert.equal(readFileSync(join(dirname(profile.patchPath), backups()[0]), "utf8"), PREEXISTING);

		const second = run(profile.home, "install");
		assert.match(second, /patch already current:/u);
		assert.doesNotMatch(second, /backup:/u);
		assert.equal(backups().length, 1, "a no-op install must not add a backup");
	} finally {
		profile.cleanup();
	}
});

test("install seeds a patch file that does not exist yet", () => {
	const profile = makeHome({ patch: undefined });
	try {
		const output = run(profile.home, "install");
		assert.match(output, /block appended to/u);
		assert.equal(existsSync(profile.patchPath), true);
		assert.match(readFileSync(profile.patchPath, "utf8"), /^\[\]\n\n# >>> dsh-notice/u);
	} finally {
		profile.cleanup();
	}
});

test("install repairs a link left dangling by a moved working copy", () => {
	const profile = makeHome();
	try {
		profile.writePatch();
		mkdirSync(dirname(profile.linkPath), { recursive: true });
		symlinkSync(DANGLING, profile.linkPath, "dir");
		assert.equal(existsSync(profile.linkPath), false, "a dangling link looks absent to existsSync");

		// This used to throw out of realpathSync and abort the whole install.
		const output = run(profile.home, "install");
		assert.match(output, /link written:.*\(replacing a stale link\)/u);
		assert.equal(existsSync(profile.linkPath), true);
		assertResolvable(profile);
	} finally {
		profile.cleanup();
	}
});

test("status reports a dangling link as broken, not as linked", () => {
	const profile = makeHome();
	try {
		profile.writePatch();
		mkdirSync(dirname(profile.linkPath), { recursive: true });
		symlinkSync(DANGLING, profile.linkPath, "dir");
		const output = run(profile.home, "status");
		assert.match(output, /package linked : broken/u);
		assert.match(output, /row installed  : no/u);
	} finally {
		profile.cleanup();
	}
});

test("uninstall removes the row and the link, restoring the patch", () => {
	const profile = makeHome();
	try {
		profile.writePatch();
		run(profile.home, "install");
		const output = run(profile.home, "uninstall");
		assert.match(output, /block removed from/u);
		assert.match(output, /link removed:/u);
		assert.equal(existsSync(profile.linkPath), false);
		assert.equal(readFileSync(profile.patchPath, "utf8").trimEnd(), PREEXISTING.trimEnd());
	} finally {
		profile.cleanup();
	}
});

test("uninstall still clears a link that dangles", () => {
	const profile = makeHome();
	try {
		profile.writePatch();
		run(profile.home, "install");
		rmSync(profile.linkPath, { force: true });
		symlinkSync(DANGLING, profile.linkPath, "dir");
		assert.match(run(profile.home, "uninstall"), /link removed:/u);
		assert.equal(lstatSync(profile.linkPath, { throwIfNoEntry: false }), undefined);
	} finally {
		profile.cleanup();
	}
});

test("uninstall leaves an entry it did not write alone", () => {
	const profile = makeHome();
	try {
		profile.writePatch();
		mkdirSync(profile.linkPath, { recursive: true });
		const output = run(profile.home, "uninstall");
		assert.match(output, /link left alone/u);
		assert.equal(lstatSync(profile.linkPath).isDirectory(), true);
	} finally {
		profile.cleanup();
	}
});

test("--dry-run reports the change without making it", () => {
	const profile = makeHome();
	try {
		profile.writePatch();
		const output = run(profile.home, "install", "--dry-run");
		assert.match(output, /link would be written:/u);
		assert.match(output, /block appended would be applied to/u);
		assert.equal(existsSync(profile.linkPath), false);
		assert.equal(readFileSync(profile.patchPath, "utf8"), PREEXISTING);
	} finally {
		profile.cleanup();
	}
});

test("a directory without package.json is refused, not written to", () => {
	const profile = makeHome();
	try {
		profile.writePatch();
		rmSync(join(profile.home, "profiles", "desktop", "package.json"));
		assert.throws(() => run(profile.home, "install"), /not a DSH profile/u);
		assert.equal(existsSync(profile.linkPath), false);
	} finally {
		profile.cleanup();
	}
});

test("an unbalanced marker block is refused instead of being overwritten", () => {
	// Only the closing marker is present, which means a human edited the block.
	const patch = "# <<< dsh-notice <<<\n- id: notice\n";
	const profile = makeHome({ patch });
	try {
		profile.writePatch();
		assert.throws(() => run(profile.home, "install"), /unbalanced/u);
		assert.equal(readFileSync(profile.patchPath, "utf8"), patch);
	} finally {
		profile.cleanup();
	}
});

test("an unknown subcommand exits non-zero", () => {
	const profile = makeHome();
	try {
		assert.throws(() => run(profile.home, "frobnicate"), /unknown command/u);
	} finally {
		profile.cleanup();
	}
});
