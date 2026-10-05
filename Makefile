UUID = jeyboard@johnramsden.ca
SCHEMA = org.gnome.shell.extensions.jeyboard
ZIP = $(UUID).shell-extension.zip
SOURCES = metadata.json extension.js keys.js layout.js view.js input.js typer.js \
	indicator.js stylesheet.css layouts schemas/$(SCHEMA).gschema.xml
DESTDIR =
FLAVOR =
EXTDIR = $(DESTDIR)/usr/share/gnome-shell/extensions/$(UUID)

# debhelper runs the default target; there is nothing to build.
all:

test:
	gjs -m tests/run.js

# Headless gnome-shell run of tests/shell/smoke.js; prints TEST PASS/FAIL lines.
# Clearing gnome-shell-disable-extensions: a killed test shell leaves it behind and the
# next test shell would then load no extensions.
shell-test: zip
	rm -f /run/user/$$(id -u)/gnome-shell-disable-extensions /run/user/$$(id -u)/gnome-shell-test-display*
	-env -i HOME=$$HOME PATH=$$PATH XDG_RUNTIME_DIR=/run/user/$$(id -u) timeout -k 5 100 dbus-run-session -- gnome-shell-test-tool --headless --extension $(ZIP) tests/shell/smoke.js > shell-test.log 2>&1
	@grep -E 'TEST |JS ERROR|Gjs-CRITICAL|jeyboard' shell-test.log | cut -c1-200
	@! grep -qE 'TEST FAIL|JS ERROR|Gjs-CRITICAL' shell-test.log && grep -q 'TEST DONE failed=0' shell-test.log

# Plain zip so it works without gnome-extensions. Never includes gschemas.compiled.
zip:
	rm -f $(ZIP)
	cd extension && zip -r ../$(ZIP) $(SOURCES)

install:
	@test "$(FLAVOR)" = system || { echo "usage: make install FLAVOR=system DESTDIR=..."; exit 1; }
	install -d -m 755 $(EXTDIR) $(EXTDIR)/layouts
	install -m 644 extension/*.js extension/stylesheet.css $(EXTDIR)/
	install -m 644 extension/layouts/*.js $(EXTDIR)/layouts/
	sed 's/"unlock-dialog"\]/"unlock-dialog", "gdm"]/' extension/metadata.json > $(EXTDIR)/metadata.json
	chmod 644 $(EXTDIR)/metadata.json
	grep -q '"gdm"' $(EXTDIR)/metadata.json
	install -d -m 755 $(DESTDIR)/usr/share/glib-2.0/schemas
	install -m 644 extension/schemas/$(SCHEMA).gschema.xml $(DESTDIR)/usr/share/glib-2.0/schemas/
	install -d -m 755 $(DESTDIR)/usr/share/gdm/dconf
	install -m 644 data/gdm/95-jeyboard $(DESTDIR)/usr/share/gdm/dconf/95-jeyboard

clean:
	rm -f $(ZIP) shell-test.log

.PHONY: all test shell-test zip install clean
