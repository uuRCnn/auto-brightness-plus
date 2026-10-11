// The screenshots for README.md (docs/*.png), in an isolated headless GNOME Shell:
//   BP_TEST_SCRIPT=tools/readme-shots.js BP_MONITORS="1600x1300 1280x800" tools/run-test.sh build/shots
// then tools/readme-shots.py crops them into docs/.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const UUID = 'auto-brightness-plus@dukha';
const OUT = GLib.getenv('BP_TEST_OUT');
const LOG = [];
const RECTS = {};

function log(msg) {
    LOG.push(msg);
    console.log(`BP-SHOTS: ${msg}`);
}

function sleep(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

// a screenshot, and where Quick Settings is on it (for cropping)
async function shot(name) {
    const file = Gio.File.new_for_path(`${OUT}/${name}.png`);
    const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
    await new Shell.Screenshot().screenshot(false, stream);
    stream.close(null);
    const box = Main.panel.statusArea.quickSettings.menu.box;
    const [x, y] = box.get_transformed_position();
    const [w, h] = box.get_transformed_size();
    RECTS[name] = [Math.round(x), Math.round(y), Math.round(w), Math.round(h)];
    log(`screenshot ${name} ${RECTS[name]}`);
}

function extensionSettings() {
    const dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell', 'extensions', UUID, 'schemas']);
    const source = Gio.SettingsSchemaSource.new_from_directory(dir, Gio.SettingsSchemaSource.get_default(), false);
    return new Gio.Settings({settings_schema: source.lookup('org.gnome.shell.extensions.auto-brightness-plus', true)});
}

async function shots() {
    new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).set_string('color-scheme', 'prefer-dark');
    const settings = extensionSettings();
    settings.set_string('ddcutil-path', GLib.getenv('BP_FAKE_DDCUTIL'));
    settings.set_int('ddc-write-interval', 120);
    for (let i = 0; i < 20 && (Main.overview.visible || Main.overview.animationInProgress); i++) {
        Main.overview.hide();
        await sleep(300);
    }
    const pointer = global.stage.context.get_backend().get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), 400, 600);
    Main.extensionManager.enableExtension(UUID);
    await sleep(3000);
    const obj = Main.extensionManager.lookup(UUID)?.stateObj;
    if (!obj?._manager)
        throw new Error('extension did not start');
    const manager = obj._manager;
    const [main, side] = manager.displays;
    main.setConfig('day', 0.8);
    side.setConfig('day', 0.7);
    main.setConfig('schedule', true);
    side.setConfig('schedule', true);
    if (obj._nightItem)
        obj._nightItem.visible = true;     // no Night Light on virtual monitors
    await sleep(1500);

    const qs = Main.panel.statusArea.quickSettings;
    qs.menu.open();
    await sleep(900);
    await shot('menu');

    const item = obj._items[0];
    item.menu.open();
    await sleep(1200);
    await shot('monitor-menu');
    item.menu.close();
    await sleep(500);

    // the other monitor turned off by hand, its menu with the box under the button
    manager.turnOff(side);
    await sleep(2500);
    const other = obj._items[1];
    other.menu.open();
    await sleep(1200);
    const adj = other._scroll.vadjustment ?? other._scroll.vscroll?.adjustment;
    if (adj)
        adj.value = adj.upper;
    await sleep(300);
    await shot('turned-off');
    other.menu.close();
    qs.menu.close();
}

export async function run() {
    try {
        await shots();
    } catch (e) {
        log(`FAILED: ${e.message}\n${e.stack}`);
    }
    GLib.file_set_contents(`${OUT}/rects.json`, JSON.stringify(RECTS));
    GLib.file_set_contents(`${OUT}/log.txt`, LOG.join('\n'));
}
