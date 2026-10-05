// Owns: layout validation, panel geometry and hit-testing (docs/SPEC.md 7, 8).
// Must not: import anything or touch GNOME. Pixels in, plain rects out. ES2016 only.
//
// READING GUIDE (for developers new to GNOME extensions or JavaScript)
//
// What this file does: it takes a keyboard LAYOUT (plain data describing every
// key's position, see layouts/us.js) and answers three questions:
//   1. Is the layout well formed?                  -> validate()
//   2. Given a panel width in pixels, where is each key on screen?
//                                                  -> geometry()
//   3. Given a mouse position, what is under it?   -> hitTest()
// plus the math for sizing and positioning the whole panel on a monitor
// (panelWidth, clampRect, rectFromSaved, savedFromRect).
// It draws nothing and imports nothing; view.js does the drawing.
//
// Domain terms:
// - 'u' units: layout coordinates are measured in key widths. 1u is the width
//   of an ordinary key (the "key pitch": distance from one key's left edge to
//   the next). A 2.25u Shift key is 2.25 ordinary keys wide. Using units lets
//   the same layout scale to any panel width: pixels = u * pixelsPerU.
// - evdev code: the Linux kernel's number for a physical key (42 = Left
//   Shift). Layout entries are identified by it.
// - role: marks modifier keys ('shift', 'ctrl', 'alt', 'super'); see keys.js.
// - half-open rectangle: a rectangle that includes its left and top edges but
//   not its right and bottom edges, [x, x+w) and [y, y+h). With it, two
//   rectangles that touch share no pixel, so every point belongs to at most
//   one neighbouring key and there is no ambiguity on a shared border.
// - work area: the part of a monitor not covered by the top bar, dock and
//   similar shell furniture. The panel is kept inside it.
// - stage px: the pixels Clutter positions actors in (logical, scaled pixels). All
//   pixel numbers here are stage px; the view converts for CSS.

// The 104 evdev codes of the US ANSI full-size layout (docs/SPEC.md 7.2). A layout
// may only use codes from this list, which catches typos in layout data (a
// wrong number would otherwise silently type the wrong key). The order is just
// the layout's reading order: function row, number row, and so on.
const KNOWN_CODES = [
    1, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 87, 88, 99, 70, 119,
    41, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 110, 102, 104, 69, 98, 55, 74,
    15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 43, 111, 107, 109, 71, 72, 73, 78,
    58, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 28, 75, 76, 77,
    42, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 103, 79, 80, 81, 96,
    29, 125, 56, 57, 100, 126, 127, 97, 105, 108, 106, 82, 83,
];

// Which codes are modifiers, and of what kind. The layout must put `role` on
// exactly these eight keys and nowhere else (checked in checkKey). The role
// is what keys.js uses to decide toggle behaviour, so a missing or extra role
// would change behaviour silently. Looking up a code that is not here gives
// `undefined`, which is what an ordinary key's missing `role` also is, so the
// single comparison in checkKey covers both directions.
const ROLE_BY_CODE = {
    42: 'shift', 54: 'shift',
    29: 'ctrl', 97: 'ctrl',
    56: 'alt', 100: 'alt',
    125: 'super', 126: 'super',
};

// EPS is a tiny tolerance for floating point comparisons: fractions such as
// 0.25 are exact in binary but sums of others may not be, so "touching" and
// "just fits" tests allow a rounding error of 1e-9 (a billionth of a u).
const EPS = 1e-9;
const PAD = 0.25;     // panel padding, in u
const HEADER = 0.5;   // header height, in u (the buttons are HEADER x HEADER)
const MIN_PITCH = 24; // smallest key pitch, in logical px

// Reject the layout by throwing an Error. The message always starts with
// "invalid layout:" so a failure is easy to spot in logs.
function fail(msg) {
    throw new Error(`invalid layout: ${msg}`);
}

// True for real, finite numbers. isFinite() rejects NaN and Infinity, and
// typeof rejects strings such as '0' that JavaScript would otherwise coerce.
function isNum(v) {
    return typeof v === 'number' && isFinite(v);
}

// Check one key entry against the format in docs/SPEC.md 7.1. `size` is the
// layout's [width, height] in u. Throws (via fail) on the first problem.
function checkKey(key, size) {
    if (key === null || typeof key !== 'object')
        fail('key must be an object');
    if (!isNum(key.code) || !isNum(key.x) || !isNum(key.y) || typeof key.label !== 'string')
        fail('key needs numeric code, x, y and a string label');
    // Optional fields may be absent (undefined) but, if present, must be of the
    // right type.
    for (const f of ['shiftLabel', 'numLockOffLabel']) {
        if (key[f] !== undefined && typeof key[f] !== 'string')
            fail(`${f} must be a string (code ${key.code})`);
    }
    if (key.letter !== undefined && typeof key.letter !== 'boolean')
        fail(`letter must be a boolean (code ${key.code})`);
    for (const f of ['w', 'h']) {
        if (key[f] !== undefined && !(isNum(key[f]) && key[f] > 0))
            fail(`${f} must be a number > 0 (code ${key.code})`);
    }
    if (!KNOWN_CODES.includes(key.code))
        fail(`unknown code ${key.code}`);
    // Role must equal the table's role for this code (both undefined for
    // ordinary keys), see ROLE_BY_CODE above.
    if (key.role !== ROLE_BY_CODE[key.code])
        fail(`wrong role on code ${key.code}`);
    // Width and height default to 1u when absent.
    const w = key.w === undefined ? 1 : key.w;
    const h = key.h === undefined ? 1 : key.h;
    // The key's whole rectangle must lie inside [0, size]; EPS forgives
    // rounding on the right/bottom edges.
    if (key.x < 0 || key.y < 0 || key.x + w > size[0] + EPS || key.y + h > size[1] + EPS)
        fail(`code ${key.code} lies outside size`);
}

// True if rectangles a and b ({x, y, w, h}) share any area. Two rectangles
// overlap only if they overlap on BOTH axes. Subtracting EPS means rectangles
// that merely touch along an edge (neighbouring keys) are NOT overlapping.
function overlaps(a, b) {
    return a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS &&
        a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS;
}

// The key's rectangle with the default size filled in: w and h are 1 when the
// layout omits them. Both validation and geometry use this one definition.
function cell(key) {
    return {
        x: key.x, y: key.y,
        w: key.w === undefined ? 1 : key.w,
        h: key.h === undefined ? 1 : key.h,
    };
}

// Check a whole layout; returns it unchanged if fine, throws if not. Run once
// when a layout is loaded, so the rest of the code can trust the data
// (unique codes, no overlaps, everything inside `size`, roles correct).
export function validate(layout) {
    const size = layout.size;
    if (!Array.isArray(size) || !isNum(size[0]) || !isNum(size[1]) || !Array.isArray(layout.keys))
        fail('needs size [w, h] and keys');
    if (size[0] <= 0 || size[1] <= 0)
        fail('size must be positive');

    // `cells` collects rectangles already accepted; each new key is compared
    // against all of them. Quadratic, but there are only ~100 keys and it runs
    // once. `seen` makes duplicate codes an error because keys.js's ledger is
    // keyed by code: two keys with one code would be indistinguishable.
    const cells = [];
    const seen = new Set();
    for (const key of layout.keys) {
        checkKey(key, size);
        if (seen.has(key.code))
            fail(`duplicate code ${key.code}`);
        seen.add(key.code);
        const c = cell(key);
        for (const other of cells) {
            if (overlaps(c, other))
                fail(`code ${key.code} overlaps another key`);
        }
        cells.push(c);
    }
    return layout;
}

// Smallest sensible panel width: key pitch MIN_PITCH. The panel is
// (size[0] + 2 * PAD) units wide, and each unit should be at least MIN_PITCH px.
export function minWidth(layout) {
    return MIN_PITCH * (layout.size[0] + 2 * PAD);
}

// All rects are in panel-local px. `cells` are full key cells (no gaps); the
// view insets them for drawing, hit-testing uses the full cells.
//
// Panel layout, top to bottom: PAD of padding, a HEADER band (drag area plus
// the grip and close buttons), then the keys, then PAD of padding. The width
// in u is the layout width plus padding on both sides, so one u in pixels is
// width / that. Height follows from u, so the panel keeps its aspect ratio.
// Coordinates are relative to the panel's own top-left corner (0, 0), not the
// screen.
export function geometry(layout, width) {
    const u = width / (layout.size[0] + 2 * PAD);
    const height = u * (layout.size[1] + 2 * PAD + HEADER);
    const keysX = PAD * u;
    const keysY = (PAD + HEADER) * u;
    const side = HEADER * u;
    const buttonY = PAD * u;
    // The two header buttons are squares of side HEADER, right-aligned: close
    // at the far right edge (inset by the right padding) and the resize grip just left
    // of it.
    const close = {x: width - PAD * u - side, y: buttonY, w: side, h: side};
    const grip = {x: close.x - side, y: buttonY, w: side, h: side};
    return {
        u, width, height,
        // The header band includes the top padding so its edge is easy to grab.
        header: {x: 0, y: 0, w: width, h: (PAD + HEADER) * u},
        close,
        grip,
        // One rect per key in layout order; `key` keeps the layout entry so
        // hitTest() can report which key was hit.
        cells: layout.keys.map(key => {
            const c = cell(key);
            return {
                key,
                x: keysX + c.x * u, y: keysY + c.y * u,
                w: c.w * u, h: c.h * u,
            };
        }),
    };
}

// Hit-testing is "which thing is under this point?". inside() is the
// half-open rectangle test: left/top edges count, right/bottom edges do not
// (see the header comment), so adjacent rectangles never both claim a point.
function inside(r, x, y) {
    return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

// Order: close > grip > header > key > none. The close and grip buttons sit
// inside the header band, so they must be tested first or the header would
// swallow their clicks. Returns {type: 'close'|'grip'|'header'|'none'} or
// {type: 'key', key}. 'none' (padding or the gaps between keys) must still be
// consumed by the caller so the click does not fall through to the app below.
export function hitTest(geo, x, y) {
    if (inside(geo.close, x, y))
        return {type: 'close'};
    if (inside(geo.grip, x, y))
        return {type: 'grip'};
    if (inside(geo.header, x, y))
        return {type: 'header'};
    for (const c of geo.cells) {
        if (inside(c, x, y))
            return {type: 'key', key: c.key};
    }
    return {type: 'none'};
}

// Placement math (docs/SPEC.md 8). `area` is a work-area rect {x, y, width, height}
// in stage px; `rect` is a panel rect in the same space.

// Choose the panel width in px. `fraction` is the saved width as a fraction of
// the work area width. The result is clamped: not below the minimum key pitch,
// but never wider than the work area or tall enough to overflow it vertically.
// `ratio` is panel height / panel width (it is fixed by the layout), so the
// widest panel whose height still fits is area.height / ratio.
export function panelWidth(layout, area, fraction) {
    const ratio = (layout.size[1] + 2 * PAD + HEADER) / (layout.size[0] + 2 * PAD);
    const widest = Math.min(area.width, area.height / ratio);
    return Math.min(Math.max(fraction * area.width, minWidth(layout)), widest);
}

// The panel's {width, height} in px for a given width.
function sizeFor(layout, width) {
    const g = geometry(layout, width);
    return {width: g.width, height: g.height};
}

// Slide `rect` the minimum distance needed to lie wholly inside `area`. The
// size is unchanged. Math.max(.., area.x) enforces the left/top limit and
// Math.min(.., area.x + area.width - rect.width) the right/bottom one.
export function clampRect(rect, area) {
    const x = Math.min(Math.max(rect.x, area.x), area.x + area.width - rect.width);
    const y = Math.min(Math.max(rect.y, area.y), area.y + area.height - rect.height);
    return {x, y, width: rect.width, height: rect.height};
}

// `saved` is {x, y, width} as stored in GSettings: fractions of the work area,
// x or y < 0 meaning "default position" (bottom centre). Storing fractions
// rather than pixels keeps the panel sensible if the resolution changes.
// Returns a full rect {x, y, width, height} in stage px, clamped to the area.
export function rectFromSaved(layout, area, saved) {
    const size = sizeFor(layout, panelWidth(layout, area, saved.width));
    const rect = {width: size.width, height: size.height};
    if (saved.x < 0 || saved.y < 0) {
        rect.x = area.x + (area.width - size.width) / 2;
        rect.y = area.y + area.height - size.height;
    } else {
        rect.x = area.x + saved.x * area.width;
        rect.y = area.y + saved.y * area.height;
    }
    return clampRect(rect, area);
}

// The inverse of rectFromSaved: turn a panel rect into the fractions that get
// stored. (The height is not stored; it follows from the width.)
export function savedFromRect(rect, area) {
    return {
        x: (rect.x - area.x) / area.width,
        y: (rect.y - area.y) / area.height,
        width: rect.width / area.width,
    };
}
