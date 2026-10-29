"use strict";
/**
 * Fake `cf` for tests (CF_TARGET_CF_BIN=test/fake-cf.js). Keeps its session in
 * $CF_HOME/.cf/config.json with cf-like token fields, and logs every call to
 * FAKE_CF_LOG (arguments, CF_HOME, whether CF_PASSWORD was set — never its value).
 */
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const cfg = path.join(process.env.CF_HOME || "", ".cf", "config.json");
if (process.env.FAKE_CF_LOG) {
	fs.appendFileSync(process.env.FAKE_CF_LOG, JSON.stringify({
		args, CF_HOME: process.env.CF_HOME || null, CF_PLUGIN_HOME: process.env.CF_PLUGIN_HOME || null,
		hasPassword: Boolean(process.env.CF_PASSWORD)
	}) + "\n");
}
let c = {};
try { c = JSON.parse(fs.readFileSync(cfg, "utf8")); } catch (e) { /* no session */ }
const save = () => { fs.mkdirSync(path.dirname(cfg), { recursive: true }); fs.writeFileSync(cfg, JSON.stringify(c)); };
const flag = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const out = (text, code = 0) => { process.stdout.write(text + "\n"); process.exit(code); };
const token = () => `tok-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const logged = () => Boolean(c.AccessToken) && !c.Expired;

switch (args[0]) {
	case "--version":
	case "version":
		out("cf version 8.0.0-fake");
		break;
	case "api":
		c.Target = args[1];
		save();
		out("OK");
		break;
	case "auth":
		if (process.env.CF_PASSWORD !== "good" && process.env.CF_PASSWORD !== process.env.FAKE_CF_ACCEPT) out("Credentials were rejected, please try again.\nFAILED", 1);
		Object.assign(c, { AccessToken: token(), RefreshToken: token(), UAAGrantType: "password", FakeUser: process.env.CF_USERNAME, Expired: false });
		save();
		out("OK");
		break;
	case "login":
		if (flag("--sso-passcode") !== "good") out("Invalid passcode.\nFAILED", 1);
		Object.assign(c, { Target: flag("-a"), AccessToken: token(), RefreshToken: token(), UAAGrantType: "", FakeUser: "sso@acme.com", Expired: false });
		save();
		out("OK");
		break;
	case "target":
		// Like real cf: `cf target` alone only reads config.json (exit 0 even with
		// expired tokens); targeting an org is the first call that hits the network.
		if (!c.AccessToken) out("Not logged in. Use 'cf login' or 'cf login --sso' to log in.\nFAILED", 1);
		if (flag("-o") && !logged()) out("The token expired, was revoked, or the token ID is incorrect. Please log back in to re-authenticate.\nFAILED", 1);
		if (flag("-o") === "org-missing") out(`Organization '${flag("-o")}' not found.\nFAILED`, 1);
		if (flag("-o")) {
			c.OrganizationFields = { Name: flag("-o") };
			c.SpaceFields = { Name: flag("-s") };
			save();
		}
		out(`API endpoint:   ${c.Target}\nuser:           ${c.FakeUser}\norg:            ${(c.OrganizationFields || {}).Name || ""}\nspace:          ${(c.SpaceFields || {}).Name || ""}`);
		break;
	case "oauth-token":
		// Refreshes the access token: fails when the refresh token is no longer valid.
		if (!logged()) out("The token expired, was revoked, or the token ID is incorrect. Please log back in to re-authenticate.\nFAILED", 1);
		out(`bearer ${c.AccessToken}`);
		break;
	case "curl":
		if (args[1].startsWith("/v3/organizations")) out(JSON.stringify({ resources: [{ guid: "g1", name: "acme-org" }], pagination: { next: null } }));
		if (args[1].startsWith("/v3/spaces")) {
			const rel = { organization: { data: { guid: "g1" } } };
			out(JSON.stringify({ resources: [{ name: "dev", relationships: rel }, { name: "qa", relationships: rel }], pagination: { next: null } }));
		}
		out("{}");
		break;
	case "whereami": {
		// Test helper: optionally waits, then prints the target this run sees.
		const until = Date.now() + Number(args[1] || 0);
		while (Date.now() < until) { /* busy wait: keeps the run open */ }
		out(`${(c.OrganizationFields || {}).Name}/${(c.SpaceFields || {}).Name} as ${c.FakeUser}`);
		break;
	}
	case "refresh":
		// Test helper: simulates cf renewing the access token during a command.
		c.AccessToken = token();
		save();
		out("refreshed");
		break;
	default:
		out(`fake cf: ${args.join(" ")}`);
}
