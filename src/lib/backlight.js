// Built-in (laptop) screens: GNOME's own backlight control.
//  GNOME 49+: Main.brightnessManager (one scale per backlit monitor)
//  GNOME 46-48: org.gnome.SettingsDaemon.Power.Screen over D-Bus

import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const BUS_NAME = 'org.gnome.SettingsDaemon.Power';
const OBJECT_PATH = '/org/gnome/SettingsDaemon/Power';
const SCREEN_XML = `<node>
  <interface name="org.gnome.SettingsDaemon.Power.Screen">
    <property name="Brightness" type="i" access="readwrite"/>
  </interface>
</node>`;
const ScreenProxy = Gio.DBusProxy.makeProxyWrapper(SCREEN_XML);

const BUILTIN_CONNECTORS = ['eDP-1', 'eDP-2', 'LVDS-1', 'DSI-1', 'eDP', 'LVDS'];

/**
 * One controllable backlight.
 * {connector, name, get(): 0..1, set(v), connectChanged(cb) -> disconnect fn}
 */
export function findBacklights() {
    const manager = Main.brightnessManager;
    if (manager?.scales) {
        return manager.scales.map(scale => {
            const monitor = scale.monitor?.get_monitors?.()[0];
            return {
                connector: monitor?.get_connector?.() ?? '',
                name: scale.name,
                get: () => scale.value,
                set: v => {
                    scale.value = v;
                },
                connectChanged: cb => {
                    const id = scale.connect('notify::value', cb);
                    return () => scale.disconnect(id);
                },
            };
        });
    }
    return null; // use the D-Bus fallback (async)
}

export function legacyBacklight() {
    return new Promise(resolve => {
        new ScreenProxy(Gio.DBus.session, BUS_NAME, OBJECT_PATH, (p, error) => {
            if (error || !Number.isInteger(p.Brightness) || p.Brightness < 0) {
                resolve(null);
                return;
            }
            const mm = global.backend.get_monitor_manager();
            const connector = BUILTIN_CONNECTORS.find(c => mm.get_monitor_for_connector(c) >= 0) ?? '';
            resolve({
                connector,
                name: null,
                get: () => Math.max(0, p.Brightness) / 100,
                set: v => {
                    p.Brightness = Math.round(v * 100);
                },
                connectChanged: cb => {
                    const id = p.connect('g-properties-changed', cb);
                    return () => p.disconnect(id);
                },
            });
        });
    });
}
