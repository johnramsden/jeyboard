// Owns: the Clutter event filter, the claimed pointer sequence, pointer polling,
// and dispatch of clicks to keys.js / typer.js / drag / resize / hide.
// Must not: look at key events, call stage.grab() or Main.pushModal() (they drop
// Wayland keyboard focus), open a PopupMenu (its items take key focus on hover),
// or decide key behaviour (keys.js does).
//
// Why a filter, why polling: docs/SPEC.md 5.3. In short, mutter's own filter runs first
// and PROPAGATEs pointer events under any stage grab, so ours sees them; with no
// grab it hands events to the surface under the pointer, so once the pointer leaves
// the panel we may never see the release, and polling global.get_pointer() is the
// release path.
// https://github.com/GNOME/mutter/blob/50.1/clutter/clutter/clutter-main.c#L198-L229
// https://github.com/GNOME/mutter/blob/50.1/src/core/events.c
//
// Terms such as actor, stage, picking, grab and event filter are explained in the
// glossary in docs/DESIGN.md. The three ideas this file depends on:
//
// Event filter: a function registered with Clutter.Event.add_filter(). Clutter calls
//   it for each input event that mutter's own filter (which runs first) lets
//   through: all pointer events while any grab is active, but with no grab only
//   events over shell actors such as our panel. It runs after picking and before
//   normal delivery. It returns Clutter.EVENT_STOP ("handled, nobody else gets
//   this") or Clutter.EVENT_PROPAGATE ("not mine, carry on"). Returning STOP is
//   how a click on our panel stays invisible to the app or shell UI underneath,
//   so it cannot, for example, dismiss an app popover.
//   We use a filter instead of St.Button "clicked" handlers because those are only
//   reached through Clutter's delivery and grab machinery, and since GNOME 49
//   St.Button is gesture-driven; gestures are not triggered for events a filter
//   consumes. Keys are therefore activated here, by hit-testing the press position.
//
// Claim: a press that we consume starts a "sequence" (press ... release of one
//   button on one device), recorded in this._claim. The matching release must also
//   be consumed, otherwise an app would see a release with no press (or close its
//   popover). Releases are routed by the claim, never by where the pointer is when
//   the release arrives.
//
// Lost release: with no grab active, once the pointer leaves our panel mutter sends
//   events to the window under it, and our filter may never see the button release.
//   So while a sequence is claimed we also poll global.get_pointer() on a timer and
//   treat "the button bit is no longer set" as the release. That is the guaranteed
//   release path, not just a watchdog.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import * as keys from './keys.js';
import * as layoutLib from './layout.js';

// Poll intervals in milliseconds. 16 ms is about one frame at 60 Hz, so a drag
// looks smooth; 100 ms is plenty to notice a button release while a key is just
// being held, and costs less.
const POLL_FAST_MS = 16;   // drag and resize
const POLL_SLOW_MS = 100;  // every claim until a drag or resize starts

// global.get_pointer() returns a bitmask of which buttons are down. Mouse button
// numbers (1 = left, 2 = middle, 3 = right ...) map to Clutter's mask bits here.
const BUTTON_MASKS = {
    1: Clutter.ModifierType.BUTTON1_MASK,
    2: Clutter.ModifierType.BUTTON2_MASK,
    3: Clutter.ModifierType.BUTTON3_MASK,
    4: Clutter.ModifierType.BUTTON4_MASK,
    5: Clutter.ModifierType.BUTTON5_MASK,
};

export class Input {
    // host: {panel, typer, layout, onMoved(), onClose()}
    // The host is the extension, passed in so this file stays thin and does not
    // import the view or the extension itself.
    constructor(host) {
        this._host = host;
        // keys.js state machine (which keys/modifiers are down); plain data.
        this._state = keys.createState();
        // The claimed pointer sequence, or null. Shape (set in _onPress):
        // {button, kind: 'none'|'key'|'drag'|'resize'|'close', start: [x, y],
        //  device, origin?}
        this._claim = null;
        // Ids returned by Clutter / GLib so we can remove the filter and the
        // timer later. 0 means "none".
        this._filterId = 0;
        this._pollId = 0;
        // True when uninstall() was asked for while a sequence was claimed.
        this._removePending = false;
    }

    get claimed() {
        return this._claim !== null;
    }

    install() {
        this._removePending = false;
        if (!this._filterId)
            // The stage argument is null, as mutter does for its own filter: with
            // a real stage Clutter would call clutter_actor_get_stage() on a null
            // actor for device hotplug events and log a critical (docs/SPEC.md 5.3).
            this._filterId = Clutter.Event.add_filter(null, (event, actor) => this._onEvent(event, actor));
    }

    // Removal waits for a claimed sequence to end so its release is still consumed:
    // if we removed the filter mid-click, the release would fall through to the app
    // below, which saw no press. _finishSequence() does the removal once the claim
    // ends, and install() cancels it if the panel is shown again first.
    uninstall() {
        if (this._claim)
            this._removePending = true;
        else
            this._removeFilter();
    }

    // Immediate teardown, used when the extension is disabled: no deferral.
    destroy() {
        this._stopPolling();
        this._claim = null;
        this._removeFilter();
    }

    _removeFilter() {
        this._removePending = false;
        if (!this._filterId)
            return;
        Clutter.Event.remove_filter(this._filterId);
        this._filterId = 0;
    }

    // The release-all triggers of docs/SPEC.md 6.6. The sequence claim is kept.
    // Order: send the releases keys.js says are needed, then have the typer
    // release anything else it still holds (its own safety net, see typer.js),
    // then redraw the panel. The claim is kept on purpose so the user's
    // still-held mouse button is still consumed when it is let go.
    releaseAll() {
        this._host.typer.send(keys.releaseAll(this._state));
        this._host.typer.releaseAll();
        this._host.panel.sync(keys.snapshot(this._state));
    }

    // Error recovery: release every key on the virtual device and start from a
    // fresh state so a half-updated state machine cannot leave anything stuck.
    // The typer is released first (it does not depend on this._state).
    _resetAfterError() {
        this._host.typer.releaseAll();
        this._state = keys.createState();
        this._host.panel.sync(keys.snapshot(this._state));
    }

    // Is the picked actor our panel, or something inside it? (actor can be null.)
    _isOverPanel(actor) {
        const panel = this._host.panel.actor;
        return !!actor && (actor === panel || panel.contains(actor));
    }

    // The filter callback. `event` is the Clutter event, `actor` the actor
    // picking found under the pointer.
    _onEvent(event, actor) {
        // actor is null for device hotplug events: decide before touching it.
        // `handler` is chosen per event type and run inside the try/catch below, so
        // that every handler gets the same error handling.
        let handler;
        switch (event.type()) {
        case Clutter.EventType.BUTTON_PRESS:
            handler = () => this._onPress(event, actor);
            break;
        case Clutter.EventType.BUTTON_RELEASE:
            handler = () => this._onRelease(event);
            break;
        case Clutter.EventType.MOTION:
            handler = () => this._onMotion(event, actor);
            break;
        case Clutter.EventType.SCROLL:
            // Swallow scrolling over the panel so it does not scroll the window
            // underneath; scrolling elsewhere is none of our business.
            handler = () => this._isOverPanel(actor) ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
            break;
        default:
            // Key events, ENTER/LEAVE, touch, hotplug: never ours.
            return Clutter.EVENT_PROPAGATE;
        }

        // This runs inside the compositor, so an uncaught exception here could leave
        // keys held.
        try {
            return handler();
        } catch (e) {
            // Never log key identities.
            console.error(`jeyboard: input error: ${e.message}`);
            // The error handler: (1) release everything, (2) fresh state (both
            // done by _resetAfterError), (3) return STOP so the half-handled
            // event does not also reach the app. The reset is itself wrapped in
            // try/catch so a failure there cannot escape either.
            try {
                this._resetAfterError();
            } catch (e2) {
                console.error(`jeyboard: reset failed: ${e2.message}`);
            }
            return Clutter.EVENT_STOP;
        }
    }

    _onPress(event, actor) {
        // Presses elsewhere belong to the apps and shell: let them through.
        if (!this._isOverPanel(actor))
            return Clutter.EVENT_PROPAGATE;
        // A second button pressed while one sequence is active: swallow it, do
        // nothing (we only track one sequence at a time).
        if (this._claim)
            return Clutter.EVENT_STOP;

        const button = event.get_button();
        const [x, y] = event.get_coords();
        const local = this._host.panel.toLocal(x, y);
        // Claim first: the press is consumed either way, so its release must be too.
        // That is why the claim is made at press time, before we know what was
        // hit: even a press on empty panel space is STOPped, so its release must
        // be STOPped too or the app would see a lone release. `device` is
        // remembered so a release from another device is not mistaken for ours.
        this._claim = {
            button, kind: 'none', start: [x, y], device: event.get_source_device(),
        };
        // Poll for every claim, not only the interesting ones: with no grab the
        // release may never be seen, and an unended claim would swallow later clicks.
        this._startPolling(POLL_SLOW_MS);
        // toLocal failed (the panel's transform cannot be inverted, e.g. it is not
        // allocated yet): nothing to hit-test.
        if (!local)
            return Clutter.EVENT_STOP;

        // What is under the press, in the panel's own coordinates (key, header,
        // grip, close button or nothing). The geometry maths lives in the panel
        // and layout modules, not here.
        const hit = this._host.panel.hitTest(local[0], local[1]);
        switch (hit.type) {
        case 'key':
            this._claim.kind = 'key';
            // Pressing happens now, at press time; the release is sent when the
            // sequence ends. keys.press() returns a list of {code, pressed}
            // actions; the typer sends them.
            this._host.typer.send(keys.press(this._state, hit.key, button));
            this._host.panel.sync(keys.snapshot(this._state));
            break;
        case 'header':
        case 'grip': {
            // Only the primary (left) button moves or resizes the panel.
            if (button !== 1)
                break;
            const [px, py] = this._host.panel.actor.get_position();
            this._claim.kind = hit.type === 'grip' ? 'resize' : 'drag';
            // Remember where the panel was when the gesture began; the polled
            // pointer movement is applied relative to this (see _moveGesture).
            this._claim.origin = {x: px, y: py, width: this._host.panel.geometry.width};
            // Faster polling, so the panel follows the pointer smoothly.
            this._startPolling(POLL_FAST_MS);
            break;
        }
        case 'close':
            if (button !== 1)
                break;
            // Armed only: the panel hides on release, if still over the X.
            this._claim.kind = 'close';
            break;
        default:
            break;
        }
        return Clutter.EVENT_STOP;
    }

    _onRelease(event) {
        const claim = this._claim;
        // Not the release of our sequence (no claim, other button or device):
        // not ours, let it through.
        if (!claim || event.get_button() !== claim.button ||
            event.get_source_device() !== claim.device)
            return Clutter.EVENT_PROPAGATE;
        // Decide from the press-time claim, never by hit-testing the release: a
        // release let through under a grab would close an app popover.
        // (Mutter dismisses an app popover only when a button release reaches its
        // grab; consuming our press AND release keeps popovers open.)
        const [x, y] = event.get_coords();
        this._endSequence(x, y);
        // STOP wherever the pointer is: the press was ours, so the release is too.
        return Clutter.EVENT_STOP;
    }

    _onMotion(event, actor) {
        const over = this._isOverPanel(actor);
        // During a claimed sequence swallow motion over the panel and let it
        // through elsewhere. The drag/resize position itself comes from polling,
        // not from these events, since they stop arriving once the pointer is off
        // the panel.
        if (this._claim)
            return over ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        // No sequence: only maintain the hover highlight, and always PROPAGATE so
        // apps still see the motion.
        if (over) {
            const [x, y] = event.get_coords();
            const local = this._host.panel.toLocal(x, y);
            this._host.panel.setHover(local ? this._host.panel.hitTest(local[0], local[1]) : null);
        } else {
            this._host.panel.setHover(null);
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // GLib.timeout_add(priority, ms, callback) calls `callback` every `ms`
    // milliseconds until it returns GLib.SOURCE_REMOVE (stop) instead of
    // GLib.SOURCE_CONTINUE (call again). It returns an id for GLib.source_remove().
    _startPolling(ms) {
        // Replacing the timer (e.g. slow -> fast on a drag) must not leave the old
        // one running.
        this._stopPolling();
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            try {
                this._poll();
            } catch (e) {
                console.error(`jeyboard: poll error: ${e.message}`);
                // Drop the claim first so a failing reset cannot leave it stuck.
                // (_finishSequence also stops polling, so _pollId becomes 0.)
                this._finishSequence();
                try {
                    this._resetAfterError();
                } catch (e2) {
                    console.error(`jeyboard: reset failed: ${e2.message}`);
                }
            }
            // Keep the timer alive only while a poll id is still set; if the
            // sequence ended (or failed) above, _stopPolling zeroed it and we
            // tell GLib to stop calling us.
            return this._pollId ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
        });
    }

    _stopPolling() {
        if (this._pollId)
            GLib.source_remove(this._pollId);
        this._pollId = 0;
    }

    // One poll tick: has the claimed button been released, and if not, where is
    // the pointer?
    _poll() {
        const claim = this._claim;
        if (!claim) {
            this._stopPolling();
            return;
        }
        // global.get_pointer() asks the shell for the pointer position and the
        // currently held buttons/modifiers right now, independent of whether any
        // event reached our filter. `mods` is a bitmask of button/modifier bits.
        const [x, y, mods] = global.get_pointer();
        // Buttons we have no mask for count as mask 0, so they end the sequence at
        // once instead of throwing.
        if (!(mods & (BUTTON_MASKS[claim.button] ?? 0))) {
            // Button no longer held: this is the release, even though we never
            // saw a release event.
            this._endSequence(x, y);
            return;
        }
        this._moveGesture(claim, x, y);
    }

    // Drag and resize follow the polled pointer; the top-left stays fixed on resize.
    // The maths: how far the pointer has moved since the press (dx, dy), added to
    // where the panel was at press time (claim.origin). Using the start point
    // rather than adding up small steps means rounding errors and skipped polls
    // cannot accumulate.
    _moveGesture(claim, x, y) {
        const panel = this._host.panel;
        const dx = x - claim.start[0];
        const dy = y - claim.start[1];
        if (claim.kind === 'drag') {
            // Whole-pixel positions keep the panel from being drawn blurry.
            panel.actor.set_position(Math.round(claim.origin.x + dx), Math.round(claim.origin.y + dy));
        } else if (claim.kind === 'resize') {
            // Only the width is changed (by horizontal movement); the left/top
            // edge stays put. The width never goes below the minimum key pitch
            // (layout.minWidth). The maximum (the work area) is applied by
            // panel.clamp() when the resize ends, so the panel may briefly overflow
            // the screen during the drag.
            const min = layoutLib.minWidth(this._host.layout);
            const width = Math.max(min, claim.origin.width + dx);
            panel.setWidth(width);
        }
    }

    // Finish the claimed sequence at pointer position (x, y), from either a real
    // release event or from polling. Decisions use the press-time claim kind.
    _endSequence(x, y) {
        const claim = this._claim;
        const panel = this._host.panel;
        switch (claim.kind) {
        case 'key':
            // Releases the key, and any Shift/Super that the click added.
            this._host.typer.send(keys.release(this._state, claim.button));
            panel.sync(keys.snapshot(this._state));
            break;
        case 'drag':
        case 'resize':
            // Apply the final pointer position, keep the panel on screen, then
            // tell the host so it can save the geometry.
            this._moveGesture(claim, x, y);
            panel.clamp();
            this._host.onMoved();
            break;
        case 'close': {
            // The one place a release position matters: like a normal button,
            // the click only counts if the pointer is still on the X.
            const local = panel.toLocal(x, y);
            if (local && panel.hitTest(local[0], local[1]).type === 'close')
                this._host.onClose();
            break;
        }
        default:
            break;
        }
        this._finishSequence();
    }

    // Common end of every sequence: drop the claim, clear hover, stop the timer,
    // and perform a filter removal that uninstall() deferred.
    _finishSequence() {
        this._claim = null;
        this._host.panel.setHover(null);
        this._stopPolling();
        if (this._removePending)
            this._removeFilter();
    }
}
