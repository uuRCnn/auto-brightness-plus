#!/usr/bin/env bash
# Build the installable / uploadable zip:  build/brightness-plus@dukha.shell-extension.zip
#   tools/build.sh            build only
#   tools/build.sh --install  build and install for the current user
set -euo pipefail
cd "$(dirname "$0")/.."

python3 tools/make-po.py >/dev/null
tools/update-po.sh >/dev/null

mkdir -p build
gnome-extensions pack src --force --out-dir=build \
    --podir=../po \
    --schema=schemas/org.gnome.shell.extensions.brightness-plus.gschema.xml \
    --extra-source=lib \
    --extra-source=../LICENSE

ZIP=build/brightness-plus@dukha.shell-extension.zip
echo "built $ZIP ($(du -h "$ZIP" | cut -f1))"
unzip -l "$ZIP" | tail -n +4 | head -n -2 | awk '{print "  " $4}'

if [ "${1:-}" = "--install" ]; then
    gnome-extensions install --force "$ZIP"
    echo "installed — on Wayland, log out and back in, then: gnome-extensions enable brightness-plus@dukha"
fi
