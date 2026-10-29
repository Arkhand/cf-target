"use strict";
let failed = 0;
function ok(name, cond) {
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
	if (!cond) failed++;
}
function throws(name, fn, re) {
	try {
		fn();
		ok(name, false);
	} catch (e) {
		ok(name, re ? re.test(e.message) : true);
	}
}
function finish() {
	console.log(failed ? `\n${failed} test(s) failed` : "\nAll tests passed");
	process.exit(failed ? 1 : 0);
}
module.exports = { ok, throws, finish };
