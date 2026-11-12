# Performance

Paths reachable from render are multiplicative. The panel therefore:

- computes lanes and the row list once per refresh/page, never in render;
- builds row SVGs in `prepareRows`, reusing rows already prepared and only drawing the new tail;
- keys SVG cache files by the drawing plus the author, not by the embedded avatar bytes;
- renders only visible rows through the virtual list;
- skips the row rebuild when commits, worktrees and the palette are unchanged.
