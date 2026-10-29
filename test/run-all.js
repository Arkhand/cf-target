"use strict";
// Runs every test/*.test.js in its own process; fails if any fails.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const files = fs.readdirSync(__dirname).filter((f) => f.endsWith(".test.js")).sort();
let bad = 0;
for (const f of files) {
	console.log(`\n=== ${f}`);
	const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: "inherit" });
	if (r.status !== 0) bad++;
}
console.log(bad ? `\n${bad} suite(s) failed` : `\n${files.length} suite(s) passed`);
process.exit(bad ? 1 : 0);
