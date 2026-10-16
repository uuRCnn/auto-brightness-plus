// Night Light and red screen per monitor, through the monitors' own colour
// tables (gamma), the same way GNOME's Night Light works. Nothing is drawn
// by GNOME Shell, so menus, blur and transparency stay untouched and it
// costs no GPU time.
//
// GNOME's Night Light picks one temperature for all monitors. A monitor
// whose multiplier is not ×1, or the red screen, gets its own table on top:
//   temperature = 6500 K − (6500 K − Night Light temperature) × multiplier
//   red screen  = green and blue go down by strength × multiplier
// Monitors left at ×1 without red screen are not touched at all.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const NEUTRAL = 6500;
const MIN_KELVIN = 1000;
const FADE_MS = 700;
const FADE_STEP_MS = 35;

const DC_BUS = 'org.gnome.Mutter.DisplayConfig';
const DC_PATH = '/org/gnome/Mutter/DisplayConfig';
const COLOR_BUS = 'org.gnome.SettingsDaemon.Color';
const COLOR_PATH = '/org/gnome/SettingsDaemon/Color';

// Red/green/blue gain of a black body at `kelvin`, relative to 6500 K.
export function kelvinGain(kelvin) {
    const t = kelvin / 100;
    const c = v => Math.min(255, Math.max(0, v)) / 255;
    const r = t <= 66 ? 1 : c(329.698727446 * Math.pow(t - 60, -0.1332047592));
    const g = c(t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492));
    const b = t >= 66 ? 1 : t <= 19 ? 0 : c(138.5177312231 * Math.log(t - 10) - 305.0447927307);
    const ref = [1, 0.9965, 0.9800];        // 6500 K by the same formula
    return [r / ref[0], g / ref[1], b / ref[2]].map(v => Math.min(1, v));
}

function ramp(size, gain) {
    const out = new Array(size);
    for (let i = 0; i < size; i++)
        out[i] = Math.round(i / (size - 1) * 65535 * gain);
    return out;
}

function call(method, params, type) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call(DC_BUS, DC_PATH, DC_BUS, method, params,
            type ? new GLib.VariantType(type) : null, Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                try {
                    resolve(conn.call_finish(res).deepUnpack());
                } catch (e) {
                    reject(e);
                }
            });
    });
}

export class GammaController {
    constructor(log = () => {}) {
        this._log = log;
        this._mons = [];            // by monitor index: {night, red} multipliers
        this._red = 0;              // red screen strength shown right now
        this._redTarget = 0;
        this._temp = NEUTRAL;       // Night Light temperature right now
        this._map = null;           // monitor index -> [{crtc, size}]
        this._serial = 0;
        this._touched = new Set();  // crtcs that carry our table
        this._applyId = 0;
        this._fadeId = 0;
        this._busy = false;
        this._again = false;
        this._destroyed = false;

        this._colorProxy = null;
        Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null,
            COLOR_BUS, COLOR_PATH, COLOR_BUS, null, (o, res) => {
                try {
                    this._colorProxy = Gio.DBusProxy.new_for_bus_finish(res);
                } catch (e) {
                    this._log(`no Night Light service: ${e.message}`);
                    return;
                }
                if (this._destroyed)
                    return;
                this._colorProxy.connect('g-properties-changed', () => this._readTemp());
                this._readTemp();
            });
        this._changedId = Gio.DBus.session.signal_subscribe(DC_BUS, DC_BUS, 'MonitorsChanged', DC_PATH,
            null, Gio.DBusSignalFlags.NONE, () => this.relayout());
        // mutter rewrites the tables when screens wake up
        this._powerId = global.backend.get_monitor_manager().connect('power-save-mode-changed', () => this.reapply());
    }

    _readTemp() {
        const v = this._colorProxy?.get_cached_property('Temperature')?.unpack();
        if (typeof v !== 'number' || v < MIN_KELVIN)
            return;
        if (v !== this._temp) {
            this._temp = v;
            // mutter writes its own table for the new temperature: ours goes on top right after
            this.reapply();
        }
    }

    /**
     * When GNOME's Night Light really starts and ends on automatic: its own
     * sunset and sunrise (hours), or null when it has none (then it uses the
     * fixed times of its schedule).
     */
    nightLightTimes() {
        const get = name => this._colorProxy?.get_cached_property(name)?.unpack();
        const sunset = get('Sunset'), sunrise = get('Sunrise');
        if (typeof sunset !== 'number' || typeof sunrise !== 'number' || sunset < 0 || sunrise < 0)
            return null;
        return {sunset, sunrise};
    }

    /** Multipliers of one monitor (1 = like GNOME, 0 = none, 2 = twice as strong). */
    setMonitor(index, night, red) {
        const old = this._mons[index];
        if (old && old.night === night && old.red === red)
            return;
        this._mons[index] = {night, red};
        this._queue();
    }

    /** Red screen strength (0 = off) on every monitor. */
    setRed(strength, animate = true) {
        if (strength === this._redTarget)
            return;
        this._redTarget = strength;
        if (this._fadeId)
            GLib.source_remove(this._fadeId);
        this._fadeId = 0;
        if (!animate) {
            this._red = strength;
            this._queue();
            return;
        }
        const from = this._red;
        const t0 = GLib.get_monotonic_time();
        this._fadeId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FADE_STEP_MS, () => {
            const p = Math.min(1, (GLib.get_monotonic_time() - t0) / 1000 / FADE_MS);
            const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
            this._red = from + (strength - from) * e;
            this._queue();
            if (p < 1)
                return GLib.SOURCE_CONTINUE;
            this._fadeId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Monitors changed: find the crtcs again. */
    relayout() {
        this._map = null;
        this._touched.clear();
        this._queue();
    }

    /** Something reset the tables: write ours again. */
    reapply() {
        this._touched.clear();
        this._queue();
    }

    _queue() {
        if (this._applyId || this._destroyed)
            return;
        this._applyId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._applyId = 0;
            this._apply().catch(e => this._log(`gamma: ${e.message}`));
            return GLib.SOURCE_REMOVE;
        });
    }

    _wanted(index) {
        const m = this._mons[index] ?? {night: 1, red: 1};
        const temp = Math.max(MIN_KELVIN, NEUTRAL - (NEUTRAL - this._temp) * m.night);
        const red = Math.min(1, Math.max(0, this._red * m.red));
        const own = Math.abs(temp - this._temp) >= 1 || red > 0.001;
        return {temp, red, own};
    }

    async _apply() {
        if (this._busy) {
            this._again = true;
            return;
        }
        this._busy = true;
        try {
            const anything = Main.layoutManager.monitors.some((m, i) => this._wanted(i).own);
            if (!anything && !this._touched.size)
                return;
            if (!this._map)
                await this._loadMap();
            if (this._destroyed || !this._map)
                return;
            for (const [index, crtcs] of this._map) {
                const w = this._wanted(index);
                for (const {crtc, size} of crtcs) {
                    if (!w.own && !this._touched.has(crtc))
                        continue;
                    // back to plain Night Light when we are not needed any more
                    const temp = w.own ? w.temp : this._temp;
                    const red = w.own ? w.red : 0;
                    const [gr, gg, gb] = kelvinGain(temp);
                    this._log(`gamma crtc${crtc}: ${Math.round(temp)} K red ${red.toFixed(2)}`);
                    await call('SetCrtcGamma', new GLib.Variant('(uuaqaqaq)', [this._serial, crtc,
                        ramp(size, gr), ramp(size, gg * (1 - red)), ramp(size, gb * (1 - red))]), null);
                    if (w.own)
                        this._touched.add(crtc);
                    else
                        this._touched.delete(crtc);
                }
            }
        } finally {
            this._busy = false;
            if (this._again) {
                this._again = false;
                this._queue();
            }
        }
    }

    // monitor index (as in Main.layoutManager.monitors) -> crtcs with their table sizes
    async _loadMap() {
        const [serial, , outputs] = await call('GetResources', null, null);
        const [, , logical] = await call('GetCurrentState', null, null);
        const crtcOf = new Map(outputs.filter(o => o[2] >= 0).map(o => [o[4], o[2]]));
        const map = new Map();
        for (const [x, y, , , , connectors] of logical) {
            const index = Main.layoutManager.monitors.findIndex(m => m.x === x && m.y === y);
            if (index < 0)
                continue;
            const crtcs = [];
            for (const [connector] of connectors) {
                const crtc = crtcOf.get(connector);
                if (crtc === undefined)
                    continue;
                const [r] = await call('GetCrtcGamma', new GLib.Variant('(uu)', [serial, crtc]), '(aqaqaq)');
                if (r.length > 1)
                    crtcs.push({crtc, size: r.length});
            }
            if (crtcs.length)
                map.set(index, crtcs);
        }
        this._serial = serial;
        this._map = map;
        this._log(`gamma: ${[...map].map(([i, c]) => `${i}:${c.map(x => `crtc${x.crtc}/${x.size}`).join('+')}`).join(' ')}`);
    }

    /** Give every monitor back to Night Light. */
    destroy() {
        this._destroyed = true;
        if (this._applyId)
            GLib.source_remove(this._applyId);
        if (this._fadeId)
            GLib.source_remove(this._fadeId);
        Gio.DBus.session.signal_unsubscribe(this._changedId);
        global.backend.get_monitor_manager().disconnect(this._powerId);
        if (this._map && this._touched.size) {
            const [gr, gg, gb] = kelvinGain(this._temp);
            for (const crtcs of this._map.values()) {
                for (const {crtc, size} of crtcs) {
                    if (this._touched.has(crtc)) {
                        call('SetCrtcGamma', new GLib.Variant('(uuaqaqaq)', [this._serial, crtc,
                            ramp(size, gr), ramp(size, gg), ramp(size, gb)]), null).catch(() => {});
                    }
                }
            }
        }
        this._colorProxy = null;
    }
}
