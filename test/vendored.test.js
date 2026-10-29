"use strict";
const fs = require("fs");
const path = require("path");
const { ok, finish } = require("./helpers");

const proxy = path.join(__dirname, "..", "..", "CF-proxy", "lib");
for (const name of ["sessions.js", "targetfile.js"]) {
	const vendored = path.join(proxy, name);
	if (!fs.existsSync(path.join(proxy, ".."))) {
		console.log(`SKIP  ${name}: CF-proxy not next to cf-target`);
		continue;
	}
	const norm = (f) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
	ok(`CF-proxy/lib/${name} is identical to lib/${name}`, fs.existsSync(vendored) && norm(vendored) === norm(path.join(__dirname, "..", "lib", name)));
}
finish();
