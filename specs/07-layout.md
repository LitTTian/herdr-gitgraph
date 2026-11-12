# Panel layout

- The list keeps at least 115 px; the details at least 300 px.
- The panel reports its real width: the header and the list may shrink, so content never pushes the
  measured width past the pane.
- Below 600 px the details column and the divider are not rendered; the graph uses the full width.
- The list/details divider drags horizontally and the list width is stored.

- A Markdown file opened in the IDE shows a Source/Preview switch at the right of the header.
  Preview renders the current text (including unsaved edits) read-only; Source is the editor.
