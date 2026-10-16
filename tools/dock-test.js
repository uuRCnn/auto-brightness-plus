// Dash-to-Dock next to Auto Brightness+, in an isolated headless GNOME Shell:
// a maximized window, the mouse on the dock; counts how often the dock
// shows and hides. BP_DOCK_MODE: none (only the dock), on (both), off (both,
// the second monitor turned off).
//   BP_TEST_SCRIPT=$PWD/tools/dock-test.js BP_EXTRA_EXTENSIONS=~/.local/share/gnome-shell/extensions/dash-to-dock@micxgx.gmail.com tools/run-test.sh build/dock

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const UUID = 'auto-brightness-plus@dukha';
const DOCK = 'dash-to-dock@micxgx.gmail.com';
const OUT = GLib.getenv('BP_TEST_OUT');
const MODE = GLib.getenv('BP_DOCK_MODE') || 'off';
const LOG = [];

function log(msg) {
    LOG.push(msg);
    console.log(`BP-DOCK: ${msg}`);
}

function sleep(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

function settingsOf(uuid, schema) {
    const dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell', 'extensions', uuid, 'schemas']);
    const source = Gio.SettingsSchemaSource.new_from_directory(dir, Gio.SettingsSchemaSource.get_default(), false);
    return new Gio.Settings({settings_schema: source.lookup(schema, true)});
}

async function test() {
    // started from the user's settings: ours may already be on
    if (MODE === 'none')
        Main.extensionManager.disableExtension(UUID);
    new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).set_boolean('enable-hot-corners', false);
    const pointer = global.stage.context.get_backend().get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), 800, 500);
    for (let i = 0; i < 20 && (Main.overview.visible || Main.overview.animationInProgress); i++) {
        Main.overview.hide();
        await sleep(300);
    }
    // the user's dock settings
    const dock = settingsOf(DOCK, 'org.gnome.shell.extensions.dash-to-dock');
    for (const [k, v] of [['dock-fixed', false], ['autohide', true], ['intellihide', true], ['require-pressure-to-show', false],
        ['autohide-in-fullscreen', false], ['multi-monitor', false]])
        dock.set_boolean(k, v);
    dock.set_string('intellihide-mode', 'ALL_WINDOWS');
    dock.set_string('dock-position', 'BOTTOM');
    dock.set_int('preferred-monitor', -2);
    Main.extensionManager.enableExtension(DOCK);
    if (GLib.getenv('BP_DOCK_HIDETOPBAR'))
        Main.extensionManager.enableExtension('hidetopbar@mathieu.bidon.ca');
    await sleep(1500);

    // a window filling the main monitor
    const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
    launcher.setenv('WAYLAND_DISPLAY', 'bp-test-0', true);
    launcher.setenv('GDK_BACKEND', 'wayland', true);
    const proc = launcher.spawnv(['gjs', '-m', GLib.getenv('BP_TEST_WINDOW')]);
    let win = null;
    for (let i = 0; i < 40 && !win; i++) {
        await sleep(200);
        win = global.get_window_actors().map(a => a.meta_window).find(w => w?.get_title() === 'BP test window') ?? null;
    }
    win.move_to_monitor(0);
    win.maximize();
    await sleep(1500);
    const r = win.get_frame_rect();
    log(`window: ${r.x},${r.y} ${r.width}x${r.height} monitor=${win.get_monitor()} maximized=${win.is_maximized?.() ?? win.get_maximized?.()}`);

    if (MODE !== 'none') {
        const s = settingsOf(UUID, 'org.gnome.shell.extensions.auto-brightness-plus');
        s.set_string('ddcutil-path', GLib.getenv('BP_FAKE_DDCUTIL'));
        Main.extensionManager.enableExtension(UUID);
        await sleep(3000);
        const manager = Main.extensionManager.lookup(UUID)?.stateObj?._manager;
        log(`ours: ${manager ? manager.displays.length : 'none'} displays`);
        // like the user's: automatic dimming on, in the middle of the evening
        for (const d of manager.displays) {
            d.setConfig('schedule', true);
            d.setConfig('offset', -240);
        }
        if (MODE === 'off')
            manager.turnOff(manager.displays[1]);
        if (MODE === 'lowest')
            manager.setMinimum(manager.displays[0], true);
        if (MODE === 'extra') {
            manager.displays[0].setConfig('schedule', false);
            manager.displays[0].setConfig('extra', 0.4);
        }
        await sleep(2500);
    }

    const ext = Main.extensionManager.lookup(DOCK);
    const {DockManager} = await import(`file://${ext.path}/docking.js`);
    const d = DockManager.allDocks[0];
    log(`dock state=${d?.dockState} ext state=${ext.state} ${ext.error ?? ''}`);

    const move = async (x, y) => {
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
        await sleep(30);
    };
    const m = Main.layoutManager.primaryMonitor;
    for (let i = 0; i < 20 && (Main.overview.visible || Main.overview.animationInProgress); i++) {
        Main.overview.hide();
        await sleep(400);
        if (i % 5 === 4)
            log(`overview still ${Main.overview.visible} anim=${Main.overview.animationInProgress} target=${Main.overview.visibleTarget}`);
    }
    if (Main.overview.visible) {
        // last resort: leave it the way the keyboard shortcut does
        Main.overview.toggle();
        await sleep(1500);
        log(`after toggle: overview ${Main.overview.visible}`);
    }
    win.activate(global.get_current_time());
    await sleep(500);
    // once onto the dock and away again: it hides behind the window
    await move(m.x + m.width / 2, m.y + m.height - 30);
    await sleep(800);
    await move(m.x + m.width / 2, m.y + m.height / 2);
    await sleep(2500);

    // the mouse goes to the dock and stays there; the dock's state, every 20 ms
    const states = [];
    let last = d.dockState;
    const watch = async ms => {
        for (let t = 0; t < ms; t += 20) {
            await sleep(20);
            if (d.dockState !== last) {
                last = d.dockState;
                states.push(last);
            }
        }
    };
    log(`monitor ${m.x},${m.y} ${m.width}x${m.height}; dock state ${d.dockState} intellihide overlap=${d._intellihide?._status ?? '?'} overview=${Main.overview.visible} hover=${d._box.hover} autohide=${d.autohideEnabled} fixed=${d._fixedIsEnabled ?? '?'}`);
    for (let i = 0; i <= 10; i++) {
        await move(m.x + m.width / 2, m.y + m.height / 2 + (m.height / 2 - 1) * i / 10);
        await watch(40);
    }
    await watch(3000);
    await move(m.x + m.width / 2, m.y + m.height - 30);    // onto the icons
    await watch(3000);
    await move(m.x + m.width / 2 + 40, m.y + m.height - 30);
    await watch(3000);
    const names = ['HIDDEN', 'SHOWING', 'SHOWN', 'HIDING'];
    log(`MODE ${MODE}: dock changes while the mouse stays on it: ${states.length} [${states.map(x => names[x] ?? x).join(' ')}]`);
    proc.force_exit();
}

export async function run() {
    try {
        await test();
    } catch (e) {
        log(`FAILED: ${e.message}\n${e.stack}`);
    }
    GLib.file_set_contents(`${OUT}/log.txt`, LOG.join('\n'));
}
