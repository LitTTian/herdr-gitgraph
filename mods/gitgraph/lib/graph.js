// Pure lane layout for the commit graph. No host imports: covered by the Node test runner.
//
// Each row says which lane the commit occupies, which lanes existed before it, which exist after
// it (first parent stays in the commit's lane), and where extra parents were added (merges).

export const MAX_LANES = 8;

function freeLane(lanes, start, reserved = null) {
  for (let lane = start; lane < lanes.length; lane++) {
    if (lane !== reserved && lanes[lane] == null) return lane;
  }
  let lane = Math.max(lanes.length, start);
  if (lane === reserved) lane += 1;
  return lane;
}

// The checked-out branch is its first-parent chain: the walk that keeps the leftmost lane.
function mainlineShas(commits, tip) {
  if (!tip) return null;
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
  if (!bySha.has(tip)) return null;
  const seen = new Set();
  let sha = tip;
  while (sha && bySha.has(sha) && !seen.has(sha)) {
    seen.add(sha);
    sha = bySha.get(sha).parents?.[0] ?? null;
  }
  return seen;
}

export function layoutGraph(commits, maxLanes = MAX_LANES, activeTip = null) {
  const lanes = []; // lane index -> sha expected next, or null
  const rows = [];
  // The first-parent chain of the checked-out branch owns its lane; no other commit may take it.
  const mainline = mainlineShas(commits, activeTip);
  let mainLane = null;

  for (const commit of commits) {
    const isMain = Boolean(mainline?.has(commit.sha));
    let lane;
    if (isMain && mainLane == null) {
      // The tip gets a fresh slot: a lane another branch already waits in stays that branch's,
      // so the reserved lane cannot leak back to it through the left-to-right renumbering.
      lane = lanes.length;
    } else if (isMain && lanes[mainLane] === commit.sha) {
      lane = mainLane;
    } else {
      lane = lanes.indexOf(commit.sha);
    }
    if (lane < 0) lane = freeLane(lanes, 0, isMain ? null : mainLane);
    // The lane is reserved as soon as the tip takes it, before any merge slot is allocated.
    if (isMain && mainLane == null) mainLane = lane;
    const before = lanes.slice();

    // A commit can be awaited by several lanes (a branch tip and a merge source).
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === commit.sha && i !== lane) lanes[i] = null;
    }

    const parents = commit.parents ?? [];
    lanes[lane] = parents[0] ?? null;

    const merges = [];
    for (const parent of parents.slice(1)) {
      if (lanes.includes(parent)) continue;
      const slot = freeLane(lanes, 0, mainLane);
      lanes[slot] = parent;
      merges.push(slot);
    }

    // Keep the reserved lane real: a trailing hole there must not be popped and later reused.
    while (lanes.length && lanes[lanes.length - 1] == null && lanes.length - 1 !== mainLane) lanes.pop();

    rows.push({ sha: commit.sha, lane, before, after: lanes.slice(), merges });
  }

  if (!activeTip) return rows;
  const activeRow = commits.findIndex((commit) => commit.sha === activeTip);
  if (activeRow < 0) return rows;
  const activeLane = rows[activeRow].lane;

  // Lanes are ordered by first appearance (commit time); the active branch moves to the left.
  const firstSeen = new Map();
  rows.forEach((row, index) => {
    const seen = new Set([row.lane, ...row.merges]);
    row.before.forEach((value, lane) => {
      if (value != null) seen.add(lane);
    });
    row.after.forEach((value, lane) => {
      if (value != null) seen.add(lane);
    });
    for (const lane of seen) if (!firstSeen.has(lane)) firstSeen.set(lane, index);
  });
  const order = [...firstSeen.keys()].sort((a, b) => {
    if (a === activeLane) return -1;
    if (b === activeLane) return 1;
    return firstSeen.get(a) - firstSeen.get(b);
  });
  const pos = new Map(order.map((lane, index) => [lane, index]));
  const move = (lane) => (lane == null ? lane : pos.get(lane) ?? lane);
  return rows.map((row) => {
    const before = [];
    row.before.forEach((value, lane) => {
      // A hole moved onto another lane would erase that lane's sha; only real entries move.
      if (value != null) before[move(lane)] = value;
    });
    const after = [];
    row.after.forEach((value, lane) => {
      if (value != null) after[move(lane)] = value;
    });
    // Every row is permuted the same way; keeping one row's lane in sync by hand would break
    // the invariant that row.after[l] equals the next row's before[l].
    return { sha: row.sha, lane: move(row.lane), before, after, merges: row.merges.map(move) };
  });
}

function rowLanes(row) {
  let width = row.lane + 1;
  row.before.forEach((value, index) => {
    if (value != null) width = Math.max(width, index + 1);
  });
  row.after.forEach((value, index) => {
    if (value != null) width = Math.max(width, index + 1);
  });
  for (const lane of row.merges) width = Math.max(width, lane + 1);
  return width;
}

export function rowLaneWidth(row) {
  return rowLanes(row);
}

export function graphWidth(rows) {
  return rows.reduce((width, row) => Math.max(width, rowLanes(row)), 1);
}

// The lane diagram for one row, `width` lanes wide. Two characters per lane keeps the lines apart
// in a monospace font.
export function graphText(row, width) {
  const columns = Math.max(1, width * 2 - 1);
  const chars = Array(columns).fill(" ");
  const at = (lane) => lane * 2;

  for (let lane = 0; lane < width; lane++) {
    if (lane === row.lane) {
      chars[at(lane)] = "●";
      continue;
    }
    const was = row.before[lane] != null;
    const now = row.after[lane] != null;
    if (was && now) chars[at(lane)] = "│";
    else if (was && !now) chars[at(lane)] = "╯";
    else if (!was && now) chars[at(lane)] = "╮";
  }

  // A lane that ends on this row joins the commit with a horizontal run.
  for (let lane = 0; lane < width; lane++) {
    if (lane === row.lane) continue;
    if (row.before[lane] == null || row.after[lane] != null) continue;
    const from = Math.min(row.lane, lane);
    const to = Math.max(row.lane, lane);
    for (let column = at(from) + 1; column < at(to); column++) {
      if (chars[column] === " ") chars[column] = "─";
    }
  }

  for (const target of row.merges) {
    const from = Math.min(row.lane, target);
    const to = Math.max(row.lane, target);
    for (let column = at(from) + 1; column < at(to); column++) {
      if (chars[column] === " ") chars[column] = "─";
    }
    const corner = at(to);
    if (corner < columns) chars[corner] = target > row.lane ? "╮" : "╭";
  }

  return chars.join("").replace(/\s+$/, "");
}

// Split a row's diagram into per-lane runs, so the caller can color each lane.
export function graphRuns(row, width) {
  const text = graphText(row, width).padEnd(width * 2 - 1, " ");
  const runs = [];
  for (let index = 0; index < text.length; index++) {
    const lane = Math.min(width - 1, Math.floor(index / 2));
    const ch = text[index];
    const last = runs[runs.length - 1];
    if (last && last.lane === lane) last.text += ch;
    else runs.push({ lane, text: ch });
  }
  return runs;
}
