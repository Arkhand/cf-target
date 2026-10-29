"use strict";
/**
 * The only place that executes `cf`. Always with an explicit CF_HOME: there is
 * no code path that touches the global ~/.cf session.
 */
const os = require("os");
const { execFile, spawn } = require("child_process");

const CF_BIN = process.env.CF_TARGET_CF_BIN || (process.platform === "win32" ? "cf.exe" : "cf");

/** A .js CF_BIN (the tests' fake cf) runs with node. */
function command(args) {
	return CF_BIN.endsWith(".js") ? [process.execPath, [CF_BIN, ...args]] : [CF_BIN, args];
}

/** CF_PLUGIN_HOME keeps plugins (multiapps) coming from ~/.cf while the session is private. */
function cfEnv(home, extra = {}) {
	return { ...process.env, CF_HOME: home, CF_PLUGIN_HOME: process.env.CF_PLUGIN_HOME || os.homedir(), ...extra };
}

function cfCapture(args, { home, env = {}, timeout = 120000 } = {}) {
	if (!home) throw new Error("cfCapture needs a CF_HOME");
	return new Promise((resolve) => {
		const [bin, argv] = command(args);
		// No shell: arguments (org names with spaces, "&", commas) reach cf untouched.
		const child = execFile(bin, argv, { env: cfEnv(home, env), timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
			const code = !err ? 0 : typeof err.code === "number" ? err.code : err.code === "ENOENT" ? 127 : 1;
			resolve({ code, out: String(stdout || ""), err: String(stderr || "") });
		});
		// A cf prompt (e.g. "select an org") gets EOF instead of hanging until the timeout.
		child.stdin.end();
	});
}

function cfInherit(args, { home }) {
	if (!home) throw new Error("cfInherit needs a CF_HOME");
	return new Promise((resolve) => {
		const [bin, argv] = command(args);
		const child = spawn(bin, argv, { env: cfEnv(home), stdio: "inherit", windowsHide: true });
		child.on("error", () => resolve(127));
		child.on("exit", (code) => resolve(code === null ? 1 : code));
	});
}

/** Fields of `cf target`. [ \t]* (not \s*) so an empty value does not swallow the next line. */
function parseTargetOutput(out) {
	const field = (label) => {
		const m = String(out).match(new RegExp(`^${label}:[ \\t]*(.*)$`, "im"));
		const value = m ? m[1].trim() : "";
		return value || null;
	};
	return { api: field("API endpoint"), user: field("user"), org: field("org"), space: field("space") };
}

function lastLines(result, n = 3) {
	return `${result.err}\n${result.out}`.trim().split(/\r?\n/).filter(Boolean).slice(-n).join(" ");
}

module.exports = { cfEnv, cfCapture, cfInherit, parseTargetOutput, lastLines };
