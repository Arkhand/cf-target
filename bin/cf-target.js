#!/usr/bin/env node
"use strict";
/**
 * cf-target - run Cloud Foundry commands only against the account declared in
 * this project's .cf-target.
 *
 *   cf-target -- <cf args>      run cf against this folder's account
 *   cf-target show              which account this folder uses, password stored?, session?
 *   cf-target login             log in (password: prompted, stored in Credential Manager)
 *                               [--password-stdin | --sso-passcode X]
 *   cf-target forget            delete the stored password
 *   cf-target init ...          create .cf-target (see Task 6)
 *   cf-target targets ...       orgs/spaces the user can see (see Task 6)
 *
 * --json: one JSON object per command. Exit codes: 0 ok, 1 error, 2 usage or no
 * .cf-target, 4 no session, 6 org/space not found, 7 identity mismatch;
 * `cf-target -- ...` returns cf's own exit code.
 */
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const tf = require("../lib/targetfile");
const sessions = require("../lib/sessions");
const credstore = require("../lib/credstore");
const { cfInherit } = require("../lib/cfexec");
const runner = require("../lib/runner");
const { EXIT } = runner;

// ---------------------------------------------------------------------------
// Arguments: own flags before `--`, cf's arguments after it, untouched.
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const dashdash = argv.indexOf("--");
const own = dashdash === -1 ? argv : argv.slice(0, dashdash);
const rest = dashdash === -1 ? [] : argv.slice(dashdash + 1);
const positional = [];
const flags = {};
for (let i = 0; i < own.length; i++) {
	const a = own[i];
	if (a.startsWith("--")) {
		const next = own[i + 1];
		if (next !== undefined && !next.startsWith("--")) {
			flags[a.slice(2)] = next;
			i++;
		} else {
			flags[a.slice(2)] = true;
		}
	} else {
		positional.push(a);
	}
}
const JSON_OUT = flags.json === true;

function done(payload, human) {
	if (JSON_OUT) console.log(JSON.stringify({ ok: true, ...payload }));
	else if (human) human();
	process.exit(0);
}

function die(code, error, extra = {}) {
	if (JSON_OUT) {
		console.log(JSON.stringify({ ok: false, code, error, ...extra }));
	} else {
		console.error(`cf-target: ${error}`);
		if (extra.hint) console.error(extra.hint);
	}
	process.exit(code);
}

function readStdin() {
	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (c) => (data += c));
		process.stdin.on("end", () => resolve(data));
	});
}

/** Prompt without echo: the password is typed by the user, never shown or logged. */
function promptHidden(question) {
	return new Promise((resolve) => {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
		rl._writeToOutput = (s) => {
			if (s.startsWith(question)) process.stdout.write(question);
		};
		rl.question(question, (answer) => {
			rl.close();
			process.stdout.write("\n");
			resolve(answer);
		});
	});
}

function prompt(question) {
	return new Promise((resolve) => {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer.trim());
		});
	});
}

function requireTarget() {
	let loaded;
	try {
		loaded = tf.loadTarget(process.cwd());
	} catch (e) {
		die(EXIT.USAGE, e.message);
	}
	if (!loaded) {
		die(EXIT.USAGE, "No .cf-target in this folder or its parents: this project has no declared Cloud Foundry account.",
			{ hint: "Create it: cf-target init --api <url> --org <org> --space <space> --user <user> --auth password|sso" });
	}
	return loaded;
}

/**
 * Runs fn(home) on a private copy of the user's session and writes renewed
 * tokens back. replaceOnSuccess (login): the whole config replaces the shared one.
 */
async function withRun(target, fn, { replaceOnSuccess = false } = {}) {
	const run = sessions.openRun(sessions.sessionHome(target.api, target.user));
	try {
		const result = await fn(run.home);
		sessions.writeBack(run, { replace: replaceOnSuccess && Boolean(result && result.ok) });
		return result;
	} finally {
		sessions.closeRun(run);
	}
}

// ---------------------------------------------------------------------------
// cf-target -- <args>
// ---------------------------------------------------------------------------
async function cmdRun() {
	if (!rest.length) die(EXIT.USAGE, "Missing cf arguments after --.", { hint: "Example: cf-target -- apps" });
	const { target } = requireTarget();
	const result = await withRun(target, async (home) => {
		const prep = await runner.prepare(target, home);
		if (!prep.ok) return prep;
		// stderr, so piping cf's output stays clean.
		process.stderr.write(`[cf-target] ${target.api} / ${target.org} / ${target.space} as ${prep.session.user}\n`);
		// Ctrl+C reaches cf too (same console). Wait for it to exit instead of dying
		// here, so the private copy is written back and removed.
		const ignore = () => {};
		process.on("SIGINT", ignore);
		process.on("SIGBREAK", ignore);
		try {
			return { ok: true, exitCode: await cfInherit(rest, { home }) };
		} finally {
			process.off("SIGINT", ignore);
			process.off("SIGBREAK", ignore);
		}
	});
	if (!result.ok) die(result.code, result.error, { hint: result.hint });
	process.exit(result.exitCode);
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------
async function cmdShow() {
	const { file, target } = requireTarget();
	const passwordStored = target.auth === "password" && Boolean(credstore.getPassword(target.api, target.user));
	const { session } = await withRun(target, async (home) => ({ ok: true, session: await runner.sessionOf(home) }));
	const state = !session ? "none" : runner.sameIdentity(session, target) ? "ok" : `other user (${session.user})`;
	done({ file, target, passwordStored, session: state }, () => {
		console.log(`.cf-target  ${file}`);
		console.log(`account     ${target.api} / ${target.org} / ${target.space}`);
		console.log(`user        ${target.user} (${target.auth}${target.auth === "password" ? `, password stored: ${passwordStored ? "yes" : "no"}` : ""})`);
		console.log(`session     ${state}`);
	});
}

// ---------------------------------------------------------------------------
// login / forget
// ---------------------------------------------------------------------------
async function cmdLogin() {
	const { target } = requireTarget();
	let attempt;
	if (target.auth === "sso") {
		if (typeof flags["sso-passcode"] === "string") {
			attempt = (home) => runner.ssoLogin(target, home, flags["sso-passcode"]);
		} else if (process.stdin.isTTY) {
			attempt = async (home) => ({ ok: (await cfInherit(["login", "-a", target.api, "--sso"], { home })) === 0, error: "cf login --sso failed." });
		} else {
			die(EXIT.USAGE, "SSO login needs a terminal or --sso-passcode.", { hint: "Run in your terminal: cf-target login" });
		}
	} else {
		let password;
		if (flags["password-stdin"]) password = (await readStdin()).replace(/\r?\n$/, "");
		else if (process.stdin.isTTY) password = await promptHidden(`Password for ${target.user} (${target.api}): `);
		else die(EXIT.USAGE, "Password login needs a terminal or --password-stdin.", { hint: "Run in your terminal: cf-target login" });
		if (!password) die(EXIT.USAGE, "Empty password.");
		attempt = async (home) => {
			const r = await runner.passwordLogin(target, home, password);
			// Stored only after cf accepted it.
			if (r.ok) credstore.setPassword(target.api, target.user, password);
			return r;
		};
	}

	const result = await withRun(target, async (home) => {
		const r = await attempt(home);
		if (!r.ok) return { ok: false, code: EXIT.NO_SESSION, error: r.error };
		const s = await runner.sessionOf(home);
		if (!s || !runner.sameIdentity(s, target)) {
			return { ok: false, code: EXIT.MISMATCH, error: `Logged in as ${s ? s.user : "?"}, but .cf-target says ${target.user}.` };
		}
		return { ok: true, user: s.user };
	}, { replaceOnSuccess: true });

	if (!result.ok) die(result.code, result.error);
	done({ user: result.user, api: target.api, passwordStored: target.auth === "password" }, () =>
		console.log(`OK  ${result.user} on ${target.api}${target.auth === "password" ? " (password stored in Windows Credential Manager)" : ""}`));
}

async function cmdForget() {
	const { target } = requireTarget();
	const deleted = credstore.deletePassword(target.api, target.user);
	done({ deleted }, () => console.log(deleted ? `Password for ${target.user} deleted.` : "No stored password."));
}

// ---------------------------------------------------------------------------
// targets: orgs/spaces visible to the user (to pick values for init)
// ---------------------------------------------------------------------------
function identityFromFlagsOrFile() {
	if (typeof flags.api === "string" && typeof flags.user === "string") {
		return { api: flags.api, user: flags.user, auth: typeof flags.auth === "string" ? flags.auth : "password", origin: typeof flags.origin === "string" ? flags.origin : undefined };
	}
	return requireTarget().target;
}

async function cmdTargets() {
	const who = identityFromFlagsOrFile();
	const result = await withRun(who, async (home) => {
		const s = await runner.ensureSession(who, home);
		if (!s.ok) return s;
		return { ok: true, targets: await runner.listTargets(home) };
	});
	if (!result.ok) die(result.code, result.error, { hint: result.hint });
	done({ targets: result.targets }, () => {
		for (const t of result.targets) console.log(`${t.org}: ${t.spaces.join(", ")}`);
	});
}

// ---------------------------------------------------------------------------
// init: create .cf-target (verified when a login is possible without asking)
// ---------------------------------------------------------------------------
async function cmdInit() {
	const dir = path.resolve(typeof flags.dir === "string" ? flags.dir : process.cwd());
	const existing = path.join(dir, tf.FILE_NAME);
	if (fs.existsSync(existing) && !flags.force) {
		die(EXIT.USAGE, `${existing} already exists.`, { hint: "Use --force to overwrite it." });
	}

	const values = {};
	for (const k of [...tf.REQUIRED, "origin"]) {
		if (typeof flags[k] === "string") values[k] = flags[k];
	}
	const missing = tf.REQUIRED.filter((k) => !values[k]);
	if (missing.length) {
		if (!process.stdin.isTTY) die(EXIT.USAGE, `Missing: ${missing.map((k) => `--${k}`).join(" ")}`);
		for (const k of missing) values[k] = await prompt(`${k}${k === "auth" ? " (password|sso)" : ""}: `);
	}

	let target;
	try {
		target = tf.parseTarget(tf.formatTarget(values));
	} catch (e) {
		die(EXIT.USAGE, e.message);
	}

	// Never write a file pointing at an org/space that does not exist.
	const check = await withRun(target, (home) => runner.prepare(target, home));
	let verified = false;
	let warning = null;
	if (check.ok) {
		verified = true;
	} else if (check.code === EXIT.NO_TARGET || check.code === EXIT.MISMATCH) {
		die(check.code, check.error, { hint: "Fix the values; .cf-target was not written." });
	} else {
		warning = `Not verified (${check.error}). Run in your terminal: cf-target login`;
	}

	const file = tf.writeTarget(dir, target);
	const gitignored = tf.ensureGitignored(dir);
	done({ file, target, verified, gitignored, warning }, () => {
		console.log(`Wrote ${file}${verified ? " (verified)" : ""}`);
		if (gitignored) console.log("Added .cf-target to .gitignore");
		if (warning) console.log(`!!  ${warning}`);
	});
}

// ---------------------------------------------------------------------------
const COMMANDS = { show: cmdShow, login: cmdLogin, forget: cmdForget, init: cmdInit, targets: cmdTargets };

if (dashdash !== -1 && !positional.length) {
	cmdRun().catch((e) => die(EXIT.ERROR, e.message));
} else if (COMMANDS[positional[0]]) {
	COMMANDS[positional[0]]().catch((e) => die(EXIT.ERROR, e.message));
} else {
	const doc = fs.readFileSync(__filename, "utf8").match(/\/\*\*([\s\S]*?)\*\//)[1].replace(/^ \* ?/gm, "");
	console.log(doc.trim());
	process.exit(positional[0] ? EXIT.USAGE : 0);
}
