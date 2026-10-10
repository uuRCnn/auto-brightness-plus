// Quick Settings widgets: one brightness slider per monitor (with its moon
// menu) and the Night Light toggle with a menu.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickMenuToggle, QuickSlider} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {fmt, formatMinutes, minutesOfDay} from './sun.js';
import {dayTimes} from './schedule.js';

const MOON_ICON = 'weather-clear-night-symbolic';
const COLOR_SCHEMA = 'org.gnome.settings-daemon.plugins.color';
const TEMP_WARM = 1700;
const TEMP_COOL = 4700;

const PERCENT = new Intl.NumberFormat(undefined, {style: 'percent'});
const pct = v => PERCENT.format(Math.round(v * 100) / 100);

// ------------------------------------------------------------------ tooltip
export class Tooltip {
    constructor() {
        this.actor = new St.Label({style_class: 'bp-tooltip', visible: false, opacity: 0});
        Main.layoutManager.uiGroup.add_child(this.actor);
        this._owner = null;
    }

    show(owner, slider, text) {
        this._owner = owner;
        this.actor.text = text;
        Main.layoutManager.uiGroup.set_child_above_sibling(this.actor, null);
        const [sx, sy] = slider.get_transformed_position();
        const [w] = this.actor.get_preferred_width(-1);
        const [, h] = this.actor.get_preferred_height(-1);
        const handle = sx + slider.width * slider.value;
        const monitor = Main.layoutManager.findMonitorForActor(slider);
        let x = Math.round(handle - w / 2);
        if (monitor)
            x = Math.max(monitor.x + 4, Math.min(x, monitor.x + monitor.width - w - 4));
        this.actor.set_position(x, Math.round(sy - h - 6));
        if (!this.actor.visible) {
            this.actor.show();
            this.actor.ease({opacity: 255, duration: 120});
        }
    }

    hide(owner) {
        if (owner && owner !== this._owner)
            return;
        this._owner = null;
        this.actor.remove_all_transitions();
        this.actor.opacity = 0;
        this.actor.hide();
    }

    destroy() {
        this.actor.destroy();
    }
}

// ------------------------------------------------------------------ small items
// Non-clickable rows are plain boxes with the menu item padding:
// GNOME would grey out an inactive PopupMenuItem.
function addRow(menu, actor) {
    menu.box.add_child(actor);
    return actor;
}

// "Title            value" row
const LabelRow = GObject.registerClass(
class LabelRow extends St.BoxLayout {
    _init(title) {
        super._init({style_class: 'bp-row'});
        this.label = new St.Label({text: title, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this.value = new St.Label({style_class: 'bp-value', y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this.label);
        this.add_child(this.value);
    }
});

// full width slider row
const SliderRow = GObject.registerClass(
class SliderRow extends PopupMenu.PopupBaseMenuItem {
    _init(value, styleClass = '') {
        super._init({activate: false, style_class: `bp-slider-row ${styleClass}`});
        this.slider = new Slider(value);
        this.slider.x_expand = true;
        this.add_child(this.slider);
    }

    vfunc_navigate_focus(from, direction) {
        return this.slider.navigate_focus(from, direction, false);
    }
});

// "Start   (−) 19:20 (+)"
const StepperRow = GObject.registerClass(
class StepperRow extends St.BoxLayout {
    _init(title) {
        super._init({style_class: 'bp-row bp-stepper'});
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(new St.Label({text: title}));
        this.sub = new St.Label({style_class: 'bp-sub'});
        box.add_child(this.sub);
        this.add_child(box);

        this.minus = new St.Button({style_class: 'bp-step icon-button', can_focus: true,
            child: new St.Icon({icon_name: 'list-remove-symbolic'}), accessible_name: _('Earlier')});
        this.value = new St.Label({style_class: 'bp-step-value', y_align: Clutter.ActorAlign.CENTER});
        this.plus = new St.Button({style_class: 'bp-step icon-button', can_focus: true,
            child: new St.Icon({icon_name: 'list-add-symbolic'}), accessible_name: _('Later')});
        this.add_child(this.minus);
        this.add_child(this.value);
        this.add_child(this.plus);
    }
});

function pillButton(iconName, text) {
    const box = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER});
    box.add_child(new St.Icon({icon_name: iconName, style_class: 'bp-pill-icon'}));
    box.add_child(new St.Label({text, y_align: Clutter.ActorAlign.CENTER}));
    return new St.Button({style_class: 'bp-pill', child: box, x_expand: true, can_focus: true});
}

function bindSlider(slider, onChange) {
    const id = slider.connect('notify::value', () => onChange(slider.value));
    return value => {
        if (Math.abs(slider.value - value) < 0.0005)
            return;
        slider.block_signal_handler(id);
        slider.value = value;
        slider.unblock_signal_handler(id);
    };
}

// ------------------------------------------------------------------ monitor slider
export const BrightnessItem = GObject.registerClass(
class BrightnessItem extends QuickSlider {
    _init(display, manager, settings, tooltip) {
        super._init({iconName: 'display-brightness-symbolic', menuEnabled: true});
        this._display = display;
        this._manager = manager;
        this._settings = settings;
        this._tooltip = tooltip;
        this._dragging = false;
        this.add_style_class_name('bp-item');

        // moon instead of the arrow
        this._moonButton = this._menuButton ?? null;
        if (this._moonButton) {
            this._moonButton.child = new St.Icon({icon_name: MOON_ICON});
            this._moonButton.add_style_class_name('bp-moon');
        }
        this.menuButtonAccessibleName = _('Evening dimming and more');

        this._setSlider = bindSlider(this.slider, v => {
            this._display.setUser(v);
            this._showTooltip();
        });
        this.slider.accessible_name = display.name;

        // hover: monitor name
        this.slider.track_hover = true;
        this.slider.connectObject(
            'notify::hover', () => this._onHover(),
            'drag-begin', () => (this._dragging = true),
            'drag-end', () => {
                this._dragging = false;
                this._onHover();
            }, this);

        this._buildMenu();

        display.connectObject('changed', () => this._sync(), this);
        manager.connectObject('schedule-changed', () => this._sync(), this);
        settings.connectObject(
            'changed::slider-label', () => this._syncLabel(),
            'changed::schedule-mode', () => this._sync(), this);
        this.menu.connect('open-state-changed', (m, open) => {
            if (open)
                this._sync();
        });

        this._syncLabel();
        this._sync();
    }

    _onHover() {
        if (this.slider.hover || this._dragging)
            this._showTooltip();
        else
            this._tooltip.hide(this);
    }

    _showTooltip() {
        if (!this._settings.get_boolean('show-tooltip') || !this.slider.get_stage())
            return;
        if (!this.slider.hover && !this._dragging)
            return;
        this._tooltip.show(this, this.slider, `${this._display.name} · ${pct(this.slider.value)}`);
    }

    _syncLabel() {
        const mode = this._settings.get_string('slider-label');
        const parent = this._iconButton ?? this._icon?.get_parent();
        if (!parent)
            return;
        let child;
        if (mode === 'icon') {
            child = this._icon;
        } else {
            const text = mode === 'number' ? String(this._display.number) : this._display.shortName;
            child = new St.Label({
                text,
                style_class: `bp-badge ${mode === 'number' ? 'bp-badge-number' : 'bp-badge-text'}`,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
        }
        if (this._badge && this._badge !== child) {
            parent.remove_child(this._badge);
            if (this._badge !== this._icon)
                this._badge.destroy();
        }
        if (this._iconButton) {
            if (this._iconButton.child !== child) {
                if (this._iconButton.child === this._icon)
                    this._iconButton.remove_child(this._icon);
                this._iconButton.child = child;
            }
        } else if (child !== this._icon) {
            this._icon.hide();
            parent.insert_child_above(child, this._icon);
        } else {
            this._icon.show();
        }
        this._badge = child === this._icon ? null : child;
    }

    _buildMenu() {
        const d = this._display;
        const m = this.menu;
        m.setHeader('video-display-symbolic', d.name, '');

        // evening dimming
        this._scheduleSwitch = new PopupMenu.PopupSwitchMenuItem(_('Evening dimming'), d.cfg.schedule);
        this._scheduleSwitch.add_style_class_name('bp-switch');
        this._scheduleSwitch.insert_child_at_index(
            new St.Icon({icon_name: MOON_ICON, style_class: 'popup-menu-icon bp-moon-icon'}), 0);
        this._scheduleSwitch.connect('toggled', (item, state) => d.setConfig('schedule', state));
        m.addMenuItem(this._scheduleSwitch);

        this._start = new StepperRow(_('Start'));
        this._start.minus.connect('clicked', () => this._step(-1));
        this._start.plus.connect('clicked', () => this._step(1));
        addRow(m, this._start);

        this._nightLabel = new LabelRow(_('Night brightness'));
        this._nightLabel.value.add_style_class_name('bp-night-value');
        addRow(m, this._nightLabel);
        this._night = new SliderRow(d.cfg.night, 'bp-night');
        this._setNight = bindSlider(this._night.slider, v => {
            d.setConfig('night', Math.round(v * 100) / 100);
            this._nightLabel.value.text = pct(v);
        });
        m.addMenuItem(this._night);

        m.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // extra (software) dimming
        this._extraLabel = new LabelRow(_('Extra dimming'));
        addRow(m, this._extraLabel);
        this._extra = new SliderRow(d.cfg.extra);
        this._setExtra = bindSlider(this._extra.slider, v => {
            d.setConfig('extra', Math.round(v * 100) / 100);
            this._syncExtraLabel();
        });
        m.addMenuItem(this._extra);

        // screen off
        const buttons = new St.BoxLayout({style_class: 'bp-row bp-buttons'});
        const off = pillButton('system-shutdown-symbolic', _('Turn off screen'));
        const others = pillButton('video-display-symbolic', _('Turn off others'));
        off.connect('clicked', () => {
            Main.panel.closeQuickSettings?.();
            this._manager.turnOff(d);
        });
        others.connect('clicked', () => {
            Main.panel.closeQuickSettings?.();
            this._manager.turnOffOthers(d);
        });
        buttons.add_child(off);
        buttons.add_child(others);
        addRow(m, buttons);
    }

    _step(dir) {
        const d = this._display;
        if (this._settings.get_string('schedule-mode') === 'sun')
            d.setConfig('offset', Math.max(-240, Math.min(240, d.cfg.offset + dir * 5)));
        else
            d.setConfig('start', (d.cfg.start + dir * 15 + 1440) % 1440);
    }

    _syncExtraLabel() {
        const v = this._extra.slider.value;
        this._extraLabel.value.text = v < 0.005 ? _('Off') : pct(v);
    }

    _sync() {
        const d = this._display;
        const g = this._manager.globals;
        this._setSlider(d.value);
        this.slider.reactive = d.ready;
        this._moonButton?.[d.cfg.schedule ? 'add_style_class_name' : 'remove_style_class_name']('bp-active');
        if (d.off)
            this.add_style_class_name('bp-off');
        else
            this.remove_style_class_name('bp-off');

        if (!this.menu.isOpen)
            return;
        this.menu.setHeader('video-display-symbolic', d.name,
            d.off ? _('Turned off') : fmt(_('Brightness %s'), pct(d.value)));
        this._scheduleSwitch.setToggleState(d.cfg.schedule);

        const times = dayTimes(new Date(), d.cfg, g);
        const start = minutesOfDay(new Date(times.eveningStart));
        this._start.value.text = formatMinutes(start);
        if (g.mode === 'sun' && times.sunset) {
            const off = d.cfg.offset;
            const sign = off < 0 ? '−' : '+';
            this._start.sub.text = fmt(_('Sunset %s %s %d min'),
                formatMinutes(minutesOfDay(times.sunset)), sign, Math.abs(off));
        } else {
            this._start.sub.text = _('Fixed time');
        }
        this._nightLabel.value.text = pct(d.cfg.night);
        this._setNight(d.cfg.night);
        this._setExtra(d.cfg.extra);
        this._syncExtraLabel();

        for (const row of [this._start, this._nightLabel, this._night]) {
            if (d.cfg.schedule)
                row.remove_style_class_name('bp-dim');
            else
                row.add_style_class_name('bp-dim');
        }
    }

    destroy() {
        this._tooltip.hide(this);
        this.menu.destroy();
        super.destroy();
    }
});

// ------------------------------------------------------------------ night light
const COLOR_BUS = 'org.gnome.SettingsDaemon.Color';
const COLOR_PATH = '/org/gnome/SettingsDaemon/Color';
const COLOR_XML = `<node>
  <interface name="org.gnome.SettingsDaemon.Color">
    <property name="NightLightActive" type="b" access="read"/>
  </interface>
</node>`;
const ColorProxy = Gio.DBusProxy.makeProxyWrapper(COLOR_XML);

/** Watches whether Night Light is currently tinting the screen. */
export class NightLightState {
    constructor(onChange) {
        this.active = false;
        this._proxy = new ColorProxy(Gio.DBus.session, COLOR_BUS, COLOR_PATH, (p, error) => {
            if (error)
                return;
            this.active = !!p.NightLightActive;
            onChange();
        });
        this._proxy.connect('g-properties-changed', () => {
            this.active = !!this._proxy.NightLightActive;
            onChange();
        });
    }

    destroy() {
        this._proxy = null;
    }
}

export const NightLightItem = GObject.registerClass(
class NightLightItem extends QuickMenuToggle {
    _init(settings, state, shellGettext) {
        super._init({
            title: shellGettext('Night Light'),
            iconName: 'night-light-symbolic',
            toggleMode: true,
        });
        this._settings = settings;
        this._state = state;
        this.add_style_class_name('bp-night-light');

        global.backend.get_monitor_manager().bind_property('night-light-supported',
            this, 'visible', GObject.BindingFlags.SYNC_CREATE);

        this._color = new Gio.Settings({schema_id: COLOR_SCHEMA});
        this._color.bind('night-light-enabled', this, 'checked', Gio.SettingsBindFlags.DEFAULT);

        const m = this.menu;
        m.setHeader('night-light-symbolic', shellGettext('Night Light'), '');

        this._tempLabel = new LabelRow(_('Temperature'));
        addRow(m, this._tempLabel);
        this._temp = new SliderRow(this._tempToValue(), 'bp-temp');
        this._setTemp = bindSlider(this._temp.slider, v => this._writeTemp(v));
        m.addMenuItem(this._temp);

        m.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._red = new PopupMenu.PopupSwitchMenuItem(_('Red screen'), settings.get_boolean('red-enabled'));
        this._red.add_style_class_name('bp-switch bp-red-switch');
        this._red.insert_child_at_index(new St.Widget({style_class: 'bp-red-dot', y_align: Clutter.ActorAlign.CENTER}), 0);
        this._red.connect('toggled', (item, on) => settings.set_boolean('red-enabled', on));
        m.addMenuItem(this._red);

        this._redHint = new LabelRow('');
        this._redHint.add_style_class_name('bp-hint');
        addRow(m, this._redHint);

        this._strengthLabel = new LabelRow(_('Strength'));
        this._strengthLabel.value.add_style_class_name('bp-red-value');
        addRow(m, this._strengthLabel);
        this._strength = new SliderRow(settings.get_double('red-strength'), 'bp-red');
        this._setStrength = bindSlider(this._strength.slider, v => {
            settings.set_double('red-strength', Math.max(0.05, Math.round(v * 100) / 100));
        });
        m.addMenuItem(this._strength);

        this._color.connectObject(
            'changed::night-light-temperature', () => this._sync(),
            'changed::night-light-schedule-automatic', () => this._sync(),
            'changed::night-light-schedule-from', () => this._sync(),
            'changed::night-light-schedule-to', () => this._sync(),
            'changed::night-light-enabled', () => this._sync(), this);
        settings.connectObject(
            'changed::red-enabled', () => this._sync(),
            'changed::red-strength', () => this._sync(),
            'changed::red-follows-night-light', () => this._sync(), this);
        this._sync();
    }

    _tempToValue() {
        const t = this._color.get_uint('night-light-temperature');
        return Math.max(0, Math.min(1, (TEMP_COOL - t) / (TEMP_COOL - TEMP_WARM)));
    }

    // gsettings writes are cheap, but not 60 per second: merge them
    _writeTemp(v) {
        this._pendingTemp = Math.round(TEMP_COOL - v * (TEMP_COOL - TEMP_WARM));
        if (this._tempTimer)
            return;
        this._tempTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            this._tempTimer = 0;
            this._color.set_uint('night-light-temperature', this._pendingTemp);
            return GLib.SOURCE_REMOVE;
        });
    }

    _hours(h) {
        return formatMinutes(Math.round(h * 60));
    }

    stateChanged() {
        this._sync();
    }

    _sync() {
        const s = this._settings;
        const red = s.get_boolean('red-enabled');
        const redShown = red && this.checked;
        this.subtitle = redShown ? _('Red screen') : null;
        if (redShown)
            this.add_style_class_name('bp-red-on');
        else
            this.remove_style_class_name('bp-red-on');

        const auto = this._color.get_boolean('night-light-schedule-automatic');
        const sub = auto
            ? _('Sunset to sunrise')
            : `${this._hours(this._color.get_double('night-light-schedule-from'))} – ${this._hours(this._color.get_double('night-light-schedule-to'))}`;
        this.menu.setHeader('night-light-symbolic', this.title, sub);

        this._setTemp(this._tempToValue());
        this._tempLabel.value.text = `${this._color.get_uint('night-light-temperature')} K`;
        this._red.setToggleState(red);
        const strength = s.get_double('red-strength');
        this._setStrength(strength);
        this._strengthLabel.value.text = pct(strength);
        this._strengthLabel.visible = red;
        this._strength.visible = red;

        let hint = '';
        if (red && s.get_boolean('red-follows-night-light')) {
            if (!this.checked)
                hint = _('Turns on together with Night Light');
            else if (!this._state.active)
                hint = _('Starts when Night Light starts');
        }
        this._redHint.label.text = hint;
        this._redHint.visible = !!hint;
    }

    destroy() {
        if (this._tempTimer) {
            GLib.source_remove(this._tempTimer);
            this._color.set_uint('night-light-temperature', this._pendingTemp);
        }
        this.menu.destroy();
        super.destroy();
    }
});
