# Opening a file

- Clicking a changed file targets the IDE pane in the current tab. If there is none, a new IDE pane
  is split below and the request travels in its props; no pane id is needed.
- A single click opens an italic preview diff; double click pins it.
- Diff tabs remember their request. Switching back to one re-runs `git show`; leaving it for a
  normal file does not lose it. Closing the active tab activates its neighbour through the same
  path, so a diff neighbour reloads instead of reading the working tree.
- Each shared request is consumed once: a manually selected diff tab is not overwritten by the
  newest request.
- A relative path is resolved under the panel's root; only a missing file reports "no longer
  available".
