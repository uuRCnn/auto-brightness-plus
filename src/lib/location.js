// Where are we? Used only to calculate sunset and sunrise.
//
// No permissions are asked: like Night Light we use the coordinates GNOME
// already cached for Night Light (updated by GNOME itself while travelling,
// when location services are on). Otherwise the system time zone gives an
// approximate position (zone1970.tab), which follows the user as soon as
// the time zone changes. A manual location can be set in the preferences.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const COLOR_SCHEMA = 'org.gnome.settings-daemon.plugins.color';
const ZONE_TABLES = ['/usr/share/zoneinfo/zone1970.tab', '/usr/share/zoneinfo/zone.tab'];

let zoneCache = null;

// "+4101+02858" or "+404251-0740023" -> [lat, lon]
function parseIso6709(s) {
    const m = /^([+-])(\d{2})(\d{2})(\d{2})?([+-])(\d{3})(\d{2})(\d{2})?$/.exec(s);
    if (!m)
        return null;
    const lat = (+m[2] + +m[3] / 60 + (+m[4] || 0) / 3600) * (m[1] === '-' ? -1 : 1);
    const lon = (+m[6] + +m[7] / 60 + (+m[8] || 0) / 3600) * (m[5] === '-' ? -1 : 1);
    return [lat, lon];
}

function loadZones() {
    if (zoneCache)
        return zoneCache;
    zoneCache = new Map();
    for (const path of ZONE_TABLES) {
        try {
            const [ok, bytes] = GLib.file_get_contents(path);
            if (!ok)
                continue;
            for (const line of new TextDecoder().decode(bytes).split('\n')) {
                if (!line || line.startsWith('#'))
                    continue;
                const cols = line.split('\t');
                const pos = parseIso6709(cols[1] ?? '');
                if (pos && cols[2] && !zoneCache.has(cols[2]))
                    zoneCache.set(cols[2], pos);
            }
        } catch {}
        if (zoneCache.size)
            break;
    }
    return zoneCache;
}

export function timezoneId() {
    // /etc/localtime follows time zone changes at once (GLib caches its own)
    try {
        const target = GLib.file_read_link('/etc/localtime');
        const i = target.indexOf('zoneinfo/');
        if (i >= 0)
            return target.slice(i + 9);
    } catch {}
    return GLib.TimeZone.new_local().get_identifier();
}

function gnomeCoordinates() {
    try {
        const source = Gio.SettingsSchemaSource.get_default();
        if (!source.lookup(COLOR_SCHEMA, true))
            return null;
        const settings = new Gio.Settings({schema_id: COLOR_SCHEMA});
        const [lat, lon] = settings.get_value('night-light-last-coordinates').deepUnpack();
        if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180)
            return [lat, lon];
    } catch {}
    return null;
}

/**
 * @param {Gio.Settings} settings extension settings
 * @returns {{lat: number, lon: number, source: string, zone: string}}
 */
export function getLocation(settings) {
    const zone = timezoneId() ?? '';
    if (settings.get_string('location-mode') === 'manual') {
        return {lat: settings.get_double('latitude'), lon: settings.get_double('longitude'),
            source: 'manual', zone};
    }
    const gnome = gnomeCoordinates();
    if (gnome)
        return {lat: gnome[0], lon: gnome[1], source: 'gnome', zone};
    const pos = loadZones().get(zone);
    if (pos)
        return {lat: pos[0], lon: pos[1], source: 'timezone', zone};
    // unknown zone (e.g. "UTC"): use the UTC offset, mid latitude
    const offsetHours = new Date().getTimezoneOffset() / -60;
    return {lat: 45, lon: offsetHours * 15, source: 'offset', zone};
}

/** Calls `callback` when the automatic location may have changed. */
export function watchLocation(callback) {
    const handles = [];
    try {
        if (Gio.SettingsSchemaSource.get_default().lookup(COLOR_SCHEMA, true)) {
            const color = new Gio.Settings({schema_id: COLOR_SCHEMA});
            const id = color.connect('changed::night-light-last-coordinates', () => callback());
            handles.push(() => color.disconnect(id));
        }
    } catch {}
    try {
        const monitor = Gio.File.new_for_path('/etc/localtime').monitor_file(Gio.FileMonitorFlags.WATCH_MOVES, null);
        const id = monitor.connect('changed', () => callback());
        handles.push(() => {
            monitor.disconnect(id);
            monitor.cancel();
        });
    } catch {}
    return () => handles.splice(0).forEach(h => h());
}
