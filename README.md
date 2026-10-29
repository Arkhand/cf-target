# cf-target

Run Cloud Foundry commands **only** against the account a project declares.

`cf` keeps one session and one target (org/space) for the whole machine in
`~/.cf/config.json`: whatever the last `cf target` set applies to the next
command, in any terminal or repo. That is how a deploy once landed in another
client's subaccount. `cf-target` gives every project a declared account and runs
every `cf` command in an isolated copy of the session, pinned to that account.

```
cf-target -- deploy mta_archives/app_1.0.0.mtar -f
[cf-target] https://api.cf.us10-001.hana.ondemand.com / my-org / dev as you@company.com
```

## The `.cf-target` file

At the project root (found by walking up from the current folder, like git).
Not committed: `init` adds it to `.gitignore`. No passwords in it.

```ini
# Cloud Foundry account for this project. Used by cf-target, cf-proxy and Claude.
# Not committed (.gitignore). Passwords are NOT here: Windows Credential Manager.
api   = https://api.cf.us10-001.hana.ondemand.com
org   = my-org
space = dev
user  = you@company.com
auth  = password
```

`auth` is `password` or `sso`. Optional `origin` = IdP origin key for `cf auth --origin`.

## Commands

```
cf-target init --api <url> --org <org> --space <space> --user <user> --auth password|sso [--dir <path>] [--force]
cf-target show                       which account this folder uses, stored password?, session?
cf-target login                      log in; a password is prompted (no echo) and stored
          [--password-stdin | --sso-passcode <code>]
cf-target forget                     delete the stored password
cf-target targets [--api --user]     orgs/spaces the user can see (to pick values for init)
cf-target -- <cf args>               run cf against this folder's account
```

`--json` on any command prints one JSON object. Exit codes: 0 ok · 1 error ·
2 usage or no `.cf-target` · 4 no session (SSO, or no stored password) ·
6 org/space not found · 7 the session belongs to another user/API ·
`cf-target -- …` returns `cf`'s own code.

## How it stays on the right account

- **One session per user and region** in `~/.cf-target/sessions/<api>/<user>/cf-home`,
  shared with [cf-proxy](../CF-proxy).
- **Every run works on a private copy** of that session (a temp `CF_HOME`), logs in
  with the stored password if the session expired, checks that the session's user
  and API are the file's, targets the file's org/space **in the copy**, runs `cf`,
  and writes renewed tokens back with compare-and-swap. Two repos can deploy at the
  same time, even to the same user's different spaces, without touching each other
  or the global `~/.cf`.
- **Passwords** live in Windows Credential Manager, entry `cf-target:<api>:<user>`
  (Control Panel > Credential Manager > Windows Credentials). They never go through
  argv, files or a chat: `cf auth` gets them through `CF_PASSWORD`.

## Claude Code integration (global, in `~/.claude`)

| Piece | What it does |
|---|---|
| `hooks/cf-guard.js` (PreToolUse, Bash and PowerShell) | Denies any raw `cf …` Claude runs (except `--version`, `help`, `plugins`) and points to `cf-target -- …`, or to `cf-target init` when the project has no `.cf-target`. |
| `skills/cf-target` | When to propose a `.cf-target`, how to run `cf` through the wrapper, what each exit code means, live-system rules. |
| `skills/cf-proxy` | How to start or reuse cf-proxy (and its PostgreSQL tunnels) for the project's account. |

Install / update:

```
npm link                          # puts cf-target on PATH
node scripts/install.js           # copies the hook and skills into ~/.claude
node scripts/install.js --register  # also registers the hook in ~/.claude/settings.json (backup kept)
```

The `cf-proxy` skill expects `cf-proxy` on PATH too: run `npm link` in the
`CF-proxy` clone. Its tunnel commands need a CF-proxy version with `cf-proxy tunnels`.

The sources live in `global/`; edit there and run `install.js` again.

**Known gap:** the hook only sees commands Claude runs directly. A `cf` inside
`npm run deploy`, `mbt` or a script would still use the global session. Run those
`cf` steps through `cf-target -- …`, or log the global session out (`cf logout`) so an
indirect `cf` fails instead of hitting whatever the global target is.

## Development

No dependencies, Node ≥ 18. `npm test` runs every `test/*.test.js` against a fake
`cf` (`test/fake-cf.js`) and a file-based credential backend, never the real ones.
`CF_TARGET_TEST_WINCRED=1 node test/credstore.test.js` also round-trips a dummy
entry through the real Credential Manager.

`lib/sessions.js` and `lib/targetfile.js` are vendored verbatim into CF-proxy;
`test/vendored.test.js` fails if the copies drift.

Design: [docs/superpowers/specs/2026-10-01-cf-target-design.md](docs/superpowers/specs/2026-10-01-cf-target-design.md).
