# Commit list

## Rows

- 19 px rows: lane graph, branch badge, subject, relative time, short hash.
- Branch tips show a rectangular badge with the branch name (oldest branch when several share the
  commit; the rest are summarised as `+N`).
- The checked-out branch's node uses the current time, so it sorts above every commit; every other
  worktree's node sits directly above its HEAD commit with a dashed link drawn down into that
  commit node. A dirty worktree shows a solid dot inside its dashed ring. The label is followed by
  `+added ~modified -deleted`; the newest changed-file mtime is right-aligned where commit dates
  sit, and no hash is shown. Clicking a node opens its path, branch, HEAD and files.
- Node rows keep the other lanes' vertical lines, so another branch's line is never cut off.
- Lane 0 is reserved for the checked-out branch's history; other branches never reuse it.
- Message starts right after the row's own graph, not at a fixed column.

## Virtualisation and paging

- The list is a virtual list; rows are built for the visible range only.
- A page is requested when the visible range includes the last row. 200 commits per page.
- Paging grows the requested limit and replaces the list (`loaded + 200`), instead of `--skip`:
  positional skipping re-runs the traversal and drifts when refs move.
- A page that adds nothing stops paging; a watchdog clears a stuck loading state after 30 s.
- Refresh (timer/watch) reloads at least the already loaded depth.
