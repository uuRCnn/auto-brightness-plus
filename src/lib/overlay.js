// Software dimming: one black, see-through actor per monitor on top of
// everything. Darkening with a black layer of opacity a gives exactly
// colour * (1 - a), like a backlight. Hidden (zero cost) when not needed.
//
// The layers never take the mouse: clicks, typing and scrolling always go
// to the apps under them, even on a turned off screen.

import Clutter from 'gi://Clutter';
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
    constructor() {
        this._layers = [];
        this._above = new Set();      // actors that must stay above the layers
        this._raiseId = Main.layoutManager.uiGroup.connect('child-added', () => this._raise());
        this.rebuild();
    }

    rebuild() {
        this._layers.forEach(l => l.destroy());
        this._layers = Main.layoutManager.monitors.map((m, i) => new MonitorLayer(i));
    }

    // menus and dialogs add themselves on top; stay above them
    _raise() {
        const group = Main.layoutManager.uiGroup;
        for (const layer of this._layers) {
            if (layer.actor.visible && group.get_last_child() !== layer.actor)
                group.set_child_above_sibling(layer.actor, null);
        }
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
        layer.set(alpha, opts);
        if (alpha > 0)
            this._raise();
    }

    destroy() {
        Main.layoutManager.uiGroup.disconnect(this._raiseId);
        this._layers.forEach(l => l.destroy());
        this._layers = [];
    }
}
