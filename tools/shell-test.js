// Automated test, run inside an isolated headless GNOME Shell:
//   tools/run-test.sh
// Opens Quick Settings in every state and writes screenshots + a log to
// $BP_TEST_OUT. A fake ddcutil (tools/fake-ddcutil.sh) plays the monitors.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const UUID = 'auto-brightness-plus@dukha';
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

let pointer = null;
async function moveTo(x, y) {
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
    await sleep(60);
}

async function press(down) {
    pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY,
        down ? Clutter.ButtonState.PRESSED : Clutter.ButtonState.RELEASED);
    await sleep(60);
}

function center(actor) {
    const [x, y] = actor.get_transformed_position();
    const [w, h] = actor.get_transformed_size();
    return [x + w / 2, y + h / 2];
}

// scroll a monitor menu so that `actor` is on screen
function reveal(actor) {
    for (let p = actor.get_parent(); p; p = p.get_parent()) {
        if (p instanceof St.ScrollView) {
            const adj = p.vadjustment ?? p.vscroll?.adjustment;
            const [, y] = actor.get_transformed_position();
            const [, py] = p.get_transformed_position();
            if (adj && (y < py || y + actor.height > py + p.height))
                adj.value = Math.min(adj.upper - adj.page_size, adj.value + (y - py) - 20);
            return;
        }
    }
}

async function click(actor) {
    reveal(actor);
    await sleep(80);
    await moveTo(...center(actor));
    await press(true);
    await press(false);
}

function findActor(root, pred) {
    if (pred(root))
        return root;
    for (const c of root.get_children()) {
        const r = findActor(c, pred);
        if (r)
            return r;
    }
    return null;
}

// frames painted and the longest gap between two of them while `fn` runs
async function frameStats(fn, ms) {
    const times = [];
    const id = global.stage.connect('after-paint', () => times.push(GLib.get_monotonic_time()));
    const t0 = GLib.get_monotonic_time();
    await fn();
    const t1 = GLib.get_monotonic_time();
    await sleep(ms);
    global.stage.disconnect(id);
    let gap = 0;
    for (let i = 1; i < times.length; i++)
        gap = Math.max(gap, times[i] - times[i - 1]);
    return `call ${((t1 - t0) / 1000).toFixed(1)} ms, ${times.length} frames, longest gap ${(gap / 1000).toFixed(1)} ms`;
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
    return new Gio.Settings({settings_schema: source.lookup('org.gnome.shell.extensions.auto-brightness-plus', true)});
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
    log(`menu style by default: ${settings.get_string('menu-style')} (must be simple)`);
    // most checks below click the detailed rows; the simple menu has its own checks
    settings.set_string('menu-style', 'detailed');

    log(`monitors: ${Main.layoutManager.monitors.map(m => `${m.index}:${m.width}x${m.height}@${m.x}`).join(' ')}`);
    const mm = global.backend.get_monitor_manager();
    for (const c of ['Meta-0', 'Meta-1', 'Virtual-1', 'Virtual-2'])
        log(`connector ${c} -> ${mm.get_monitor_for_connector(c)}`);

    // the headless shell starts in the overview: make sure it is really gone
    for (let i = 0; i < 20 && (Main.overview.visible || Main.overview.animationInProgress); i++) {
        Main.overview.hide();
        await sleep(300);
    }
    log(`overview visible=${Main.overview.visible}`);
    pointer = global.stage.context.get_backend().get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    await moveTo(800, 600);
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

    // ---- moon menu (real clicks)
    manager.displays[0].setConfig('schedule', true);
    log(`moon click: ${await frameStats(() => click(item._moonButton), 600)}`);
    await sleep(300);
    log(`menu open=${item.menu.isOpen}`);
    {
        // the open menu must end above the bottom of the screen
        await sleep(400);
        const box = qs.menu.box;
        const [, by] = box.get_transformed_position();
        const mon = Main.layoutManager.findMonitorForActor(box);
        log(`fit: menu bottom ${Math.round(by + box.height)} / screen bottom ${mon.y + mon.height} scroll=${Math.round(item._scroll.height)} content=${Math.round(item._content.actor.get_preferred_height(item._scroll.width)[1])}`);
        await shot('03a-fit');
    }
    let t = GLib.get_monotonic_time();
    for (let i = 0; i < 20; i++)
        item._sync();
    log(`_sync: ${((GLib.get_monotonic_time() - t) / 20000).toFixed(2)} ms each`);
    t = GLib.get_monotonic_time();
    for (let i = 0; i < 20; i++) {
        item._graph.queue_repaint();
        await sleep(20);
    }
    log('graph repaint x20 done');
    // opening animation: our menu vs GNOME's own volume menu
    item.menu.close();
    await sleep(500);
    log(`open ours: ${await frameStats(async () => item.menu.open(), 450)}`);
    item.menu.close();
    await sleep(500);
    const vol = qs._volumeOutput?.quickSettingsItems?.[0];
    if (vol?.menu) {
        log(`open volume: ${await frameStats(async () => vol.menu.open(), 450)}`);
        vol.menu.close();
        await sleep(500);
    }
    item.menu.open();
    await sleep(500);
    await shot('03-monitor-menu');
    item.menu.close();
    await sleep(400);
    log(`moon click again: ${await frameStats(() => click(item._moonButton), 600)}`);
    await sleep(300);

    // info tooltip
    const info = findActor(item._scheduleSwitch, a => a.has_style_class_name?.('bp-info'));
    await moveTo(...center(info));
    await sleep(400);
    await shot('03b-info');
    log(`info tooltip visible=${obj._tooltip.actor.visible} text="${obj._tooltip.actor.text}"`);

    // layers
    const d0 = manager.displays[0];
    d0.setConfig('extra', 0.3);
    d0.setConfig('nightLight', 0.5);
    d0.setConfig('redLight', 1.5);
    await sleep(400);
    await shot('04-layers');
    log(`multipliers: night ${d0.cfg.nightLight} red ${d0.cfg.redLight} rows ${item._layers.nightLight.row.value.text} ${item._layers.redLight.row.value.text}`);

    // the evening defaults: sunset shaped, main monitor vs the others
    {
        const {curveKnots: knots, curveAt: at} = await import(GLib.Uri.resolve_relative(import.meta.url, '../src/lib/schedule.js', GLib.UriFlags.NONE));
        const main = manager.displays.find(x => x.index === Main.layoutManager.primaryIndex);
        const side = manager.displays.find(x => x !== main);
        const show = (d, key) => [60, 120, 240, 270, 330, 420, 510].map(m => `${m / 60}h:${Math.round(at(knots(d.cfg, key), m) / (key === 'night' ? d.cfg.day : 1) * 100)}`).join(' ');
        log(`defaults main: offset ${main.cfg.offset} duration ${main.cfg.duration} night ${main.cfg.night} curve ${show(main, 'night')} (of the day value)`);
        log(`defaults side: duration ${side.cfg.duration} night ${side.cfg.night} curve ${show(side, 'night')}; extra ${show(side, 'extra')}`);
        log(`main isDefault night=${manager.isDefault(main, 'night')} (must be true)`);
        log(`default buttons: main ${JSON.stringify(main.cfg.events)} (others must be 150), side ${JSON.stringify(side.cfg.events)} (all null)`);
        // no automatic buttons during the rest of the test (it may run late in the evening)
        for (const x of manager.displays)
            x.setConfig('events', {lowest: null, off: null, others: null});
    }

    // drag the graph: extra dimming curve up
    const g = item._graph;
    let [gx, gy] = g.get_transformed_position();
    const [gw, gh] = g.get_transformed_size();
    const geo = g._geometry();
    const endX = gx + geo.left + geo.pw * d0.cfg.duration / 540;
    const extraY = gy + geo.top + geo.ph * (1 - d0.cfg.extra);
    await moveTo(endX, extraY);
    await press(true);
    for (let i = 1; i <= 10; i++)
        await moveTo(endX, extraY - i * 4);
    await shot('04b-graph-drag');
    await press(false);
    log(`graph drag: extra ${d0.cfg.extra} (was 0.3)`);
    // left end: day brightness
    const dayY = gy + geo.top + geo.ph * (1 - d0.cfg.day);
    await moveTo(gx + geo.left + 2, dayY);
    await press(true);
    for (let i = 1; i <= 6; i++)
        await moveTo(gx + geo.left + 2, dayY + i * 3);
    await press(false);
    log(`graph drag: day ${d0.cfg.day}`);
    // a small point: drag it, then double-click = automatic again
    const sp = g._points(geo).find(p => p.key === 'night' && p.i === 2);
    const sx = gx + sp.x, sy = gy + sp.y;
    await moveTo(sx, sy);
    await press(true);
    for (let i = 1; i <= 5; i++)
        await moveTo(sx, sy - i * 4);
    await press(false);
    log(`small point: ${JSON.stringify(d0.cfg.points.night)} (2nd set)`);
    {
        await sleep(300);
        const resetOf = key => findActor(item._layers[key].row, x => x.has_style_class_name?.('bp-reset'));
        const reset = resetOf('night');
        log(`reset shown after moving a point: ${reset.opacity === 255} (must be true); red light ×${d0.cfg.redLight} reset: ${resetOf('redLight').opacity === 255} (must be true: not ×1)`);
        await shot('04b1-reset');
        await click(reset);
        await sleep(400);
        log(`after reset: points ${JSON.stringify(d0.cfg.points.night)} (all null) night=${d0.cfg.night} reset shown: ${reset.opacity === 255} (must be false)`);
        // move it again for the rest of the test
        d0.setConfig('points', {...d0.cfg.points, night: [null, 0.6, null, null, null, null]});
        await sleep(200);
    }
    await shot('04b2-point');
    // lane: + then the first choice (the reset click may have scrolled the menu)
    reveal(g);
    await sleep(80);
    [gx, gy] = g.get_transformed_position();
    const laneY = gy + geo.laneTop + 14;
    await moveTo(gx + geo.left + 13, laneY);
    await press(true);
    await press(false);
    await sleep(200);
    await moveTo(gx + geo.left + 43, laneY);
    await press(true);
    await press(false);
    await sleep(300);
    log(`lane events: ${JSON.stringify(d0.cfg.events)} (lowest set)`);
    await shot('04b3-lane');
    // automatic run at night, and back in the morning
    const nowMs = Date.now();
    manager._runActions(d0, new Date(nowMs), {phase: 'night', start: nowMs - (d0.cfg.events.lowest + 5) * 60000, next: nowMs + 3600000});
    log(`automatic lowest: minimum=${d0.minimum} (must be true)`);
    manager._runActions(d0, new Date(nowMs), {phase: 'morning', progress: 1, next: nowMs + 3600000});
    log(`morning: minimum=${d0.minimum} (must be false)`);
    {
        // turned off by the evening's button: only a little darker; by hand: fully black
        const ds = manager.displays[1];
        const layerOf = x => Main.layoutManager.uiGroup.get_children().find(a => a.name === `auto-brightness-plus-dim-${x.index}`);
        d0.setConfig('events', {lowest: null, off: null, others: 30});
        manager._runActions(d0, new Date(nowMs), {phase: 'night', start: nowMs - 35 * 60000, next: nowMs + 3600000});
        await sleep(1500);
        log(`others off by the evening: off=${ds.off} dark ${manager.offDarkOf(ds)} layer ${layerOf(ds)?.opacity} (must be true 0.25 64)`);
        manager.wake(ds.index);
        await sleep(800);
        manager.turnOffOthers(d0);
        await sleep(1500);
        log(`others off by hand: dark ${manager.offDarkOf(ds)} layer ${layerOf(ds)?.opacity} (must be 1 255)`);
        manager.wake(ds.index);
        d0.setConfig('events', {lowest: null, off: null, others: null});
        d0._fired.clear();
        await sleep(800);
    }
    d0.setConfig('events', {lowest: null, off: null, others: null});
    // drag horizontally: duration
    const endX2 = gx + geo.left + geo.pw * d0.cfg.duration / 540;
    const nightY = gy + geo.top + geo.ph * (1 - Math.min(d0.cfg.day, d0.cfg.night));
    await moveTo(endX2, nightY);
    await press(true);
    for (let i = 1; i <= 8; i++)
        await moveTo(endX2 - i * 6, nightY);
    await press(false);
    log(`graph drag: duration ${d0.cfg.duration} (was 240) graph ${gw}x${gh}`);
    await sleep(300);

    // lowest light
    const lowest = findActor(item.menu.box, a => a.has_style_class_name?.('bp-tile-lowest'));
    await click(lowest);
    await sleep(700);
    log(`lowest: minimum=${d0.minimum}`);
    log(`lowest on main monitor: dim layer opacity ${Main.layoutManager.uiGroup.get_children().find(x => x.name === `auto-brightness-plus-dim-${d0.index}`)?.opacity} (others would be ${Math.round(0.9 * 255)})`);
    await shot('04c-lowest');
    await click(lowest);
    await sleep(500);
    log(`lowest again: minimum=${d0.minimum}`);

    // turn off screen from its own menu: the pointer is on that screen
    const offBtn = findActor(item.menu.box, a => a.has_style_class_name?.('bp-tile-off'));
    await click(offBtn);
    await sleep(1200);
    log(`turn off own screen: off=${d0.off} (pointer on it, must stay off)`);
    await shot('04d-own-off');
    await moveTo(800 + 120, 600 + 80);
    await moveTo(800 + 200, 600 + 120);
    await sleep(500);
    log(`after moving the mouse: off=${d0.off} (must still be true)`);
    await press(true);
    await press(false);
    await sleep(500);
    log(`after a click: peek=${d0.peek} off=${d0.off} (must be true true: lit, still turned off)`);
    // the same button turns it back on
    qs.menu.open();
    await sleep(600);
    await click(item._moonButton);
    await sleep(700);
    await click(findActor(item.menu.box, a => a.has_style_class_name?.('bp-tile-off')));
    await sleep(600);
    log(`turn off pressed again: off=${d0.off} (must be false)`);
    item.menu.close();
    qs.menu.close();
    await sleep(400);

    // turn off others, and again = back on
    qs.menu.open();
    await sleep(600);
    await click(item._moonButton);
    await sleep(700);
    const othersBtn = findActor(item.menu.box, a => a.has_style_class_name?.('bp-tile-others'));
    await click(othersBtn);
    await sleep(800);
    log(`others: ${manager.displays.map(d => `${d.number}:${d.off}`).join(' ')} (2 must be off)`);
    {
        // the box under "Turn off screen" in the dark screen's own menu
        const it2 = obj._items[1];
        qs.menu.open();
        await sleep(600);
        await click(it2._moonButton);
        await sleep(800);
        reveal(it2._off.sec.actor);
        await sleep(200);
        await shot('04f2-off-box');
        log(`off box visible=${it2._off.sec.actor.visible} keep="${it2._off.keep.label.text}"`);
        const d2b = manager.displays[1];
        d2b.setConfig('offDark', 0.8);
        await sleep(500);
        const lay = Main.layoutManager.uiGroup.get_children().find(x => x.name === `auto-brightness-plus-dim-${d2b.index}`);
        log(`dark while off 80%: layer opacity ${lay?.opacity} (must be about ${Math.round(0.8 * 255)})`);
        d2b.setConfig('offDark', 0.7);
        manager.previewOff(d2b);
        await sleep(300);
        log(`dark slider moved: view=${d2b.view} (must be dark) opacity ${lay?.opacity} (must be about ${Math.round(0.7 * 255)}, at once)`);
        const gear = findActor(it2.menu.actor, x => x.has_style_class_name?.('bp-settings'));
        log(`settings button in the header: ${!!gear?.mapped}`);
        d2b.setConfig('offDark', 1);
        it2.menu.close();
        qs.menu.close();
        await sleep(400);
    }
    // peek: mouse onto the dark screen lights it, leaving darkens it again
    const d2 = manager.displays[1];
    {
        // passing by its edge (e.g. on the way to the dock) does not light it
        await moveTo(1600 + 6, 500);
        await sleep(700);
        await moveTo(800, 600);
        await sleep(300);
        log(`mouse along the edge: peek=${d2.peek} (must be false)`);
    }
    // the evening curve moved on while it was off (what tick() does): the peek shows that value
    manager._write(d2, 0.42);
    // every backlight change of a turned off screen must happen under full black
    const covered = [];
    const origTo = manager._backlightTo.bind(manager);
    manager._backlightTo = (d, v) => {
        if (d === d2 && d.off) {
            const layer = Main.layoutManager.uiGroup.get_children().find(x => x.name === `auto-brightness-plus-dim-${d.index}`);
            covered.push(layer?.visible ? layer.opacity : 0);
        }
        return origTo(d, v);
    };
    await moveTo(1600 + 300, 300);
    await sleep(1000);
    await moveTo(1600 + 320, 320);
    await sleep(400);
    log(`peek on screen 2: peek=${d2.peek} off=${d2.off} (must be true true)`);
    await sleep(600);
    log(`peek backlight: last DDC write for screen 2 = "${ddcCalls('setvcp').filter(l => l.includes(`--bus ${d2.bus}`)).at(-1)}" (must be 0: a turned off screen stays at its lowest light, only the layer fades)`);
    await shot('04g-peek');
    const busWrites = () => ddcCalls('setvcp').filter(l => l.includes(`--bus ${d2.bus}`)).map(l => Number(l.split(' ')[2]));
    const writesBefore = busWrites().length;
    await moveTo(800, 600);
    await sleep(500);
    log(`mouse back: peek=${d2.peek} off=${d2.off} (must be false true)`);
    log(`after leaving ("keep lit" off): view=${d2.view} (must be dark at once)`);
    {
        await sleep(2500);
        const lay2 = Main.layoutManager.uiGroup.get_children().find(x => x.name === `auto-brightness-plus-dim-${d2.index}`);
        const steps = busWrites().slice(writesBefore);
        log(`DDC writes while peeking and leaving: [${steps.join(' ')}] (must be none), then layer opacity ${lay2?.opacity} (must be 255)`);
        log(`backlight changes while turned off: ${covered.length} (must be 0)`);
        // "Keep lit" switched on: lit for the seconds after the mouse leaves, then dark
        settings.set_int('keep-lit-seconds', 5);
        d2.setConfig('keepLit', true);
        await moveTo(1600 + 300, 300);
        await sleep(400);
        await moveTo(1600 + 330, 330);
        await sleep(1500);
        await moveTo(800, 600);
        await sleep(600);
        log(`keep lit on, mouse left: view=${d2.view} (must be kept)`);
        await sleep(6500);
        log(`keep lit on, seconds over: view=${d2.view} (must be dark)`);
        d2.setConfig('keepLit', false);
        settings.reset('keep-lit-seconds');
        // "Dark while off" at its lowest (25 %): never darker than that, not even for a moment
        d2.setConfig('offDark', 0.25);
        await sleep(300);
        let maxOpacity = 0;
        const sampler = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
            maxOpacity = Math.max(maxOpacity, lay2?.visible ? lay2.opacity : 0);
            return GLib.SOURCE_CONTINUE;
        });
        await moveTo(1600 + 300, 300);
        await sleep(300);
        await moveTo(1600 + 330, 330);
        await sleep(1500);
        const litValue = busWrites().at(-1);
        await moveTo(800, 600);
        await sleep(2000);
        GLib.source_remove(sampler);
        log(`dark while off 25 %: backlight ${litValue} then ${busWrites().at(-1)} (must be 0 then 0), most black seen ${maxOpacity} (must be at most ${Math.round(0.25 * 255)})`);
        d2.setConfig('offDark', 1);
        await sleep(800);
        // lowest light, then turn off: lowest light must end
        const dl = manager.displays[0];
        manager.setMinimum(dl, true);
        manager.turnOff(dl, false);
        log(`turn off ends lowest light: minimum=${dl.minimum} (must be false) off=${dl.off}`);
        manager.wake(dl.index);
        await sleep(300);
    }

    // the corner dot opens the screen's menu
    log(`corner dot by default: ${settings.get_boolean('show-dot')} (must be false)`);
    settings.set_boolean('show-dot', true);
    manager.darkNow(d2);
    await moveTo(800, 600);
    await sleep(400);
    const dot = manager._dots._dots.get(d2.index)?.actor;
    log(`corner dot when switched on: shown=${!!dot?.mapped} (must be true)`);
    if (dot) {
        await click(dot);
        await sleep(500);
        log(`dot menu open=${!!manager._offMenu._menu?.menu.isOpen}`);
        await shot('04h-dot-menu');
        manager._offMenu.close();
        await sleep(200);
    }
    settings.reset('show-dot');

    // keep lit: stays lit with the mouse elsewhere, then dims
    manager.keepLit(d2, 2);
    await moveTo(800, 600);
    await sleep(800);
    log(`keep lit, mouse away: view=${d2.view} (must be kept)`);
    await sleep(2200);
    log(`keep lit over: view=${d2.view} (must be dark)`);

    manager.wake(d2.index);
    await sleep(400);
    qs.menu.open();
    await sleep(600);
    await click(item._moonButton);
    await sleep(700);
    log(`others button checked=${othersBtn.checked}`);
    await click(othersBtn);
    await sleep(800);
    log(`others again: ${manager.displays.map(d => `${d.number}:${d.off}`).join(' ')} (all on)`);
    item.menu.close();
    await sleep(300);

    // header placement
    settings.set_string('buttons-position', 'header');
    await sleep(800);
    const hitem = obj._items[0];
    await click(hitem._moonButton);
    await sleep(800);
    await shot('04e-header-buttons');
    settings.set_string('buttons-position', 'top');
    await sleep(800);
    await click(obj._items[0]._moonButton);
    await sleep(800);
    await shot('04f-top-buttons');
    settings.set_string('buttons-position', 'bottom');
    await sleep(800);
    const d1 = manager.displays[0];
    d1.setConfig('extra', 0);
    d1.setConfig('nightLight', 1);
    d1.setConfig('redLight', 1);
    await sleep(300);
    qs.menu.open();
    await sleep(600);

    // ---- Night Light / red screen in the graph, and their sliders only while they are on
    {
        const item = obj._items[0];   // the sliders were rebuilt above
        const color = new Gio.Settings({schema_id: 'org.gnome.settings-daemon.plugins.color'});
        color.set_boolean('night-light-enabled', true);
        color.set_boolean('night-light-schedule-automatic', false);
        color.set_double('night-light-schedule-from', 19.0);
        color.set_double('night-light-schedule-to', 7.0);
        settings.set_boolean('red-enabled', false);
        qs.menu.open();
        await sleep(700);
        if (!item.menu.isOpen)
            await click(item._moonButton);
        await sleep(800);
        const bars = item._graph._gnomeBars(item._graph._startTime());
        log(`graph bars: ${bars.map(b => `${b.row ? 'red' : 'night'} ${Math.round(b.from)}..${Math.round(b.to)} min`).join(', ')}`);
        log(`night light slider adjustable=${item._layers.nightLight.row.slider.reactive} (must be true), red=${item._layers.redLight.row.slider.reactive} (must be false: red screen off)`);
        await shot('04n-gnome-bars');
        // the settings button stays in the top right corner, even with a long monitor name
        const gear = findActor(item.menu.actor, x => x.has_style_class_name?.('bp-settings'));
        const title = item.menu._headerTitle;
        const [gx] = gear.get_transformed_position();
        const [tx] = title.get_transformed_position();
        const [mx] = item.menu.actor.get_transformed_position();
        log(`gear right edge gap ${Math.round(mx + item.menu.actor.width - (gx + gear.width))}px, title ends ${Math.round(tx + title.width)} < gear ${Math.round(gx)}: ${tx + title.width <= gx}`);
        color.set_boolean('night-light-enabled', false);
        await sleep(300);
        log(`night light off: slider adjustable=${item._layers.nightLight.row.slider.reactive} (must be false)`);
        color.set_boolean('night-light-enabled', true);
        // reset next to Night light: ×1 and GNOME's automatic time again
        color.set_boolean('night-light-schedule-automatic', false);
        d0.setConfig('nightLight', 1.6);
        await sleep(200);
        const nlReset = findActor(item._layers.nightLight.row, a => a.has_style_class_name?.('bp-reset'));
        log(`night light reset shown: ${nlReset.opacity === 255} (must be true)`);
        nlReset.emit('clicked', 0);
        await sleep(200);
        log(`night light reset: ×${d0.cfg.nightLight} (must be 1) automatic=${color.get_boolean('night-light-schedule-automatic')} (must be true) shown=${nlReset.opacity === 255} (must be false)`);
        // a switch in the monitor menu: Quick Settings stays open
        await click(item._morningSwitch);
        await sleep(300);
        log(`switch clicked: quick settings open=${qs.menu.isOpen} (must be true) morning=${d0.cfg.morningReset}`);
        await click(item._morningSwitch);
        await sleep(300);

        // the simple menu: pills + one slider, the buttons on the graph
        settings.set_string('menu-style', 'simple');
        await sleep(400);
        item._fitHeight();
        reveal(item._graph);
        await sleep(300);
        const pick = item._pick;
        log(`simple menu: pills shown=${pick.box.mapped} detailed rows hidden=${!item._layers.day.row.visible && !item._start.visible} (must be true true)`);
        await shot('04p-simple');
        await click(pick.pills.extra.pill);
        await sleep(300);
        pick.slider.value = 0.4;
        await sleep(300);
        log(`pill "extra" + slider 40 %: key=${pick.key} extra=${item._display.cfg.extra} value="${pick.valueLabel.text}" (must be extra 0.4)`);
        await click(pick.pills.night.pill);
        await sleep(300);
        log(`pill "night": slider ${Math.round(pick.slider.value * 100)} % = night ${Math.round(item._display.cfg.night * 100)} %`);
        item._display.setConfig('extra', 0);
        // + in the graph's corner, then a choice: the button lands on the graph
        {
            const g = item._graph;
            item._display.setConfig('events', {lowest: null, off: null, others: null});
            await sleep(200);
            reveal(g);
            await sleep(300);
            const geo = g._geometry();
            const lane = g._lane(geo);
            const [gx2, gy2] = g.get_transformed_position();
            log(`graph at ${Math.round(gx2)},${Math.round(gy2)} + at ${Math.round(lane.plus.x)},${Math.round(lane.plus.y)} scroll=${item._scroll.height}`);
            await moveTo(gx2 + lane.plus.x, gy2 + lane.plus.y);
            await press(true);
            await press(false);
            await sleep(300);
            const choice = g._lane(geo).choices[0];
            if (!choice)
                throw new Error(`the + did not open (choosing=${g._choosing})`);
            await moveTo(gx2 + choice.x, gy2 + choice.y);
            await press(true);
            await press(false);
            await sleep(300);
            log(`inline +: ${JSON.stringify(item._display.cfg.events)} (lowest set)`);
            await shot('04q-simple-lane');
            item._display.setConfig('events', {lowest: null, off: null, others: null});
        }
        settings.set_string('menu-style', 'detailed');
        await sleep(300);
        // automatic dimming off: extra dimming goes to 0 with it
        const dx = item._display;
        dx.setConfig('extra', 0.4);
        item._scheduleSwitch.setToggleState(false);
        item._scheduleSwitch.emit('toggled', false);
        log(`automatic dimming off: extra=${dx.cfg.extra} (must be 0) schedule=${dx.cfg.schedule}`);
        item._scheduleSwitch.setToggleState(true);
        item._scheduleSwitch.emit('toggled', true);
        color.set_boolean('night-light-enabled', false);
        color.reset('night-light-schedule-automatic');
        color.reset('night-light-schedule-from');
        color.reset('night-light-schedule-to');
        item.menu.close();
        await sleep(300);
    }

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
    manager.turnOff(manager.displays[1]);
    await sleep(800);
    await shot('10-minimum-light');
    manager.wakeAll();
    await sleep(600);

    // ---- schedule: pretend it is night
    const d = manager.displays[0];
    log(`phase now: ${JSON.stringify(manager.phaseOf(d))}`);

    // ---- "Claude is done": the terminal's turned off screen lights up, a notification appears
    {
        const d1 = manager.displays[0], d2c = manager.displays[1];
        manager.wakeAll();
        settings.set_int('keep-lit-seconds', 5);
        const childFile = `${OUT}/child.pid`;
        const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
        launcher.setenv('WAYLAND_DISPLAY', 'bp-test-0', true);
        launcher.setenv('GDK_BACKEND', 'wayland', true);
        launcher.setenv('BP_TEST_CHILD_PID', childFile, true);
        const created = new Promise(resolve => {
            const id = global.display.connect('window-created', (dpy, w) => {
                global.display.disconnect(id);
                resolve(w);
            });
        });
        const proc = launcher.spawnv(['gjs', '-m', GLib.getenv('BP_TEST_WINDOW')]);
        const win = await created;
        await sleep(700);
        win.move_to_monitor(d2c.index);
        await sleep(500);
        manager.turnOffOthers(d1);
        await moveTo(800, 600);
        await sleep(600);
        const child = Number(new TextDecoder().decode(GLib.file_get_contents(childFile)[1]));
        const source = (await import('resource:///org/gnome/shell/ui/messageTray.js')).getSystemSource();
        const before = source.notifications.length;
        // what the Claude hook runs
        const gd = Gio.Subprocess.new(['gdbus', 'call', '--session', '--dest', 'org.gnome.Shell', '--object-path',
            '/org/gnome/Shell/Extensions/AutoBrightnessPlus', '--method', 'org.gnome.Shell.Extensions.AutoBrightnessPlus.Notify',
            'done', String(child)], Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE);
        await new Promise(r => gd.wait_async(null, () => r()));
        await sleep(600);
        log(`claude done (pid ${child} under the window's app): view=${d2c.view} (must be kept) notifications +${source.notifications.length - before} (must be 1) title="${source.notifications.at(-1)?.title}"`);
        await shot('04m-claude-done');
        await sleep(5800);
        log(`after keep-lit seconds: view=${d2c.view} (must be dark)`);
        // the terminal on a lit screen (e.g. the main one): still a notification
        manager.wakeAll();
        await sleep(300);
        const n2 = source.notifications.length;
        obj._notify.handle('done', child);
        log(`terminal on a lit screen: notifications +${source.notifications.length - n2} (must be 1)`);
        settings.set_int('keep-lit-seconds', 45);
        proc.force_exit();
        await sleep(300);
    }

    // ---- everything set must come back after a restart (disable + enable = a new session)
    {
        const d = manager.displays[0];
        d.setConfig('schedule', true);
        d.setConfig('day', 0.83);
        d.setConfig('night', 0.27);
        d.setConfig('extra', 0.4);
        d.setConfig('duration', 195);
        d.setConfig('nightLight', 1.3);
        d.setConfig('redLight', 0.7);
        d.setConfig('points', {night: [0.7, null, 0.5, 0.25, null, 0.2], extra: [null, null, null, null, null, null]});
        d.setConfig('events', {lowest: 530, off: null, others: null});   // late: must not run during the test
        d.setConfig('morningReset', false);
        settings.set_double('red-strength', 0.55);
        // before a reboot: a screen turned off by hand, lowest light, and "turn off other
        // screens" whose time is long over: none of them comes back
        manager.turnOff(manager.displays[1], false, false, true);
        manager.setMinimum(d, true);
        d.setConfig('events', {lowest: 530, off: null, others: 1});
        globalThis.BP_SAVED = JSON.stringify(d.cfg, (k, v) => (k === 'last' ? undefined : v));
    }

    // ---- disable / enable cycle
    Main.extensionManager.disableExtension(UUID);
    await sleep(800);
    log(`after disable: dim actors=${Main.layoutManager.uiGroup.get_children().filter(a => a.name?.startsWith('auto-brightness-plus')).length} effects=${Main.layoutManager.uiGroup.get_effects().length}`);
    Main.extensionManager.enableExtension(UUID);
    await sleep(2500);
    const ext2 = Main.extensionManager.lookup(UUID);
    log(`re-enabled state=${ext2?.state} items=${ext2?.stateObj?._items?.length}`);
    {
        const d = ext2.stateObj._manager.displays[0];
        await sleep(500);
        const now = JSON.stringify(d.cfg, (k, v) => (k === 'last' ? undefined : v));
        log(`remembered after restart: ${now === globalThis.BP_SAVED ? 'yes' : `NO\n  before ${globalThis.BP_SAVED}\n  after  ${now}`} red-strength=${settings.get_double('red-strength')}`);
        const d2r = ext2.stateObj._manager.displays[1];
        log(`turned off screen after restart: off=${d2r.off} (must be false: no button survives a restart, a past "others" does not run) day=${d2r.cfg.day} (must not be 0)`);
        log(`lowest light after restart: ${d.minimum} (must be false)`);
        // the morning after: the monitor still shows the 0 we wrote, its day value is 0.83
        const mgr2 = ext2.stateObj._manager;
        d.setConfig('schedule', false);
        d.cfg.last = 0;
        mgr2._hardwareValue(d, 0);
        log(`boot read 0 that we wrote: value=${d.value} day=${d.cfg.day} (must be 0.83 0.83)`);
        ext2.stateObj._manager.wake(d2r.index);
    }
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
