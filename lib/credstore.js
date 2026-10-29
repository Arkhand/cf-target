"use strict";
/**
 * Passwords, one per (API endpoint, user), in Windows Credential Manager.
 *
 * Visible to the user in Control Panel > Credential Manager > Windows
 * Credentials, entry "cf-target:<api>:<user>". Shared by every project and by
 * cf-proxy's launcher (same key).
 *
 * The secret never goes through argv: PowerShell receives the request as JSON
 * on stdin and answers through a pipe. Node's built-ins cannot call advapi32
 * directly, hence PowerShell + P/Invoke (~300 ms per call).
 *
 * CF_TARGET_CRED_BACKEND=file stores into $CF_TARGET_HOME/credentials.test.json
 * instead: tests only, never for real use.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { normalizeApi } = require("./targetfile");
const { baseDir } = require("./sessions");

const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
# UTF-8 both ways: the console code page would mangle non-ASCII passwords (symmetrically,
# so a round trip still "works" while Credential Manager holds the wrong bytes).
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class CfTargetCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredWrite(ref CREDENTIAL c, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredRead(string target, int type, int flags, out IntPtr c);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredDelete(string target, int type, int flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr p);
  public static void Write(string target, string user, string secret) {
    byte[] blob = Encoding.Unicode.GetBytes(secret);
    var c = new CREDENTIAL { Type = 1, TargetName = target, UserName = user, CredentialBlobSize = blob.Length, CredentialBlob = Marshal.AllocCoTaskMem(blob.Length), Persist = 2 };
    try {
      Marshal.Copy(blob, 0, c.CredentialBlob, blob.Length);
      if (!CredWrite(ref c, 0)) throw new Exception("CredWrite failed: " + Marshal.GetLastWin32Error());
    } finally { Marshal.FreeCoTaskMem(c.CredentialBlob); }
  }
  public static string Read(string target) {
    IntPtr p;
    if (!CredRead(target, 1, 0, out p)) return null;
    try {
      var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      return Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2);
    } finally { CredFree(p); }
  }
  public static bool Delete(string target) { return CredDelete(target, 1, 0); }
}
'@
$req = [Console]::In.ReadToEnd() | ConvertFrom-Json
switch ($req.op) {
  'get'    { $s = [CfTargetCred]::Read($req.target); if ($null -eq $s) { '{"found":false}' } else { @{ found = $true; secret = $s } | ConvertTo-Json -Compress } }
  'set'    { [CfTargetCred]::Write($req.target, $req.user, $req.secret); '{"ok":true}' }
  'delete' { @{ ok = $true; deleted = [CfTargetCred]::Delete($req.target) } | ConvertTo-Json -Compress }
}
`;

function backend() {
	return process.env.CF_TARGET_CRED_BACKEND === "file" ? "file" : "wincred";
}

function credKey(api, user) {
	return `cf-target:${normalizeApi(api)}:${String(user || "").trim().toLowerCase()}`;
}

function powershell(request) {
	// -EncodedCommand: the script travels as base64 UTF-16LE, no quoting issues.
	const encoded = Buffer.from(PS_SCRIPT, "utf16le").toString("base64");
	const r = spawnSync("powershell.exe",
		["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
		{ input: JSON.stringify(request), encoding: "utf8", windowsHide: true, timeout: 30000 });
	const last = String(r.stdout || "").trim().split(/\r?\n/).pop();
	try {
		return JSON.parse(last);
	} catch (e) {
		const why = String(r.stderr || (r.error && r.error.message) || "no output").trim().split(/\r?\n/)[0];
		throw new Error(`Windows Credential Manager: ${why}`);
	}
}

function testFile() {
	return path.join(baseDir(), "credentials.test.json");
}

function readTestStore() {
	try { return JSON.parse(fs.readFileSync(testFile(), "utf8")); } catch (e) { return {}; }
}

function writeTestStore(store) {
	fs.mkdirSync(path.dirname(testFile()), { recursive: true });
	fs.writeFileSync(testFile(), JSON.stringify(store, null, 2), "utf8");
}

function getPassword(api, user) {
	const key = credKey(api, user);
	if (backend() === "file") return readTestStore()[key] ?? null;
	const res = powershell({ op: "get", target: key });
	return res.found ? res.secret : null;
}

function setPassword(api, user, secret) {
	const key = credKey(api, user);
	if (backend() === "file") {
		const store = readTestStore();
		store[key] = secret;
		return writeTestStore(store);
	}
	powershell({ op: "set", target: key, user: String(user).trim(), secret });
}

function deletePassword(api, user) {
	const key = credKey(api, user);
	if (backend() === "file") {
		const store = readTestStore();
		if (!(key in store)) return false;
		delete store[key];
		writeTestStore(store);
		return true;
	}
	return Boolean(powershell({ op: "delete", target: key }).deleted);
}

module.exports = { backend, credKey, getPassword, setPassword, deletePassword };
