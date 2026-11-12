# Lane layout

## Behavior

- Input: commits newest first, each with `sha` and `parents`.
- Output per row: the commit's `lane`, the lanes before and after the row, and the lanes added for
  extra parents (`merges`).
- The first parent continues in the commit's lane. Extra parents take a free lane, or a new lane at
  the end. There is no lane cap: a branch is never forced onto another branch's lane.
- A commit awaited by several lanes takes the leftmost one and clears the others.
- The branch checked out in the repo keeps the leftmost lane: after layout, lanes are permuted so
  that branch's lane is 0, the rest keep their first-appearance order. Every row is permuted the
  same way, so `row.after[l]` always equals the next row's `before[l]`.

## Drawing

- One SVG per row, drawn on a single coordinate system: lane lines, horizontal fan, quarter-arc
  corners. The avatar circle is painted last and covers the joints.
- Rows overlap by two pixels so image-edge antialiasing cannot leave a seam.
- Fans are drawn left to right; each branch's run and corner use that branch's color, so the
  shared part takes the outermost color while every corner keeps its own.
