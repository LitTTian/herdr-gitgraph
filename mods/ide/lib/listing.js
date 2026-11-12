// The shell program the browser runs for one folder. Kept pure so tests can execute exactly it.
// `-p`/`ls` is not used: `ls -p` does not mark symlinked directories, and it lists .git.
export const LISTING = [
  'for p in "$1"/* "$1"/.[!.]*; do',
  '  [ -e "$p" ] || [ -L "$p" ] || continue',
  '  n=${p##*/}',
  '  [ "$n" = .git ] && continue',
  '  if [ -d "$p" ]; then printf "d\\0%s\\0" "$n"; else printf "f\\0%s\\0" "$n"; fi',
  "done",
].join("\n");
