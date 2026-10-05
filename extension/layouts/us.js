// Pure data: full-size US ANSI layout (docs/SPEC.md 7). No imports, ES2016 only.
// Codes are Linux evdev KEY_* values. Labels are US-only; typing sends codes,
// so on another system layout only the labels are off.
//
// READING GUIDE (for developers new to GNOME extensions or JavaScript)
//
// This file is only data: one object describing a full-size (104 key) US ANSI
// keyboard. layout.js validates it and turns it into screen rectangles;
// keys.js decides what clicking each key does. Nothing here runs any logic.
//
// Fields (the full format is docs/SPEC.md 7.1):
// - id / name: an identifier and a human-readable title.
// - size: [width, height] of the whole key area in 'u' units, where 1u is the
//   width of an ordinary key. 22.5u wide: the main block is 15u, then a 0.25u
//   gap (the main block ends at x=15, the next block starts at 15.25), the
//   3-key navigation block, another gap, and a 4-key-wide numpad. 6.5u tall:
//   the function row, a 0.5u gap, and five rows of 1u.
// - Per key:
//     code        Linux evdev key code (from linux/input-event-codes.h). This
//                 is what is actually sent; the system keymap turns it into a
//                 character. Example: 30 is the "A" key, 42 is Left Shift.
//     x, y        top-left corner in u, measured from the top-left of the key
//                 area. A row's y is 1 higher than the row above, except the
//                 gap after the function row (0 -> 1.5).
//     w, h        width and height in u; omitted means 1. Wide keys are Shift,
//                 Enter, Space and so on; the numpad "+" and Enter are 2u tall.
//     label       the text drawn on the key (the unshifted one).
//     shiftLabel  small secondary label for what a RIGHT click types (right
//                 click means "with Shift", docs/SPEC.md 6.2). Letters do not need
//                 one: they show upper case when Shift XOR Caps Lock is on.
//     numLockOffLabel
//                 for numpad keys: what the key does when Num Lock is off
//                 (Home, arrows, ...). `label` is used when Num Lock is on.
//     letter      true for a-z; the view swaps their case instead of showing
//                 a shiftLabel.
//     role        'shift' | 'ctrl' | 'alt' | 'super' on the eight modifier
//                 keys only. keys.js treats a key with a role as a modifier (one-shot, lockable).
// - Positions are written by hand and pinned by tests/layout.test.js (the
//   TABLE there is a second copy of this data), so a typo is caught.
// - Some labels are the Unicode arrows; the file is UTF-8, so they appear
//   directly as characters in strings. Comments stay ASCII.
export default {
    id: 'us-ansi-full',
    name: 'US English (full size)',
    size: [22.5, 6.5],
    keys: [
        // Row y=0: Esc, then F1-F4, F5-F8, F9-F12 in groups of four separated
        // by half-unit gaps like a physical keyboard, then PrtSc/ScrLk/Pause.
        // (code 99 is KEY_SYSRQ, the kernel's name for Print Screen.)
        {code: 1, x: 0, y: 0, label: 'Esc'},
        {code: 59, x: 2, y: 0, label: 'F1'},
        {code: 60, x: 3, y: 0, label: 'F2'},
        {code: 61, x: 4, y: 0, label: 'F3'},
        {code: 62, x: 5, y: 0, label: 'F4'},
        {code: 63, x: 6.5, y: 0, label: 'F5'},
        {code: 64, x: 7.5, y: 0, label: 'F6'},
        {code: 65, x: 8.5, y: 0, label: 'F7'},
        {code: 66, x: 9.5, y: 0, label: 'F8'},
        {code: 67, x: 11, y: 0, label: 'F9'},
        {code: 68, x: 12, y: 0, label: 'F10'},
        {code: 87, x: 13, y: 0, label: 'F11'},
        {code: 88, x: 14, y: 0, label: 'F12'},
        {code: 99, x: 15.25, y: 0, label: 'PrtSc'},
        {code: 70, x: 16.25, y: 0, label: 'ScrLk'},
        {code: 119, x: 17.25, y: 0, label: 'Pause'},
        // Row y=1.5: number row. Backspace is 2u wide. Then Insert/Home/PgUp,
        // then the numpad's top row (Num Lock and the operators).
        {code: 41, x: 0, y: 1.5, label: '`', shiftLabel: '~'},
        {code: 2, x: 1, y: 1.5, label: '1', shiftLabel: '!'},
        {code: 3, x: 2, y: 1.5, label: '2', shiftLabel: '@'},
        {code: 4, x: 3, y: 1.5, label: '3', shiftLabel: '#'},
        {code: 5, x: 4, y: 1.5, label: '4', shiftLabel: '$'},
        {code: 6, x: 5, y: 1.5, label: '5', shiftLabel: '%'},
        {code: 7, x: 6, y: 1.5, label: '6', shiftLabel: '^'},
        {code: 8, x: 7, y: 1.5, label: '7', shiftLabel: '&'},
        {code: 9, x: 8, y: 1.5, label: '8', shiftLabel: '*'},
        {code: 10, x: 9, y: 1.5, label: '9', shiftLabel: '('},
        {code: 11, x: 10, y: 1.5, label: '0', shiftLabel: ')'},
        {code: 12, x: 11, y: 1.5, label: '-', shiftLabel: '_'},
        {code: 13, x: 12, y: 1.5, label: '=', shiftLabel: '+'},
        {code: 14, x: 13, y: 1.5, w: 2, label: 'Backspace'},
        {code: 110, x: 15.25, y: 1.5, label: 'Insert'},
        {code: 102, x: 16.25, y: 1.5, label: 'Home'},
        {code: 104, x: 17.25, y: 1.5, label: 'PgUp'},
        {code: 69, x: 18.5, y: 1.5, label: 'Num Lock'},
        {code: 98, x: 19.5, y: 1.5, label: '/'},
        {code: 55, x: 20.5, y: 1.5, label: '*'},
        {code: 74, x: 21.5, y: 1.5, label: '-'},
        // Row y=2.5: Tab (1.5u), the QWERTY letters, and the 1.5u backslash.
        // Then Delete/End/PgDn and numpad 7 8 9 and the tall '+' (h: 2).
        {code: 15, x: 0, y: 2.5, w: 1.5, label: 'Tab'},
        {code: 16, x: 1.5, y: 2.5, label: 'q', letter: true},
        {code: 17, x: 2.5, y: 2.5, label: 'w', letter: true},
        {code: 18, x: 3.5, y: 2.5, label: 'e', letter: true},
        {code: 19, x: 4.5, y: 2.5, label: 'r', letter: true},
        {code: 20, x: 5.5, y: 2.5, label: 't', letter: true},
        {code: 21, x: 6.5, y: 2.5, label: 'y', letter: true},
        {code: 22, x: 7.5, y: 2.5, label: 'u', letter: true},
        {code: 23, x: 8.5, y: 2.5, label: 'i', letter: true},
        {code: 24, x: 9.5, y: 2.5, label: 'o', letter: true},
        {code: 25, x: 10.5, y: 2.5, label: 'p', letter: true},
        {code: 26, x: 11.5, y: 2.5, label: '[', shiftLabel: '{'},
        {code: 27, x: 12.5, y: 2.5, label: ']', shiftLabel: '}'},
        {code: 43, x: 13.5, y: 2.5, w: 1.5, label: '\\', shiftLabel: '|'},
        {code: 111, x: 15.25, y: 2.5, label: 'Delete'},
        {code: 107, x: 16.25, y: 2.5, label: 'End'},
        {code: 109, x: 17.25, y: 2.5, label: 'PgDn'},
        {code: 71, x: 18.5, y: 2.5, label: '7', numLockOffLabel: 'Home'},
        {code: 72, x: 19.5, y: 2.5, label: '8', numLockOffLabel: '↑'},
        {code: 73, x: 20.5, y: 2.5, label: '9', numLockOffLabel: 'PgUp'},
        {code: 78, x: 21.5, y: 2.5, h: 2, label: '+'},
        // Row y=3.5: Caps Lock (1.75u), the home row, and Enter (2.25u).
        // The numpad 5 has no numLockOffLabel: with Num Lock off it does
        // nothing useful. There is no navigation-block key on this row.
        {code: 58, x: 0, y: 3.5, w: 1.75, label: 'Caps Lock'},
        {code: 30, x: 1.75, y: 3.5, label: 'a', letter: true},
        {code: 31, x: 2.75, y: 3.5, label: 's', letter: true},
        {code: 32, x: 3.75, y: 3.5, label: 'd', letter: true},
        {code: 33, x: 4.75, y: 3.5, label: 'f', letter: true},
        {code: 34, x: 5.75, y: 3.5, label: 'g', letter: true},
        {code: 35, x: 6.75, y: 3.5, label: 'h', letter: true},
        {code: 36, x: 7.75, y: 3.5, label: 'j', letter: true},
        {code: 37, x: 8.75, y: 3.5, label: 'k', letter: true},
        {code: 38, x: 9.75, y: 3.5, label: 'l', letter: true},
        {code: 39, x: 10.75, y: 3.5, label: ';', shiftLabel: ':'},
        {code: 40, x: 11.75, y: 3.5, label: '\'', shiftLabel: '"'},
        {code: 28, x: 12.75, y: 3.5, w: 2.25, label: 'Enter'},
        {code: 75, x: 18.5, y: 3.5, label: '4', numLockOffLabel: '←'},
        {code: 76, x: 19.5, y: 3.5, label: '5'},
        {code: 77, x: 20.5, y: 3.5, label: '6', numLockOffLabel: '→'},
        // Row y=4.5: the two Shift keys (2.25u and 2.75u) with the bottom
        // letter row between them, the Up arrow, and numpad 1 2 3 and the
        // tall numpad Enter (h: 2). The Shifts have role 'shift': they are modifiers.
        {code: 42, x: 0, y: 4.5, w: 2.25, label: 'Shift', role: 'shift'},
        {code: 44, x: 2.25, y: 4.5, label: 'z', letter: true},
        {code: 45, x: 3.25, y: 4.5, label: 'x', letter: true},
        {code: 46, x: 4.25, y: 4.5, label: 'c', letter: true},
        {code: 47, x: 5.25, y: 4.5, label: 'v', letter: true},
        {code: 48, x: 6.25, y: 4.5, label: 'b', letter: true},
        {code: 49, x: 7.25, y: 4.5, label: 'n', letter: true},
        {code: 50, x: 8.25, y: 4.5, label: 'm', letter: true},
        {code: 51, x: 9.25, y: 4.5, label: ',', shiftLabel: '<'},
        {code: 52, x: 10.25, y: 4.5, label: '.', shiftLabel: '>'},
        {code: 53, x: 11.25, y: 4.5, label: '/', shiftLabel: '?'},
        {code: 54, x: 12.25, y: 4.5, w: 2.75, label: 'Shift', role: 'shift'},
        {code: 103, x: 16.25, y: 4.5, label: '↑'},
        {code: 79, x: 18.5, y: 4.5, label: '1', numLockOffLabel: 'End'},
        {code: 80, x: 19.5, y: 4.5, label: '2', numLockOffLabel: '↓'},
        {code: 81, x: 20.5, y: 4.5, label: '3', numLockOffLabel: 'PgDn'},
        {code: 96, x: 21.5, y: 4.5, h: 2, label: 'Enter'},
        // Row y=5.5: the bottom row. Ctrl, Super and Alt on the left and Alt,
        // Super, Menu and Ctrl on the right (all four modifier kinds carry a
        // role); Space is 6.25u wide. Code 127 (KEY_COMPOSE) is the Menu key,
        // an ordinary key. Then the Left/Down/Right arrows and numpad 0 (2u
        // wide) and '.'. The Super keys share one toggle (docs/SPEC.md 6.3).
        {code: 29, x: 0, y: 5.5, w: 1.25, label: 'Ctrl', role: 'ctrl'},
        {code: 125, x: 1.25, y: 5.5, w: 1.25, label: 'Super', role: 'super'},
        {code: 56, x: 2.5, y: 5.5, w: 1.25, label: 'Alt', role: 'alt'},
        {code: 57, x: 3.75, y: 5.5, w: 6.25, label: 'Space'},
        {code: 100, x: 10, y: 5.5, w: 1.25, label: 'Alt', role: 'alt'},
        {code: 126, x: 11.25, y: 5.5, w: 1.25, label: 'Super', role: 'super'},
        {code: 127, x: 12.5, y: 5.5, w: 1.25, label: 'Menu'},
        {code: 97, x: 13.75, y: 5.5, w: 1.25, label: 'Ctrl', role: 'ctrl'},
        {code: 105, x: 15.25, y: 5.5, label: '←'},
        {code: 108, x: 16.25, y: 5.5, label: '↓'},
        {code: 106, x: 17.25, y: 5.5, label: '→'},
        {code: 82, x: 18.5, y: 5.5, w: 2, label: '0', numLockOffLabel: 'Ins'},
        {code: 83, x: 20.5, y: 5.5, label: '.', numLockOffLabel: 'Del'},
    ],
};
