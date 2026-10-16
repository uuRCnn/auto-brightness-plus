#!/usr/bin/env bash
# Run the extension inside an isolated, headless GNOME Shell with two virtual
# monitors and a fake ddcutil, and take screenshots. Does not touch the
# running session, the user's settings or real monitors.
#
#   tools/run-test.sh [output-dir]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(realpath -m "${1:-$ROOT/build/test}")"
TMP="$(mktemp -d /tmp/bp-test.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

rm -rf "$OUT"
mkdir -p "$OUT" "$TMP/config" "$TMP/data/gnome-shell/extensions" "$TMP/cache" "$TMP/runtime"
chmod 700 "$TMP/runtime"

glib-compile-schemas "$ROOT/src/schemas"
EXT="$TMP/data/gnome-shell/extensions/auto-brightness-plus@dukha"
cp -r "$ROOT/src" "$EXT"
[ -d "$ROOT/build/locale" ] && cp -r "$ROOT/build/locale" "$EXT/locale"
# BP_USER_DCONF=1: start with a copy of the user's settings (all extensions' too); the copy lives
# only in the temporary directory
if [ -n "${BP_USER_DCONF:-}" ] && [ -f "$HOME/.config/dconf/user" ]; then
    mkdir -p "$TMP/config/dconf"
    cp "$HOME/.config/dconf/user" "$TMP/config/dconf/user"
fi
# other extensions to run next to it (e.g. a dock), copied from the given directories
for x in ${BP_EXTRA_EXTENSIONS:-}; do
    cp -r "$x" "$TMP/data/gnome-shell/extensions/$(basename "$x")"
done

# preferences harness copy (prefs.js with its shell import replaced by a shim)
PD="$TMP/prefs"
cp -r "$ROOT/src" "$PD"
cp "$ROOT/tools/prefs-shim.js" "$PD/prefs-shim.js"
sed -i "s|resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js|./prefs-shim.js|" "$PD/prefs.js"
[ -d "$ROOT/build/locale" ] && cp -r "$ROOT/build/locale" "$PD/locale"
export BP_PREFS_DIR="$PD"
export BP_PREFS_HARNESS="$ROOT/tools/prefs-harness.js"
export BP_TEST_WINDOW="$ROOT/tools/test-window.js"

# a plain "ddcutil" is always the fake one: no test ever talks to the real monitors
mkdir -p "$TMP/bin"
ln -s "$ROOT/tools/fake-ddcutil.sh" "$TMP/bin/ddcutil"
export PATH="$TMP/bin:$PATH"

export XDG_CONFIG_HOME="$TMP/config"
export XDG_DATA_HOME="$TMP/data"
export XDG_CACHE_HOME="$TMP/cache"
export XDG_RUNTIME_DIR="$TMP/runtime"
export BP_TEST_OUT="$OUT"
export BP_FAKE_DDCUTIL="$ROOT/tools/fake-ddcutil.sh"
export FAKE_DDC_LOG="$OUT/ddc-calls.txt"
export FAKE_DDC_CONNECTORS="${FAKE_DDC_CONNECTORS:-Meta-0 Meta-1}"
export LANG="${BP_LANG:-en_US.UTF-8}"
export LANGUAGE="${BP_LANGUAGE:-}"
unset DISPLAY WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS

timeout 240 dbus-run-session -- gnome-shell --headless --wayland --no-x11 \
    --wayland-display=bp-test-0 $(for m in ${BP_MONITORS:-1600x1000 1280x800}; do printf -- "--virtual-monitor %s " "$m"; done) \
    --automation-script="${BP_TEST_SCRIPT:-$ROOT/tools/shell-test.js}" > "$OUT/shell.log" 2>&1 || true

echo "---- test log"
cat "$OUT/log.txt" 2>/dev/null || echo "(no log)"
echo "---- shell warnings/errors mentioning the extension"
grep -iE "auto-brightness-plus|Brightness\+|JS ERROR|TypeError|ReferenceError|Gjs-CRITICAL|St-CRITICAL|Clutter-CRITICAL" "$OUT/shell.log" | grep -v "BP-TEST" | head -40 || true
