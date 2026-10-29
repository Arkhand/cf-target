#!/usr/bin/env node
// PreToolUse hook (Bash | PowerShell) — guardia de cuenta de Cloud Foundry.
//
// `cf` guarda UNA sesión y UN target para toda la máquina (~/.cf). Un `cf` suelto
// de Claude va a donde haya quedado el último `cf target`, que puede ser otro
// cliente (ya pasó: un deploy cayó en la subcuenta equivocada). Este hook bloquea todo `cf` directo y manda
// a usar `cf-target -- <args>`, que corre contra la cuenta del `.cf-target` del
// proyecto con una sesión aislada.
//
// Pasa lo que no toca ninguna cuenta: --version, version, help, -h, plugins.
// Límite: no ve un `cf` que corre adentro de otro programa (npm run, mbt, scripts).
// Falla ABIERTO: ante un error propio deja pasar y avisa por stderr.
// Fuente: repo cf-target, global/hooks/cf-guard.js (se instala con scripts/install.js).

const fs = require("fs");
const path = require("path");

const SAFE = new Set(["--version", "-v", "version", "help", "-h", "--help", "plugins"]);
const CF_EXE = /^cf(?:7|8)?(?:\.exe)?$/;
const SHELL_EXE = /^(?:cmd|powershell|pwsh|bash|sh|zsh)(?:\.exe)?$/;
// Prefijos que corren el comando que viene después.
const RUNNERS = /^(?:time|env|exec|nohup|command|start-process)$/i;

function allow() { process.exit(0); }
function deny(reason) {
	process.stdout.write(JSON.stringify({
		hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason }
	}));
	process.exit(0);
}

/**
 * Saca los cuerpos de heredoc (bash) y de here-strings (PowerShell): son texto
 * (un mensaje de commit, un .md), no comandos.
 */
function stripBodies(command) {
	const out = [];
	let endTag = null;
	let hereEnd = null;
	for (const line of command.split(/\r?\n/)) {
		if (endTag) {
			if (line.trim() === endTag) endTag = null;
			continue;
		}
		if (hereEnd) {
			const t = line.trimStart();
			if (t.startsWith(hereEnd)) {
				hereEnd = null;
				out.push(t.slice(2));
			}
			continue;
		}
		const heredoc = line.match(/<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/);
		const here = line.match(/@(['"])\s*$/);
		if (heredoc) {
			endTag = heredoc[2];
			out.push(line.slice(0, heredoc.index) + line.slice(heredoc.index + heredoc[0].length));
		} else if (here) {
			hereEnd = `${here[1]}@`;
			out.push(line.slice(0, here.index));
		} else {
			out.push(line);
		}
	}
	return out.join("\n");
}

/** Parte en comandos por ; && || | & y saltos de línea, sin cortar adentro de comillas. */
function segments(command) {
	const segs = [];
	let cur = "";
	let quote = null;
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		if (quote) {
			cur += c;
			// Escape dentro de comillas dobles (\" en bash, `" en PowerShell).
			if (quote === '"' && (c === "\\" || c === "`") && i + 1 < command.length) cur += command[++i];
			else if (c === quote) quote = null;
			continue;
		}
		if (c === '"' || c === "'") {
			quote = c;
			cur += c;
			continue;
		}
		if (c === ";" || c === "\n" || c === "\r" || c === "|" || c === "&") {
			if ((c === "|" || c === "&") && command[i + 1] === c) i++;
			segs.push(cur);
			cur = "";
			continue;
		}
		cur += c;
	}
	segs.push(cur);
	return segs.map((s) => s.trim()).filter(Boolean);
}

/** Dónde puede empezar un comando: al inicio y después de = ( { ` fuera de comillas ($x = cf …, $(cf …), (cf …)). */
function starts(seg) {
	const out = [seg];
	let quote = null;
	for (let i = 0; i < seg.length; i++) {
		const c = seg[i];
		if (quote) {
			if (c === quote) quote = null;
			continue;
		}
		if (c === '"' || c === "'") quote = c;
		else if (c === "=" || c === "(" || c === "{" || c === "`") out.push(seg.slice(i + 1));
	}
	return out;
}

/** Palabras con comillas resueltas, y dónde termina cada una en el texto. */
function tokenize(s) {
	const tokens = [];
	let i = 0;
	while (i < s.length) {
		while (i < s.length && /\s/.test(s[i])) i++;
		if (i >= s.length) break;
		let text = "";
		while (i < s.length && !/\s/.test(s[i])) {
			const c = s[i];
			if (c === '"' || c === "'") {
				const j = s.indexOf(c, i + 1);
				const end = j === -1 ? s.length : j;
				text += s.slice(i + 1, end);
				i = end + 1;
			} else {
				text += c;
				i++;
			}
		}
		tokens.push({ text, end: i });
	}
	return tokens;
}

/** El script de un shell anidado, sin las comillas o llaves de afuera. */
function unwrap(s) {
	const t = s.trim();
	if (/^(["']).*\1$/s.test(t) || /^\{.*\}$/s.test(t)) return t.slice(1, -1);
	return t.replace(/^["']/, "").replace(/["']$/, "");
}

const clean = (word) => word.replace(/[)}`]+$/, "");

function checkStart(text, depth) {
	const s = text.trim().replace(/^&\s*/, "");
	const toks = tokenize(s);
	let k = 0;
	// VAR=valor delante (bash), salvo que el propio comando sea cf.
	while (k < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[k].text)) k++;
	while (k < toks.length && RUNNERS.test(toks[k].text)) {
		k++;
		if (k < toks.length && /^-filepath$/i.test(toks[k].text)) k++;
	}
	if (k >= toks.length) return null;
	const exe = clean(path.win32.basename(toks[k].text.replace(/\//g, "\\")).toLowerCase());
	const rest = toks.slice(k + 1);
	if (CF_EXE.test(exe)) {
		const first = clean(rest[0] ? rest[0].text : "").toLowerCase();
		if (!first || SAFE.has(first)) return null;
		return { args: clean(s.slice(toks[k].end).trim()) };
	}
	if (SHELL_EXE.test(exe) && depth < 3) {
		const flag = exe.startsWith("cmd") ? /^\/[ck]$/i : /^(?:-c|-command)$/i;
		const at = rest.findIndex((t) => flag.test(t.text));
		if (at !== -1) return findRawCf(unwrap(s.slice(rest[at].end)), depth + 1);
	}
	return null;
}

/** El primer `cf` que se ejecutaría con algo que no está en SAFE, o null. */
function findRawCf(command, depth = 0) {
	for (const seg of segments(stripBodies(command))) {
		for (const start of starts(seg)) {
			const hit = checkStart(start, depth);
			if (hit) return hit;
		}
	}
	return null;
}

function findTargetFile(dir) {
	let d = path.resolve(dir);
	for (;;) {
		const f = path.join(d, ".cf-target");
		// Archivo, no carpeta: ~/.cf-target es el store de sesiones.
		try {
			if (fs.statSync(f).isFile()) return f;
		} catch (e) { /* no existe */ }
		const parent = path.dirname(d);
		if (parent === d) return null;
		d = parent;
	}
}

function describe(file) {
	const text = fs.readFileSync(file, "utf8");
	const get = (k) => {
		const m = text.match(new RegExp(`^[ \\t]*${k}[ \\t]*=[ \\t]*(.*?)(?:[ \\t]+#.*)?[ \\t]*$`, "m"));
		return m ? m[1] : "?";
	};
	return `${get("api")} / ${get("org")} / ${get("space")}`;
}

function main(data) {
	if (!["Bash", "PowerShell"].includes(data.tool_name)) allow();
	const command = (data.tool_input && data.tool_input.command) || "";
	const hit = findRawCf(command);
	if (!hit) allow();
	const file = findTargetFile(data.cwd || process.cwd());
	if (file) {
		deny(`\`cf\` directo está bloqueado: usaría la sesión global, que puede apuntar a otro cliente. ` +
			`Corré \`cf-target -- ${hit.args}\` (cuenta del proyecto: ${describe(file)}).`);
	}
	deny("`cf` directo está bloqueado y este proyecto no tiene `.cf-target`: no hay cuenta de Cloud Foundry declarada. " +
		"Proponé crearla con `cf-target init` (skill cf-target) y esperá la confirmación del usuario.");
}

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
	try {
		main(JSON.parse(input || "{}"));
	} catch (e) {
		process.stderr.write(`cf-guard: ${e && e.message}\n`);
		allow();
	}
});
