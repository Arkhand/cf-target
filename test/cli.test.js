"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { ok, finish } = require("./helpers");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cft-cli-"));
const env = {
	...process.env, CF_TARGET_HOME: path.join(tmp, "home"), CF_TARGET_CRED_BACKEND: "file",
	CF_TARGET_CF_BIN: path.join(__dirname, "fake-cf.js"), FAKE_CF_LOG: path.join(tmp, "fake.log")
};
const CLI = path.join(__dirname, "..", "bin", "cf-target.js");
const cli = (cwd, args, input) => spawnSync(process.execPath, [CLI, ...args], { cwd, env, input, encoding: "utf8" });
const json = (r) => { try { return JSON.parse(r.stdout.trim().split("\n").pop()); } catch (e) { return {}; } };

function project(name, space, extra = "") {
	const dir = path.join(tmp, name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, ".cf-target"),
		`api = https://api.cf.eu10.hana.ondemand.com\norg = acme-org\nspace = ${space}\nuser = dev@acme.com\nauth = password\n${extra}`);
	return dir;
}

const repoA = project("repo-a", "dev");
const repoB = project("repo-b", "qa");
const bare = path.join(tmp, "no-target");
fs.mkdirSync(bare);

(async () => {
	let r = cli(bare, ["--", "apps"]);
	ok("no .cf-target -> 2 with an init hint", r.status === 2 && /cf-target init/.test(r.stderr));

	r = cli(repoA, ["show", "--json"]);
	ok("show: account, no stored password, no session", json(r).target.org === "acme-org" && json(r).passwordStored === false && json(r).session === "none");

	r = cli(repoA, ["--", "apps"]);
	ok("run without session or password -> 4", r.status === 4 && /cf-target login/.test(r.stderr));

	r = cli(repoA, ["login", "--password-stdin", "--json"], "bad\n");
	ok("login with a wrong password -> 4 and nothing stored", r.status === 4 && json(cli(repoA, ["show", "--json"])).passwordStored === false);

	r = cli(repoA, ["login", "--password-stdin", "--json"], "good\n");
	ok("login ok stores the password", r.status === 0 && json(r).passwordStored === true && json(cli(repoA, ["show", "--json"])).session === "ok");

	r = cli(repoA, ["--", "whereami"]);
	ok("run uses the declared org/space", r.status === 0 && r.stdout.trim() === "acme-org/dev as dev@acme.com");
	ok("banner on stderr names the account", /\[cf-target\] https:\/\/api\.cf\.eu10\.hana\.ondemand\.com \/ acme-org \/ dev as dev@acme\.com/.test(r.stderr));
	ok("cf exit code is passed through", cli(repoA, ["--", "target", "-o", "org-missing", "-s", "x"]).status === 1);

	// Two repos, same session, different spaces, at the same time.
	const run = (cwd) => new Promise((resolve) => {
		const child = spawn(process.execPath, [CLI, "--", "whereami", "1500"], { cwd, env });
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.on("exit", (code) => resolve({ code, out: out.trim() }));
	});
	const [a, b] = await Promise.all([run(repoA), run(repoB)]);
	ok("parallel run A sees its own space", a.code === 0 && a.out === "acme-org/dev as dev@acme.com");
	ok("parallel run B sees its own space", b.code === 0 && b.out === "acme-org/qa as dev@acme.com");

	// A renewed token reaches the shared session.
	const sessions = require("../lib/sessions");
	process.env.CF_TARGET_HOME = env.CF_TARGET_HOME;
	const shared = sessions.configFile(sessions.sessionHome("https://api.cf.eu10.hana.ondemand.com", "dev@acme.com"));
	const tokenBefore = JSON.parse(fs.readFileSync(shared, "utf8")).AccessToken;
	cli(repoA, ["--", "refresh"]);
	ok("a token renewed during a run is written back", JSON.parse(fs.readFileSync(shared, "utf8")).AccessToken !== tokenBefore);

	// Killed mid-run: shared session intact, no lock left, next run works.
	const victim = spawn(process.execPath, [CLI, "--", "whereami", "5000"], { cwd: repoA, env });
	await new Promise((res) => setTimeout(res, 1500));
	if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(victim.pid), "/T", "/F"]);
	else victim.kill("SIGKILL");
	await new Promise((res) => victim.on("exit", res));
	ok("no session.lock left after a kill", !fs.existsSync(path.join(path.dirname(path.dirname(path.dirname(shared))), "session.lock")));
	ok("shared session still valid JSON", Boolean(JSON.parse(fs.readFileSync(shared, "utf8")).AccessToken));
	ok("next run works after a kill", cli(repoA, ["--", "whereami"]).status === 0);

	// The same user written with other casing is the same identity (and session).
	const other = project("repo-c", "dev", "");
	fs.writeFileSync(path.join(other, ".cf-target"), fs.readFileSync(path.join(other, ".cf-target"), "utf8").replace("dev@acme.com", "Dev@Acme.com"));
	ok("user case differences are the same identity", cli(other, ["--", "whereami"]).status === 0);

	r = cli(repoA, ["forget", "--json"]);
	ok("forget deletes the stored password", json(r).deleted === true && json(cli(repoA, ["show", "--json"])).passwordStored === false);

	// Not asserted on purpose: a killed run leaves its temp home in %TEMP% (accepted, spec §7).
	fs.rmSync(tmp, { recursive: true, force: true });
	finish();
})();
