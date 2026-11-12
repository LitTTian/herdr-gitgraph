# Commit details

- Author block: 24 px avatar (GitHub photo when available, otherwise initials on the commit's lane
  color), name and email on the right, then a row with the date left and the short hash right.
- The full commit message renders as Markdown.
- The message area and the changed-file list are separated by a 5 px divider that drags vertically
  (message ≥ 80 px); the height is remembered.
- A merge shows the first-parent diff. A scoped file that did not exist at the commit falls back to
  the whole commit with a note.
