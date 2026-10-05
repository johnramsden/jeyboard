// Unit tests for extension/layout.js (validation, geometry, hit-testing and
// placement math) and for the data in extension/layouts/us.js.
// Run with `make test` (tests/run.js supplies describe/it/equal/throws).
//
// READING GUIDE (for developers new to GNOME extensions or JavaScript)
//
// Terms: a layout is plain data listing keys with positions in 'u' units (1u =
// width of an ordinary key); geometry() converts those to pixels for a given
// panel width; hit-testing finds what is under a pointer position; the work
// area is the screen region not covered by the top bar and similar. Details
// are at the top of extension/layout.js and in docs/SPEC.md sections 7 and 8.
//
// The '\u2191' strings are escapes for arrow characters, so this file stays ASCII.
import * as layout from '../extension/layout.js';
import us from '../extension/layouts/us.js';

// Test helpers. key(code, x, y, extra) builds a minimal layout entry with the
// label 'k'; `extra` adds w, h, role, etc. small(keys) wraps keys in a layout
// that is 10u wide and 3u tall. Codes 1 (Esc) and 59 (F1) are valid ones.

const key = (code, x, y, extra = {}) => Object.assign({code, x, y, label: 'k'}, extra);
const small = keys => ({size: [10, 3], keys});

// validate() throws on malformed layouts. throws(fn, 'text') also checks that
// the error message mentions 'text', so each test fails for the right reason.
describe('validate', () => {
    it('accepts a small valid layout', () => {
        layout.validate(small([key(1, 0, 0), key(59, 1, 0)]));
    });
    it('rejects missing fields', () => {
        throws(() => layout.validate(small([{code: 1, x: 0, y: 0}])), 'label');
        throws(() => layout.validate(small([{code: 1, y: 0, label: 'a'}])), 'numeric');
        throws(() => layout.validate({keys: []}), 'size');
        throws(() => layout.validate({size: [1, 1]}), 'keys');
    });
    it('rejects bad types and sizes', () => {
        throws(() => layout.validate(small([key(1, '0', 0)])), 'numeric');
        throws(() => layout.validate(small([key(1, 0, 0, {w: 0})])), 'w must');
        throws(() => layout.validate(small([key(1, 0, 0, {h: -1})])), 'h must');
    });
    it('rejects an unknown code', () => {
        throws(() => layout.validate(small([key(500, 0, 0)])), 'unknown code');
    });
    it('rejects duplicate codes', () => {
        throws(() => layout.validate(small([key(1, 0, 0), key(1, 2, 0)])), 'duplicate');
    });
    // Key rectangles are half-open, so two keys that share an edge (first
    // ends at x=2, second starts at x=2) are fine; real overlap is an error.
    it('rejects overlaps but allows touching', () => {
        throws(() => layout.validate(small([key(1, 0, 0, {w: 2}), key(59, 1, 0)])), 'overlaps');
        layout.validate(small([key(1, 0, 0, {w: 2}), key(59, 2, 0)]));
    });
    it('rejects keys outside size', () => {
        throws(() => layout.validate(small([key(1, 9.5, 0)])), 'outside');
        throws(() => layout.validate(small([key(1, 0, 2.5)])), 'outside');
        throws(() => layout.validate(small([key(1, -1, 0)])), 'outside');
    });
    // Only the eight modifier codes carry a role, and each must carry the
    // right one: 42 is a shift, not a ctrl; code 1 (Esc) has no role.
    it('rejects a missing or misplaced role', () => {
        throws(() => layout.validate(small([key(42, 0, 0)])), 'role');
        throws(() => layout.validate(small([key(42, 0, 0, {role: 'ctrl'})])), 'role');
        throws(() => layout.validate(small([key(1, 0, 0, {role: 'shift'})])), 'role');
    });
});

describe('validate extras', () => {
    it('rejects non-positive size, null keys and bad optional types', () => {
        throws(() => layout.validate({size: [-1, 1], keys: []}), 'positive');
        throws(() => layout.validate(small([null])), 'object');
        throws(() => layout.validate(small([key(1, 0, 0, {shiftLabel: 5})])), 'shiftLabel');
        throws(() => layout.validate(small([key(1, 0, 0, {letter: 'yes'})])), 'letter');
    });
});

// SPEC 7.2: [code, x, y, w, h, label, secondary label]. Pins the data, not just its shape.
// This is a deliberate second copy of the layout, written independently from
// the spec table, so a typo in extension/layouts/us.js shows up as a mismatch
// instead of being trusted. x and y are in u. The optional last item is the
// shifted label for character keys, or the Num-Lock-off label for numpad keys.
// Arrows are written as \u2190 etc. (left/up/right/down) to keep this ASCII.
const TABLE = [
    [1,0,0,1,1,'Esc'],[59,2,0,1,1,'F1'],[60,3,0,1,1,'F2'],[61,4,0,1,1,'F3'],[62,5,0,1,1,'F4'],
    [63,6.5,0,1,1,'F5'],[64,7.5,0,1,1,'F6'],[65,8.5,0,1,1,'F7'],[66,9.5,0,1,1,'F8'],
    [67,11,0,1,1,'F9'],[68,12,0,1,1,'F10'],[87,13,0,1,1,'F11'],[88,14,0,1,1,'F12'],
    [99,15.25,0,1,1,'PrtSc'],[70,16.25,0,1,1,'ScrLk'],[119,17.25,0,1,1,'Pause'],
    [41,0,1.5,1,1,'`','~'],[2,1,1.5,1,1,'1','!'],[3,2,1.5,1,1,'2','@'],[4,3,1.5,1,1,'3','#'],
    [5,4,1.5,1,1,'4','$'],[6,5,1.5,1,1,'5','%'],[7,6,1.5,1,1,'6','^'],[8,7,1.5,1,1,'7','&'],
    [9,8,1.5,1,1,'8','*'],[10,9,1.5,1,1,'9','('],[11,10,1.5,1,1,'0',')'],[12,11,1.5,1,1,'-','_'],
    [13,12,1.5,1,1,'=','+'],[14,13,1.5,2,1,'Backspace'],
    [110,15.25,1.5,1,1,'Insert'],[102,16.25,1.5,1,1,'Home'],[104,17.25,1.5,1,1,'PgUp'],
    [69,18.5,1.5,1,1,'Num Lock'],[98,19.5,1.5,1,1,'/'],[55,20.5,1.5,1,1,'*'],[74,21.5,1.5,1,1,'-'],
    [15,0,2.5,1.5,1,'Tab'],[16,1.5,2.5,1,1,'q'],[17,2.5,2.5,1,1,'w'],[18,3.5,2.5,1,1,'e'],
    [19,4.5,2.5,1,1,'r'],[20,5.5,2.5,1,1,'t'],[21,6.5,2.5,1,1,'y'],[22,7.5,2.5,1,1,'u'],
    [23,8.5,2.5,1,1,'i'],[24,9.5,2.5,1,1,'o'],[25,10.5,2.5,1,1,'p'],
    [26,11.5,2.5,1,1,'[','{'],[27,12.5,2.5,1,1,']','}'],[43,13.5,2.5,1.5,1,'\\','|'],
    [111,15.25,2.5,1,1,'Delete'],[107,16.25,2.5,1,1,'End'],[109,17.25,2.5,1,1,'PgDn'],
    [71,18.5,2.5,1,1,'7','Home'],[72,19.5,2.5,1,1,'8','\u2191'],[73,20.5,2.5,1,1,'9','PgUp'],
    [78,21.5,2.5,1,2,'+'],
    [58,0,3.5,1.75,1,'Caps Lock'],[30,1.75,3.5,1,1,'a'],[31,2.75,3.5,1,1,'s'],[32,3.75,3.5,1,1,'d'],
    [33,4.75,3.5,1,1,'f'],[34,5.75,3.5,1,1,'g'],[35,6.75,3.5,1,1,'h'],[36,7.75,3.5,1,1,'j'],
    [37,8.75,3.5,1,1,'k'],[38,9.75,3.5,1,1,'l'],[39,10.75,3.5,1,1,';',':'],
    [40,11.75,3.5,1,1,"'",'"'],[28,12.75,3.5,2.25,1,'Enter'],
    [75,18.5,3.5,1,1,'4','\u2190'],[76,19.5,3.5,1,1,'5'],[77,20.5,3.5,1,1,'6','\u2192'],
    [42,0,4.5,2.25,1,'Shift'],[44,2.25,4.5,1,1,'z'],[45,3.25,4.5,1,1,'x'],[46,4.25,4.5,1,1,'c'],
    [47,5.25,4.5,1,1,'v'],[48,6.25,4.5,1,1,'b'],[49,7.25,4.5,1,1,'n'],[50,8.25,4.5,1,1,'m'],
    [51,9.25,4.5,1,1,',','<'],[52,10.25,4.5,1,1,'.','>'],[53,11.25,4.5,1,1,'/','?'],
    [54,12.25,4.5,2.75,1,'Shift'],[103,16.25,4.5,1,1,'\u2191'],
    [79,18.5,4.5,1,1,'1','End'],[80,19.5,4.5,1,1,'2','\u2193'],[81,20.5,4.5,1,1,'3','PgDn'],
    [96,21.5,4.5,1,2,'Enter'],
    [29,0,5.5,1.25,1,'Ctrl'],[125,1.25,5.5,1.25,1,'Super'],[56,2.5,5.5,1.25,1,'Alt'],
    [57,3.75,5.5,6.25,1,'Space'],[100,10,5.5,1.25,1,'Alt'],[126,11.25,5.5,1.25,1,'Super'],
    [127,12.5,5.5,1.25,1,'Menu'],[97,13.75,5.5,1.25,1,'Ctrl'],
    [105,15.25,5.5,1,1,'\u2190'],[108,16.25,5.5,1,1,'\u2193'],[106,17.25,5.5,1,1,'\u2192'],
    [82,18.5,5.5,2,1,'0','Ins'],[83,20.5,5.5,1,1,'.','Del'],
];

// Compare every key in us.js with TABLE above.
describe('us layout matches SPEC 7.2', () => {
    it('pins every key', () => {
        equal(TABLE.length, 104);
        for (const [code, x, y, w, h, label, second] of TABLE) {
            const k = us.keys.find(e => e.code === code);
            equal(k !== undefined, true);
            equal([k.x, k.y, k.w || 1, k.h || 1, k.label], [x, y, w, h, label]);
            // The secondary label is shiftLabel on character keys, numLockOffLabel on the numpad.
            equal(k.shiftLabel || k.numLockOffLabel, second);
        }
    });
    it('letters are exactly a-z', () => {
        equal(us.keys.filter(k => k.letter).map(k => k.label).sort().join(''), 'abcdefghijklmnopqrstuvwxyz');
    });
});

// Structural properties of the real layout, independent of TABLE.
describe('us layout', () => {
    it('has exactly 104 keys and validates', () => {
        equal(us.keys.length, 104);
        layout.validate(us);
    });
    // The main block is 15u wide on every row, so the right-hand edge is
    // straight (x < 15 selects the main block, excluding nav keys and numpad).
    it('main-block rows end at x=15', () => {
        const ends = {};
        for (const k of us.keys) {
            if (k.x < 15)
                ends[k.y] = Math.max(ends[k.y] || 0, k.x + (k.w || 1));
        }
        equal([ends[1.5], ends[2.5], ends[3.5], ends[4.5]], [15, 15, 15, 15]);
    });
    it('only the eight modifiers have roles', () => {
        equal(us.keys.filter(k => k.role).map(k => k.code).sort((a, b) => a - b),
            [29, 42, 54, 56, 97, 100, 125, 126]);
    });
});

// geometry(layout, width): panel width 2300 px, so u = 2300 / (22.5 + 2 * 0.25
// padding) = 2300 / 23 = 100 px per unit; round numbers keep the expected
// values easy to check. Panel height = u * (6.5 + 0.25 + 0.25 + 0.5 header).
// Key rectangles start at x = padding (25 px) and y = padding + header (75 px).
describe('geometry', () => {
    const g = layout.geometry(us, 2300);  // u = 100

    it('follows the spec formulas', () => {
        equal(g.u, 100);
        equal(g.width, 2300);
        equal(g.height, 100 * (6.5 + 0.5 + 0.5));
    });
    it('minWidth uses a 24 px pitch', () => {
        equal(layout.minWidth(us), 24 * 23);
    });
    it('keys start inside the padding, below the header', () => {
        const esc = g.cells.find(c => c.key.code === 1);
        equal([esc.x, esc.y, esc.w, esc.h], [25, 75, 100, 100]);
    });
    it('keeps the close and grip buttons square, close at the right end', () => {
        equal(g.close, {x: 2300 - 25 - 50, y: 25, w: 50, h: 50});
        equal(g.grip, {x: 2300 - 25 - 100, y: 25, w: 50, h: 50});
    });
    it('header does not overlap any key', () => {
        for (const c of g.cells)
            equal(c.y >= g.header.y + g.header.h, true);
    });
});

// hitTest(geo, x, y): what is at a point in panel-local pixels? Priority is
// close button > grip > header > key > none. Rectangles are half-open (left
// and top edges inclusive, right and bottom exclusive), so touching rectangles
// never both claim one point. Coordinates below are written as
// "25 + column * 100" (panel padding plus u-offset times 100 px per u), and
// "75 + row * 100" (padding plus header plus rows). Esc is at the top-left of
// the key area, so its cell spans x 25..125 and y 75..175.
describe('hitTest', () => {
    const g = layout.geometry(us, 2300);
    const at = (x, y) => layout.hitTest(g, x, y);
    const code = (x, y) => at(x, y).key.code;

    it('hits the close button, grip and header in that order', () => {
        equal(at(2230, 50).type, 'close');
        equal(at(2200, 50).type, 'grip');
        equal(at(500, 50).type, 'header');
        equal(at(500, 10).type, 'header');
    });
    it('close and grip win over the header they sit in', () => {
        equal(at(g.close.x, g.close.y).type, 'close');
        equal(at(g.grip.x, g.grip.y).type, 'grip');
        equal(at(g.grip.x - 1, g.grip.y).type, 'header');
    });
    it('hits keys at their edges (half-open cells)', () => {
        equal(code(25, 75), 1);              // Esc top-left corner
        equal(code(124.9, 174.9), 1);        // Esc bottom-right inside
        equal(at(125, 75).type, 'none');     // gap before F1 at 2u
        equal(code(225, 75), 59);            // F1
    });
    it('misses in gaps and padding', () => {
        equal(at(10, 300).type, 'none');                 // left padding
        equal(at(25 + 15.1 * 100, 75).type, 'none');     // gap between F12 and PrtSc, y=0 row
        equal(at(25 + 15 * 100 + 10, 75 + 150 + 10).type, 'none');
    });
    it('finds tall and wide keys', () => {
        const kx = 25 + 21.5 * 100 + 10;
        equal(code(kx, 75 + 250 + 10), 78);          // KP+ top
        equal(code(kx, 75 + 350 + 10), 78);          // KP+ second row
        equal(code(kx, 75 + 450 + 10), 96);          // KPEnter top
        equal(code(kx, 75 + 550 + 10), 96);          // KPEnter bottom row
        equal(code(25 + 19 * 100, 75 + 550 + 10), 82);  // KP0 spans two cells
        equal(code(25 + 20.4 * 100, 75 + 550 + 10), 82);
        equal(code(25 + 20.6 * 100, 75 + 550 + 10), 83);
    });
    it('Space is wide', () => {
        equal(code(25 + 3.8 * 100, 75 + 550 + 10), 57);
        equal(code(25 + 9.9 * 100, 75 + 550 + 10), 57);
    });
    // Guards against a key being completely shadowed by another rectangle.
    it('every key is hittable at its centre', () => {
        for (const c of g.cells)
            equal(at(c.x + c.w / 2, c.y + c.h / 2).key.code, c.key.code);
    });
});

// Placement math: where the panel goes on a monitor. `area` is the work area
// in stage px; saved geometry is stored as fractions of it so it survives a
// resolution change. Panel size ratio: height/width = 7.5 / 23 for the us
// layout (the 7.5 is 6.5 + padding + header; the 23 is 22.5 + padding).
describe('placement', () => {
    const area = {x: 100, y: 50, width: 2000, height: 1000};

    it('panelWidth honours the fraction, the minimum pitch and the work area', () => {
        equal(layout.panelWidth(us, area, 0.6), 1200);
        equal(layout.panelWidth(us, area, 0.1), layout.minWidth(us));
        equal(layout.panelWidth(us, area, 1), 2000);
        // height-limited: 7.5/23 of the width must fit in 500 px of height
        const short = {x: 0, y: 0, width: 2000, height: 500};
        equal(Math.round(layout.panelWidth(us, short, 1)), Math.round(500 * 23 / 7.5));
        const narrow = {x: 0, y: 0, width: 300, height: 1000};
        equal(layout.panelWidth(us, narrow, 0.6), 300);
    });
    it('default position is bottom centre', () => {
        const r = layout.rectFromSaved(us, area, {x: -1, y: -1, width: 0.6});
        equal(r.width, 1200);
        equal(r.x, 100 + 400);
        equal(r.y + r.height, 50 + 1000);
    });
    it('restores a saved fractional position', () => {
        const r = layout.rectFromSaved(us, area, {x: 0.1, y: 0.2, width: 0.5});
        equal([r.x, r.y, r.width], [300, 250, 1000]);
    });
    it('clamps into the work area', () => {
        const r = layout.rectFromSaved(us, area, {x: 0.9, y: 0.95, width: 0.5});
        equal(r.x + r.width <= 2100, true);
        equal(r.y + r.height <= 1050, true);
        equal(layout.clampRect({x: -50, y: -50, width: 10, height: 10}, area).x, 100);
    });
    it('save and restore round-trip', () => {
        const r = {x: 700, y: 300, width: 1000, height: 326.08};
        const s = layout.savedFromRect(r, area);
        equal([s.x, s.y, s.width], [0.3, 0.25, 0.5]);
    });
});
