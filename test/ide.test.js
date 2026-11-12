import test from "node:test";
import assert from "node:assert/strict";
import { isMarkdownPath, parseListing, sortEntries } from "../mods/ide/lib/parse.js";

test("parseListing reads NUL-separated kind/name pairs", () => {
  const out = "d\0src\0f\0README.md\0d\0.link-dir\0f\0notes with space.md\0";
  assert.deepEqual(parseListing(out), [
    { name: "src", dir: true },
    { name: "README.md", dir: false },
    { name: ".link-dir", dir: true },
    { name: "notes with space.md", dir: false },
  ]);
});

test("parseListing ignores truncated and unknown records", () => {
  assert.deepEqual(parseListing("d\0src\0x\0who\0f"), [{ name: "src", dir: true }]);
  assert.deepEqual(parseListing(""), []);
});

test("sortEntries puts directories first, then names", () => {
  const entries = [
    { name: "zeta", dir: false },
    { name: "alpha", dir: true },
    { name: "beta", dir: false },
    { name: "Beta", dir: true },
  ];
  assert.deepEqual(sortEntries(entries).map((e) => e.name), ["alpha", "Beta", "beta", "zeta"]);
});

import { LISTING } from "../mods/ide/lib/listing.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("LISTING follows symlinked folders and skips .git", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-browser-"));
  try {
    mkdirSync(join(root, "sub"));
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "config"), "");
    writeFileSync(join(root, "file.txt"), "");
    symlinkSync(join(root, "sub"), join(root, "link-dir"));
    const out = execFileSync("sh", ["-c", LISTING, "browser", root]).toString();
    const entries = parseListing(out).map((e) => `${e.dir ? "d" : "f"}:${e.name}`).sort();
    assert.deepEqual(entries, ["d:link-dir", "d:sub", "f:file.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import { splitDiff } from "../mods/ide/lib/diff.js";

test("splitDiff numbers both sides and classifies lines", () => {
  const rows = splitDiff([
    "diff --git a/x b/x",
    "index 111..222 100644",
    "--- a/x",
    "+++ b/x",
    "@@ -3,4 +3,5 @@ fn",
    " same",
    "-old",
    "+new",
    "+extra",
  ]);
  assert.deepEqual(rows.map((r) => r.kind), ["meta", "meta", "meta", "meta", "hunk", "ctx", "del", "add", "add"]);
  const ctx = rows[5];
  assert.deepEqual(ctx.left, { no: 3, text: "same" });
  assert.deepEqual(ctx.right, { no: 3, text: "same" });
  assert.deepEqual(rows[6].left, { no: 4, text: "old" });
  assert.equal(rows[6].right, null);
  assert.deepEqual(rows[7].right, { no: 4, text: "new" });
  assert.deepEqual(rows[8].right, { no: 5, text: "extra" });
});

test("splitDiff treats several hunks independently", () => {
  const rows = splitDiff(["@@ -1 +1 @@", "-a", "+b", "@@ -9 +9 @@", "-c", "+d"]);
  assert.deepEqual(rows[1].left, { no: 1, text: "a" });
  assert.deepEqual(rows[4].left, { no: 9, text: "c" });
  assert.deepEqual(rows[5].right, { no: 9, text: "d" });
});

import { openTab, pinTab, setDirty, removeTab } from "../mods/ide/lib/tabs.js";

test("opening a file previews it, replacing a clean preview", () => {
  let tabs = openTab([], "/a", false);
  assert.deepEqual(tabs, [{ path: "/a", pinned: false, dirty: false }]);
  tabs = openTab(tabs, "/b", false);
  assert.deepEqual(tabs, [{ path: "/b", pinned: false, dirty: false }]);
});

test("a dirty preview is pinned instead of replaced", () => {
  let tabs = openTab([], "/a", false);
  tabs = setDirty(tabs, "/a", true);
  tabs = openTab(tabs, "/b", false);
  assert.deepEqual(tabs, [
    { path: "/a", pinned: true, dirty: true },
    { path: "/b", pinned: false, dirty: false },
  ]);
});

test("double-click pins and reopening promotes without duplicates", () => {
  let tabs = openTab([], "/a", true);
  assert.deepEqual(tabs, [{ path: "/a", pinned: true, dirty: false }]);
  tabs = openTab(tabs, "/b", false);
  tabs = openTab(tabs, "/b", true);
  assert.deepEqual(tabs, [
    { path: "/a", pinned: true, dirty: false },
    { path: "/b", pinned: true, dirty: false },
  ]);
  assert.deepEqual(pinTab(tabs, "/b"), tabs);
});

test("removeTab keeps order and drops the tab", () => {
  const tabs = [{ path: "/a", pinned: true, dirty: false }, { path: "/b", pinned: false, dirty: false }];
  assert.deepEqual(removeTab(tabs, "/a"), [{ path: "/b", pinned: false, dirty: false }]);
});

test("isMarkdownPath accepts the markdown extensions", () => {
  assert.equal(isMarkdownPath("README.md"), true);
  assert.equal(isMarkdownPath("docs/page.mdx"), true);
  assert.equal(isMarkdownPath("notes.MARKDOWN"), true);
  assert.equal(isMarkdownPath("src/main.rs"), false);
  assert.equal(isMarkdownPath(null), false);
});
