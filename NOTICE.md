# Third-party notices

The Herdr app is licensed under the Apache License 2.0. Some files here are copies of the app's
shipped mods, with the listed edits, because the app has no hook for the new-tab menu:

| Path | Upstream | Edits |
|---|---|---|
| `mods/gitgraph-tabs/main.js` | `herdr-app/defaults/mods/tabs/main.js` | opens `ide-new-menu` for the `+` button |
| `mods/ide-new-menu/main.js` | `herdr-app/defaults/mods/new-menu/main.js` | adds "Open IDE here" and "Open GitGraph here" rows (pane splits); taller popup |
| `mods/gitgraph-menu/main.js` | `herdr-app/defaults/mods/menu/main.js` | adds "Open in IDE" / "Open in GitGraph"; own ids |
| `mods/gitgraph-pane/main.js` | `herdr-app/defaults/mods/pane/main.js` | a mod pane shows the folder published under `title.<pane>` |
| `mods/ide/chevron-*.svg` | `herdr-app/defaults/mods/files/` | unchanged tree chevrons |

They are pinned to the app version they were copied from. When the app's tab bar or menus change,
re-copy the upstream file, re-apply the listed edits, and run `just check`.
