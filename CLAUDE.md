# cf-target

Per-project Cloud Foundry account: a `.cf-target` file declares api/org/space/user,
a CLI runs `cf` only against that account (isolated session per subaccount,
password from Windows Credential Manager), a global hook blocks raw `cf`, and
global skills teach Claude to use it.

- Design: [docs/superpowers/specs/2026-10-01-cf-target-design.md](docs/superpowers/specs/2026-10-01-cf-target-design.md)
- Read `.claude/memory/MEMORY.md` before changing anything.
- Code, comments and docs in English. Memory in Spanish.
- Skills and the hook are global (`~/.claude/skills`, `~/.claude/hooks`), not in
  this repo. Registering the hook in `~/.claude/settings.json` needs the user's OK.
- Related repo: `../CF-proxy` (shares the session per subaccount).
