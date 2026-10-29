"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ok, throws, finish } = require("./helpers");
const tf = require("../lib/targetfile");

const sample = [
	"# comment",
	"api   = https://API.cf.us10-001.hana.ondemand.com/",
	"org   = Acme Inc. S4 Rise , GUI SSO , MBC account_workzone-dev-abc123",
	"space = dev   # inline comment",
	"user  = dev@acme.com",
	"auth  = password",
	""
].join("\n");

const t = tf.parseTarget(sample);
ok("parses an org with spaces and commas", t.org === "Acme Inc. S4 Rise , GUI SSO , MBC account_workzone-dev-abc123");
ok("strips inline comments", t.space === "dev");
ok("keeps api as written", t.api === "https://API.cf.us10-001.hana.ondemand.com/");
ok("normalizeApi lowercases and drops the trailing slash", tf.normalizeApi(t.api) === "https://api.cf.us10-001.hana.ondemand.com");
throws("unknown key is an error", () => tf.parseTarget(sample + "spcae = x\n"), /unknown key "spcae"/);
throws("missing key is an error", () => tf.parseTarget("api = x\norg = o\nspace = s\nauth = sso\n"), /missing "user"/);
throws("bad auth is an error", () => tf.parseTarget(sample.replace("auth  = password", "auth = magic")), /auth must be/);
throws("duplicate key is an error", () => tf.parseTarget(sample + "org = other\n"), /duplicate key "org"/);
throws("a line without = is an error", () => tf.parseTarget(sample + "oops\n"), /expected "key = value"/);
throws("errors carry file:line", () => tf.parseTarget("api = x\nbad\n", "C:\\p\\.cf-target"), /\.cf-target:2:/);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cft-tf-"));
const deep = path.join(root, "a", "b", "c");
fs.mkdirSync(deep, { recursive: true });
fs.writeFileSync(path.join(root, ".cf-target"), sample);
ok("found walking up", tf.findTargetFile(deep) === path.join(root, ".cf-target"));
fs.writeFileSync(path.join(root, "a", ".cf-target"), sample.replace("space = dev   # inline comment", "space = qa"));
ok("nearest file wins", tf.loadTarget(deep).target.space === "qa");
const empty = fs.mkdtempSync(path.join(os.tmpdir(), "cft-none-"));
const none = tf.findTargetFile(empty);
ok("nothing inside an empty tree", none === null || !none.startsWith(empty));

// The session store ~/.cf-target is a DIRECTORY: it must never count as a project file.
const storeLike = fs.mkdtempSync(path.join(os.tmpdir(), "cft-dir-"));
fs.mkdirSync(path.join(storeLike, ".cf-target", "sessions"), { recursive: true });
const below = path.join(storeLike, "Desktop", "repo");
fs.mkdirSync(below, { recursive: true });
const found = tf.findTargetFile(below);
ok("a .cf-target directory is not a target file", found === null || !found.startsWith(storeLike));
fs.rmSync(storeLike, { recursive: true, force: true });

const written = tf.formatTarget(t);
ok("format/parse round trip", JSON.stringify(tf.parseTarget(written)) === JSON.stringify(t));
ok("the file says passwords are not in it", /Passwords are NOT here/.test(written));
ok("writeTarget writes .cf-target", tf.writeTarget(empty, t) === path.join(empty, ".cf-target") && tf.loadTarget(empty).target.user === "dev@acme.com");

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cft-git-"));
fs.mkdirSync(path.join(repo, ".git"));
ok("adds .cf-target to a new .gitignore in a git repo", tf.ensureGitignored(repo) === true && /^\.cf-target$/m.test(fs.readFileSync(path.join(repo, ".gitignore"), "utf8")));
ok("does not add it twice", tf.ensureGitignored(repo) === false);
fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/");
ok("appends on a new line to an existing .gitignore", tf.ensureGitignored(repo) && fs.readFileSync(path.join(repo, ".gitignore"), "utf8") === "node_modules/\n.cf-target\n");
const plain = fs.mkdtempSync(path.join(os.tmpdir(), "cft-plain-"));
ok("no .gitignore outside a git repo", tf.ensureGitignored(plain) === false && !fs.existsSync(path.join(plain, ".gitignore")));

for (const d of [root, empty, repo, plain]) fs.rmSync(d, { recursive: true, force: true });
finish();
