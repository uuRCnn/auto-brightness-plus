/* Brightness+ preferences
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {getLocation} from './lib/location.js';
import {fmt as format, formatMinutes, minutesOfDay, sunTimes} from './lib/sun.js';

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function comboRow(settings, key, title, choices, subtitle = '') {
    const model = new Gtk.StringList();
    choices.forEach(([, label]) => model.append(label));
    const row = new Adw.ComboRow({title, subtitle, model});
    const sync = () => {
        const i = choices.findIndex(([v]) => v === settings.get_string(key));
        row.selected = Math.max(0, i);
    };
    sync();
    settings.connect(`changed::${key}`, sync);
    row.connect('notify::selected', () => {
        const value = choices[row.selected]?.[0];
        if (value && value !== settings.get_string(key))
            settings.set_string(key, value);
    });
    return row;
}

function spinRow(settings, key, title, lower, upper, step, subtitle = '', digits = 0) {
    const row = new Adw.SpinRow({
        title, subtitle, digits,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 5}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

// minutes after midnight shown as HH:MM
function timeRow(settings, key, title, subtitle = '') {
    const row = spinRow(settings, key, title, 0, 1439, 15, subtitle);
    row.connect('output', () => {
        row.text = formatMinutes(row.value);
        return true;
    });
    row.connect('input', () => {
        const m = /^(\d{1,2})[:.](\d{2})$/.exec(row.text.trim());
        if (!m)
            return [false, 0];
        return [true, (+m[1] % 24) * 60 + Math.min(59, +m[2])];
    });
    return row;
}

export default class BrightnessPlusPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const s = this.getSettings();
        window.set_default_size(640, 720);
        window.add(this._generalPage(s));
        window.add(this._eveningPage(s));
        window.add(this._screenPage(s));
        window.add(this._advancedPage(s));
    }

    _generalPage(s) {
        const page = new Adw.PreferencesPage({title: _('General'), icon_name: 'display-brightness-symbolic'});

        const look = new Adw.PreferencesGroup({
            title: _('Sliders'),
            description: _('Every monitor gets its own slider in Quick Settings, next to the volume slider.'),
        });
        look.add(comboRow(s, 'slider-label', _('Left of the slider'), [
            ['icon', _('Brightness icon')],
            ['number', _('Monitor number (1, 2, 3…)')],
            ['short-name', _('Short name (LG, VS…)')],
        ]));
        look.add(switchRow(s, 'show-tooltip', _('Show the monitor name on hover')));
        look.add(switchRow(s, 'hide-builtin-slider', _('Replace GNOME’s own brightness slider'),
            _('The laptop screen then gets a row like the other monitors')));
        page.add(look);

        const night = new Adw.PreferencesGroup({title: _('Night Light')});
        night.add(switchRow(s, 'night-light-menu', _('Add a menu to the Night Light button'),
            _('Temperature, red screen and its strength')));
        page.add(night);
        return page;
    }

    _eveningPage(s) {
        const page = new Adw.PreferencesPage({title: _('Evening'), icon_name: 'weather-clear-night-symbolic'});

        const when = new Adw.PreferencesGroup({
            title: _('Evening dimming'),
            description: _('Turn it on per monitor with the moon button next to its slider. Brightness goes down slowly in the evening and comes back in the morning.'),
        });
        when.add(comboRow(s, 'schedule-mode', _('Start'), [
            ['sun', _('At sunset')],
            ['fixed', _('At a fixed time')],
        ]));
        when.add(spinRow(s, 'transition-minutes', _('Transition'), 1, 240, 5, _('Minutes, for both evening and morning')));
        const morningOffset = spinRow(s, 'morning-offset', _('Morning'), -240, 240, 5, _('Minutes after sunrise'));
        const morningTime = timeRow(s, 'morning-time', _('Morning'), _('Brightness comes back at'));
        when.add(morningOffset);
        when.add(morningTime);
        page.add(when);

        const defaults = new Adw.PreferencesGroup({
            title: _('For new monitors'),
            description: _('Each monitor can change these in its own menu.'),
        });
        const offset = spinRow(s, 'default-offset', _('Minutes after sunset'), -240, 240, 5);
        const start = timeRow(s, 'default-start', _('Start time'));
        defaults.add(offset);
        defaults.add(start);
        const nightRow = new Adw.SpinRow({
            title: _('Night brightness'), subtitle: _('Percent'),
            adjustment: new Gtk.Adjustment({lower: 0, upper: 100, step_increment: 5}),
            value: Math.round(s.get_double('default-night') * 100),
        });
        nightRow.connect('notify::value', () => s.set_double('default-night', nightRow.value / 100));
        defaults.add(nightRow);
        page.add(defaults);

        const where = new Adw.PreferencesGroup({
            title: _('Location'),
            description: _('Only used to calculate sunset and sunrise. Automatic uses the location GNOME keeps for Night Light, otherwise your time zone. Nothing is sent anywhere.'),
        });
        where.add(comboRow(s, 'location-mode', _('Location'), [
            ['auto', _('Automatic')],
            ['manual', _('Manual')],
        ]));
        const lat = spinRow(s, 'latitude', _('Latitude'), -90, 90, 0.5, '', 3);
        const lon = spinRow(s, 'longitude', _('Longitude'), -180, 180, 0.5, '', 3);
        where.add(lat);
        where.add(lon);
        const today = new Adw.ActionRow({title: _('Today'), subtitle: ''});
        where.add(today);
        page.add(where);

        const sync = () => {
            const sun = s.get_string('schedule-mode') === 'sun';
            morningOffset.visible = sun;
            morningTime.visible = !sun;
            offset.visible = sun;
            start.visible = !sun;
            const manual = s.get_string('location-mode') === 'manual';
            lat.visible = manual;
            lon.visible = manual;

            const loc = getLocation(s);
            const t = sunTimes(new Date(), loc.lat, loc.lon);
            const source = {
                manual: _('manual'),
                gnome: _('GNOME location'),
                timezone: format(_('time zone %s'), loc.zone),
                offset: _('UTC offset'),
            }[loc.source];
            const fmt = d => (d ? formatMinutes(minutesOfDay(d)) : '—');
            today.subtitle = format(_('Sunset %s · sunrise %s · from %s'), fmt(t.sunset), fmt(t.sunrise), source);
        };
        ['schedule-mode', 'location-mode', 'latitude', 'longitude'].forEach(k => s.connect(`changed::${k}`, sync));
        sync();
        return page;
    }

    _screenPage(s) {
        const page = new Adw.PreferencesPage({title: _('Screen off'), icon_name: 'system-shutdown-symbolic'});

        const off = new Adw.PreferencesGroup({
            title: _('Turn off screen'),
            description: _('“Turn off screen” and “Turn off others” in each monitor’s menu.'),
        });
        off.add(comboRow(s, 'screen-off-mode', _('Turned off screen'), [
            ['black', _('Fully black')],
            ['minimum', _('Lowest light')],
        ]));
        const level = spinRow(s, 'screen-off-level', _('Light left'), 1, 40, 1, _('Percent, for “Lowest light”'));
        off.add(level);
        off.add(switchRow(s, 'wake-on-hover', _('Turn back on when the mouse comes'),
            _('Moving the mouse onto a turned off screen brings its light back')));
        page.add(off);
        const sync = () => (level.visible = s.get_string('screen-off-mode') === 'minimum');
        s.connect('changed::screen-off-mode', sync);
        sync();

        const red = new Adw.PreferencesGroup({
            title: _('Red screen'),
            description: _('Switch it on in the Night Light menu. It removes all blue and green light, which helps you fall asleep.'),
        });
        red.add(switchRow(s, 'red-follows-night-light', _('Only while Night Light is active'),
            _('Starts and stops together with Night Light')));
        const strength = new Adw.ActionRow({title: _('Strength')});
        const scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 5, 100, 5);
        scale.set_hexpand(true);
        scale.set_draw_value(true);
        scale.set_format_value_func((sc, v) => new Intl.NumberFormat(undefined, {style: 'percent'}).format(Math.round(v) / 100));
        scale.set_value(s.get_double('red-strength') * 100);
        scale.connect('value-changed', () => s.set_double('red-strength', scale.get_value() / 100));
        strength.add_suffix(scale);
        red.add(strength);
        page.add(red);
        return page;
    }

    _advancedPage(s) {
        const page = new Adw.PreferencesPage({title: _('Advanced'), icon_name: 'preferences-other-symbolic'});

        const ddc = new Adw.PreferencesGroup({
            title: 'ddcutil',
            description: _('External monitors are controlled over DDC/CI. Your user needs access to /dev/i2c-* (usually the “i2c” group).'),
        });
        const found = GLib.find_program_in_path(s.get_string('ddcutil-path') || 'ddcutil');
        const status = new Adw.ActionRow({
            title: found ? _('ddcutil found') : _('ddcutil not found'),
            subtitle: found ?? _('Install ddcutil from your distribution, then press Scan again'),
        });
        const rescan = new Gtk.Button({label: _('Scan again'), valign: Gtk.Align.CENTER});
        rescan.connect('clicked', () => s.set_int('rescan', s.get_int('rescan') + 1));
        status.add_suffix(rescan);
        ddc.add(status);

        const path = new Adw.EntryRow({title: _('ddcutil program')});
        s.bind('ddcutil-path', path, 'text', Gio.SettingsBindFlags.DEFAULT);
        ddc.add(path);
        const args = new Adw.EntryRow({title: _('Extra arguments')});
        s.bind('ddcutil-extra-args', args, 'text', Gio.SettingsBindFlags.DEFAULT);
        ddc.add(args);
        ddc.add(spinRow(s, 'ddc-write-interval', _('Pause between writes'), 0, 2000, 20,
            _('Milliseconds. Raise it if a monitor misses changes')));
        page.add(ddc);

        const dbg = new Adw.PreferencesGroup();
        dbg.add(switchRow(s, 'debug', _('Debug messages'), _('Written to the system journal')));
        page.add(dbg);
        return page;
    }
}
