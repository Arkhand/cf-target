"use strict";
/**
 * Puts a private CF_HOME in the state a .cf-target asks for, or says why it
 * cannot: session (logging in with the stored password if needed), identity
 * (the session's user and API are the file's), and target (org/space).
 */
const { cfCapture, parseTargetOutput, lastLines } = require("./cfexec");
const credstore = require("./credstore");
const { normalizeApi } = require("./targetfile");
const { URL } = require("url");

const EXIT = { ERROR: 1, USAGE: 2, NO_SESSION: 4, NO_TARGET: 6, MISMATCH: 7 };
const LOGIN_HINT = "Run in your terminal: cf-target login";

/**
 * The session in this home, or null if there is none or it can no longer be
 * used. `cf target` alone only reads config.json (exit 0 even with every token
 * expired), so `cf oauth-token` proves the session: it refreshes the access
 * token and fails once the refresh token is gone. Its output (a bearer token)
 * stays in this process; it is never printed.
 */
async function sessionOf(home) {
	const r = await cfCapture(["target"], { home, timeout: 60000 });
	if (r.code !== 0) return null;
	const s = parseTargetOutput(r.out);
	if (!s.user) return null;
	const token = await cfCapture(["oauth-token"], { home, timeout: 60000 });
	return token.code === 0 ? s : null;
}

function sameIdentity(session, target) {
	return normalizeApi(session.api) === normalizeApi(target.api) &&
		String(session.user).toLowerCase() === String(target.user).toLowerCase();
}

/** cf auth with the password in the environment: it never shows up in argv. */
async function passwordLogin(target, home, password) {
	const api = await cfCapture(["api", target.api], { home, timeout: 60000 });
	if (api.code !== 0) return { ok: false, error: lastLines(api) };
	const args = ["auth"];
	if (target.origin) args.push("--origin", target.origin);
	const auth = await cfCapture(args, { home, env: { CF_USERNAME: target.user, CF_PASSWORD: password }, timeout: 120000 });
	return auth.code === 0 ? { ok: true } : { ok: false, error: lastLines(auth) || "Credentials rejected." };
}

async function ssoLogin(target, home, passcode) {
	const r = await cfCapture(["login", "-a", target.api, "--sso-passcode", passcode], { home, timeout: 120000 });
	return r.code === 0 ? { ok: true } : { ok: false, error: lastLines(r) || "Passcode rejected." };
}

async function ensureSession(target, home) {
	let session = await sessionOf(home);
	if (!session || !sameIdentity(session, target)) {
		if (target.auth !== "password") {
			return { ok: false, code: EXIT.NO_SESSION, error: `No valid cf session for ${target.user} (SSO: needs a passcode).`, hint: LOGIN_HINT };
		}
		const password = credstore.getPassword(target.api, target.user);
		if (!password) {
			return { ok: false, code: EXIT.NO_SESSION, error: `No cf session and no stored password for ${target.user} on ${target.api}.`, hint: LOGIN_HINT };
		}
		const login = await passwordLogin(target, home, password);
		if (!login.ok) {
			// A rejected password is removed: retrying it on every run (several Claude
			// sessions, the launcher) would lock the account at the IdP. A network
			// error keeps it.
			const rejected = /reject|invalid|credentials|unauthorized|bad credentials/i.test(login.error);
			if (rejected) credstore.deletePassword(target.api, target.user);
			return {
				ok: false,
				code: EXIT.NO_SESSION,
				error: `Automatic login failed: ${login.error}${rejected ? " (the stored password was rejected and removed)" : ""}`,
				hint: LOGIN_HINT
			};
		}
		session = await sessionOf(home);
		if (!session) return { ok: false, code: EXIT.NO_SESSION, error: "Login did not leave a session.", hint: LOGIN_HINT };
	}
	if (!sameIdentity(session, target)) {
		return { ok: false, code: EXIT.MISMATCH, error: `Session is ${session.user} on ${session.api}; .cf-target says ${target.user} on ${target.api}.` };
	}
	return { ok: true, session };
}

async function prepare(target, home) {
	const s = await ensureSession(target, home);
	if (!s.ok) return s;
	const t = await cfCapture(["target", "-o", target.org, "-s", target.space], { home, timeout: 60000 });
	if (t.code !== 0) {
		return { ok: false, code: EXIT.NO_TARGET, error: `Cannot target ${target.org} / ${target.space}: ${lastLines(t)}` };
	}
	return { ok: true, session: { api: s.session.api, user: s.session.user, org: target.org, space: target.space } };
}


/** GET every page of a CF v3 endpoint through `cf curl` in this home. */
async function curlAll(firstUrl, home) {
	const out = [];
	let url = firstUrl;
	while (url) {
		const r = await cfCapture(["curl", url], { home, timeout: 60000 });
		const start = r.out.indexOf("{");
		if (r.code !== 0 || start === -1) break;
		let body;
		try {
			body = JSON.parse(r.out.slice(start));
		} catch (e) {
			break;
		}
		out.push(...(body.resources || []));
		const next = body.pagination && body.pagination.next && body.pagination.next.href;
		url = next ? new URL(next).pathname + new URL(next).search : null;
	}
	return out;
}

/** Orgs with their spaces, as the session's user sees them. */
async function listTargets(home) {
	const orgs = await curlAll("/v3/organizations?per_page=100", home);
	const names = Object.fromEntries(orgs.map((o) => [o.guid, o.name]));
	const byOrg = {};
	for (const s of await curlAll("/v3/spaces?per_page=100", home)) {
		const guid = s.relationships && s.relationships.organization && s.relationships.organization.data && s.relationships.organization.data.guid;
		if (names[guid]) (byOrg[guid] = byOrg[guid] || []).push(s.name);
	}
	return orgs
		.map((o) => ({ org: o.name, spaces: (byOrg[o.guid] || []).sort((a, b) => a.localeCompare(b)) }))
		.sort((a, b) => a.org.localeCompare(b.org));
}

module.exports = { EXIT, sessionOf, sameIdentity, passwordLogin, ssoLogin, ensureSession, prepare, listTargets };
