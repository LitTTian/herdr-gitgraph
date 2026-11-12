# Commit list

## Rows

- 19 px rows: lane graph, branch badge, subject, relative time, short hash.
- Branch tips show a rectangular badge with the branch name (oldest branch when several share the
  commit; the rest are summarised as `+N`).
- Uncommitted worktrees get a dashed node above their HEAD commit, labelled with the branch.
- Message starts right after the row's own graph, not at a fixed column.

## Virtualisation and paging

- The list is a virtual list; rows are built for the visible range only.
- A page is requested when the visible range includes the last row. 200 commits per page.
- Paging grows the requested limit and replaces the list (`loaded + 200`), instead of `--skip`:
  positional skipping re-runs the traversal and drifts when refs move.
- A page that adds nothing stops paging; a watchdog clears a stuck loading state after 30 s.
- Refresh (timer/watch) reloads at least the already loaded depth.
