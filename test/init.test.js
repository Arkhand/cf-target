"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { ok, finish } = require("./helpers");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cft-init-"));
const env = {
	...process.env, CF_TARGET_HOME: path.join(tmp, "home"), CF_TARGET_CRED_BACKEND: "file",
	CF_TARGET_CF_BIN: path.join(__dirname, "fake-cf.js")
};
const CLI = path.join(__dirname, "..", "bin", "cf-target.js");
const cli = (cwd, args, input) => spawnSync(process.execPath, [CLI, ...args], { cwd, env, input, encoding: "utf8" });
const json = (r) => { try { return JSON.parse(r.stdout.trim().split("\n").pop()); } catch (e) { return {}; } };
const API = "https://api.cf.eu10.hana.ondemand.com";

const repo = path.join(tmp, "repo");
fs.mkdirSync(path.join(repo, ".git"), { recursive: true });

let r = cli(repo, ["init", "--api", API, "--org", "acme-org", "--json"]);
ok("missing values without a terminal -> 2 naming them", r.status === 2 && /--space/.test(json(r).error) && /--user/.test(json(r).error));

r = cli(repo, ["targets", "--api", API, "--user", "dev@acme.com", "--json"]);
ok("targets before init without a password -> 4", r.status === 4);

process.env.CF_TARGET_HOME = env.CF_TARGET_HOME;
process.env.CF_TARGET_CRED_BACKEND = "file";
require("../lib/credstore").setPassword(API, "dev@acme.com", "good");

r = cli(repo, ["targets", "--api", API, "--user", "dev@acme.com", "--json"]);
ok("targets lists real orgs/spaces before init", r.status === 0 && json(r).targets[0].org === "acme-org" && json(r).targets[0].spaces.includes("qa"));

r = cli(repo, ["init", "--api", API, "--org", "org-missing", "--space", "dev", "--user", "dev@acme.com", "--auth", "password", "--json"]);
ok("an org that does not exist -> 6 and no file", r.status === 6 && !fs.existsSync(path.join(repo, ".cf-target")));

r = cli(repo, ["init", "--api", API, "--org", "acme-org", "--space", "dev", "--user", "dev@acme.com", "--auth", "password", "--json"]);
ok("init verifies and writes the file", r.status === 0 && json(r).verified === true && fs.existsSync(path.join(repo, ".cf-target")));
ok("init gitignores it", json(r).gitignored === true && /^\.cf-target$/m.test(fs.readFileSync(path.join(repo, ".gitignore"), "utf8")));

r = cli(repo, ["init", "--api", API, "--org", "acme-org", "--space", "qa", "--user", "dev@acme.com", "--auth", "password", "--json"]);
ok("init does not overwrite without --force", r.status === 2 && /--force/.test(json(r).hint));

const sso = path.join(tmp, "sso");
fs.mkdirSync(sso);
r = cli(sso, ["init", "--api", API, "--org", "acme-org", "--space", "dev", "--user", "sso@acme.com", "--auth", "sso", "--json"]);
ok("SSO without session: written but not verified, with a warning", r.status === 0 && json(r).verified === false && /cf-target login/.test(json(r).warning));

r = cli(repo, ["targets", "--json"]);
ok("targets with a .cf-target uses it", r.status === 0 && json(r).targets.length === 1);

fs.rmSync(tmp, { recursive: true, force: true });
finish();
