"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ok, finish } = require("./helpers");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cft-sess-"));
process.env.CF_TARGET_HOME = tmp;
const s = require("../lib/sessions");

const API = "https://api.cf.us10-001.hana.ondemand.com";
const shared = s.sessionHome(API, "dev@acme.com");
ok("same session for api case/slash and user case", shared === s.sessionHome("https://API.cf.us10-001.hana.ondemand.com/", "DEV@acme.com"));
ok("another user has another session", shared !== s.sessionHome(API, "other@acme.com"));
ok("lives under CF_TARGET_HOME/sessions", shared.startsWith(path.join(tmp, "sessions")));

// No shared config yet.
let run = s.openRun(shared);
ok("openRun gives an empty private home", fs.existsSync(run.home) && !fs.existsSync(s.configFile(run.home)));
ok("nothing to write back", s.writeBack(run) === "unchanged");
s.closeRun(run);
ok("closeRun removes the private home", !fs.existsSync(run.home));

// A shared session exists.
const base = { Target: API, AccessToken: "a1", RefreshToken: "r1", UAAGrantType: "password", OrganizationFields: { Name: "org-a" } };
fs.mkdirSync(path.dirname(s.configFile(shared)), { recursive: true });
fs.writeFileSync(s.configFile(shared), JSON.stringify(base));

run = s.openRun(shared);
const copy = JSON.parse(fs.readFileSync(s.configFile(run.home), "utf8"));
ok("the private home starts as a copy", copy.AccessToken === "a1");
fs.writeFileSync(s.configFile(run.home), JSON.stringify({ ...copy, AccessToken: "a2", RefreshToken: "r2", OrganizationFields: { Name: "org-b" } }));
ok("renewed tokens are written back", s.writeBack(run) === "written");
let now = JSON.parse(fs.readFileSync(s.configFile(shared), "utf8"));
ok("only tokens travel back, never the target", now.AccessToken === "a2" && now.OrganizationFields.Name === "org-a");
s.closeRun(run);

// Compare-and-swap: two runs refresh at the same time; the first wins.
const runA = s.openRun(shared);
const runB = s.openRun(shared);
fs.writeFileSync(s.configFile(runA.home), JSON.stringify({ ...now, AccessToken: "a3" }));
fs.writeFileSync(s.configFile(runB.home), JSON.stringify({ ...now, AccessToken: "a4" }));
ok("first writer wins", s.writeBack(runA) === "written");
ok("second writer is skipped", s.writeBack(runB) === "skipped");
now = JSON.parse(fs.readFileSync(s.configFile(shared), "utf8"));
ok("shared keeps the first writer's token", now.AccessToken === "a3");
s.closeRun(runA);
s.closeRun(runB);

// Login: replace the whole config.
run = s.openRun(shared);
fs.writeFileSync(s.configFile(run.home), JSON.stringify({ Target: API, AccessToken: "fresh", RefreshToken: "fresh-r", UAAGrantType: "password" }));
ok("replace writes even if the base changed", s.writeBack(run, { replace: true }) === "written");
ok("replace writes the whole config", JSON.parse(fs.readFileSync(s.configFile(shared), "utf8")).AccessToken === "fresh");
s.closeRun(run);

// A stale lock (crashed process) does not block.
const lockFile = path.join(path.dirname(shared), "session.lock");
fs.writeFileSync(lockFile, "");
const old = new Date(Date.now() - 60000);
fs.utimesSync(lockFile, old, old);
run = s.openRun(shared);
ok("a stale lock is reclaimed", fs.existsSync(run.home) && !fs.existsSync(lockFile));
s.closeRun(run);

ok("no temp files left in the session folder", !fs.readdirSync(path.dirname(s.configFile(shared))).some((f) => f.endsWith(".tmp")));

// Tokens of another user never land in this user's session (review finding 5).
const jwt = (user) => `x.${Buffer.from(JSON.stringify({ user_name: user })).toString("base64url")}.sig`;
fs.writeFileSync(s.configFile(shared), JSON.stringify({ Target: API, AccessToken: jwt("dev@acme.com"), RefreshToken: "r", UAAGrantType: "password" }));
run = s.openRun(shared);
fs.writeFileSync(s.configFile(run.home), JSON.stringify({ Target: API, AccessToken: jwt("intruder@other.com"), RefreshToken: "r2", UAAGrantType: "password" }));
ok("tokens of another user are not written back", s.writeBack(run) === "skipped" &&
	JSON.parse(fs.readFileSync(s.configFile(shared), "utf8")).AccessToken === jwt("dev@acme.com"));
fs.writeFileSync(s.configFile(run.home), JSON.stringify({ Target: API, AccessToken: jwt("DEV@acme.com"), RefreshToken: "r3", UAAGrantType: "password" }));
ok("the same user's renewed tokens still go back", s.writeBack(run) === "written");
s.closeRun(run);

// Copies left by dead processes (Ctrl+C, taskkill /F) are swept: they hold live tokens (review finding 6).
const { spawnSync } = require("child_process");
const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
const orphan = path.join(os.tmpdir(), `cf-target-${deadPid}-orphan`);
const alive = path.join(os.tmpdir(), `cf-target-${process.pid}-alive`);
for (const d of [orphan, alive]) {
	fs.mkdirSync(path.join(d, ".cf"), { recursive: true });
	fs.writeFileSync(path.join(d, ".cf", "config.json"), "{}");
}
run = s.openRun(shared);
ok("the private home carries this pid in its name", path.basename(run.home).startsWith(`cf-target-${process.pid}-`));
ok("a dead process's copy is swept", !fs.existsSync(orphan));
ok("a live process's copy is kept", fs.existsSync(alive));
s.closeRun(run);
fs.rmSync(alive, { recursive: true, force: true });

fs.rmSync(tmp, { recursive: true, force: true });
finish();
