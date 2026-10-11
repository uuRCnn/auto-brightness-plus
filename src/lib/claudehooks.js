// Adds / removes our two hooks in Claude Code's settings
// (~/.claude/settings.json, or $CLAUDE_CONFIG_DIR/settings.json).
// Everything else in that file stays as it is; a backup is kept next to it.
// Used by the preferences window only.

import GLib from 'gi://GLib';

const MARK = 'org.gnome.Shell.Extensions.AutoBrightnessPlus.Notify';

// $PPID of the hook's shell is the Claude process; the extension walks up to the terminal window
const command = kind => `gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell/Extensions/AutoBrightnessPlus --method ${MARK} ${kind} $PPID >/dev/null 2>&1 || true`;

export function settingsPath() {
    const dir = GLib.getenv('CLAUDE_CONFIG_DIR') || GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
    return GLib.build_filenamev([dir, 'settings.json']);
}

function read(path) {
    if (!GLib.file_test(path, GLib.FileTest.EXISTS))
        return {text: null, data: {}};
    const [, bytes] = GLib.file_get_contents(path);
    const text = new TextDecoder().decode(bytes);
    const data = text.trim() ? JSON.parse(text) : {};      // throws on a broken file: then we touch nothing
    if (typeof data !== 'object' || Array.isArray(data) || data === null)
        throw new Error('settings.json is not a JSON object');
    return {text, data};
}

const ours = group => (group?.hooks ?? []).some(h => typeof h?.command === 'string' && h.command.includes(MARK));

function strip(data) {
    const hooks = data.hooks;
    if (!hooks || typeof hooks !== 'object')
        return;
    for (const event of ['Stop', 'Notification']) {
        if (!Array.isArray(hooks[event]))
            continue;
        hooks[event] = hooks[event].filter(g => !ours(g));
        if (!hooks[event].length)
            delete hooks[event];
    }
    if (!Object.keys(hooks).length)
        delete data.hooks;
}

function write(path, before, data) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
    if (before !== null)
        GLib.file_set_contents(`${path}.auto-brightness-plus.bak`, before);
    GLib.file_set_contents(path, `${JSON.stringify(data, null, 2)}\n`);
}

/** Are our hooks in Claude Code's settings? */
export function isConnected() {
    try {
        const {data} = read(settingsPath());
        return ['Stop', 'Notification'].some(e => (data.hooks?.[e] ?? []).some(ours));
    } catch {
        return false;
    }
}

export function connect() {
    const path = settingsPath();
    const {text, data} = read(path);
    strip(data);
    data.hooks ??= {};
    (data.hooks.Stop ??= []).push({hooks: [{type: 'command', command: command('done')}]});
    // only when Claude really waits for you (a permission or a question), not for every notice
    (data.hooks.Notification ??= []).push({matcher: 'permission_prompt|elicitation_dialog',
        hooks: [{type: 'command', command: command('ask')}]});
    write(path, text, data);
}

export function disconnect() {
    const path = settingsPath();
    const {text, data} = read(path);
    strip(data);
    write(path, text, data);
}
