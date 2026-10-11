// The small dot in a corner of a turned off screen: click it for the
// screen's little menu, drag it to another corner (remembered per monitor).
// Only the dot itself takes the mouse; the rest of the screen stays free.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const MARGIN = 10;

export class CornerDots {
    constructor(manager, settings, overlays) {
        this._manager = manager;
        this._settings = settings;
        this._overlays = overlays;
        this._dots = new Map();       // monitor index -> {actor, drag, display}: one dot per monitor at most
        this._settingsId = settings.connect('changed::show-dot', () => this._manager.displays.forEach(d => this.sync(d)));
    }

    _corners() {
        try {
            return JSON.parse(this._settings.get_string('dot-corners')) || {};
        } catch {
            return {};
        }
    }

    _place(d, actor) {
        const m = Main.layoutManager.monitors[d.index];
        if (!m)
            return;
        const corner = this._corners()[d.id] ?? 'tr';
        const size = actor.width || 18;
        const x = corner.endsWith('r') ? m.x + m.width - MARGIN - size : m.x + MARGIN;
        const y = corner.startsWith('b') ? m.y + m.height - MARGIN - size : m.y + MARGIN;
        actor.set_position(x, y);
    }

    /** Show the dot while `d` is turned off. */
    sync(d) {
        const want = d.off && this._settings.get_boolean('show-dot');
        let dot = this._dots.get(d.index);
        // a dot of an older display object on this monitor: it is ours now
        if (dot && dot.display !== d) {
            if (!want) {
                this._remove(d.index);
                return;
            }
            dot.display = d;
            this._place(d, dot.actor);
            return;
        }
        if (want && !dot) {
            const actor = new St.Button({
                style_class: 'bp-dot',
                child: new St.Widget({style_class: 'bp-dot-core', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER}),
                reactive: true,
                track_hover: true,
                accessible_name: _('Screen menu'),
            });
            dot = {actor, drag: null, display: d};
            this._dots.set(d.index, dot);
            Main.layoutManager.uiGroup.add_child(actor);
            this._overlays.keepAbove(actor);
            this._place(d, actor);
            actor.connect('notify::width', () => this._place(d, actor));
            actor.connect('button-press-event', (a, event) => {
                const [x, y] = event.get_coords();
                dot.drag = {x, y, ax: actor.x, ay: actor.y, moved: false, grab: global.stage.grab(actor)};
                return Clutter.EVENT_STOP;
            });
            actor.connect('motion-event', (a, event) => {
                if (!dot.drag)
                    return Clutter.EVENT_PROPAGATE;
                const [x, y] = event.get_coords();
                if (Math.hypot(x - dot.drag.x, y - dot.drag.y) > 4)
                    dot.drag.moved = true;
                if (dot.drag.moved)
                    actor.set_position(dot.drag.ax + x - dot.drag.x, dot.drag.ay + y - dot.drag.y);
                return Clutter.EVENT_STOP;
            });
            actor.connect('button-release-event', (a, event) => {
                const drag = dot.drag;
                if (!drag)
                    return Clutter.EVENT_PROPAGATE;
                drag.grab?.dismiss();
                dot.drag = null;
                const [x, y] = event.get_coords();
                if (drag.moved) {
                    // to the nearest corner of this monitor
                    const m = Main.layoutManager.monitors[d.index];
                    const corner = `${y < m.y + m.height / 2 ? 't' : 'b'}${x < m.x + m.width / 2 ? 'l' : 'r'}`;
                    this._settings.set_string('dot-corners', JSON.stringify({...this._corners(), [dot.display.id]: corner}));
                    this._place(dot.display, actor);
                } else {
                    this._manager.openMenu(dot.display, x, y);
                }
                return Clutter.EVENT_STOP;
            });
        } else if (!want && dot) {
            this._remove(d.index);
        }
    }

    _remove(index) {
        const dot = this._dots.get(index);
        if (!dot)
            return;
        dot.drag?.grab?.dismiss();
        dot.actor.destroy();
        this._dots.delete(index);
    }

    destroy() {
        this._settings.disconnect(this._settingsId);
        for (const dot of this._dots.values()) {
            dot.drag?.grab?.dismiss();
            dot.actor.destroy();
        }
        this._dots.clear();
    }
}
