// External monitors over DDC/CI, through the ddcutil command line tool.
//
// Why the desktop never stutters:
//  * every ddcutil call is an async subprocess, nothing blocks the shell
//  * one write at a time per monitor; while a write runs, newer values
//    replace the waiting one (dragging a slider = a handful of writes,
//    not hundreds)
//  * writes to the same monitor are spaced by a small interval and a value
//    that is already set is never written again
//  * the detected monitor list is cached on disk, so login does not wait
//    for the slow i2c scan; a fresh scan runs later in the background

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'brightness-plus']);
const CACHE_FILE = GLib.build_filenamev([CACHE_DIR, 'ddcutil-detect.txt']);

export function parseDetect(text) {
    const displays = [];
    for (const block of text.split(/\n(?=\S)/)) {
        if (!/^Display \d+/.test(block))
            continue; // "Invalid display", "Phantom display", ...
        const bus = /I2C bus:\s*\/dev\/i2c-(\d+)/.exec(block)?.[1];
        if (!bus)
            continue;
        const drm = /DRM[ _]connector:\s*(\S+)/.exec(block)?.[1] ?? '';
        const connector = drm.replace(/^card\d+-/, '');
        const monitor = /Monitor:\s*(.*)/.exec(block)?.[1]?.trim() ?? '';
        const [mfg = '', model = '', serial = ''] = monitor.split(':');
        displays.push({
            bus,
            connector,
            mfg,
            model: model.trim(),
            serial: serial.trim(),
            id: monitor || `bus-${bus}`,
        });
    }
    return displays;
}

export class DdcBackend {
    constructor(settings, log) {
        this._settings = settings;
        this._log = log;
        this._cancellable = new Gio.Cancellable();
        this._queues = new Map();
        this._destroyed = false;
    }

    async _run(args) {
        const path = this._settings.get_string('ddcutil-path') || 'ddcutil';
        const extra = this._settings.get_string('ddcutil-extra-args').split(/\s+/).filter(Boolean);
        const argv = [path, ...args, ...extra];
        this._log(`run ${argv.join(' ')}`);
        const proc = Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
        const [stdout] = await proc.communicate_utf8_async(null, this._cancellable);
        return {ok: proc.get_successful(), out: stdout ?? ''};
    }

    available() {
        const path = this._settings.get_string('ddcutil-path') || 'ddcutil';
        return GLib.path_is_absolute(path)
            ? GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE)
            : GLib.find_program_in_path(path) !== null;
    }

    cachedDisplays() {
        try {
            const [ok, bytes] = GLib.file_get_contents(CACHE_FILE);
            if (ok)
                return parseDetect(new TextDecoder().decode(bytes));
        } catch {}
        return null;
    }

    async detect() {
        if (!this.available())
            return [];
        const {out} = await this._run(['detect', '--brief']);
        const displays = parseDetect(out);
        try {
            GLib.mkdir_with_parents(CACHE_DIR, 0o700);
            GLib.file_set_contents(CACHE_FILE, out);
        } catch {}
        return displays;
    }

    /** @returns {Promise<{current: number, max: number}|null>} */
    async getBrightness(bus) {
        const {out} = await this._run(['getvcp', '10', '--brief', '--bus', bus]);
        // "VCP 10 C 52 100"
        const m = /VCP\s+10\s+C\s+(\d+)\s+(\d+)/.exec(out);
        if (!m || +m[2] <= 0)
            return null;
        return {current: +m[1], max: +m[2]};
    }

    /** Queue a raw brightness write; newer calls replace waiting ones. */
    setBrightness(bus, raw) {
        let q = this._queues.get(bus);
        if (!q) {
            q = {pending: null, busy: false, last: null, lastTime: 0, timer: 0};
            this._queues.set(bus, q);
        }
        q.pending = raw;
        if (!q.busy)
            this._pump(bus, q);
    }

    _pump(bus, q) {
        if (this._destroyed)
            return;
        if (q.pending === null || q.pending === q.last) {
            q.pending = null;
            q.busy = false;
            return;
        }
        q.busy = true;
        const wait = q.lastTime + this._settings.get_int('ddc-write-interval') - GLib.get_monotonic_time() / 1000;
        if (wait > 0) {
            q.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.ceil(wait), () => {
                q.timer = 0;
                this._write(bus, q);
                return GLib.SOURCE_REMOVE;
            });
        } else {
            this._write(bus, q);
        }
    }

    async _write(bus, q) {
        const value = q.pending;
        q.pending = null;
        if (value === null || value === q.last) {
            this._pump(bus, q);
            return;
        }
        try {
            const {ok, out} = await this._run(['setvcp', '10', String(value), '--bus', bus, '--noverify']);
            if (ok)
                q.last = value;
            else
                this._log(`setvcp failed on bus ${bus}: ${out.trim()}`);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                this._log(`setvcp error on bus ${bus}: ${e.message}`);
        }
        q.lastTime = GLib.get_monotonic_time() / 1000;
        this._pump(bus, q);
    }

    /** Fire and forget, outside the queue (used while shutting down). */
    writeNow(bus, raw) {
        try {
            const path = this._settings.get_string('ddcutil-path') || 'ddcutil';
            Gio.Subprocess.new([path, 'setvcp', '10', String(raw), '--bus', bus, '--noverify'],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch {}
    }

    /** Forget what was written last (e.g. after the monitor was replugged). */
    forget(bus) {
        const q = this._queues.get(bus);
        if (q)
            q.last = null;
    }

    destroy() {
        this._destroyed = true;
        this._cancellable.cancel();
        for (const q of this._queues.values()) {
            if (q.timer)
                GLib.source_remove(q.timer);
        }
        this._queues.clear();
    }
}
