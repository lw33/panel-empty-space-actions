#!/usr/bin/env bash

set -euo pipefail

UUID="panel-empty-space-actions@lw33.github.com"
SCHEMA="org.gnome.shell.extensions.panel-empty-space-actions"
SCHEMA_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}/schemas"

if [[ ! -d "${SCHEMA_DIR}" ]]; then
    echo "Schema directory not found: ${SCHEMA_DIR}" >&2
    exit 1
fi

case "${1:-status}" in
    on)
        GSETTINGS_SCHEMA_DIR="${SCHEMA_DIR}" gsettings set "${SCHEMA}" debug-log-enabled true
        echo "debug logging enabled"
        ;;
    off)
        GSETTINGS_SCHEMA_DIR="${SCHEMA_DIR}" gsettings set "${SCHEMA}" debug-log-enabled false
        echo "debug logging disabled"
        ;;
    status)
        GSETTINGS_SCHEMA_DIR="${SCHEMA_DIR}" gsettings get "${SCHEMA}" debug-log-enabled
        ;;
    *)
        echo "Usage: $0 [on|off|status]" >&2
        exit 1
        ;;
esac
