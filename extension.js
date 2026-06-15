import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const FALLBACK_DOUBLE_CLICK_TIMEOUT_MS = 400;
const CLICK_DISTANCE_THRESHOLD = 18;
const DEFAULT_MINIMIZE_RESTORE_TIMEOUT_SECONDS = 2;

const Action = Object.freeze({
    NONE: 'none',
    MINIMIZE_FOCUSED_WINDOW: 'minimize-focused-window',
    TOGGLE_MINIMIZE_RESTORE: 'toggle-minimize-restore',
    TRIGGER_CUSTOM_SHORTCUT: 'trigger-custom-shortcut',
    SHOW_DESKTOP: 'show-desktop',
    TOGGLE_MAXIMIZE: 'toggle-maximize',
    CLOSE_WINDOW: 'close-window',
    TOGGLE_ALWAYS_ON_TOP: 'toggle-always-on-top',
    HIDE_ALL_NORMAL_WINDOWS: 'hide-all-normal-windows',
});

function getEventActor(event) {
    try {
        return global.stage.get_event_actor(event);
    } catch {
        return event.get_source?.() ?? null;
    }
}

function getFocusedWindow() {
    const window = global.display.get_focus_window();
    if (!window)
        return null;

    const windowType = window.get_window_type?.() ?? window.window_type;
    if (windowType === Meta.WindowType.DESKTOP || windowType === Meta.WindowType.DOCK)
        return null;

    return window;
}

function isNormalWorkspaceWindow(window, workspace) {
    if (!window || !workspace || window.minimized || window.skip_taskbar)
        return false;

    if (!window.located_on_workspace?.(workspace))
        return false;

    const windowType = window.get_window_type?.() ?? window.window_type;
    return windowType === Meta.WindowType.NORMAL;
}

function listNormalWorkspaceWindows(workspace) {
    return workspace.list_windows().filter(window => isNormalWorkspaceWindow(window, workspace));
}

function describeActor(actor) {
    if (!actor)
        return 'null';

    const constructorName = actor.constructor?.name ?? 'Actor';
    const name = actor.name ?? actor.get_name?.() ?? '';
    const styleClass = actor.get_style_class_name?.() ?? '';
    return [constructorName, name, styleClass].filter(Boolean).join(':');
}

function describeActorPath(actor) {
    const path = [];
    let current = actor;

    while (current && path.length < 8) {
        path.push(describeActor(current));
        current = current.get_parent?.() ?? null;
    }

    return path.join(' <- ');
}

export default class PanelDoubleClickMinimizeExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._desktopMouseSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.peripherals.mouse',
        });
        this._wmKeybindingsSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.wm.keybindings',
        });
        this._shellKeybindingsSettings = new Gio.Settings({
            schema_id: 'org.gnome.shell.keybindings',
        });
        this._mediaKeysSettings = new Gio.Settings({
            schema_id: 'org.gnome.settings-daemon.plugins.media-keys',
        });
        this._pendingPrimaryClick = null;
        this._storedDesktopWindows = [];
        this._toggledAboveWindows = new Set();
        this._lastMinimizeRestoreToggle = null;

        this._panelEventId = Main.panel.connect(
            'captured-event',
            this._onPanelCapturedEvent.bind(this)
        );
        this._settingsSignalHandles = [
            [
                this._settings,
                this._settings.connect(
                'changed::debug-log-enabled',
                () => this._log(`debug logging ${this._isDebugEnabled() ? 'enabled' : 'disabled'}`)
                ),
            ],
            [
                this._desktopMouseSettings,
                this._desktopMouseSettings.connect(
                'changed::double-click',
                () => this._log(`system double-click timeout updated to ${this._getDoubleClickTimeoutMs()}ms`)
                ),
            ],
            [
                this._settings,
                this._settings.connect(
                'changed::minimize-restore-timeout-seconds',
                () => this._log(`timed restore window updated to ${this._getMinimizeRestoreTimeoutMs()}ms`)
                ),
            ],
            [
                this._settings,
                this._settings.connect(
                'changed::primary-custom-shortcut-accelerator',
                () => this._log(`primary shortcut updated to ${this._getCustomShortcutAccelerator('double-left-click') || 'unset'}`)
                ),
            ],
            [
                this._settings,
                this._settings.connect(
                'changed::middle-custom-shortcut-accelerator',
                () => this._log(`middle shortcut updated to ${this._getCustomShortcutAccelerator('middle-click') || 'unset'}`)
                ),
            ],
            [
                this._settings,
                this._settings.connect(
                'changed::secondary-custom-shortcut-accelerator',
                () => this._log(`secondary shortcut updated to ${this._getCustomShortcutAccelerator('right-click') || 'unset'}`)
                ),
            ],
        ];

        this._log('extension enabled');
    }

    disable() {
        if (this._panelEventId) {
            Main.panel.disconnect(this._panelEventId);
            this._panelEventId = 0;
        }

        for (const [object, signalId] of this._settingsSignalHandles ?? [])
            object.disconnect(signalId);

        this._settingsSignalHandles = [];
        this._pendingPrimaryClick = null;
        this._storedDesktopWindows = [];
        this._toggledAboveWindows?.clear();
        this._lastMinimizeRestoreToggle = null;
        this._mediaKeysSettings = null;
        this._shellKeybindingsSettings = null;
        this._wmKeybindingsSettings = null;
        this._desktopMouseSettings = null;
        this._settings = null;
    }

    _onPanelCapturedEvent(_actor, event) {
        if (event.type() !== Clutter.EventType.BUTTON_PRESS)
            return Clutter.EVENT_PROPAGATE;

        return this._handleButtonPress(event);
    }

    _handleButtonPress(event) {
        const button = event.get_button();
        const sourceActor = getEventActor(event);
        const [stageX, stageY] = event.get_coords();
        const blankHit = this._isBlankPanelActor(sourceActor);

        this._log(
            `button-press button=${button} blank=${blankHit} actor=${describeActor(sourceActor)} coords=${stageX},${stageY}`
        );

        if (!blankHit) {
            if (button === Clutter.BUTTON_PRIMARY)
                this._pendingPrimaryClick = null;

            return Clutter.EVENT_PROPAGATE;
        }

        if (button === Clutter.BUTTON_PRIMARY)
            return this._handlePrimaryDoubleClick(sourceActor, stageX, stageY, event.get_time());

        if (button === Clutter.BUTTON_MIDDLE)
            return this._runConfiguredAction(this._settings.get_string('middle-action'), 'middle-click');

        if (button === Clutter.BUTTON_SECONDARY)
            return this._runConfiguredAction(this._settings.get_string('secondary-action'), 'right-click');

        return Clutter.EVENT_PROPAGATE;
    }

    _handlePrimaryDoubleClick(sourceActor, stageX, stageY, eventTime) {
        if (!this._isDoubleClick(stageX, stageY, eventTime)) {
            this._pendingPrimaryClick = {
                time: eventTime,
                x: stageX,
                y: stageY,
                window: getFocusedWindow(),
            };
            this._log(
                `stored first click path=${describeActorPath(sourceActor)} timeout=${this._getDoubleClickTimeoutMs()}ms`
            );
            return this._shouldCapturePrimarySingleClick()
                ? Clutter.EVENT_STOP
                : Clutter.EVENT_PROPAGATE;
        }

        const preferredWindow = this._pendingPrimaryClick.window ?? null;
        this._pendingPrimaryClick = null;
        return this._runConfiguredAction(
            this._settings.get_string('primary-action'),
            'double-left-click',
            {preferredWindow}
        );
    }

    _runConfiguredAction(actionId, triggerLabel, context = {}) {
        if (actionId === Action.NONE) {
            this._log(`action skipped for ${triggerLabel}: none`);
            return Clutter.EVENT_PROPAGATE;
        }

        const handled = this._executeAction(actionId, {
            ...context,
            triggerLabel,
        });
        this._log(`trigger=${triggerLabel} action=${actionId} handled=${handled}`);
        return handled ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
    }

    _executeAction(actionId, context = {}) {
        switch (actionId) {
        case Action.MINIMIZE_FOCUSED_WINDOW:
            return this._minimizeFocusedWindow(context.preferredWindow);
        case Action.TOGGLE_MINIMIZE_RESTORE:
            return this._toggleMinimizeRestoreFocusedWindow(context.preferredWindow);
        case Action.TRIGGER_CUSTOM_SHORTCUT:
            return this._triggerCustomShortcut(context);
        case Action.SHOW_DESKTOP:
            return this._toggleShowDesktop();
        case Action.TOGGLE_MAXIMIZE:
            return this._toggleMaximizeFocusedWindow(context.preferredWindow);
        case Action.CLOSE_WINDOW:
            return this._closeFocusedWindow(context.preferredWindow);
        case Action.TOGGLE_ALWAYS_ON_TOP:
            return this._toggleFocusedWindowAlwaysOnTop(context.preferredWindow);
        case Action.HIDE_ALL_NORMAL_WINDOWS:
            return this._hideAllNormalWindows();
        default:
            this._log(`unknown action: ${actionId}`);
            return false;
        }
    }

    _minimizeFocusedWindow(preferredWindow = null) {
        const window = this._getActionTargetWindow(preferredWindow);
        if (!window || window.minimized || !window.can_minimize())
            return false;

        this._log(
            `minimizing window title="${window.get_title?.() ?? ''}" wmClass="${window.get_wm_class?.() ?? ''}"`
        );
        window.minimize();
        return true;
    }

    _toggleMinimizeRestoreFocusedWindow(preferredWindow = null) {
        const nowMs = GLib.get_monotonic_time() / 1000;
        const remembered = this._lastMinimizeRestoreToggle;
        const rememberedWindow = remembered?.window ?? null;
        const rememberAgeMs = remembered ? nowMs - remembered.timeMs : Number.POSITIVE_INFINITY;

        if (rememberedWindow && rememberAgeMs <= this._getMinimizeRestoreTimeoutMs()) {
            this._log(
                `toggle-minimize-restore remembered title="${rememberedWindow.get_title?.() ?? ''}" minimized=${rememberedWindow.minimized} ageMs=${Math.round(rememberAgeMs)} timeoutMs=${this._getMinimizeRestoreTimeoutMs()}`
            );

            if (rememberedWindow.minimized) {
                rememberedWindow.unminimize();
                rememberedWindow.activate(global.get_current_time());
                this._lastMinimizeRestoreToggle = null;
                return true;
            }
        }

        const window = this._getActionTargetWindow(preferredWindow);
        if (!window || window.minimized || !window.can_minimize())
            return false;

        this._log(
            `toggle-minimize-restore minimize title="${window.get_title?.() ?? ''}" wmClass="${window.get_wm_class?.() ?? ''}"`
        );
        window.minimize();
        this._lastMinimizeRestoreToggle = {
            window,
            timeMs: nowMs,
        };
        return true;
    }

    _triggerCustomShortcut(context = {}) {
        const preferredWindow = context.preferredWindow ?? null;
        const accelerator = this._getCustomShortcutAccelerator(context.triggerLabel);
        if (!accelerator) {
            this._log('custom shortcut skipped: empty');
            return false;
        }

        this._log(`custom shortcut trigger accelerator=${accelerator}`);

        if (this._triggerAcceleratorViaXdotool(accelerator))
            return true;

        if (accelerator === '<Super>l' ||
            this._matchesSettingsShortcut(this._mediaKeysSettings, 'screensaver', accelerator) ||
            this._matchesSettingsShortcut(this._mediaKeysSettings, 'screensaver-static', accelerator)) {
            return this._lockScreen();
        }

        if (this._matchesSettingsShortcut(this._wmKeybindingsSettings, 'show-desktop', accelerator))
            return this._toggleShowDesktop();

        if (this._matchesSettingsShortcut(this._wmKeybindingsSettings, 'close', accelerator))
            return this._closeFocusedWindow(preferredWindow);

        if (this._matchesSettingsShortcut(this._wmKeybindingsSettings, 'minimize', accelerator))
            return this._minimizeFocusedWindow(preferredWindow);

        if (this._matchesSettingsShortcut(this._wmKeybindingsSettings, 'toggle-maximized', accelerator) ||
            this._matchesSettingsShortcut(this._wmKeybindingsSettings, 'maximize', accelerator) ||
            this._matchesSettingsShortcut(this._wmKeybindingsSettings, 'unmaximize', accelerator)) {
            return this._toggleMaximizeFocusedWindow(preferredWindow);
        }

        if (this._matchesSettingsShortcut(this._wmKeybindingsSettings, 'toggle-above', accelerator) ||
            this._matchesSettingsShortcut(this._wmKeybindingsSettings, 'always-on-top', accelerator)) {
            return this._toggleFocusedWindowAlwaysOnTop(preferredWindow);
        }

        if (this._matchesSettingsShortcut(this._shellKeybindingsSettings, 'toggle-overview', accelerator)) {
            Main.overview.toggle();
            return true;
        }

        if (this._matchesSettingsShortcut(this._shellKeybindingsSettings, 'toggle-quick-settings', accelerator)) {
            const menu = Main.panel.statusArea.quickSettings?.menu;
            if (!menu)
                return false;

            menu.toggle();
            return true;
        }

        if (this._matchesSettingsShortcut(this._mediaKeysSettings, 'logout', accelerator))
            return this._logout();

        if (this._runMatchingCustomKeybindingCommand(accelerator))
            return true;

        this._log(`custom shortcut unsupported: ${accelerator}`);
        return false;
    }

    _toggleShowDesktop() {
        const workspace = global.workspace_manager.get_active_workspace();
        const windows = listNormalWorkspaceWindows(workspace);
        if (windows.length > 0) {
            this._storedDesktopWindows = windows.filter(window => window.can_minimize());
            this._storedDesktopWindows.forEach(window => window.minimize());
            return this._storedDesktopWindows.length > 0;
        }

        const stackedWindows = global.display.sort_windows_by_stacking(this._storedDesktopWindows);
        let topWindow = null;
        for (const window of stackedWindows) {
            if (!window || !window.located_on_workspace?.(workspace))
                continue;

            window.unminimize();
            topWindow = window;
        }

        if (topWindow)
            topWindow.activate(global.get_current_time());

        const restored = stackedWindows.length > 0;
        this._storedDesktopWindows = [];
        return restored;
    }

    _toggleMaximizeFocusedWindow(preferredWindow = null) {
        const window = this._getActionTargetWindow(preferredWindow);
        if (!window || !window.can_maximize?.())
            return false;

        const isMaximized = this._isWindowFullyMaximized(window);
        if (isMaximized)
            window.unmaximize();
        else
            window.maximize();

        return true;
    }

    _closeFocusedWindow(preferredWindow = null) {
        const window = this._getActionTargetWindow(preferredWindow);
        if (!window)
            return false;

        window.delete(global.get_current_time());
        return true;
    }

    _toggleFocusedWindowAlwaysOnTop(preferredWindow = null) {
        const window = this._getActionTargetWindow(preferredWindow);
        if (!window)
            return false;

        const managedByExtension = this._toggledAboveWindows?.has(window) ?? false;
        const isAbove = window.is_above?.() ?? false;

        this._log(
            `toggle-above title="${window.get_title?.() ?? ''}" managed=${managedByExtension} isAbove=${isAbove}`
        );

        if (managedByExtension || isAbove) {
            window.unmake_above();
            this._toggledAboveWindows?.delete(window);
        } else {
            window.make_above();
            this._toggledAboveWindows?.add(window);
        }

        this._log(
            `toggle-above result title="${window.get_title?.() ?? ''}" managed=${this._toggledAboveWindows?.has(window) ?? false} isAboveNow=${window.is_above?.() ?? false}`
        );
        return true;
    }

    _hideAllNormalWindows() {
        const workspace = global.workspace_manager.get_active_workspace();
        const windows = listNormalWorkspaceWindows(workspace).filter(window => window.can_minimize());
        windows.forEach(window => window.minimize());
        return windows.length > 0;
    }

    _isBlankPanelActor(actor) {
        if (!actor || !Main.panel.contains(actor))
            return false;

        if (actor === Main.panel ||
            actor === Main.panel._leftBox ||
            actor === Main.panel._centerBox ||
            actor === Main.panel._rightBox) {
            return true;
        }

        let current = actor;
        while (current && current !== Main.panel) {
            const styleClass = current.get_style_class_name?.() ?? '';
            if (styleClass.split(/\s+/).includes('panel-button'))
                return false;

            current = current.get_parent?.() ?? null;
        }

        return true;
    }

    _isDoubleClick(stageX, stageY, eventTime) {
        if (!this._pendingPrimaryClick)
            return false;

        const clickTimeoutMs = this._getDoubleClickTimeoutMs();
        const elapsed = eventTime - this._pendingPrimaryClick.time;
        if (elapsed < 0 || elapsed > clickTimeoutMs) {
            this._log(`double-click timeout elapsed=${elapsed}ms threshold=${clickTimeoutMs}ms`);
            return false;
        }

        const distance = Math.hypot(stageX - this._pendingPrimaryClick.x, stageY - this._pendingPrimaryClick.y);
        this._log(
            `double-click check elapsed=${elapsed}ms threshold=${clickTimeoutMs}ms distance=${distance.toFixed(1)} threshold=${CLICK_DISTANCE_THRESHOLD}px`
        );

        return distance <= CLICK_DISTANCE_THRESHOLD;
    }

    _getDoubleClickTimeoutMs() {
        return this._desktopMouseSettings?.get_int('double-click') ?? FALLBACK_DOUBLE_CLICK_TIMEOUT_MS;
    }

    _shouldCapturePrimarySingleClick() {
        return this._settings?.get_boolean('capture-primary-single-click') ?? false;
    }

    _getCustomShortcutAccelerator(triggerLabel = '') {
        const settingKey = this._getCustomShortcutSettingKey(triggerLabel);
        const triggerAccelerator = settingKey
            ? this._normalizeAccelerator(this._settings?.get_string(settingKey) ?? '')
            : '';

        if (triggerAccelerator)
            return triggerAccelerator;

        return this._normalizeAccelerator(this._settings?.get_string('custom-shortcut-accelerator') ?? '');
    }

    _getMinimizeRestoreTimeoutMs() {
        const seconds = this._settings?.get_int('minimize-restore-timeout-seconds') ??
            DEFAULT_MINIMIZE_RESTORE_TIMEOUT_SECONDS;
        return Math.max(1, seconds) * 1000;
    }

    _normalizeAccelerator(accelerator) {
        return accelerator?.trim() ?? '';
    }

    _isWindowFullyMaximized(window) {
        const horizontal = window.maximized_horizontally ?? false;
        const vertical = window.maximized_vertically ?? false;
        return horizontal && vertical;
    }

    _getCustomShortcutSettingKey(triggerLabel) {
        switch (triggerLabel) {
        case 'double-left-click':
            return 'primary-custom-shortcut-accelerator';
        case 'middle-click':
            return 'middle-custom-shortcut-accelerator';
        case 'right-click':
            return 'secondary-custom-shortcut-accelerator';
        default:
            return '';
        }
    }

    _matchesSettingsShortcut(settings, key, accelerator) {
        const normalizedTarget = this._normalizeAccelerator(accelerator);
        return settings.get_strv(key).some(binding =>
            this._normalizeAccelerator(binding) === normalizedTarget
        );
    }

    _runMatchingCustomKeybindingCommand(accelerator) {
        const normalizedTarget = this._normalizeAccelerator(accelerator);
        const customKeybindings = this._mediaKeysSettings?.get_strv('custom-keybindings') ?? [];

        for (const path of customKeybindings) {
            const settings = new Gio.Settings({
                schema_id: 'org.gnome.settings-daemon.plugins.media-keys.custom-keybinding',
                path,
            });
            const binding = this._normalizeAccelerator(settings.get_string('binding'));
            const command = settings.get_string('command').trim();

            if (binding !== normalizedTarget || !command)
                continue;

            try {
                GLib.spawn_command_line_async(command);
                this._log(`custom keybinding command launched path=${path} command="${command}"`);
                return true;
            } catch (error) {
                this._log(`custom keybinding command failed path=${path} error=${error}`);
                return false;
            }
        }

        return false;
    }

    _triggerAcceleratorViaXdotool(accelerator) {
        if (GLib.getenv('XDG_SESSION_TYPE') !== 'x11')
            return false;

        const xdotoolPath = GLib.find_program_in_path('xdotool');
        if (!xdotoolPath)
            return false;

        const sequence = this._acceleratorToXdotoolSequence(accelerator);
        if (!sequence) {
            this._log(`xdotool sequence unavailable for accelerator=${accelerator}`);
            return false;
        }

        try {
            const subprocess = Gio.Subprocess.new(
                [xdotoolPath, 'key', '--clearmodifiers', sequence],
                Gio.SubprocessFlags.NONE
            );
            const success = subprocess.wait_check(null);
            this._log(`xdotool trigger sequence=${sequence} success=${success}`);
            return success;
        } catch (error) {
            this._log(`xdotool trigger failed sequence=${sequence} error=${error}`);
            return false;
        }
    }

    _acceleratorToXdotoolSequence(accelerator) {
        const normalized = this._normalizeAccelerator(accelerator);
        if (!normalized)
            return '';

        const modifiers = [];
        const modifierMap = new Map([
            ['Control', 'ctrl'],
            ['Primary', 'ctrl'],
            ['Alt', 'alt'],
            ['Shift', 'shift'],
            ['Super', 'super'],
            ['Meta', 'meta'],
            ['Hyper', 'hyper'],
        ]);

        let key = normalized;
        key = key.replace(/<([^>]+)>/g, (_match, modifierName) => {
            const mapped = modifierMap.get(modifierName);
            if (mapped)
                modifiers.push(mapped);
            return '';
        });

        const mappedKey = this._mapXdotoolKeyName(key.trim());
        if (!mappedKey)
            return '';

        return [...modifiers, mappedKey].join('+');
    }

    _mapXdotoolKeyName(key) {
        if (!key)
            return '';

        const keyMap = new Map([
            ['Above_Tab', 'ISO_Left_Tab'],
            ['Page_Up', 'Page_Up'],
            ['Page_Down', 'Page_Down'],
            ['space', 'space'],
            ['Return', 'Return'],
            ['Escape', 'Escape'],
            ['BackSpace', 'BackSpace'],
            ['Tab', 'Tab'],
            ['Delete', 'Delete'],
            ['Insert', 'Insert'],
            ['Home', 'Home'],
            ['End', 'End'],
            ['Left', 'Left'],
            ['Right', 'Right'],
            ['Up', 'Up'],
            ['Down', 'Down'],
            ['KP_Enter', 'KP_Enter'],
        ]);

        return keyMap.get(key) ?? key;
    }

    _lockScreen() {
        try {
            Gio.DBus.session.call_sync(
                'org.gnome.ScreenSaver',
                '/org/gnome/ScreenSaver',
                'org.gnome.ScreenSaver',
                'Lock',
                null,
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null
            );
            return true;
        } catch (error) {
            this._log(`lock screen failed: ${error}`);
            return false;
        }
    }

    _logout() {
        try {
            Gio.DBus.session.call_sync(
                'org.gnome.SessionManager',
                '/org/gnome/SessionManager',
                'org.gnome.SessionManager',
                'Logout',
                new GLib.Variant('(u)', [0]),
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null
            );
            return true;
        } catch (error) {
            this._log(`logout failed: ${error}`);
            return false;
        }
    }

    _getActionTargetWindow(preferredWindow = null) {
        const focusedWindow = getFocusedWindow();
        if (focusedWindow)
            return focusedWindow;

        if (preferredWindow) {
            this._log(
                `using remembered window title="${preferredWindow.get_title?.() ?? ''}" because focused window is unavailable`
            );
            return preferredWindow;
        }

        return null;
    }

    _isDebugEnabled() {
        return this._settings?.get_boolean('debug-log-enabled') ?? false;
    }

    _log(message) {
        if (!this._isDebugEnabled())
            return;

        log(`[panel-empty-space-actions] ${message}`);
    }
}
