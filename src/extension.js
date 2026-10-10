/* Brightness+ — monitor brightness for GNOME Shell
 * Copyright (C) 2026 Dukha
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {DisplayManager} from './lib/displays.js';
import {RedFilter} from './lib/redfilter.js';
import {BrightnessItem, NightLightItem, NightLightState, Tooltip} from './lib/ui.js';

const COLS = 2;

export default class BrightnessPlusExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._manager = new DisplayManager(this._settings);
        this._red = new RedFilter();
        this._tooltip = new Tooltip();
        this._items = [];
        this._hidden = [];
        this._nightItem = null;
        this._readyTimer = 0;

        this._nightState = new NightLightState(() => {
            this._syncRed();
            this._nightItem?.stateChanged();
        });
        this._settings.connectObject(
            'changed::red-enabled', () => this._syncRed(),
            'changed::red-strength', () => this._syncRed(false),
            'changed::red-follows-night-light', () => this._syncRed(),
            'changed::night-light-menu', () => this._rebuildNightLight(),
            'changed::hide-builtin-slider', () => this._syncBuiltinSlider(), this);

        this._whenQuickSettingsReady(() => {
            this._manager.connectObject('displays-changed', () => this._rebuildSliders(), this);
            this._rebuildSliders();
            this._rebuildNightLight();
            this._syncRed(false);
        });
    }

    disable() {
        if (this._readyTimer)
            GLib.source_remove(this._readyTimer);
        this._readyTimer = 0;
        this._settings.disconnectObject(this);
        this._manager.disconnectObject(this);
        this._destroySliders();
        this._destroyNightLight();
        this._restoreHidden();
        this._nightState.destroy();
        this._red.destroy();
        this._tooltip.destroy();
        this._manager.destroy();
        this._nightState = null;
        this._red = null;
        this._tooltip = null;
        this._manager = null;
        this._settings = null;
    }

    // Quick Settings builds its items asynchronously at login
    _whenQuickSettingsReady(callback) {
        const qs = Main.panel.statusArea.quickSettings;
        const ready = () => qs._volumeOutput?.quickSettingsItems?.[0]?.get_parent?.() ||
            qs._backgroundApps;
        if (ready()) {
            callback();
            return;
        }
        let tries = 0;
        this._readyTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            if (ready() || ++tries > 150) {
                this._readyTimer = 0;
                callback();
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    // ------------------------------------------------------------ sliders
    _rebuildSliders() {
        this._destroySliders();
        const qs = Main.panel.statusArea.quickSettings;
        const sibling = qs._volumeOutput?.quickSettingsItems?.[0] ??
            qs._brightness?.quickSettingsItems?.[0] ?? null;
        for (const display of this._manager.displays) {
            const item = new BrightnessItem(display, this._manager, this._settings, this._tooltip);
            if (sibling?.get_parent())
                qs.menu.insertItemBefore(item, sibling, COLS);
            else
                qs.menu.addItem(item, COLS);
            this._items.push(item);
        }
        this._syncBuiltinSlider();
    }

    _destroySliders() {
        this._items.splice(0).forEach(item => item.destroy());
    }

    // our own row replaces GNOME's built-in screen slider
    _syncBuiltinSlider() {
        const native = Main.panel.statusArea.quickSettings._brightness?.quickSettingsItems?.[0];
        if (!native)
            return;
        const hide = this._settings.get_boolean('hide-builtin-slider') &&
            this._manager.displays.some(d => d.kind === 'backlight');
        if (hide)
            this._hide(native);
        else
            this._unhide(native);
    }

    // ------------------------------------------------------------ night light
    _rebuildNightLight() {
        this._destroyNightLight();
        const qs = Main.panel.statusArea.quickSettings;
        const native = qs._nightLight?.quickSettingsItems?.[0];
        if (!native?.get_parent() || !this._settings.get_boolean('night-light-menu'))
            return;
        const shellGettext = s => GLib.dgettext('gnome-shell', s);
        this._nightItem = new NightLightItem(this._settings, this._nightState, shellGettext);
        qs.menu.insertItemBefore(this._nightItem, native, 1);
        this._hide(native);
    }

    _destroyNightLight() {
        if (!this._nightItem)
            return;
        this._nightItem.destroy();
        this._nightItem = null;
        const native = Main.panel.statusArea.quickSettings._nightLight?.quickSettingsItems?.[0];
        if (native)
            this._unhide(native);
    }

    // ------------------------------------------------------------ red screen
    _syncRed(animate = true) {
        if (!this._red)
            return;
        const s = this._settings;
        let on = s.get_boolean('red-enabled');
        if (on && s.get_boolean('red-follows-night-light'))
            on = this._nightState.active;
        this._red.set(on ? s.get_double('red-strength') : 0, animate);
    }

    // ------------------------------------------------------------ hiding native items
    // Their visibility is bound to other state, so keep them hidden.
    _hide(actor) {
        if (this._hidden.some(h => h.actor === actor))
            return;
        const id = actor.connect('notify::visible', () => {
            if (actor.visible)
                actor.hide();
        });
        this._hidden.push({actor, id, wasVisible: actor.visible});
        actor.hide();
    }

    _unhide(actor) {
        const i = this._hidden.findIndex(h => h.actor === actor);
        if (i < 0)
            return;
        const [h] = this._hidden.splice(i, 1);
        actor.disconnect(h.id);
        this._restoreVisibility(actor, h.wasVisible);
    }

    _restoreHidden() {
        for (const h of this._hidden.splice(0)) {
            h.actor.disconnect(h.id);
            this._restoreVisibility(h.actor, h.wasVisible);
        }
    }

    _restoreVisibility(actor, wasVisible) {
        const qs = Main.panel.statusArea.quickSettings;
        if (actor === qs._nightLight?.quickSettingsItems?.[0])
            actor.visible = global.backend.get_monitor_manager().night_light_supported;
        else if (actor === qs._brightness?.quickSettingsItems?.[0])
            actor.visible = !!Main.brightnessManager?.globalScale || wasVisible;
        else
            actor.visible = wasVisible;
    }
}
