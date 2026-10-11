# jeyboard — implementation specification

Status: ready for implementation (v1), revision 2 after source-level review. Date: 2026-10-04. Owner: John Ramsden.

This document is self-contained. It defines what to build, how it must behave, the platform facts the design relies on (with upstream references), what is still unverified and must be spiked first, and how to test and package it. MUST means required; SHOULD is a strong default; MAY is optional. Read `../AGENTS.md` for working rules (simplicity, testing, comments, commit conventions).

## 1. Goal

jeyboard is an on-screen keyboard (OSK) for GNOME Shell on Wayland, built as a GNOME Shell extension. Its user drives it with a mouse (accessibility use), not touch.

Hard requirements:

1. **Real modifiers.** Ctrl/Alt/Super/Shift combinations must behave exactly like a hardware keyboard: Ctrl+C, Ctrl+Shift+T, Alt+F4, Super, Super+A, Shift+arrows, and modifier+mouse-click (Ctrl+click, Shift+click) in native Wayland apps, XWayland apps, terminals and GNOME Shell's own text entries.
2. **Usable everywhere.** The keyboard must be visible, clickable and able to type in every GNOME surface: normal and fullscreen app windows, the overview and its search, GNOME Shell's own password dialogs (polkit authentication, keyring unlock, Wi-Fi/VPN secrets, mount passwords), the lock screen, the GDM login screen, shell menus, app pop-ups (GTK popovers, browser menus), the Alt+Tab switcher and the screenshot UI.
3. **Never steal focus.** Clicking the keyboard must never move keyboard focus away from whatever is being typed into.
4. **Floating window.** It pops out as a floating keyboard the user can drag anywhere, on any monitor, and resize.
5. **Simplicity.** As easy as possible to understand, with the smallest possible surface for breakage: public APIs over private GNOME internals, one code path over per-version paths, manual control over automatic heuristics.

Targets: GNOME 50 first (Ubuntu 26.04 LTS ships gnome-shell and mutter 50.1 and gdm3 50.1; this is the owner's daily driver), then GNOME 51 (51.0 released 2026-09-14). Wayland only (GNOME 50 has no X11 session). Distribution: primarily a `.deb` (system-wide install), secondarily extensions.gnome.org (EGO). The code must follow EGO review rules even though the `.deb` is primary.

Fresh codebase. GJS OSK (https://github.com/Vishram1123/gjs-osk) and Touch Board (https://github.com/d3z-the-dev/touch-board) are GPL-3 references for ideas only; do not copy code from them. License: MIT.

Identifiers: UUID `jeyboard@johnramsden.ca`; GSettings schema id `org.gnome.shell.extensions.jeyboard`, path `/org/gnome/shell/extensions/jeyboard/`.

## 2. Why this architecture (decided; do not revisit)

- An out-of-process OSK (any standalone app, including one that injects keys through `/dev/uinput`) cannot meet requirement 2 on GNOME. Mutter implements no layer-shell, virtual-keyboard or input-method protocol, and its maintainers declined them (https://gitlab.gnome.org/GNOME/mutter/-/issues/1974, https://gitlab.gnome.org/GNOME/gnome-shell/-/issues/1141). App windows sit below shell modal dialogs, are hidden on the lock screen, in the overview and in GDM, and receive no pointer input while the shell holds a grab. Native Wayland toplevels take focus on click. RemoteDesktop/libei sessions are torn down on lock.
- GNOME's built-in OSK cannot meet requirement 1. Ctrl/Alt appear only in four "-extended" layouts shown for terminal-purpose fields, as one-shot latches around a single text commit. Tab/arrows/Enter ignore them (https://gitlab.gnome.org/GNOME/gnome-shell/-/issues/9397). There is no Super/Esc/F-keys, and nothing is ever held. Upstream declined general modifiers (https://gitlab.gnome.org/GNOME/gnome-shell/-/issues/181).
- Therefore: an extension running inside gnome-shell, drawing the keyboard as shell UI and injecting keys through a Clutter virtual keyboard.
- uinput is not needed on GNOME. The Clutter virtual keyboard enters the same seat input path as hardware (`meta_seat_impl_notify_key_in_impl`) and needs no root. uinput is kept only as a possible later fallback backend (section 14).

## 3. Scope

### 3.1 v1 (build this)

- One floating keyboard panel, drawn inside GNOME Shell, draggable and resizable, remembering its monitor, position and size (one saved placement; section 8).
- One layout: full-size US English ANSI (104 keys), defined in `layouts/us.js` (section 7).
- One-shot modifiers that lock on a double click, right-click-for-Shift on every other key, and key repeat by holding (section 6).
- One input path for GNOME 50 and 51: a Clutter event filter (section 5.3), subject to spike S2.
- A top-bar button to show and hide the panel. The panel is shown automatically on the lock screen, on the GDM login screen, and when a shell modal dialog (password prompt) opens (section 5.5).
- Visible over fullscreen apps.
- Two artifacts from one tree: an EGO zip and a `.deb` (section 11).

### 3.2 Not in v1 (do not build unless asked)

- Suppressing GNOME's built-in OSK. Document instead: keep Settings → Accessibility → Screen Keyboard off.
- Auto-show on text focus.
- Docked mode that reserves screen space (struts).
- Caret avoidance.
- Emoji, accents, text commit and prediction.
- A preferences window.
- Other layouts and sizes, and a label generator.
- uinput.
- Plasma.
- A pointer-lock escape (section 14).
- The gnome-initial-setup first-boot session (mode `initial-setup`, used only when no user account exists, e.g. OEM installs). The extension does not load there; document this in the README.

## 4. Repository layout

```
jeyboard/
  AGENTS.md               working rules for agents (simplicity, testing, comments, commits)
  LICENSE                 MIT license text
  docs/SPEC.md            this file
  docs/DESIGN.md          high-level design: how and why, for newcomers
  README.md               user-facing install/use notes and documented limitations
  Makefile                all (no-op, first target), test, shell-test, zip (EGO), install (system), clean
  tests/shell/smoke.js    headless gnome-shell smoke test (make shell-test)
  .github/workflows/ci.yml  CI: make test, package build, make shell-test
  extension/
    metadata.json         see 11.1; `make install FLAVOR=system` rewrites session-modes
    extension.js          enable()/disable(): wires everything, owns lifecycle and session sync
    keys.js               PURE: modifier state machine + pressed-key ledger
    layout.js             PURE: validate layout data, geometry, hit-testing
    view.js               St panel: draws keys, header (drag area, resize grip, hide button), highlights
    input.js              the Clutter event filter: claims sequences, polls the pointer, dispatches to keys.js
    typer.js              Clutter virtual keyboard: send [{code, pressed}] actions; release-all; dispose
    indicator.js          top-bar button (show/hide)
    stylesheet.css
    schemas/org.gnome.shell.extensions.jeyboard.gschema.xml
    layouts/us.js         PURE data module: `export default {…}` (no file IO needed at runtime)
  tests/
    run.js                tiny dependency-free test runner for plain gjs (`gjs -m tests/run.js`)
    keys.test.js
    layout.test.js
  debian/                 native .deb packaging (11.3)
  data/gdm/95-jeyboard    greeter enablement keyfile (system flavour, 11.3)
  scripts/push-to-vm.sh   dev helper (section 12)
```

### 4.1 The pure core

`keys.js`, `layout.js` and `layouts/us.js` MUST NOT import anything: no `gi://`, no `resource:///`, no GLib. They take plain data in and return plain data out. This makes the riskiest logic (modifier toggles, right-click Shift, release-all) testable in seconds with plain `gjs`, and portable to a possible later Plasma front-end.

They MUST be written in ES2016-compatible JavaScript, so that Qt's QML engine (ES2016) could load them later:
- no class fields;
- no `#private` members;
- no static blocks.

ES modules (`import`/`export`) are fine.

The layout is a JS module rather than a JSON file. This avoids runtime file IO entirely; EGO flags synchronous file reads in shell code.

`typer.send(actions)` is the only backend seam. Do not add any other abstraction layers (no injected schedulers, loggers or settings) until a second front-end actually exists.

### 4.2 Data flow

```js
// input.js, inside the event filter, on a button press over the panel
const hit = layout.hitTest(geometry, lx, ly);        // {type:'key', key} | {type:'close'} | {type:'grip'} | {type:'header'} | {type:'none'}
const actions = keys.press(state, hit.key, button);  // e.g. right-click on P:
// [{code: 42, pressed: true}, {code: 25, pressed: true}]
typer.send(actions);
view.sync(keys.snapshot(state));                     // highlights: pressed keys, modifiers that are on
// ...later, when the claimed button is released (seen as an event, or found by polling):
typer.send(keys.release(state, button));             // [{code: 25, pressed: false}, {code: 42, pressed: false}]
view.sync(keys.snapshot(state));
```

## 5. GNOME integration

### 5.1 The panel actor

- **One reactive actor.** A single reactive `St.Widget` (the panel) contains non-reactive children: the header (drag area, resize grip, hide button) and the key widgets.
  - The panel MUST be `reactive: true`, so picking returns it and the event filter receives it as the target actor. When no grab is active, mutter returns PROPAGATE for pointer events over a reactive shell actor, so presses reach the filter.
  - Children are non-reactive so the pick always returns the panel. Hit-testing is done by `layout.js`.
- **Focus.** Everything has `can_focus: false`. The extension MUST NEVER call `grab_key_focus()`, `Main.pushModal()`, `global.stage.grab()`, or open any `PopupMenu` (menu items grab key focus on hover). Any of these moves keyboard focus away from the target app; any stage grab makes mutter drop Wayland keyboard focus.
- **Coordinates.** Position and size are in stage coordinates (logical pixels). Convert a stage point to panel-local coordinates with `panel.transform_stage_point(x, y)`, which returns `[ok, lx, ly]`.
- **HiDPI.** St CSS px are already scaled. For any px computed in JS, use `St.ThemeContext.get_for_stage(global.stage).scale_factor` and listen to its `notify::scale-factor`.
- **Focus-follows-mouse.** With `org.gnome.desktop.wm.preferences focus-mode` set to `'mouse'`, mutter unsets window focus when the pointer enters a non-window actor such as the panel (src/core/display.c, focus_mouse_mode). v1 supports `'click'` (default) and `'sloppy'`; document `'mouse'` as unsupported in the README.

### 5.2 Stacking

- Add the panel with `Main.uiGroup.add_child(panel)`, not `addChrome`/`addTopChrome`. Do not pass `affectsInputRegion`; it throws on GNOME 50+.
- **Keep it on top with one cheap check per frame:**

  ```js
  global.stage.connectObject('before-update', () => {
      if (Main.uiGroup.get_last_child() !== panel)
          Main.uiGroup.set_child_above_sibling(panel, null);
  }, this);
  ```

  - `child-added` alone is not enough. Several shell actors raise themselves with `set_child_above_sibling` without being re-added: `PopupMenu.open()` (top-bar menus, quick settings), `ScreenshotUI.open()`, `OsdWindow.show()`, `ScreenTransition.run()` and the screen-shield fade.
  - MetaLaters BEFORE_REDRAW callbacks run from this same signal, so the timing matches a later without needing a trigger.
  - Disconnect via `disconnectObject(this)` in disable().
- **Accepted cosmetic side effects:** the drag-and-drop icon, OSD windows, the screen-transition snapshot and the screen-shield fade are drawn under the panel.
- **Fullscreen.** While the panel is visible, hold `global.compositor.disable_unredirect()`, balanced by `enable_unredirect()` on hide and disable. Otherwise the panel is invisible over unredirected fullscreen apps.

### 5.3 Input: one Clutter event filter (primary design; must pass spike S2)

Facts this relies on (read from source at mutter 50.1 and 51.0; not yet run):

- `Clutter.Event.add_filter(stage, func)` is public, introspected API. Filters run in `clutter_stage_handle_event` after picking and before Clutter delivers the event or applies any grab, and a filter returning `Clutter.EVENT_STOP` means the event is never delivered (https://github.com/GNOME/mutter/blob/50.1/clutter/clutter/clutter-main.c#L198-L229, https://github.com/GNOME/mutter/blob/51.0/clutter/clutter/clutter-main.c#L177-L208). The docs say filters "take precedence over any grabs" (https://github.com/GNOME/mutter/blob/51.0/clutter/clutter/clutter-event.c#L1244-L1283).
- Mutter's own filter is registered first (with a null stage) and always runs before ours.
  - **Under any stage grab** (a shell modal dialog, menu, switcher, or a Wayland xdg_popup's input-only grab), it returns PROPAGATE for pointer events, so our filter sees every pointer event (https://github.com/GNOME/mutter/blob/51.0/src/core/events.c#L297-L298).
  - **With no grab**, it delivers events to the Wayland surface under the pointer and returns STOP whenever there is a focus surface (https://github.com/GNOME/mutter/blob/51.0/src/wayland/meta-wayland-pointer.c#L974-L993). Over the reactive panel there is no surface, so we see presses, motion and releases there. A press over the panel leaves no Wayland implicit-grab surface, and a press our filter consumes sets up no Clutter implicit grab either. So once the pointer leaves the panel over an app window, our filter sees **no more MOTION and no BUTTON_RELEASE** for that sequence. The app under the pointer receives pointer enter/motion and an unmatched button release, which is harmless.
- The filter receives the picked actor. Picking ignores grabs, so a click over the panel targets the panel even while a dialog, menu or popover holds a grab.
- Mutter dismisses an app popover only when a button release reaches its input-only grab (https://github.com/GNOME/mutter/blob/50.1/src/wayland/meta-wayland-popup.c#L148-L176). Consuming the press and the release over the panel therefore keeps popovers open. The overview's search-reset gesture, menus' outside-click handlers and the switcher's outside-click handler never see our clicks either, so no shell patches are needed.

Behaviour:

- **Installing.** `this._filterId = Clutter.Event.add_filter(null, (event, actor) => this._onEvent(event, actor));`. Use a null stage, as mutter does; there is only one stage. A non-null stage makes Clutter call `clutter_actor_get_stage()` on a null actor for device hotplug events and log a critical. The callback must return `Clutter.EVENT_STOP` or `Clutter.EVENT_PROPAGATE`. `actor` is null for DEVICE_ADDED/DEVICE_REMOVED, so return PROPAGATE for any unhandled event type before touching `actor`.
- **Lifetime.** The filter is installed while the panel is visible, in every session mode. Removal (`Clutter.Event.remove_filter(id)`) waits until no sequence is claimed (see Hiding); `disable()` removes it at once.
- **Key events** (`KEY_PRESS`/`KEY_RELEASE`): return PROPAGATE immediately. Never inspect them.
- **`ENTER`/`LEAVE`:** never STOP.
- **`BUTTON_PRESS`:**
  - If the target actor is the panel or inside it, consume it (STOP).
  - If no sequence is claimed, claim it (device + button), hit-test, and dispatch:
    - key: `keys.press`;
    - header: start a drag (button 1 only);
    - grip: start a resize (button 1 only);
    - close: arm the hide;
    - none: nothing.
  - If another sequence is already claimed, consume the press but dispatch nothing.
  - Presses not over the panel: PROPAGATE.
- **`BUTTON_RELEASE`:** if it belongs to the claimed sequence, end the sequence (below) and return STOP, wherever the pointer is. Decide from the press-time claim, never by hit-testing the release; a release let through under a grab would close an app popover. Seeing the release is not guaranteed (no-grab case above).
- **Polling: the guaranteed path.** While a sequence is claimed, poll `global.get_pointer()`, which returns `[x, y, mods]` with button mask bits in `mods`: every 16 ms during a drag or resize, and every 100 ms during a key hold. Drag and resize are driven from the polled position; MOTION events seen over the panel MAY also update them, and are returned STOP. When the claimed button's mask bit clears, end the sequence. This is not just a watchdog; it is the normal release path when no grab is active and the pointer has left the panel. `get_pointer()` can report the button up before the BUTTON_RELEASE event reaches the filter, so a sequence ended by polling records a pending `{button, device}` release; the next matching BUTTON_RELEASE is returned STOP (a new press of that button clears the record, and a record expires after 500 ms so a truly lost release cannot swallow an unrelated app release later; a hide deferred by a claim keeps the filter until the owed release arrives or expires). Extra buttons pressed during a claim are STOPped and recorded the same way.
- **Ending a sequence:**
  - key: `typer.send(keys.release(state, button))`;
  - drag/resize: clamp, then save geometry;
  - close: hide, if the release (or last polled position) is over ×.

  Then drop the claim and stop polling.
- **`MOTION`** with no claimed sequence: update hover highlighting if over the panel, and PROPAGATE.
- **Scroll** over the panel: STOP (ignore). `TOUCH_*` events MAY be handled like button 1; otherwise PROPAGATE.
- **Do not fix the no-grab release gap with `global.stage.grab()`.** Any stage grab makes mutter treat windows as non-interactable and drop Wayland keyboard focus (src/core/display.c, meta_display_windows_are_interactable), breaking requirement 3.
- **Activation.** Keys are activated by this filter's own dispatch, never by `St.Button` `clicked`. St.Button is gesture-driven since GNOME 49, and gestures are not triggered for events a filter consumes.
- **Hiding.** Hiding for any reason runs release-all immediately (6.6), but the filter stays installed until the claimed sequence (if any) has ended. Only then is it removed, so that sequence's release is still consumed. `disable()` removes it at once. `keys.releaseAll` clears keys.js's claim, so the later release produces no actions; input.js keeps its own sequence claim, so the event is still consumed.
- **Errors.** Every dispatch is wrapped in try/catch. On any exception:
  1. Log the error, never key identities.
  2. Run `typer.releaseAll(); state = keys.createState();`.
  3. Return STOP for that event.
- **EGO note.** Reviewers may object to a global filter that stays installed on the lock screen. The `.deb` is primary, so accept the risk. If EGO rejects it, the EGO flavour can default to the fallback route (5.7).

### 5.4 Key injection (`typer.js`)

- **The device.** Create one device in `enable()`: `global.stage.context.get_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE)`. Do NOT use `Clutter.get_default_backend()`; it was removed in GNOME 51 (https://gitlab.gnome.org/GNOME/mutter/-/merge_requests/4981).
- **Sending keys.** Use `device.notify_key(Clutter.CURRENT_TIME, evdevCode, state)`, where state is `Clutter.KeyState.PRESSED` or `Clutter.KeyState.RELEASED`. Pass one or the other, never ORed: RELEASED is 0, so `PRESSED | RELEASED` is a press.
  - The time argument is in microseconds. `CURRENT_TIME` (0) makes mutter stamp the event with `g_get_monotonic_time()` in its input thread, so actions carry no time and every path uses the same clock.
  - Codes are Linux evdev `KEY_*` values; mutter adds the +8 XKB offset itself.
- NEVER use `notify_keyval`. It only finds keysyms in the current layout group, silently adds Shift_L or ISO_Level3_Shift, and does not track the Shift it added, so it can be left stuck.
- **Two ledgers, one authority.** The ledger of pressed codes lives in `keys.js` and is authoritative. `typer.js` keeps only a list of the codes it has pressed on the device, as a safety net, not a second state machine. It drops a duplicate press or an unmatched release before calling `notify_key` (mutter would otherwise drop them with a g_warning). `typer.releaseAll()` releases that list, non-modifiers first, then modifiers.
- **On `disable()`:** release-all (6.6), then `device.run_dispose()`, with a comment, because EGO flags every `run_dispose()` call:

  ```js
  // run_dispose: unregister the virtual keyboard now. Otherwise it lives until GC
  // with its seat press counts, which can leave keys held (SPEC.md 5.4).
  ```

- **Why this works** (verified in source): virtual-device keys take the hardware path.
  1. The seat-wide XKB state.
  2. The IBus input-method filter.
  3. Mutter and shell keybindings (Super, Alt+Tab, Alt+F4, Super+A).
  4. The Wayland/XWayland focus, or the shell's key focus.

  Held modifiers also apply to physical keys and to mouse clicks, because pointer events carry the seat's effective XKB modifiers (https://github.com/GNOME/mutter/blob/51.0/src/backends/native/meta-seat-impl.c#L1112-L1114). Server-side repeat runs for virtual devices too.

Hazards to handle:

- **Seat-wide state.** Modifier state and the press counter are seat-wide, and the counter never resets. A stuck virtual key also blocks the same physical key. A new device cannot clear it, because its per-device count rejects a stray release. Hence the strict ledger and the release-all triggers (6.6).
- **Keymap reload.** A reload creates a fresh XKB state that silently drops held modifiers while the counters still think they are down. On `global.backend` `keymap-changed`: release-all.
- **System accessibility filters.** Sticky, Slow and Bounce Keys apply to virtual devices too. With Sticky Keys on, GNOME also ignores the bare Super tap. With "Enable by keyboard" on (`org.gnome.desktop.a11y.keyboard enable`, off by default), two more things happen:
  - a Shift left on for 8 s without another key toggles Slow Keys;
  - five Shift presses within 15 s toggle Sticky Keys.

  v1 does not detect any of this; document it in the README.
- **Action modes.** Shell keybindings are filtered by `Main.actionMode`, so Super does nothing on the lock screen. This is correct behaviour.

### 5.5 Session modes and auto-show

- **Metadata `session-modes`.**
  - EGO flavour: `["user", "unlock-dialog"]`.
  - System flavour: `["user", "unlock-dialog", "gdm"]`.

  EGO allows only `user` and `unlock-dialog`.
- **Detecting state.** Use `Main.sessionMode.isLocked` and `Main.sessionMode.isGreeter`. Never compare the mode name: Ubuntu runs mode `ubuntu`, whose parentMode is `user`.
- **One function, `syncSessionState()`.** It shows the panel if `isLocked || isGreeter`; otherwise it shows the panel only if the `visible` setting is true. It MUST be called at the end of `enable()`, and from the `Main.sessionMode` `updated` handler, after release-all. Why `enable()` must apply the state itself:
  - in the GDM greeter, the shell starts in mode `gdm` and never emits `updated` after extensions are enabled;
  - at lock, when another extension is disabled, the shell disables and re-enables jeyboard ("rebase") after the mode has already become `unlock-dialog`, so the fresh handler misses that `updated`.
- **Password dialogs.** On `Main.layoutManager` `system-modal-opened` (emitted when a shell modal dialog opens: polkit, keyring, Wi-Fi/VPN, mount, Alt+F2, end-session), show the panel without changing `visible`. Password surfaces always get the keyboard. While a modal dialog is open, the top-bar button cannot be clicked, so this is the only way to get the keyboard there. The panel stays shown until the user hides it. The screenshot UI also emits this signal and is excluded (5.6).
- **The `visible` setting** reflects only the user-session choice, made with the top-bar button or the × button.
- **Why input works there.**
  - The screen shield and unlock dialog grab `Main.uiGroup` (https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/50.5/js/ui/unlockDialog.js#L955), and the GDM login dialog grabs the whole stage. The panel is inside both.
  - Polkit and network-secret dialogs can also appear over the lock screen (network since 50.1, https://gitlab.gnome.org/GNOME/gnome-shell/-/merge_requests/4160); the filter covers those.
- **The `disable()` comment.** `disable()` MUST contain a comment justifying `unlock-dialog` (an EGO requirement), for example: "unlock-dialog: the on-screen keyboard is needed to type the password on the lock screen; it never reads key events."
- **Enabling.** Users enable the extension themselves (`gnome-extensions enable jeyboard@johnramsden.ca`, which writes `org.gnome.shell enabled-extensions`). The greeter is enabled by the greeter keyfile (11.3). Never rely on a session-mode JSON's `enabledExtensions`: `unlock-dialog` inherits an empty list, so such extensions are disabled at lock.

### 5.6 Other surfaces

- **Alt+Tab and Ctrl+Alt+Tab.** Alt on is a real hold. One-shot Alt then Tab switches to the previous window (Alt is released after Tab, which finishes the switcher). To browse, lock Alt (click it twice): the switcher stays open while you click Tab/arrows, and a third click on Alt finishes it. Ctrl+Alt+Tab works the same with Ctrl and Alt.
  - The user can click switcher items directly, or click Tab/arrows/Esc on the keyboard (needs S2).
  - The switcher finishes as soon as its binding modifier is released (51.0 switcherPopup.js#L232-L244; 50.x `vfunc_key_release_event`), or immediately if that modifier is already up when it opens (https://github.com/GNOME/gnome-shell/blob/51.0/js/ui/switcherPopup.js#L158-L163). So Alt on → Tab → Alt off switches to the previous window. Ctrl+Alt+Tab works the same with Ctrl and Alt on.
- **Super-based switchers** (Super+Tab, Super+`, Super+Space for input sources) are one-shot: Super is never held (6.3), so each chord selects the next item and the popup closes at once. To browse windows, use Alt+Tab with Alt locked.
- **Screenshot UI.** It is fully usable by pointer.
  - `ScreenshotUI.open()` is async. After capturing the frozen frame, it raises `Main.layoutManager.screenshotUIGroup` to the top of `Main.uiGroup` (no `child-added`), and its full-screen reactive actor covers the panel until the per-frame check (5.2) raises the panel again.
  - So the panel does not appear in the screenshot, wrap `open()` (private, via `InjectionManager`):

    ```js
    this._injections.overrideMethod(Main.screenshotUI, 'open', orig => async function (...args) {
        panel.visible = false;   // cosmetic hide only, so the panel is not in the capture
        try {
            return await orig.call(this, ...args);
        } finally {
            panel.visible = true;
            Main.uiGroup.set_child_above_sibling(panel, null);
        }
    });
    ```

  - `ScreenshotUI.open()` itself emits `system-modal-opened` (gnome-shell 50.1 screenshot.js); the wrap sets a flag so the password-dialog auto-show (5.5) ignores that emission, and `finally` restores visibility from the extension's own shown state (not a value captured before the await), skipping everything if `disable()` ran meanwhile.
  - This hide is cosmetic only and MUST NOT use the user-hide path: no release-all, the filter stays installed and its claim is kept, and unredirect and `visible` are untouched. `open()` is usually triggered by the Print keybinding (fires on key press) while the mouse button that pressed PrtSc is still down; that release must still be consumed and must release code 99.
  - If the wrap breaks in a future GNOME, the only cost is the keyboard appearing in screenshots.
- **Area-select and colour-picker overlays** (used by apps) are pointer-driven; Esc from the keyboard works if S2 passes.
- **Screen recordings.** The keyboard cannot be excluded from them; there is no per-actor capture exclusion.
- **Overview search.** Works, because consumed clicks never reach the search-reset gesture. S2 must verify this.

### 5.7 Fallback if spike S2 fails (implement only the parts that fail)

- **GNOME 51:**
  - Parent the panel under `global.compositor.get_input_panel_group()` instead of `Main.uiGroup`. The group is a 0x0, non-reactive actor at (0,0) with no layout manager; children position themselves in stage coordinates.
  - Mutter treats it as "grab chrome": pointer events whose target is inside it bypass any grab (https://gitlab.gnome.org/GNOME/mutter/-/merge_requests/5171, https://gitlab.gnome.org/GNOME/gnome-shell/-/merge_requests/4283). Handle raw events on the panel.
  - Keep pick-blocking overlays below the group. On `Main.uiGroup` `child-added`, move each `SwitcherPopup`, `SelectArea` and `PickPixel` below it with `Main.uiGroup.set_child_below_sibling(child, global.compositor.get_input_panel_group())`. After every awaited `ScreenshotUI.open()`, do the same for `Main.layoutManager.screenshotUIGroup`.
  - Shell menus raised by `PopupMenu.open()` still draw above the panel where they overlap; accepted.
  - Treat a LEAVE event with `Clutter.EventFlags.FLAG_GRAB_NOTIFY` as cancelling the owned press.
- **GNOME 50:**
  - Override `KeyboardManager.prototype.maybeHandleEvent` with `InjectionManager.overrideMethod`.
    - ModalDialog, UnlockDialog and LookingGlass return STOP from `vfunc_captured_event` when it returns true (https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/50.5/js/ui/modalDialog.js#L120-L125).
    - GrabHelper calls it but ignores the result (https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/50.5/js/ui/grabHelper.js#L158-L179).
    - In the override, when the event's actor is inside the panel, dispatch it to input.js directly and return true. Return false for key events.
  - Do NOT override `ModalDialog.prototype.vfunc_captured_event`: subclasses already initialised keep a copy of the class struct.
  - Use raw `button-press-event`/`button-release-event` signals for the no-grab case.
  - For app popovers, add hover-to-type (dwell): poll `global.get_pointer()` about every 50 ms and type a key after the pointer rests on it for a configurable time. No button events are generated, so popovers never close (verified in source).
  - Known remaining gaps on this route: shell menus, app folders, the screenshot UI and its area-select and colour-picker overlays close on a panel click (all use GrabHelper); keyboard control of the switcher.

## 6. Keyboard behaviour (`keys.js`)

Modifier behaviour is decided by each layout entry's `role` (7.2), never by code. The only codes `keys.js` hard-codes are LEFTSHIFT 42 (for right-click Shift), LEFTMETA 125 (for Super chords and taps), RIGHTMETA 126 (so `snapshot()` lights both Super keys), plus the F-key list for the VT block (6.3).

### 6.1 Normal keys, left button

- Button down → press the key's code; button up → release it. This "physical mirror" model makes system key repeat, Slow Keys and Bounce Keys behave as on hardware. Holding the button repeats the key.
- Moving off a key while holding does not cancel it; the release still releases the same key.
- If Super is on (see 6.3), the key is sent as a chord: down → press 125, press the key; up → release the key, release 125.

### 6.2 Normal keys, right button = with Shift

- **Mechanics.** Button down: if no `shift`-role key is on, press LEFTSHIFT (42), then press the key. Button up: release the key, then release LEFTSHIFT if this click pressed it.
- **Examples.** Right-click `p` → `P`; `8` → `*`; an arrow → Shift+arrow (selection); Tab → Shift+Tab; F10 → Shift+F10.
- **With modifiers on.** Combines with modifiers that are on: right-click `t` with Ctrl on → Ctrl+Shift+T.
- **Repeat.** Holding the right button repeats the shifted key.
- **Caps Lock** behaves as on hardware: Shift+letter with Caps Lock on types lowercase, because the XKB ALPHABETIC type has no Shift+Lock entry.
- **With Super on.** Down → press 125, press 42 (if needed), press the key; up → release in reverse.
- **Other buttons.** Middle button (2) and any other button: `keys.press` returns `[]`.

### 6.3 Modifier keys: one-shot, double-click to lock

Roles in v1 (US layout):
- `shift`: 42 and 54;
- `ctrl`: 29 and 97;
- `alt`: 56 and 100 (on the US layout Right Alt is a plain Alt_R, not AltGr);
- `super`: 125 and 126.

**Shift, Ctrl, Alt.**
- Each key has three states and changes state independently, on button down, with the left or right button (the same action):
  - **Off -> on (one-shot):** the code is pressed and stays held, and the key is highlighted.
  - **On -> locked** (a second click): nothing is sent; it stays held and is highlighted differently (`locked`).
  - **Locked -> off** (a third click): the code is released.
- A normal key uses up every one-shot modifier that is on (locked ones are untouched): the key is pressed and released as usual, and then the one-shot modifiers are released, newest first, on the same button release. So the application sees Ctrl down, G down, G up, Ctrl up.
- Several modifiers can be on at once. Clicking another modifier leaves the others as they are. Examples: Ctrl+G = click Ctrl, click G. Ctrl+Alt+G = click Ctrl, click Alt, click G (both released after G). Ctrl+Shift+T held for several keys = lock both (click each twice), type, then click each once more to turn them off.
- A key blocked by the VT block (below) types nothing, so it does not use up the one-shot modifiers.
- While a modifier is on or locked, modifier+mouse actions in apps work (Ctrl+click, Shift+click, Ctrl-drag, Ctrl+scroll), because the key is really held. Only a normal key uses a one-shot modifier up (mouse clicks in apps do not), so lock it to keep it for several keys.
- Right click on a normal key adds Shift for that click only (6.2) and combines with these states.

**Super: one shared toggle, never physically held.**
- Why: a held Super turns clicks on windows into window moves (it is GNOME's mouse-button modifier), and its overview tap only fires if nothing else happens between press and release.
- The two Super keys share one logical toggle. Clicking either turns it on or off, and both are highlighted while it is on. Super does not lock: it is one-shot, because a Super tap is the main use and a second click must turn it off (the tap).
- Super on is a visual state only; nothing is pressed.
- Each normal key clicked while Super is on is sent as an atomic chord with 125 (6.1). Toggling another modifier while Super is on does not count as a chord.
- Turning Super off when no chord was sent emits a bare tap (press 125, release 125) on that click's button release. It is emitted on release because mutter cancels the overview tap if a button event arrives between the Super press and release, and mutter's filter sees button events before ours.
- GNOME opens the overview only if no other modifier is held when Super is pressed (Caps Lock and Num Lock are ignored) and Sticky Keys is off. With Ctrl, Shift or Alt on, the tap is still sent, as on hardware, but does nothing.
- A chord uses Super up: after the key's release Super turns itself off (no tap), like the other one-shot modifiers, so "off after a chord" never needs a tap.

**VT block.**
- A key with code 59–68 (F1–F10), 87 (F11) or 88 (F12) is blocked when at least one `ctrl` key and at least one `alt` key are on. Use this explicit list, not a numeric range: 69 and 70 are Num Lock and Scroll Lock, which are never blocked.
- The block applies in every session mode. Mutter's switch-to-session-1..12 bindings (`<Primary><Alt>F1..F12`) switch virtual terminals for virtual-device events too, and gnome-shell allows them in all action modes, including the lock screen and GDM. Switching to a text console strands a mouse-only user.
- A blocked press creates a claim with no actions (press and release both return `[]`) and sets `blocked` for the view to flash.

**Lock keys.**
- Caps Lock (58), Num Lock (69) and Scroll Lock (70) are normal keys: press on down, release on up, with no toggle state in `keys.js`.
- The view shows Caps and Num state from `seat.get_keymap()` boolean properties `caps-lock-state` / `num-lock-state` and their `notify::` signals. Scroll Lock state is not available, so it has no indicator.

### 6.4 Repeat

There is no repeat logic in jeyboard. Holding a button holds the key; mutter's server-side repeat and Wayland clients repeat it per the user's keyboard repeat settings. S1 verifies repeat in a shell `St.Entry` as well as in apps.

### 6.5 What the state machine exposes

```js
// keys.js (pure, ES2016)
export function createState()
// modifiers that are on, the subset of those that are locked, ledger of pressed codes (in press order),
// the single active claim (button + codes it pressed + one-shot modifiers it will use up + pending Super tap), blocked
export function press(state, key, button)
// button 1 or 3; anything else -> []. key is a layout entry {code, role?}.
// Returns [] and records nothing if a claim is already active.
export function release(state, button)
// releases exactly what the active claim pressed and is still held, in reverse order,
// then the one-shot modifiers the key used up (locked ones stay), plus a pending bare Super tap; [] if there is no claim (e.g. after releaseAll)
export function releaseAll(state)
// releases every held code (non-modifiers first, then modifiers, each in reverse press order);
// turns every modifier and lock off including Super; clears the claim, any pending tap and blocked
export function snapshot(state)
// -> {on: Set(codes highlighted as on), locked: Set(subset of on that is locked), pressed: Set(codes held), blocked: code|null}
```

- Only one claim exists at a time, matching input.js's single claimed sequence.
- `blocked` is set by a VT-blocked press and cleared by the next press, release or releaseAll. `view.js` owns the flash timer.
- A modifier click creates a claim with no release actions, except the Super-off case, whose release emits the bare tap. A normal key's claim also remembers which one-shot modifiers (and Super) it used, and releases them after the key.

### 6.6 Release-all triggers (MUST)

Each trigger runs `typer.send(keys.releaseAll(state)); typer.releaseAll(); view.sync(keys.snapshot(state));` unless noted.

| Trigger | Action |
|---|---|
| Panel hidden by the user (top-bar button, × button) or by a session change | release-all (all toggles off) |
| `Main.sessionMode` `updated` (lock, unlock) | release-all (all toggles off), then `syncSessionState()` |
| `disable()` | release-all (all toggles off), then `run_dispose()` |
| `global.backend` `keymap-changed` | release-all (all toggles off) |
| Exception in any handler | `typer.releaseAll(); state = keys.createState();` |
| Polling finds the claimed button up | end the sequence normally: `typer.send(keys.release(state, button))` (also releases any Shift or Super the click added and the one-shot modifiers it used up) |

The screenshot capture hide (5.6) is NOT a trigger.

## 7. Layout: full-size US ANSI (`layouts/us.js`)

### 7.1 Format

```js
// layouts/us.js (pure data module)
export default {
    id: 'us-ansi-full',
    name: 'US English (full size)',
    size: [22.5, 6.5],
    keys: [
        {code: 1, x: 0, y: 0, label: 'Esc'},
        {code: 2, x: 1, y: 1.5, label: '1', shiftLabel: '!'},
        {code: 25, x: 10.5, y: 2.5, label: 'p', letter: true},
        {code: 42, x: 0, y: 4.5, w: 2.25, label: 'Shift', role: 'shift'},
        {code: 78, x: 21.5, y: 2.5, h: 2, label: '+'},
        {code: 71, x: 18.5, y: 2.5, label: '7', numLockOffLabel: 'Home'},
        // ...
    ],
};
```

- **Fields.**
  - Required: `code`, `x`, `y` (numbers) and `label` (string). Units are key widths (1u).
  - Optional:
    - `w` and `h` (default 1, must be > 0);
    - `shiftLabel`;
    - `numLockOffLabel`;
    - `letter`;
    - `role`: `shift`, `ctrl`, `alt` or `super`.
- **Letter labels.** Letters (`letter: true`) display lowercase, and uppercase when exactly one of these is true: a `shift` key is on, or Caps Lock is on (Shift XOR Caps Lock). This matches what a left click types (6.2). Letters need no `shiftLabel`; it is ignored if present.
- **Other labels.** Non-letter keys never swap their main label. `shiftLabel` is always a small top-left secondary label, so the user knows what right-click types.
- **Numpad labels.** Numpad keys show `label` when Num Lock is on and `numLockOffLabel` when it is off.
- **Validation in `layout.js`:**
  - required fields present, with the right types;
  - `code` in `KNOWN_CODES`, a constant array inside layout.js holding exactly the 104 codes of 7.2;
  - no code appears twice (the ledger is keyed by code);
  - no rectangles overlap;
  - every key lies inside `size`;
  - `role` appears exactly on the eight modifier codes listed in 7.2, and on no other key.

### 7.2 Key table (evdev codes from linux/input-event-codes.h)

Names such as "KP/" or "LShift" are identifiers; the label strings are listed after the table. Positions are given as `@x` (and `w`/`h` when not 1).

Row y=0 (function row):
- Esc 1 @0.
- F1 59 @2, F2 60 @3, F3 61 @4, F4 62 @5.
- F5 63 @6.5, F6 64 @7.5, F7 65 @8.5, F8 66 @9.5.
- F9 67 @11, F10 68 @12, F11 87 @13, F12 88 @14.
- PrtSc 99 (KEY_SYSRQ) @15.25, ScrLk 70 @16.25, Pause 119 @17.25.

Row y=1.5:
- `` ` ``/~ 41 @0, 1/! 2 @1, 2/@ 3 @2, 3/# 4 @3, 4/$ 5 @4, 5/% 6 @5, 6/^ 7 @6, 7/& 8 @7, 8/* 9 @8, 9/( 10 @9, 0/) 11 @10, -/_ 12 @11, =/+ 13 @12, Backspace 14 @13 w2.
- Insert 110 @15.25, Home 102 @16.25, PgUp 104 @17.25.
- NumLock 69 @18.5, KP/ 98 @19.5, KP* 55 @20.5, KP- 74 @21.5.

Row y=2.5:
- Tab 15 @0 w1.5, q 16 @1.5, w 17 @2.5, e 18 @3.5, r 19 @4.5, t 20 @5.5, y 21 @6.5, u 22 @7.5, i 23 @8.5, o 24 @9.5, p 25 @10.5, [/{ 26 @11.5, ]/} 27 @12.5, \/| 43 @13.5 w1.5.
- Delete 111 @15.25, End 107 @16.25, PgDn 109 @17.25.
- KP7/Home 71 @18.5, KP8/↑ 72 @19.5, KP9/PgUp 73 @20.5, KP+ 78 @21.5 h2.

Row y=3.5:
- Caps 58 @0 w1.75, a 30 @1.75, s 31 @2.75, d 32 @3.75, f 33 @4.75, g 34 @5.75, h 35 @6.75, j 36 @7.75, k 37 @8.75, l 38 @9.75, ;/: 39 @10.75, '/" 40 @11.75, Enter 28 @12.75 w2.25.
- KP4/← 75 @18.5, KP5 76 @19.5 (no Num Lock off label), KP6/→ 77 @20.5.

Row y=4.5:
- LShift 42 @0 w2.25, z 44 @2.25, x 45 @3.25, c 46 @4.25, v 47 @5.25, b 48 @6.25, n 49 @7.25, m 50 @8.25, ,/< 51 @9.25, ./> 52 @10.25, //? 53 @11.25, RShift 54 @12.25 w2.75.
- Up 103 @16.25.
- KP1/End 79 @18.5, KP2/↓ 80 @19.5, KP3/PgDn 81 @20.5, KPEnter 96 @21.5 h2.

Row y=5.5:
- LCtrl 29 @0 w1.25, LSuper 125 @1.25 w1.25, LAlt 56 @2.5 w1.25, Space 57 @3.75 w6.25, RAlt 100 @10 w1.25, RSuper 126 @11.25 w1.25, Menu 127 (KEY_COMPOSE) @12.5 w1.25, RCtrl 97 @13.75 w1.25.
- Left 105 @15.25, Down 108 @16.25, Right 106 @17.25.
- KP0/Ins 82 @18.5 w2, KP./Del 83 @20.5.

The table has 104 keys in total. Every main-block row ends at x=15, and nothing overlaps (verified).

Roles: 42 and 54 `shift`; 29 and 97 `ctrl`; 56 and 100 `alt`; 125 and 126 `super`. No other key has a role. Caps Lock 58, Num Lock 69, Scroll Lock 70 and Menu 127 are normal keys.

Labels:
- **Character keys.** US shifted labels: `` ` ``~ 1! 2@ 3# 4$ 5% 6^ 7& 8* 9( 0) -_ =+ [{ ]} \| ;: '" ,< .> /?. Letters are lowercase a–z.
- **Named keys:**
  - Esc, F1…F12, PrtSc, ScrLk, Pause;
  - Backspace, Tab, Caps Lock, Enter;
  - Shift (42, 54), Ctrl (29, 97), Super (125, 126), Alt (56, 100), Menu, Space (57);
  - Insert, Home, PgUp, Delete, End, PgDn;
  - ↑ ← ↓ → (103, 105, 108, 106);
  - Num Lock (69).
- **Numpad labels:** / * - + Enter 7 8 9 4 5 6 1 2 3 0 ., with Num Lock off labels Home ↑ PgUp ← → End ↓ PgDn Ins Del.
- **Lock indicators.** The lock-state indicator is drawn on code 58 (Caps Lock) and code 69 (Num Lock).

Labels are written by hand for US. Typing does not depend on labels: keycodes are sent, so if the system layout isn't US the keys type according to the system layout and only the labels are off.

## 8. View (`view.js`)

- **Geometry, in u** (1u = key pitch):
  - padding 0.25u on all sides;
  - a header 0.5u tall above the keys, holding, from left to right, the drag area, the resize grip (0.5u square) and the × button (0.5u square) at its right end;
  - nothing in the header overlaps keys.

  `layout.js` computes it from the layout's `size`: u = panel width / (size[0] + 0.5), panel height = u × (size[1] + 0.5 + 0.5). Key rectangles are inset slightly for visual gaps; hit-testing uses the full cells.
- **Hit-test order:** × > grip > header > key > none. A press on none is still consumed. Only button 1 starts a drag or resize, or arms ×.
- **Size limits.** The `width` setting is the whole panel width. The minimum key pitch is 24 logical px. If the work area is narrower than that allows, the work area wins. The default width is 60% of the work area width of the primary monitor, and the default position is bottom centre of that work area.
- **Dragging and resizing.** Driven by pointer polling (5.3). A drag moves the panel by the pointer delta since the press. A resize changes the width (the height follows) while keeping the top-left fixed.
- **Monitors.**
  - The panel's monitor is the one containing its centre: `global.display.get_monitor_index_for_rect(new Mtk.Rectangle({x, y, width, height}))` (`import Mtk from 'gi://Mtk'`).
  - Connector to index: `global.backend.get_monitor_manager().get_monitor_for_connector(connector)` (-1 if gone, then use `Main.layoutManager.primaryIndex`).
  - Index to connector: pick, from `monitorManager.get_monitors()`, the monitor whose `get_connector()` maps back to that index.
  - After a drag or resize, and on `Main.layoutManager` `monitors-changed`, clamp the whole panel inside `Main.layoutManager.getWorkAreaForMonitor(index)`.
- **Persistence.** Write geometry to GSettings only when a drag or resize ends, never per motion. Store the monitor connector, the top-left as fractions of that monitor's work area, and the width as a fraction of the work-area width (11.2).
- **The × button** acts when the claimed press ends over it. In the user session it also saves `visible=false`.
- **Key styles,** set by `view.sync(snapshot)` as style pseudo-classes:
  - `:active` while pressed;
  - `:checked` while a modifier is on (both Super keys when Super is on);
  - `:hover` from filter motion;
  - a short flash (owned by view.js) for a blocked key.

  Hover may not update while a grab is active; nothing may depend on it.
- **Accessibility.** Each key widget gets an `accessible_name` (its label). Modifiers get the role `TOGGLE_BUTTON`, with `CHECKED` state when on.
- **Theming.** One `stylesheet.css` with a dark default. Respect `St.Settings.get().high_contrast` by adding a style class.

## 9. Indicator (`indicator.js`)

- `class Indicator extends PanelMenu.Button`, with `super._init(0.0, 'jeyboard', true)` (no menu).
- With dontCreateMenu set to true, the base class disables its own click gesture. Add one:

  ```js
  const click = new Clutter.ClickGesture();
  click.connect('recognize', () => this._toggle());
  this.add_action(click);
  ```

- After `super._init()`, set `this.can_focus = false`; the base constructor forces `can_focus: true`.
- Icon: `this.add_child(new St.Icon({icon_name: 'input-keyboard-symbolic', style_class: 'system-status-icon'}))`.
- Clicking toggles the panel and saves `visible` (in the user session only).
- Add it with `Main.panel.addToStatusArea(uuid, indicator)`. Extension indicators survive the lock screen and greeter, where this button is the only manual toggle.
- **Limitation (accepted for v1).** While a fullscreen window is focused the top bar is hidden, so a hidden panel cannot be re-shown until fullscreen ends. Document this in the README.

## 10. Privacy, safety and EGO hygiene

- Never log key codes, labels or any typed content, in any build. Debug logs may record only state transitions (shown/hidden, filter installed, release-all reason).
- Use `connectObject`/`disconnectObject` for every signal and track every GLib source; `disable()` removes everything.
- No GObjects or side effects at import time.
- `disable()` is synchronous; an async `disable()` errors on GNOME 51.
- Every `run_dispose()` call carries a comment (5.4).
- No runtime file IO; the layout is a JS module.
- No spawned processes, no binaries.

## 11. Build and packaging

### 11.1 metadata.json

```json
{
  "uuid": "jeyboard@johnramsden.ca",
  "name": "jeyboard",
  "description": "On-screen keyboard with real modifier keys that works everywhere, including the lock and login screens.",
  "shell-version": ["50", "51"],
  "session-modes": ["user", "unlock-dialog"],
  "settings-schema": "org.gnome.shell.extensions.jeyboard",
  "version-name": "0.1.0"
}
```

The system flavour adds `"gdm"` to `session-modes`. Add `"url"` (the repository link) once the repository is public; EGO discourages unnecessary keys.

### 11.2 GSettings keys

| Key | Type | Default | Meaning |
|---|---|---|---|
| `visible` | b | false | shown in the user session |
| `monitor` | s | '' | connector of the monitor holding the panel ('' = primary) |
| `pos-x` | d | -1.0 | panel left as a fraction of the work-area width (-1 = default position) |
| `pos-y` | d | -1.0 | panel top as a fraction of the work-area height |
| `width` | d | 0.6 | panel width as a fraction of the work-area width |

### 11.3 Makefile and artifacts

**Makefile targets.**
- `all`: the first target; does nothing (debhelper runs the default target).
- `test`: `gjs -m tests/run.js`.
- `shell-test`: builds the zip and runs `tests/shell/smoke.js` in a headless `gnome-shell` (50+) via `gnome-shell-test-tool`; log in `shell-test.log` (git-ignored). CI (`.github/workflows/ci.yml`) runs `test`, the package build and `shell-test`.
- `zip`: builds the EGO zip `jeyboard@johnramsden.ca.shell-extension.zip`. The Makefile uses plain `zip` (below) rather than `gnome-extensions pack`; the content is equivalent and it works on hosts without `gnome-extensions`. The `pack` form, for reference:

  ```
  gnome-extensions pack extension --force --out-dir=. \
    --extra-source=keys.js --extra-source=layout.js --extra-source=view.js \
    --extra-source=input.js --extra-source=typer.js --extra-source=indicator.js \
    --extra-source=layouts
  ```

  - Pass the `layouts` directory, not `layouts/us.js`: `pack` keeps only each extra source's basename.
  - `extension.js`, `metadata.json`, `stylesheet.css` and `schemas/*.gschema.xml` are added automatically. `pack` never compiles schemas, and the zip must never contain `gschemas.compiled` (an automated EGO rejection).
  - On hosts without `gnome-extensions` (the dev host has none), use the equivalent `cd extension && zip -r ../jeyboard@johnramsden.ca.shell-extension.zip metadata.json extension.js keys.js layout.js view.js input.js typer.js indicator.js stylesheet.css layouts schemas/org.gnome.shell.extensions.jeyboard.gschema.xml`.
- `install DESTDIR=… FLAVOR=system`:
  - installs `extension/` to `$(DESTDIR)/usr/share/gnome-shell/extensions/jeyboard@johnramsden.ca/`, without `schemas/`;
  - installs the schema to `$(DESTDIR)/usr/share/glib-2.0/schemas/`; `Extension.getSettings()` falls back to the default schema source when there is no `schemas/` directory;
  - installs `data/gdm/95-jeyboard` to `$(DESTDIR)/usr/share/gdm/dconf/95-jeyboard` (mode 0644);
  - rewrites `session-modes` to include `gdm`;
  - leaves all installed files world-readable, because the greeter runs as the dynamic user `gdm-greeter`.

**GDM enablement on Ubuntu (verified against gdm3 50.1 packaging).**
- Ubuntu's gdm3 compiles every keyfile in `/usr/share/gdm/dconf/` into `/var/lib/gdm3/greeter-dconf-defaults` with `/usr/share/gdm/generate-config`, which runs as ExecStartPre and ExecReload of `gdm.service`.
- The gdm dconf profile (`/usr/share/dconf/profile/gdm`) is `user-db:user` plus `file-db:/var/lib/gdm3/greeter-dconf-defaults`, with no system-db. So `/etc/dconf/db/gdm.d` is never read on Ubuntu.
- Do not ship `/etc/dconf/profile/gdm`: it would shadow Ubuntu's profile and drop the greeter defaults.
- `data/gdm/95-jeyboard`:

  ```
  [org/gnome/shell]
  enabled-extensions=['jeyboard@johnramsden.ca']
  ```

- Keyfiles merge in filename order. `95-` sorts after `90-debian-settings` (a symlink to `/etc/gdm3/greeter.dconf-defaults`), so our value wins. A later-sorting file from another package that also sets `enabled-extensions` would override ours; document this.
- The keyfile takes effect at the next boot. Restarting gdm3 also works but ends running sessions.
- Non-Ubuntu GDM (upstream profile with system-db) is out of scope for v1.

**debian/.**
- `debian/control`:
  - `Source: jeyboard`, `Build-Depends: debhelper-compat (= 13), gjs`, `Rules-Requires-Root: no`;
  - binary `gnome-shell-extension-jeyboard`, `Architecture: all`, `Depends: ${misc:Depends}, gnome-shell (>= 50~), gnome-shell (<< 52~)`.
- `debian/rules`: `%:` → `dh $@`; `override_dh_auto_install:` → `$(MAKE) install DESTDIR=$(CURDIR)/debian/gnome-shell-extension-jeyboard FLAVOR=system`.
- `dh_auto_test` runs `make test`, honouring `DEB_BUILD_OPTIONS=nocheck`.
- There are no maintainer scripts: the schema is compiled by the glib trigger, and GDM recompiles its keyfiles at start.
- `debian/source/format` is `3.0 (native)`; `debian/copyright` is MIT (Debian name: Expat).

**User sessions.** The package does not force-enable the extension; the user runs `gnome-extensions enable jeyboard@johnramsden.ca`. A user-installed (EGO) copy with the same UUID takes precedence over the system copy in that user's session.

## 12. Development environment

- **Host.** Ubuntu 24.04 with KDE on X11. It cannot run GNOME 50/51 and has neither `gjs` nor `gnome-extensions`.
  - `make test` needs gjs ≥ 1.68 (`gjs -m`). Either install `gjs` on the host after asking the owner (Ubuntu 24.04 ships 1.80), or run it in the VM.
  - `make zip` must work with plain `zip` (11.3).
- **VM.** Use the owner's existing virt-manager VM (Ubuntu 26.04, GNOME 50.1). Ask the owner before running builds or tests whether to use the VM.
- **Iterating on Wayland.** Extension code cannot be reloaded in a running session; it needs a new shell process. Either:
  - build the zip, run `gnome-extensions install --force jeyboard@johnramsden.ca.shell-extension.zip` in the VM, then log out and back in; or
  - install `mutter-dev-bin` and run a nested shell with `dbus-run-session gnome-shell --devkit --wayland`.

  `scripts/push-to-vm.sh` automates build → copy (scp or a shared folder) → install.
- **Debugging.** Logs: `journalctl -f -o cat /usr/bin/gnome-shell`. Looking Glass: Alt+F2 → `lg` (closed automatically on the lock screen).
- **Ubuntu source check.** Before trusting spike results, compare the Ubuntu 50.1 sources (`apt source gnome-shell mutter`) with the files this spec cites at 50.5/51.0: `keyboard.js`, `modalDialog.js`, `grabHelper.js`, `switcherPopup.js`, `screenshot.js`, `events.c`, `clutter-main.c`, `meta-wayland-popup.c`, `meta-wayland-pointer.c`.
- **GNOME 51.** Use an Ubuntu 26.10 or GNOME OS nightly VM.
- **Headless shell test (implemented as `make shell-test`).** `gnome-shell-test-tool --headless --extension jeyboard@johnramsden.ca.shell-extension.zip tests/shell/smoke.js` (gnome-shell package, 50+). Automation scripts can import `Main` and create Clutter virtual pointer devices.

## 13. Spikes, then build

### 13.1 Spikes (one throwaway extension; confirmed by the owner on GNOME 50.1, no written log kept)

**S1: typing** (GNOME 50, then 51).
- With Ctrl on, Ctrl+click multi-select in Nautilus, and Ctrl+click in GTK3, XWayland and Firefox.
- Ctrl+Shift+T in a terminal; Alt+F4; Super+A.
- Bare Super, with no other modifier on, opens the overview.
- Right-click `p` → `P`, and `8` → `*`.
- Key repeat in an app and in a shell entry.
- After `disable()` with Ctrl on, the physical Ctrl key still works (no stuck key).
- Ctrl+Alt+F3 is blocked.

**S2: the event filter** (GNOME 50 and 51). Click keys of a test panel while each of these is open:
- a polkit dialog (`pkexec true`), a keyring prompt, and a Wi-Fi/VPN secret dialog;
- the Alt+F2 run dialog;
- an app folder, quick settings and a top-bar menu;
- a GTK4 popover with a text entry (e.g. the GNOME Text Editor go-to-line popover), the Nautilus rename popover, and a Firefox menu;
- the Alt+Tab switcher (with Alt locked), and the screenshot UI;
- the lock screen;
- overview search.

For each, record:
1. Key delivered?
2. Surface stayed open?
3. Focus unchanged?
4. No stuck keys?

With no grab, also check:
- drag the header quickly over a maximized app;
- resize outward over a maximized app;
- press a key, slide off over an app window, and release (the key must be released by polling).

Regressions with the filter installed: normal app clicks, drag-and-drop, Super-drag window move, cursor shape after leaving the panel, and device hotplug (no criticals in the log).

Measure filter overhead over 60 s of fast mouse motion; the target is a mean under 20 µs.

Decision: if everything passes, keep the single-filter design. If not, implement only the failing parts from 5.7.

**S3: GDM.** Install the `.deb` on 26.04 and reboot. Check that:
- the greeter loads the extension (`sudo -u gdm env DCONF_PROFILE=gdm dconf read /org/gnome/shell/enabled-extensions` lists it, and the panel appears);
- the schema is found;
- the panel types the password;
- login hands over cleanly.

**S4: dwell typing** (only if S2 fails for popovers on 50). Type into a GTK popover by polling `global.get_pointer()`.

### 13.2 Build v1 (after the spikes)

Implement sections 4–11.

Acceptance, on GNOME 50 and then 51, using only jeyboard and the mouse (no physical keyboard):
1. Log in at GDM.
2. Lock and unlock the screen.
3. Pass a polkit prompt and a Wi-Fi/VPN secret prompt, with the panel appearing on its own when the dialog opens.
4. Type into a GTK popover entry.
5. Ctrl+click multi-select in Nautilus.
6. Ctrl+Shift+T in a terminal.
7. Alt+Tab to another window.
8. Type in overview search.
9. Use the keyboard over a fullscreen video.
10. Drag the panel to a second monitor and resize it; it is restored there after re-login.

Stress:
- lock while a key is held;
- disable while Ctrl is on, then check the physical Ctrl key still works;
- a polkit dialog opening while a key is held;
- rapid clicking;
- clicking PrtSc on the keyboard (no stuck code 99).

### 13.3 Tests

`tests/run.js` is a tiny dependency-free runner (describe/it/expect-equal) for plain `gjs -m`. No jasmine.

`keys.test.js`:
- Modifiers:
  - on, locked and off for each Shift/Ctrl/Alt key, with the correct held codes;
  - right-click on each modifier does exactly what left-click does;
  - a normal key uses up one-shot modifiers (not locked ones), including several at once, and a blocked key does not;
  - the two Super keys share one toggle;
  - Super is never held.
- Normal keys:
  - left vs right click on a normal key;
  - right-click with LEFTSHIFT on, and with RIGHTSHIFT on, adds no LEFTSHIFT;
  - right-click with Ctrl on gives Ctrl+Shift+key.
- Super:
  - Super on + left click: down `[125↓, key↓]`, up the reverse;
  - Super on + right-click: down `[125↓, 42↓, key↓]`, up the reverse;
  - Super off with no chord: press returns `[]` and release returns `[125↓, 125↑]`;
  - a Super chord turns Super off by itself, with no tap; the next Super click turns it on again.
- Lock keys: Caps/Num/Scroll Lock emit press on down and release on up.
- Buttons: button 2 returns `[]`.
- VT block:
  - covers 59–68, 87 and 88 with any Ctrl plus any Alt;
  - the blocked press and its release both return `[]` and `blocked` is set;
  - 69 and 70 are never blocked.
- Ledger:
  - a second press while a claim is active returns `[]`;
  - it refuses a double press and an unmatched release;
  - `release()` after `releaseAll()` returns `[]`;
  - `releaseAll()` releases non-modifiers first, turns every toggle off (including Super), and clears any pending tap and the locked set.

`layout.test.js`:
- validation: missing fields, overlaps, out of bounds, unknown code, duplicate code, misplaced or missing roles;
- `layouts/us.js` has exactly 104 keys and validates;
- hit-testing at key edges and in gaps, for the ×, grip and header regions, and for the hit-test order;
- the tall KP+ and KPEnter keys and the wide KP0;
- geometry formulas for a given panel width.

## 14. Later, only if needed (not v1)

- **More panel features:**
  - docked mode with reserved space (`Main.layoutManager.trackChrome(panel, {affectsStruts: true})`, untracked when hidden);
  - auto-show on text focus (`Main.inputMethod` `input-panel-state`, or stage key focus moving to a `Clutter.Text`);
  - suppressing the built-in OSK for touch laptops (`KeyboardManager.prototype._lastDeviceIsTouchscreen`, plus an instance override of `Main.keyboard._a11yApplicationsSettings.get_boolean`);
  - a preferences window (a separate Adw process);
  - emoji and accents via `Main.inputMethod.commit()`.
- **Other layouts and sizes.** Generate label tables at build time from libxkbcommon via Python ctypes, and follow `InputSourceManager.currentSource.xkbId`. GJS has no keycode-to-keysym API.
- **An escape for apps that lock the mouse** (games, VM consoles).
  - A brief `Main.pushModal()` drops the pointer lock, but a plain mouse cannot trigger anything while locked. The trigger must be a touchpad gesture, a spare button or switch sending a key bound as non-maskable, or a D-Bus call.
  - A confined (not locked) pointer is released by moving onto the panel, if the panel is inside the confinement region.
  - Meanwhile, prefer absolute-pointer modes in VMs and remote-desktop clients.
- **A uinput backend,** if GNOME's virtual-keyboard API ever breaks.
  - A D-Bus-activated, hardened system service, with per-request polkit plus a logind active-seat check.
  - A keycode allowlist: no SysRq, power or SAK keys. The layout's PrtSc is KEY_SYSRQ (99), so this backend must translate 99 to KEY_PRINT (210), which XKB also maps to Print.
  - Never ship a `uaccess` or `input`-group udev rule. `/dev/uinput` is 0600 root on 26.04, and opening it up is a sandbox escape and a keylogger grant.
- **A Plasma front-end** reusing `keys.js`, `layout.js` and `layouts/us.js`:
  - Qt6/QML;
  - a LayerShellQt OVERLAY surface with `keyboard_interactivity none`;
  - `kde_lockscreen_overlay_v1` for the lock screen;
  - `org_kde_kwin_fake_input` for injection, gated by a `.desktop` `X-KDE-Wayland-Interfaces` entry on KWin 6.6/6.7;
  - `org.kde.KeyboardLayouts` for labels.

  Plasma's Overview, app popups and Alt+Tab need an in-process KWin C++ plugin (its input-filter API is exported), rebuilt for every KWin patch release. Kubuntu 26.04 ships KWin 6.6.x.
- **EGO submission.**

## 15. Outside any desktop (no OSK can reach these)

- **Boot-time disk passphrase.** Plymouth reads hardware keys only. Use TPM2 unlock (in the 26.04 installer, or `systemd-cryptenroll`) or a FIDO2 key. Alternatively use `unl0kr`, a mouse-capable unlock keyboard packaged in 26.04; it needs custom dracut integration.
- **GRUB.** It has no mouse driver. Keep the menu hidden and choose entries from the desktop with `grub-reboot`.
- **Firmware setup.** Enter it with `systemctl reboot --firmware-setup`.
- **Text consoles and the rescue shell.** `buffyboard` (packaged in 26.04) is a mouse-driven console keyboard; otherwise use SSH.

## 16. Known risks, limitations and unverified items

**Spikes S1-S3 were confirmed by the owner on GNOME 50.1 (no written log). Not covered: GNOME 51. The items below record what the design relied on:**
- The single-filter design (5.3) is verified by reading source at mutter 50.1/51.0, not by running it. Spike S2 decides.
- With no grab, MOTION and BUTTON_RELEASE off the panel are not seen by the filter; drag, resize and releases there rely on polling (5.3). S2 checks this.
- Popovers staying open, keyboard control of the switcher, and overview search with the filter are known from source reading only.
- GDM loading through `/usr/share/gdm/dconf/95-jeyboard`: S3.
- Repeat for virtual-device keys in shell `St.Entry` widgets: S1.

**Limitations to document in the README:**
- While an Input Capture portal session is active (e.g. Input Leap, Deskflow), mutter's filter consumes every event first (src/core/events.c, meta_display_process_captured_input), so the panel cannot be used.
- Focus-follows-mouse (`focus-mode 'mouse'`) is unsupported (5.1).
- A hidden panel cannot be re-shown while a fullscreen window hides the top bar (9). Accepted for v1 by the owner; a later option is collapsing the panel into a small always-on-top floating button instead of hiding it.
- The gnome-initial-setup session is not supported (3.2).

**Private APIs used** (re-run S1/S2 after each Ubuntu 50.x update and each new GNOME release):
- `Main.uiGroup` stacking;
- `Main.layoutManager` (monitors, work areas, `monitors-changed`, `system-modal-opened`);
- `Main.screenshotUI.open` (wrapped; cosmetic);
- `Main.sessionMode`;
- `Main.panel`;
- in the fallback only, `KeyboardManager.prototype.maybeHandleEvent` (50) and the input panel group (51).

**EGO:** reviewer discretion on `unlock-dialog` (Touch Board was accepted in 2026; GJS OSK was rejected) and on a global event filter.

## 17. References

Plan and research (local):
- Plan: `/home/john/.claude/plans/i-want-to-plan-linear-mochi.md`.
- Research logs (one `result` line per agent in each `journal.jsonl`), under `/home/john/.claude/projects/-home-john-Canonical-checkouts-jeyboard/ed2e39e7-2813-4c27-84f8-a96415796058/subagents/workflows/`:
  - `wf_ac2d4bd1-23c`: GNOME feasibility;
  - `wf_f048eb23-9bf`: cross-desktop and uinput;
  - `wf_5c6b5fe5-c1b`: unreachable surfaces;
  - `wf_cdcef8f3-2b1`: the source-level review of this spec.

Upstream:
- Input panel group (grab chrome), GNOME 51: https://gitlab.gnome.org/GNOME/mutter/-/merge_requests/5171 and https://gitlab.gnome.org/GNOME/gnome-shell/-/merge_requests/4283
- `Clutter.get_default_backend()` removal: https://gitlab.gnome.org/GNOME/mutter/-/merge_requests/4981
- Network secrets over the lock screen (50.1): https://gitlab.gnome.org/GNOME/gnome-shell/-/merge_requests/4160
- App popovers closed by OSK taps (GNOME 50 and earlier): https://gitlab.gnome.org/GNOME/mutter/-/issues/4362
- Pointer events to Wayland surfaces with no grab: https://github.com/GNOME/mutter/blob/51.0/src/wayland/meta-wayland-pointer.c#L974-L993
- Ubuntu gdm3 greeter dconf: https://salsa.debian.org/gnome-team/gdm/-/raw/ubuntu/resolute/debian/generate-config and https://salsa.debian.org/gnome-team/gdm/-/raw/ubuntu/resolute/debian/patches/91_dconf_database_path.patch
- EGO review guidelines: https://gjs.guide/extensions/review-guidelines/review-guidelines.html
- GNOME 51 port guide: https://gjs.guide/extensions/upgrading/gnome-shell-51.html
- `Clutter.Event.add_filter`: https://mutter.gnome.org/clutter/type_func.Event.add_filter.html
