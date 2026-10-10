#!/usr/bin/env bash
# Re-extract strings, merge them into every po/<lang>.po and compile .mo
# files into build/locale. New or changed strings show up as untranslated
# or fuzzy entries (msgfmt --statistics lists them).
set -euo pipefail
cd "$(dirname "$0")/.."
xgettext --from-code=UTF-8 -k_ -kngettext:1,2 -kpgettext:1c,2 -kN_ --language=JavaScript \
    -o po/brightness-plus.pot --package-name="Brightness+" \
    --msgid-bugs-address="https://github.com/uuRCnn/brightness-plus/issues" \
    src/extension.js src/prefs.js src/lib/*.js
for po in po/*.po; do
    [ -e "$po" ] || continue
    lang=$(basename "$po" .po)
    msgmerge --quiet --update --backup=none "$po" po/brightness-plus.pot
    mkdir -p "build/locale/$lang/LC_MESSAGES"
    msgfmt --check -o "build/locale/$lang/LC_MESSAGES/brightness-plus.mo" "$po"
done
echo "translations ok"
