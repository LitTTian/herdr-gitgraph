// Pure parsing of git output. No host imports: covered by the Node test runner.

const US = "\x1f";
const RS = "\x1e";

// One git log record: full sha, short sha, author, email, unix time, ref decoration, subject.
export const LOG_FORMAT = ["%H", "%h", "%an", "%ae", "%at", "%D", "%P", "%s"].join("%x1f") + "%x1e";

// One commit header: author, email, ISO date, full message.
export const META_FORMAT = ["%an", "%ae", "%aI", "%B"].join("%x1f");

export function parseRefs(text, remotes = ["origin"]) {
  if (!text) return [];
  return text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((name) => {
      if (name.startsWith("HEAD -> ")) return { kind: "head", name: name.slice(8) };
      if (name === "HEAD") return { kind: "head", name };
      if (name.startsWith("tag: ")) return { kind: "tag", name: name.slice(5) };
      if (remotes.some((remote) => name.startsWith(`${remote}/`))) return { kind: "remote", name };
      return { kind: "branch", name };
    });
}

export function parseLog(text, remotes = ["origin"]) {
  const commits = [];
  for (const raw of text.split(RS)) {
    const record = raw.replace(/^[\r\n]+/, "");
    if (!record) continue;
    const fields = record.split(US);
    if (fields.length < 8) continue;
    const [sha, short, author, email, at, decoration, parents] = fields;
    commits.push({
      sha,
      short,
      author,
      email,
      at: Number(at) || 0,
      parents: parents.split(" ").filter(Boolean),
      refs: parseRefs(decoration, remotes),
      subject: fields.slice(7).join(US),
    });
  }
  return commits;
}

export function parseNumstat(text) {
  const files = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [added, removed, ...rest] = parts;
    const binary = added === "-" || removed === "-";
    files.push({
      path: rest.join("\t"),
      add: binary ? 0 : Number(added) || 0,
      del: binary ? 0 : Number(removed) || 0,
      binary,
    });
  }
  return files;
}

export function parseShowMeta(text) {
  const first = text.indexOf(US);
  const second = text.indexOf(US, first + 1);
  const third = text.indexOf(US, second + 1);
  if (first < 0 || second < 0 || third < 0) {
    return { author: "", email: "", date: "", message: text.trim() };
  }
  return {
    author: text.slice(0, first),
    email: text.slice(first + 1, second),
    date: text.slice(second + 1, third),
    message: text.slice(third + 1).replace(/\n+$/, ""),
  };
}

export function relativeTime(atSeconds, nowSeconds) {
  const seconds = Math.floor(nowSeconds - atSeconds);
  if (seconds <= 0) return "now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

// `git worktree list --porcelain -z` records are NUL-separated, one attribute per token.
export function parseWorktrees(text) {
  const entries = [];
  let current = null;
  const tokens = String(text ?? "").split("\0");
  for (const token of tokens) {
    if (!token) {
      if (current) entries.push(current);
      current = null;
      continue;
    }
    const space = token.indexOf(" ");
    const key = space < 0 ? token : token.slice(0, space);
    const value = space < 0 ? "" : token.slice(space + 1);
    if (key === "worktree") {
      if (current) entries.push(current);
      current = { path: value, head: null, branch: null };
    } else if (key === "HEAD" && current) {
      current.head = value;
    } else if (key === "branch" && current) {
      current.branch = value.replace(/^refs\/heads\//, "");
    }
  }
  if (current) entries.push(current);
  return entries.filter((entry) => entry.path);
}

// `git for-each-ref` fields: sha, short name, committer unix time, HEAD marker.
export function parseBranches(text) {
  return String(text ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, name, at, head] = line.split("\t");
      return { sha, name, at: Number(at) || 0, head: head === "*" };
    })
    .filter((branch) => branch.sha && branch.name);
}

// Branch labels degrade from full name to "…/last-segment" and then to "/seg…".
export function branchLabel(name, maxChars = 20) {
  const value = String(name ?? "");
  if (value.length <= maxChars) return value;
  const parts = value.split("/");
  const last = parts[parts.length - 1] || value;
  const shortened = `…/${last}`;
  if (shortened.length <= maxChars) return shortened;
  return `/${last.slice(0, Math.max(1, maxChars - 2))}…`;
}

// Counts working-tree states from `git status --porcelain=v1 -z`.
export function parseStatusCounts(text) {
  const counts = { added: 0, modified: 0, deleted: 0 };
  const tokens = String(text ?? "").split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token || token.length < 3) continue;
    const x = token[0];
    const y = token[1];
    if (x === "R" || x === "C") i += 1; // the old path follows
    if (x === "?" && y === "?") counts.added += 1;
    else if (x === "A" || y === "A") counts.added += 1;
    else if (x === "D" || y === "D") counts.deleted += 1;
    else counts.modified += 1;
  }
  return counts;
}

// One entry per changed path, with the display letter (U for untracked) and its path.
export function parseStatusPaths(text) {
  const tokens = String(text ?? "").split("\0");
  const files = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.length < 4) continue;
    const x = token[0];
    const y = token[1];
    const path = token.slice(3);
    // A rename or copy carries its old path as the next token; it is not a separate change.
    if (x === "R" || x === "C" || y === "R" || y === "C") i += 1;
    let letter = "M";
    if (x === "?") letter = "U";
    else if (x === "A" || y === "A") letter = "A";
    else if (x === "D" || y === "D") letter = "D";
    else if (x === "R" || y === "R") letter = "R";
    files.push({ status: letter, path });
  }
  return files;
}
