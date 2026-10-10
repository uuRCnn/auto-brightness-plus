// Automated test, run inside an isolated headless GNOME Shell:
//   tools/run-test.sh
// Opens Quick Settings in every state and writes screenshots + a log to
// $BP_TEST_OUT. A fake ddcutil (tools/fake-ddcutil.sh) plays the monitors.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const UUID = 'brightness-plus@dukha';
const OUT = GLib.getenv('BP_TEST_OUT');
const DDC_LOG = GLib.getenv('FAKE_DDC_LOG');
const LOG = [];

function log(msg) {
    LOG.push(msg);
    console.log(`BP-TEST: ${msg}`);
}

function sleep(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

async function shot(name) {
    const file = Gio.File.new_for_path(`${OUT}/${name}.png`);
    const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
    const shooter = new Shell.Screenshot();
    await shooter.screenshot(false, stream);
    stream.close(null);
    log(`screenshot ${name}`);
}

function ddcCalls(kind) {
    try {
        const [, bytes] = GLib.file_get_contents(DDC_LOG);
        return new TextDecoder().decode(bytes).split('\n').filter(l => l.startsWith(kind));
    } catch {
        return [];
    }
}

function extensionSettings() {
    const dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell', 'extensions', UUID, 'schemas']);
    const source = Gio.SettingsSchemaSource.new_from_directory(dir, Gio.SettingsSchemaSource.get_default(), false);
    return new Gio.Settings({settings_schema: source.lookup('org.gnome.shell.extensions.brightness-plus', true)});
}

async function test() {
    const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    iface.set_string('color-scheme', GLib.getenv('BP_TEST_SCHEME') || 'prefer-dark');
    Main.overview.hide();
    await sleep(800);

    const settings = extensionSettings();
    settings.set_string('ddcutil-path', GLib.getenv('BP_FAKE_DDCUTIL'));
    settings.set_int('ddc-write-interval', 120);
    settings.set_boolean('red-follows-night-light', false);
    settings.set_boolean('debug', true);

    log(`monitors: ${Main.layoutManager.monitors.map(m => `${m.index}:${m.width}x${m.height}@${m.x}`).join(' ')}`);
    const mm = global.backend.get_monitor_manager();
    for (const c of ['Meta-0', 'Meta-1', 'Virtual-1', 'Virtual-2'])
        log(`connector ${c} -> ${mm.get_monitor_for_connector(c)}`);

    Main.extensionManager.enableExtension(UUID);
    await sleep(2500);
    const ext = Main.extensionManager.lookup(UUID);
    log(`extension state=${ext?.state} error=${ext?.error ?? ''}`);
    const obj = ext?.stateObj;
    if (!obj?._manager)
        throw new Error(`extension did not start: ${ext?.error}`);
    const manager = obj._manager;
    log(`displays: ${manager.displays.map(d => `${d.number}:${d.kind}:${d.name}:${d.shortName}:bus${d.bus}:v${d.value.toFixed(2)}:ready${d.ready}`).join(' | ')}`);
    log(`items=${obj._items.length} night=${!!obj._nightItem}`);
    log(`location ${JSON.stringify(manager.globals.location)}`);

    const qs = Main.panel.statusArea.quickSettings;
    if (obj._nightItem)
        obj._nightItem.visible = true; // no Night Light on virtual monitors

    // ---- main menu
    qs.menu.open();
    await sleep(700);
    await shot('01-menu');

    // ---- hover tooltip
    const item = obj._items[0];
    item.slider.hover = true;
    await sleep(400);
    await shot('02-tooltip');
    item.slider.hover = false;
    await sleep(200);

    // ---- dragging = many values, few writes
    const before = ddcCalls('setvcp').length;
    for (let i = 0; i <= 60; i++) {
        item.slider.value = 0.3 + i / 200;
        await sleep(16);
    }
    await sleep(1500);
    const writes = ddcCalls('setvcp').slice(before);
    log(`drag: 61 slider values -> ${writes.length} ddc writes; last="${writes.at(-1)}" value=${manager.displays[0].value.toFixed(2)}`);

    // ---- moon menu
    manager.displays[0].setConfig('schedule', true);
    item.menu.open();
    await sleep(800);
    await shot('03-monitor-menu');
    item._extra.slider.value = 0.4;
    await sleep(300);
    await shot('04-extra-dim');
    item._extra.slider.value = 0;
    item.menu.close();
    await sleep(500);

    // ---- labels
    for (const mode of ['number', 'short-name', 'icon']) {
        settings.set_string('slider-label', mode);
        await sleep(300);
        await shot(`05-label-${mode}`);
    }

    // ---- night light menu + red screen
    if (obj._nightItem) {
        obj._nightItem.menu.open();
        await sleep(800);
        await shot('06-night-light');
        settings.set_boolean('red-enabled', true);
        obj._nightItem.checked = true;
        await sleep(1200);
        await shot('07-red-screen');
        settings.set_double('red-strength', 0.4);
        await sleep(400);
        await shot('08-red-40');
        settings.set_boolean('red-enabled', false);
        obj._nightItem.menu.close();
        await sleep(1200);
    }
    qs.menu.close();
    await sleep(500);

    // ---- turn off others
    manager.turnOffOthers(manager.displays[0]);
    await sleep(800);
    await shot('09-others-off');
    log(`off: ${manager.displays.map(d => `${d.number}:${d.off}`).join(' ')}`);
    manager.wakeAll();
    await sleep(800);
    settings.set_string('screen-off-mode', 'minimum');
    manager.turnOff(manager.displays[1]);
    await sleep(800);
    await shot('10-minimum-light');
    manager.wakeAll();
    await sleep(600);

    // ---- schedule: pretend it is night
    const d = manager.displays[0];
    log(`phase now: ${JSON.stringify(manager.phaseOf(d))}`);

    // ---- disable / enable cycle
    Main.extensionManager.disableExtension(UUID);
    await sleep(800);
    log(`after disable: dim actors=${Main.layoutManager.uiGroup.get_children().filter(a => a.name?.startsWith('brightness-plus')).length} effects=${Main.layoutManager.uiGroup.get_effects().length}`);
    Main.extensionManager.enableExtension(UUID);
    await sleep(2500);
    const ext2 = Main.extensionManager.lookup(UUID);
    log(`re-enabled state=${ext2?.state} items=${ext2?.stateObj?._items?.length}`);
    // ---- preferences window, every page
    for (let page = 0; page < 4; page++) {
        const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
        launcher.setenv('WAYLAND_DISPLAY', 'bp-test-0', true);
        launcher.setenv('GDK_BACKEND', 'wayland', true);
        const proc = launcher.spawnv(['gjs', '-m', GLib.getenv('BP_PREFS_HARNESS'), GLib.getenv('BP_PREFS_DIR'), String(page)]);
        await sleep(3500);
        await shot(`20-prefs-${page}`);
        proc.force_exit();
        await sleep(500);
    }

    log(`ddc calls total: ${ddcCalls('').length} (detect=${ddcCalls('detect').length}, getvcp=${ddcCalls('getvcp').length}, setvcp=${ddcCalls('setvcp').length})`);
}

export async function run() {
    try {
        await test();
    } catch (e) {
        log(`FAILED: ${e.message}\n${e.stack}`);
    }
    GLib.file_set_contents(`${OUT}/log.txt`, LOG.join('\n'));
}
