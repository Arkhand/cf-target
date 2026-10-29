"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { ok, finish } = require("./helpers");

const HOOK = path.join(__dirname, "..", "global", "hooks", "cf-guard.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cft-guard-"));
const withTarget = path.join(tmp, "with");
const without = path.join(tmp, "without");
fs.mkdirSync(path.join(withTarget, "sub"), { recursive: true });
fs.mkdirSync(without);
fs.writeFileSync(path.join(withTarget, ".cf-target"), "api = https://api.cf.eu10.hana.ondemand.com\norg = acme-org\nspace = dev   # x\nuser = u@a.com\nauth = sso\n");

function decide(command, cwd = withTarget, tool = "Bash") {
	const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: tool, tool_input: { command }, cwd }), encoding: "utf8" });
	if (!r.stdout.trim()) return { decision: "allow", status: r.status };
	const o = JSON.parse(r.stdout).hookSpecificOutput;
	return { decision: o.permissionDecision, reason: o.permissionDecisionReason, status: r.status };
}

const DENY = [
	"cf apps",
	"cf.exe target -o OTHER -s x",
	"cd x && cf push",
	"echo a; cf services",
	'& "C:\\Program Files\\Cloud Foundry\\cf.exe" deploy x.mtar',
	'powershell -Command "cf apps; echo x"',
	"cmd /c cf login -a https://x",
	"CF_TRACE=true cf apps",
	"cf8 apps",
	"$x = 1\ncf apps",
	"bash -c 'cf delete app -f'",
	// From the final review: assignments, subexpressions, prefixes, nested shells with valued flags.
	"$apps = cf apps",
	"$x = & cf target",
	"x=$(cf apps)",
	"echo $(cf apps)",
	"(cf apps)",
	"Write-Output (cf target)",
	"if (cf target) { 'ok' }",
	'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "cf apps"',
	"pwsh -NoLogo -Command { cf apps }",
	"time cf apps",
	"env cf apps",
	"exec cf apps",
	"Start-Process cf -ArgumentList apps",
	'cmd /s /c "cf apps"'
];
const ALLOW = [
	"cf --version", "cf version", "cf help push", "cf plugins", "cf",
	"cf-target -- apps", "node bin\\cf-proxy.js cf acme -- apps",
	'git commit -m "fix cf push"', "echo cf apps", "npm run deploy", "ls cf",
	"# cf push\nGet-ChildItem",
	"(cf --version)",
	// From the final review: text that mentions cf is not a cf command.
	"git commit -F - <<'EOF'\nfix(x): something\n\ncf push now goes through cf-target\nEOF",
	'git commit -m "$(cat <<\'EOF\'\nmsg\ncf apps\nEOF\n)"',
	'grep -E "cf apps|cf push" README.md',
	"rg 'cf\\s+delete|cf push' lib",
	'echo "run this; cf apps; then that"',
	"cat > notes.md <<EOF\ncf apps\nEOF",
	"$doc = @'\ncf apps\n'@\nWrite-Output $doc"
];
for (const c of DENY) ok(`deny: ${JSON.stringify(c)}`, decide(c).decision === "deny");
for (const c of ALLOW) ok(`allow: ${JSON.stringify(c)}`, decide(c).decision === "allow");
ok("PowerShell tool is guarded too", decide("cf apps", withTarget, "PowerShell").decision === "deny");
ok("other tools are ignored", decide("cf apps", withTarget, "Read").decision === "allow");

const withReason = decide("cf apps", path.join(withTarget, "sub")).reason;
ok("reason names the account from the nearest .cf-target", /acme-org \/ dev/.test(withReason) && /cf-target -- apps/.test(withReason));
ok("reason without .cf-target asks to propose one", /cf-target init/.test(decide("cf apps", without).reason));

const storeLike = path.join(tmp, "home");
fs.mkdirSync(path.join(storeLike, ".cf-target", "sessions"), { recursive: true });
fs.mkdirSync(path.join(storeLike, "repo"));
ok("a .cf-target directory above (the session store) is not a project file", /cf-target init/.test(decide("cf apps", path.join(storeLike, "repo")).reason));

const broken = spawnSync(process.execPath, [HOOK], { input: "not json", encoding: "utf8" });
ok("fails open on bad input", broken.status === 0 && !broken.stdout.trim());

fs.rmSync(tmp, { recursive: true, force: true });
finish();
