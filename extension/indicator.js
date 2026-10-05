// Owns: the top-bar button that shows and hides the panel.
// Must not: open a menu (PopupMenu items grab key focus).
//
// The "indicator" is the small keyboard icon in the GNOME top bar (the status area
// at the right, next to network/volume). Clicking it shows or hides the panel.
// Extension indicators stay available on the lock screen and the login greeter,
// where this button is the only manual toggle (docs/SPEC.md 9).
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

// GObject.registerClass: shell widgets are GObject classes (the C object system).
// A JavaScript subclass of one must be registered with it, which is what wrapping
// the class expression here does. The result is exported as `Indicator`.
// PanelMenu.Button is the shell's standard top-bar button; normally it owns a
// dropdown menu, which we deliberately do not use.
export const Indicator = GObject.registerClass(
class JeyboardIndicator extends PanelMenu.Button {
    // onToggle: a callback supplied by extension.js, called on every click. The
    // button holds no state of its own; extension.js decides show or hide.
    constructor(onToggle) {
        // super(...) runs the parent constructor; it must come before any use of
        // `this`. Arguments: menu alignment (0.0), accessible name, and
        // dontCreateMenu = true so no PopupMenu exists to grab key focus.
        super(0.0, 'jeyboard', true);
        // The base constructor forces can_focus: true.
        this.can_focus = false;
        // The icon is a theme icon name; '-symbolic' icons are recoloured by the
        // theme to match the top bar. 'system-status-icon' is the shell's own style
        // class for top-bar icons (size and padding).
        this.add_child(new St.Icon({
            icon_name: 'input-keyboard-symbolic',
            style_class: 'system-status-icon',
        }));
        // dontCreateMenu disables the base class's own click handling, so we attach
        // a gesture recogniser ourselves: ClickGesture emits 'recognize' after a
        // complete press-and-release on this button. add_action() attaches it to
        // the actor. No menu is opened and no focus is taken.
        const click = new Clutter.ClickGesture();
        click.connect('recognize', () => onToggle());
        this.add_action(click);
    }
});
