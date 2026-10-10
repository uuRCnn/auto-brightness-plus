// Software dimming: one black, see-through actor per monitor on top of
// everything. Darkening with a black layer of opacity a gives exactly
// colour * (1 - a), like a backlight. Hidden (zero cost) when not needed.
//
// A turned off screen makes its layer reactive, so moving the mouse onto
// it can wake it up without any polling.

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const FADE_MS = 350;

class MonitorLayer {
    constructor(index, onWake) {
        this._index = index;
        this._onWake = onWake;
        this._alpha = 0;
        this._wake = false;
        this._tracked = false;
        this.actor = new St.Widget({
            name: `brightness-plus-dim-${index}`,
            style: 'background-color: black;',
            reactive: false,
            visible: false,
            opacity: 0,
        });
        this.actor.connect('enter-event', () => {
            if (this._wake)
                this._onWake(this._index);
            return Clutter.EVENT_PROPAGATE;
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

    /** alpha 0..1, wake: react to the pointer */
    set(alpha, {wake = false, animate = false} = {}) {
        alpha = Math.min(1, Math.max(0, alpha));
        this._wake = wake;
        this.actor.reactive = wake;
        this._syncInputRegion(wake);
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
                duration: FADE_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
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

    // X11 sessions only send events to actors inside the input region
    _syncInputRegion(wake) {
        if (Meta.is_wayland_compositor?.() !== false || wake === this._tracked)
            return;
        this._tracked = wake;
        if (wake)
            Main.layoutManager.trackChrome(this.actor, {affectsInputRegion: true});
        else
            Main.layoutManager.untrackChrome(this.actor);
    }

    destroy() {
        if (this._tracked)
            Main.layoutManager.untrackChrome(this.actor);
        this.actor.destroy();
    }
}

export class DimOverlays {
    constructor(onWake) {
        this._onWake = onWake;
        this._layers = [];
        this._raiseId = Main.layoutManager.uiGroup.connect('child-added', () => this._raise());
        this.rebuild();
    }

    rebuild() {
        this._layers.forEach(l => l.destroy());
        this._layers = Main.layoutManager.monitors.map((m, i) => new MonitorLayer(i, this._onWake));
    }

    // menus and dialogs add themselves on top; stay above them
    _raise() {
        const group = Main.layoutManager.uiGroup;
        for (const layer of this._layers) {
            if (layer.actor.visible && group.get_last_child() !== layer.actor)
                group.set_child_above_sibling(layer.actor, null);
        }
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
