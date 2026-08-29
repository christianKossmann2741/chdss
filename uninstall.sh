#!/usr/bin/env bash
set -euo pipefail
app_dir="${CHDSS_HOME:-$HOME/.local/share/chdss}"
bin_dir="${CHDSS_BIN_DIR:-$HOME/.local/bin}"
rm -f "$bin_dir/chdss"
rm -rf "$app_dir"
printf "Removed CHDSS from %s and %s/chdss.\n" "$app_dir" "$bin_dir"
