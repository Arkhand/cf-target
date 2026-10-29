"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ok, finish } = require("./helpers");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cft-run-"));
const log = path.join(tmp, "fake.log");
Object.assign(process.env, {
	CF_TARGET_HOME: tmp, CF_TARGET_CRED_BACKEND: "file",
	CF_TARGET_CF_BIN: path.join(__dirname, "fake-cf.js"), FAKE_CF_LOG: log
});
const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []);
const sessions = require("../lib/sessions");
const cred = require("../lib/credstore");
const runner = require("../lib/runner");
const { parseTargetOutput } = require("../lib/cfexec");

const T = { api: "https://api.cf.eu10.hana.ondemand.com", org: "acme-org", space: "dev", user: "dev@acme.com", auth: "password" };

(async () => {
	ok("parseTargetOutput: empty org is null, no bleed into the next line",
		parseTargetOutput("API endpoint:   x\nuser:           u\norg:            \nspace:          ").org === null);

	const shared = sessions.sessionHome(T.api, T.user);
	let run = sessions.openRun(shared);
	let r = await runner.prepare(T, run.home);
	ok("no session and no stored password -> 4 with a login hint", !r.ok && r.code === 4 && /cf-target login/.test(r.hint));

	cred.setPassword(T.api, T.user, "wrong");
	r = await runner.prepare(T, run.home);
	ok("stored wrong password -> 4 'Automatic login failed'", !r.ok && r.code === 4 && /Automatic login failed/.test(r.error));
	ok("a rejected stored password is removed (no retry storm against the IdP)", cred.getPassword(T.api, T.user) === null && /removed/.test(r.error));
	const authsBefore = calls().filter((c) => c.args[0] === "auth").length;
	r = await runner.prepare(T, run.home);
	ok("the next run does not try the rejected password again", !r.ok && r.code === 4 && calls().filter((c) => c.args[0] === "auth").length === authsBefore);

	cred.setPassword(T.api, T.user, "good");
	r = await runner.prepare(T, run.home);
	ok("stored password logs in and targets org/space", r.ok && r.session.org === "acme-org" && r.session.space === "dev");
	const auth = calls().find((c) => c.args[0] === "auth");
	ok("password goes by env, never argv", auth && auth.hasPassword && !auth.args.includes("good"));
	ok("every cf call used the private home", calls().every((c) => c.CF_HOME === run.home));
	ok("plugins still come from the user's home", calls().every((c) => c.CF_PLUGIN_HOME === (process.env.CF_PLUGIN_HOME || os.homedir())));
	sessions.writeBack(run);
	sessions.closeRun(run);

	const before = calls().length;
	run = sessions.openRun(shared);
	r = await runner.prepare(T, run.home);
	ok("a second run reuses the session (no new auth)", r.ok && !calls().slice(before).some((c) => c.args[0] === "auth"));
	sessions.closeRun(run);

	const weird = { ...T, org: "Acme Inc. S4 Rise , GUI SSO & MBC" };
	run = sessions.openRun(shared);
	r = await runner.prepare(weird, run.home);
	const tcall = calls().reverse().find((c) => c.args[0] === "target" && c.args[1] === "-o");
	ok("an org with spaces, commas and & reaches cf as one argument", r.ok && tcall.args[2] === weird.org);
	sessions.closeRun(run);

	run = sessions.openRun(shared);
	r = await runner.prepare({ ...T, org: "org-missing" }, run.home);
	ok("unknown org -> 6", !r.ok && r.code === 6 && /org-missing/.test(r.error));
	sessions.closeRun(run);

	// Expired session in the shared store: auto re-login with the stored password.
	const cfgFile = sessions.configFile(shared);
	fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, "utf8")), Expired: true }));
	run = sessions.openRun(shared);
	r = await runner.prepare(T, run.home);
	ok("an expired session re-logs in on its own", r.ok);
	sessions.closeRun(run);

	const sso = { ...T, user: "sso@acme.com", auth: "sso" };
	run = sessions.openRun(sessions.sessionHome(sso.api, sso.user));
	r = await runner.prepare(sso, run.home);
	ok("SSO without a session -> 4, never tries a password", !r.ok && r.code === 4 && /SSO/.test(r.error));
	ok("passcode login works", (await runner.ssoLogin(sso, run.home, "good")).ok && (await runner.prepare(sso, run.home)).ok);
	sessions.closeRun(run);

	fs.rmSync(tmp, { recursive: true, force: true });
	finish();
})();
