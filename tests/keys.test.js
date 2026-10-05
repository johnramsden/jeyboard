// Unit tests for extension/keys.js: the modifier state machine and ledger.
// Run with `make test` (tests/run.js supplies describe/it/equal/throws).
//
// READING GUIDE (for developers new to GNOME extensions or JavaScript)
//
// Every test builds a fresh state, "clicks" keys, and checks the ACTIONS that
// keys.js returns (lists of {code, pressed}) or the snapshot. No real keyboard
// or GNOME is involved. Terms (evdev code, toggle, chord, tap, ledger, claim)
// are explained at the top of extension/keys.js; the behaviour is specified in
// docs/SPEC.md section 6.
//
// A "click" has two halves: press(state, key, button) on mouse button down and
// release(state, button) on button up. Button 1 is the left button and 3 the
// right button (right click means "with Shift").
import * as keys from '../extension/keys.js';

// Stand-ins for layout entries: only the fields keys.js reads (code, role).
// Codes are Linux evdev numbers: 42/54 Left/Right Shift, 29/97 Left/Right Ctrl,
// 56/100 Left/Right Alt, 125/126 Left/Right Super, 20 is T, 25 is P, 63 is F5.

const LSHIFT = {code: 42, role: 'shift'};
const RSHIFT = {code: 54, role: 'shift'};
const LCTRL = {code: 29, role: 'ctrl'};
const RCTRL = {code: 97, role: 'ctrl'};
const LALT = {code: 56, role: 'alt'};
const RALT = {code: 100, role: 'alt'};
const LSUPER = {code: 125, role: 'super'};
const RSUPER = {code: 126, role: 'super'};
const T = {code: 20};
const P = {code: 25};
const F5 = {code: 63};

// Shorthands for expected actions: dn(20) is "key 20 goes down", up(20) is
// "key 20 goes up".
const dn = code => ({code, pressed: true});
const up = code => ({code, pressed: false});

// A complete click: button down then button up. Returns both results as
// [pressActions, releaseActions]. `button = 1` is a default parameter: if the
// caller omits it, the left button is used.
function click(state, key, button = 1) {
    return [keys.press(state, key, button), keys.release(state, button)];
}

// Shift/Ctrl/Alt have three states: one click turns them on (key held down,
// "one-shot": the next normal key uses it up), a second click LOCKS them (stays
// held across keys), a third click turns them off. The two Super keys behave
// differently (see below).
describe('modifier toggles', () => {
    for (const [name, key] of [['LShift', LSHIFT], ['RShift', RSHIFT], ['LCtrl', LCTRL],
        ['RCtrl', RCTRL], ['LAlt', LALT], ['RAlt', RALT]]) {
        it(`${name}: on, then locked, then off (left click)`, () => {
            const s = keys.createState();
            const c = key.code;
            equal(click(s, key), [[dn(c)], []]);
            equal(keys.snapshot(s), {on: new Set([c]), locked: new Set(), pressed: new Set([c]), blocked: null});
            // second click locks: nothing is sent, it simply stops being one-shot
            equal(click(s, key), [[], []]);
            equal(keys.snapshot(s), {on: new Set([c]), locked: new Set([c]), pressed: new Set([c]), blocked: null});
            equal(click(s, key), [[up(c)], []]);
            equal(keys.snapshot(s).on, new Set());
            equal(keys.snapshot(s).locked, new Set());
        });
        it(`${name} right click does exactly what left click does`, () => {
            const s = keys.createState();
            equal(click(s, key, 3), [[dn(key.code)], []]);
            equal(click(s, key, 3), [[], []]);
            equal(click(s, key, 3), [[up(key.code)], []]);
        });
        it(`${name} one-shot is used up by the next normal key`, () => {
            const s = keys.createState();
            click(s, key);
            equal(click(s, T), [[dn(20)], [up(20), up(key.code)]]);
            equal(keys.snapshot(s).pressed, new Set());
            equal(keys.snapshot(s).on, new Set());
        });
        it(`${name} locked survives normal keys`, () => {
            const s = keys.createState();
            click(s, key);
            click(s, key);
            equal(click(s, T), [[dn(20)], [up(20)]]);
            equal(click(s, T), [[dn(20)], [up(20)]]);
            equal(keys.snapshot(s).pressed, new Set([key.code]));
        });
    }

    // Ctrl+G: click Ctrl once, click G; Ctrl is released after G.
    it('ctrl then g: ctrl is used up', () => {
        const s = keys.createState();
        equal(click(s, LCTRL), [[dn(29)], []]);
        equal(click(s, {code: 34}), [[dn(34)], [up(34), up(29)]]);
        equal(keys.snapshot(s).on, new Set());
    });

    // Ctrl+Alt+G: clicking Alt keeps Ctrl on; G uses both up, newest first.
    it('ctrl then alt then g: both are used up together', () => {
        const s = keys.createState();
        click(s, LCTRL);
        equal(click(s, LALT), [[dn(56)], []]);
        equal(keys.snapshot(s).on, new Set([29, 56]));
        equal(click(s, {code: 34}), [[dn(34)], [up(34), up(56), up(29)]]);
        equal(keys.snapshot(s).pressed, new Set());
    });

    it('a locked modifier stays while a one-shot one is used up', () => {
        const s = keys.createState();
        click(s, LCTRL);
        click(s, LCTRL);          // locked
        click(s, LSHIFT);         // one-shot
        equal(click(s, T), [[dn(20)], [up(20), up(42)]]);
        equal(keys.snapshot(s).pressed, new Set([29]));
        equal(keys.snapshot(s).locked, new Set([29]));
        // and a locked modifier can be unlocked by a third click
        equal(click(s, LCTRL), [[up(29)], []]);
    });

    it('holding the key keeps the one-shot held until release (repeat works)', () => {
        const s = keys.createState();
        click(s, LCTRL);
        equal(keys.press(s, T, 1), [dn(20)]);
        equal(keys.snapshot(s).pressed, new Set([29, 20]));
        equal(keys.release(s, 1), [up(20), up(29)]);
    });

    it('left and right variants are independent', () => {
        const s = keys.createState();
        click(s, LSHIFT);
        click(s, RSHIFT);
        equal(keys.snapshot(s).on, new Set([42, 54]));
        click(s, LSHIFT);          // locks left only
        equal(keys.snapshot(s).locked, new Set([42]));
        click(s, T);               // uses up right only
        equal(keys.snapshot(s).on, new Set([42]));
    });

    // Super is never physically held (a held Super turns window clicks into
    // window moves); turning it on sends nothing, and turning it off sends a
    // quick bare tap after the button is released. See docs/SPEC.md 6.3.
    it('the two Super keys share one toggle and Super is never held', () => {
        const s = keys.createState();
        equal(keys.press(s, LSUPER, 1), []);
        equal(keys.snapshot(s), {on: new Set([125, 126]), locked: new Set(), pressed: new Set(), blocked: null});
        keys.release(s, 1);
        // turning it off with the other Super key: bare tap on release
        equal(keys.press(s, RSUPER, 3), []);
        equal(keys.release(s, 3), [dn(125), up(125)]);
        equal(keys.snapshot(s).on, new Set());
    });
});

// Ordinary keys: press on button down, release on button up (a physical
// mirror, so system key repeat works while the button is held). Right button
// adds Shift for the duration of the click.
describe('normal keys', () => {
    it('left click presses and releases', () => {
        const s = keys.createState();
        equal(keys.press(s, T, 1), [dn(20)]);
        equal(keys.release(s, 1), [up(20)]);
    });

    // Order matters: Shift goes down before the key and comes up after it, or
    // the application would see an unshifted key.
    it('right click adds LEFTSHIFT and releases it after the key', () => {
        const s = keys.createState();
        equal(keys.press(s, P, 3), [dn(42), dn(25)]);
        equal(keys.release(s, 3), [up(25), up(42)]);
        equal(keys.snapshot(s).pressed, new Set());
    });

    // If a Shift is already toggled on, adding another would be redundant, and
    // releasing it would wrongly turn off the user's toggled Shift.
    it('right click with LEFTSHIFT on adds no shift', () => {
        const s = keys.createState();
        click(s, LSHIFT);
        equal(click(s, P, 3), [[dn(25)], [up(25), up(42)]]);
        equal(keys.snapshot(s).pressed, new Set());
    });

    it('right click with a LOCKED shift adds no shift and keeps it', () => {
        const s = keys.createState();
        click(s, LSHIFT);
        click(s, LSHIFT);
        equal(click(s, P, 3), [[dn(25)], [up(25)]]);
        equal(keys.snapshot(s).pressed, new Set([42]));
    });

    it('right click with RIGHTSHIFT on adds no LEFTSHIFT', () => {
        const s = keys.createState();
        click(s, RSHIFT);
        equal(click(s, P, 3), [[dn(25)], [up(25), up(54)]]);
    });

    it('right click with Ctrl on gives Ctrl+Shift+key', () => {
        const s = keys.createState();
        click(s, LCTRL);
        equal(keys.press(s, T, 3), [dn(42), dn(20)]);
        equal(keys.release(s, 3), [up(20), up(42), up(29)]);
        equal(keys.snapshot(s).pressed, new Set());
    });

    // The middle button and extra buttons (such as 8) do nothing and must not
    // leave a claim behind that would block the next real click.
    it('other buttons return [] and record nothing', () => {
        const s = keys.createState();
        equal(keys.press(s, T, 2), []);
        equal(keys.press(s, T, 8), []);
        equal(keys.release(s, 2), []);
        equal(keys.press(s, T, 1), [dn(20)]);
    });

    // Caps (58), Num (69) and Scroll Lock (70) are ordinary keys here: the
    // system keeps the lock state, keys.js keeps none.
    it('lock keys press on down and release on up', () => {
        for (const code of [58, 69, 70]) {
            const s = keys.createState();
            equal(keys.press(s, {code}, 1), [dn(code)]);
            equal(keys.release(s, 1), [up(code)]);
        }
    });
});

// Super "on" is only a highlight. While it is on, a normal key is sent as an
// atomic chord: Super down, key down ... key up, Super up, all within the one
// click. A tap (Super down+up with nothing between) is what opens the GNOME
// overview, so it is only sent if no chord used Super.
describe('Super', () => {
    it('on + left click is an atomic chord', () => {
        const s = keys.createState();
        click(s, LSUPER);
        equal(keys.press(s, T, 1), [dn(125), dn(20)]);
        equal(keys.release(s, 1), [up(20), up(125)]);
    });

    it('on + right click is Super+Shift+key', () => {
        const s = keys.createState();
        click(s, LSUPER);
        equal(keys.press(s, T, 3), [dn(125), dn(42), dn(20)]);
        equal(keys.release(s, 3), [up(20), up(42), up(125)]);
    });

    // The tap comes from release(), not press(): press returns [] here.
    it('off with no chord taps Super on release', () => {
        const s = keys.createState();
        click(s, LSUPER);
        equal(keys.press(s, LSUPER, 1), []);
        equal(keys.release(s, 1), [dn(125), up(125)]);
    });

    // Super is one-shot too: the chord uses it up, with no tap afterwards.
    it('a chord turns Super off by itself, with no tap', () => {
        const s = keys.createState();
        click(s, LSUPER);
        equal(click(s, T), [[dn(125), dn(20)], [up(20), up(125)]]);
        equal(keys.snapshot(s).on, new Set());
        // the next click turns it on again; nothing is sent
        equal(click(s, LSUPER), [[], []]);
        equal(keys.snapshot(s).on, new Set([125, 126]));
    });

    // Clicking Ctrl while Super is on does not count as using Super, so the
    // eventual Super-off still produces a tap.
    it('toggling another modifier is not a chord', () => {
        const s = keys.createState();
        click(s, LSUPER);
        click(s, LCTRL);
        equal(click(s, LSUPER), [[], [dn(125), up(125)]]);
    });

    it('a chord in one Super session does not suppress the next tap', () => {
        const s = keys.createState();
        click(s, LSUPER);
        click(s, T);            // chord; Super is now off
        click(s, LSUPER);       // on again
        equal(click(s, LSUPER)[1], [dn(125), up(125)]);   // off with no chord: tap
    });

    it('Super does not lock: a second click always turns it off', () => {
        const s = keys.createState();
        click(s, LSUPER);
        click(s, LSUPER);
        equal(keys.snapshot(s).on, new Set());
        equal(keys.snapshot(s).locked, new Set());
    });
});

// VT block: with Ctrl and Alt both on, F1-F12 would switch to a text console
// (Ctrl+Alt+Fn), stranding a mouse-only user, so those presses are swallowed.
// A blocked press still takes a claim (its release is consumed) but returns no
// actions, and sets `blocked` so the view can flash the key.
describe('VT block', () => {
    // A state with Left Ctrl and Left Alt toggled on.
    function withCtrlAlt() {
        const s = keys.createState();
        click(s, LCTRL);
        click(s, LALT);
        return s;
    }

    // The explicit list: F1-F10 (59-68), F11 (87), F12 (88).
    for (const code of [59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 87, 88]) {
        it(`blocks code ${code} with Ctrl+Alt`, () => {
            const s = withCtrlAlt();
            equal(keys.press(s, {code}, 1), []);
            equal(keys.snapshot(s).blocked, code);
            equal(keys.release(s, 1), []);
            equal(keys.snapshot(s).blocked, null);
        });
    }

    it('blocks with the right-hand modifiers and with right click', () => {
        const s = keys.createState();
        click(s, RCTRL);
        click(s, RALT);
        equal(keys.press(s, F5, 3), []);
        equal(keys.release(s, 3), []);
        equal(keys.snapshot(s).pressed, new Set([97, 100]));
    });

    // 69 and 70 (Num Lock, Scroll Lock) lie numerically between F10 and F11,
    // which is why keys.js uses an explicit list and not a range.
    it('never blocks 69 and 70', () => {
        for (const code of [69, 70]) {
            const s = withCtrlAlt();
            equal(keys.press(s, {code}, 1), [dn(code)]);
        }
    });

    it('does not block with only Ctrl or only Alt', () => {
        for (const mod of [LCTRL, LALT]) {
            const s = keys.createState();
            click(s, mod);
            equal(keys.press(s, F5, 1), [dn(63)]);
        }
    });

    it('does not block F-keys without modifiers', () => {
        const s = keys.createState();
        equal(keys.press(s, F5, 1), [dn(63)]);
    });
});

// The ledger records which codes are down; the claim ties a button release to
// the codes that button's press put down. Together they guarantee every press
// gets a release and nothing is released twice.
describe('ledger', () => {
    it('a second press while a claim is active returns []', () => {
        const s = keys.createState();
        keys.press(s, T, 1);
        equal(keys.press(s, P, 1), []);
        equal(keys.press(s, T, 3), []);
        equal(keys.release(s, 1), [up(20)]);
    });

    it('a release for a different button is ignored', () => {
        const s = keys.createState();
        keys.press(s, T, 1);
        equal(keys.release(s, 3), []);
        equal(keys.release(s, 1), [up(20)]);
    });

    it('release without press returns []', () => {
        equal(keys.release(keys.createState(), 1), []);
    });

    it('double release returns [] the second time', () => {
        const s = keys.createState();
        keys.press(s, T, 1);
        keys.release(s, 1);
        equal(keys.release(s, 1), []);
    });

    it('release() after releaseAll() returns []', () => {
        const s = keys.createState();
        keys.press(s, T, 3);
        equal(keys.releaseAll(s), [up(20), up(42)]);
        equal(keys.release(s, 3), []);
    });

    // releaseAll is the panic button (panel hidden, screen locked, ...). It
    // unwinds like a person lifting their fingers: the key before the
    // modifiers, newest first.
    it('releaseAll releases non-modifiers first, reverse press order', () => {
        const s = keys.createState();
        click(s, LCTRL);
        click(s, LSHIFT);
        keys.press(s, T, 1);
        equal(keys.releaseAll(s), [up(20), up(42), up(29)]);
    });

    it('releaseAll turns every toggle off and clears Super state', () => {
        const s = keys.createState();
        click(s, LCTRL);
        click(s, LCTRL);        // locked
        click(s, LSUPER);
        keys.releaseAll(s);
        equal(keys.snapshot(s), {on: new Set(), locked: new Set(), pressed: new Set(), blocked: null});
        // Super is off again, so one click turns it on without emitting anything
        equal(click(s, LSUPER), [[], []]);
    });

    it('releaseAll clears a pending Super tap', () => {
        const s = keys.createState();
        click(s, LSUPER);
        keys.press(s, LSUPER, 1);
        keys.releaseAll(s);
        equal(keys.release(s, 1), []);
    });

    it('releaseAll clears blocked', () => {
        const s = keys.createState();
        click(s, LCTRL);
        click(s, LALT);
        keys.press(s, F5, 1);
        keys.releaseAll(s);
        equal(keys.snapshot(s).blocked, null);
    });

    it('releaseAll on a fresh state is empty', () => {
        equal(keys.releaseAll(keys.createState()), []);
    });

    it('snapshot shows the key held during a click', () => {
        const s = keys.createState();
        keys.press(s, T, 1);
        equal(keys.snapshot(s).pressed, new Set([20]));
    });
});

// Edge cases found while reviewing the state machine: combinations of Super,
// Shift, VT blocking and mismatched buttons.
describe('review edge cases', () => {
    it('Super on + Shift on + right click adds no extra Shift', () => {
        const s = keys.createState();
        click(s, LSUPER);
        click(s, LSHIFT);
        equal(keys.press(s, T, 3), [dn(125), dn(20)]);
        equal(keys.release(s, 3), [up(20), up(125), up(42)]);
    });
    it('a blocked press with Super on does not count as a chord', () => {
        const s = keys.createState();
        click(s, LSUPER);
        click(s, LCTRL);
        click(s, LALT);
        equal(click(s, F5), [[], []]);
        equal(click(s, LSUPER)[1], [dn(125), up(125)]);
    });
    it('releaseAll mid chord releases click-added keys before toggled modifiers', () => {
        const s = keys.createState();
        click(s, LCTRL);
        click(s, LSUPER);
        keys.press(s, T, 3);
        equal(keys.releaseAll(s), [up(20), up(42), up(125), up(29)]);
    });
    it('a modifier turned on with one button can be locked and cleared with the other', () => {
        const s = keys.createState();
        click(s, LCTRL, 1);
        equal(click(s, LCTRL, 3), [[], []]);
        equal(click(s, LCTRL, 1), [[up(29)], []]);
        click(s, LALT, 3);
        click(s, LALT, 1);
        equal(click(s, LALT, 3), [[up(56)], []]);
    });
    it('a modifier press during an active claim does nothing', () => {
        const s = keys.createState();
        keys.press(s, T, 1);
        equal(keys.press(s, LCTRL, 1), []);
        equal(keys.snapshot(s).on, new Set());
    });
    it('a wrong-button release leaves a modifier claim active', () => {
        const s = keys.createState();
        keys.press(s, LCTRL, 1);
        equal(keys.release(s, 3), []);
        equal(keys.press(s, T, 1), []);
        keys.release(s, 1);
        equal(keys.press(s, T, 1), [dn(20)]);
    });
    it('blocked is cleared by the next successful press', () => {
        const s = keys.createState();
        click(s, LCTRL);
        click(s, LALT);
        keys.press(s, F5, 1);
        keys.release(s, 1);
        keys.press(s, F5, 1);
        equal(keys.snapshot(s).blocked, 63);
        keys.release(s, 1);
        keys.press(s, T, 1);   // a normal key uses up ctrl+alt
        equal(keys.snapshot(s).blocked, null);
    });
    it('a wrong-button release does not clear the blocked flash', () => {
        const s = keys.createState();
        click(s, LCTRL);
        click(s, LALT);
        keys.press(s, F5, 1);
        keys.release(s, 3);
        equal(keys.snapshot(s).blocked, 63);
    });
});

// A blocked press types nothing, so it must not use up the one-shot modifiers:
// the user can pick a different key.
describe('one-shot vs blocked', () => {
    it('a VT-blocked key leaves one-shot modifiers on', () => {
        const s = keys.createState();
        click(s, LCTRL);
        click(s, LALT);
        equal(click(s, F5), [[], []]);
        equal(keys.snapshot(s).on, new Set([29, 56]));
        equal(click(s, T), [[dn(20)], [up(20), up(56), up(29)]]);
    });
    it('a locked ctrl+alt still blocks F-keys', () => {
        const s = keys.createState();
        click(s, LCTRL); click(s, LCTRL);
        click(s, LALT); click(s, LALT);
        equal(click(s, F5), [[], []]);
        equal(keys.snapshot(s).blocked, null);   // cleared again by the release
    });
});

// More edge cases from review of the one-shot change.
describe('one-shot edge cases', () => {
    it('a Super tap does not use up a one-shot modifier', () => {
        const s = keys.createState();
        click(s, LCTRL);
        click(s, LSUPER);
        equal(click(s, LSUPER)[1], [dn(125), up(125)]);
        equal(keys.snapshot(s).on, new Set([29]));
    });
    it('releaseAll mid click leaves no stale state', () => {
        const s = keys.createState();
        click(s, LCTRL);
        keys.press(s, T, 1);
        equal(keys.releaseAll(s), [up(20), up(29)]);
        equal(keys.release(s, 1), []);
        equal(click(s, LCTRL), [[dn(29)], []]);
    });
    it('a Super chord turns Super off but keeps a locked modifier', () => {
        const s = keys.createState();
        click(s, LCTRL);
        click(s, LCTRL);
        click(s, LSUPER);
        equal(click(s, T), [[dn(125), dn(20)], [up(20), up(125)]]);
        equal(keys.snapshot(s).on, new Set([29]));
        equal(keys.snapshot(s).locked, new Set([29]));
    });
    it('a Super chord also uses up a one-shot modifier', () => {
        const s = keys.createState();
        click(s, LCTRL);
        click(s, LSUPER);
        equal(click(s, T)[1], [up(20), up(125), up(29)]);
        equal(keys.snapshot(s).on, new Set());
    });
    it('locked modifiers survive a blocked key', () => {
        const s = keys.createState();
        click(s, LCTRL); click(s, LCTRL);
        click(s, LALT); click(s, LALT);
        click(s, F5);
        equal(keys.snapshot(s).locked, new Set([29, 56]));
        equal(keys.snapshot(s).pressed, new Set([29, 56]));
    });
});
