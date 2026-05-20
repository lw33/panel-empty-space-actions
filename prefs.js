import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function getActionOptions() {
    return [
        {id: 'minimize-focused-window', label: _('Minimize current window')},
        {id: 'toggle-minimize-restore', label: _('Timed minimize / restore')},
        {id: 'trigger-custom-shortcut', label: _('Trigger custom shortcut')},
        {id: 'show-desktop', label: _('Show desktop / restore')},
        {id: 'toggle-maximize', label: _('Maximize / restore')},
        {id: 'close-window', label: _('Close current window')},
        {id: 'toggle-always-on-top', label: _('Always on top / restore')},
        {id: 'hide-all-normal-windows', label: _('Hide all normal windows')},
        {id: 'none', label: _('Do nothing')},
    ];
}

function createDropdownRow(settings, key, title, subtitle, options) {
    const labels = options.map(option => option.label);
    const model = Gtk.StringList.new(labels);
    const dropdown = new Gtk.DropDown({
        model,
        valign: Gtk.Align.CENTER,
    });

    const current = settings.get_string(key);
    const index = Math.max(0, options.findIndex(option => option.id === current));
    dropdown.set_selected(index);
    dropdown.connect('notify::selected', widget => {
        const selected = options[widget.get_selected()];
        settings.set_string(key, selected.id);
    });

    const row = new Adw.ActionRow({title, subtitle});
    row.add_suffix(dropdown);
    row.activatable_widget = dropdown;
    return row;
}

function createSwitchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function createSpinRow(settings, key, title, subtitle, lower, upper) {
    const adjustment = new Gtk.Adjustment({
        lower,
        upper,
        step_increment: 1,
        page_increment: 1,
        value: settings.get_int(key),
    });
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment,
        climb_rate: 1,
        digits: 0,
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function getShortcutLabel(accelerator) {
    if (!accelerator)
        return _('Set shortcut');

    const [success, keyval, modifiers] = Gtk.accelerator_parse(accelerator);
    if (!success)
        return accelerator;

    return Gtk.accelerator_get_label(keyval, modifiers) || accelerator;
}

function isForbiddenShortcutKeyval(keyval) {
    return [
        Gdk.KEY_Home,
        Gdk.KEY_Left,
        Gdk.KEY_Up,
        Gdk.KEY_Right,
        Gdk.KEY_Down,
        Gdk.KEY_Page_Up,
        Gdk.KEY_Page_Down,
        Gdk.KEY_End,
        Gdk.KEY_Tab,
        Gdk.KEY_KP_Enter,
        Gdk.KEY_Return,
        Gdk.KEY_Mode_switch,
    ].includes(keyval);
}

function isValidShortcut({mask, keycode, keyval}) {
    if ((mask === 0 || mask === Gdk.ModifierType.SHIFT_MASK) && keycode !== 0) {
        if ((keyval >= Gdk.KEY_a && keyval <= Gdk.KEY_z) ||
            (keyval >= Gdk.KEY_A && keyval <= Gdk.KEY_Z) ||
            (keyval >= Gdk.KEY_0 && keyval <= Gdk.KEY_9) ||
            (keyval === Gdk.KEY_space && mask === 0) ||
            isForbiddenShortcutKeyval(keyval)) {
            return false;
        }
    }

    return true;
}

function createShortcutCaptureRow(window, settings, key, title, subtitle) {
    const row = new Adw.ActionRow({title, subtitle});
    const captureButton = new Gtk.Button({
        label: getShortcutLabel(settings.get_string(key)),
        valign: Gtk.Align.CENTER,
    });
    const clearButton = new Gtk.Button({
        icon_name: 'edit-clear-symbolic',
        tooltip_text: _('Clear shortcut'),
        valign: Gtk.Align.CENTER,
        sensitive: Boolean(settings.get_string(key)),
    });
    const keyController = new Gtk.EventControllerKey();
    let listening = false;

    const updateUi = () => {
        const accelerator = settings.get_string(key);
        captureButton.set_label(listening ? _('Press a shortcut…') : getShortcutLabel(accelerator));
        clearButton.set_sensitive(Boolean(accelerator));
    };

    const stopListening = () => {
        if (!listening)
            return;

        listening = false;
        if (keyController.get_widget())
            keyController.get_widget().remove_controller(keyController);
        updateUi();
    };

    captureButton.connect('clicked', () => {
        if (listening) {
            stopListening();
            return;
        }

        listening = true;
        window.add_controller(keyController);
        updateUi();
    });
    clearButton.connect('clicked', () => {
        settings.set_string(key, '');
        stopListening();
        updateUi();
    });
    keyController.connect('key-pressed', (_controller, keyval, keycode, state) => {
        if (!listening)
            return Gdk.EVENT_PROPAGATE;

        let mask = state & Gtk.accelerator_get_default_mod_mask();
        mask &= ~Gdk.ModifierType.LOCK_MASK;

        if (mask === 0) {
            switch (keyval) {
            case Gdk.KEY_BackSpace:
                settings.set_string(key, '');
                stopListening();
                return Gdk.EVENT_STOP;
            case Gdk.KEY_Escape:
                stopListening();
                return Gdk.EVENT_STOP;
            default:
                break;
            }
        }

        if (!isValidShortcut({mask, keycode, keyval}) || !Gtk.accelerator_valid(keyval, mask))
            return Gdk.EVENT_STOP;

        settings.set_string(key, Gtk.accelerator_name_with_keycode(null, keyval, keycode, mask));
        stopListening();
        return Gdk.EVENT_STOP;
    });
    window.connect('close-request', () => {
        stopListening();
        return false;
    });
    row.add_suffix(clearButton);
    row.add_suffix(captureButton);
    row.activatable_widget = captureButton;
    return row;
}

export default class PanelEmptySpaceActionsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const actionOptions = getActionOptions();

        window.set_default_size(720, 520);
        window.set_search_enabled(true);

        const page = new Adw.PreferencesPage({
            title: _('Panel Actions'),
            icon_name: 'input-mouse-symbolic',
        });
        window.add(page);

        const introGroup = new Adw.PreferencesGroup({
            title: _('Triggering'),
            description: _('Only empty areas of the top panel respond. Buttons, tray icons, the clock, and menus are ignored automatically.'),
        });
        page.add(introGroup);
        introGroup.add(new Adw.ActionRow({
            title: _('Gesture map'),
            subtitle: _('Left button uses double-click. Middle and right buttons use single-click.'),
        }));

        const actionsGroup = new Adw.PreferencesGroup({
            title: _('Mouse actions'),
            description: _('Each panel gesture can be bound to a different action, or multiple gestures can share the same action.'),
        });
        page.add(actionsGroup);
        actionsGroup.add(createDropdownRow(
            settings,
            'primary-action',
            _('Left double-click'),
            _('Default: Minimize current window'),
            actionOptions
        ));
        actionsGroup.add(createDropdownRow(
            settings,
            'middle-action',
            _('Middle click'),
            _('Default: Maximize / restore'),
            actionOptions
        ));
        actionsGroup.add(createDropdownRow(
            settings,
            'secondary-action',
            _('Right click'),
            _('Default: Show desktop / restore'),
            actionOptions
        ));
        actionsGroup.add(createSpinRow(
            settings,
            'minimize-restore-timeout-seconds',
            _('Timed restore window'),
            _('Used by the timed minimize / restore action. Default is 2 seconds, adjustable from 1 to 10 seconds.'),
            1,
            10
        ));

        const shortcutsGroup = new Adw.PreferencesGroup({
            title: _('Shortcut triggers'),
            description: _('When a gesture is bound to "Trigger custom shortcut", it executes the shortcut recorded here for that specific mouse button.'),
        });
        page.add(shortcutsGroup);
        shortcutsGroup.add(createShortcutCaptureRow(
            window,
            settings,
            'primary-custom-shortcut-accelerator',
            _('Left double-click shortcut'),
            _('For example, record Super+L to lock the screen when the left double-click gesture triggers a custom shortcut.'),
        ));
        shortcutsGroup.add(createShortcutCaptureRow(
            window,
            settings,
            'middle-custom-shortcut-accelerator',
            _('Middle click shortcut'),
            _('Executed when the middle click gesture is bound to trigger a custom shortcut.'),
        ));
        shortcutsGroup.add(createShortcutCaptureRow(
            window,
            settings,
            'secondary-custom-shortcut-accelerator',
            _('Right click shortcut'),
            _('Executed when the right click gesture is bound to trigger a custom shortcut.'),
        ));

        const diagnosticsGroup = new Adw.PreferencesGroup({
            title: _('Diagnostics'),
            description: _('Useful when checking blank-area hit detection, actor paths, and action dispatch.'),
        });
        page.add(diagnosticsGroup);
        diagnosticsGroup.add(createSwitchRow(
            settings,
            'debug-log-enabled',
            _('Enable debug logging'),
            _('Write click hit-testing and action dispatch information to the GNOME Shell log.'),
        ));
    }
}
