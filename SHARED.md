# Shared values between these mods

Herdr app mods talk to each other through the app's global `shared` store.

## `ide.diff.<pane>`

Published by `gitgraph` when a changed file is clicked and an IDE pane already exists in the tab;
read by that pane's `ide` copy. Each request is consumed once, so switching between diff tabs does
not reopen the newest one.

```json
{ "repo": "/abs/repo", "sha": "ee5bfb5", "base": "1939e2c", "path": "docs/skill.mdx",
  "name": "skill.mdx", "pinned": false }
```

A new IDE pane created for the click receives the same object as its `props.diff`; no shared value
is involved.

## `title.<pane>` and `title.<mod>`

Published by `gitgraph` and `ide`: the folder the panel was created with, abbreviated with `~`.
`gitgraph-pane` (the pane header) shows `title.<pane>` for a mod pane and falls back to
`title.<mod>`.
