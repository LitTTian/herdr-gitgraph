# herdr-gitgraph

A git history and file workspace for the [Herdr](https://herdr.dev) app: a commit graph with commit
details and a changed-file list, plus a file browser and editor that shows the diff of a clicked
file.

![Commit graph](docs/images/gitgraph.png)

![Diff in the editor](docs/images/diff.png)

| Mod | What it does |
|---|---|
| `gitgraph` | History panel: lane graph with branch badges, paging, commit details, changed files. |
| `ide` | File tree + editor in one pane, with preview tabs, diffs, saving. |
| `gitgraph-tabs` | Copy of the app's tab bar that opens `ide-new-menu` (see `NOTICE.md`). |
| `ide-new-menu` | The **+** menu, with **Open IDE here** and **Open GitGraph here**. |
| `gitgraph-menu` | Terminal right-click menu, with **Open in IDE** and **Open in GitGraph**. |
| `gitgraph-pane` | Pane header used by the layout: shows a mod pane's folder. |

Panels open like terminals — from the **+** menu, a terminal's right-click menu, or `mod.open` —
and close like panes. The layout in `layout/ide.json` holds terminals only; panels are created on
demand.

## Behavior

- **History panel**
  - 19 px rows: lane graph, subject, relative time, short hash.
  - Branch tips carry a rectangular branch badge; several tips on one commit show the oldest name
    and `+N`.
  - Uncommitted worktrees show a dashed node above their HEAD commit.
  - 200 commits per page; the next page loads when the list reaches its last row. Refreshes keep the
    loaded depth.
  - Details: avatar (GitHub photo or initials on the lane color), name/email, date/hash, Markdown
    message, and the changed-file list.
  - Changed files switch between a list (name first, directory after) and a grouped tree; the
    message/list divider drags vertically.
  - The list keeps 115 px and the details 300 px; below 600 px only the graph is drawn.
- **Editor**
  - File tree, one tab per open file, preview tabs (italic) that a click replaces, pinned tabs,
    unsaved dots, `ctrl-s` to save.
  - A changed file opens in the IDE of the current tab, or in a new pane below; diff tabs reload
    themselves when reselected.

## Install and develop

Requires the Herdr app (`herdr-app` on `PATH`) and Node 20+.

```bash
just check     # node --test + herdr-app check for every mod
just sync      # mirror the mods into ~/.config/herdr-app/mods
just layout    # install layout/ide.json and switch to it
just keys      # bind cmd-shift-g / cmd-shift-i / ctrl-s
```

Git is read-only: every command runs with `--no-optional-locks -c core.fsmonitor=false
-c diff.autoRefreshIndex=false`, so folder watch never sees Herdr write under `.git`.

## Specs

The implementation follows these specs (SDD):

- [00 – Overview](specs/00-overview.md)
- [01 – Lane layout](specs/01-graph-layout.md)
- [02 – Commit list and paging](specs/02-commit-list.md)
- [03 – Commit details](specs/03-commit-details.md)
- [04 – Changed files](specs/04-changed-files.md)
- [05 – Opening a file](specs/05-diff-handoff.md)
- [06 – Pane header](specs/06-pane-header.md)
- [07 – Panel layout](specs/07-layout.md)
- [08 – Performance](specs/08-performance.md)

## Status

Implemented: the commit graph and the changed-file list, with commit details, paging, worktree
markers, and the editor integration needed to view a file's diff.

Not implemented yet: search, branch/tag management, remotes and fetch/pull/push, staging and
committing, commit actions (cherry-pick, revert, …), blame, file history browsing from arbitrary
refs, and settings. These are future work; the panels are read-only today.

## Known issues

- Under fractional UI zoom the graph can still be off by one pixel at some joints.
- Rows in the virtual list cannot hover-highlight: the app forbids item handlers there.
- A split pane's own header text belongs to the app; only the folder is supplied by this project.
- Avatars need network access; without it (or without a GitHub account) initials are shown.
- Paging loads only at the very bottom of the list.

## Acknowledgment

Thanks to the GitLens project (<https://github.com/gitkraken/vscode-gitlens>) for the reference
experience of the commit graph and the changed-file views. No code was copied from it.
