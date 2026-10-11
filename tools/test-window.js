// A small window for tools/shell-test.js: busy (text changing) from 2 s to
// 6 s after start, then still.
import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';

const app = new Gtk.Application({application_id: 'org.brightnessplus.TestWindow'});
app.connect('activate', () => {
    const win = new Gtk.ApplicationWindow({application: app, title: 'BP test window', default_width: 520, default_height: 360});
    const label = new Gtk.Label({label: 'waiting…'});
    win.set_child(label);
    win.present();
    // a child process, like a shell running Claude inside a terminal
    const out = GLib.getenv('BP_TEST_CHILD_PID');
    if (out) {
        const [, pid] = GLib.spawn_async(null, ['sleep', '120'], null, GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD, null);
        GLib.file_set_contents(out, String(pid));
    }
    let n = 0;
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            label.label = `working ${++n} ${'█'.repeat(n % 30)}`;
            return n < 40 ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
        });
        return GLib.SOURCE_REMOVE;
    });
});
app.run([]);
