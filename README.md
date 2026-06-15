# Panel Empty Space Actions

Configurable mouse actions for empty space in the GNOME top panel.

## Features

- Separate actions for left double-click, middle click, and right click
- Optional capture of a left single click on empty panel space to suppress the panel default behavior
- Window actions: minimize, timed minimize/restore, show desktop, maximize/restore, close, always on top, hide all normal windows
- Per-trigger custom shortcut bindings
- Optional debug logging
- Chinese translation included

## Notes

- Targets GNOME Shell 46 through 50
- Ignores clicks on panel buttons, menus, clock, tray icons, and indicators
- On X11, custom shortcuts are sent with `xdotool` when available; when it is missing, the extension falls back safely
- On Wayland, custom shortcuts fall back to known GNOME actions and matching custom command shortcuts
- The extension does not execute arbitrary shell text from its own settings; it only triggers built-in GNOME actions or existing GNOME custom keybindings configured by the user

## Source and License

- Source: `https://github.com/lw33/panel-empty-space-actions`
- License: MIT

## Local install

```bash
./install.sh
```

## Debug logging

```bash
./debug.sh on
./debug.sh off
./debug.sh status
```
