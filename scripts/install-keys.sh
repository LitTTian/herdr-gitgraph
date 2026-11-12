#!/bin/bash
# Merge this repo's key bindings into the app's keys.json, keeping anything already bound.
# A backup is written next to keys.json first. The app does not merge mod keys on its own.
set -euo pipefail

app_home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
keys="$app_home/keys.json"
mkdir -p "$app_home"
[ -f "$keys" ] || printf '{}\n' > "$keys"
cp "$keys" "$keys.bak-$(date +%Y%m%d-%H%M%S)"

python3 - "$keys" <<'PY'
import json, sys

path = sys.argv[1]
data = json.load(open(path))
global_keys = data.setdefault("global", {})

# Bindings this installer added before the mods were merged are replaced, not left dangling.
stale = {"mod.open:browser", "mod.open:editor"}
for key in [k for k, v in global_keys.items() if v in stale]:
    del global_keys[key]

wanted = {
    "cmd-shift-g": "mod.open:gitgraph",
    "cmd-shift-i": "mod.open:ide",
}
for key, value in wanted.items():
    if key in global_keys and global_keys[key] != value:
        print(f"{key}: kept existing {global_keys[key]!r}")
        continue
    global_keys[key] = value
    print(f"{key}: bound {value}")

editor = data.get("mod:editor")
if isinstance(editor, dict) and editor.get("ctrl-s") == "editor.save":
    del data["mod:editor"]
ide = data.setdefault("mod:ide", {})
ide.setdefault("ctrl-s", "ide.save")
ide.setdefault("ctrl-shift-s", "ide.save-all")
print("mod:ide ctrl-s/ctrl-shift-s:", ide["ctrl-s"], "/", ide["ctrl-shift-s"])

json.dump(data, open(path, "w"), indent=2)
PY

echo "wrote $keys (backup alongside)"
