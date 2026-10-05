// Owns: the modifier state machine and the ledger of pressed codes (docs/SPEC.md 6).
// Must not: import anything, touch GNOME, or know about pixels. Plain data in,
// plain actions ([{code, pressed}]) out. ES2016 only.
//
// READING GUIDE (for developers new to GNOME extensions or JavaScript)
//
// What this file is: jeyboard is an on-screen keyboard. The GNOME-specific code
// (elsewhere) turns mouse clicks into calls to the functions below. Each call
// takes the current state plus "which key, which mouse button" and returns a
// list of ACTIONS: objects like {code: 42, pressed: true}, meaning "send a
// key-down for key 42" (pressed: false means key-up). Another module
// (typer.js) feeds those actions to the system as if a real keyboard
// produced them. Because this file only computes lists and never sends
// anything, it can be unit tested with plain `gjs` (see tests/keys.test.js).
//
// Domain terms used throughout:
// - evdev key code: the number the Linux kernel uses to name a physical key
//   (for example 42 = Left Shift, 125 = Left Super). They come from
//   linux/input-event-codes.h and are the same on every keyboard layout; the
//   system keymap later decides what character a code types.
// - modifier: a key that changes what other keys do (Shift, Ctrl, Alt, Super).
//   A layout entry carries a `role` ('shift', 'ctrl', 'alt', 'super') which
//   marks it as a modifier. This file never hard-codes which codes are
//   modifiers; it only looks at `role`.
// - one-shot / lock: a mouse cannot hold Ctrl and click at once, so modifiers
//   latch. Clicking Shift/Ctrl/Alt once turns it "on" (really held down) UNTIL
//   the next normal key is typed, which uses it and then lets it go. Clicking an
//   "on" modifier a second time LOCKS it: it stays held across keys until
//   clicked once more (which turns it off). Several modifiers can be on at
//   once and are all let go together by the next normal key (locked ones stay).
// - chord: several keys pressed together, such as Ctrl+Shift+T.
// - tap: pressing and immediately releasing a key (used for Super, below).
// - ledger: the list of key codes this module has pressed and not yet
//   released, in press order. It is the single source of truth for "what is
//   physically down right now", so everything can always be released.
// - claim: a record of ONE mouse click in progress. It remembers which mouse
//   button started it and which codes that click pressed, so the matching
//   button release lets go of exactly those codes and nothing else.

// evdev codes this file needs to know about by name.
const LEFTSHIFT = 42;
const LEFTMETA = 125;  // "meta" is the kernel's name for the Super / Windows key
const RIGHTMETA = 126; // only so snapshot() can light both Super keys

// F1-F10, F11, F12. An explicit list: 69 and 70 (Num/Scroll Lock) sit between
// F10 and F11 and must never be blocked. A numeric range 59..88 would catch
// them, which is why this is a list and not a range.
// These are the keys that, with Ctrl+Alt held, make the system switch to a
// text console (a "VT", virtual terminal). See isVtBlocked() below.
const VT_CODES = [59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 87, 88];

// Build one action object.
function act(code, pressed) {
    return {code, pressed};
}

// Create a fresh, empty state. All other functions take this object as their
// first argument and mutate it in place; nothing is stored in module-level
// variables, so tests can make as many independent states as they like.
export function createState() {
    return {
        mods: new Map(),   // code -> role, for shift/ctrl/alt keys that are on or locked
        locked: new Set(), // the subset of mods that stays on after a normal key
        superOn: false,    // the one shared Super toggle (never physically held)
        ledger: [],        // codes currently pressed, in press order
        claim: null,       // {button, codes, tap, consume, consumeSuper} for the active click
        blocked: null,     // code of a VT-blocked press, for the view to flash
    };
}

// True if at least one toggled-on modifier has the given role. Used because
// "Ctrl is on" means either Left Ctrl or Right Ctrl, whichever was clicked.
function hasRole(state, role) {
    for (const r of state.mods.values()) {
        if (r === role)
            return true;
    }
    return false;
}

// Press one code on behalf of the current click: record it in the ledger (so
// it will be released), remember it in the claim (so THIS click's button
// release lets go of it), and append the key-down action.
// If the code is already down (in the ledger) it does nothing: pressing twice
// without a release would be a stuck-key hazard, and a key some other owner
// already holds (for example a toggled-on Shift) must not be released by this
// click. `claimCodes` is claim.codes of the click being built.
function pressCode(state, actions, claimCodes, code) {
    if (state.ledger.includes(code))
        return;
    state.ledger.push(code);
    claimCodes.push(code);
    actions.push(act(code, true));
}

// Handle a click on a modifier key (any button: left and right do the same).
// Returns the actions to send now. The claim it creates has no codes, so the
// later release() sends nothing - except the Super-off case, see below.
function toggleModifier(state, key, button) {
    const claim = {button, codes: [], tap: false, consume: [], consumeSuper: false};
    const actions = [];

    if (key.role === 'super') {
        // Super is special: it is NEVER physically held (no key-down is sent
        // when it turns on). Why: while Super is physically down, GNOME treats
        // mouse clicks on windows as window moves/resizes (Super is the
        // "mouse-button modifier"), which would break clicking the keyboard
        // and the apps under it. Also, the Activities overview opens on a
        // bare Super tap, and only if nothing else happens between the press
        // and the release, which a long toggle could not guarantee. So "Super
        // on" is only a highlighted state here; real Super is sent later,
        // either folded into a chord with the next key or as one quick tap.
        // The two Super keys share the single `superOn` flag.
        if (state.superOn) {
            state.superOn = false;
            // A bare tap, sent on release (docs/SPEC.md 6.3). (A chord turns Super off
            // by itself, so clicking Super while it is on always means "tap".)
            // It is deferred to the button RELEASE because mutter (GNOME's
            // window manager) cancels the overview tap if a mouse-button event
            // arrives between the Super press and release, and mutter sees
            // the real mouse button-up before our code does.
            claim.tap = true;
        } else {
            state.superOn = true;
        }
    } else if (state.mods.has(key.code) && !state.locked.has(key.code)) {
        // Already on (one-shot): a second click LOCKS it. Nothing is sent; it is
        // already held, it just no longer lets go after the next normal key.
        state.locked.add(key.code);
    } else if (state.mods.has(key.code)) {
        // Locked: a click turns it off (key-up now).
        state.mods.delete(key.code);
        state.locked.delete(key.code);
        state.ledger = state.ledger.filter(c => c !== key.code);
        actions.push(act(key.code, false));
    } else if (!state.ledger.includes(key.code)) {
        // Off -> on (one-shot): press and keep holding. The ledger check is a guard so the
        // same code is never put in the ledger twice.
        state.mods.set(key.code, key.role);
        state.ledger.push(key.code);
        actions.push(act(key.code, true));
    }

    // Even a toggle takes the single claim slot, so a second button pressed
    // during the click is ignored until this one is released.
    state.claim = claim;
    return actions;
}

// True if this key must be swallowed: an F-key while Ctrl and Alt are both on.
// Ctrl+Alt+F1..F12 switches virtual terminals in GNOME (mutter honours it even
// for synthetic keys, in every session mode including the lock screen), and
// switching to a text console would strand a user who only has a mouse.
function isVtBlocked(state, key) {
    return VT_CODES.includes(key.code) &&
        hasRole(state, 'ctrl') && hasRole(state, 'alt');
}

// A mouse button went down on `key` (a layout entry: {code, role?, ...}).
// button 1 = left, 3 = right (right adds Shift); anything else is ignored.
// Returns the key actions to send now.
//
// Press order matters: modifiers must be down BEFORE the key, because
// applications see the sequence of events. So the order is Super (if on),
// then Shift (if right click needs it), then the key itself. release() undoes
// them in reverse.
export function press(state, key, button) {
    // Only one click may be in progress at a time (matches input.js, which
    // follows a single claimed button sequence). A second press during a
    // click, or an unsupported button, does nothing and records nothing.
    if (state.claim || (button !== 1 && button !== 3))
        return [];
    state.blocked = null;

    if (key.role)
        return toggleModifier(state, key, button);

    const claim = {button, codes: [], tap: false, consume: [], consumeSuper: false};
    state.claim = claim;

    // A blocked key still gets a claim (so its release is consumed) but no
    // actions; `blocked` tells the view to flash the key.
    if (isVtBlocked(state, key)) {
        state.blocked = key.code;
        return [];
    }

    // One-shot modifiers (on but not locked) are used up by this key: remember
    // them now and let them go when the click is released, so the app sees
    // e.g. Ctrl down, G down, G up, Ctrl up. Locked ones are left alone.
    claim.consume = state.ledger.filter(c => state.mods.has(c) && !state.locked.has(c));
    claim.consumeSuper = state.superOn;

    const actions = [];
    if (state.superOn) {
        // Atomic chord: Super goes down only for the duration of this click.
        pressCode(state, actions, claim.codes, LEFTMETA);
    }
    // Right click = "with Shift". Skip it if any Shift is already on (left or
    // right), otherwise add a Left Shift that this click will also release.
    if (button === 3 && !hasRole(state, 'shift'))
        pressCode(state, actions, claim.codes, LEFTSHIFT);
    pressCode(state, actions, claim.codes, key.code);
    return actions;
}

// The mouse button came up. Releases exactly what THIS click pressed (the
// claim), newest first, so Super/Shift added for the click come off after the
// key. Then it uses up the one-shot modifiers this key consumed (and turns the
// Super toggle off if it was chorded); LOCKED modifiers are left held.
// Matching releases to the claim (not "release whatever is down") is what
// prevents stuck keys. Also emits the deferred bare Super tap if the claim
// asks for one.
// Returns [] if there is no claim or the button is not the claiming button
// (for example a release after releaseAll(), or a stray extra button).
export function release(state, button) {
    const claim = state.claim;
    if (!claim || claim.button !== button)
        return [];
    state.blocked = null;
    state.claim = null;

    const actions = [];
    // slice() copies the array so reverse() does not reorder claim.codes.
    for (const code of claim.codes.slice().reverse()) {
        // Skip codes releaseAll() or something else already let go of.
        if (!state.ledger.includes(code))
            continue;
        state.ledger = state.ledger.filter(c => c !== code);
        actions.push(act(code, false));
    }
    // Use up the one-shot modifiers, newest first, after the key itself.
    for (const code of claim.consume.slice().reverse()) {
        // Defensive: mods only change mid-claim through releaseAll(), which also
        // drops the claim, so this is normally never skipped.
        if (!state.mods.has(code) || state.locked.has(code))
            continue;
        state.mods.delete(code);
        state.ledger = state.ledger.filter(c => c !== code);
        actions.push(act(code, false));
    }
    if (claim.consumeSuper) {
        // The chord is done, so the Super toggle turns itself off. No tap: the
        // chord used it.
        state.superOn = false;
    }
    if (claim.tap)
        // The Super tap: down then up, back to back.
        actions.push(act(LEFTMETA, true), act(LEFTMETA, false));
    return actions;
}

// Panic button: release everything and forget everything. Called when the
// panel hides, the session locks, the keymap changes, and so on (docs/SPEC.md 6.6).
// Guarantees no key is left stuck down. Order: normal keys first, then
// toggled modifiers, each newest first, so a chord unwinds like a human
// letting go (the key before its modifiers).
export function releaseAll(state) {
    const isMod = code => state.mods.has(code);
    const ordered = state.ledger.slice().reverse();
    const actions = ordered.filter(c => !isMod(c)).map(c => act(c, false))
        .concat(ordered.filter(isMod).map(c => act(c, false)));

    state.mods.clear();
    state.locked.clear();
    state.ledger = [];
    state.superOn = false;
    // Dropping the claim means a later release() returns [] instead of
    // releasing something twice. Dropping a pending Super tap is intended.
    state.claim = null;
    state.blocked = null;
    return actions;
}

// Read-only view for drawing the keyboard (no state is changed):
// - on: codes to draw as "checked" (toggled modifiers; both Super keys when
//   Super is on, even though Super is not actually held),
// - locked: the subset of `on` that is locked (stays on after a normal key),
// - pressed: codes physically down right now (for the pressed look),
// - blocked: the VT-blocked code to flash, or null.
// Sets are copies, so callers cannot corrupt the state through them.
export function snapshot(state) {
    const on = new Set(state.mods.keys());
    if (state.superOn) {
        on.add(LEFTMETA);
        on.add(RIGHTMETA);
    }
    return {
        on,
        locked: new Set(state.locked),
        pressed: new Set(state.ledger),
        blocked: state.blocked,
    };
}
