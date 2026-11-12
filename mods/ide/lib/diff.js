// Pure parsing of unified diff lines into side-by-side rows. No host imports.
//
// A row is one of:
//   {kind: "meta"|"hunk"|"other", text}
//   {kind: "ctx"|"add"|"del", left, right}  where a side is {no, text} or null
export function splitDiff(lines) {
  const rows = [];
  let oldNo = 0;
  let newNo = 0;

  for (const raw of lines) {
    const line = String(raw ?? "");

    if (line.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      if (match) {
        oldNo = Number(match[1]);
        newNo = Number(match[2]);
      }
      rows.push({ kind: "hunk", text: line });
      continue;
    }

    if (
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("new file mode") ||
      line.startsWith("deleted file mode") ||
      line.startsWith("similarity index") ||
      line.startsWith("rename ")
    ) {
      rows.push({ kind: "meta", text: line });
      continue;
    }

    if (line.startsWith("+")) {
      rows.push({ kind: "add", left: null, right: { no: newNo++, text: line.slice(1) } });
      continue;
    }
    if (line.startsWith("-")) {
      rows.push({ kind: "del", left: { no: oldNo++, text: line.slice(1) }, right: null });
      continue;
    }
    if (line.startsWith(" ")) {
      const text = line.slice(1);
      rows.push({ kind: "ctx", left: { no: oldNo++, text }, right: { no: newNo++, text } });
      continue;
    }
    if (line === "") continue;
    rows.push({ kind: "other", text: line });
  }

  return rows;
}
