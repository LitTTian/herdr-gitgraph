#!/bin/bash
# Mirror every mod in this repo into the Herdr app's mods folder.
#
# A symlink would be discovered by the app but changes inside it are outside the app's watched
# folder, so hot reload would not fire. Real directories kept in sync do reload.
#
# Names are deliberately not `files`/`changes`: those are built-in mods, and the app renames an
# edited copy instead of loading it.
set -euo pipefail

src="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
app_home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
app_bin="${HERDR_APP_BIN:-$(command -v herdr-app || echo "$HOME/.local/bin/herdr-app")}"

for name in gitgraph ide gitgraph-tabs ide-new-menu gitgraph-menu gitgraph-pane; do
  dest="$app_home/mods/$name"
  rm -rf "$dest"
  mkdir -p "$dest"
  rsync -a "$src/mods/$name/" "$dest/"
  "$app_bin" check "$dest"
  echo "synced $dest"
done
