# jeyboard design

This is the high-level "how and why" of jeyboard. It is written for someone who has
not built a GNOME Shell extension before. [SPEC.md](SPEC.md) is the source of truth
for exact behaviour; this document explains the shape of the solution and the
reasoning behind the big decisions, so the code is easier to read. Section numbers
like "SPEC 5.3" point at the detailed rules.

Status note: this describes what is implemented. The owner has confirmed the main
scenarios on GNOME 50.1 (SPEC 13.1); GNOME 51 has not been checked.

## Glossary

- **GNOME Shell**: the desktop (top bar, overview, lock screen, dialogs). It is a large
  JavaScript program that runs inside the compositor process.
- **mutter**: the compositor and window manager inside that process. It receives every
  mouse, touch and keyboard event from the kernel and decides who gets it.
- **Wayland**: the display protocol. Apps are separate clients; mutter is the server.
- **Clutter**: the scene-graph library inside mutter. It draws the screen and routes
  input events.
- **St** ("Shell Toolkit"): themeable widgets built on Clutter, styled with CSS
  (`stylesheet.css`).
- **actor**: any object on screen (a panel, a label, a key). Actors form a tree.
- **stage**: the root actor; everything on screen is somewhere under it.
- **reactive**: an actor that can be the target of pointer events.
- **picking**: working out which actor is visually under a point. Picking ignores grabs.
- **grab**: a temporary rule "while this is active, input goes only to this thing", used
  by menus, modal dialogs and popovers. A grab (and `Main.pushModal()`) also makes mutter
  drop keyboard focus from the app, so jeyboard never takes one.
- **event filter**: a function registered with `Clutter.Event.add_filter()` that sees
  input events before normal delivery. It answers `EVENT_STOP` (handled, nobody else
  gets it) or `EVENT_PROPAGATE` (carry on).
- **evdev key code**: the Linux kernel's number for a physical key (30 is the key where
  A is on a US keyboard). It names a key position, not a character.
- **modifier**: Shift, Ctrl, Alt or Super: a key that changes what other keys do.
- **session mode**: which shell UI is running: the normal user session, the lock screen
  (`unlock-dialog`) or the login screen (`gdm`).
- **work area**: a monitor's rectangle minus the top bar and docks.
- **GSettings / dconf**: the desktop's persistent key/value store; the keys are declared
  in the schema XML.
- **stage pixels**: the pixels Clutter positions actors in (logical, scaled pixels).

## 1. The problem

jeyboard is an on-screen keyboard (OSK) for someone who drives the computer with a
mouse. Three things make that hard on GNOME:

1. **Real modifiers.** Ctrl, Alt, Shift and Super must act like keys held down on a
   hardware keyboard (Ctrl+C, Alt+Tab, Ctrl+click in a file manager). GNOME's own OSK
   only offers one-shot latches that wrap a single text commit, never a held key.
2. **It must work everywhere**: normal windows, fullscreen apps, the overview, the
   lock screen, the login screen, and password prompts (polkit, keyring, Wi-Fi).
3. **It must never steal keyboard focus.** If clicking the keyboard moved focus away
   from the text box you are typing in, nothing would work.

## 2. The big decision: an extension inside gnome-shell

Mutter (GNOME's window manager and Wayland compositor) deliberately does not support
the Wayland protocols a separate OSK program would use. A separate program also sits
*below* shell dialogs, is hidden on the lock screen and cannot receive clicks while the
shell has the pointer grabbed. So the keyboard has to live **inside the gnome-shell
process** as an extension, drawn as shell UI like the top bar is. (SPEC 2.)

Consequences of living inside the shell:

- We draw with the shell's own toolkits: **Clutter** (the scene graph; everything on
  screen is an "actor") and **St** (shell widgets and CSS styling, built on Clutter).
- We type by creating a **virtual keyboard device** on mutter's input seat and sending
  it evdev key codes. To the rest of the system these look exactly like keys from real
  hardware, so shortcuts, modifiers, the input method and every app behave normally.
- Extension code runs with the shell's privileges, so mistakes can stick keys or freeze
  the desktop. A lot of the design below is about being defensive.

## 3. Module map

```
extension.js   lifecycle (enable/disable), show/hide, session state, wiring
view.js        the panel: draws keys, header, highlights; saves/restores position
input.js       the event filter: turns mouse clicks on the panel into actions
typer.js       the virtual keyboard: sends key press/release
indicator.js   the top-bar button
keys.js        PURE: modifier state machine + ledger of pressed keys
layout.js      PURE: layout validation, geometry, hit-testing, placement math
layouts/us.js  PURE: the 104-key US layout as plain data
```

"PURE" modules import nothing and know nothing about GNOME. They take plain data and
return plain data, so they are tested quickly with plain `gjs` (`make test`). The
shell-facing modules are kept thin so that nearly all the logic lives in the tested
pure modules. The one seam between "decide" and "do" is `typer.send(actions)`, where an
action is `{code, pressed}`.

A click flows like this:

```
mouse press -> input.js (filter) -> layout.hitTest() says which key
            -> keys.press() returns actions, e.g. [{shift down}, {p down}]
            -> typer.send(actions)         (keys really go down)
            -> view.sync(keys.snapshot())  (highlights update)
mouse release (seen as an event, or found by polling)
            -> keys.release() -> typer.send() -> view.sync()
```

## 4. How input works

This is the most delicate part. (SPEC 5.1, 5.3.)

### 4.1 One reactive panel, hit-testing in our own code

The panel is a single St widget marked *reactive* (it can be the target of the
pointer). Everything inside it (keys, header buttons) is *not* reactive. So whenever the
pointer is anywhere over the panel, the thing under it is "the panel", and **we work out
which key was hit ourselves** with plain arithmetic (`layout.hitTest`). This keeps the
logic testable and avoids per-key widgets fighting over events.

### 4.2 An event filter instead of normal click handlers

Normally you would give each button a click handler. We cannot, for two reasons:

- When a shell dialog, menu, switcher or app popup is open, GNOME has a **grab**: it
  sends all pointer events to that one thing, so ordinary widgets never hear about
  clicks elsewhere. Password dialogs are exactly this case.
- Clicking a normal button can close popups the user is typing into.

`Clutter.Event.add_filter` lets us look at input events before they are delivered, and
tells the system "I handled this" (`EVENT_STOP`) or "carry on" (`EVENT_PROPAGATE`).
Mutter's own filter runs first. Under any grab it lets pointer events through, so ours
sees them all; with no grab it hands events to the app window under the pointer, and ours
only sees events over shell actors such as our panel (see 4.3 for the consequence).
(Source references are in `input.js` comments and SPEC 5.3.)

What the filter does:

- Key events, enter/leave, touch and device hotplug: ignored (`PROPAGATE`).
- Button press over the panel: **consume it** (`STOP`) so the app, dialog or popup under
  it never sees the click (which is why clicking the keyboard does not close a popover or
  move focus). If no click is in progress, claim it and act on what was hit; if one is
  already in progress, swallow the press and do nothing.
- Button press elsewhere: let it through untouched.
- Release of the claimed button: ends the click and is consumed (`STOP`) wherever the
  pointer is. Any other release is let through.
- Motion: while a click is claimed, consumed over the panel and let through elsewhere;
  otherwise only the hover highlight is updated and the motion is let through.
- Scroll over the panel: consumed and ignored.

**Filter lifetime.** The filter is installed only while the panel is visible. When the
panel is hidden, removal is deferred until any claimed click has ended, so that click's
release is still consumed; showing the panel again cancels a pending removal. `disable()`
removes it at once. Every handler runs inside a try/catch: on an exception we log (never
key identities), release everything on the virtual keyboard, start from a fresh
state-machine state and return `STOP`.

Because we consume clicks, the normal button-clicked machinery is not triggered. We run
our own activation from the filter instead.

### 4.3 Claims and the lost release

On a press we **claim** that click: we remember which button (and device) started it and
what it hit (key, header drag, resize grip, close, nothing). Everything that follows is
decided from that claim, never by looking at where the pointer is when it is released.
This matters: a release we let through under a grab could close an app popover.

There is a catch. With **no grab active** (a normal app window below the pointer),
mutter delivers events straight to the app under the pointer. If you press a key on the
panel and slide off over an app window before releasing, our filter **never sees the
release**. If we waited for it, the key would stay held down forever.

So while a click is claimed we also **poll** the pointer every 100 ms (every 16 ms
during drags and resizes) using `global.get_pointer()`, which reports which mouse
buttons are down. When the claimed button is no longer down, we end the click ourselves.
Polling is the guaranteed release path; seeing the release event is just the fast path.
Polling starts the moment a click is claimed, whatever it hit, so no claim can get stuck.

One more wrinkle: `global.get_pointer()` can report the button as up slightly before the
release event itself reaches our filter. When polling ends a click, we therefore note
that its release is still owed, and consume it when it arrives (a fresh press of that
button cancels the note, and it expires after half a second). Otherwise that late
release would reach an app popover.

We do not use a stage grab or `Main.pushModal()` to see the release, because either
makes mutter drop keyboard focus from the app, breaking requirement 3.

### 4.4 Dragging and resizing

Both are driven by the polled pointer position. A drag moves the panel by how far the
pointer moved since the press; a resize changes the width and the height follows (keeping
the top-left corner fixed). When the click ends we clamp the panel inside the screen's
usable area and save the placement. We save only at the end, never on every movement.

## 5. Keys and modifiers (`keys.js`)

The state machine is pure and has one rule of thumb: **what a key does is decided by its
`role` in the layout data, not by hard-coded codes** (with a few documented exceptions).
(SPEC 6.)

- **Normal key, left click:** press on mouse down, release on mouse up. Holding the mouse
  button holds the key, so the system's own key repeat just works; we implement no
  repeat.
- **Right click on a normal key:** the same, with Shift added (`p` -> `P`, `8` -> `*`,
  Tab -> Shift+Tab). If a Shift is already on, we do not add another.
- **Shift / Ctrl / Alt: one-shot, double-click to lock.** A mouse cannot hold a key and
  click at once, so these latch. First click: "on", really held down. The next normal
  key uses it up: it is pressed, then released, then the one-shot modifiers are released
  (so apps see Ctrl down, G down, G up, Ctrl up). Several can be on together (Ctrl, Alt,
  then G releases both). A second click on an "on" modifier **locks** it: it stays held
  across keys and mouse clicks (Ctrl+click multi-select) until a third click turns it
  off. State is `mods` (what is held) plus `locked` (the subset that survives keys).
  Left and right click do the same. A VT-blocked key types nothing, so it uses nothing
  up.
- **Super is special: never physically held.** A held Super turns every click on a window
  into a window move in GNOME, and its "tap to open overview" only fires if nothing
  happens between press and release. So Super is a *visual* toggle. While it is on, the next
  normal key is sent as an atomic chord (Super down, key down, key up, Super up) and Super
  then turns itself off. Super never locks (a second click must turn it off, because that
  is how you ask for the tap). Turning it off without having typed a key sends a bare
  Super tap, on mouse *release*, because
  mutter cancels the tap if a button event arrives between the press and release.
- **Ctrl+Alt+F1..F12 is blocked.** Those switch to a text console, which would strand a
  mouse-only user. The block applies everywhere (even the lock screen). Num Lock and
  Scroll Lock sit numerically between F10 and F11, so the F-key list is explicit, not a
  range.
- **Lock keys.** Caps Lock, Num Lock and Scroll Lock are ordinary keys: press on mouse
  down, release on mouse up, no toggle state in `keys.js`. The panel's Caps/Num lamps and
  letter case come from the keymap's `caps-lock-state` / `num-lock-state` properties
  (via `notify::` signals), so they also follow a physical keyboard. Scroll Lock has no
  lamp because that state is not available.
- **The ledger.** `keys.js` records every code it believes is pressed. Releases only ever
  release what is in the ledger, and a double press is refused. This makes "release all"
  safe to call at any time.

## 6. Never leave a key stuck

A stuck modifier on a shared system is awful, so there are several layers
(SPEC 5.4, 6.6):

- Why so strict: key press counts are seat-wide and never reset, a stuck virtual key also
  blocks the same physical key, and a new virtual device cannot clear another device's
  stuck key. A leak is hard to recover from, so we never create one.
- Every press goes through the ledger in `keys.js`; `typer.js` keeps its own small list of
  what it pressed on the device as a safety net and drops duplicates and unmatched
  releases (mutter would otherwise log warnings).
- **Release-all** (release everything, turn every toggle off) runs when: the panel is
  hidden, the session mode changes (lock/unlock), the keymap reloads (that silently
  drops held modifiers from XKB's state), the extension is disabled, or any handler
  throws. The exception path calls `typer.releaseAll()` and starts from a fresh state
  machine, rather than `keys.releaseAll`, so it works even if `keys.js` state is corrupt.
  The screenshot-UI hide (section 9) is deliberately **not** a trigger.
- Release-all releases ordinary keys first, then modifiers, like a person lifting their
  fingers.
- On disable we release everything and then call `run_dispose()` on the virtual device so
  its presses do not linger until garbage collection.
- We never use `notify_keyval`: it silently adds Shift or a layout-switch key and does not
  track it, so it can leave one stuck. We send raw keycodes only.

## 7. Where the panel lives: stacking and fullscreen

(SPEC 5.2.)

- The panel is a child of `Main.uiGroup`, the shell's top-level UI container. It must be
  above everything, but several shell parts raise themselves without notifying anyone, so
  **once per frame** (`before-update` signal) we check whether we are the last child and
  raise ourselves if not. It is one comparison; the cost is negligible.
- Accepted cosmetic side effects: drag-and-drop icons, OSD popups and some transition
  snapshots draw under the panel.
- **Fullscreen apps:** normally mutter bypasses the compositor for a fullscreen window
  ("unredirect"), which would hide our panel. While the panel is visible we call
  `disable_unredirect()` and re-enable it when hidden, with a flag so the calls are
  balanced.

## 8. Sessions, the lock screen, the login screen and password prompts

(SPEC 5.5.)

GNOME Shell runs in different **session modes**: the normal user session, the lock
screen (`unlock-dialog`) and the login screen (`gdm`). An extension only runs in the modes
listed in its `metadata.json`.

- **Lock screen / login screen:** the extension declares `unlock-dialog` (and `gdm` in the
  system `.deb` flavour). We detect state with `Main.sessionMode.isLocked` /
  `isGreeter`, never by comparing the mode name (Ubuntu's mode is called `ubuntu`).
  The lock screen grabs `Main.uiGroup` and the login dialog grabs the whole stage; our
  panel is inside both, and our event filter still sees clicks under either grab, so
  typing a password works.
- **One function decides visibility: `syncSessionState()`.** Locked or greeter: show.
  Otherwise show only if the user last left it visible (the `visible` setting). It runs
  at the end of `enable()` and whenever the session mode changes. It must run from
  `enable()` because the login screen never emits a "mode changed" event after
  extensions load, and at lock time the shell may re-enable the extension after the mode
  already changed.
- **Enabling.** The package does not enable the extension for users; they run
  `gnome-extensions enable jeyboard@johnramsden.ca` themselves. For the **login screen** the
  `.deb` installs a keyfile (`/usr/share/gdm/dconf/95-jeyboard`) that Ubuntu's gdm3
  compiles into the greeter's defaults whenever gdm starts, listing the extension as
  enabled. It takes effect at the next boot (restarting gdm3 also works but ends running
  sessions). It is Ubuntu-specific: Ubuntu's greeter profile has no system database, so
  `/etc/dconf/db/gdm.d` is never read. Keyfiles merge in filename order, and a
  later-sorting keyfile from another package that also sets `enabled-extensions`
  overrides ours. Never rely on a session mode's `enabledExtensions`: `unlock-dialog`
  inherits an empty list.
- **Password and other shell dialogs (polkit, keyring, Wi-Fi/VPN secrets, mount
  passwords, Alt+F2):** these are "system modals". The layout manager announces them with
  the `system-modal-opened` signal, and we show the panel then, **without** changing the
  saved `visible` setting. The reason: while such a dialog is open the top-bar button
  cannot be clicked, so auto-showing is the only way a mouse-only user could get a
  keyboard there. It stays until the user hides it.
  - The screenshot UI also emits that signal. We deliberately ignore it, otherwise taking a
    screenshot would pop the keyboard up.
- **Hiding by the user** (top-bar button or the x) saves `visible` only in the normal user
  session. On the lock and login screens a hide is not saved and lasts only until the next
  session-mode change, when `syncSessionState()` forces the panel back on.

## 9. The screenshot UI

(SPEC 5.6.) The screenshot tool captures the screen first, so a visible panel would be in
the picture. We wrap `Main.screenshotUI.open()` (a private shell method, wrapped with
`InjectionManager`) to hide the panel while it runs, then restore visibility from the
extension's own state and raise the panel back above the screenshot UI, which `open()` put
on top. Two related details:

- The screenshot UI itself emits `system-modal-opened`, which would auto-show the panel
  (section 8). A flag set by the wrapper makes that handler ignore it.
- The hide is **cosmetic only**: it does not release keys, remove the filter, drop a claim
  or touch the saved setting. Clicking PrtSc on the panel opens the screenshot UI while the
  mouse button is still down, and that release must still be consumed and must still
  release code 99, so the claim has to survive.

If a future GNOME breaks the wrapper, the only cost is the keyboard showing up in
screenshots.

## 10. Window and position handling

(SPEC 8.)

- **Geometry in "u" units:** a key's size is 1u; the layout (`layouts/us.js`) is plain
  numbers in u. `layout.geometry()` turns a panel width into pixel rectangles
  (u = width / (layout width + padding)), so resizing is just recomputing from a new
  width. Hit-testing uses full cells (no gaps); drawing insets them slightly.
- **Persistence** (GSettings): which monitor (by connector name like `HDMI-1`, because
  monitor indexes change), the top-left as **fractions of that monitor's work area**, and
  the width as a fraction of the work-area width. Fractions survive resolution changes.
  Position is clamped to the work area after drags and when monitors change.
- **Size limits:** minimum key pitch 24 logical pixels; if the screen is smaller than that
  allows, the screen wins.
- **HiDPI:** St multiplies CSS pixels by the theme's scale factor, but our geometry is in
  stage pixels, so font sizes computed in code are divided by the scale factor. Where that
  factor is 1 (expected on many Wayland setups) the division does nothing.

## 11. Other principles

- **Public APIs first.** Anything private or monkey-patched is listed in SPEC 16 with a
  reason. Currently: `Main.uiGroup`, `Main.layoutManager`, `Main.sessionMode`,
  `Main.panel`, and the wrapped `Main.screenshotUI.open`.
- **Hard rules** (AGENTS.md): never take key focus, never `pushModal`, never open a
  `PopupMenu` (each steals focus); never `notify_keyval`; always release; never log key
  codes or typed content. Logs may record only state changes.
- **Clean shutdown:** every signal is connected with `connectObject` and removed with
  `disconnectObject`; every timer is tracked; `disable()` is synchronous and undoes
  everything. The extension has no side effects at import time and does no file I/O at
  runtime (the layout is a JS module, not a JSON file).
- **No speculative features.** SPEC 3.2 lists what is deliberately left out (auto-show on
  text focus, docked mode, other layouts, preferences window, ...).

## 12. Known limits

Documented in the README and SPEC 16. Highlights: focus-follows-mouse mode `mouse` is
unsupported; an active Input Capture portal (Input Leap, Deskflow) swallows events before
us; the top bar is hidden by fullscreen windows so a hidden panel cannot be re-shown
there; Sticky/Slow/Bounce Keys accessibility settings apply to our keys too; labels are US
only.

## 13. How it is tested

- `make test`: unit tests for the pure modules (state machine branches, ledger, layout
  validation, geometry, hit-testing, placement math, and a table that pins every one of
  the 104 keys to the spec).
- `make shell-test`: runs a real headless gnome-shell 50.1 with a virtual mouse and checks
  the keys that come out the other side, including the "release lost off the panel" case
  (by swallowing off-panel releases like mutter does over an app window).
- Manual checklist in SPEC 13.2 for everything a headless run cannot cover (lock screen,
  login screen, polkit, popovers, GNOME 51, multi-monitor).
