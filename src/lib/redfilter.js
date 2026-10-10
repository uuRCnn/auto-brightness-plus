// Red screen: a tiny shader on the whole desktop that moves all light into
// the red channel (no blue, no green). `strength` blends between the normal
// picture (0) and fully red (1). The effect is only attached while used.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const EFFECT_NAME = 'brightness-plus-red';
const FADE_MS = 800;

const DECLARATIONS = 'uniform float u_strength;';
const CODE = `
    vec3 c = cogl_color_out.rgb;
    float r = dot(c, vec3(0.62, 0.32, 0.06));
    cogl_color_out.rgb = mix(c, vec3(r, 0.0, 0.0), u_strength);`;

const STRENGTH = {
    Properties: {
        'strength': GObject.ParamSpec.double('strength', null, null,
            GObject.ParamFlags.READWRITE, 0, 1, 0),
    },
};

let RedEffect = null;

// GNOME 51 replaced Shell.GLSLEffect with Clutter.ShaderEffect snippets
function effectClass() {
    if (RedEffect)
        return RedEffect;
    if (Shell.GLSLEffect) {
        RedEffect = GObject.registerClass(STRENGTH, class RedEffectGLSL extends Shell.GLSLEffect {
            _init() {
                this._strength = 0;
                super._init();
                this._loc = this.get_uniform_location('u_strength');
            }

            get strength() {
                return this._strength;
            }

            set strength(v) {
                if (v === this._strength)
                    return;
                this._strength = v;
                this.notify('strength');
                this.queue_repaint();
            }

            vfunc_build_pipeline() {
                this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, CODE, false);
            }

            vfunc_paint_target(...args) {
                this.set_uniform_float(this._loc, 1, [this._strength]);
                super.vfunc_paint_target(...args);
            }
        });
    } else {
        RedEffect = GObject.registerClass(STRENGTH, class RedEffectSnippet extends Clutter.ShaderEffect {
            _init() {
                this._strength = undefined;
                super._init();
                this.strength = 0;
            }

            vfunc_get_static_snippet() {
                return Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, CODE);
            }

            get strength() {
                return this._strength;
            }

            set strength(v) {
                if (v === this._strength)
                    return;
                this._strength = v;
                this.set_uniform_float('u_strength', 1, [v]);
                this.notify('strength');
            }
        });
    }
    return RedEffect;
}

export class RedFilter {
    constructor() {
        this._effect = null;
        this._target = 0;
    }

    /** @param {number} strength 0 removes the effect */
    set(strength, animate = true) {
        if (strength === this._target)
            return;
        this._target = strength;
        const group = Main.layoutManager.uiGroup;
        if (strength > 0 && !this._effect) {
            this._effect = new (effectClass())();
            group.add_effect_with_name(EFFECT_NAME, this._effect);
        }
        if (!this._effect)
            return;
        group.remove_transition(`@effects.${EFFECT_NAME}.strength`);
        const done = () => {
            if (this._target === 0 && this._effect) {
                group.remove_effect(this._effect);
                this._effect = null;
            }
        };
        if (!animate) {
            this._effect.strength = strength;
            done();
            return;
        }
        group.ease_property(`@effects.${EFFECT_NAME}.strength`, strength, {
            duration: FADE_MS,
            mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
            onStopped: done,
        });
    }

    destroy() {
        const group = Main.layoutManager.uiGroup;
        if (this._effect) {
            group.remove_transition(`@effects.${EFFECT_NAME}.strength`);
            group.remove_effect(this._effect);
            this._effect = null;
        }
    }
}
