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
if [[ -d "${SOURCE_DIR}/po" ]]; then
    while IFS= read -r -d '' po_file; do
        locale_name="$(basename "${po_file}" .po)"
        mo_dir="${SOURCE_DIR}/locale/${locale_name}/LC_MESSAGES"
        mkdir -p "${mo_dir}"
        msgfmt "${po_file}" -o "${mo_dir}/panel-empty-space-actions.mo"
    done < <(find "${SOURCE_DIR}/po" -maxdepth 1 -name '*.po' -print0)
fi

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
