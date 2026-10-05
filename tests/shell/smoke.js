// Headless behaviour test for the shell-facing code (docs/SPEC.md 13.2, no grab case).
// Run: make shell-test   (needs gnome-shell 50+, no display)
// Drives a virtual pointer over the panel and checks the keyboard events mutter emits.
// Prints "TEST PASS ..." / "TEST FAIL ..." lines and "TEST DONE failed=N".
//
// HOW THIS RUNS
// `make shell-test` zips the extension and starts gnome-shell-test-tool, which
// launches a REAL gnome-shell/mutter with --headless (a virtual monitor, no display
// server, no GPU window) inside a throw-away dbus session. It installs and enables the
// zip, then loads THIS file as a module and awaits its exported run() function.
// So this script runs inside the shell process itself, with the same imports an
// extension has (Main, Clutter, ...). It can therefore reach into the live extension
// (`inst._panel`, `inst._input`; underscore members are private by convention only)
// and it drives the shell like a user: a virtual mouse, real event delivery.
//
// The Makefile target passes only if the log has no "TEST FAIL", "JS ERROR" or
// "Gjs-CRITICAL" and contains "TEST DONE failed=0". Printing a final DONE line is
// important: if the shell hangs or run() throws part-way, no DONE line appears and
// the target fails, instead of passing by silence. The overall run is also cut off
// by `timeout` in the Makefile.
//
// What is checked, in one sentence each (names match the check() calls below):
//   - the extension actually loaded (state 1 = ExtensionState.ACTIVE);
//   - the panel can be shown and that choice is saved to GSettings;
//   - left click sends press+release of a key, right click adds Shift around it;
//   - a one-shot modifier (Ctrl) is used up by the next key; a double click locks it
//     until a third click;
//   - a forbidden chord (Ctrl+Alt+F1) is blocked: no key events at all;
//   - a key held with the button, pointer dragged away, button released out of our
//     sight, is still released (the polling path: the "guaranteed release");
//   - presses that start no gesture (gap between keys, right click on the header)
//     do not leave the input "claimed" and wedge the next click;
//   - dragging the header moves the panel and saves its position;
//   - disable() with Ctrl still toggled on sends a release for it (no stuck key).
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

// Must match the "uuid" in extension/metadata.json; it is how the shell names the
// extension in Main.extensionManager.
const UUID = 'jeyboard@ramsdenj.ca';
let failed = 0;
// The recorder. Every key press/release reaching the stage is appended here so a
// check can compare "what the panel caused" with an expected string. Codes are
// evdev numbers (Linux key codes: 30 = A, 29 = Left Ctrl, 42 = Left Shift ...).
const events = [];       // 'v<evdev>' press, '^<evdev>' release, as seen on the stage

// A minimal assertion helper (no test framework is available inside the shell).
// Values are compared as JSON text so arrays and objects compare by content. A failure is counted, not thrown, so one bad
// check does not hide the others. The log prefixes are what the Makefile greps for.
function check(name, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        console.log(`TEST PASS ${name}`);
    } else {
        failed++;
        console.log(`TEST FAIL ${name}: expected ${e}, got ${a}`);
    }
}

// The test-tool entry point. `async` lets us `await` pauses between steps (the shell
// keeps running its main loop while we wait, which is what delivers the events).
export async function run() {
    const ext = Main.extensionManager.lookup(UUID);
    // Proves the zip loads and enable() did not throw: ExtensionState.ACTIVE is 1.
    check('extension enabled', ext?.state, 1);
    // stateObj is the live JeyboardExtension instance created by the shell.
    const inst = ext.stateObj;
    const settings = inst._settings;

    // Observer filter, installed after ours; it only records key events.
    // A Clutter event filter sees every event before normal dispatch and answers
    // PROPAGATE (let it continue) or STOP (swallow it). Filters run in the order
    // they were added, so this recorder sees the key events the extension injects
    // but only those that survive earlier filters. get_key_code() is the X11/XKB
    // keycode, which is the evdev code plus 8, hence the "- 8".
    Clutter.Event.add_filter(null, (event, _actor) => {
        const t = event.type();
        if (t === Clutter.EventType.KEY_PRESS)
            events.push(`v${event.get_key_code() - 8}`);
        else if (t === Clutter.EventType.KEY_RELEASE)
            events.push(`^${event.get_key_code() - 8}`);
        return Clutter.EVENT_PROPAGATE;
    });

    // A virtual pointer: the seat can create a fake input device, and events sent
    // through it travel the same path as a physical mouse. The `sleep` pauses let the
    // shell process each event (and repaint) before the next step.
    // Coordinates are stage coordinates, same as the panel's.
    const seat = global.stage.context.get_backend().get_default_seat();
    const pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const sleep = ms => Scripting.sleep(ms);
    const move = async (x, y) => {
        pointer.notify_absolute_motion(Clutter.CURRENT_TIME, x, y);
        await sleep(60);
    };
    const button = async (b, pressed) => {
        pointer.notify_button(Clutter.CURRENT_TIME, b,
            pressed ? Clutter.ButtonState.PRESSED : Clutter.ButtonState.RELEASED);
        await sleep(60);
    };
    // take() returns the events recorded since the last call as one string
    // ('v30 ^30') and empties the list (splice(0) removes all elements and returns
    // them), so each check sees only what happened since the previous one.
    const take = () => events.splice(0).join(' ');

    // Same call as the top-bar button. Proves show works end to end and saves the
    // preference (user session, not the greeter).
    inst._setUserVisible(true);
    await sleep(300);
    const panel = inst._panel;
    check('panel visible', panel.actor.visible, true);
    check('visible saved', settings.get_boolean('visible'), true);

    // Click the centre of a key. b is the pointer button: 1 left, 3 right.
    // `b = 1` is a default parameter value. The helper `centre` is defined just
    // below; that is fine because it is only called later, after both exist.
    const click = async (code, b = 1) => {
        const [x, y] = centre(code);
        await move(x, y);
        await button(b, true);
        await button(b, false);
    };

    // Stage coordinates of the middle of a key, from the panel's own geometry (so the
    // test shares no hit-test code path with the click it triggers).
    const centre = code => {
        const cell = panel.geometry.cells.find(c => c.key.code === code);
        const [px, py] = panel.actor.get_transformed_position();
        return [px + cell.x + cell.w / 2, py + cell.y + cell.h / 2];
    };
    // A headless shell picks against the last painted frame; hover over the freshly
    // shown panel until it has been painted, or the first press hits what was under it.
    {
        const [x, y] = centre(30);
        await move(x - 5, y);
        await sleep(500);
        await move(x, y);
        await sleep(200);
    }
    // Left click on A (evdev 30): one press then one release, nothing else.
    await click(30);
    check('left click a', take(), 'v30 ^30');

    // Right click = "with Shift": Shift (42) goes down first and up last, wrapping P
    // (25), so the app receives Shift+P.
    await click(25, 3);
    check('right click p = shift+p', take(), 'v42 v25 ^25 ^42');

    // Click Left Ctrl (29): it turns on (one-shot) and is held. The next normal key
    // (T, 20) uses it up, so Ctrl is released right after T.
    await click(29);
    await click(20);
    check('one-shot ctrl is used up by the next key', take(), 'v29 v20 ^20 ^29');

    // Click Ctrl twice: it locks and survives keys. A third click turns it off.
    await click(29);
    await click(29);
    await click(20);
    await click(20);
    check('locked ctrl survives keys', take(), 'v29 v20 ^20 v20 ^20');
    await click(29);
    check('third click unlocks ctrl', take(), '^29');

    // Toggle Ctrl (29) and Alt (56) on, discard those events, then click F1 (59).
    // Ctrl+Alt+F1 would switch to a text console and lock the on-screen keyboard
    // away, so the state machine refuses it: no events at all must be emitted.
    await click(29);
    await click(56);
    take();
    await click(59);
    check('Ctrl+Alt+F1 blocked', take(), '');
    // The blocked press kept Ctrl and Alt on; a normal key uses them up so later
    // checks start clean.
    await click(20);
    take();

    // The headless shell does not do this by itself, so the next block installs a
    // filter that swallows button releases and motion outside the panel, as a real
    // desktop would. The extension's own filter is removed and installed again so it
    // runs after this one, and so it never sees those events: only its polling of the
    // pointer state can notice that the button went up. (_removeFilter and
    // _isOverPanel are Input internals; this test uses them on purpose.)
    inst._input._removeFilter();
    Clutter.Event.add_filter(null, (event, actor) => {
        const t = event.type();
        const over = !inst._input || inst._input._isOverPanel(actor);
        if (!over && (t === Clutter.EventType.BUTTON_RELEASE || t === Clutter.EventType.MOTION))
            return Clutter.EVENT_STOP;
        return Clutter.EVENT_PROPAGATE;
    });
    inst._input.install();

    // A point above the panel (outside it) where the pointer is dragged away to.
    const [offX, offY] = (() => {
        const [px, py] = panel.actor.get_transformed_position();
        return [px + 40, py - 80];
    })();
    // Press at (x, y) with button b, slide off the panel, then release off the panel,
    // where the swallowing filter above hides the release from the extension. The long
    // sleep afterwards gives its polling time to notice the button is up.
    const pressSlideRelease = async (x, y, b) => {
        await move(x, y);
        await button(b, true);
        await move(offX, offY);
        await button(b, false);
        await sleep(400);
    };
    const geo = panel.geometry;
    // Convert a point given in panel units (u, one key pitch) to stage coordinates.
    const pt = (ux, uy) => {
        const [px, py] = panel.actor.get_transformed_position();
        return [px + ux * geo.u, py + uy * geo.u];
    };

    // The guaranteed release path: key held, pointer leaves, release never seen.
    // This is the heart of the "every press has a release" rule: the press goes out
    // at once ('v30'); the matching release can only come from polling, and must.
    {
        const [x, y] = centre(30);
        await move(x, y);
        await button(1, true);
        check('held key pressed', take(), 'v30');
        await move(offX, offY);
        await button(1, false);
        await sleep(400);
        check('release found by polling', take(), '^30');
    }
    // Claims that start no gesture must not stay stuck when their release is lost.
    // (Input "claims" a pointer press so the app underneath never sees it; the claim
    // must end even if the press did nothing.) After each lost release, an ordinary
    // click must still work, and finally the input must report that it is idle.
    // pt(6.75, 1.25) is a spot between keys; pt(3, 0.4) is in the header.
    await pressSlideRelease(...pt(6.75, 1.25), 1);
    await click(30);
    check('gap press does not wedge the claim', take(), 'v30 ^30');
    await pressSlideRelease(...pt(3, 0.4), 3);
    await click(30);
    check('right-click on header does not wedge the claim', take(), 'v30 ^30');
    check('input idle', inst._input.claimed, false);

    // Drag the header; position changes and is saved on release.
    // The pointer moves left and up by 200 x 120 px in two steps; the panel must end
    // up further left, and pos-x in GSettings (default -1) must now be a real
    // fraction >= 0, proving the save on release.
    {
        const [px, py] = panel.actor.get_transformed_position();
        const hx = px + panel.geometry.width / 3;
        const hy = py + panel.geometry.u * 0.5;
        await move(hx, hy);
        await button(1, true);
        await move(hx - 100, hy - 60);
        await sleep(100);
        await move(hx - 200, hy - 120);
        await button(1, false);
        await sleep(200);
        const [nx] = panel.actor.get_transformed_position();
        check('drag moved panel', Math.round(px - nx) > 0, true);
        check('geometry saved', settings.get_double('pos-x') >= 0, true);
    }

    // Disabling with Ctrl on must release it. disable() is called directly with the
    // live instance as `this`; its release-all must emit the Ctrl release ('^29'),
    // so no key is left logically held after the extension is gone.
    await click(29);
    take();
    ext.stateObj.disable?.call(inst);
    await sleep(100);
    check('disable releases ctrl', take(), '^29');

    console.log(`TEST DONE failed=${failed}`);
}
