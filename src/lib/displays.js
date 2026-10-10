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
import {getLocation, watchLocation} from './location.js';
import {phaseAt, scheduledValue} from './schedule.js';
import {fmt} from './sun.js';

const EXTRA_MAX = 0.9;        // extra dimming slider at 100% = 90% darker
const SOFT_MAX = 0.85;        // software-only monitor at 0% = 85% darker
const SAVE_DELAY_MS = 1500;
const RESCAN_DELAY_S = 4;
const MAX_SLEEP_S = 600;      // re-check at least every 10 min (suspend safe)

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
        this.override = null;
        this.phase = null;
        this.ready = this.kind === 'soft';
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
        this._overlays = new DimOverlays(index => this.wake(index));
        this._readGlobals();

        this._settingsIds = [
            'schedule-mode', 'transition-minutes', 'morning-offset', 'morning-time',
            'location-mode', 'latitude', 'longitude',
        ].map(k => settings.connect(`changed::${k}`, () => this._globalsChanged()));
        this._settingsIds.push(settings.connect('changed::rescan', () => this.rebuild(true)));
        this._settingsIds.push(settings.connect('changed::screen-off-mode', () => this._refreshOff()));
        this._settingsIds.push(settings.connect('changed::screen-off-level', () => this._refreshOff()));
        this._unwatchLocation = watchLocation(() => this._globalsChanged());

        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => {
            this._overlays.rebuild();
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
            console.log(`[Brightness+] ${msg}`);
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

    _cfgFor(id) {
        const s = this._settings;
        const c = this._config[id] ?? {};
        const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
        const cfg = {
            day: num(c.day, null),
            schedule: c.schedule === true,
            offset: num(c.offset, s.get_int('default-offset')),
            start: num(c.start, s.get_int('default-start')),
            night: num(c.night, s.get_double('default-night')),
            extra: num(c.extra, 0),
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
        const indexOf = c => (c ? mm.get_monitor_for_connector(c) : -1);
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

        // tear down the old list
        this._backlightHandles.splice(0).forEach(h => h());
        for (const d of this.displays)
            this._overlays.set(d.index, 0);

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
            props.cfg = this._cfgFor(props.id);
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

        for (const d of displays)
            this._initValue(d);
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
            let info = null;
            try {
                info = await this._ddc.getBrightness(d.bus);
            } catch (e) {
                this.log(`getvcp ${d.bus}: ${e.message}`);
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

    // first value read from the monitor
    _hardwareValue(d, v) {
        d.value = v;
        d.ready = true;
        const phase = d.cfg.schedule ? phaseAt(new Date(), d.cfg, this.globals) : null;
        // the monitor's own buttons may have changed it: trust it in daytime
        if (d.cfg.day === null || !phase || phase.phase === 'day')
            d.cfg.day = v;
        this._applyOverlay(d);
        d.emit('changed');
        this.tick();
    }

    // ------------------------------------------------------------ output
    _write(d, v) {
        v = Math.min(1, Math.max(0, v));
        d.value = v;
        if (!d.off)
            this._writeHardware(d, v);
        this._applyOverlay(d);
        d.emit('changed');
    }

    _writeHardware(d, v) {
        if (d.kind === 'ddc') {
            this._ddc.setBrightness(d.bus, Math.round(v * d.max));
        } else if (d.kind === 'backlight') {
            d._writingBacklight = true;
            d.bl.set(v);
            d._writingBacklight = false;
        }
    }

    _applyOverlay(d, animate = false) {
        let alpha;
        if (d.off) {
            alpha = this._settings.get_string('screen-off-mode') === 'black'
                ? 1 : 1 - this._settings.get_int('screen-off-level') / 100;
        } else {
            const soft = d.kind === 'soft' ? (1 - d.value) * SOFT_MAX : 0;
            alpha = 1 - (1 - soft) * (1 - d.cfg.extra * EXTRA_MAX);
        }
        this._overlays.set(d.index, alpha, {
            wake: d.off && this._settings.get_boolean('wake-on-hover'),
            animate,
        });
    }

    userSet(d, v, write = true) {
        if (d.off)
            this.wake(d.index);
        if (d.cfg.schedule) {
            const phase = phaseAt(new Date(), d.cfg, this.globals);
            if (phase.phase === 'day') {
                d.cfg.day = v;
            } else if (phase.phase === 'night') {
                d.cfg.night = v;
            } else {
                // during a transition: keep the user's value until the next one
                const after = phaseAt(new Date(phase.next + 1000), d.cfg, this.globals);
                d.override = {value: v, until: after.next};
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
        if (key === 'extra') {
            this._applyOverlay(d);
            d.emit('changed');
            return;
        }
        if (key === 'schedule' && !d.cfg.schedule) {
            // switched off: back to the day brightness
            d.override = null;
            if (d.cfg.day !== null)
                this._write(d, d.cfg.day);
        }
        d.emit('changed');
        this.tick();
    }

    // ------------------------------------------------------------ screen off
    turnOff(d, animate = true) {
        if (d.off)
            return;
        d.off = true;
        if (d.kind !== 'soft')
            this._writeHardware(d, 0);
        this._applyOverlay(d, animate);
        d.emit('changed');
        this.emit('off-changed');
    }

    turnOffOthers(d) {
        for (const other of this.displays) {
            if (other !== d)
                this.turnOff(other);
        }
    }

    wake(index) {
        const d = this.displays.find(x => x.index === index);
        if (!d?.off)
            return;
        d.off = false;
        if (d.kind !== 'soft')
            this._writeHardware(d, d.value);
        this._applyOverlay(d, true);
        d.emit('changed');
        this.emit('off-changed');
    }

    wakeAll() {
        for (const d of this.displays)
            this.wake(d.index);
    }

    _refreshOff() {
        for (const d of this.displays) {
            if (d.off)
                this._applyOverlay(d);
        }
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
            if (d.override && now.getTime() >= d.override.until)
                d.override = null;
            if (!d.override) {
                const target = scheduledValue(phase, d.cfg);
                // write only when the visible percentage changes
                if (Math.round(target * 100) !== Math.round(d.value * 100))
                    this._write(d, target);
            }
            const untilNext = Math.max(1, (phase.next - now.getTime()) / 1000);
            if (phase.phase === 'evening' || phase.phase === 'morning') {
                // ~1 % per step, at least 10 s apart
                const span = Math.abs(d.cfg.day - Math.min(d.cfg.day, d.cfg.night)) * 100;
                const step = (this.globals.transition * 60) / Math.max(1, span);
                sleep = Math.min(sleep, Math.max(10, Math.min(120, step)), untilNext);
            } else {
                sleep = Math.min(sleep, untilNext);
            }
        }
        if (!this.displays.some(d => d.cfg.schedule))
            return;
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, Math.ceil(sleep), () => {
            this._timer = 0;
            this.tick();
            return GLib.SOURCE_REMOVE;
        });
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
                    this._writeHardware(d, d.value);
            }
            this.tick();
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        this._destroyed = true;
        if (this._timer)
            GLib.source_remove(this._timer);
        if (this._rescanTimer)
            GLib.source_remove(this._rescanTimer);
        if (this._saveTimer) {
            GLib.source_remove(this._saveTimer);
            this._flush();
        }
        Gio.DBus.system.signal_unsubscribe(this._sleepId);
        Main.layoutManager.disconnect(this._monitorsId);
        this._settingsIds.forEach(id => this._settings.disconnect(id));
        this._unwatchLocation();
        this._backlightHandles.splice(0).forEach(h => h());
        // give turned off screens their light back
        for (const d of this.displays) {
            if (!d.off)
                continue;
            if (d.kind === 'ddc')
                this._ddc.writeNow(d.bus, Math.round(d.value * d.max));
            else if (d.kind === 'backlight')
                this._writeHardware(d, d.value);
        }
        this._overlays.destroy();
        this._ddc.destroy();
        this.displays = [];
    }
}
