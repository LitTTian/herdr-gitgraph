# Glossary

Terms used by this project. No implementation details.

- **Mod** — a panel of the Herdr app, written as JavaScript that describes native UI. A mod shows
  information and can run commands, but it is not a process of its own.
- **Space** — a named place to work in the Herdr app, on one machine. Each space holds tabs.
- **Tab** — a piece of work inside a space; it holds terminals and mod panes.
- **Pane** — a rectangle in a tab. It shows either a terminal or a mod.
- **Terminal** — a program running in a pane, kept alive by herdr-core (`hc`).
- **Repo** — a git working tree, the unit the history panel is about. One pane belongs to at most
  one repo.
- **Worktree** — an additional checkout of the same repo. Each worktree has its own HEAD and working
  tree.
- **Commit** — an immutable point in a repo's history, with an author, a time and a message.
- **Ref** — a name that points at a commit: a branch, a tag, or a remote-tracking branch.
- **Lane** — a vertical column in the commit graph. One lane carries one line of history.
- **Changed file** — a file that differs in a commit or in the working tree, with added and removed
  line counts.
- **Details** — what the history panel shows about one commit: author, time, message, changed files.
- **History** — the ordered commits of a repo, newest first.
- **File history** — the commits that touched one file, followed across renames.
- **Diff tab** — an editor tab that shows the change of one file in one commit.
- **Preview tab** — an italic tab that the next single click replaces; editing or double-clicking
  pins it.
- **IDE layout** — the window arrangement shipped in `layout/ide.json`.
