// Quick Settings widgets: one brightness slider per monitor (with its moon
// menu) and the Night Light toggle with a menu.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickMenuToggle, QuickSlider} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {fmt, formatMinutes, minutesOfDay, sunElevation, sunTimes} from './sun.js';
import {formatSeconds} from './offmenu.js';
import {GRAPH_SPAN, curveAt, curveKnots, dayTimes} from './schedule.js';
import {ACTIONS, OFF_DARK_MIN} from './displays.js';

const INFO_WIDTH = 270;
const COLOR_SCHEMA = 'org.gnome.settings-daemon.plugins.color';
const TEMP_WARM = 1700;
const TEMP_COOL = 4700;

const DURATION_MIN = 30;
const DURATION_MAX = 360;
const DURATION_STEP = 15;

// one colour per layer: slider, value and graph curve
const MOON_ICON = 'weather-clear-night-symbolic';
const YELLOW = [1.0, 0.84, 0.04];
const DAY = {key: 'day', title: () => _('Day brightness'), style: 'bp-c-bright', rgb: YELLOW, evening: true};
const NIGHT = {key: 'night', title: () => _('Night brightness'), style: 'bp-c-bright', rgb: YELLOW, evening: true};
const EXTRA = {key: 'extra', title: () => _('Extra dimming'), style: 'bp-c-extra', rgb: [0.39, 0.82, 1.0],
    info: () => _('Darkens the picture further when the monitor is already at its lowest brightness.')};
const LAYERS = [DAY, NIGHT, EXTRA];

// this monitor's share of Night Light and red screen: ×0 … ×2
const MULTIPLIERS = [
    // the health fact first (why), then what the slider does here
    {key: 'nightLight', title: () => _('Night light'), style: 'bp-c-warm',
        info: () => `${_('Blue light in the evening holds back melatonin, the sleep hormone. A warmer screen helps you fall asleep more easily.')}\n${
            _('How strong Night Light is on this monitor. ×1 = exactly GNOME’s Night Light, nothing added. ×0 turns it off here, ×2 makes it twice as warm.')}`},
    {key: 'redLight', title: () => _('Red light'), style: 'bp-c-red',
        info: () => `${_('Red light disturbs melatonin and your body clock the least of all colours. Ideal for the last hours before bed.')}\n${
            _('How strong the red screen is on this monitor. ×1 = the red screen as set in the Night Light menu, nothing added. ×0 keeps this monitor normal, ×2 makes it twice as red.')}`},
];
const MULT_MAX = 2;
const MULT = new Intl.NumberFormat(undefined, {minimumFractionDigits: 1, maximumFractionDigits: 1});
const mult = k => `×${MULT.format(k)}`;

const PERCENT = new Intl.NumberFormat(undefined, {style: 'percent'});
const pct = v => PERCENT.format(Math.round(v * 100) / 100);

function formatDuration(min) {
    const h = Math.floor(min / 60), m = min % 60;
    if (!h)
        return fmt(_('%d min'), m);
    return m ? fmt(_('%d h %d min'), h, m) : fmt(_('%d h'), h);
}


// ------------------------------------------------------------------ tooltip
export class Tooltip {
    constructor() {
        this.actor = new St.Label({style_class: 'bp-tooltip', visible: false, opacity: 0});
        Main.layoutManager.uiGroup.add_child(this.actor);
        this._owner = null;
    }

    /**
     * Centered above `anchor` (below it when there is no room).
     * @param {boolean} wrap long text: several lines
     */
    show(owner, anchor, text, wrap = false) {
        this._owner = owner;
        const a = this.actor;
        a.text = text;
        if (wrap) {
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            a.add_style_class_name('bp-tooltip-info');
            a.clutter_text.line_wrap = true;
            a.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            a.set_width(INFO_WIDTH * scale);
        } else {
            a.remove_style_class_name('bp-tooltip-info');
            a.clutter_text.line_wrap = false;
            a.set_width(-1);
        }
        Main.layoutManager.uiGroup.set_child_above_sibling(a, null);
        const [ax, ay] = anchor.get_transformed_position();
        const [aw, ah] = anchor.get_transformed_size();
        const [, w] = a.get_preferred_width(-1);
        const [, h] = a.get_preferred_height(w);
        const monitor = Main.layoutManager.findMonitorForActor(anchor);
        let x = Math.round(ax + aw / 2 - w / 2);
        let y = Math.round(ay - h - 6);
        if (monitor) {
            x = Math.max(monitor.x + 4, Math.min(x, monitor.x + monitor.width - w - 4));
            if (y < monitor.y + 4)
                y = Math.round(ay + ah + 6);
        }
        a.set_position(x, y);
        if (!a.visible) {
            a.show();
            a.ease({opacity: 255, duration: 120});
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

let iconDir = '';
/** Where the extension's own icons are (call once from enable()). */
export function setIconDir(dir) {
    iconDir = dir;
}

let openPrefs = null;
/** How to open the preferences window (call once from enable()). */
export function setPrefsOpener(fn) {
    openPrefs = fn;
}
const ownIcon = name => Gio.icon_new_for_string(`${iconDir}/${name}-symbolic.svg`);

// (i): explains on hover
/*
 * A small "back to the default" arrow next to a slider. Its place is always
 * kept (so the sliders line up); it shows only while the value is changed.
 * shown(): is it changed? reset(): back to the default.
 */
function resetButton(tooltip, text, shown, reset) {
    const button = new St.Button({
        style_class: 'bp-reset icon-button',
        child: new St.Icon({icon_name: 'edit-undo-symbolic', style_class: 'bp-reset-icon'}),
        can_focus: true,
        track_hover: true,
        accessible_name: text,
        y_align: Clutter.ActorAlign.CENTER,
    });
    button.connect('notify::hover', () => (button.hover
        ? tooltip.show(button, button, text, true)
        : tooltip.hide(button)));
    button.connect('clicked', () => {
        tooltip.hide(button);
        reset();
    });
    button.connect('destroy', () => tooltip.hide(button));
    button.sync = () => {
        const on = shown();
        button.opacity = on ? 255 : 0;
        button.reactive = on;
        button.can_focus = on;
    };
    return button;
}

/*
 * A switch row that stays in the open menu: a plain PopupSwitchMenuItem
 * "activates" on a click, and that closes the whole Quick Settings.
 */
function switchItem(text, active) {
    const item = new PopupMenu.PopupSwitchMenuItem(text, active);
    item.activate = () => {
        if (item._switch.mapped)
            item.toggle();
    };
    return item;
}

function infoButton(tooltip, text) {
    const icon = new St.Icon({gicon: ownIcon('bp-info'), style_class: 'bp-info-icon'});
    const bin = new St.Bin({
        style_class: 'bp-info',
        child: icon,
        reactive: true,
        track_hover: true,
        y_align: Clutter.ActorAlign.CENTER,
        accessible_name: text,
    });
    // the text is read at hover time, so it can change (accessible_name)
    bin.connect('notify::hover', () => {
        if (bin.hover)
            tooltip.show(bin, bin, bin.accessible_name, true);
        else
            tooltip.hide(bin);
    });
    bin.connect('destroy', () => tooltip.hide(bin));
    return bin;
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
        this.label = new St.Label({text: title, y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this.label);
        this.extra = new St.BoxLayout({x_expand: true});
        this.add_child(this.extra);
        this.value = new St.Label({style_class: 'bp-value', y_align: Clutter.ActorAlign.CENTER});
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

// "Title  [(i)]  ───●───  35 %" on one line
const LayerRow = GObject.registerClass(
class LayerRow extends PopupMenu.PopupBaseMenuItem {
    _init(layer, value) {
        super._init({activate: false, style_class: `bp-layer ${layer.style}`});
        this.layer = layer;
        const head = new St.BoxLayout({style_class: 'bp-layer-head', y_align: Clutter.ActorAlign.CENTER});
        head.add_child(new St.Widget({style_class: 'bp-layer-dot', y_align: Clutter.ActorAlign.CENTER}));
        this.label = new St.Label({text: layer.title(), style_class: 'bp-layer-label', y_align: Clutter.ActorAlign.CENTER});
        head.add_child(this.label);
        this.head = head;
        this.add_child(head);
        this.slider = new Slider(value);
        this.slider.x_expand = true;
        this.add_child(this.slider);
        this.value = new St.Label({style_class: 'bp-layer-value', y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this.value);
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

// small square-ish button: coloured icon over a short label
function tileButton(icon, text, styleClass) {
    // icons stay on one line even when one label takes two lines
    const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.START});
    box.add_child(new St.Icon({
        ...typeof icon === 'string' ? {icon_name: icon} : {gicon: icon},
        style_class: 'bp-tile-icon',
        x_align: Clutter.ActorAlign.CENTER,
    }));
    // long translations wrap onto a second line instead of stretching the tile
    const label = new St.Label({text, style_class: 'bp-tile-label', x_expand: true});
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    label.clutter_text.line_alignment = Pango.Alignment.CENTER;
    box.add_child(label);
    return new St.Button({style_class: `bp-tile ${styleClass}`, child: box, x_expand: true, can_focus: true,
        accessible_name: text});
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

// ------------------------------------------------------------------ evening graph
/*
 * The evening, drawn: brightness (yellow) and extra dimming (blue, only
 * when used). Every curve has its start (the day value), three points on
 * the way, the main point (the night value, at the end of the duration;
 * drawn bigger) and three more points through the night. Drag a point up or
 * down; drag the main point sideways to change the duration; double-click a
 * small point to let it follow the main point again.
 *
 * Under it (simple menu: along its top), the buttons that run by themselves: "+" adds one,
 * drag a button to move its time, click it once and then its × to remove it.
 * Repaints only when something changes.
 */
const ACTION_STYLE = {
    // the same colours as the buttons under the graph
    lowest: {rgb: [0.75, 0.61, 1.0], title: () => _('Lowest light')},
    off: {rgb: [1.0, 0.42, 0.37], title: () => _('Turn off screen')},
    others: {rgb: [1.0, 0.42, 0.37], title: () => _('Turn off other screens')},
};
const NIGHT_LIGHT_RGB = [1.0, 0.58, 0.16];
const GRAPH_LAYERS = {night: {rgb: YELLOW}, extra: {rgb: [0.39, 0.82, 1.0]}};
const HIT = 13;
// the sky behind the graph, by the sun's height (degrees): day, golden hour,
// sunset, twilight, night
const SKY = [
    [8, [0.45, 0.70, 1.00], 0.10],
    [2, [1.00, 0.78, 0.40], 0.14],
    [-2, [1.00, 0.50, 0.30], 0.18],
    [-7, [0.62, 0.32, 0.62], 0.18],
    [-13, [0.22, 0.20, 0.50], 0.22],
    [-18, [0.08, 0.10, 0.28], 0.30],
];
const STARS = [[0.13, 0.20], [0.31, 0.08], [0.47, 0.27], [0.62, 0.12], [0.78, 0.30], [0.91, 0.10], [0.70, 0.45], [0.22, 0.40]];

function skyAt(elev) {
    if (elev >= SKY[0][0])
        return SKY[0].slice(1);
    for (let i = 1; i < SKY.length; i++) {
        const [e1, c1, a1] = SKY[i - 1], [e2, c2, a2] = SKY[i];
        if (elev >= e2) {
            const t = (e1 - elev) / (e1 - e2);
            return [c1.map((c, k) => c + (c2[k] - c) * t), a1 + (a2 - a1) * t];
        }
    }
    return SKY.at(-1).slice(1);
}

const LANE_H = 28;

const EveningGraph = GObject.registerClass(
class EveningGraph extends St.DrawingArea {
    _init(display, manager, settings, color) {
        super._init({style_class: 'bp-graph', reactive: true, x_expand: true});
        this._display = display;
        this._manager = manager;
        this._settings = settings;
        this._color = color;
        this._drag = null;
        this._grab = null;
        this._choosing = false;     // "+" pressed: pick which button
        this._selected = null;      // a lane button showing its ×
    }

    // in repaint the surface size, otherwise the allocation (same thing)
    // the simple menu: the buttons sit in a row along the graph's top, + in its corner
    get _inline() {
        return this._settings.get_string('menu-style') !== 'detailed';
    }

    _geometry(size = [this.width, this.height]) {
        const [w, h] = size;
        const left = 10, right = 12, top = 20;       // top: room for the Night Light / red screen bars
        const laneTop = this._inline ? h : h - LANE_H - 16;
        const ph = Math.max(1, (this._inline ? h : laneTop) - 20 - top);
        return {w, h, left, top, pw: Math.max(1, w - left - right), ph, laneTop};
    }

    _X(g, min) {
        return g.left + g.pw * Math.max(0, Math.min(1, min / GRAPH_SPAN));
    }

    _Y(g, v) {
        return g.top + g.ph * (1 - v);
    }

    _drawSky(cr, g, start, X, Y) {
        const gl = this._manager.globals;
        const top = g.top, h = Y(0) - g.top;
        if (h <= 0)
            return;
        cr.save();
        this._roundRect(cr, g.left, top, g.pw, h, 6);
        cr.clip();
        const step = 3;
        const dark = [];
        for (let x = 0; x < g.pw; x += step) {
            const min = (x + step / 2) / g.pw * GRAPH_SPAN;
            const elev = sunElevation(new Date(start + min * 60000), gl.lat, gl.lon);
            const [rgb, a] = skyAt(elev);
            // stronger at the top, like a real sky
            const grad = new Cairo.LinearGradient(0, top, 0, top + h);
            grad.addColorStopRGBA(0, ...rgb, a);
            grad.addColorStopRGBA(1, ...rgb, a * 0.35);
            cr.setSource(grad);
            cr.rectangle(g.left + x, top, Math.min(step, g.pw - x), h);
            cr.fill();
            dark.push(elev < -12);
        }
        // a few stars where it is really night
        cr.setSourceRGBA(1, 1, 1, 0.55);
        for (const [fx, fy] of STARS) {
            const x = fx * g.pw;
            if (dark[Math.floor(x / step)]) {
                cr.arc(g.left + x, top + fy * h, 0.9, 0, 2 * Math.PI);
                cr.fill();
            }
        }
        // midnight: a small moon at the top
        const midnight = new Date(start);
        midnight.setHours(24, 0, 0, 0);
        const mm = (midnight.getTime() - start) / 60000;
        if (mm > 0 && mm < GRAPH_SPAN) {
            const mx = X(mm), my = top + 7;
            // a crescent: the disc without a second, shifted disc
            cr.save();
            cr.arc(mx, my, 3.6, 0, 2 * Math.PI);
            cr.clip();
            cr.rectangle(mx - 4, my - 4, 8, 8);
            cr.arc(mx + 1.8, my - 1.2, 3.2, 0, 2 * Math.PI);
            cr.setFillRule(Cairo.FillRule.EVEN_ODD);
            cr.setSourceRGBA(0.85, 0.88, 1.0, 0.8);
            cr.fill();
            cr.restore();
        }
        cr.restore();
    }

    _drawSunset(cr, x, base, ink) {
        const sun = [1.0, 0.62, 0.18];
        x = Math.max(this._geometry().left + 9, x);
        const r = 6.5;
        // a faint line up: where the Night Light start snaps to
        cr.setDash([2, 3], 0);
        cr.setLineWidth(1);
        ink(0.35, sun);
        cr.moveTo(Math.round(x) + 0.5, 1);
        cr.lineTo(Math.round(x) + 0.5, base - r - 13);
        cr.stroke();
        cr.setDash([], 0);
        // the upper half of the sun, and its rays
        cr.save();
        cr.rectangle(x - 20, base - 20, 40, 20);
        cr.clip();
        cr.arc(x, base, r, 0, 2 * Math.PI);
        ink(0.95, sun);
        cr.fill();
        cr.setLineWidth(1.5);
        cr.setLineCap(Cairo.LineCap.ROUND);
        for (const a of [-150, -120, -90, -60, -30]) {
            const t = a * Math.PI / 180;
            cr.moveTo(x + Math.cos(t) * (r + 2.5), base + Math.sin(t) * (r + 2.5));
            cr.lineTo(x + Math.cos(t) * (r + 5), base + Math.sin(t) * (r + 5));
        }
        ink(0.8, sun);
        cr.stroke();
        cr.restore();
        // the horizon
        cr.setLineWidth(1.5);
        ink(0.9, sun);
        cr.moveTo(x - r - 6, base + 0.5);
        cr.lineTo(x + r + 6, base + 0.5);
        cr.stroke();
        // going down
        const ay = base - r - 12;
        cr.setLineWidth(1.4);
        cr.moveTo(x, ay - 4);
        cr.lineTo(x, ay + 3);
        cr.moveTo(x - 2.5, ay + 0.5);
        cr.lineTo(x, ay + 3);
        cr.lineTo(x + 2.5, ay + 0.5);
        cr.stroke();
        cr.setLineCap(Cairo.LineCap.BUTT);
    }

    // sunset of this evening, minutes after its start (GNOME's automatic Night Light time)
    _sunset(start) {
        const g = this._manager.globals;
        const set = sunTimes(new Date(start), g.lat, g.lon).sunset;
        return set ? (set.getTime() - start) / 60000 : null;
    }

    /*
     * When GNOME's Night Light and the red screen are on, in minutes after
     * this evening's start: [{rgb, from, to}]. Shown as thin bars at the top;
     * GNOME sets these times (Settings → Displays → Night Light), not us.
     */
    _gnomeBars(start) {
        const c = this._color, s = this._settings, cfg = this._display.cfg;
        if (!c.get_boolean('night-light-enabled'))
            return [];
        // exactly when GNOME switches it on: its own sunset/sunrise on automatic, its
        // fixed times otherwise (also on automatic when it has no location)
        const at = h => {
            const d = new Date(start);
            d.setHours(Math.floor(h), Math.round((h % 1) * 60), 0, 0);
            let min = (d.getTime() - start) / 60000;
            if (min < -720)
                min += 1440;
            return min;
        };
        const gsd = c.get_boolean('night-light-schedule-automatic') ? this._manager.gamma.nightLightTimes() : null;
        const from = at(gsd ? gsd.sunset : c.get_double('night-light-schedule-from'));
        let to = at(gsd ? gsd.sunrise : c.get_double('night-light-schedule-to'));
        if (to <= from)
            to += 1440;
        // GNOME warms up linearly during the hour before the start (and cools down
        // during the hour before the end): gsd-night-light's one hour "smear"
        const ramp = Math.min(60, Math.max(0, (to - from) / 2));
        const bars = [];
        if (cfg.nightLight > 0)
            bars.push({rgb: NIGHT_LIGHT_RGB, from, to, ramp, row: 0, k: cfg.nightLight});
        if (s.get_boolean('red-enabled') && cfg.redLight > 0) {
            const follows = s.get_boolean('red-follows-night-light');
            bars.push({rgb: [1.0, 0.27, 0.23], from: follows ? from : 0, to: follows ? to : GRAPH_SPAN, ramp: 0, row: 1, k: cfg.redLight});
        }
        return bars;
    }

    _layers() {
        const cfg = this._display.cfg;
        const out = ['night'];
        const extra = curveKnots(cfg, 'extra');
        if (extra.some(([, v]) => v > 0.004) || this._drag?.key === 'extra')
            out.push('extra');
        return out;
    }

    // every draggable point: {key, i, x, y, kind: 'start'|'small'|'main'}
    _points(g) {
        const out = [];
        for (const key of this._layers()) {
            curveKnots(this._display.cfg, key).forEach(([t, v], i) => {
                if (key === 'extra' && i === 0)
                    return;             // extra dimming always starts at 0
                const kind = i === 0 ? 'start' : i === 4 ? 'main' : 'small';
                out.push({key, i, x: this._X(g, t), y: this._Y(g, v), kind, v});
            });
        }
        return out;
    }

    _lane(g) {
        const cfg = this._display.cfg;
        const inline = this._inline;
        // inline: the buttons in a row along the top of the graph, next to the +
        const cy = inline ? g.top + 13 : g.laneTop + LANE_H / 2;
        const items = ACTIONS.filter(a => cfg.events[a] !== null)
            .map(a => ({action: a, x: this._X(g, cfg.events[a]), y: cy}));
        // inline: + in the graph's top right corner, the choices to its left
        const plus = inline ? {x: g.left + g.pw - 13, y: g.top + 13} : {x: g.left + 13, y: cy};
        const step = inline ? -28 : 30;
        const choices = this._choosing
            ? ACTIONS.filter(a => cfg.events[a] === null).map((a, i) => ({action: a, x: plus.x + step * (i + 1), y: plus.y}))
            : [];
        return {items, plus, choices, cy, inline};
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const node = this.get_theme_node();
        const fg = node.get_foreground_color();
        const g = this._geometry(this.get_surface_size());
        const cfg = this._display.cfg;
        const fgc = [fg.red / 255, fg.green / 255, fg.blue / 255];
        const ink = (a, rgb = fgc) => cr.setSourceRGBA(...rgb, a);
        const X = t => this._X(g, t), Y = v => this._Y(g, v);
        const start = this._startTime();

        // the sky: where the sun really is at each time (day, sunset, twilight, night)
        this._drawSky(cr, g, start, X, Y);

        // frame: baseline, end of the duration, buttons' times
        cr.setLineWidth(1);
        ink(0.10);
        cr.moveTo(g.left, Y(0) + 0.5);
        cr.lineTo(g.left + g.pw, Y(0) + 0.5);
        cr.stroke();
        cr.setDash([2, 3], 0);
        ink(0.16);
        cr.moveTo(Math.round(X(cfg.duration)) + 0.5, g.top);
        cr.lineTo(Math.round(X(cfg.duration)) + 0.5, Y(0));
        cr.stroke();
        const lane = this._lane(g);
        for (const it of lane.items) {
            ink(0.5, ACTION_STYLE[it.action].rgb);
            cr.moveTo(Math.round(it.x) + 0.5, lane.inline ? it.y + 22 : g.top - 6);
            cr.lineTo(Math.round(it.x) + 0.5, lane.inline ? Y(0) : g.laneTop);
            cr.stroke();
        }
        cr.setDash([], 0);
        const now = (Date.now() - start) / 60000;
        if (cfg.schedule && now >= 0 && now <= GRAPH_SPAN) {
            ink(0.35);
            cr.moveTo(Math.round(X(now)) + 0.5, g.top - 6);
            cr.lineTo(Math.round(X(now)) + 0.5, Y(0));
            cr.stroke();
        }

        // the sunset (GNOME's automatic Night Light start): a sun half gone
        // under the bottom line, with an arrow down
        const sunsetMin = this._sunset(start);
        if (sunsetMin !== null && sunsetMin >= 0 && sunsetMin <= GRAPH_SPAN)
            this._drawSunset(cr, X(sunsetMin), Y(0), ink);

        // thicker and stronger with this monitor's multiplier (×0 … ×2); the
        // warm-up hour before the start is drawn as a taper
        for (const b of this._gnomeBars(start)) {
            const x1 = X(Math.max(0, b.from)), x2 = X(Math.min(GRAPH_SPAN, b.to));
            const k = Math.min(2, b.k) / 2;
            const h = 1.5 + 3 * k;
            const cy = 5 + b.row * 7;
            if (b.ramp > 0) {
                const r0 = X(Math.max(0, b.from - b.ramp));
                if (x1 > r0) {
                    cr.moveTo(r0, cy);
                    cr.lineTo(x1, cy - h / 2);
                    cr.lineTo(x1, cy + h / 2);
                    cr.closePath();
                    ink(0.25 + 0.4 * k, b.rgb);
                    cr.fill();
                }
            }
            if (x2 <= x1)
                continue;
            this._roundRect(cr, x1, cy - h / 2, x2 - x1, h, h / 2);
            ink(0.35 + 0.6 * k, b.rgb);
            cr.fill();
        }

        // curves: smooth through their points
        const layers = this._layers();
        layers.sort((a, b) => (a === this._drag?.key) - (b === this._drag?.key));
        const N = 90;
        for (const key of layers) {
            const knots = curveKnots(cfg, key);
            const rgb = GRAPH_LAYERS[key].rgb;
            const path = () => {
                cr.moveTo(X(0), Y(knots[0][1]));
                for (let i = 1; i <= N; i++) {
                    const t = GRAPH_SPAN * i / N;
                    cr.lineTo(X(t), Y(curveAt(knots, t)));
                }
            };
            if (key === 'night') {
                path();
                cr.lineTo(X(GRAPH_SPAN), Y(0));
                cr.lineTo(X(0), Y(0));
                cr.closePath();
                ink(0.07, rgb);
                cr.fill();
            }
            path();
            cr.setLineWidth(2);
            ink(0.95, rgb);
            cr.stroke();
        }
        for (const p of this._points(g)) {
            const rgb = GRAPH_LAYERS[p.key].rgb;
            const active = this._drag?.key === p.key && this._drag?.i === p.i;
            if (p.kind === 'main') {
                // the main point: bigger, filled, with a white ring and a soft halo
                cr.arc(p.x, p.y, active ? 10 : 8.5, 0, 2 * Math.PI);
                ink(0.22, rgb);
                cr.fill();
                cr.arc(p.x, p.y, 5.5, 0, 2 * Math.PI);
                ink(1, rgb);
                cr.fillPreserve();
                cr.setLineWidth(2);
                ink(1, [1, 1, 1]);
                cr.stroke();
            } else if (p.kind === 'start') {
                cr.arc(p.x, p.y, active ? 5.5 : 4.2, 0, 2 * Math.PI);
                ink(1, rgb);
                cr.fill();
            } else {
                cr.arc(p.x, p.y, active ? 5 : 3.6, 0, 2 * Math.PI);
                ink(1, [0.17, 0.17, 0.19]);
                cr.fillPreserve();
                cr.setLineWidth(1.8);
                ink(1, rgb);
                cr.stroke();
            }
        }

        // labels
        const layout = PangoCairo.create_layout(cr);
        const font = node.get_font().copy();
        font.set_size(Math.round(font.get_size() * 0.7));
        font.set_weight(Pango.Weight.BOLD);
        layout.set_font_description(font);
        const label = (text, x, y, align, a = 0.55, rgb = fgc) => {
            layout.set_text(text, -1);
            const [, log] = layout.get_pixel_extents();
            let lx = align === 'center' ? x - log.width / 2 : align === 'end' ? x - log.width : x;
            lx = Math.max(0, Math.min(g.w - log.width, lx));
            cr.moveTo(lx, y);
            ink(a, rgb);
            PangoCairo.show_layout(cr, layout);
            return [lx, lx + log.width];
        };
        const clock = min => formatMinutes(minutesOfDay(new Date(start + min * 60000)));
        const ly = Y(0) + 3;
        // the evening starting right at sunset: its start label is the sunset one
        const atSunset = sunsetMin !== null && Math.abs(sunsetMin) < 3;
        const used = [atSunset
            ? label(clock(0), g.left, ly, 'start', 0.95, [1.0, 0.70, 0.25])
            : label(clock(0), g.left, ly, 'start')];
        const fits = ([a, b]) => used.every(([c, d]) => b + 8 < c || a > d + 8);
        if (!atSunset && sunsetMin !== null && sunsetMin >= 0 && sunsetMin <= GRAPH_SPAN) {
            const text = clock(sunsetMin);
            layout.set_text(text, -1);
            const [, log] = layout.get_pixel_extents();
            const x = X(sunsetMin), span = [x - log.width / 2, x + log.width / 2];
            if (fits(span))
                used.push(label(text, x, ly, 'center', 0.95, [1.0, 0.70, 0.25]));
        }
        for (const [min, a] of [[cfg.duration, 0.85], [GRAPH_SPAN, 0.55]]) {
            layout.set_text(clock(min), -1);
            const [, log] = layout.get_pixel_extents();
            const x = X(min), span = [x - log.width / 2, x + log.width / 2];
            if (min === GRAPH_SPAN)
                span[0] = x - log.width;
            if (fits(span))
                used.push(label(clock(min), x, ly, min === GRAPH_SPAN ? 'end' : 'center', a));
        }
        if (this._drag?.what === 'point' && this._drag.moved) {
            const p = this._points(g).find(x => x.key === this._drag.key && x.i === this._drag.i);
            if (p) {
                let text = pct(p.v);
                if (this._drag.axis === 'x' && this._drag.i === 0) {
                    // the start: its time, and how far from sunset
                    const o = cfg.offset;
                    text = this._settings.get_string('schedule-mode') === 'sun'
                        ? `${clock(0)} · ${o < 0 ? '−' : '+'}${formatDuration(Math.abs(o))}` : clock(0);
                } else if (this._drag.axis === 'x') {
                    text = formatDuration(cfg.duration);
                }
                label(text, p.x + (p.x > g.left + g.pw * 0.75 ? -10 : 10), Math.max(0, p.y - 18),
                    p.x > g.left + g.pw * 0.75 ? 'end' : 'start', 1, GRAPH_LAYERS[p.key].rgb);
            }
        }

        // the lane (inline: no strip, the buttons sit along the top of the graph)
        if (!lane.inline) {
            this._roundRect(cr, g.left, g.laneTop, g.pw, LANE_H, LANE_H / 2);
            ink(0.06);
            cr.fill();
        }
        this._circle(cr, lane.plus.x, lane.plus.y, 10, fgc, this._choosing ? 0.3 : 0.16);
        ink(0.9);
        cr.setLineWidth(1.6);
        cr.moveTo(lane.plus.x - 4.5, lane.plus.y);
        cr.lineTo(lane.plus.x + 4.5, lane.plus.y);
        if (!this._choosing) {
            cr.moveTo(lane.plus.x, lane.plus.y - 4.5);
            cr.lineTo(lane.plus.x, lane.plus.y + 4.5);
        }
        cr.stroke();
        for (const c of lane.choices) {
            this._circle(cr, c.x, c.y, 11, ACTION_STYLE[c.action].rgb, 0.18);
            this._glyph(cr, c.action, c.x, c.y);
        }
        for (const it of lane.items) {
            const rgb = ACTION_STYLE[it.action].rgb;
            this._circle(cr, it.x, it.y, 11, [0.17, 0.17, 0.19], 1);
            cr.arc(it.x, it.y, 11, 0, 2 * Math.PI);
            cr.setLineWidth(1.5);
            ink(1, rgb);
            cr.stroke();
            this._glyph(cr, it.action, it.x, it.y);
            if (lane.inline) {
                // on a dark chip: the curve may run right through here
                const text = clock(cfg.events[it.action]);
                layout.set_text(text, -1);
                const [, log] = layout.get_pixel_extents();
                const lx = Math.max(0, Math.min(g.w - log.width, it.x - log.width / 2));
                this._roundRect(cr, lx - 4, it.y + 12, log.width + 8, log.height + 4, (log.height + 4) / 2);
                ink(0.85, [0.13, 0.13, 0.15]);
                cr.fill();
                label(text, it.x, it.y + 14, 'center', 1, rgb);
            } else {
                label(clock(cfg.events[it.action]), it.x, g.laneTop + LANE_H + 1, 'center', 0.9, rgb);
            }
            if (this._selected === it.action) {
                const [bx, by] = [it.x + 10, it.y - 10];
                this._circle(cr, bx, by, 6.5, [0.9, 0.3, 0.3], 1);
                ink(1, [1, 1, 1]);
                cr.setLineWidth(1.4);
                cr.moveTo(bx - 2.5, by - 2.5);
                cr.lineTo(bx + 2.5, by + 2.5);
                cr.moveTo(bx + 2.5, by - 2.5);
                cr.lineTo(bx - 2.5, by + 2.5);
                cr.stroke();
            }
        }
        cr.$dispose();
    }

    _circle(cr, x, y, r, rgb, a) {
        cr.arc(x, y, r, 0, 2 * Math.PI);
        cr.setSourceRGBA(...rgb, a);
        cr.fill();
    }

    _roundRect(cr, x, y, w, h, r) {
        cr.newSubPath();
        cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
        cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
        cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
        cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
        cr.closePath();
    }

    // the three buttons' symbols, drawn small
    _glyph(cr, action, x, y) {
        cr.setSourceRGBA(...ACTION_STYLE[action].rgb, 1);
        cr.setLineWidth(1.4);
        if (action === 'lowest') {
            // a monitor with a dim picture, like its button
            cr.setLineWidth(1.2);
            this._roundRect(cr, x - 6, y - 4.5, 12, 8, 1.4);
            cr.stroke();
            cr.setSourceRGBA(...ACTION_STYLE[action].rgb, 0.35);
            cr.rectangle(x - 4, y - 2.5, 8, 4);
            cr.fill();
            cr.setSourceRGBA(...ACTION_STYLE[action].rgb, 1);
            cr.moveTo(x - 2.5, y + 5.5);
            cr.lineTo(x + 2.5, y + 5.5);
            cr.stroke();
        } else if (action === 'off') {
            cr.arc(x, y + 0.6, 4.6, -Math.PI / 2 + 0.7, 1.5 * Math.PI - 0.7);
            cr.stroke();
            cr.moveTo(x, y - 5);
            cr.lineTo(x, y);
            cr.stroke();
        } else {
            cr.setLineWidth(1.1);
            cr.rectangle(x - 7.5, y - 2.5, 4, 4);
            cr.rectangle(x + 3.5, y - 2.5, 4, 4);
            cr.stroke();
            cr.rectangle(x - 2.5, y - 3.5, 5, 6);
            cr.fill();
        }
    }

    _startTime() {
        return dayTimes(new Date(), this._display.cfg, this._manager.globals).eveningStart;
    }

    // ---------------------------------------------------------- input
    _local(event) {
        const [sx, sy] = event.get_coords();
        const [, x, y] = this.transform_stage_point(sx, sy);
        return [x, y];
    }

    _valueAt(y) {
        const g = this._geometry();
        return Math.max(0, Math.min(1, 1 - (y - g.top) / g.ph));
    }

    _minutesAt(x) {
        const g = this._geometry();
        return Math.max(0, Math.min(GRAPH_SPAN, Math.round((x - g.left) / g.pw * GRAPH_SPAN / 5) * 5));
    }

    _hitPoint(x, y) {
        const g = this._geometry();
        let best = null, dist = HIT;
        for (const p of this._points(g)) {
            // the main points win over the small ones next to them
            const d = Math.hypot(p.x - x, p.y - y) - (p.kind === 'main' ? 4 : 0);
            if (d < dist) {
                dist = d;
                best = p;
            }
        }
        return best;
    }

    _setPoint(p, v) {
        const d = this._display;
        v = Math.round(v * 100) / 100;
        if (p.i === 0) {
            d.setConfig('day', v);
        } else if (p.i === 4) {
            d.setConfig(p.key, p.key === 'night' ? Math.min(v, d.cfg.day ?? 1) : v);
        } else {
            const own = [...d.cfg.points[p.key]];
            own[p.i < 4 ? p.i - 1 : p.i - 2] = v;
            d.setConfig('points', {...d.cfg.points, [p.key]: own});
        }
    }

    _resetPoint(p) {
        const d = this._display;
        if (p.kind !== 'small')
            return;
        const own = [...d.cfg.points[p.key]];
        own[p.i < 4 ? p.i - 1 : p.i - 2] = null;
        d.setConfig('points', {...d.cfg.points, [p.key]: own});
    }

    _setEvent(action, min) {
        const d = this._display;
        d.setConfig('events', {...d.cfg.events, [action]: min});
    }

    vfunc_button_press_event(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = this._local(event);
        const g = this._geometry();
        const lane = this._lane(g);
        const near = (a, r = HIT) => Math.hypot(a.x - x, a.y - y) < r;

        // the lane (inline: its buttons are on the graph; anything else goes to the curves)
        const laneHit = !lane.inline ||
            near(lane.plus) || lane.choices.some(c => near(c)) || lane.items.some(i => near(i)) ||
            (this._selected && lane.items.some(i => i.action === this._selected && Math.hypot(i.x + 10 - x, i.y - 10 - y) < 9));
        if (lane.inline && !laneHit && (this._choosing || this._selected)) {
            this._choosing = false;
            this._selected = null;
            this.queue_repaint();
        }
        if (laneHit && (lane.inline || y >= g.laneTop - 4)) {
            if (this._selected) {
                const it = lane.items.find(i => i.action === this._selected);
                if (it && Math.hypot(it.x + 10 - x, it.y - 10 - y) < 9) {
                    this._setEvent(it.action, null);
                    this._selected = null;
                    this.queue_repaint();
                    return Clutter.EVENT_STOP;
                }
            }
            const choice = lane.choices.find(c => near(c));
            if (choice) {
                // a new one goes an hour after the main point, or where there is room
                const d = this._display.cfg;
                let at = Math.min(GRAPH_SPAN, d.duration + 60);
                while (ACTIONS.some(a => d.events[a] !== null && Math.abs(d.events[a] - at) < 20) && at < GRAPH_SPAN)
                    at += 20;
                this._setEvent(choice.action, Math.min(at, GRAPH_SPAN));
                this._choosing = false;
                this.queue_repaint();
                return Clutter.EVENT_STOP;
            }
            if (near(lane.plus)) {
                this._choosing = !this._choosing && ACTIONS.some(a => this._display.cfg.events[a] === null);
                this._selected = null;
                this.queue_repaint();
                return Clutter.EVENT_STOP;
            }
            const it = lane.items.find(i => near(i));
            if (it) {
                this._drag = {what: 'event', action: it.action, x, y, moved: false};
                this._grab = global.stage.grab(this);
                return Clutter.EVENT_STOP;
            }
            this._choosing = false;
            this._selected = null;
            this.queue_repaint();
            return Clutter.EVENT_STOP;
        }

        // the curves
        const p = this._hitPoint(x, y);
        if (!p)
            return Clutter.EVENT_STOP;
        if (event.get_click_count?.() === 2) {
            this._resetPoint(p);
            this.queue_repaint();
            return Clutter.EVENT_STOP;
        }
        const cfg = this._display.cfg;
        this._drag = {what: 'point', key: p.key, i: p.i, x, y, axis: null, moved: false,
            offset: cfg.offset, start: cfg.start};
        this._grab = global.stage.grab(this);
        this.queue_repaint();
        return Clutter.EVENT_STOP;
    }

    vfunc_motion_event(event) {
        const dr = this._drag;
        if (!dr)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = this._local(event);
        if (!dr.moved && Math.hypot(x - dr.x, y - dr.y) < 4)
            return Clutter.EVENT_STOP;
        dr.moved = true;
        if (dr.what === 'event') {
            this._setEvent(dr.action, this._minutesAt(x));
        } else {
            // the main point also moves sideways (= duration), the start point too
            // (= when the evening starts, also before sunset); the others only up/down
            if (!dr.axis)
                dr.axis = (dr.i === 4 || dr.i === 0) && Math.abs(x - dr.x) > Math.abs(y - dr.y) ? 'x' : 'y';
            if (dr.axis === 'x' && dr.i === 0) {
                const g = this._geometry();
                const delta = Math.round((x - dr.x) / g.pw * GRAPH_SPAN / 5) * 5;
                if (this._settings.get_string('schedule-mode') === 'sun')
                    this._display.setConfig('offset', Math.max(-240, Math.min(240, dr.offset + delta)));
                else
                    this._display.setConfig('start', ((dr.start + delta) % 1440 + 1440) % 1440);
            } else if (dr.axis === 'x') {
                const min = this._minutesAt(x);
                this._display.setConfig('duration', Math.max(DURATION_MIN, Math.min(DURATION_MAX, min)));
            } else {
                this._setPoint({key: dr.key, i: dr.i}, this._valueAt(y));
            }
        }
        this.queue_repaint();
        return Clutter.EVENT_STOP;
    }

    vfunc_button_release_event() {
        const dr = this._drag;
        if (!dr)
            return Clutter.EVENT_PROPAGATE;
        // a click on a lane button: show its ×
        if (dr.what === 'event' && !dr.moved)
            this._selected = this._selected === dr.action ? null : dr.action;
        this._endDrag();
        return Clutter.EVENT_STOP;
    }

    _endDrag() {
        this._grab?.dismiss();
        this._grab = null;
        this._drag = null;
        this.queue_repaint();
    }

    vfunc_unmap() {
        if (this._drag)
            this._endDrag();
        this._choosing = false;
        this._selected = null;
        super.vfunc_unmap();
    }
});

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
        this.menuButtonAccessibleName = _('Automatic dimming and more');

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

        this._menuBuilt = false;
        // GNOME's Night Light: the bars in the graph and whether "Night light ×" can be changed
        this._color = new Gio.Settings({schema_id: COLOR_SCHEMA});
        const colorChanged = () => {
            if (this.menu.isOpen) {
                this._sync();
                this._graph?.queue_repaint();
            }
        };
        this._color.connectObject(
            'changed::night-light-enabled', colorChanged,
            'changed::night-light-schedule-automatic', colorChanged,
            'changed::night-light-schedule-from', colorChanged,
            'changed::night-light-schedule-to', colorChanged, this);
        settings.connectObject(
            'changed::red-enabled', colorChanged,
            'changed::red-follows-night-light', colorChanged, this);
        display.connectObject('changed', () => this._sync(), this);
        manager.connectObject(
            'schedule-changed', () => this._sync(),
            'off-changed', () => this._sync(), this);
        settings.connectObject(
            'changed::slider-label', () => this._syncLabel(),
            'changed::schedule-mode', () => this._sync(),
            'changed::menu-style', () => {
                this._sync();
                this._graph?.queue_repaint();
                if (this.menu.isOpen)
                    this._fitHeight();
            }, this);
        // the menu is built the first time it opens: nothing to pay for at login
        this.menu.setHeader('video-display-symbolic', display.name, '');
        this.menu.connect('open-state-changed', (m, open) => {
            if (open) {
                this._ensureMenu();
                this._sync();
                this._fitHeight(true);
            } else {
                this._tooltip.hide();
            }
        });

        this._syncLabel();
        this._sync();
        // build the menu when the desktop is idle, so opening it costs nothing
        this._buildId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this._buildId = 0;
            this._ensureMenu();
            return GLib.SOURCE_REMOVE;
        });
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

    _ensureMenu() {
        if (this._menuBuilt)
            return;
        this._menuBuilt = true;
        const d = this._display;
        // everything goes into a section inside a scroll view, so a long
        // menu scrolls instead of running off small screens (see _fitHeight)
        this._content = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._content);
        const box = this._content.actor;
        this.menu.box.remove_child(box);
        this._scroll = new St.ScrollView({
            style_class: 'bp-menu-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
        });
        if (this._scroll.set_child)
            this._scroll.set_child(box);
        else
            this._scroll.add_actor(box);
        this.menu.box.add_child(this._scroll);
        const m = this._content;
        const position = this._settings.get_string('buttons-position');
        const actions = this._actions();

        // next to the monitor name: the buttons (when placed there) and the settings
        const head = new St.BoxLayout({style_class: 'bp-header-actions', y_align: Clutter.ActorAlign.START,
            x_align: Clutter.ActorAlign.END});
        const roundButton = (icon, title, style, run) => {
            const btn = new St.Button({
                style_class: `bp-round icon-button ${style}`,
                child: new St.Icon({...icon, style_class: 'bp-round-icon'}),
                can_focus: true,
                accessible_name: title,
                track_hover: true,
            });
            btn.connect('notify::hover', () => (btn.hover ? this._tooltip.show(btn, btn, title) : this._tooltip.hide(btn)));
            btn.connect('clicked', run);
            head.add_child(btn);
            return btn;
        };
        if (position === 'header') {
            for (const a of actions)
                a.button = roundButton(a.icon, a.title, a.style, () => a.run());
        }
        roundButton({icon_name: 'emblem-system-symbolic'}, _('Settings'), 'bp-settings', () => {
            Main.panel.closeQuickSettings?.();
            Main.panel.statusArea.quickSettings?.menu.close();
            openPrefs?.();
        });
        if (this.menu.addHeaderSuffix) {
            this.menu.addHeaderSuffix(head);
            // the name takes the free width (and is cut with … when long), so
            // the buttons always sit in the top right corner, never over it
            const header = this.menu._header;
            if (header) {
                header.x_expand = true;
                header.x_align = Clutter.ActorAlign.FILL;
                // GNOME's empty spacer after the suffix would push the buttons off the corner
                for (const child of header.get_children()) {
                    if (child !== head && child.constructor === Clutter.Actor)
                        child.hide();
                }
            }
            head.x_expand = true;
            for (const label of [this.menu._headerTitle, this.menu._headerSubtitle]) {
                if (!label)
                    continue;
                label.x_expand = true;
                label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            }
        } else {
            addRow(m, head);
        }

        if (position === 'header' && actions.length) {
            this._buildOffBox(m);
        } else if (position === 'top') {
            this._addTiles(actions);
            m.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        // evening dimming
        this._scheduleSwitch = switchItem(_('Automatic dimming'), d.cfg.schedule);
        this._scheduleSwitch.add_style_class_name('bp-switch');
        this._scheduleSwitch.insert_child_at_index(
            new St.Icon({icon_name: MOON_ICON, style_class: 'popup-menu-icon bp-moon-icon'}), 0);
        const label = this._scheduleSwitch.label;
        this._scheduleSwitch.insert_child_above(infoButton(this._tooltip,
            `${_('Slowly dims this monitor in the evening, and brings it back in the morning.')}\n${
                _('Drag the points to shape the evening; the big point also sets how long it takes. + adds a button that runs by itself.')}`), label);
        label.x_expand = false;
        this._scheduleSwitch.insert_child_above(new St.Widget({x_expand: true}), label.get_next_sibling());
        this._scheduleSwitch.connect('toggled', (item, state) => {
            // without the evening, extra dimming would darken the screen all day: off with it
            if (!state)
                d.setConfig('extra', 0);
            d.setConfig('schedule', state);
        });
        m.addMenuItem(this._scheduleSwitch);

        this._start = new StepperRow(_('Start'));
        this._start.minus.connect('clicked', () => this._step(-1));
        this._start.plus.connect('clicked', () => this._step(1));
        addRow(m, this._start);

        this._duration = new StepperRow(_('Duration'));
        this._duration.minus.accessible_name = _('Shorter');
        this._duration.plus.accessible_name = _('Longer');
        this._duration.minus.connect('clicked', () => this._stepDuration(-1));
        this._duration.plus.connect('clicked', () => this._stepDuration(1));
        addRow(m, this._duration);

        this._graph = new EveningGraph(d, this._manager, this._settings, this._color);
        this._graphRow = addRow(m, new St.Bin({style_class: 'bp-row bp-graph-row', child: this._graph, x_expand: true}));
        this._buildPicker(m);

        // in the morning: lowest light / turned off screens back to normal
        this._morningSwitch = switchItem(_('Back to normal in the morning'), d.cfg.morningReset);
        this._morningSwitch.add_style_class_name('bp-switch bp-morning-switch');
        const mlabel = this._morningSwitch.label;
        this._morningSwitch.insert_child_above(infoButton(this._tooltip,
            _('When the morning comes, lowest light and turned off screens go back to normal, whether they were switched on by hand or by the graph.')), mlabel);
        mlabel.x_expand = false;
        this._morningSwitch.insert_child_above(new St.Widget({x_expand: true}), mlabel.get_next_sibling());
        this._morningSwitch.connect('toggled', (item, state) => d.setConfig('morningReset', state));
        m.addMenuItem(this._morningSwitch);

        // day / night brightness, extra dimming
        this._layers = {};
        const addLayer = (layer, value, onChange) => {
            const row = new LayerRow(layer, value);
            if (layer.info)
                row.head.add_child(infoButton(this._tooltip, layer.info()));
            const set = bindSlider(row.slider, onChange);
            this._layers[layer.key] = {row, set};
            m.addMenuItem(row);
        };
        for (const layer of LAYERS) {
            addLayer(layer, d.cfg[layer.key] ?? d.value, v => {
                v = Math.round(v * 100) / 100;
                if (layer === NIGHT)
                    v = Math.min(v, d.cfg.day ?? 1);
                d.setConfig(layer.key, v);
            });
        }
        // a reset next to every slider, shown only while it is changed
        this._resets = [];
        this._resetFor = {};
        const addReset = (row, text, shown, reset) => {
            const button = resetButton(this._tooltip, text, shown, reset);
            row.add_child(button);
            this._resets.push(button);
            this._resetFor[row.layer.key] = {text, shown, reset};
        };
        addReset(this._layers.day.row, _('Back to 100 %'),
            () => (d.cfg.day ?? d.value) < 0.995, () => d.setConfig('day', 1));
        const mgr = this._manager;
        addReset(this._layers.night.row, _('Back to the default evening curve'),
            () => !mgr.isDefault(d, 'night'), () => mgr.resetLayer(d, 'night'));
        addReset(this._layers.extra.row, _('Back to the default evening curve'),
            () => !mgr.isDefault(d, 'extra'), () => mgr.resetLayer(d, 'extra'));

        // this monitor's share of Night Light and red screen
        this._multSep = new PopupMenu.PopupSeparatorMenuItem();
        m.addMenuItem(this._multSep);
        for (const layer of MULTIPLIERS) {
            addLayer(layer, d.cfg[layer.key] / MULT_MAX, v => {
                // snap to ×1 near the middle: the usual value is easy to find again
                let k = Math.round(v * MULT_MAX * 10) / 10;
                if (Math.abs(k - 1) < 0.06)
                    k = 1;
                d.setConfig(layer.key, k);
            });
        }
        // Night Light: ×1 and GNOME's own time again (the orange bar in the graph)
        addReset(this._layers.nightLight.row, _('Back to the default: ×1 and GNOME’s automatic time (sunset)'),
            () => !mgr.isDefault(d, 'nightLight') || !this._color.get_boolean('night-light-schedule-automatic'), () => {
                this._color.set_boolean('night-light-schedule-automatic', true);
                mgr.resetLayer(d, 'nightLight');
            });
        addReset(this._layers.redLight.row, _('Back to ×1'),
            () => d.cfg.redLight !== 1, () => d.setConfig('redLight', 1));

        if (position === 'bottom') {
            m.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this._addTiles(actions);
        }
        this._actionList = actions;
    }

    /*
     * The simple menu: one small pill per value (its name and value), and
     * one slider for the pill that is chosen. Uses the same rows' setters
     * and resets as the detailed menu (built below, hidden in this style).
     */
    _buildPicker(m) {
        const box = new St.BoxLayout({style_class: 'bp-pills', x_expand: true});
        this._pick = {box, key: 'night', pills: {}};
        const keys = [[DAY, _('Day')], [NIGHT, _('Night')], [EXTRA, _('Extra')],
            [MULTIPLIERS[0], _('Warmth')], [MULTIPLIERS[1], _('Red')]];
        for (const [layer, name] of keys) {
            const inner = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
            const head = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER});
            head.add_child(new St.Widget({style_class: 'bp-layer-dot', y_align: Clutter.ActorAlign.CENTER}));
            head.add_child(new St.Label({text: name, style_class: 'bp-pill-label', y_align: Clutter.ActorAlign.CENTER}));
            inner.add_child(head);
            const value = new St.Label({style_class: 'bp-pill-value', x_align: Clutter.ActorAlign.CENTER});
            inner.add_child(value);
            const pill = new St.Button({style_class: `bp-pill ${layer.style}`, child: inner, x_expand: true,
                can_focus: true, toggle_mode: false, accessible_name: layer.title()});
            pill.connect('clicked', () => {
                this._pick.key = layer.key;
                this._sync();
            });
            if (layer.info) {
                pill.track_hover = true;
                pill.connect('notify::hover', () => (pill.hover
                    ? this._tooltip.show(pill, pill, layer.info(), true) : this._tooltip.hide(pill)));
            }
            box.add_child(pill);
            this._pick.pills[layer.key] = {pill, value, layer};
        }
        this._pickRow = addRow(m, new St.Bin({style_class: 'bp-row bp-pills-row', child: box, x_expand: true}));

        // the one slider, with its value and reset
        const row = new PopupMenu.PopupBaseMenuItem({activate: false, style_class: 'bp-layer bp-pick-slider'});
        const slider = new Slider(0);
        slider.x_expand = true;
        row.add_child(slider);
        const value = new St.Label({style_class: 'bp-layer-value', y_align: Clutter.ActorAlign.CENTER});
        row.add_child(value);
        const reset = resetButton(this._tooltip, _('Back to the default'),
            () => this._resetFor?.[this._pick.key]?.shown() ?? false,
            () => this._resetFor?.[this._pick.key]?.reset());
        row.add_child(reset);
        row.vfunc_navigate_focus = (from, direction) => slider.navigate_focus(from, direction, false);
        // moves the chosen value through its detailed row's slider (same rounding, snapping, limits)
        this._pick.set = bindSlider(slider, v => {
            const target = this._layers[this._pick.key]?.row.slider;
            if (target)
                target.value = v;
        });
        this._pick.row = row;
        this._pick.slider = slider;
        this._pick.valueLabel = value;
        this._pick.reset = reset;
        m.addMenuItem(row);
    }

    _syncPicker(simple, on) {
        const p = this._pick;
        if (!p)
            return;
        this._pickRow.visible = simple;
        p.row.visible = simple;
        if (!simple)
            return;
        const nightOn = this._color.get_boolean('night-light-enabled');
        const redOn = this._settings.get_boolean('red-enabled');
        const shown = {day: on, night: on, extra: true, nightLight: true, redLight: redOn};
        if (!shown[p.key])
            p.key = on ? 'night' : 'extra';
        for (const [key, {pill, value}] of Object.entries(p.pills)) {
            pill.visible = shown[key];
            const row = this._layers[key]?.row;
            value.text = row?.value.text ?? '';
            pill[key === p.key ? 'add_style_pseudo_class' : 'remove_style_pseudo_class']('checked');
            const enabled = key === 'nightLight' ? nightOn : key === 'redLight' ? redOn : true;
            pill[enabled ? 'remove_style_class_name' : 'add_style_class_name']('bp-pill-disabled');
        }
        const row = this._layers[p.key]?.row;
        const layer = p.pills[p.key].layer;
        if (!row)
            return;
        // the slider takes the chosen value's colour
        for (const style of ['bp-c-bright', 'bp-c-extra', 'bp-c-warm', 'bp-c-red'])
            p.row.remove_style_class_name(style);
        p.row.add_style_class_name(layer.style);
        p.set(row.slider.value);
        p.slider.reactive = row.slider.reactive;
        p.row[row.slider.reactive ? 'remove_style_class_name' : 'add_style_class_name']('bp-layer-disabled');
        p.valueLabel.text = row.value.text;
        p.reset.sync();
    }

    /*
     * Make the menu fit on the screen: Quick Settings opens at the top of
     * its monitor and grows down; whatever does not fit below scrolls.
     * Measured each time the menu opens, so it is right for any screen
     * size, scale, number of monitors and Quick Settings items.
     */
    _fitHeight(opening = false) {
        if (!this._scroll)
            return;
        const qs = Main.panel.statusArea.quickSettings;
        const monitor = Main.layoutManager.findMonitorForActor(qs.menu.actor) ?? Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const work = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const qsBox = qs.menu.box;
        const width = qsBox.width || -1;
        // Quick Settings without this submenu: measured as the submenu opens
        // (it is not laid out yet then), kept for the refits while it is open
        if (opening || this._qsOthers === undefined)
            this._qsOthers = qsBox.get_preferred_height(width)[1];
        // the submenu around our scroll view: its header, paddings and spacing
        const menu = this.menu;
        const pad = a => (a ? a.get_theme_node().get_vertical_padding() + a.get_theme_node().get_border_width(St.Side.TOP) * 2 : 0);
        const header = menu._header?.get_preferred_height(width)[1] ?? 64;
        const chrome = header + pad(menu.actor) + pad(menu.box) + 24;
        const [, top] = qsBox.get_transformed_position();
        const bottom = work.y + work.height - 16;               // a little room below
        const room = Math.max(160, bottom - Math.max(top, work.y) - this._qsOthers - chrome);
        const [, contentNatural] = this._content.actor.get_preferred_height(this._scroll.width || width);
        this._scroll.height = Math.min(contentNatural, room);
    }

    /*
     * Under "Turn off screen", only while this screen is off: whether it
     * stays lit a while after the mouse leaves, and how dark it is.
     * Every monitor keeps its own values.
     */
    _buildOffBox(m) {
        const d = this._display;
        const sec = new PopupMenu.PopupMenuSection();
        sec.actor.add_style_class_name('bp-off-box');
        m.addMenuItem(sec);
        this._off = {sec};
        const icon = gicon => new St.Icon({
            ...typeof gicon === 'string' ? {icon_name: gicon} : {gicon},
            style_class: 'bp-off-icon', y_align: Clutter.ActorAlign.CENTER,
        });

        // "⏻ While the screen is off": says what these belong to
        const head = new St.BoxLayout({style_class: 'bp-row bp-off-head'});
        head.add_child(icon('system-shutdown-symbolic'));
        head.add_child(new St.Label({text: _('While the screen is off'), style_class: 'bp-off-title', y_align: Clutter.ActorAlign.CENTER}));
        sec.box.add_child(head);

        const keep = switchItem('', false);
        keep.add_style_class_name('bp-switch bp-off-row');
        keep.insert_child_at_index(icon('preferences-system-time-symbolic'), 0);
        const kl = keep.label;
        this._off.keepInfo = infoButton(this._tooltip, '');
        keep.insert_child_above(this._off.keepInfo, kl);
        kl.x_expand = false;
        keep.insert_child_above(new St.Widget({x_expand: true}), kl.get_next_sibling());
        // on: after the mouse leaves, lit for the seconds, then dark; off: dark at once
        keep.connect('toggled', (item, on) => {
            d.setConfig('keepLit', on);
            if (!on)
                this._manager.endKeepLit(d);
        });
        sec.addMenuItem(keep);
        this._off.keep = keep;

        // icon title (i) value, and the slider under it: long titles never squeeze it
        const slider = (key, gicon, title, info, toValue, fromValue) => {
            const row = new LabelRow(title);
            row.add_style_class_name('bp-off-row');
            row.insert_child_at_index(icon(gicon), 0);
            row.extra.add_child(infoButton(this._tooltip, info));
            row.value.add_style_class_name('bp-off-value');
            sec.box.add_child(row);
            const srow = new SliderRow(fromValue(key()), 'bp-c-off bp-off-slider');
            // while it moves, show the value on that screen for a moment
            const set = bindSlider(srow.slider, v => {
                d.setConfig(this._manager.offDarkKey(d), toValue(v));
                this._manager.previewOff(d);
            });
            sec.addMenuItem(srow);
            return {row, set, fromValue};
        };
        // the monitor stays at its lowest light while off; this is the black on top: 25 % … 100 %
        const span = 1 - OFF_DARK_MIN;
        // turned off by hand and by the evening's buttons keep their own value
        this._off.dark = slider(() => this._manager.offDarkOf(d), ownIcon('bp-dark'), _('Dark while off'),
            _('While the screen is off, the monitor stays at its lowest light and this much black is added on top. 25 % = a little darker, 100 % = fully black.'),
            v => Math.round((OFF_DARK_MIN + v * span) * 100) / 100, k => (k - OFF_DARK_MIN) / span);
        const offDefault = () => (d.cfg.offAuto ? OFF_DARK_MIN : 1);
        this._off.reset = resetButton(this._tooltip, _('Back to the default'),
            () => Math.abs(this._manager.offDarkOf(d) - offDefault()) > 0.005, () => {
                d.setConfig(this._manager.offDarkKey(d), offDefault());
                this._manager.previewOff(d);
            });
        this._off.dark.row.add_child(this._off.reset);
    }

    _syncOffBox() {
        const o = this._off;
        if (!o)
            return;
        const d = this._display;
        o.sec.actor.visible = d.off;
        if (!d.off)
            return;
        const secs = formatSeconds(this._settings.get_int('keep-lit-seconds'));
        o.keep.label.text = fmt(_('Keep lit for %s'), secs);
        o.keepInfo.accessible_name = fmt(_('On: after the mouse leaves, the screen stays lit for %s, then goes dark. Off: it goes dark as soon as the mouse leaves.'), secs);
        o.keep.setToggleState(d.cfg.keepLit);
        const dark = this._manager.offDarkOf(d);
        o.dark.set(o.dark.fromValue(dark));
        o.dark.row.value.text = pct(dark);
        o.reset.sync();
    }

    // lowest light, turn off, turn off others (the ones switched on in the preferences)
    _actions() {
        const d = this._display;
        const s = this._settings;
        const closeMenu = () => {
            Main.panel.closeQuickSettings?.();
            Main.panel.statusArea.quickSettings?.menu.close();
        };
        const all = [
            {key: 'show-lowest-button', title: _('Lowest light'), style: 'bp-tile-lowest',
                icon: {gicon: ownIcon('bp-lowest-light')}, checked: () => d.minimum,
                run: () => this._manager.setMinimum(d, !d.minimum)},
            {key: 'show-off-button', title: _('Turn off screen'), style: 'bp-tile-off',
                icon: {icon_name: 'system-shutdown-symbolic'}, checked: () => d.off,
                run: () => {
                    // pressed again (from a peek at the dark screen): back on
                    if (d.off) {
                        this._manager.wake(d.index);
                        return;
                    }
                    closeMenu();
                    this._manager.turnOff(d, true, false, true);     // by hand: kept over a restart
                }},
            {key: 'show-others-button', title: _('Turn off other screens'), style: 'bp-tile-others',
                icon: {gicon: ownIcon('bp-others-off')}, checked: () => this._manager.othersOff(d),
                run: () => {
                    const turningOff = !this._manager.othersOff(d);
                    if (turningOff)
                        closeMenu();
                    this._manager.toggleOthers(d);
                }},
        ];
        return all.filter(a => s.get_boolean(a.key));
    }

    _addTiles(actions) {
        if (!actions.length)
            return;
        const tiles = new St.BoxLayout({style_class: 'bp-row bp-tiles'});
        tiles.layout_manager.homogeneous = true;      // same width whatever the language
        for (const a of actions) {
            a.button = tileButton(a.icon.gicon ?? a.icon.icon_name, a.title, a.style);
            a.button.connect('clicked', () => a.run());
            tiles.add_child(a.button);
        }
        addRow(this._content, tiles);
        this._buildOffBox(this._content);
    }

    _step(dir) {
        const d = this._display;
        if (this._settings.get_string('schedule-mode') === 'sun')
            d.setConfig('offset', Math.max(-240, Math.min(240, d.cfg.offset + dir * 5)));
        else
            d.setConfig('start', (d.cfg.start + dir * 15 + 1440) % 1440);
    }

    _stepDuration(dir) {
        const d = this._display;
        const next = Math.round((d.cfg.duration + dir * DURATION_STEP) / DURATION_STEP) * DURATION_STEP;
        d.setConfig('duration', Math.max(DURATION_MIN, Math.min(DURATION_MAX, next)));
    }

    _sync() {
        const d = this._display;
        const g = this._manager.globals;
        this._setSlider(d.value);
        this.slider.reactive = d.ready;
        this._moonButton?.[d.cfg.schedule ? 'add_style_class_name' : 'remove_style_class_name']('bp-active');
        if (d.off || d.minimum)
            this.add_style_class_name('bp-off');
        else
            this.remove_style_class_name('bp-off');

        if (!this.menu.isOpen || !this._menuBuilt)
            return;
        let sub = fmt(_('Brightness %s'), pct(d.value));
        if (d.off)
            sub = _('Turned off');
        else if (d.minimum)
            sub = _('Lowest light');
        this.menu.setHeader('video-display-symbolic', d.name, sub);
        this._scheduleSwitch.setToggleState(d.cfg.schedule);

        const on = d.cfg.schedule;
        const simple = this._settings.get_string('menu-style') !== 'detailed';
        this._start.visible = on && !simple;
        this._duration.visible = on && !simple;
        this._graphRow.visible = on;
        this._morningSwitch.visible = on && !simple;
        this._multSep.visible = !simple;
        this._morningSwitch.setToggleState(d.cfg.morningReset);
        if (on) {
            const times = dayTimes(new Date(), d.cfg, g);
            this._start.value.text = formatMinutes(minutesOfDay(new Date(times.eveningStart)));
            if (g.mode === 'sun' && times.sunset) {
                const offset = d.cfg.offset;
                const sign = offset < 0 ? '−' : '+';
                this._start.sub.text = fmt(_('Sunset %s %s %d min'),
                    formatMinutes(minutesOfDay(times.sunset)), sign, Math.abs(offset));
            } else {
                this._start.sub.text = _('Fixed time');
            }
            this._duration.value.text = formatDuration(d.cfg.duration);
            this._duration.sub.text = fmt(_('Until %s'), formatMinutes(minutesOfDay(new Date(times.eveningEnd))));
            this._graph.queue_repaint();
        }
        for (const layer of LAYERS) {
            const {row, set} = this._layers[layer.key];
            row.visible = (!layer.evening || on) && !simple;
            const v = d.cfg[layer.key] ?? d.value;
            set(v);
            const off = layer === EXTRA && v < 0.005;
            row.value.text = off ? _('Off') : pct(v);
            row[off ? 'add_style_class_name' : 'remove_style_class_name']('bp-layer-off');
        }
        // only adjustable while that is on in GNOME / the Night Light menu: grey otherwise
        const nightOn = this._color.get_boolean('night-light-enabled');
        const redOn = this._settings.get_boolean('red-enabled');
        for (const layer of MULTIPLIERS) {
            const {row, set} = this._layers[layer.key];
            const k = d.cfg[layer.key];
            set(k / MULT_MAX);
            row.value.text = mult(k);
            row[k === 0 ? 'add_style_class_name' : 'remove_style_class_name']('bp-layer-off');
            const enabled = layer.key === 'nightLight' ? nightOn : redOn;
            row.visible = !simple;
            row.slider.reactive = enabled;
            row.slider.can_focus = enabled;
            row[enabled ? 'remove_style_class_name' : 'add_style_class_name']('bp-layer-disabled');
        }
        for (const a of this._actionList)
            a.button.checked = a.checked();
        this._resets.forEach(b => b.sync());
        this._syncPicker(simple, on);
        this._syncOffBox();
        // rows came or went: fit again (once the layout has settled)
        if (!this._fitId) {
            this._fitId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
                this._fitId = 0;
                if (this.menu.isOpen)
                    this._fitHeight();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    destroy() {
        if (this._buildId)
            GLib.source_remove(this._buildId);
        if (this._fitId)
            GLib.source_remove(this._fitId);
        this._tooltip.hide();
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
    _init(settings, state, shellGettext, tooltip) {
        super._init({
            title: shellGettext('Night Light'),
            iconName: 'night-light-symbolic',
            toggleMode: true,
        });
        this._settings = settings;
        this._state = state;
        this._tooltip = tooltip;
        this.add_style_class_name('bp-night-light');

        global.backend.get_monitor_manager().bind_property('night-light-supported',
            this, 'visible', GObject.BindingFlags.SYNC_CREATE);

        this._color = new Gio.Settings({schema_id: COLOR_SCHEMA});
        this._color.bind('night-light-enabled', this, 'checked', Gio.SettingsBindFlags.DEFAULT);

        const m = this.menu;
        m.setHeader('night-light-symbolic', shellGettext('Night Light'), '');

        this._tempLabel = new LabelRow(_('Temperature'));
        this._tempLabel.extra.add_child(infoButton(tooltip,
            _('Blue light in the evening holds back melatonin, the sleep hormone. A warmer screen helps you fall asleep more easily.')));
        this._tempReset = resetButton(tooltip, _('Back to GNOME’s default'),
            () => this._color.get_user_value('night-light-temperature') !== null,
            () => this._color.reset('night-light-temperature'));
        this._tempLabel.add_child(this._tempReset);
        addRow(m, this._tempLabel);
        this._temp = new SliderRow(this._tempToValue(), 'bp-temp');
        this._setTemp = bindSlider(this._temp.slider, v => this._writeTemp(v));
        m.addMenuItem(this._temp);

        m.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._red = switchItem(_('Red screen'), settings.get_boolean('red-enabled'));
        this._red.add_style_class_name('bp-switch bp-red-switch');
        this._red.insert_child_at_index(new St.Widget({style_class: 'bp-red-dot', y_align: Clutter.ActorAlign.CENTER}), 0);
        const label = this._red.label;
        this._red.insert_child_above(infoButton(tooltip,
            _('Red light disturbs melatonin and your body clock the least of all colours. Ideal for the last hours before bed.')), label);
        label.x_expand = false;
        this._red.insert_child_above(new St.Widget({x_expand: true}), label.get_next_sibling());
        this._red.connect('toggled', (item, on) => settings.set_boolean('red-enabled', on));
        m.addMenuItem(this._red);

        this._redHint = new LabelRow('');
        this._redHint.add_style_class_name('bp-hint');
        addRow(m, this._redHint);

        // adjustable while off too: it starts with this strength
        this._strengthLabel = new LabelRow(_('Strength'));
        this._strengthLabel.value.add_style_class_name('bp-red-value');
        this._strengthReset = resetButton(tooltip, _('Back to the default'),
            () => settings.get_user_value('red-strength') !== null,
            () => settings.reset('red-strength'));
        this._strengthLabel.add_child(this._strengthReset);
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
        m.connect('open-state-changed', (menu, open) => {
            if (!open)
                tooltip.hide();
        });
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
        this._tempReset.sync();
        this._strengthReset.sync();
        for (const a of [this._strengthLabel, this._strength]) {
            if (red)
                a.remove_style_class_name('bp-dim');
            else
                a.add_style_class_name('bp-dim');
        }

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
        this._tooltip.hide();
        this.menu.destroy();
        super.destroy();
    }
});
