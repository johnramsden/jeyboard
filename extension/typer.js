// Owns: the Clutter virtual keyboard device and the list of codes pressed on it.
// Must not: decide what to press (keys.js does), or use notify_keyval (docs/SPEC.md 5.4).
//
// GNOME/Clutter terms are explained in the glossary in docs/DESIGN.md.
//
// A "virtual keyboard device" is a fake keyboard that exists only in software. We
// ask mutter to create one and then tell it "key X went down", "key X went up".
// Mutter treats those exactly like presses from a real USB keyboard: they go
// through the same keymap (XKB), input-method (IBus), keybinding (Super, Alt+Tab
// ...) and focus logic, so the app being typed into cannot tell the difference.
// That is how an on-screen keyboard types without ever taking keyboard focus
// (docs/SPEC.md 5.4).
//
// A key that is "pressed" but never "released" stays held down seat-wide (a "stuck
// key"). Press counts are seat-wide and never reset, and a new device cannot clear
// another device's stuck key, so a leak is hard to recover from. Much of this file
// exists to make that impossible.
import Clutter from 'gi://Clutter';

// evdev key codes of the modifier keys, in order: Left Ctrl (29), Right Ctrl
// (97), Left Shift (42), Right Shift (54), Left Alt (56), Right Alt (100), Left
// Super (125), Right Super (126). "evdev codes" are the numbers the Linux kernel
// uses for physical keys (see linux/input-event-codes.h, KEY_*). They name a
// physical key position, not a character: code 30 is "the key where A is on a
// US keyboard", whatever layout is active.
//
// Released last in releaseAll(), so a chord unwinds like on hardware. (On a real
// keyboard you let go of Ctrl+C by lifting C and then Ctrl; if Ctrl went up
// first, the app could see a bare "C" typed.)
const MODIFIER_CODES = [29, 97, 42, 54, 56, 100, 125, 126];

export class Typer {
    constructor() {
        // Not Clutter.get_default_backend(): removed in GNOME 51.
        // The "seat" is mutter's grouping of all input devices for one user.
        const seat = global.stage.context.get_backend().get_default_seat();
        this._device = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        // Why Typer keeps its own list of pressed codes even though keys.js has
        // an authoritative ledger: this is a safety net, not a second state
        // machine. It lets us (a) drop bad events before mutter sees them and
        // (b) know exactly what is physically down on THIS device, so
        // releaseAll() can always undo it, even if keys.js state was reset
        // after an error. It is a plain array of codes with no duplicates.
        this._held = [];
    }

    // actions: [{code, pressed}]. Duplicate presses and unmatched releases are
    // dropped here because mutter would g_warning on them.
    send(actions) {
        for (const {code, pressed} of actions) {
            const isHeld = this._held.includes(code);
            // Skip when the request matches what we already believe: pressing
            // an already-held key, or releasing a key that is not held.
            if (pressed === isHeld)
                continue;
            // Update our record BEFORE calling into mutter: if a press throws, we
            // err toward believing the key is held, so releaseAll() still tries to
            // release it.
            this._held = pressed ? this._held.concat(code) : this._held.filter(c => c !== code);
            // Pass PRESSED or RELEASED, never ORed: RELEASED is 0, so
            // `PRESSED | RELEASED` equals PRESSED and a "release" would be a press.
            // CURRENT_TIME (0) lets mutter stamp the event with its own monotonic
            // clock in its input thread, so we never pass a timestamp and every
            // path uses the same clock.
            // The code is a raw evdev code; mutter adds the +8 XKB offset itself.
            // We deliberately never use notify_keyval (send a keysym such as
            // "a"): it only looks up keysyms in the current layout group, silently
            // adds Shift or ISO_Level3_Shift to reach them, and does not track
            // the extra modifier it added, so that modifier can be left stuck.
            this._device.notify_key(Clutter.CURRENT_TIME, code,
                pressed ? Clutter.KeyState.PRESSED : Clutter.KeyState.RELEASED);
        }
    }

    // Release everything this device holds, e.g. when the panel hides, the
    // screen locks, or after an error.
    releaseAll() {
        // Newest press first, mirroring how you would let go by hand.
        const held = this._held.slice().reverse();
        const isMod = code => MODIFIER_CODES.includes(code);
        // Non-modifiers first, then modifiers last (see MODIFIER_CODES), each
        // turned into a {code, pressed: false} action and sent through send(),
        // which also updates this._held.
        this.send(held.filter(c => !isMod(c)).concat(held.filter(isMod))
            .map(code => ({code, pressed: false})));
    }

    destroy() {
        // Never dispose the device while something is still down.
        this.releaseAll();
        // run_dispose: unregister the virtual keyboard now. Otherwise it lives until GC
        // with its seat press counts, which can leave keys held (docs/SPEC.md 5.4).
        // (Objects are normally freed by the garbage collector at some later,
        // unpredictable time; run_dispose forces it now. Extension review flags
        // every use of it, hence this comment.)
        this._device.run_dispose();
        this._device = null;
    }
}
