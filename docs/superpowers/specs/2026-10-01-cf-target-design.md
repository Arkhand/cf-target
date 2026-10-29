# cf-target — design

Status: **draft, awaiting review** · Date: 2026-10-01 · Owner: Daniel Musial

## 1. Problem

Cloud Foundry CLI state is global: `~/.cf/config.json` holds one session and one
target (org/space) for the whole machine. Whatever the last `cf login` / `cf target`
set stays active for the next command, in any terminal, any repo, any Claude session.

This already caused an incident (2026-09-18): a `cf deploy` meant for one client
landed in another client's subaccount because the global target
pointed there. The MTA wrote a subaccount-level destination that survived
`cf undeploy` and had to be deleted by hand through the Destination Service API.

It also blocks working on two projects at once: deploying repo A and repo B to two
different subaccounts from two Claude sessions means they fight over one target.

Secondary problems:
- Passwords for `cf login` end up typed into chats (one is in plain text in
  `~/.claude/history.jsonl` today).
- Nothing tells Claude, per project, which account it is supposed to use.

## 2. Goals

1. Each project **declares** its CF account in a file the user can read at a glance.
2. Every `cf` command Claude runs for a project goes to **that** account, with no
   chance of using another one by accident — even when two repos are being worked on
   at the same time, also when both use the same subaccount with different spaces.
3. Claude can log in on its own when a session expires, using a password stored in a
   **secure OS store** that Claude never sees.
4. When a project has no declaration and Claude is asked to do CF work, Claude
   **proposes** creating it.
5. `cf-proxy` uses the same declaration and the same session per subaccount.

Non-goals: Linux/macOS credential stores (Windows only for now; the code keeps the
store behind one module so another backend can be added), managing CF users or
roles, replacing `cf` for interactive human use outside Claude.

## 3. Decisions taken (with the user, 2026-10-01)

| Topic | Decision |
|---|---|
| Password store | **Windows Credential Manager** (visible in Control Panel). Launcher's DPAPI `secrets.bin` migrates to it. |
| `.cf-target` in git | **Not committed.** Added to the project's `.gitignore` on creation. |
| Hook strictness | **Block every raw `cf`** Claude runs, except `--version`, `version`, `help`, `-h`, `plugins`. |
| Sessions | **One session shared by the wrapper and cf-proxy** (asked "per subaccount"; keyed by `(api, user)` on planning, see §7). Concurrent runs must not interfere (two repos at once). |
| Where things live | Tool in its own repo `<projects>\cf-target`. Skills and hook are **global** in `~/.claude`. |

## 4. Overview

```
 project repo                         ~/.cf-target/                       Windows
 ─────────────                        ─────────────                       ───────
 .cf-target  ──► cf-target (CLI) ──►  sessions/<api>/<user>/cf-home  ◄──  Credential Manager
 (declares)        │   per run:         (one login per user and region) cf-target:<api>:<user>
                   │   temp CF_HOME copy ─► cf ... ─► write back token
                   ▼
              cf-proxy (profiles resolve to the same session)

 ~/.claude/hooks/cf-guard.js   blocks raw `cf` → "use cf-target -- <args>"
 ~/.claude/skills/cf-target    how to declare / log in / run / propose the file
 ~/.claude/skills/cf-proxy     how to run cf-proxy for the project's account
```

| Piece | Kind | Location |
|---|---|---|
| `cf-target` CLI + libs | Node, no dependencies | this repo; `npm link` puts `cf-target` on PATH |
| `cf-guard.js` | PreToolUse hook | `~/.claude/hooks/` |
| `cf-target` skill | Skill | `~/.claude/skills/cf-target/SKILL.md` |
| `cf-proxy` skill | Skill | `~/.claude/skills/cf-proxy/SKILL.md` |
| cf-proxy changes | Code | `CF-proxy` repo |

## 5. The `.cf-target` file

Plain `key = value`, `#` comments, at the project root (found by walking up from the
current directory, like git). Example written by `cf-target init`:

```ini
# Cloud Foundry account for this project. Used by cf-target, cf-proxy and Claude.
# Not committed (.gitignore). Passwords are NOT here: Windows Credential Manager.
api   = https://api.cf.us10-001.hana.ondemand.com
org   = my-org
space = dev
user  = you@company.com
auth  = password          # password | sso
```

Rules:
- Required: `api`, `org`, `space`, `user`, `auth`. Optional: `origin` (IdP origin
  key for `cf auth --origin`, for subaccounts whose password users live in a custom
  IdP).
- Unknown keys are an error (typos must not silently fall back to defaults).
- `api` is normalized for comparisons (lowercase, no trailing slash).
- `org` may contain spaces and commas (real example:
  `Acme Inc. S4 Rise , GUI SSO , MBC account_workzone-dev-abc123`); the value is
  everything after the first `=`, trimmed, with an inline ` # comment` stripped.
- The nearest file wins. A file in a parent folder applies to every subfolder
  without its own file (monorepos with one account).

## 6. Credential store

Module `lib/credstore.js`, one backend for now: Windows Credential Manager through
PowerShell + P/Invoke (`CredWrite` / `CredRead` / `CredDelete`, generic credential,
`CRED_PERSIST_LOCAL_MACHINE`). Spike done 2026-10-01: write → read → delete round
trip works, ~285 ms including the `Add-Type` compile.

- Target name: `cf-target:<normalized api>:<user>`. One password per user per
  region, shared by every project and by cf-proxy.
- The secret travels only through **stdin** of the PowerShell process, never argv
  (visible in Task Manager) and never stdout. The CLI passes it to `cf auth` via the
  `CF_PASSWORD` environment variable (verified supported by cf v8).
- Claude never handles the password: `cf-target login` prompts in the user's
  terminal with no echo. Claude asks the user to run `! cf-target login`.
- `cf-target forget` deletes the stored password.
- Test backend: `CF_TARGET_CRED_BACKEND=file` + `CF_TARGET_HOME` (plain JSON in a
  temp dir), so tests never touch the real store.

The Python launcher's `store.py` switches to the same store via `ctypes`
(`advapi32.CredReadW/CredWriteW`) and migrates `secrets.bin` once, mapping each
launcher profile name to its `(api, user)`.

## 7. Sessions and concurrency

### Store

```
~/.cf-target/sessions/<api-host>/<user-slug>/cf-home/.cf/config.json
```

One per `(api, user)`. Refined while planning (2026-10-01): a `cf` session is a UAA
login of a **user** on a **region**; the org is only the target, and every run sets
its own target in its temp copy. Keying by `(api, user)` means one login serves every
org/space that user reaches in that region (several subaccounts of the same client,
cf-proxy draft profiles that have no org yet), and two users never share a session.
It is also the Credential Manager key, so "session" and "password" line up.
`user-slug` is a filesystem-safe encoding plus a short hash. Login writes here through
the same per-run copy (replace mode).

### Per-run isolation

Every `cf-target -- <args>` run:

1. Resolves `.cf-target` → session dir. Takes a short lock on the session
   (`session.lock`, `'wx'`, stale after 30 s) only while copying.
2. Copies `config.json` into a fresh temp `CF_HOME` (`os.tmpdir()/cf-target-<pid>-<rand>`),
   records the original's hash.
3. In the temp home: checks the session (`cf target`); if expired and
   `auth = password` with a stored password → `cf api` + `cf auth` (env
   `CF_USERNAME`/`CF_PASSWORD`); if `sso` → exit 4 asking the user to log in.
4. Verifies identity: session user == file `user` and session api == file `api`;
   otherwise exit 7, runs nothing.
5. `cf target -o <org> -s <space>` **in the temp home**; failure → exit 6.
6. Prints the banner to stderr: `[cf-target] <api> / <org> / <space> as <user>`.
7. Runs `cf <args>` with inherited stdio, `CF_HOME=<temp>`,
   `CF_PLUGIN_HOME=<home>` (plugins such as `multiapps` keep coming from `~/.cf`).
8. Write-back: if the temp `config.json` holds newer tokens, takes the lock and
   copies **only** `AccessToken`, `RefreshToken`, `UAAGrantType` back, **only if**
   the shared file still has the hash recorded in step 2 (compare-and-swap; if
   someone else refreshed meanwhile, theirs wins). Atomic: write tmp + rename.
9. Deletes the temp home. Exit code = `cf`'s exit code.

Outcome: target is never shared state; two runs never write the same
`config.json` at the same time; a crash leaves the shared session intact.

Risk: if UAA rotates refresh tokens, a run that loses the compare-and-swap keeps a
refresh token the shared store never sees. Harmless (the shared one is still valid
for the next run). If rotation invalidates old refresh tokens, the losing run's
tokens are simply discarded — also harmless.

### cf-proxy

`cf-proxy` profiles stop owning a CF_HOME. `profiles.cfHomeOf(profile)` resolves to
the session store by `(api, user)`; a running proxy also works on a **private copy**
for its lifetime (same steps 2–8, write-back on exit and on each token refresh it
detects). Existing `~/.cf-proxy/profiles/<p>/cf-home` folders are migrated once into
the store. `cf-proxy profiles add --from-target [dir]` creates the profile from a
`.cf-target`.

## 8. CLI

```
cf-target init [--api --org --space --user --auth --origin] [--dir <path>]
cf-target show                       which account this folder resolves to + session state
cf-target login [--sso-passcode X]   logs in; with password, prompts (no echo) and stores it
cf-target forget                     deletes the stored password for this target's user
cf-target targets                    orgs/spaces visible to the session (to fill init)
cf-target -- <cf args>               runs cf against this folder's account
```

- `--json` on every command: one JSON object, `{ok:true,...}` or
  `{ok:false, code, error, hint}`.
- `init` with missing values asks interactively; non-interactive (Claude) passes all
  flags. It validates by logging in (or reusing the session) and checking that
  `org`/`space` exist, writes the file, and appends `.cf-target` to `.gitignore`
  (creating it if the folder is a git repo without one).
- `show` is what the user runs to "see which account I'm on":
  ```
  .cf-target  C:\...\repo\.cf-target
  account     https://api.cf.us10-001.hana.ondemand.com / my-org / dev
  user        you@company.com (password stored: yes)
  session     ok (expires 2026-10-02 01:11)
  ```

Exit codes (0/1/2/4 mean the same as in cf-proxy; 6 and 7 are specific to
cf-target): 0 ok · 1 error · 2 usage / no `.cf-target` ·
4 no session (SSO, or no stored password) · 6 org/space not found ·
7 session identity ≠ file · other = `cf`'s own exit code (only for `--`).

## 9. Hook: `~/.claude/hooks/cf-guard.js`

PreToolUse, matcher `Bash|PowerShell`, timeout 5 s. Same style as
`gh-account-guard.js` (Spanish comments, fail **open** on its own errors).

- Splits the command on `;`, `&&`, `||`, `|`, newlines; for each segment strips
  leading `&`, env assignments, quotes and a path, and looks at the executable:
  `cf`, `cf.exe`, `cf7`, `cf8`.
- Allowed: `cf --version`, `cf version`, `cf help …`, `cf -h`, `cf plugins`.
  Everything else → `permissionDecision: "deny"` with the reason:
  - project has `.cf-target` (searched upward from the hook's `cwd`):
    *"Raw `cf` is blocked: it would use the global session. Run
    `cf-target -- <args>` (account: <api> / <org> / <space>)."*
  - project has none: *"This project has no `.cf-target`, so there is no declared
    CF account. Propose creating it with `cf-target init` (see skill cf-target)."*
- `cf-target …` and `cf-proxy cf <p> -- …` are not matched (different executable).

Known gap: a `cf` run **inside** another program (`npm run deploy`, `mbt`, a
script) is invisible to the hook. Mitigation, opt-in during install: `cf logout` of
the global session, so any indirect `cf` fails with "not logged in" instead of
hitting a random account. The skill tells Claude to route such scripts through
`cf-target -- …` equivalents.

Also: `destructive-guard.js` asks before `cf delete…` by regex on `cf\s+delete`.
Extend its rules to also match `cf-target -- delete…` and
`cf-proxy cf <p> -- delete…`, so the confirmation survives the new wrapper.

## 10. Skills

### `~/.claude/skills/cf-target/SKILL.md`

Triggers: any Cloud Foundry work in a project (deploy, `cf` commands, services,
logs, MTA), or the user asking which account a project uses.

Content:
1. Always run `cf-target show --json` first. Never call `cf` directly (the hook
   will block it anyway).
2. No `.cf-target` → **propose** one: read the project's `CLAUDE.md` / memory for
   api/org/space/user, show the proposed file to the user, and run
   `cf-target init … --json` only after the user confirms. If nothing is known,
   ask; `cf-target targets` (after a login) lists the real orgs/spaces.
3. Exit 4 → ask the user to run `! cf-target login` (password typed by them, stored
   in Credential Manager; SSO needs the passcode). Never ask for the password in chat.
4. Exit 7/6 → show the mismatch, do not "fix" by switching accounts.
5. Live-system rules from the global `CLAUDE.md`: before deploy / service changes /
   destination writes, list what will be touched (account banner included) and wait
   for confirmation.

### `~/.claude/skills/cf-proxy/SKILL.md`

1. Account comes from `.cf-target` (via `cf-target show --json`); profile found in
   `cf-proxy profiles list --json` by `(api, org)`; if missing, propose
   `cf-proxy profiles add --from-target`.
2. `cf-proxy ps --json` first; reuse a running proxy; else `start <p> --json`
   (idempotent across sessions).
3. Exit codes 4/5/6 handling, user login (`login.loggedIn`, `/__login` URL,
   redirect-uri warning), never stop proxies it did not start.

## 11. CloudeStatus

- `extra.json.repos`: add `CF-proxy` and `cf-target` so the dashboard tracks them.
- `backup/` picks up the new hook and skills automatically (`hooks/`, `skills/` are
  in the allowlist); the secret scan must stay clean (no passwords anywhere).
- Its `pendientes.md` lists a "destructive guard" with a custom rule for `cf`: this
  work covers the CF part (cf-guard + destructive-guard extension).

## 12. Testing

Unit/integration (plain Node scripts, like cf-proxy; fake `cf`, file cred backend,
temp `CF_TARGET_HOME`):
- `.cf-target` parsing: comments, orgs with spaces/commas, unknown key → error,
  upward search, nearest wins.
- Run: correct `CF_HOME`/`CF_PLUGIN_HOME`; identity mismatch → 7, nothing run;
  missing org → 6; expired session + stored password → auto `cf auth` without the
  password in argv; SSO expired → 4.
- Concurrency: two runs in parallel on the same session with different spaces →
  each sees its own target; shared `config.json` never half-written; write-back
  compare-and-swap (second writer skips).
- Hook: table of commands → allow/deny (`cf push`, `cf.exe target -o X`,
  `echo a && cf apps`, `npm run x`, `cf --version`, `cf-target -- apps`,
  `& "C:\...\cf.exe" apps`, PowerShell pipelines).
- Cred store: real round trip behind an opt-in flag (writes/deletes a dummy entry).

Live (trial `abcd1234trial / dev`, us10-001): `init` → `login` (password to
Credential Manager) → `cf-target -- apps` from two repos at the same time with
different spaces → global `~/.cf/config.json` hash unchanged.

## 13. Implementation order

1. Repo scaffold, `lib/targetfile.js`, `lib/credstore.js` (+ file backend), tests.
2. `lib/sessions.js` (store, per-run copy, lock, write-back) + `bin/cf-target.js`
   (`show`, `login`, `forget`, `--`), tests incl. concurrency.
3. `init` + `targets` + `.gitignore` handling.
4. `~/.claude/hooks/cf-guard.js` + tests; register in `~/.claude/settings.json`
   (user confirmation: global config); extend `destructive-guard.js`.
5. Skills `cf-target` and `cf-proxy`.
6. cf-proxy: session store, private copy per run, `--from-target`, launcher
   `store.py` → Credential Manager + migration.
7. CloudeStatus `extra.json`, run `status.cmd`, docs, memory.
8. Opt-in: global `cf logout`.

## 14. Resolved during review

- File name: **`.cf-target`**. Same name as the tool, a dotfile like `.nvmrc` /
  `.gitignore` (config, not content), and unambiguous when searched upward.
- No `--target <path>` option: the account is always the one of the folder the
  command runs in. One rule, nothing to override by mistake.
