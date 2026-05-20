#!/usr/bin/env bash

set -euo pipefail

UUID="panel-empty-space-actions@lw33.github.com"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

mkdir -p "${TARGET_DIR}"
cp "${SOURCE_DIR}/metadata.json" "${TARGET_DIR}/metadata.json"
cp "${SOURCE_DIR}/extension.js" "${TARGET_DIR}/extension.js"
cp "${SOURCE_DIR}/prefs.js" "${TARGET_DIR}/prefs.js"

rm -rf "${TARGET_DIR}/schemas"
mkdir -p "${TARGET_DIR}/schemas"
cp "${SOURCE_DIR}/schemas/"*.xml "${TARGET_DIR}/schemas/"
glib-compile-schemas "${TARGET_DIR}/schemas"

rm -rf "${TARGET_DIR}/locale"
if [[ -d "${SOURCE_DIR}/locale" ]]; then
    mkdir -p "${TARGET_DIR}/locale"
    cp -a "${SOURCE_DIR}/locale/." "${TARGET_DIR}/locale/"
fi

gnome-extensions disable "${UUID}" >/dev/null 2>&1 || true

if gnome-extensions enable "${UUID}" >/dev/null 2>&1; then
    echo "Installed and enabled ${UUID}"
else
    echo "Installed ${UUID}"
    echo "GNOME Shell has not picked up the new UUID yet. Reload GNOME Shell or log out and back in, then enable it manually."
fi
