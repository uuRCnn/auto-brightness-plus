// Opens the preferences window on a given page, outside of GNOME Shell.
//   gjs -m tools/prefs-harness.js <build-dir-with-prefs> <page-index>
// The build dir must contain prefs.js (import rewritten to ./prefs-shim.js),
// prefs-shim.js, metadata.json, schemas// and lib/.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

const [dir, page = '0'] = ARGV;
const {default: Prefs} = await import(`file://${dir}/prefs.js`);
const metadata = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(`${dir}/metadata.json`)[1]));
metadata.path = dir;

const app = new Adw.Application({application_id: 'dev.dukha.AutoBrightnessPlus.PrefsHarness', flags: Gio.ApplicationFlags.NON_UNIQUE});
app.connect('activate', () => {
    const window = new Adw.PreferencesWindow({application: app});
    const pages = [];
    const add = window.add.bind(window);
    window.add = p => {
        pages.push(p);
        add(p);
    };
    const prefs = new Prefs(metadata);
    prefs.fillPreferencesWindow(window);
    if (pages[+page])
        window.set_visible_page(pages[+page]);
    window.set_default_size(680, 900);
    window.present();
});
app.run([System.programInvocationName]);
