"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ok, finish } = require("./helpers");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "cft-cred-"));
process.env.CF_TARGET_HOME = home;
process.env.CF_TARGET_CRED_BACKEND = "file";
const cred = require("../lib/credstore");

const API = "https://API.cf.eu10.hana.ondemand.com/";
const nasty = `p"a'ss %PATH% & ^| ñandú 🔑 ${"x".repeat(40)}`;

ok("key normalizes api and user", cred.credKey(API, "Dev@Acme.com") === "cf-target:https://api.cf.eu10.hana.ondemand.com:dev@acme.com");
ok("nothing stored yet", cred.getPassword(API, "dev@acme.com") === null);
cred.setPassword(API, "dev@acme.com", nasty);
ok("special characters round-trip (file backend)", cred.getPassword("https://api.cf.eu10.hana.ondemand.com", "DEV@acme.com") === nasty);
ok("another user is separate", cred.getPassword(API, "other@acme.com") === null);
ok("delete returns true", cred.deletePassword(API, "dev@acme.com") === true);
ok("deleted is gone", cred.getPassword(API, "dev@acme.com") === null);
ok("delete of nothing returns false", cred.deletePassword(API, "dev@acme.com") === false);

// Opt-in: real Windows Credential Manager with a dummy entry (written and deleted).
if (process.env.CF_TARGET_TEST_WINCRED === "1") {
	delete process.env.CF_TARGET_CRED_BACKEND;
	const user = `cf-target-selftest-${process.pid}@example.com`;
	cred.setPassword("https://api.selftest.invalid", user, nasty);
	ok("Credential Manager round trip with special characters", cred.getPassword("https://api.selftest.invalid", user) === nasty);
	ok("Credential Manager delete", cred.deletePassword("https://api.selftest.invalid", user) === true && cred.getPassword("https://api.selftest.invalid", user) === null);
}

fs.rmSync(home, { recursive: true, force: true });
finish();
