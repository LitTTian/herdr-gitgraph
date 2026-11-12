// Pure parsing of the browser's directory listing. No host imports.
// The shell prints NUL-separated pairs: "d" or "f", then the entry name.
export function parseListing(stdout) {
  const parts = String(stdout ?? "").split("\0");
  const entries = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const kind = parts[i];
    const name = parts[i + 1];
    if (!name || (kind !== "d" && kind !== "f")) continue;
    entries.push({ name, dir: kind === "d" });
  }
  return entries;
}

export function sortEntries(entries) {
  return [...entries].sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
}

// Files the IDE can render as a Markdown preview.
export function isMarkdownPath(path) {
  return /\.(md|mdx|markdown)$/i.test(String(path ?? ""));
}
