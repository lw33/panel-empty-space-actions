# Panel Empty Space Actions

Configurable mouse actions for empty space in the GNOME top panel.

## Features

- Separate actions for left double-click, middle click, and right click
- Window actions: minimize, timed minimize/restore, show desktop, maximize/restore, close, always on top, hide all normal windows
- Per-trigger custom shortcut bindings
- Optional debug logging
- Chinese translation included

## Notes

- Targets GNOME Shell 46
- Ignores clicks on panel buttons, menus, clock, tray icons, and indicators
- On X11, custom shortcuts are sent with `xdotool` when available
- On Wayland, custom shortcuts fall back to known GNOME actions and matching custom command shortcuts

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
