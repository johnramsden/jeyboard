# AGENTS.md

## Commit conventions

- Commits must be signed off (`Signed-off-by:` trailer) **by the human**. Agents must never add a `Signed-off-by:` trailer on the human's behalf — the DCO sign-off is an attestation only the human can make.
- Agents must include an `Assisted-by:` trailer identifying the agent and model.
- Order trailers as: `Assisted-by:` first, then the human's `Signed-off-by:` last (added by the human).

Format:

```
Assisted-by: AGENT_NAME:MODEL_VERSION
```

- `AGENT_NAME` — the AI tool or framework (e.g. `claude-code`, `opencode`, `codex`, `pi`, …).
- `MODEL_VERSION` — the specific model version used (e.g. `claude-sonnet-4-6`, `gpt-5.5`).

Example:

```
Assisted-by: opencode:gpt-5.5
```

Other commit rules:

- Commit messages must be ASCII only.
- Keep PRs small and focused; don't mix trivial and controversial changes.
- Squash into logical commits for non-trivial PRs.
- Maintain a linear git history.


## Project principles

`SPEC.md` is the source of truth for behaviour and scope. Read it before changing anything. If a change conflicts with it, update the spec in the same PR or ask first.

### Keep it simple

The goal is a codebase with as little as possible that can break, and that is easy to understand.

- Choose the simplest design that meets the spec. Less code means less to break and less to read.
- Prefer public GNOME/Clutter/St APIs over private GNOME Shell internals. Any private internal or monkey-patch needs a comment explaining why no public API works, and must be listed in SPEC.md section 16.
- Prefer one code path over per-version branches. Only branch, by feature detection, when GNOME versions actually behave differently.
- No speculative abstraction: no layers, options, settings or extension points for needs that don't exist yet. SPEC.md sections 3.2 and 14 list what is deliberately left out.
- `keys.js`, `layout.js` and `layouts/us.js` stay pure: no imports, ES2016 only, plain data in and plain actions out.
- Small functions, clear names, no clever tricks. If a reader has to stop and puzzle over something, simplify it; if it can't be simpler, comment it.
- Every new dependency, file, setting or GNOME hook needs a stated reason in the PR description.

### Keep it tested

Everything in the codebase should be adequately tested.

- Every behaviour change ships with tests in the same commit.
- Pure modules are unit-tested with `make test` (plain `gjs`, no dependencies). Cover every branch of the modifier state machine, the key ledger and hit-testing, including edge cases (double press, release without press, release-all ordering).
- Keep shell-facing code (`extension.js`, `view.js`, `input.js`, `typer.js`, `indicator.js`) thin, so logic lives in the tested pure modules. Cover the rest with the manual checklist in SPEC.md section 13.2, and with headless `gnome-shell-test-tool` scripts once they exist. A PR touching these files says which checklist items were run, on which GNOME version.
- A bug in testable code is fixed by first adding a failing test that reproduces it.
- `make test` must pass before every commit.
- Never report something as working without running it. Say what was tested and how.

### Comment the confusing parts

- Comment why, not what.
- Anything that depends on GNOME or mutter behaviour must explain itself, with a link to the upstream source pinned to a tag. Examples: event-filter ordering and grabs, why releases are claimed at press time, why Super is never held, why `notify_keyval` is banned, stuck-key hazards.
- Each module starts with a short comment saying what it owns and what it must not do.
- An outdated comment is a bug; update comments with the code.

### Never break these

- Never take key focus, call `Main.pushModal()`, or open a `PopupMenu`; each one steals focus from the app being typed into.
- Never use `notify_keyval`.
- Every key press must have a guaranteed release (the ledger plus the release-all triggers in SPEC.md 6.6).
- Never log key codes, labels or typed content.
