#!/usr/bin/env node
"use strict";
/**
 * Installs the global pieces into ~/.claude (or CF_TARGET_CLAUDE_DIR):
 *   global/hooks/cf-guard.js        -> <claude>/hooks/cf-guard.js
 *   global/skills/<name>/SKILL.md   -> <claude>/skills/<name>/SKILL.md
 *
 * --register also adds the hook to <claude>/settings.json (PreToolUse, matcher
 * "Bash|PowerShell") after a backup. It changes global Claude Code
 * configuration: run it only with the user's OK.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CLAUDE = process.env.CF_TARGET_CLAUDE_DIR || path.join(os.homedir(), ".claude");

function copy(rel, dest) {
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.copyFileSync(path.join(ROOT, rel), dest);
	console.log(`copied ${rel} -> ${dest}`);
}

copy("global/hooks/cf-guard.js", path.join(CLAUDE, "hooks", "cf-guard.js"));
for (const name of fs.readdirSync(path.join(ROOT, "global", "skills"))) {
	copy(`global/skills/${name}/SKILL.md`, path.join(CLAUDE, "skills", name, "SKILL.md"));
}

if (process.argv.includes("--register")) {
	const file = path.join(CLAUDE, "settings.json");
	const exists = fs.existsSync(file);
	const settings = exists ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
	const command = `node "${path.join(CLAUDE, "hooks", "cf-guard.js")}"`;
	settings.hooks = settings.hooks || {};
	const pre = (settings.hooks.PreToolUse = settings.hooks.PreToolUse || []);
	if (pre.some((e) => (e.hooks || []).some((h) => h.command === command))) {
		console.log("cf-guard already registered");
	} else {
		if (exists) fs.copyFileSync(file, `${file}.bak-cf-target`);
		pre.push({ matcher: "Bash|PowerShell", hooks: [{ type: "command", command, timeout: 5, statusMessage: "Verificando cuenta de Cloud Foundry…" }] });
		fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", "utf8");
		console.log(`registered cf-guard in ${file}${exists ? " (backup: settings.json.bak-cf-target)" : ""}`);
	}
}
