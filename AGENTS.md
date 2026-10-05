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

`docs/SPEC.md` is the source of truth for behaviour and scope. Read it before changing anything. If a change conflicts with it, update the spec in the same PR or ask first. `docs/DESIGN.md` explains the high-level design and has the glossary of GNOME terms; update it when a design decision changes.

### Keep it simple

The goal is a codebase with as little as possible that can break, and that is easy to understand.

- Choose the simplest design that meets the spec. Less code means less to break and less to read.
- Prefer public GNOME/Clutter/St APIs over private GNOME Shell internals. Any private internal or monkey-patch needs a comment explaining why no public API works, and must be listed in docs/SPEC.md section 16.
- Prefer one code path over per-version branches. Only branch, by feature detection, when GNOME versions actually behave differently.
- No speculative abstraction: no layers, options, settings or extension points for needs that don't exist yet. docs/SPEC.md sections 3.2 and 14 list what is deliberately left out.
- `keys.js`, `layout.js` and `layouts/us.js` stay pure: no imports, ES2016 only, plain data in and plain actions out.
- Small functions, clear names, no clever tricks. If a reader has to stop and puzzle over something, simplify it; if it can't be simpler, comment it.
- Every new dependency, file, setting or GNOME hook needs a stated reason in the PR description.

### Keep it tested

Everything in the codebase should be adequately tested.

- Every behaviour change ships with tests in the same commit.
- Pure modules are unit-tested with `make test` (plain `gjs`, no dependencies). Cover every branch of the modifier state machine, the key ledger and hit-testing, including edge cases (double press, release without press, release-all ordering).
- Keep shell-facing code (`extension.js`, `view.js`, `input.js`, `typer.js`, `indicator.js`) thin, so logic lives in the tested pure modules. Cover the rest with the manual checklist in docs/SPEC.md section 13.2, and with the headless `make shell-test` run (see "How to test"). A PR touching these files says which checklist items were run, on which GNOME version.
- A bug in testable code is fixed by first adding a failing test that reproduces it.
- `make test` must pass before every commit.
- Never report something as working without running it. Say what was tested and how.

### How to test

- `make test`: unit tests of the pure modules (`tests/*.test.js`, run by `tests/run.js` with plain `gjs -m`). Needs only `gjs`; takes about a second. Add a test to `tests/keys.test.js` or `tests/layout.test.js` with every change to those modules. For a bug, write the failing test first.
- `make shell-test`: builds the zip and runs `tests/shell/smoke.js` in a real **headless** `gnome-shell` (50+) through `gnome-shell-test-tool`, driving a virtual pointer and checking the key events that come out. It prints `TEST PASS` / `TEST FAIL` lines and fails the make target on any failure or on a `Gjs-CRITICAL` / `JS ERROR`; the full log is `shell-test.log` (git-ignored). It takes about 10 seconds. Add a check to `smoke.js` for any shell-facing behaviour a virtual pointer can exercise (clicks, modifiers, drag, release handling).
- Headless gotchas:
  - The Makefile starts the shell with a clean environment (`env -i`) and removes stale `/run/user/$UID/gnome-shell-test-display*` and `gnome-shell-disable-extensions` files first. A shell started from a busy login environment can hang at startup.
  - Run only one at a time. A leftover test shell from a killed run holds the display; kill it by PID. Never kill by a broad pattern (it can match your own command line) and never touch the real GDM shell.
  - The headless shell picks against the last painted frame, so the test hovers over a freshly shown panel before the first click. It also emulates mutter swallowing off-panel releases (the real "no grab" case), which is what exercises the polling path.
- Things headless cannot show (appearance, lock screen, login screen, polkit, popovers, multi-monitor, GNOME 51) are covered by the manual checklist in `docs/SPEC.md` 13.2: build the `.deb` or zip, install, log out and in, then enable. Say which items were run and on which GNOME version.
- CI (`.github/workflows/ci.yml`) runs `make test` and the package build on every push and PR, and `make shell-test` on the `ubuntu-26.04` runner (a GitHub preview image; non-blocking until seen green). Keep the workflow in step with the Makefile targets.
- Run both `make test` and `make shell-test` before committing shell-facing changes, and report what was tested and how.

### Comments

We comment generously. The reader we write for is a competent programmer who is **not** a GNOME extension developer and not necessarily a JavaScript expert. They should be able to open any file and understand what it is for and why it is built that way.

- **Explain why, and explain GNOME.** Say why a choice was made, and explain any GNOME, mutter, Clutter or St behaviour the code depends on. Anything that depends on GNOME or mutter behaviour must explain itself, with a link to the upstream source pinned to a tag. Examples: event-filter ordering and grabs, why releases are claimed at press time, why Super is never held, why `notify_keyval` is banned, stuck-key hazards.
- **Do not teach JavaScript.** Do not explain syntax or idioms (arrow functions, destructuring, `??`, `Map`, `try/catch`) and do not restate in prose what a line of code plainly does. A comment that only repeats the code is noise that hides the comments that matter.
- **Define terms once.** GNOME terms (actor, stage, grab, reactive, session mode, work area, ...) live in the glossary in `docs/DESIGN.md`; point to it instead of re-explaining them in every file. Terms owned by a module (evdev code, claim, ledger, chord, ...) are defined once at the top of that module.
- **Module headers.** Each module starts with a short comment saying what it owns and what it must not do.
- **Cross-references.** Cite the spec by section number (for example `docs/SPEC.md 5.3`) rather than copying it. Big-picture reasoning belongs in `docs/DESIGN.md`, not repeated in code.
- **Keep them true.** An outdated comment is a bug; update comments with the code. Comments must be ASCII.
- **Comment-only changes change no code.** Verify it (for example by stripping comments from the old and new file and comparing) and say so in the commit message.

### Never break these

- Never take key focus, call `Main.pushModal()`, or open a `PopupMenu`; each one steals focus from the app being typed into.
- Never use `notify_keyval`.
- Every key press must have a guaranteed release (the ledger plus the release-all triggers in docs/SPEC.md 6.6).
- Never log key codes, labels or typed content.
