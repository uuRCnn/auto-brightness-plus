// "Claude is done": Claude Code's hooks call our little D-Bus method when it
// finishes or waits for you; the terminal's turned off screen lights up for
// a while and a notification appears. Other programs can do the same with
// the terminal bell or by asking for attention (GNOME's own signal).
//
// Nothing runs between those moments: no polling, no watching windows.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

export const DBUS_PATH = '/org/gnome/Shell/Extensions/AutoBrightnessPlus';
export const DBUS_IFACE = 'org.gnome.Shell.Extensions.AutoBrightnessPlus';
const XML = `<node>
  <interface name="${DBUS_IFACE}">
    <method name="Notify">
      <arg type="s" direction="in" name="kind"/>
      <arg type="u" direction="in" name="pid"/>
    </method>
  </interface>
</node>`;
const MAX_PARENTS = 40;

// parent process id, from /proc (null when gone)
function parentOf(pid) {
    try {
        const [, bytes] = GLib.file_get_contents(`/proc/${pid}/stat`);
        const text = new TextDecoder().decode(bytes);
        // "pid (name) state ppid …": the name may contain spaces and parentheses
        const rest = text.slice(text.lastIndexOf(')') + 2).split(' ');
        return Number(rest[1]) || null;
    } catch {
        return null;
    }
}

export class NotifyService {
    constructor(manager, settings) {
        this._manager = manager;
        this._settings = settings;
        this._dbus = Gio.DBusExportedObject.wrapJSObject(XML, this);
        try {
            this._dbus.export(Gio.DBus.session, DBUS_PATH);
        } catch (e) {
            console.error(`[Auto Brightness+] D-Bus: ${e.message}`);
            this._dbus = null;
        }
        this._ids = [
            global.display.connect('window-demands-attention', (dpy, win) => this._attention(win)),
            global.display.connect('window-marked-urgent', (dpy, win) => this._attention(win)),
        ];
    }

    // ---------------------------------------------------------- D-Bus
    /** kind: 'done' (Claude finished) or 'ask' (Claude waits for you); pid: a process in that terminal */
    Notify(kind, pid) {
        try {
            this.handle(kind, pid);
        } catch (e) {
            console.error(`[Auto Brightness+] notify: ${e.message}`);
        }
    }

    handle(kind, pid) {
        const s = this._settings;
        if (kind === 'ask' ? !s.get_boolean('claude-ask') : !s.get_boolean('claude-done'))
            return;
        const wins = this._windowsOf(pid);
        const dark = this._lightUp(wins);
        // always told, also when the terminal is on a lit (e.g. the main) screen
        if (s.get_boolean('claude-notification'))
            this._notify(kind, dark[0] ?? wins[0] ?? null);
    }

    // the terminal bell, or an app asking for attention (GNOME shows its own notification)
    _attention(win) {
        if (win && this._settings.get_boolean('notify-bell'))
            this._lightUp([win]);
    }

    // turned off screens with one of these windows: lit for a while, then dark
    _lightUp(wins) {
        const s = this._settings;
        const hit = [];
        for (const win of wins) {
            const d = this._manager.displays.find(x => x.index === win.get_monitor());
            if (d?.off && !hit.some(h => h.d === d))
                hit.push({d, win});
        }
        for (const {d} of hit)
            this._manager.keepLit(d, s.get_int('keep-lit-seconds'));
        return hit.map(h => h.win);
    }

    // the windows of the terminal that runs `pid`: walk up its parents until one owns a window
    _windowsOf(pid) {
        const byPid = new Map();
        for (const actor of global.get_window_actors()) {
            const win = actor.meta_window;
            const p = win?.get_pid?.();
            if (p > 0)
                byPid.set(p, [...byPid.get(p) ?? [], win]);
        }
        for (let p = pid, i = 0; p > 1 && i < MAX_PARENTS; i++, p = parentOf(p)) {
            if (byPid.has(p))
                return byPid.get(p);
        }
        return [];
    }

    _notify(kind, win) {
        const title = kind === 'ask' ? _('Claude is waiting for you') : _('Claude is done');
        let body = '';
        if (win) {
            const d = this._manager.displays.find(x => x.index === win.get_monitor());
            body = d ? `${win.get_title() ?? ''} · ${d.name}` : win.get_title() ?? '';
        }
        const source = MessageTray.getSystemSource?.();
        if (!source) {
            Main.notify(title, body);
            return;
        }
        const n = new MessageTray.Notification({source, title, body, iconName: 'utilities-terminal-symbolic'});
        if (win) {
            const go = () => Main.activateWindow(win);
            n.addAction(_('Go to the terminal'), go);
            n.connect('activated', go);
        }
        source.addNotification(n);
    }

    destroy() {
        this._ids.forEach(id => global.display.disconnect(id));
        this._dbus?.unexport();
        this._dbus = null;
    }
}
