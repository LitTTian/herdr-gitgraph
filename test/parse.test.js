import test from "node:test";
import assert from "node:assert/strict";
import { branchLabel, parseBranches, parseLog, parseRefs, parseNumstat, parseShowMeta, parseStatusCounts, parseWorktrees, relativeTime } from "../mods/gitgraph/lib/parse.js";

const US = "\x1f";
const RS = "\x1e";

test("parseLog reads records separated by the unit separator", () => {
  const text =
    ["abc123", "abc", "Ada", "ada@example.com", "1700000000", "HEAD -> main, tag: v1", "", "first"].join(US) +
    RS +
    "\n" +
    ["def456", "def", "Bob", "bob@example.com", "1690000000", "", "", "second"].join(US) +
    RS;

  assert.deepEqual(parseLog(text), [
    {
      sha: "abc123",
      short: "abc",
      author: "Ada",
      email: "ada@example.com",
      at: 1700000000,
      parents: [],
      refs: [
        { kind: "head", name: "main" },
        { kind: "tag", name: "v1" },
      ],
      subject: "first",
    },
    {
      sha: "def456",
      short: "def",
      author: "Bob",
      email: "bob@example.com",
      at: 1690000000,
      parents: [],
      refs: [],
      subject: "second",
    },
  ]);
});

test("parseLog tolerates an empty repo and a trailing separator", () => {
  assert.deepEqual(parseLog(""), []);
  assert.deepEqual(parseLog(`${RS}\n`), []);
});

test("parseLog keeps separator characters out of the subject boundary", () => {
  const text = ["s", "s", "A", "a@x", "1", "", "", "fix: a | b"].join(US) + RS;
  assert.equal(parseLog(text)[0].subject, "fix: a | b");
});

test("parseRefs classifies head, tag, remote and branch", () => {
  assert.deepEqual(parseRefs(""), []);
  assert.deepEqual(parseRefs("HEAD -> main"), [{ kind: "head", name: "main" }]);
  assert.deepEqual(parseRefs("HEAD"), [{ kind: "head", name: "HEAD" }]);
  assert.deepEqual(parseRefs("tag: v1.0.0"), [{ kind: "tag", name: "v1.0.0" }]);
  assert.deepEqual(parseRefs("origin/main"), [{ kind: "remote", name: "origin/main" }]);
  assert.deepEqual(parseRefs("feature/x"), [{ kind: "branch", name: "feature/x" }]);
  assert.equal(parseRefs("HEAD -> main, tag: v1, origin/main").length, 3);
});

test("parseNumstat reads counts, binary markers and paths with spaces", () => {
  const text = "12\t3\tsrc/a.rs\n-\t-\tassets/logo.png\n0\t7\tdocs/my note.md\n\n";
  assert.deepEqual(parseNumstat(text), [
    { path: "src/a.rs", add: 12, del: 3, binary: false },
    { path: "assets/logo.png", add: 0, del: 0, binary: true },
    { path: "docs/my note.md", add: 0, del: 7, binary: false },
  ]);
});

test("parseShowMeta keeps a multi-line message intact", () => {
  const text = ["Ada", "ada@example.com", "2026-11-11T10:00:00+08:00", "Subject line\n\nBody text\n"].join(US);
  assert.deepEqual(parseShowMeta(text), {
    author: "Ada",
    email: "ada@example.com",
    date: "2026-11-11T10:00:00+08:00",
    message: "Subject line\n\nBody text",
  });
});

test("relativeTime is coarse and never negative", () => {
  const now = 1700000000;
  assert.equal(relativeTime(now, now), "now");
  assert.equal(relativeTime(now + 5, now), "now");
  assert.equal(relativeTime(now - 59, now), "59s ago");
  assert.equal(relativeTime(now - 60, now), "1m ago");
  assert.equal(relativeTime(now - 3599, now), "59m ago");
  assert.equal(relativeTime(now - 3600, now), "1h ago");
  assert.equal(relativeTime(now - 86400, now), "1d ago");
  assert.equal(relativeTime(now - 29 * 86400, now), "29d ago");
  assert.equal(relativeTime(now - 30 * 86400, now), "1mo ago");
  assert.equal(relativeTime(now - 365 * 86400, now), "1y ago");
});

test("parseLog classifies refs against the repo's remotes", () => {
  const text = ["s", "s", "A", "a@x", "1", "upstream/main", "", "x"].join(US) + RS;
  assert.deepEqual(parseLog(text, ["upstream"])[0].refs, [{ kind: "remote", name: "upstream/main" }]);
  assert.deepEqual(parseLog(text, ["origin"])[0].refs, [{ kind: "branch", name: "upstream/main" }]);
});

test("parseLog parses --follow output with rename subjects", () => {
  const text = ["a".repeat(40), "aaaaaaa", "A", "a@x", "2", "", "", "rename: a.txt → b.txt"].join(US) + RS;
  assert.equal(parseLog(text)[0].subject, "rename: a.txt → b.txt");
});

test("parseNumstat handles a file-scoped show", () => {
  assert.deepEqual(parseNumstat("3\t1\tsrc/only.txt\n"), [
    { path: "src/only.txt", add: 3, del: 1, binary: false },
  ]);
});

import { layoutGraph, graphText, graphWidth } from "../mods/gitgraph/lib/graph.js";

const commit = (sha, parents = []) => ({ sha, parents });

test("layoutGraph keeps a linear history in one lane", () => {
  const rows = layoutGraph([commit("a", ["b"]), commit("b", ["c"]), commit("c")]);
  assert.deepEqual(rows.map((r) => r.lane), [0, 0, 0]);
  assert.deepEqual(rows.map((r) => r.merges), [[], [], []]);
  assert.equal(graphText(rows[0], graphWidth(rows)), "●");
});

test("layoutGraph opens a lane for a branch and closes it at the fork", () => {
  // topo order: tip, feature tip, fork point, root
  const rows = layoutGraph([
    commit("tip", ["fork"]),
    commit("feature", ["fork"]),
    commit("fork", ["root"]),
    commit("root"),
  ]);
  assert.deepEqual(rows.map((r) => r.lane), [0, 1, 0, 0]);
  assert.equal(graphWidth(rows), 2);
  assert.equal(graphText(rows[1], 2), "│ ●");
  assert.equal(graphText(rows[2], 2), "●─╯");
});

test("layoutGraph draws a merge connector to an extra parent lane", () => {
  const rows = layoutGraph([
    commit("merge", ["main", "side"]),
    commit("main", ["base"]),
    commit("side", ["base"]),
    commit("base"),
  ]);
  assert.deepEqual(rows[0].merges, [1]);
  assert.match(graphText(rows[0], 2), /●─╮/);
});

import {
  LANE_PITCH,
  graphRuns,
  laneCenter,
  layoutGraph as layout,
  rowLaneWidth,
  rowSvgWidth,
} from "../mods/gitgraph/lib/graph.js";
import { avatarKey, avatarUrl } from "../mods/gitgraph/lib/avatar.js";

test("graphRuns splits a row by lane for coloring", () => {
  const rows = layoutGraph([commit("tip", ["fork"]), commit("feature", ["fork"]), commit("fork")]);
  const runs = graphRuns(rows[1], 2);
  assert.deepEqual(runs.map((r) => r.lane), [0, 1]);
  assert.deepEqual(runs.map((r) => r.text), ["│ ", "●"]);
});

test("parseWorktrees keeps path, head and branch for every worktree", () => {
  const text = [
    "worktree /repo",
    "HEAD 1111111111111111111111111111111111111111",
    "branch refs/heads/main",
    "",
    "worktree /repo-wt/feature",
    "HEAD 2222222222222222222222222222222222222222",
    "branch refs/heads/feature",
    "",
    "worktree /repo-wt/detached",
    "HEAD 3333333333333333333333333333333333333333",
    "detached",
    "",
  ].join("\0");
  assert.deepEqual(parseWorktrees(text), [
    { path: "/repo", head: "1111111111111111111111111111111111111111", branch: "main" },
    { path: "/repo-wt/feature", head: "2222222222222222222222222222222222222222", branch: "feature" },
    { path: "/repo-wt/detached", head: "3333333333333333333333333333333333333333", branch: null },
  ]);
});

test("parseBranches reads ref tips and the HEAD marker", () => {
  const text = [
    "aaa\tmain\t1700000200\t*",
    "aaa\torigin/main\t1700000200\t",
    "bbb\tfeature\t1700000100\t",
  ].join("\n");
  assert.deepEqual(parseBranches(text), [
    { sha: "aaa", name: "main", at: 1700000200, head: true },
    { sha: "aaa", name: "origin/main", at: 1700000200, head: false },
    { sha: "bbb", name: "feature", at: 1700000100, head: false },
  ]);
});

test("layoutGraph keeps the active branch in lane 0", () => {
  const rows = layout(
    [
      { sha: "other", parents: ["base"], at: 300 },
      { sha: "active", parents: ["base"], at: 200 },
      { sha: "base", parents: [], at: 100 },
    ],
    8,
    "active",
  );
  assert.equal(rows[0].lane, 1);
  assert.equal(rows[1].lane, 0);
  // The shared ancestor is part of the active history, so it keeps lane 0; the other branch
  // approaches it from lane 1.
  assert.equal(rows[2].lane, 0);
  assert.equal(rows[2].before[0], "base");
  assert.equal(rows[2].before[1], "base");
});

test("layoutGraph never reuses lane 0 after the active branch ends", () => {
  const rows = layout(
    [
      { sha: "a1", parents: ["a2"], at: 400 },
      { sha: "a2", parents: [], at: 300 },
      { sha: "b1", parents: ["b2"], at: 200 },
      { sha: "b2", parents: [], at: 100 },
    ],
    8,
    "a1",
  );
  assert.equal(rows[0].lane, 0);
  assert.equal(rows[1].lane, 0);
  assert.notEqual(rows[2].lane, 0);
  assert.notEqual(rows[3].lane, 0);
});

test("rowLaneWidth follows the lanes a row actually uses", () => {
  const rows = layout([
    { sha: "merge", parents: ["main", "side"] },
    { sha: "main", parents: ["base"] },
    { sha: "side", parents: ["base"] },
    { sha: "base", parents: [] },
  ]);
  assert.equal(rowLaneWidth(rows[0]), 2);
  assert.equal(rowLaneWidth(rows[1]), 2);
});

test("branchLabel degrades to …/segment and then /seg…", () => {
  assert.equal(branchLabel("main"), "main");
  assert.equal(branchLabel("origin/really-long-feature-name"), "/really-long-featur…");
  assert.equal(branchLabel("feature/very-long-name"), "…/very-long-name");
  assert.equal(branchLabel("feature/extraordinarily-long-name", 12), "/extraordin…");
});

test("avatarUrl prefers GitHub, otherwise the email local part", () => {
  assert.equal(avatarUrl("123+octocat@users.noreply.github.com"), "https://github.com/octocat.png?size=64");
  assert.equal(avatarUrl("octocat@users.noreply.github.com"), "https://github.com/octocat.png?size=64");
  assert.equal(avatarUrl("alice@example.com"), "https://github.com/alice.png?size=64");
  assert.equal(avatarUrl(""), null);
  assert.equal(avatarKey("alice@example.com"), avatarKey("alice@example.com"));
});

test("parseStatusCounts handles untracked, added, modified, deleted and renames", () => {
  const text = [
    "?? new.txt",
    "A  added.txt",
    " M modified.txt",
    " D deleted.txt",
    "R  new-name.txt",
    "old-name.txt",
    "",
  ].join("\0");
  assert.deepEqual(parseStatusCounts(text), { added: 2, modified: 2, deleted: 1 });
});

test("layoutGraph keeps the active tip's lane when another branch waits on it", () => {
  const rows = layout(
    [
      { sha: "x", parents: ["p"], at: 600 },
      { sha: "y", parents: ["tip"], at: 500 },
      { sha: "tip", parents: ["base"], at: 400 },
      { sha: "base", parents: [], at: 300 },
      { sha: "q", parents: [], at: 200 },
      { sha: "p", parents: [], at: 100 },
    ],
    8,
    "tip",
  );
  const mainline = new Set(["tip", "base"]);
  assert.deepEqual(
    rows.filter((row) => mainline.has(row.sha)).map((row) => row.lane),
    [0, 0],
  );
  assert.ok(rows.filter((row) => !mainline.has(row.sha)).every((row) => row.lane !== 0));
});

test("lane geometry is one integer grid for every row renderer", () => {
  assert.equal(laneCenter(0), 9);
  assert.equal(laneCenter(1), 27);
  assert.equal(laneCenter(2), 45);
  assert.equal(rowSvgWidth(1), 18);
  assert.equal(rowSvgWidth(2), 36);
  assert.equal(rowSvgWidth(4), 72);
  // Any zoom multiplies these integers; no renderer has its own pitch or padding.
  assert.equal(LANE_PITCH, 18);
  assert.equal(laneCenter(3) - laneCenter(2), LANE_PITCH);
});
