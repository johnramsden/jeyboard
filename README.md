# jeyboard

An on-screen keyboard for GNOME Shell on Wayland, built for mouse-only
(accessibility) use. It is a GNOME Shell extension, so it can sit above the
lock screen, the login screen, shell password dialogs and fullscreen apps, and
it never takes keyboard focus from the app you are typing into.

- Full-size US ANSI layout (104 keys), floating, draggable and resizable.
- **Modifiers are one-shot, and lock on a double click.** Click Ctrl once and it is
  really held until you type the next key, which uses it up (Ctrl+G = click Ctrl,
  click G). Click Ctrl, then Alt, then G for Ctrl+Alt+G: both are released after G.
  Click a modifier twice to lock it (it gets a ring) so it stays held for several
  keys or mouse clicks, such as Ctrl+click multi-select; click it once more to turn
  it off. Super is a toggle that is never physically held: clicking a key while it
  is on sends a chord and turns it off, and clicking Super again with no key typed
  taps Super (opens the overview). Super does not lock.
- **Right-click any key to type it with Shift** (`p` becomes `P`, `8` becomes `*`,
  an arrow becomes Shift+arrow).
- Hold a button to repeat a key.
- Ctrl+Alt+F1..F12 is blocked, so a mouse-only user cannot strand themselves on a
  text console.

Targets GNOME 50 and 51 (Wayland only). Behaviour is defined in [docs/SPEC.md](docs/SPEC.md); [docs/DESIGN.md](docs/DESIGN.md) explains how it works and why, for readers new to GNOME extensions.

## Status

Pre-release. The owner has confirmed typing, the event filter under grabs and the GDM
login screen on GNOME 50.1 (spikes S1-S3; no written log). Also covered by a headless
test (`make shell-test`). Not checked: GNOME 51.

## Install

Debian/Ubuntu package (system-wide; its GDM keyfile is meant to enable the extension
on the login screen at the next boot, unverified, spike S3):

    sudo apt install debhelper gjs
    dpkg-buildpackage -us -uc -b
    sudo apt install ../gnome-shell-extension-jeyboard_0.1_all.deb

Extensions-website style zip (user install, no login screen support):

    make zip
    gnome-extensions install --force jeyboard@ramsdenj.ca.shell-extension.zip

Then log out and back in (a running shell does not see a new extension), and run
`gnome-extensions enable jeyboard@ramsdenj.ca`. A user-installed copy takes
precedence over the system copy in that user's session. Use the keyboard icon in the top bar to show
and hide the panel. It appears by itself on the lock screen, on the login screen
and when a shell password dialog opens.

## Develop

    make test         # unit tests for the pure modules (plain gjs)
    make shell-test   # headless gnome-shell run with a virtual pointer
    make zip

GitHub Actions (`.github/workflows/ci.yml`) runs `make test` and the `.deb`/zip build on
every push and pull request, plus `make shell-test` in an Ubuntu 26.04 container (that
job is non-blocking until it has been seen to pass on GitHub).

## Limitations

- Keep Settings > Accessibility > Screen Keyboard **off**; the built-in keyboard is
  not suppressed.
- Focus-follows-mouse (`focus-mode 'mouse'`) is unsupported; `click` and `sloppy`
  work.
- While an Input Capture portal session is active (Input Leap, Deskflow), mutter
  consumes every event first and the panel cannot be used.
- While a fullscreen window hides the top bar, a hidden panel cannot be re-shown
  until fullscreen ends.
- Sticky, Slow and Bounce Keys (Accessibility > Typing) apply to jeyboard's keys
  too, and with Sticky Keys on GNOME ignores the bare Super tap. With "Enable by
  keyboard" on, holding Shift 8 s or pressing it five times toggles Slow/Sticky Keys.
- The panel and OSD windows may draw over each other; the panel cannot be excluded
  from screen recordings.
- The gnome-initial-setup first-boot session is not supported.
- The GDM keyfile is `/usr/share/gdm/dconf/95-jeyboard`. A later-sorting keyfile from
  another package that also sets `enabled-extensions` overrides it. Only Ubuntu's
  gdm3 layout is supported.
- Layout labels are US only. Keys send keycodes, so on another system layout the
  keys type per that layout and only the labels are off.
- Boot-time disk passphrase prompts, GRUB, firmware setup and text consoles are
  outside any desktop and cannot be reached (docs/SPEC.md section 15).

## License

MIT. See [LICENSE](LICENSE).
