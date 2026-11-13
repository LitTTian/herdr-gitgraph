# Panel layout

- The list keeps at least 115 px; the details at least 300 px.
- The panel reports its real width: the header and the list may shrink, so content never pushes the
  measured width past the pane.
- Below 600 px the details column and the divider are not rendered; the graph uses the full width.
- The list/details divider drags horizontally and the list width is stored.

- A Markdown file opened in the IDE shows a Source/Preview switch at the right of the header.
  Preview renders the current text (including unsaved edits) read-only; Source is the editor.

- A Save button sits at the right of the tab bar while a file is open; it is accent-colored when
  the active file has unsaved edits and saves through the same path as `ctrl-s`.

## Row graphics and zoom

Commit rows and worktree rows are generated SVGs with the same coordinates:
19 px rows, an 18 px lane pitch (14 px lane + 4 px gap), 2 px horizontal padding and 2 px of
vertical bleed, with lane centers at `2 + 18L + 7`. Both are rendered by the same image path and
cached per content, so changing the window zoom scales one integer grid instead of re-aligning
separate painters. Keep new row graphics on that grid; do not add per-zoom offsets.

## Details placement

Two header buttons (Herdr's `mods/pane/split-right.svg` and `split-down.svg` icons) switch the
details column between a right split and a bottom split; clicking the active button hides the
details (`hidden`), and the choice is stored per pane (`gitgraph.detailsPlacement`). The drag
handle between list and details resizes the list width, and in bottom mode dragging it up grows
the panel. The splitter inside the details always resizes the message block, so the file list
height follows in both modes. The right mode's message-block height
(`gitgraph.detailsHeight`) and the bottom panel height (`gitgraph.bottomHeight`) persist separately
and are clamped against the pane, so switching modes can never hide the file list. There is no width cutoff that hides the
details: list and details always share the pane.
