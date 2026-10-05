// Owns: the St panel (keys, header, highlights) and where it sits on screen.
// Must not: handle input (input.js does), take key focus, or decide key behaviour.
//
// Terms (Clutter, St, actor, stage, reactive, pick) are in the glossary in docs/DESIGN.md.
//
// Styling: St widgets are styled with CSS from stylesheet.css. A widget has a
// style_class ('jeyboard-key' matches '.jeyboard-key'), pseudo-classes such as
// :hover, :checked and :active (nothing sets them automatically on a non-reactive
// actor, so code adds and removes them), and an optional inline `style` string.
//
// Layout: this panel does NOT use a Clutter LayoutManager for its main area.
// layout.js computes every rectangle in plain numbers and this file calls
// set_position()/set_size() on each child. Only the key widgets use a BinLayout, to
// overlay the small shifted-symbol label on the main label.
//
// Why ONE reactive actor with non-reactive children (docs/SPEC.md 5.1). "Reactive" means
// "can be the target of pointer events". Our input is a single Clutter event filter
// (input.js) that asks "is the picked actor the panel?". If the keys were reactive,
// a pick would return a key widget and the filter would have to work out which actor
// belongs to us. With exactly one reactive actor, a pick over any part of the
// keyboard returns the panel, and layout.js hit-tests which key was meant.
// Nothing here may take key focus (can_focus is false everywhere), or the app being
// typed into would lose it.
//
// Size units: layout.js works in "u", one key pitch (the width of a standard key).
// Everything is proportional to u, so resizing the panel only changes u.
import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Mtk from 'gi://Mtk';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as layoutLib from './layout.js';

const KEY_INSET = 0.04;       // visual gap around each key cell, in u
const FLASH_MS = 300;         // how long a blocked key stays red, in milliseconds

export class Panel {
    constructor(layout) {
        this._layout = layout;
        // _snapshot: last key state from keys.js. `on` = modifiers that are on (one-shot or
        // locked), `locked` = the locked subset, `pressed` = keys held down, `blocked` = a key code to flash or null. _locks: Caps/Num
        // Lock lamp state.
        this._snapshot = {on: new Set(), locked: new Set(), pressed: new Set(), blocked: null};
        this._locks = {caps: false, num: false};
        this._flashId = 0;          // GLib timer id of the pending flash end; 0 = none
        this._flashActor = null;    // the key currently showing 'blocked'
        this._hover = null;         // the actor currently showing :hover
        this._keys = new Map();     // evdev key code -> {key, actor, main label, sub label}

        // Reactive so picking returns it; everything inside is not (docs/SPEC.md 5.1).
        // `actor` is the handle the extension adds to Main.uiGroup. It starts hidden
        // because extension.js decides when to show it.
        this.actor = new St.Widget({
            style_class: 'jeyboard-panel',
            reactive: true,
            can_focus: false,
            visible: false,
        });
        for (const key of layout.keys)
            this._addKey(key);
        // Resize grip and close button live in the header. They are labels, not real
        // buttons: clicks are recognised by input.js through hit-testing, so these are
        // only drawn. The characters are Unicode symbols.
        this._grip = this._addButton('jeyboard-grip', 'Resize', '⤢');
        this._close = this._addButton('jeyboard-close', 'Hide keyboard', '×');

        // HiDPI: St multiplies CSS pixels by the theme's scale factor. Our child sizes
        // are in stage pixels but font sizes go through CSS, so fonts are re-derived
        // when the scale changes (_layoutChildren).
        const themeContext = St.ThemeContext.get_for_stage(global.stage);
        themeContext.connectObject('notify::scale-factor', () => this._layoutChildren(), this);
        // St.Settings mirrors desktop-wide settings, here the high-contrast
        // accessibility switch. `this` is the owner used by disconnectObject() in
        // destroy().
        const settings = St.Settings.get();
        settings.connectObject('notify::high-contrast', () => this._syncContrast(), this);
        this._syncContrast();
        // Initial size is the minimum; restore() replaces it with the saved width.
        this.setWidth(layoutLib.minWidth(layout));
    }

    // Build the widget for one key: a box holding a main label (the key's text) and,
    // for keys with a shifted symbol (e.g. '1' / '!'), a small top-left sub label.
    _addKey(key) {
        const actor = new St.Widget({
            style_class: 'jeyboard-key',
            // BinLayout: children overlap in the same box instead of flowing.
            layout_manager: new Clutter.BinLayout(),
            reactive: false,
            can_focus: false,
            // Accessibility (ATK is the screen-reader API): give each key a spoken
            // name and a role. Keys with a `role` (Shift, Ctrl...) are toggles.
            accessible_name: key.label,
            accessible_role: key.role ? Atk.Role.TOGGLE_BUTTON : Atk.Role.PUSH_BUTTON,
        });
        // x/y_align place the label within its box; x/y_expand lets it use the whole
        // box so that CENTER actually centres it.
        const main = new St.Label({
            style_class: 'jeyboard-key-label',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        actor.add_child(main);
        let sub = null;
        if (key.shiftLabel !== undefined) {
            sub = new St.Label({
                style_class: 'jeyboard-key-sub',
                text: key.shiftLabel,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.START,
                x_expand: true,
                y_expand: true,
            });
            actor.add_child(sub);
        }
        this.actor.add_child(actor);
        this._keys.set(key.code, {key, actor, main, sub});
    }

    // Create one of the header buttons (resize grip, close). Drawn only; see above.
    _addButton(styleClass, name, text) {
        const button = new St.Label({
            style_class: styleClass,
            text,
            reactive: false,
            can_focus: false,
            accessible_name: name,
            accessible_role: Atk.Role.PUSH_BUTTON,
        });
        this.actor.add_child(button);
        return button;
    }

    // Mirror the system high-contrast setting as a 'high-contrast' CSS class on the
    // panel; stylesheet.css has descendant rules keyed on it.
    _syncContrast() {
        if (St.Settings.get().high_contrast)
            this.actor.add_style_class_name('high-contrast');
        else
            this.actor.remove_style_class_name('high-contrast');
    }

    // Holds the last result of layout.js geometry() (cells, grip, close rectangles
    // in panel-local stage pixels, and `u`).
    get geometry() {
        return this._geo;
    }

    // Resize the whole panel; the height follows from the width and the layout shape.
    setWidth(width) {
        this._geo = layoutLib.geometry(this._layout, width);
        this.actor.set_size(this._geo.width, this._geo.height);
        this._layoutChildren();
    }

    // Place and size every child from the computed geometry and set font sizes.
    // Runs after a width change and when the HiDPI scale factor changes.
    _layoutChildren() {
        const geo = this._geo;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        // St multiplies CSS px by scale_factor; u is already in stage (logical) px,
        // so divide to cancel it. When scale_factor is 1 (expected on many Wayland
        // setups) this is a no-op; kept per docs/SPEC.md 5.1.
        const font = fraction => `font-size: ${geo.u * fraction / scale}px;`;
        // Keys are drawn slightly smaller than their cells so there are gaps between
        // them; hit-testing still uses the full cell, so there is no dead space.
        const inset = KEY_INSET * geo.u;

        for (const cell of geo.cells) {
            const k = this._keys.get(cell.key.code);
            k.actor.set_position(cell.x + inset, cell.y + inset);
            k.actor.set_size(cell.w - 2 * inset, cell.h - 2 * inset);
            k.main.style = font(0.3);
            if (k.sub)
                k.sub.style = font(0.22);
        }
        for (const [button, rect] of [[this._grip, geo.grip], [this._close, geo.close]]) {
            button.set_position(rect.x, rect.y);
            button.set_size(rect.w, rect.h);
            button.style = font(0.4);
        }
    }

    // Convert a point in stage (screen) coordinates to panel-local coordinates, which
    // is what layout.js hit-testing expects. Returns [x, y], or null if the actor's
    // transform cannot be inverted. input.js calls this to locate the pointer.
    toLocal(x, y) {
        const [ok, lx, ly] = this.actor.transform_stage_point(x, y);
        return ok ? [lx, ly] : null;
    }

    // What is at this panel-local point: a key, the grip, close button, header or
    // nothing. The decision logic lives in layout.js so it can be unit-tested.
    hitTest(lx, ly) {
        return layoutLib.hitTest(this._geo, lx, ly);
    }

    // The one entry point for "something changed, redraw". snapshot: keys.snapshot();
    // locks: {caps, num}. Either may be omitted (null) to keep the last.
    sync(snapshot, locks) {
        if (snapshot)
            this._snapshot = snapshot;
        if (locks)
            this._locks = locks;
        this._refresh();
    }

    // Apply the stored snapshot and lock state to the widgets. Idempotent: it sets
    // every key's appearance from scratch each time rather than tracking changes.
    _refresh() {
        const {on, locked, pressed, blocked} = this._snapshot;
        const shiftOn = this._layout.keys.some(k => k.role === 'shift' && on.has(k.code));
        const upper = shiftOn !== this._locks.caps;   // Shift XOR Caps Lock

        // CSS states (stylesheet.css colours them): :active = in the held-keys set,
        // :checked = a toggled-on modifier. A Shift/Ctrl/Alt that is on is also held,
        // so it currently gets both, and the order of the rules in stylesheet.css
        // decides which colour shows. Super is never held, so only it is plain :checked.
        for (const {key, actor, main} of this._keys.values()) {
            setPseudo(actor, 'active', pressed.has(key.code));
            setPseudo(actor, 'checked', on.has(key.code));
            // A locked modifier gets an extra look so it differs from a one-shot one.
            if (locked.has(key.code))
                actor.add_style_class_name('locked');
            else
                actor.remove_style_class_name('locked');
            // Tell screen readers the toggle's state too.
            if (key.role)
                this._setChecked(actor, on.has(key.code));
            main.text = this._labelFor(key, upper);
            // 58 = Caps Lock, 69 = Num Lock (evdev codes): tint their label green
            // while the lock is on (state comes from the keymap, not from keys.js).
            // Setting style_class replaces the whole class list, hence the full string.
            if (key.code === 58)
                main.style_class = `jeyboard-key-label${this._locks.caps ? ' jeyboard-lock-on' : ''}`;
            if (key.code === 69)
                main.style_class = `jeyboard-key-label${this._locks.num ? ' jeyboard-lock-on' : ''}`;
        }
        // `blocked` is a key the state machine refused (e.g. Ctrl+Alt+F1): flash red.
        if (blocked !== null)
            this._flash(blocked);
    }

    _setChecked(actor, checked) {
        if (checked)
            actor.add_accessible_state(Atk.StateType.CHECKED);
        else
            actor.remove_accessible_state(Atk.StateType.CHECKED);
    }

    // Text to show on a key: letters follow Shift/Caps, keypad keys follow Num Lock.
    _labelFor(key, upper) {
        if (key.letter)
            return upper ? key.label.toUpperCase() : key.label;
        if (key.numLockOffLabel !== undefined && !this._locks.num)
            return key.numLockOffLabel;
        return key.label;
    }

    // Briefly add the 'blocked' class (red). The timer id is kept so _clearFlash()
    // can cancel it, which destroy() relies on: a timer still pending when the
    // extension is disabled would run dead code.
    _flash(code) {
        const k = this._keys.get(code);
        if (!k)
            return;
        this._clearFlash();
        k.actor.add_style_class_name('blocked');
        this._flashActor = k.actor;
        this._flashId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FLASH_MS, () => {
            this._flashId = 0;
            this._clearFlash();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Cancel the pending timer (if any) and remove the red state immediately.
    _clearFlash() {
        if (this._flashId)
            GLib.source_remove(this._flashId);
        this._flashId = 0;
        this._flashActor?.remove_style_class_name('blocked');
        this._flashActor = null;
    }

    // Move the :hover highlight. Real :hover cannot be used because the keys are
    // not reactive, so input.js feeds pointer motion in through hitTest() results.
    // hit: a hitTest() result or null. Only for cosmetics; nothing depends on it.
    setHover(hit) {
        // Anything other than a key, close or grip (header, gap) means no highlight.
        const next = !hit ? null
            : hit.type === 'key' ? this._keys.get(hit.key.code).actor
                : hit.type === 'close' ? this._close
                    : hit.type === 'grip' ? this._grip : null;
        if (next === this._hover)
            return;
        if (this._hover)
            setPseudo(this._hover, 'hover', false);
        this._hover = next;
        if (next)
            setPseudo(next, 'hover', true);
    }

    // --- placement (docs/SPEC.md 8) ---
    //
    // Terms: a "monitor" is identified at runtime by a small integer INDEX, which can
    // change when displays are plugged in, and by a stable CONNECTOR name such as
    // 'HDMI-1' or 'eDP-1'. We save the connector so the panel returns to the same
    // physical screen. The "work area" is a monitor's rectangle minus the top bar and
    // docks. Position and width are saved as FRACTIONS of the work area (0..1) so the
    // layout survives a resolution or monitor change. See layout.js for the math.

    _monitorManager() {
        return global.backend.get_monitor_manager();
    }

    // Connector name -> monitor index. Falls back to the primary monitor if the
    // setting is empty or that display is no longer connected (index < 0).
    _indexForConnector(connector) {
        const index = connector ? this._monitorManager().get_monitor_for_connector(connector) : -1;
        return index >= 0 ? index : Main.layoutManager.primaryIndex;
    }

    // Monitor index -> connector name ('' if none found).
    _connectorForIndex(index) {
        const manager = this._monitorManager();
        return manager.get_monitors().map(m => m.get_connector())
            .find(c => manager.get_monitor_for_connector(c) === index) ?? '';
    }

    // The panel's current x, y, width and height in stage pixels.
    _currentRect() {
        const [x, y] = this.actor.get_position();
        const [width, height] = this.actor.get_size();
        return {x, y, width, height};
    }

    _currentMonitor() {
        const r = this._currentRect();
        // The monitor holding the panel's centre. We ask mutter which monitor
        // contains a 1x1 rectangle at that centre point.
        return global.display.get_monitor_index_for_rect(new Mtk.Rectangle({
            x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), width: 1, height: 1,
        }));
    }

    // Load the saved position and width from GSettings and apply them: convert the
    // saved fractions to pixels on the saved monitor and clamp onto the screen.
    // A negative saved x or y (the default, -1) means "bottom centre".
    restore(settings) {
        const index = this._indexForConnector(settings.get_string('monitor'));
        const area = Main.layoutManager.getWorkAreaForMonitor(index);
        const rect = layoutLib.rectFromSaved(this._layout, area, {
            x: settings.get_double('pos-x'),
            y: settings.get_double('pos-y'),
            width: settings.get_double('width'),
        });
        this.setWidth(rect.width);
        this.actor.set_position(Math.round(rect.x), Math.round(rect.y));
    }

    // Keep the whole panel inside the work area of the monitor holding its centre
    // (called when a drag or resize ends and when monitors change). Also shrinks the
    // width if the area got smaller.
    clamp() {
        const area = Main.layoutManager.getWorkAreaForMonitor(this._currentMonitor());
        const rect = this._currentRect();
        const width = layoutLib.panelWidth(this._layout, area, rect.width / area.width);
        if (Math.round(width) !== Math.round(rect.width))
            this.setWidth(width);
        const fit = layoutLib.clampRect({...this._currentRect()}, area);
        this.actor.set_position(Math.round(fit.x), Math.round(fit.y));
    }

    // Write position as fractions of the work area, plus monitor connector and width
    // fraction. Called only when a drag or resize ends, never on every motion event,
    // to avoid hammering dconf (docs/SPEC.md 8, Persistence).
    save(settings) {
        const index = this._currentMonitor();
        const area = Main.layoutManager.getWorkAreaForMonitor(index);
        const saved = layoutLib.savedFromRect(this._currentRect(), area);
        settings.set_string('monitor', this._connectorForIndex(index));
        settings.set_double('pos-x', saved.x);
        settings.set_double('pos-y', saved.y);
        settings.set_double('width', saved.width);
    }

    // Undo everything the constructor connected or created, mirroring disable().
    destroy() {
        this._clearFlash();
        St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
        St.Settings.get().disconnectObject(this);
        this.actor.destroy();
    }
}

// Turn a CSS pseudo-class (':hover', ':checked', ':active') on or off for an actor.
// Pass the bare name without the colon. St has no single "set" call, only add and
// remove, hence this helper.
function setPseudo(actor, name, on) {
    if (on)
        actor.add_style_pseudo_class(name);
    else
        actor.remove_style_pseudo_class(name);
}
