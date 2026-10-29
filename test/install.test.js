"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { ok, finish } = require("./helpers");

const claude = fs.mkdtempSync(path.join(os.tmpdir(), "cft-claude-"));
fs.writeFileSync(path.join(claude, "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node other.js" }] }] } }, null, 2));
const env = { ...process.env, CF_TARGET_CLAUDE_DIR: claude };
const run = (args) => spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "install.js"), ...args], { env, encoding: "utf8" });

run([]);
ok("copies the hook", fs.existsSync(path.join(claude, "hooks", "cf-guard.js")));
ok("copies the cf-target skill", fs.existsSync(path.join(claude, "skills", "cf-target", "SKILL.md")));
ok("copies the cf-proxy skill", fs.existsSync(path.join(claude, "skills", "cf-proxy", "SKILL.md")));
ok("without --register settings.json is untouched", !fs.readFileSync(path.join(claude, "settings.json"), "utf8").includes("cf-guard"));

run(["--register"]);
const settings = JSON.parse(fs.readFileSync(path.join(claude, "settings.json"), "utf8"));
const entry = settings.hooks.PreToolUse.find((e) => e.hooks.some((h) => /cf-guard\.js/.test(h.command)));
ok("--register adds a Bash|PowerShell entry", entry && entry.matcher === "Bash|PowerShell");
ok("keeps existing hooks", settings.hooks.PreToolUse.some((e) => e.hooks.some((h) => h.command === "node other.js")));
ok("backs up settings.json", fs.existsSync(path.join(claude, "settings.json.bak-cf-target")));
run(["--register"]);
ok("--register is idempotent", JSON.parse(fs.readFileSync(path.join(claude, "settings.json"), "utf8")).hooks.PreToolUse.filter((e) => e.hooks.some((h) => /cf-guard\.js/.test(h.command))).length === 1);

for (const name of ["cf-target", "cf-proxy"]) {
	const text = fs.readFileSync(path.join(__dirname, "..", "global", "skills", name, "SKILL.md"), "utf8");
	ok(`${name} skill has name and description`, new RegExp(`^---\\r?\\nname: ${name}\\r?\\ndescription: `).test(text));
	ok(`${name} skill never asks for a password in chat`, /nunca.*contraseña.*chat/i.test(text));
}

const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "cft-claude-"));
const r = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "install.js"), "--register"], { env: { ...process.env, CF_TARGET_CLAUDE_DIR: fresh }, encoding: "utf8" });
ok("--register without settings.json exits 0", r.status === 0);
ok("--register without settings.json creates it with the hook", fs.existsSync(path.join(fresh, "settings.json")) && /cf-guard\.js/.test(fs.readFileSync(path.join(fresh, "settings.json"), "utf8")));

fs.rmSync(claude, { recursive: true, force: true });
fs.rmSync(fresh, { recursive: true, force: true });
finish();
