# Overview

## Goal

A git history workspace for the Herdr app: a commit graph with commit details and a changed-file
list, plus a file browser/editor that shows the diff of a clicked file.

## Surfaces

- `gitgraph` — history panel. Left: commit list with the lane graph. Right: commit details and the
  changed-file list (hidden on narrow panes).
- `ide` — tree + editor in one pane. Tree on the left, tabs and code (or a diff) on the right.
- `gitgraph-tabs`, `ide-new-menu`, `gitgraph-menu` — copies of the app's tab bar and menus that add
  entries for the two panels.
- `gitgraph-pane` — the pane header used by the shipped layout; it shows a mod pane's folder.

## Constraints

- Read-only git. Every command runs with `--no-optional-locks -c core.fsmonitor=false
  -c diff.autoRefreshIndex=false`; nothing is written under `.git`.
- The panels keep the folder they were created with; focus changes never move them.
- State is separated from runtime: layout and row geometry are computed in pure helpers covered by
  `node --test`.
