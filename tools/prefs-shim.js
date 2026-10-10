// Minimal stand-in for resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js
// used by tools/prefs-harness.js.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const domain = 'brightness-plus';
let localeDir = null;

export function gettext(s) {
    return localeDir ? GLib.dgettext(domain, s) : s;
}

export class ExtensionPreferences {
    constructor(metadata) {
        this.metadata = metadata;
        this.path = metadata.path;
        this.uuid = metadata.uuid;
        const locale = GLib.build_filenamev([this.path, 'locale']);
        if (GLib.file_test(locale, GLib.FileTest.IS_DIR)) {
            imports.gettext.bindtextdomain(domain, locale);
            localeDir = locale;
        }
    }

    getSettings() {
        const source = Gio.SettingsSchemaSource.new_from_directory(
            GLib.build_filenamev([this.path, 'schemas']), Gio.SettingsSchemaSource.get_default(), false);
        const schema = source.lookup(this.metadata['settings-schema'], true);
        return new Gio.Settings({settings_schema: schema});
    }
}
