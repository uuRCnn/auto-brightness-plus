// Software dimming: one black, see-through actor per monitor on top of
// everything. Darkening with a black layer of opacity a gives exactly
// colour * (1 - a), like a backlight. Hidden (zero cost) when not needed.
//
// The layers never take the mouse: clicks, typing and scrolling always go
// to the apps under them, even on a turned off screen.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const FADE_MS = 350;
const PEEK_FADE_MS = 160;
const SLOW_FADE_MS = 1500;      // going dark: longer than a DDC write takes

class MonitorLayer {
    constructor(index) {
        this._index = index;
        this._alpha = 0;
        this.actor = new St.Widget({
            name: `auto-brightness-plus-dim-${index}`,
            style: 'background-color: black;',
            reactive: false,
            visible: false,
            opacity: 0,
        });
        Main.layoutManager.uiGroup.add_child(this.actor);
        this.place();
    }

    place() {
        const m = Main.layoutManager.monitors[this._index];
        if (!m)
            return;
        this.actor.set_position(m.x, m.y);
        this.actor.set_size(m.width, m.height);
    }

    /**
     * @param {number} alpha 0..1
     * @param {object} opts animate: fade; fast: short fade (peeking); slow: long fade;
     *   duration: a fade of exactly that many ms
     */
    set(alpha, {animate = false, fast = false, slow = false, duration = 0} = {}) {
        alpha = Math.min(1, Math.max(0, alpha));
        if (alpha === this._alpha && !animate)
            return;
        this._alpha = alpha;
        const opacity = Math.round(alpha * 255);
        this.actor.remove_all_transitions();
        if (opacity > 0)
            this.actor.show();
        if (animate) {
            this.actor.ease({
                opacity,
                duration: duration || (fast ? PEEK_FADE_MS : slow ? SLOW_FADE_MS : FADE_MS),
                mode: duration ? Clutter.AnimationMode.EASE_IN_OUT_QUAD : Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => {
                    if (this._alpha === 0)
                        this.actor.hide();
                },
            });
        } else {
            this.actor.opacity = opacity;
            if (opacity === 0)
                this.actor.hide();
        }
    }

    destroy() {
        this.actor.destroy();
    }
}

export class DimOverlays {
    constructor(log = () => {}) {
        this._log = log;
        this._layers = [];
        this._above = new Set();      // actors that must stay above the layers
        // menus and dialogs add themselves on top: stay above them, once per main
        // loop turn and only while a layer is shown (a dock adding its labels
        // must not cause any restacking)
        this._raiseIdle = 0;
        this._raiseId = Main.layoutManager.uiGroup.connect('child-added', () => {
            if (this._raiseIdle || !this._layers.some(l => l.actor.visible))
                return;
            this._raiseIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._raiseIdle = 0;
                this._raise();
                return GLib.SOURCE_REMOVE;
            });
        });
        this.rebuild();
    }

    rebuild() {
        this._layers.forEach(l => l.destroy());
        this._layers = Main.layoutManager.monitors.map((m, i) => new MonitorLayer(i));
    }

    // menus and dialogs add themselves on top; stay above them
    _raise() {
        const group = Main.layoutManager.uiGroup;
        // already on top (only our own actors above the shown layers): nothing to do
        const ours = new Set([...this._layers.map(l => l.actor), ...this._above]);
        const children = group.get_children();
        let i = children.length - 1;
        while (i >= 0 && ours.has(children[i]))
            i--;
        const shown = this._layers.filter(l => l.actor.visible);
        const top = Math.max(-1, ...shown.map(l => children.indexOf(l.actor)));
        const above = [...this._above].filter(a => a.get_parent() === group);
        if (shown.every(l => children.indexOf(l.actor) > i) && above.every(a => children.indexOf(a) > top))
            return;
        this._log(`restack: ${shown.map(l => l._index).join(',')} above ${children[i]?.name || children[i]?.constructor?.name || '?'}`);
        for (const layer of shown)
            group.set_child_above_sibling(layer.actor, null);
        for (const actor of this._above) {
            if (actor.get_parent() === group)
                group.set_child_above_sibling(actor, null);
        }
    }

    /** Keep `actor` (a uiGroup child) above the layers until it is destroyed. */
    keepAbove(actor) {
        this._above.add(actor);
        actor.connect('destroy', () => this._above.delete(actor));
        this._raise();
    }

    /** The layer's alpha (its target while fading). */
    alpha(index) {
        return this._layers[index]?._alpha ?? 0;
    }

    set(index, alpha, opts) {
        const layer = this._layers[index];
        if (!layer)
            return;
        if (Math.abs(layer._alpha - Math.min(1, Math.max(0, alpha))) > 0.001)
            this._log(`layer ${index}: ${layer._alpha.toFixed(2)} -> ${alpha.toFixed(2)}`);
        layer.set(alpha, opts);
        if (alpha > 0)
            this._raise();
    }

    destroy() {
        Main.layoutManager.uiGroup.disconnect(this._raiseId);
        if (this._raiseIdle)
            GLib.source_remove(this._raiseIdle);
        this._layers.forEach(l => l.destroy());
        this._layers = [];
    }
}
