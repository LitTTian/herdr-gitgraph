#!/bin/bash
# Install the IDE layout into the Herdr app and optionally switch to it.
set -euo pipefail

src="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
app_home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
app_bin="${HERDR_APP_BIN:-$(command -v herdr-app || echo "$HOME/.local/bin/herdr-app")}"

mkdir -p "$app_home/layouts"
cp "$src/layout/ide.json" "$app_home/layouts/ide.json"
echo "installed $app_home/layouts/ide.json"

if [ "${1:-}" = "--switch" ]; then
  "$app_bin" do layout.switch '{"name":"ide"}'
fi
