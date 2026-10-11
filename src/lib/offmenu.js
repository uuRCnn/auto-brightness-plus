// The small menu of one screen, from the corner dot of a turned off screen
// or from the keyboard shortcut (for the screen under the mouse).

import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {fmt} from './sun.js';

export function formatSeconds(s) {
    if (s < 60)
        return fmt(_('%d s'), s);
    const m = Math.floor(s / 60), r = s % 60;
    return r ? fmt(_('%d min %d s'), m, r) : fmt(_('%d min'), m);
}

export class OffMenu {
    constructor(manager, settings, overlays) {
        this._manager = manager;
        this._settings = settings;
        this._overlays = overlays;
        this._menu = null;
    }

    open(d, x, y) {
        this.close();
        const anchor = new St.Widget({width: 1, height: 1, x, y, reactive: false});
        Main.layoutManager.uiGroup.add_child(anchor);
        const menu = new PopupMenu.PopupMenu(anchor, 0, St.Side.TOP);
        Main.layoutManager.uiGroup.add_child(menu.actor);
        this._overlays.keepAbove(menu.actor);
        const menuManager = new PopupMenu.PopupMenuManager(anchor);
        menuManager.addMenu(menu);
        this._menu = {menu, anchor, menuManager};

        const mgr = this._manager;
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(d.name));
        if (d.off) {
            const keep = this._settings.get_int('keep-lit-seconds');
            menu.addAction(fmt(_('Keep lit · %s'), formatSeconds(keep)), () => mgr.keepLit(d, keep), 'view-pin-symbolic');
            menu.addAction(_('Keep lit until I darken it'), () => mgr.keepLit(d, Infinity), 'view-pin-symbolic');
            menu.addAction(_('Darken now'), () => mgr.darkNow(d));
            menu.addAction(_('Turn the screen back on'), () => mgr.wake(d.index), 'system-shutdown-symbolic');
        } else {
            menu.addAction(_('Turn off screen'), () => mgr.turnOff(d), 'system-shutdown-symbolic');
            menu.addAction(_('Turn off other screens'), () => mgr.turnOffOthers(d), 'video-joined-displays-symbolic');
        }

        // closing happens inside the menu's own signal: tear down a moment later
        menu.connect('open-state-changed', (m, open) => {
            if (open)
                return;
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (this._menu?.menu === menu)
                    this.close();
                return GLib.SOURCE_REMOVE;
            });
        });
        menu.open();
    }

    close() {
        if (!this._menu)
            return;
        const {menu, anchor} = this._menu;
        this._menu = null;
        menu.destroy();
        anchor.destroy();
    }

    destroy() {
        this.close();
    }
}
