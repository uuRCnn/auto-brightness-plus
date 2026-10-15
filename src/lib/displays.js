// The model: one Display per monitor, how to reach its hardware, its
// settings, and the evening dimming timer.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {DdcBackend} from './ddc.js';
import {findBacklights, legacyBacklight} from './backlight.js';
import {DimOverlays} from './overlay.js';
import {GammaController} from './gamma.js';
import {CornerDots} from './cornerdot.js';
import {OffMenu} from './offmenu.js';
import {getLocation, shareWithNightLight, watchLocation} from './location.js';
import {curveMoving, dayTimes, layerValues, phaseAt, scheduledValue} from './schedule.js';
import {fmt} from './sun.js';

const EXTRA_MAX = 0.9;        // extra dimming slider at 100% = 90% darker
const SOFT_MAX = 0.85;        // software-only monitor at 0% = 85% darker
const SAVE_DELAY_MS = 1500;
// 2: the sunset-shaped evening, 3: + the others off after 3 h,
// 4: starts an hour before sunset, the others off 1.5 h after sunset
const CONFIG_VERSION = 4;
// the evening starts an hour before sunset (default-offset)
const MAIN_DURATION = 300;     // main monitor: −30 % by sunset, 10 % four hours after it
const SIDE_DURATION = 330;     // the others: −50 % by sunset, 0 % 4.5 h after it
const MAIN_SHAPE = [0.58, 0.25, 0.10];
const SIDE_SHAPE = [0.34, 0.14, 0.05];
const OTHERS_OFF_AFTER = 150;  // minutes after the start = 1.5 h after sunset
const SIDE_EXTRA = [null, null, null, 0.03, 0.10, 0.15];  // … and extra dimming late at night, up to 15 %
const DDC_TRIES = 3;
const LOWEST_PRIMARY = 0.7;   // lowest light on the main monitor keeps a little more light
const WATCH_MS = 150;          // where the mouse is, only while a screen is turned off
const MOVE_TO_LIGHT = 60;      // turned off under the mouse: move this far to light it
const PEEK_DWELL_MS = 350;     // the mouse must stay this long on a turned off screen …
const PEEK_INSET = 24;         // … and this far from its edges: passing a corner (e.g. to the dock) does not light it
export const OFF_DARK_MIN = 0.25;   // "Dark while off" goes from 25 % to 100 % (fully black)
const PREVIEW_MS = 1500;      // a moved "turned off" slider shows its value this long
const SAME_VALUE = 0.015;     // read back within 1.5 % of what we wrote: not touched by hand
const RESCAN_DELAY_S = 4;
const MAX_SLEEP_S = 600;      // re-check at least every 10 min (suspend safe)
const CURVE_STEP_S = 20;      // while the curves move: look again every 20 s (writes only on change)
export const ACTIONS = ['lowest', 'off', 'others'];

// ddcutil says HDMI-A-1, mutter says HDMI-1
function connectorAliases(c) {
    const short = c.replace(/^(HDMI|DVI)-[A-Z]-/, '$1-');
    return short === c ? [c] : [c, short];
}

// PNP vendor ids -> brand names (the common ones)
const BRANDS = {
    ACI: 'ASUS', AUS: 'ASUS', ACR: 'Acer', AOC: 'AOC', APP: 'Apple', BNQ: 'BenQ', DEL: 'Dell',
    DELL: 'Dell', GBT: 'Gigabyte', GSM: 'LG', HPN: 'HP', HWP: 'HP', HKC: 'HKC', IVM: 'iiyama',
    LEN: 'Lenovo', MSI: 'MSI', MEI: 'Panasonic', NEC: 'NEC', PHL: 'Philips', SAM: 'Samsung',
    SNY: 'Sony', VSC: 'ViewSonic', XMI: 'Xiaomi', HPQ: 'HP', EIZ: 'EIZO', FUS: 'Fujitsu',
    SHP: 'Sharp', TCL: 'TCL', HSD: 'HannStar', HRE: 'Haier', KOS: 'KOORUI', GGL: 'Google',
};

function prettyName(d) {
    const brand = BRANDS[d.mfg] ?? d.mfg;
    const model = d.model.replace(/\s+SERIES$/i, '').trim();
    if (!model)
        return brand || _('Monitor');
    return model.toLowerCase().startsWith(brand.toLowerCase()) ? model : `${brand} ${model}`;
}

function shortOf(name, mfg) {
    const brand = BRANDS[mfg] ?? name.split(/\s+/)[0] ?? '';
    if (brand.length <= 3)
        return brand.toUpperCase();
    const caps = brand.replace(/[^A-Z]/g, '');
    if (caps.length >= 2 && caps.length <= 3)
        return caps;
    return (mfg && mfg.length <= 3 ? mfg : brand.slice(0, 3)).toUpperCase();
}

export class Display extends EventEmitter {
    constructor(manager, props) {
        super();
        this._manager = manager;
        Object.assign(this, props);
        this.value = this.cfg.day;
        this.off = false;
        // a turned off screen is 'dark', 'peek' (the mouse is on it) or
        // 'kept' (lit for a while, the mouse elsewhere)
        this.view = null;
        this.minimum = false;
        this.override = null;
        this.phase = null;
        this._fired = new Set();      // automatic buttons already run tonight
        this._wasNight = false;
        this.ready = this.kind === 'soft';
    }

    get peek() {
        return this.view === 'peek';
    }

    /** Slider moved by the user. */
    setUser(v) {
        this._manager.userSet(this, v);
    }

    setConfig(key, value) {
        if (this.cfg[key] === value)
            return;
        this.cfg[key] = value;
        this._manager.configChanged(this, key);
    }
}

export class DisplayManager extends EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this.displays = [];
        this._config = this._loadConfig();
        this._timer = 0;
        this._saveTimer = 0;
        this._rescanTimer = 0;
        this._backlightHandles = [];
        this._buildSerial = 0;
        this._destroyed = false;

        this._ddc = new DdcBackend(settings, msg => this.log(msg));
        this._overlays = new DimOverlays();
        this._watchTimer = 0;
        this._offMenu = new OffMenu(this, settings, this._overlays);
        this._dots = new CornerDots(this, settings, this._overlays);
        this.gamma = new GammaController(msg => this.log(msg));
        this._readGlobals();
        if (shareWithNightLight(this.globals.location))
            this.log(`Night Light had no location: gave it ${this.globals.location.source} ${this.globals.lat.toFixed(1)}, ${this.globals.lon.toFixed(1)}`);

        this._settingsIds = [
            'schedule-mode', 'transition-minutes', 'morning-offset', 'morning-time',
            'location-mode', 'latitude', 'longitude',
        ].map(k => settings.connect(`changed::${k}`, () => this._globalsChanged()));
        this._settingsIds.push(settings.connect('changed::rescan', () => this.rebuild(true)));
        this._unwatchLocation = watchLocation(() => this._globalsChanged());

        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => {
            this._overlays.rebuild();
            this.gamma.relayout();
            this._scheduleRescan();
        });

        // after suspend the clock jumped and monitors may have reset themselves
        this._sleepId = Gio.DBus.system.signal_subscribe('org.freedesktop.login1',
            'org.freedesktop.login1.Manager', 'PrepareForSleep', '/org/freedesktop/login1', null,
            Gio.DBusSignalFlags.NONE, (c, s, p, i, sig, params) => {
                const [sleeping] = params.deepUnpack();
                if (!sleeping)
                    this._afterResume();
            });

        this.rebuild(false);
    }

    log(msg) {
        if (this._settings.get_boolean('debug'))
            console.log(`[Auto Brightness+] ${msg}`);
    }

    // ------------------------------------------------------------ config
    _loadConfig() {
        try {
            const c = JSON.parse(this._settings.get_string('monitor-config'));
            return c && typeof c === 'object' ? c : {};
        } catch {
            return {};
        }
    }

    /*
     * The evening a monitor starts with: from sunset, quickly at first. The
     * main monitor goes down to the night value; the others go further, to
     * 0, and later in the night a little extra dimming comes on them.
     */
    _eveningDefaults(primary) {
        const s = this._settings;
        const none = () => Array(6).fill(null);
        return {
            offset: s.get_int('default-offset'),
            duration: primary ? MAIN_DURATION : SIDE_DURATION,
            night: primary ? s.get_double('default-night') : 0,
            shape: primary ? [...MAIN_SHAPE] : [...SIDE_SHAPE],
            extra: 0,
            points: {night: none(), extra: primary ? none() : [...SIDE_EXTRA]},
            // the main monitor turns the others off 3 hours after the evening starts
            events: {lowest: null, off: null, others: primary ? OTHERS_OFF_AFTER : null},
        };
    }

    /** Is d's evening (layer key, or all of it) still as it starts? */
    isDefault(d, key) {
        const def = this._eveningDefaults(d.index === Main.layoutManager.primaryIndex);
        const same = (a, b) => a.every((v, i) => v === b[i]);
        if (key === 'night') {
            return d.cfg.night === Math.min(def.night, d.cfg.day ?? 1) && same(d.cfg.points.night, def.points.night) &&
                same(d.cfg.shape ?? [], def.shape);
        }
        if (key === 'extra')
            return d.cfg.extra === def.extra && same(d.cfg.points.extra, def.points.extra);
        return d.cfg.nightLight === 1;
    }

    /** One layer of d's evening back to how it starts. */
    resetLayer(d, key) {
        const def = this._eveningDefaults(d.index === Main.layoutManager.primaryIndex);
        if (def.points[key])
            d.cfg.points = {...d.cfg.points, [key]: def.points[key]};
        if (key === 'night') {
            d.cfg.night = Math.min(def.night, d.cfg.day ?? 1);
            d.cfg.shape = def.shape;
        }
        else if (key === 'extra')
            {d.cfg.extra = def.extra;}
        else
            {d.cfg.nightLight = 1;}
        this.configChanged(d, key);
    }

    _cfgFor(id, primary) {
        const s = this._settings;
        let c = this._config[id] ?? {};
        // made before these defaults (or new): the evening starts from them
        if (c.v === 2 || c.v === 3) {
            // already has the sunset evening: it now starts an hour earlier, with its
            // new first hour; the own night value and extra dimming stay
            const def = this._eveningDefaults(primary);
            const events = {...c.events};
            if (primary)
                events.others = OTHERS_OFF_AFTER;
            c = {...c, offset: def.offset, duration: def.duration, shape: def.shape, events,
                points: {...c.points, night: def.points.night}, v: CONFIG_VERSION};
        } else if (c.v !== CONFIG_VERSION) {
            c = {...c, ...this._eveningDefaults(primary), v: CONFIG_VERSION};
        }
        const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
        const cfg = {
            day: num(c.day, null),
            schedule: c.schedule === true,
            offset: num(c.offset, s.get_int('default-offset')),
            start: num(c.start, s.get_int('default-start')),
            duration: num(c.duration, s.get_int('default-duration')),
            night: num(c.night, s.get_double('default-night')),
            extra: num(c.extra, 0),
            nightLight: num(c.nightLight, 1),
            redLight: num(c.redLight, 1),
            last: num(c.last, null),
            // the 6 small graph points per layer, null = automatic
            points: {
                night: [...Array(6).keys()].map(i => num(c.points?.night?.[i], null)),
                extra: [...Array(6).keys()].map(i => num(c.points?.extra?.[i], null)),
            },
            // buttons that run by themselves: minutes after the evening start, null = not used
            events: Object.fromEntries(ACTIONS.map(a => [a, num(c.events?.[a], null)])),
            shape: Array.isArray(c.shape) && c.shape.length === 3 && c.shape.every(v => typeof v === 'number')
                ? c.shape : null,
            morningReset: c.morningReset !== false,
            // a turned off screen: how black on top of the monitor's lowest light (1 = fully black),
            // and whether it stays lit for a while after the mouse leaves
            v: CONFIG_VERSION,
            // by hand fully black (you see it is off); by the evening's buttons only a little darker
            offDark: Math.max(OFF_DARK_MIN, Math.min(1, num(c.offDark, 1))),
            offDarkAuto: Math.max(OFF_DARK_MIN, Math.min(1, num(c.offDarkAuto, OFF_DARK_MIN))),
            offAuto: c.offAuto === true,
            keepLit: c.keepLit === true,
            // turned off / lowest light when the computer was shut down: comes back that way
            // turned off by hand with its own button: comes back that way after a restart
            // (lowest light and "turn off other screens" never do)
            off: c.off === true,
            offAt: num(c.offAt, 0),
            minimum: false,
        };
        this._config[id] = cfg;
        return cfg;
    }

    _save() {
        if (this._saveTimer)
            return;
        this._saveTimer = GLib.timeout_add(GLib.PRIORITY_LOW, SAVE_DELAY_MS, () => {
            this._saveTimer = 0;
            this._flush();
            return GLib.SOURCE_REMOVE;
        });
    }

    _flush() {
        const json = JSON.stringify(this._config);
        if (json !== this._settings.get_string('monitor-config'))
            this._settings.set_string('monitor-config', json);
    }

    _readGlobals() {
        const s = this._settings;
        const loc = getLocation(s);
        this.globals = {
            mode: s.get_string('schedule-mode'),
            transition: s.get_int('transition-minutes'),
            morningOffset: s.get_int('morning-offset'),
            morningTime: s.get_int('morning-time'),
            lat: loc.lat,
            lon: loc.lon,
            location: loc,
        };
    }

    _globalsChanged() {
        this._readGlobals();
        this.tick();
        this.emit('schedule-changed');
    }

    // ------------------------------------------------------------ monitors
    _scheduleRescan() {
        if (this._rescanTimer)
            GLib.source_remove(this._rescanTimer);
        this._rescanTimer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 2, () => {
            this._rescanTimer = 0;
            this.rebuild(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * (Re)build the display list.
     * @param {boolean} fresh run a new ddcutil scan instead of using the cache
     */
    async rebuild(fresh) {
        const serial = ++this._buildSerial;
        let ddc = fresh ? null : this._ddc.cachedDisplays();
        const usedCache = !!ddc;
        try {
            if (!ddc)
                ddc = await this._ddc.detect();
        } catch (e) {
            this.log(`detect failed: ${e.message}`);
            ddc = [];
        }
        if (serial !== this._buildSerial || this._destroyed)
            return;

        let backlights = findBacklights();
        if (!backlights) {
            const legacy = await legacyBacklight().catch(() => null);
            if (serial !== this._buildSerial || this._destroyed)
                return;
            backlights = legacy ? [legacy] : [];
        }
        this._assemble(ddc, backlights);

        // the cache may be stale: verify in the background, quietly
        if (usedCache) {
            this._rescanTimer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, RESCAN_DELAY_S, () => {
                this._rescanTimer = 0;
                this._verifyCache(ddc);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    async _verifyCache(cached) {
        try {
            const fresh = await this._ddc.detect();
            const key = list => list.map(d => `${d.bus}/${d.connector}/${d.id}`).sort().join('|');
            if (!this._destroyed && key(fresh) !== key(cached)) {
                this.log('monitor list changed, rebuilding');
                this.rebuild(true);
            }
        } catch {}
    }

    _assemble(ddcList, backlights) {
        const mm = global.backend.get_monitor_manager();
        const monitors = Main.layoutManager.monitors;
        const indexOf = c => {
            for (const name of c ? connectorAliases(c) : []) {
                const i = mm.get_monitor_for_connector(name);
                if (i >= 0)
                    return i;
            }
            return -1;
        };
        const taken = new Map();

        for (const bl of backlights) {
            const i = indexOf(bl.connector);
            const index = i >= 0 ? i : (monitors.length === 1 && !ddcList.length ? 0 : -1);
            if (index >= 0 && !taken.has(index))
                taken.set(index, {kind: 'backlight', bl});
        }
        const unmatched = [];
        for (const d of ddcList) {
            const i = indexOf(d.connector);
            if (i >= 0 && !taken.has(i))
                taken.set(i, {kind: 'ddc', d});
            else
                unmatched.push(d);
        }
        // no connector info (e.g. some proprietary drivers): fill in order
        for (const m of monitors) {
            if (!unmatched.length)
                break;
            if (!taken.has(m.index))
                taken.set(m.index, {kind: 'ddc', d: unmatched.shift()});
        }

        // tear down the old list; turned off screens stay turned off
        this._backlightHandles.splice(0).forEach(h => h());
        const wasOff = new Set();
        for (const d of this.displays) {
            if (d.off)
                wasOff.add(d.id);
            this._clearView(d);
            d.off = false;
            d.view = null;
            this._dots.sync(d);
            this._overlays.set(d.index, 0);
            this.gamma.setMonitor(d.index, 1, 1);
        }

        const order = [...monitors].sort((a, b) => a.x - b.x || a.y - b.y);
        const displays = [];
        order.forEach((m, pos) => {
            const t = taken.get(m.index);
            let props;
            if (t?.kind === 'ddc') {
                const name = prettyName(t.d);
                props = {id: t.d.id, kind: 'ddc', name, shortName: shortOf(name, t.d.mfg), bus: t.d.bus, max: 100};
            } else if (t?.kind === 'backlight') {
                props = {id: 'builtin', kind: 'backlight', name: _('Built-in Display'),
                    shortName: _('Built-in').slice(0, 3), bl: t.bl};
            } else {
                const name = this._mutterName(m.index) ?? fmt(_('Monitor %d'), pos + 1);
                props = {id: `soft:${this._connectorOf(m.index) ?? m.index}`, kind: 'soft', name,
                    shortName: shortOf(name, '')};
            }
            props.index = m.index;
            props.number = pos + 1;
            props.cfg = this._cfgFor(props.id, m.index === Main.layoutManager.primaryIndex);
            displays.push(new Display(this, props));
        });

        // same short name twice: add the number
        const counts = {};
        displays.forEach(d => (counts[d.shortName] = (counts[d.shortName] ?? 0) + 1));
        displays.forEach(d => {
            if (counts[d.shortName] > 1)
                d.shortName = `${d.shortName}${d.number}`;
        });

        this.displays = displays;
        this.log(`displays: ${displays.map(d => `${d.number}:${d.kind}:${d.name}`).join(', ')}`);
        this.emit('displays-changed');

        for (const d of displays) {
            this._initValue(d);
            if (wasOff.has(d.id))
                this.turnOff(d, false, d.cfg.offAuto, d.cfg.off);
        }
    }

    _connectorOf(index) {
        try {
            for (const lm of global.backend.get_monitor_manager().get_logical_monitors?.() ?? []) {
                for (const m of lm.get_monitors?.() ?? []) {
                    const c = m.get_connector();
                    if (global.backend.get_monitor_manager().get_monitor_for_connector(c) === index)
                        return c;
                }
            }
        } catch {}
        return null;
    }

    _mutterName(index) {
        try {
            const mm = global.backend.get_monitor_manager();
            for (const lm of mm.get_logical_monitors?.() ?? []) {
                for (const m of lm.get_monitors?.() ?? []) {
                    if (mm.get_monitor_for_connector(m.get_connector()) === index)
                        return m.get_display_name?.() ?? null;
                }
            }
        } catch {}
        return null;
    }

    async _initValue(d) {
        if (d.kind === 'ddc') {
            // some monitors do not answer the first time after boot
            let info = null;
            for (let i = 0; i < DDC_TRIES && !info; i++) {
                if (i) {
                    await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_LOW, 1500 * i, () => {
                        resolve();
                        return GLib.SOURCE_REMOVE;
                    }));
                }
                if (this._destroyed || !this.displays.includes(d))
                    return;
                try {
                    info = await this._ddc.getBrightness(d.bus);
                } catch (e) {
                    this.log(`getvcp ${d.bus} (try ${i + 1}): ${e.message}`);
                }
            }
            if (this._destroyed || !this.displays.includes(d))
                return;
            if (info) {
                d.max = info.max;
                this._hardwareValue(d, info.current / info.max);
            } else {
                // DDC does not answer: behave like a software monitor
                d.kind = 'soft';
                this._hardwareValue(d, d.cfg.day ?? 1);
            }
        } else if (d.kind === 'backlight') {
            this._hardwareValue(d, d.bl.get());
            this._backlightHandles.push(d.bl.connectChanged(() => {
                if (d._writingBacklight)
                    return;
                const v = d.bl.get();
                if (Math.abs(v - d.value) > 0.004)
                    this.userSet(d, v, false);
            }));
        } else {
            this._hardwareValue(d, d.cfg.day ?? 1);
        }
    }

    // a morning since `t` (ms)? Then the screens turned off by hand come back on
    _morningSince(d, t) {
        const now = new Date();
        const today = dayTimes(now, d.cfg, this.globals).morningStart;
        const last = now.getTime() >= today ? today : dayTimes(new Date(now.getTime() - 86400000), d.cfg, this.globals).morningStart;
        return t < last;
    }

    // first value read from the monitor
    _hardwareValue(d, v) {
        d.ready = true;
        const phase = d.cfg.schedule ? phaseAt(new Date(), d.cfg, this.globals) : null;
        // turned off by hand at shutdown: stays off, unless the morning came in between
        const keepOff = d.cfg.off && !(d.cfg.morningReset && this._morningSince(d, d.cfg.offAt));
        if (!keepOff)
            d.cfg.off = false;
        // What we wrote ourselves (the night value, the 0 of a turned off screen …)
        // is not a new day value: then the schedule decides, and the monitor gets
        // it written again. Otherwise the monitor's own buttons changed it: in
        // daytime (or without automatic dimming) that is the new day brightness.
        const ours = d.cfg.last !== null && Math.abs(v - d.cfg.last) <= SAME_VALUE;
        if (d.cfg.day === null)
            d.cfg.day = v > 0.02 ? v : 1;
        else if (!ours && (!phase || phase.phase === 'day'))
            d.cfg.day = v;
        d.value = ours ? (phase ? scheduledValue(phase, d.cfg) : d.cfg.day) : v;
        d.phase = phase;
        this._save();
        this._applyLayers(d);
        if (keepOff && !d.off)
            this.turnOff(d, false, false, true);
        else if (ours && Math.abs(v - d.value) > 0.005)
            this._writeHardware(d, d.value);
        d.emit('changed');
        this.tick();
    }

    // ------------------------------------------------------------ output
    _write(d, v) {
        v = Math.min(1, Math.max(0, v));
        d.value = v;
        if (!d.off && !d.minimum)
            this._writeHardware(d, v);
        this._applyOverlay(d);
        d.emit('changed');
    }

    // what the hardware should show right now
    _restoreHardware(d) {
        if (d.kind !== 'soft')
            this._writeHardware(d, d.minimum ? 0 : d.value);
    }

    _writeHardware(d, v, queue = true) {
        if (d.kind !== 'soft' && d.cfg.last !== v) {
            d.cfg.last = v;
            this._save();
        }
        d._backlight = v;
        if (d.kind === 'ddc' && !queue)
            return;     // _backlightTo queues it itself, to wait for it
        if (d.kind === 'ddc') {
            this._ddc.setBrightness(d.bus, Math.round(v * d.max));
        } else if (d.kind === 'backlight') {
            d._writingBacklight = true;
            d.bl.set(v);
            d._writingBacklight = false;
        }
    }

    _lit(d) {
        return d.view === 'peek' || d.view === 'kept';
    }

    _applyOverlay(d, animate = false, fast = false, slow = false) {
        this._dots.sync(d);
        // a turned off screen in the middle of a change: the change ends with the right value
        if (d._moving)
            return;
        this._overlays.set(d.index, this._overlayAlpha(d), {animate, fast, slow});
    }

    // the black layer for d's current state
    _overlayAlpha(d, view = d.off && d._preview ? 'dark' : d.view) {
        const value = d.minimum ? 0 : d.value;
        const soft = d.kind === 'soft' ? (1 - value) * SOFT_MAX : 0;
        const lowest = d.index === Main.layoutManager.primaryIndex ? LOWEST_PRIMARY : 1;
        const extra = d.minimum ? lowest : layerValues(d.phase, d.cfg, new Date()).extra;
        let alpha = 1 - (1 - soft) * (1 - extra * EXTRA_MAX);
        // dark: the backlight is at 0 (see _move); the layer only adds black on top
        if (d.off && view === 'dark')
            alpha = d.kind === 'soft' ? Math.max(alpha, this.offDarkOf(d)) : this.offDarkOf(d);
        return alpha;
    }

    _wait(ms) {
        return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        }));
    }

    // a fade of the black layer that can be waited for
    _fade(d, alpha, ms) {
        if (!ms) {
            this._overlays.set(d.index, alpha);
            return Promise.resolve();
        }
        this._overlays.set(d.index, alpha, {animate: true, duration: ms});
        return this._wait(ms + 40);     // + the last frame of the fade
    }

    /*
     * From one state of a turned off screen to another, smoothly. A DDC
     * write makes the monitor change in one go, never in steps (steps
     * look like "tick tick tick"). The black layer never gets darker than
     * "Dark while off" says (0 % = never any black):
     *   darker:   the layer fades to its final value, then the backlight
     *             goes down under it;
     *   brighter: the backlight goes up under the layer as it is, then the
     *             layer fades away.
     * A newer change cancels an older one at its next step.
     */
    async _move(d, view, {fast = false} = {}) {
        const finalAlpha = this._overlayAlpha(d, d.off ? view : null);
        if (d.kind === 'soft') {
            this._overlays.set(d.index, finalAlpha, {animate: true, fast, slow: view === 'dark'});
            return;
        }
        const token = d._moveToken = (d._moveToken ?? 0) + 1;
        const alive = () => d._moveToken === token && !this._destroyed;
        const target = d.off ? this._offBacklight() : d.minimum ? 0 : d.value;
        const from = d._backlight ?? d.value;
        d._moving = true;
        try {
            if (target < from - 0.005) {
                await this._fade(d, finalAlpha, 700);
                if (!alive())
                    return;
                await this._backlightTo(d, target);
            } else {
                if (target > from + 0.005)
                    await this._backlightTo(d, target);
                if (!alive())
                    return;
                await this._fade(d, finalAlpha, fast ? 250 : 400);
            }
        } finally {
            if (alive())
                d._moving = false;
        }
    }

    // the backlight to v, resolved once the monitor has it
    _backlightTo(d, v) {
        this._writeHardware(d, v, false);
        if (d.kind !== 'ddc')
            return Promise.resolve(true);
        return this._ddc.setBrightnessAndWait(d.bus, Math.round(v * d.max));
    }

    // overlay + colour layers
    _applyLayers(d, animate = false) {
        this.gamma.setMonitor(d.index, d.cfg.nightLight, d.cfg.redLight);
        this._applyOverlay(d, animate);
    }

    userSet(d, v, write = true) {
        if (d.off)
            this.wake(d.index);
        if (d.minimum) {
            d.minimum = false;
            this.emit('off-changed');
        }
        if (d.cfg.schedule) {
            const phase = phaseAt(new Date(), d.cfg, this.globals);
            if (phase.phase === 'day') {
                d.cfg.day = v;
            } else {
                // evening or night: the user's value until the morning, then the curve again
                const until = phase.phase === 'evening'
                    ? phaseAt(new Date(phase.next + 1000), d.cfg, this.globals).next : phase.next;
                d.override = {value: v, until};
            }
        } else {
            d.cfg.day = v;
        }
        this._save();
        if (write) {
            this._write(d, v);
        } else {
            d.value = v;
            this._applyOverlay(d);
            d.emit('changed');
        }
    }

    configChanged(d, key) {
        this._save();
        if (key === 'offDark' || key === 'offDarkAuto' || key === 'keepLit') {
            this._applyOverlay(d);
            d.emit('changed');
            return;
        }
        if (key === 'extra' || key === 'nightLight' || key === 'redLight') {
            this._applyLayers(d);
            d.emit('changed');
            return;
        }
        d.phase = d.cfg.schedule ? phaseAt(new Date(), d.cfg, this.globals) : null;
        if (key === 'schedule' && !d.cfg.schedule) {
            // switched off: back to the day brightness
            d.override = null;
            if (d.cfg.day !== null)
                this._write(d, d.cfg.day);
        }
        this._applyLayers(d, key === 'schedule');
        d.emit('changed');
        this.tick();
    }

    // ------------------------------------------------------------ lowest light
    /** Brightness 0 and full extra dimming; again = back. */
    setMinimum(d, on) {
        if (d.minimum === on)
            return;
        if (d.off)
            this.wake(d.index);
        d.minimum = on;          // not kept over a restart
        this._save();
        this._restoreHardware(d);
        this._applyOverlay(d, true);
        d.emit('changed');
        this.emit('off-changed');
    }

    // ------------------------------------------------------------ screen off
    /** "Dark while off" of d right now: turned off by hand, or by the evening's buttons. */
    offDarkKey(d) {
        return d.cfg.offAuto ? 'offDarkAuto' : 'offDark';
    }

    offDarkOf(d) {
        return d.cfg[this.offDarkKey(d)];
    }

    /*
     * auto: turned off by the evening's buttons (its own "Dark while off",
     * 25 % at first). remember: turned off by hand with its own button, so
     * it is still off after a restart.
     */
    turnOff(d, animate = true, auto = false, remember = false) {
        if (d.off)
            return;
        d.cfg.offAuto = auto;
        d.cfg.offAt = Date.now();
        if (d.minimum) {
            // turned off ends "lowest light": the two never at once
            d.minimum = false;
            d.cfg.minimum = false;
        }
        d.off = true;
        d.cfg.off = remember;
        this._save();
        this._clearView(d);
        d.view = 'dark';
        // turned off under the mouse: it has to really move (or leave) first
        const [x, y] = global.get_pointer();
        d._mustMove = this._pointerOn(d) ? {x, y, after: GLib.get_monotonic_time() + 800000} : null;
        this._dots.sync(d);
        if (animate) {
            this._move(d, 'dark');
        } else {
            // at once (startup, restoring): no fades
            this._writeHardware(d, 0);
            this._overlays.set(d.index, this._overlayAlpha(d));
        }
        this._startWatch();
        d.emit('changed');
        this.emit('off-changed');
    }

    turnOffOthers(d, auto = false) {
        for (const other of this.displays) {
            if (other !== d)
                this.turnOff(other, true, auto);
        }
    }

    othersOff(d) {
        return this.displays.some(x => x !== d && x.off);
    }

    /** "Turn off others" again turns them back on. */
    toggleOthers(d) {
        if (this.othersOff(d)) {
            for (const other of this.displays) {
                if (other !== d)
                    this.wake(other.index);
            }
        } else {
            this.turnOffOthers(d);
        }
    }

    wake(index) {
        const d = this.displays.find(x => x.index === index);
        if (!d?.off)
            return;
        d.off = false;
        d.cfg.off = false;
        this._save();
        this._clearView(d);
        d.view = null;
        this._dots.sync(d);
        this._move(d, null);
        d.emit('changed');
        this.emit('off-changed');
    }

    // ------------------------------------------------------------ a turned off screen
    _clearView(d) {
        if (d._viewTimer)
            GLib.source_remove(d._viewTimer);
        d._viewTimer = 0;
        if (d._previewTimer)
            GLib.source_remove(d._previewTimer);
        d._previewTimer = 0;
        d._preview = null;
    }

    _setView(d, view, {fast = false} = {}) {
        if (!d.off)
            return;
        this._clearView(d);
        d.view = view;
        // the backlight stays at 0; lit = no black layer, dark = "Dark while off". See _move.
        this._dots.sync(d);
        this._move(d, view, {fast});
        d.emit('changed');
    }

    // A turned off screen keeps its backlight at the lowest, lit or not:
    // the mouse coming and going only fades the black layer (no DDC writes,
    // so nothing jumps). Only "turn back on" writes the brightness again.
    _offBacklight() {
        return 0;
    }

    // the mouse left a lit turned off screen: dark at once, or lit a while longer first
    _left(d) {
        if (d.cfg.keepLit)
            this.keepLit(d, this._settings.get_int('keep-lit-seconds'));
        else
            this._setView(d, 'dark');
    }

    // the mouse on d's monitor (inset: and at least that far inside its edges)
    _pointerOn(d, inset = 0) {
        const [x, y] = global.get_pointer();
        const m = Main.layoutManager.monitors[d.index];
        return !!m && x >= m.x + inset && y >= m.y + inset && x < m.x + m.width - inset && y < m.y + m.height - inset;
    }

    /** The mouse came onto a turned off screen: light it until it leaves. */
    peek(index) {
        const d = this.displays.find(x => x.index === index);
        if (!d?.off || d.view === 'peek' || d.view === 'kept')
            return;
        // the picture comes at once, the backlight follows (DDC is slower)
        this._setView(d, 'peek', {fast: true});
    }

    _startWatch() {
        if (!this._watchTimer)
            this._watchTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WATCH_MS, () => this._watch());
    }

    // Only runs while a screen is turned off, and stops by itself: the
    // mouse onto it lights it, the mouse leaving dims and darkens it.
    _watch() {
        const off = this.displays.filter(d => d.off);
        if (!off.length) {
            this._watchTimer = 0;
            return GLib.SOURCE_REMOVE;
        }
        const [x, y] = global.get_pointer();
        const hover = this._settings.get_boolean('wake-on-hover');
        for (const d of off) {
            const inside = this._pointerOn(d);
            if (d._mustMove) {
                const m = d._mustMove;
                if (inside && (GLib.get_monotonic_time() < m.after || Math.hypot(x - m.x, y - m.y) < MOVE_TO_LIGHT))
                    continue;
                d._mustMove = null;
            }
            if (inside && hover && !this._lit(d)) {
                // really on it, not just passing by the edge
                const now = GLib.get_monotonic_time();
                if (!this._pointerOn(d, PEEK_INSET)) {
                    d._enterAt = 0;
                } else if (!d._enterAt) {
                    d._enterAt = now;
                } else if (now - d._enterAt >= PEEK_DWELL_MS * 1000) {
                    d._enterAt = 0;
                    this.peek(d.index);
                }
            } else {
                d._enterAt = 0;
                if (!inside && d.view === 'peek')
                    this._left(d);
            }
        }
        return GLib.SOURCE_CONTINUE;
    }

    /**
     * Lit for `seconds` (Infinity = until darkened), even with the mouse
     * elsewhere; afterwards dark (or lit while the mouse is on it).
     */
    keepLit(d, seconds) {
        if (!d.off)
            return;
        if (d.view === 'kept' || d.view === 'peek') {
            // already lit: no change to the picture, only the timer
            this._clearView(d);
            d.view = 'kept';
            this._dots.sync(d);
            d.emit('changed');
        } else {
            this._setView(d, 'kept', {fast: true});
        }
        if (Number.isFinite(seconds)) {
            d._viewTimer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, seconds, () => {
                d._viewTimer = 0;
                if (this._pointerOn(d)) {
                    d.view = 'peek';      // the mouse is on it: stays lit, dark when it leaves
                    this._dots.sync(d);
                    d.emit('changed');
                } else {
                    this._setView(d, 'dark');
                }
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    /**
     * The "Dark while off" slider moved: a dark screen shows it at once; a
     * lit one (not the screen with the open menu) shows it for a moment.
     */
    previewOff(d) {
        if (!d.off)
            return;
        if (!this._lit(d)) {
            if (!d._moving)
                this._overlays.set(d.index, this._overlayAlpha(d));
            return;
        }
        const qs = Main.panel.statusArea.quickSettings;
        if (Main.layoutManager.findMonitorForActor(qs.menu.actor)?.index === d.index)
            return;
        if (d._previewTimer)
            GLib.source_remove(d._previewTimer);
        d._preview = 'dark';
        this._applyOverlay(d);
        d._previewTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PREVIEW_MS, () => {
            d._previewTimer = 0;
            d._preview = null;
            this._applyOverlay(d, true);
            return GLib.SOURCE_REMOVE;
        });
    }

    /** "Keep lit" switched off: back to what the mouse says. */
    endKeepLit(d) {
        if (d.view !== 'kept')
            return;
        this._setView(d, this._pointerOn(d) ? 'peek' : 'dark');
    }

    darkNow(d) {
        this._setView(d, 'dark');
    }

    /** The small menu of the screen under the mouse (corner dot, shortcut). */
    openMenu(d, x, y) {
        this._offMenu.open(d, x, y);
    }

    displayAt(x, y) {
        return this.displays.find(d => {
            const m = Main.layoutManager.monitors[d.index];
            return m && x >= m.x && y >= m.y && x < m.x + m.width && y < m.y + m.height;
        }) ?? null;
    }

    wakeAll() {
        for (const d of this.displays)
            this.wake(d.index);
    }

    // ------------------------------------------------------------ schedule
    phaseOf(d) {
        return phaseAt(new Date(), d.cfg, this.globals);
    }

    tick() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = 0;
        }
        if (this._destroyed)
            return;
        const now = new Date();
        let sleep = MAX_SLEEP_S;
        for (const d of this.displays) {
            if (!d.cfg.schedule || !d.ready || d.cfg.day === null)
                continue;
            const phase = phaseAt(now, d.cfg, this.globals);
            d.phase = phase;
            this._applyLayers(d);
            if (d.override && now.getTime() >= d.override.until)
                d.override = null;
            if (!d.override) {
                const target = scheduledValue(phase, d.cfg, now);
                // write only when the visible percentage changes
                if (Math.round(target * 100) !== Math.round(d.value * 100))
                    this._write(d, target);
            }
            sleep = Math.min(sleep, this._runActions(d, now, phase));
            sleep = Math.min(sleep, Math.max(1, (phase.next - now.getTime()) / 1000));
            if (curveMoving(now, phase))
                sleep = Math.min(sleep, CURVE_STEP_S);
        }
        if (!this.displays.some(d => d.cfg.schedule))
            return;
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, Math.ceil(sleep), () => {
            this._timer = 0;
            this.tick();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Automatic buttons: run each one once a night at its time; in the
     * morning undo them (and the ones pressed by hand) if wanted.
     * @returns {number} seconds until the next one
     */
    _runActions(d, now, phase) {
        const night = phase.phase === 'evening' || phase.phase === 'night';
        if (!night) {
            if (d._wasNight && d.cfg.morningReset)
                this._morningReset(d);
            d._wasNight = false;
            d._fired.clear();
            return MAX_SLEEP_S;
        }
        d._wasNight = true;
        let next = MAX_SLEEP_S;
        const since = (now.getTime() - phase.start) / 60000;
        for (const action of ACTIONS) {
            const at = d.cfg.events[action];
            if (at === null)
                continue;
            const key = `${phase.start}:${action}`;
            if (since >= at) {
                if (!d._fired.has(key)) {
                    d._fired.add(key);
                    this.log(`automatic ${action} on ${d.name}`);
                    if (action === 'lowest')
                        this.setMinimum(d, true);
                    else if (action === 'off')
                        this.turnOff(d, true, true);
                    else
                        this.turnOffOthers(d, true);
                }
            } else {
                next = Math.min(next, (at - since) * 60 + 1);
            }
        }
        return next;
    }

    _morningReset(d) {
        this.log(`morning: buttons of ${d.name} back`);
        this.setMinimum(d, false);
        this.wake(d.index);
        if (d.cfg.events.others !== null || this.othersOff(d)) {
            for (const other of this.displays) {
                if (other !== d)
                    this.wake(other.index);
            }
        }
    }

    _afterResume() {
        for (const d of this.displays) {
            if (d.kind === 'ddc')
                this._ddc.forget(d.bus);
        }
        this._readGlobals();
        // give the monitors a moment to wake up before talking DDC
        GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 3, () => {
            if (this._destroyed)
                return GLib.SOURCE_REMOVE;
            for (const d of this.displays) {
                if (d.kind === 'ddc' && !d.off)
                    this._restoreHardware(d);
            }
            this.tick();
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        this._destroyed = true;
        if (this._timer)
            GLib.source_remove(this._timer);
        if (this._watchTimer)
            GLib.source_remove(this._watchTimer);
        if (this._rescanTimer)
            GLib.source_remove(this._rescanTimer);
        if (this._saveTimer)
            GLib.source_remove(this._saveTimer);
        Gio.DBus.system.signal_unsubscribe(this._sleepId);
        Main.layoutManager.disconnect(this._monitorsId);
        this._settingsIds.forEach(id => this._settings.disconnect(id));
        this._unwatchLocation();
        this._backlightHandles.splice(0).forEach(h => h());
        // give turned off / lowest light screens their light back
        for (const d of this.displays) {
            if (!d.off && !d.minimum)
                continue;
            if (d.kind === 'ddc')
                this._ddc.writeNow(d.bus, Math.round(d.value * d.max));
            else if (d.kind === 'backlight')
                this._writeHardware(d, d.value);
            if (d.kind !== 'soft')
                d.cfg.last = d.value;
        }
        this._flush();
        this._offMenu.destroy();
        this._dots.destroy();
        this.displays.forEach(d => this._clearView(d));
        this._overlays.destroy();
        this.gamma.destroy();
        this._ddc.destroy();
        this.displays = [];
    }
}
