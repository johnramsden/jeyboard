#!/bin/sh
# Dev helper (docs/SPEC.md 12): build the zip, copy it to the VM and install it there.
# Usage: scripts/push-to-vm.sh user@vm-host
# Extension code cannot be reloaded in a running Wayland session: log out and in after.
set -eu
host=${1:?usage: push-to-vm.sh user@vm-host}
zip=jeyboard@ramsdenj.ca.shell-extension.zip
cd "$(dirname "$0")/.."
make zip
scp "$zip" "$host:/tmp/$zip"
ssh "$host" "gnome-extensions install --force /tmp/$zip"
echo "Installed. Log out and back in on the VM to load it."
echo "First time only, after logging back in: gnome-extensions enable jeyboard@ramsdenj.ca"
