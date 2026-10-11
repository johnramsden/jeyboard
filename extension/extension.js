// Owns: enable()/disable(), wiring of all modules, show/hide, session sync and the
// release-all triggers (docs/SPEC.md 5.5, 6.6).
// Must not: hold logic that could live in the pure modules.
//
// For readers new to GNOME extensions: the terms used here (shell, mutter, Clutter, St,
// actor, stage, session mode, ...) are in the glossary in docs/DESIGN.md.
//
// Lifecycle: the shell instantiates the default-exported class below once, then calls
// enable() when the extension is switched on and disable() when it is switched off.
// This can happen many times in one login: the user toggles it, or another extension
// is disabled and the shell "rebases" (disables and re-enables the extensions loaded
// after it, possibly while the screen is locked). So disable() MUST undo everything
// enable() did: every signal connection, every actor added to the stage, every timer,
// every compositor setting. Anything left behind keeps running code (or keeps a key
// held down) after the user thinks the extension is off. At import time (the top of
// each file) we only declare things; no objects are created and no side effects
// happen until enable() runs.
//
// Imports: 'gi://Clutter' loads a native library through auto-generated bindings;
// 'resource:///org/gnome/shell/...' loads JavaScript shipped inside the gnome-shell
// binary (e.g. `Main`, a bag of the shell's live singletons); './view.js' is one of
// this extension's own files.
import Clutter from 'gi://Clutter';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Indicator} from './indicator.js';
import {Input} from './input.js';
import * as layoutLib from './layout.js';
import us from './layouts/us.js';
import {Typer} from './typer.js';
import {Panel} from './view.js';

// The shell looks for exactly one default export and constructs it. The base class
// provides this.uuid (from metadata.json) and this.getSettings() (GSettings, see the
// schema XML). Members starting with an underscore are private by convention only.
export default class JeyboardExtension extends Extension {
    // The shell does not call disable() after an enable() that threw (the extension
    // goes to the ERROR state), so undo a partial enable() ourselves.
    enable() {
        // Set before anything can throw: disable() relies on them.
        // _shown: panel is currently displayed (user choice or forced by a modal).
        // _unredirected: we are holding the compositor's "no unredirect" lock, see
        //   _setUnredirect().
        this._shown = false;
        this._unredirected = false;
        try {
            this._enable();
        } catch (e) {
            this.disable();
            throw e;
        }
    }

    _enable() {
        // Cheap self-check that the layout data is well formed; throws if not.
        layoutLib.validate(us);
        // GSettings: the shell's persistent key/value store (dconf). The keys are
        // declared in schemas/org.gnome.shell.extensions.jeyboard.gschema.xml.
        // getSettings() finds that schema in the extension's schemas/ directory or,
        // for the system .deb (which has no schemas/), in the system schema
        // directory (docs/SPEC.md 11.3).
        // Everything stored on `this` below is state that disable() clears.
        this._settings = this.getSettings();

        // Three collaborators, each in its own file:
        //   Typer  - injects the actual key press/release events (typer.js).
        //   Panel  - the visible keyboard widget, pure view (view.js).
        //   Input  - the event filter that turns pointer clicks into key actions.
        // This file only wires them together.
        this._typer = new Typer();
        this._panel = new Panel(us);
        this._input = new Input({
            panel: this._panel,
            typer: this._typer,
            layout: us,
            onMoved: () => this._panel.save(this._settings),
            onClose: () => this._setUserVisible(false),
        });
        // Main.uiGroup holds all shell UI; app windows (global.window_group) are its
        // bottom child, so the last child draws over everything. We add the panel
        // directly instead of via Main.layoutManager.addChrome(), which would insert
        // it below global.top_window_group (app popup windows) and register it for
        // the shell's input-region tracking; affectsInputRegion also throws on GNOME
        // 50+ (docs/SPEC.md 5.2).
        Main.uiGroup.add_child(this._panel.actor);
        // Position and width come from GSettings (fractions of the work area).
        this._panel.restore(this._settings);

        // The top-bar button; the callback runs on click.
        this._indicator = new Indicator(() => this._setUserVisible(!this._shown));
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        // Z-ORDER. Children of a Clutter container are painted in order, the LAST
        // child on top. Other shell parts (popup menus, the screenshot UI, OSD pop-ups,
        // the lock-screen fade) bring themselves to the top by re-ordering uiGroup, and
        // they do it WITHOUT adding a child, so there is no 'child-added' signal for
        // us to react to. Instead we watch the stage's 'before-update' signal, which
        // fires once before each frame is drawn, and re-raise the panel if something
        // is above it. The check is one pointer comparison, so doing it every frame
        // is cheap. set_child_above_sibling(actor, null) means "above all siblings".
        // See docs/SPEC.md 5.2.
        //
        // connectObject(signal, callback, owner) is a GNOME helper (not plain GLib):
        // it connects the signal and remembers the connection under the owner object
        // (`this`). disconnectObject(this) later drops every connection made with that
        // owner in one call, so we never have to store handler ids.
        global.stage.connectObject('before-update', () => {
            if (Main.uiGroup.get_last_child() !== this._panel.actor)
                Main.uiGroup.set_child_above_sibling(this._panel.actor, null);
        }, this);
        // At shell shutdown, uiGroup is destroyed before the last frame is drawn;
        // touching it from 'before-update' after that would error. So when uiGroup
        // announces its 'destroy', we stop our per-frame handler.
        Main.uiGroup.connectObject('destroy', () => global.stage.disconnectObject(this), this);

        // SESSION MODES. The shell runs in different modes with different UI:
        //   'user'          the normal logged-in desktop,
        //   'unlock-dialog' the lock screen (the session is locked),
        //   'gdm'           the login greeter, before anyone has logged in.
        // Distributions can add modes (Ubuntu has 'ubuntu', whose parent is 'user'),
        // so code must not compare mode names; use the isLocked / isGreeter flags.
        // 'updated' fires when the mode changes, e.g. on lock and unlock. Keys held
        // from the previous mode must not leak across it, hence release-all first,
        // then re-apply what should be visible in the new mode.
        Main.sessionMode.connectObject('updated', () => {
            this._releaseAll();
            this._syncSessionState();
        }, this);
        // MODAL DIALOGS. When the shell opens a modal dialog (polkit "authenticate"
        // prompts, keyring, Wi-Fi/VPN secrets, Alt+F2, ...) the top bar cannot be
        // clicked, so the user would have no way to open the keyboard. layoutManager
        // announces these with 'system-modal-opened'; we show the panel so a password
        // can be typed. The screenshot UI emits the same signal and also shows it:
        // https://github.com/GNOME/gnome-shell/blob/50.1/js/ui/screenshot.js
        // We call _show(), not _setUserVisible(), so the saved `visible` preference
        // is unchanged. The panel then stays up until the user hides it.
        // 'monitors-changed' (a display is plugged/unplugged or rearranged) re-clamps
        // the panel so it cannot end up off-screen.
        // (docs/SPEC.md 5.5)
        Main.layoutManager.connectObject(
            'system-modal-opened', () => this._show(),
            'monitors-changed', () => this._panel.clamp(),
            this);
        // XKB is the library that tracks which modifiers (Shift, Ctrl...) are held. A
        // keymap reload (layout switch, settings change) resets that state behind our
        // back, so our idea of "Ctrl is held" would be wrong. Release everything.
        global.backend.connectObject('keymap-changed', () => this._releaseAll(), this);

        // Caps Lock and Num Lock are toggled by real keys too, not only by this
        // panel, so the panel mirrors the keymap's lock state (via the 'notify::'
        // property-change signals) to light the keys correctly.
        this._keymap = global.stage.context.get_backend().get_default_seat().get_keymap();
        this._keymap.connectObject(
            'notify::caps-lock-state', () => this._syncLocks(),
            'notify::num-lock-state', () => this._syncLocks(),
            this);
        this._syncLocks();

        // Apply the current session state now. Waiting for the 'updated' signal is not
        // enough: the greeter never emits `updated` after extensions load, and a
        // lock-time rebase misses it too (docs/SPEC.md 5.5).
        this._syncSessionState();
    }

    disable() {
        // unlock-dialog: the on-screen keyboard is needed to type the password on the
        // lock screen; it never reads key events.
        //
        // disable() must be synchronous and must undo everything enable() did
        // (otherwise signal handlers, the event filter, timers and held keys outlive
        // the extension). Order: first disconnect every signal made with owner
        // `this`, then release held keys and tear down objects. The `?.` calls do
        // nothing on null, so disable() is safe on a part-way enable(); enable()
        // calls it itself on failure.
        global.stage.disconnectObject(this);
        Main.uiGroup.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        global.backend.disconnectObject(this);
        this._keymap?.disconnectObject(this);
        this._keymap = null;

        // Last chance to let go of any key still logically held, then tear down the
        // input handling (Input.destroy) and the key injector (Typer.destroy).
        this._input?.releaseAll();
        this._input?.destroy();
        this._input = null;
        this._setUnredirect(false);
        this._typer?.destroy();
        this._typer = null;

        // Destroying the actors removes them from the stage; nulling the fields drops
        // our references so the JS garbage collector can free the objects.
        this._indicator?.destroy();
        this._indicator = null;
        this._panel?.destroy();
        this._panel = null;
        this._settings = null;
    }

    // Push the keymap's Caps/Num Lock state into the panel (null = keep the key
    // snapshot as it is; only the locks changed).
    _syncLocks() {
        this._panel.sync(null, {
            caps: this._keymap.caps_lock_state,
            num: this._keymap.num_lock_state,
        });
    }

    // Single place that decides whether the panel should be visible, from the
    // current session mode and the saved preference. Called from enable() and from
    // the sessionMode 'updated' handler (enable() must call it; see there).
    // On the lock screen and greeter the panel is forced on (a password must be
    // typeable) and the saved preference is ignored; elsewhere the preference wins.
    _syncSessionState() {
        const forced = Main.sessionMode.isLocked || Main.sessionMode.isGreeter;
        if (forced || this._settings.get_boolean('visible'))
            this._show();
        else
            this._hide();
    }

    // The top-bar and x buttons. Only the user session remembers the choice.
    _setUserVisible(visible) {
        if (!Main.sessionMode.isLocked && !Main.sessionMode.isGreeter)
            this._settings.set_boolean('visible', visible);
        if (visible)
            this._show();
        else
            this._hide();
    }

    // Show the panel and start handling input. Idempotent. If already shown we still
    // call install(): after a hide during a claimed click the filter removal is
    // pending, and install() cancels it.
    _show() {
        if (this._shown) {
            this._input.install();
            return;
        }
        this._shown = true;
        this._panel.actor.show();
        this._input.install();
        this._setUnredirect(true);
    }

    // Always release held keys first: hiding the panel while Ctrl is toggled on
    // would leave Ctrl stuck with no visible way to turn it off (docs/SPEC.md 6.6).
    // Hover highlight is cleared and the event filter removed so the hidden panel
    // cannot swallow clicks.
    _hide() {
        this._releaseAll();
        this._panel.setHover(null);
        this._shown = false;
        this._input.uninstall();
        this._panel.actor.hide();
        this._setUnredirect(false);
    }

    // Release every held key and clear toggled modifiers. See docs/SPEC.md 6.6 for the
    // full list of triggers that call this.
    _releaseAll() {
        this._input.releaseAll();
    }

    // "Unredirect": for speed, the compositor can let a fullscreen window draw
    // straight to the screen, skipping the compositor's own drawing. Our panel is
    // drawn by the compositor, so it would be invisible over such a window.
    // disable_unredirect() turns that optimisation off; enable_unredirect() restores
    // it. The _unredirected flag makes sure we call each one only when the state
    // really changes, so the two calls always stay balanced.
    _setUnredirect(on) {
        if (on === this._unredirected)
            return;
        this._unredirected = on;
        if (on)
            global.compositor.disable_unredirect();
        else
            global.compositor.enable_unredirect();
    }
}
