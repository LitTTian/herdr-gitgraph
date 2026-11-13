import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, TextView, v_virtual_list } from "gpui-base";
import {
  appHome,
  exec,
  focused,
  home,
  nextCommand,
  panes,
  props,
  run,
  setShared,
  settings,
  readTextFile,
  spaces,
  theme,
  watchFolder,
  writeTextFile,
} from "herdr";
import {
  COMMIT_LIMIT,
  currentBranch,
  findRepo,
  headSha,
  loadBranches,
  loadCommit,
  loadCommits,
  loadFileCommits,
  worktreeStats,
} from "./lib/git.js";
import { branchLabel, relativeTime } from "./lib/parse.js";
import { layoutGraph, rowLaneWidth } from "./lib/graph.js";
import { avatarKey, avatarUrl } from "./lib/avatar.js";

const COMMIT_ROW = 19;
const AVATAR = 15;
const LANE_PX = 14;
const PAGE = COMMIT_LIMIT;
const DIFF_ROW = 18;
const LIST_WIDTH = 360;
const LIST_MIN = 115;
const DETAILS_MIN = 300;
const COMPACT_WIDTH = 600;
const NO_COMMITS = "No commits yet";
const LANE_COLORS = ["ansi6", "ansi4", "ansi2", "ansi5", "ansi3", "ansi1"];

function location() {
  const space = spaces().find((s) => s.active);
  const f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  // A mod pane (or a layout block) has no cwd. Prefer a terminal in this space over the
  // space's creation folder, which may point somewhere else entirely.
  const sibling = space
    ? panes().find((p) => p.cwd && (space.tabs ?? []).some((t) => t.id === p.tab))
    : null;
  return { cwd: pane?.cwd || f?.cwd || sibling?.cwd || space?.folder, on };
}

const mono = () => settings().font_family ?? "JetBrains Mono";

function initials(author) {
  const parts = String(author ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const first = parts[0][0];
  const second = parts.length > 1 ? parts[parts.length - 1][0] : parts[0][1] ?? "";
  return `${first}${second}`.toUpperCase();
}

const basename = (path) => String(path ?? "").replace(/\/+$/, "").split("/").pop() || String(path ?? "");
const formatDate = (iso) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : "");
const screenKey = (target) => JSON.stringify(target);
const firstLine = (text) => String(text ?? "").split("\n")[0];

export default class GitGraph extends View {
  init(_props, cx) {
    this.context = null;
    this.root = null;
    this.branch = null;
    this.commits = [];
    this.selected = null;
    this.selectedWorktree = null;
    this.details = null;
    this.loading = false;
    this.detailsLoading = false;
    this.error = null;
    this.empty = null;
    this.watched = null;
    this.on = null;
    const initial = props();
    const where = location();
    // The component keeps the folder it was created with; focus changes never move it.
    this.fixedCwd = typeof initial?.repo === "string" && initial.repo ? initial.repo : where.cwd ?? null;
    this.fixedOn = where.on ?? null;
    this.shownCwd = null;
    this.repoCommits = [];
    this.note = null;
    this.listWidth = Math.max(LIST_MIN, Math.min(720, Number(localStorage.getItem("gitgraph.listWidth")) || LIST_WIDTH));
    this.width = 0;
    this.detailsHeight = Math.max(80, Number(localStorage.getItem("gitgraph.detailsHeight")) || 210);
    this.detailsDrag = null;
    this.fileView = localStorage.getItem("gitgraph.fileView") === "tree" ? "tree" : "list";
    this.closedDirs = new Set();
    this.listId = `gitgraph-commits-${Math.random().toString(36).slice(2, 8)}`;
    this.viewportH = 0;
    this.lastVisibleEnd = 0;
    this.rowPaths = new Map();
    this.rowWidths = new Map();
    this.svgFiles = new Set();
    this.avatarData = new Map();
    this.lanes = null;
    this.dragStart = null;
    this.hasMore = false;
    this.loadingMore = false;
    this.scrollTop = 0;
    this.offset = 0;
    this.viewportH = 0;
    this.worktreeRows = [];
    this.activeTip = null;
    this.tips = new Map();
    this.avatars = new Map();
    this.avatarTried = new Set();
    this.published = {};
    this.filePath = typeof initial?.file === "string" && initial.file ? initial.file : null;
    this.initialSha = typeof initial?.sha === "string" && initial.sha ? initial.sha : null;
    this.initialFile = typeof initial?.file === "string" && initial.file ? initial.file : null;
    this.refresh(cx);
    cx.timer.every(15000, (cx) => this.refresh(cx));
    // Only a page that actually reaches the last row requests more (no prefetch band).
    cx.timer.every(200, (cx) => {
      const total = this.entries?.length ?? 0;
      if (!this.hasMore || this.loadingMore || total === 0) return;
      if (this.lastVisibleEnd >= total) this.loadMore(cx);
    });
    cx.spawn(async (cx) => {
      for (;;) {
        let command;
        try {
          command = await nextCommand();
        } catch {
          return;
        }
        if (command === "more" || command === "gitgraph.more") this.loadMore(cx);
      }
    });
  }

  target() {
    return { cwd: this.fixedCwd, on: this.fixedOn, file: this.initialFile };
  }

  // The pane header (gitgraph-pane) shows this under title.<pane>; title.<mod> is the fallback.
  publishTitle() {
    const base = home();
    const folder = base && this.fixedCwd?.startsWith(base) ? `~${this.fixedCwd.slice(base.length)}` : this.fixedCwd;
    if (!folder) return;
    const entry = focused();
    const pane = entry?.pane ? panes().find((p) => p.pane === entry.pane && p.mod === "gitgraph") : null;
    if (pane) this.paneId = pane.pane;
    for (const key of [this.paneId ? `title.${this.paneId}` : null, "title.gitgraph"]) {
      if (!key || this.published[key] === folder) continue;
      this.published[key] = folder;
      setShared(key, folder);
    }
  }

  endResize(cx) {
    if (!this.dragStart) return;
    const room = Math.max(LIST_MIN, (this.width || 900) - DETAILS_MIN - 5);
    this.listWidth = Math.min(this.listWidth, room);
    localStorage.setItem("gitgraph.listWidth", String(this.listWidth));
    this.dragStart = null;
    cx.notify();
  }

  async loadAvatars(commits, cx) {
    const emails = [...new Set(commits.map((commit) => commit.email).filter(Boolean))].filter(
      (email) => !this.avatarTried.has(email),
    );
    if (!emails.length) return;
    for (const email of emails) this.avatarTried.add(email);
    const dir = `${appHome()}/cache/gitgraph-avatars`;
    try {
      await exec("mkdir", ["-p", dir], { timeout: 4000 });
    } catch {
      return;
    }
    const missing = [];
    for (const email of emails) {
      const url = avatarUrl(email);
      if (!url) continue;
      const rel = `cache/gitgraph-avatars/${avatarKey(email)}.png`;
      const path = `${dir}/${avatarKey(email)}.png`;
      let cached = false;
      try {
        const probe = await exec("test", ["-f", path], { timeout: 2000 });
        cached = probe.code === 0;
      } catch {
        cached = false;
      }
      if (cached) {
        // `image()` resolves against the app root, so keep the relative path for rendering.
        this.avatars.set(email, rel);
      } else {
        missing.push({ email, url, path, rel });
      }
    }
    if (this.avatars.size) cx.notify();
    await Promise.all(
      missing.map(async ({ email, url, path, rel }) => {
        try {
          const fetched = await exec("curl", ["-fsSL", "--max-time", "8", "-o", path, url], {
            timeout: 12000,
          });
          if (fetched.code === 0) {
            this.avatars.set(email, rel);
            cx.notify();
          }
        } catch {
          // No network or no such account: initials stay.
        }
      }),
    );
    if (this.avatars.size && this.lanes && this.commits.length) {
      await this.prepareRows(this.commits, this.lanes, theme(), cx, this.connectSet(this.entries), this.dashMap(this.entries));
    }
  }

  loadMore(cx) {
    if (this.loading || this.loadingMore || !this.hasMore || !this.root) return;
    this.loadingMore = true;
    const root = this.root;
    const on = this.on;
    const file = this.filePath;
    // Grow the requested limit instead of skipping: a positional --skip re-runs the traversal
    // and drifts whenever refs move, which shows up as repeated or missing pages.
    const limit = Math.max(PAGE, this.commits.length + PAGE);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const page = file
          ? await loadFileCommits(root, file, on, limit)
          : await loadCommits(root, on, limit);
        if (this.root !== root || this.filePath !== file) return;
        const grown = page.length > this.commits.length;
        this.commits = page;
        this.offset = page.length;
        this.hasMore = page.length >= limit && grown;
        this.lanes = layoutGraph(this.commits, undefined, this.activeTip);
        this.entries = this.buildEntries();
        await this.prepareRows(this.commits, this.lanes, theme(), cx, this.connectSet(this.entries), this.dashMap(this.entries));
      } catch (e) {
        this.note = `Load more failed: ${String(e?.message ?? e)}`;
      } finally {
        this.loadingMore = false;
        cx.notify();
      }
    });
  }

  watch(root, on, cx) {
    if (on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch {
        this.watched = null;
      }
    });
  }

  refresh(cx) {
    if (this.loading) return;
    const target = this.target();
    const context = screenKey(target);
    if (context !== this.context) {
      this.context = context;
      this.root = null;
      this.branch = null;
      this.commits = [];
      this.selected = null;
      this.details = null;
      this.diffRows = [];
      this.error = null;
      this.empty = null;
      this.watched = null;
      this.on = target.on ?? null;
      this.filePath = target.file ?? null;
      this.repoCommits = [];
      this.worktreeRows = [];
      this.activeTip = null;
      this.tips = new Map();
      this.avatars = new Map();
      this.avatarTried = new Set();
      this.note = null;
    }
    if (!target.cwd) {
      this.empty = "No folder for this pane";
      return;
    }
    this.loading = true;
    cx.spawn(async (cx) => {
      const current = () => screenKey(this.target()) === context;
      try {
        const root = await findRepo(target.cwd, target.on);
        if (!current()) return;
        if (!root) {
          this.root = null;
          this.commits = [];
          this.selected = null;
          this.details = null;
          this.empty = "Not a git repository";
          this.error = null;
          return;
        }
        const branch = await currentBranch(root, target.on);
        // Keep the depth the user scrolled to: a refresh must not collapse to the first page.
        const limit = Math.max(PAGE, this.commits.length);
        const commits = await loadCommits(root, target.on, limit);
        if (!current()) return;
        const fileCommits = this.filePath && commits.length
          ? await loadFileCommits(root, this.filePath, target.on, limit)
          : [];
        if (!current()) return;
        this.root = root;
        this.shownCwd = target.cwd;
        this.branch = branch;
        this.repoCommits = commits;
        this.commits = this.filePath ? fileCommits : commits;
        this.rowPaths = new Map();
        this.rowWidths = new Map();
        this.rowConnect = new Map();
        this.rowDash = new Map();
        this.offset = this.filePath ? fileCommits.length : commits.length;
        this.hasMore = this.offset >= limit && this.offset >= PAGE;
        this.scrollTop = 0;
        this.loadAvatars(commits, cx);
        this.activeTip = this.filePath ? null : await headSha(root, target.on);
        if (!current()) return;
        this.tips = new Map();
        if (!this.filePath) {
          const branches = await loadBranches(root, target.on);
          if (!current()) return;
          const shas = new Set(commits.map((commit) => commit.sha));
          for (const entry of branches) {
            if (!shas.has(entry.sha)) continue;
            const list = this.tips.get(entry.sha) ?? [];
            list.push(entry);
            this.tips.set(entry.sha, list);
          }
          for (const list of this.tips.values()) {
            list.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
          }
        }
        this.worktreeRows = [];
        if (!this.filePath) {
          const stats = await worktreeStats(root, target.on);
          if (!current()) return;
          this.worktreeRows = stats.map((entry) => ({
            ...entry,
            current: entry.path === root || (Boolean(branch) && entry.branch === branch),
          }));
          if (this.selectedWorktree) {
            const fresh = this.worktreeRows.find((row) => row.path === this.selectedWorktree);
            if (!fresh) {
              this.selectedWorktree = null;
              this.details = null;
            } else if (this.details?.kind === "worktree") {
              this.details = { kind: "worktree", worktree: fresh, files: fresh.files ?? [] };
            }
          }
        }
        if (!current()) return;
        const lanes = layoutGraph(this.commits, undefined, this.activeTip);
        this.lanes = lanes;
        this.entries = this.buildEntries();
        await this.prepareRows(this.commits, lanes, theme(), cx, this.connectSet(this.entries), this.dashMap(this.entries));
        this.empty = this.commits.length
          ? null
          : this.filePath
            ? "No history for this file"
            : NO_COMMITS;
        this.error = null;
        this.note = null;
        this.watch(root, target.on, cx);
        if (!this.selectedWorktree && (!this.selected || !this.commits.some((commit) => commit.sha === this.selected))) {
          const wanted = this.initialSha
            ? this.commits.find(
                (commit) =>
                  commit.sha === this.initialSha ||
                  commit.short === this.initialSha ||
                  commit.sha.startsWith(this.initialSha),
              )
            : null;
          this.selected = wanted?.sha ?? this.commits[0]?.sha ?? null;
          this.details = null;
          this.diffRows = [];
          if (this.selected) await this.loadDetails(this.selected, context, root, target.on);
        }
      } catch (e) {
        if (current()) {
          this.error = String(e?.message ?? e);
          this.empty = null;
        }
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  select(sha, cx) {
    if (!this.root || (this.selected === sha && !this.selectedWorktree)) return;
    this.selected = sha;
    this.selectedWorktree = null;
    this.details = null;
    cx.notify();
    cx.spawn(async (cx) => {
      await this.loadDetails(sha, this.context, this.root, this.on);
      cx.notify();
    });
  }

  selectWorktree(index, cx) {
    const entry = this.entries?.[index];
    if (!entry || entry.kind !== "worktree" || !this.root) return;
    const worktree = entry.worktree;
    if (this.selectedWorktree === worktree.path) return;
    this.selectedWorktree = worktree.path;
    this.selected = null;
    this.detailsLoading = false;
    this.details = {
      kind: "worktree",
      worktree,
      files: worktree.files ?? [],
    };
    cx.notify();
  }

  worktreeBlock(details, t) {
    const worktree = details.worktree ?? {};
    const line = (label, value) =>
      h_flex()
        .gap(8)
        .items_center()
        .text_size(11.5)
        .child(div().w(70).flex_none().text_color(t.dim).child(label))
        .child(div().min_w(0).truncate().text_color(t.foreground).child(value));
    return v_flex()
      .h(this.detailsHeight)
      .flex_none()
      .min_h(0)
      .overflow_y_scroll()
      .border_b(1)
      .border_color(t.border)
      .p(12)
      .gap(6)
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(
            div()
              .text_size(13)
              .font_semibold()
              .child(worktree.current ? "Working tree changes" : "Worktree changes"),
          )
          .when(Boolean(worktree.branch), (e) =>
            e.child(
              div()
                .px(6)
                .py(1)
                .rounded(4)
                .bg(t.raised)
                .text_size(10.5)
                .text_color(t.accent)
                .child(worktree.branch ?? ""),
            ),
          ),
      )
      .child(line("Path", String(worktree.path ?? "")))
      .child(line("HEAD", String(worktree.head ?? "").slice(0, 7)))
      .child(line("Changes", `+${worktree.added ?? 0}  ~${worktree.modified ?? 0}  -${worktree.deleted ?? 0}`))
      .when(Boolean(worktree.mtime), (e) =>
        e.child(line("Latest", relativeTime(worktree.mtime, Math.floor(Date.now() / 1000)))),
      );
  }

  worktreeFiles(details, t) {
    const files = details.files ?? [];
    const color = (status) =>
      status === "A" || status === "U" ? t.ansi2 : status === "D" ? t.ansi1 : status === "R" ? t.ansi4 : t.ansi3;
    return v_flex()
      .flex_1()
      .min_h(0)
      .child(
        h_flex()
          .h(26)
          .flex_none()
          .px(14)
          .gap(6)
          .items_center()
          .text_size(10.5)
          .text_color(t.dim)
          .child(`${files.length} ${files.length === 1 ? "file" : "files"} changed`),
      )
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .overflow_y_scroll()
          .children(
            files.map((file) =>
              h_flex()
                .h(20)
                .flex_none()
                .px(14)
                .gap(8)
                .items_center()
                .text_size(11)
                .child(div().w(12).flex_none().text_color(color(file.status)).child(file.status))
                .child(div().flex_1().min_w(0).truncate().child(String(file.path))),
            ),
          ),
      );
  }

  async loadDetails(sha, context, root, on) {
    this.detailsLoading = true;
    const file = this.filePath;
    try {
      const details = await loadCommit(root, sha, on, file);
      if (this.context !== context || this.selected !== sha || this.filePath !== file) return;
      this.details = details;
    } catch (e) {
      if (this.context === context && this.selected === sha && this.filePath === file) {
        this.details = { sha, author: "", email: "", date: "", message: "", files: [], error: String(e?.message ?? e) };
      }
    } finally {
      this.detailsLoading = false;
    }
  }

  openFile(path, cx) {
    if (!this.root || this.filePath === path) return;
    this.filePath = path;
    this.details = null;
    this.diffRows = [];
    cx.notify();
    cx.spawn(async (cx) => {
      const context = this.context;
      const root = this.root;
      const on = this.on;
      try {
        const commits = await loadFileCommits(root, path, on);
        if (this.context !== context || this.filePath !== path) return;
        this.commits = commits;
        this.recomputeGraph(cx);
        this.empty = commits.length ? null : "No history for this file";
        if (!commits.some((commit) => commit.sha === this.selected)) this.selected = commits[0]?.sha ?? null;
        this.details = null;
        this.diffRows = [];
        if (this.selected) await this.loadDetails(this.selected, context, root, on);
      } catch (e) {
        if (this.context === context && this.filePath === path) {
          this.filePath = null;
          this.commits = this.repoCommits ?? [];
          this.recomputeGraph(cx);
          this.empty = this.commits.length ? null : NO_COMMITS;
          this.details = null;
          this.diffRows = [];
          this.error = null;
          this.note = `Cannot read history for ${path}: ${String(e?.message ?? e)}`;
          if (this.selected) await this.loadDetails(this.selected, context, root, on);
        }
      } finally {
        cx.notify();
      }
    });
  }

  showDiff(path, cx, pinned = false) {
    if (!this.root || !this.selected) return;
    const commit = this.commits.find((entry) => entry.sha === this.selected);
    const payload = {
      repo: this.root,
      sha: this.selected,
      base: commit?.parents?.[0]?.slice(0, 7) ?? "",
      path,
      name: path.split("/").pop(),
      pinned,
    };
    // Only the current tab counts, and only its IDE pane opens the file.
    const space = spaces().find((entry) => entry.active);
    const activeTab = (space?.tabs ?? []).find((tab) => tab.active);
    const inTab = activeTab ? panes().find((pane) => pane.mod === "ide" && pane.tab === activeTab.id) : null;
    if (inTab) {
      run("tab.select", { id: inTab.tab });
      run("pane.focus", { pane: inTab.pane });
      setShared(`ide.diff.${inTab.pane}`, payload);
    } else {
      const target = panes().find((pane) => pane.focused) ?? panes().find((pane) => pane.cwd);
      run("pane.split", { pane: target?.pane, direction: "down", mod: "ide", props: { diff: payload } });
      const focusPane = focused()?.pane ?? null;
      const focusIsIde = focusPane
        ? panes().some((pane) => pane.pane === focusPane && pane.mod === "ide")
        : false;
      const created =
        (focusIsIde ? focusPane : null) ??
        panes().find((pane) => pane.mod === "ide" && pane.tab === activeTab?.id)?.pane ??
        null;
      if (created) run("pane.focus", { pane: created });
    }
    this.note = `${path} → editor`;
    cx.notify();
  }

  closeFile(cx) {
    if (!this.filePath) return;
    const sha = this.selected;
    this.filePath = null;
    this.commits = this.repoCommits ?? [];
    this.recomputeGraph(cx);
    this.empty = this.commits.length ? null : NO_COMMITS;
    this.details = null;
    this.diffRows = [];
    this.note = null;
    this.error = null;
    cx.notify();
    if (!sha) return;
    cx.spawn(async (cx) => {
      await this.loadDetails(sha, this.context, this.root, this.on);
      cx.notify();
    });
  }

  refBadge(ref, t) {
    const color = ref.kind === "tag" ? t.accent : ref.kind === "head" ? t.ansi2 : ref.kind === "remote" ? t.ansi4 : t.muted;
    const name = ref.name.length > 18 ? `${ref.name.slice(0, 17)}…` : ref.name;
    return div().px(5).py(1).rounded(4).bg(t.raised).text_size(9.5).text_color(color).child(name);
  }

  hashText(text) {
    let hash = 5381;
    for (const ch of text) hash = ((hash * 33) ^ ch.codePointAt(0)) >>> 0;
    return hash.toString(16);
  }

  avatarBase64(email) {
    if (!email) return Promise.resolve(null);
    const cached = this.avatarData.get(email);
    if (cached) return cached;
    // Cache the in-flight promise: 200 rows by one author share a single base64 process.
    const task = (async () => {
      const rel = this.avatars?.get(email);
      if (!rel) return null;
      try {
        const result = await exec("base64", ["-i", `${appHome()}/${rel}`], { timeout: 5000 });
        return result.code === 0 ? result.stdout.replace(/\s+/g, "") : null;
      } catch {
        return null;
      }
    })();
    this.avatarData.set(email, task);
    return task;
  }

  // One SVG per row: every stroke shares a coordinate system, and the avatar is painted last,
  // so it covers the junctions instead of meeting them at a curved edge.
  // One SVG per row: every stroke shares a coordinate system, and the avatar is painted last,
  // so it covers the junctions instead of meeting them at a curved edge.
  rowSvg(row, t, connectTop, commit, photo, dashLane = null) {
    const lanes = Math.max(1, rowLaneWidth(row));
    const pitch = LANE_PX + 4;
    const pad = 2; // keep the end avatars inside the viewBox
    const width = (lanes - 1) * pitch + LANE_PX + pad * 2;
    const center = (lane) => pad + lane * pitch + LANE_PX / 2;
    const color = (lane) => t[LANE_COLORS[lane % LANE_COLORS.length]] ?? t.muted;
    const targets = [...row.merges];
    for (let lane = 0; lane < lanes; lane++) {
      if (lane !== row.lane && row.before[lane] != null && row.after[lane] == null) targets.push(lane);
    }
    const nodeX = center(row.lane);
    const mid = COMMIT_ROW / 2;
    const up = mid - 5;
    const down = mid + 5;
    // Branches are drawn left to right; each run and its corner are one unit of that order.
    const ordered = [...targets].sort((a, b) => a - b);
    const paths = [];
    const turnOf = (lane) => {
      const fromMerge = row.merges.includes(lane);
      const above = row.before[lane] != null;
      const below = row.after[lane] != null;
      if (fromMerge || (below && !above)) return "down";
      if (above && !below) return "up";
      return null;
    };
    for (const target of ordered) {
      const x = center(target);
      const left = target > row.lane;
      const endX = left ? x - 5 : x + 5;
      const stroke = color(target);
      const turn = turnOf(target);
      if (turn === "down") {
        // Horizontal and curve are one path: separate butt-ends leave an anti-aliased seam.
        paths.push(
          `<path d="M${nodeX} ${mid} H${endX} Q${x} ${mid} ${x} ${down} V${COMMIT_ROW + 2}" stroke="${stroke}" stroke-width="2" fill="none"/>`,
        );
        if (row.before[target] != null) {
          const back = left ? endX + 1 : endX - 1;
          paths.push(
            `<path d="M${back} ${mid} Q${x} ${mid} ${x} ${up} V-2" stroke="${stroke}" stroke-width="2" fill="none"/>`,
          );
        }
      } else if (turn === "up") {
        paths.push(
          `<path d="M${nodeX} ${mid} H${endX} Q${x} ${mid} ${x} ${up} V-2" stroke="${stroke}" stroke-width="2" fill="none"/>`,
        );
      } else {
        paths.push(`<path d="M${nodeX} ${mid} H${endX}" stroke="${stroke}" stroke-width="2" fill="none"/>`);
      }
    }
    const vline = (x, y1, y2, stroke, dash) =>
      paths.push(
        `<path d="M${x} ${y1} V${y2}" stroke="${stroke}" stroke-width="2" fill="none"` +
          (dash ? ' stroke-dasharray="2 2"' : "") +
          "/>",
      );
    for (let lane = 0; lane < lanes; lane++) {
      const x = center(lane);
      const above = row.before[lane] != null || (lane === row.lane && connectTop);
      const below = row.after[lane] != null;
      if (lane === row.lane) {
        const stub = (COMMIT_ROW - AVATAR) / 2 + 2;
        // Stubs reach 2 px inside the circle, which is painted later and hides the joint.
        // The worktree node above this commit links with a dashed line, not a solid one.
        if (above) {
          const dashed = connectTop && row.before[lane] == null;
          vline(x, dashed ? 0 : -2, stub, color(lane), dashed);
        }
        if (below) vline(x, COMMIT_ROW - stub, COMMIT_ROW + 2, color(lane));
        continue;
      }
      if (turnOf(lane)) continue;
      if (above || below) vline(x, -2, COMMIT_ROW + 2, color(lane));
    }
    if (dashLane != null) {
      vline(center(dashLane), -2, COMMIT_ROW + 2, color(dashLane), true);
    }
    const r = AVATAR / 2;
    const cy = mid;
    const node = [
      `<circle cx="${nodeX}" cy="${cy}" r="${r}" fill="${color(row.lane)}"/>`,
      `<text x="${nodeX}" y="${cy + 8 * 0.35}" font-size="8" font-family="sans-serif" ` +
        `fill="${t.background}" text-anchor="middle">${initials(commit?.author)}</text>`,
    ];
    if (photo) {
      // Painted over the initials: if the rasterizer rejects the data URL, they still show.
      node.push(
        `<clipPath id="avatar"><circle cx="${nodeX}" cy="${cy}" r="${r - 1}"/></clipPath>` +
          `<image x="${nodeX - r + 1}" y="${cy - r + 1}" width="${AVATAR - 2}" height="${AVATAR - 2}" ` +
          `preserveAspectRatio="xMidYMid slice" clip-path="url(#avatar)" ` +
          `href="data:image/png;base64,${photo}" xlink:href="data:image/png;base64,${photo}"/>`,
      );
    }
    // Two pixels of ink above and below: the neighbours' opaque padding covers the faded
    // edge that a scaled image always has, so row boundaries never show a seam.
    const bleed = 2;
    const svgText =
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
      `width="${width}" height="${COMMIT_ROW + bleed * 2}" ` +
      `viewBox="0 -${bleed} ${width} ${COMMIT_ROW + bleed * 2}">` +
      `${paths.join("")}${node.join("")}</svg>`;
    // Hash the drawing, not the embedded base64 photo: hashing megabytes per row blocks the
    // event loop and starves the paging timer.
    const key = `${width}|${paths.join("")}|${initials(commit?.author)}|${photo ? commit.email : "-"}|${color(row.lane)}`;
    return { svgText, width, key };
  }

  async prepareRows(commits, lanes, t, cx, connectShas = new Set(), dashShas = new Map()) {
    const dir = `${appHome()}/cache/gitgraph`;
    try {
      await exec("mkdir", ["-p", dir], { timeout: 4000 });
    } catch {
      return;
    }
    const nextPaths = new Map();
    const nextWidths = new Map();
    const nextConnect = new Map();
    const nextDash = new Map();
    await Promise.all(
      commits.map(async (commit, index) => {
        const connect = connectShas.has(commit.sha);
        const dash = dashShas.get(commit.sha) ?? null;
        if (
          this.rowPaths.has(commit.sha) &&
          this.rowConnect?.get(commit.sha) === connect &&
          (this.rowDash?.get(commit.sha) ?? null) === dash
        ) {
          nextPaths.set(commit.sha, this.rowPaths.get(commit.sha));
          nextWidths.set(commit.sha, this.rowWidths.get(commit.sha));
          nextConnect.set(commit.sha, connect);
          if (dash != null) nextDash.set(commit.sha, dash);
          return;
        }
        const photo = await this.avatarBase64(commit.email);
        const { svgText, width, key } = this.rowSvg(lanes[index], t, connect, commit, photo, dash);
        const name = `r-${this.hashText(key)}.svg`;
        const rel = `cache/gitgraph/${name}`;
        if (!this.svgFiles.has(rel)) {
          this.svgFiles.add(rel);
          // writeTextFile with expected=null can wait forever when the file already exists
          // (another instance, earlier session), which froze the whole page; check first.
          let exists = false;
          try {
            exists = (await readTextFile(`${dir}/${name}`)) !== null;
          } catch {
            exists = false;
          }
          if (!exists) {
            try {
              await writeTextFile(`${dir}/${name}`, svgText, null);
            } catch {
              // Another pane wrote the identical file.
            }
          }
        }
        nextPaths.set(commit.sha, rel);
        nextWidths.set(commit.sha, width);
        nextConnect.set(commit.sha, connect);
        if (dash != null) nextDash.set(commit.sha, dash);
      }),
    );
    this.rowPaths = nextPaths;
    this.rowWidths = nextWidths;
    this.rowConnect = nextConnect;
    this.rowDash = nextDash;
    cx.notify();
  }

  recomputeGraph(cx) {
    this.lanes = layoutGraph(this.commits, undefined, this.activeTip);
    this.entries = this.buildEntries();
    this.rowPaths = new Map();
    this.rowWidths = new Map();
    this.rowConnect = new Map();
    this.rowDash = new Map();
    this.rowSignature = null;
    if (!this.commits.length) return;
    const commits = this.commits;
    const lanes = this.lanes;
    cx?.spawn?.(async (cx) => {
      await this.prepareRows(commits, lanes, theme(), cx, this.connectSet(this.entries), this.dashMap(this.entries));
    });
  }

  dashMap(entries) {
    const lanes = new Map();
    for (const entry of entries ?? []) {
      if (entry.kind === "commit" && entry.dashLane != null) lanes.set(entry.sha, entry.dashLane);
    }
    return lanes;
  }

  connectSet(entries) {
    return new Set(
      (entries ?? []).filter((entry) => entry.kind === "commit" && entry.connectTop).map((entry) => entry.sha),
    );
  }

  buildEntries() {
    const lanes = this.lanes?.length === this.commits.length ? this.lanes : null;
    const empty = { lane: 0, before: [], after: [], merges: [] };
    this.laneBySha = new Map();
    const commits = [];
    for (let i = 0; i < this.commits.length; i++) {
      const commit = this.commits[i];
      const row = lanes?.[i] ?? empty;
      this.laneBySha.set(commit.sha, row.lane ?? 0);
      commits.push({ kind: "commit", sha: commit.sha, row, commit });
    }
    // A worktree node draws the lanes that already pass through its row, so other branches'
    // lines stay continuous instead of being cut by the node.
    const laneState = (row) => [...(row?.before ?? [])];
    const rowFor = (lane, state) => ({ lane, before: state, after: state, merges: [] });
    const top = [];
    const beforeCommit = new Map();
    const now = Math.floor(Date.now() / 1000);
    for (const worktree of this.worktreeRows ?? []) {
      const node = { kind: "worktree", key: `w-${worktree.path}`, worktree, at: 0 };
      if (worktree.current) {
        // Uncommitted changes are newer than every commit, so this node stays on top.
        top.push({ ...node, at: now, row: rowFor(0, laneState(commits[0]?.row)) });
        continue;
      }
      const head = this.commits.findIndex((commit) => commit.sha === worktree.head);
      const lane = this.laneBySha.get(worktree.head) ?? 0;
      const state = laneState(commits[head]?.row);
      // Other worktrees sit directly above their own HEAD commit.
      if (head >= 0) {
        const list = beforeCommit.get(head) ?? [];
        list.push({ ...node, at: worktree.mtime || now, row: rowFor(lane, state) });
        beforeCommit.set(head, list);
      } else {
        top.push({ ...node, at: worktree.mtime || now, row: rowFor(lane, state) });
      }
    }
    const entries = [...top];
    for (let i = 0; i < commits.length; i++) {
      for (const extra of beforeCommit.get(i) ?? []) entries.push(extra);
      const commitEntry = commits[i];
      entries.push(commitEntry);
      const last = entries[entries.length - 2];
      // The dashed link only exists when the node is directly above this commit in its lane.
      commitEntry.connectTop = Boolean(
        last && last.kind === "worktree" && last.row?.lane === commitEntry.row?.lane,
      );
    }
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.kind !== "worktree") continue;
      const next = entries[i + 1];
      entry.link = Boolean(
        next && next.kind === "commit" && entry.row?.lane === next.row?.lane && next.connectTop,
      );
    }
    // The checked-out node stays on top even when another branch has newer commits: its dashed
    // link then runs down lane 0 through the rows above its own HEAD.
    const activeIndex = entries.findIndex((entry) => entry.kind === "worktree" && entry.worktree.current);
    if (activeIndex >= 0) {
      const node = entries[activeIndex];
      const headIndex = entries.findIndex(
        (entry, index) => index > activeIndex && entry.kind === "commit" && entry.sha === node.worktree.head,
      );
      if (headIndex > activeIndex) {
        for (let i = activeIndex + 1; i < headIndex; i++) entries[i].dashLane = node.row.lane;
        const head = entries[headIndex];
        head.connectTop = head.row?.lane === node.row.lane;
        node.link = head.connectTop;
      }
    }
    return entries;
  }

  graphCell(commit, row, t, connectTop) {
    const width = Math.max(1, rowLaneWidth(row));
    const laneColor = (lane) => t[LANE_COLORS[lane % LANE_COLORS.length]] ?? t.muted;
    const targets = [...row.merges];
    for (let lane = 0; lane < width; lane++) {
      if (lane !== row.lane && row.before[lane] != null && row.after[lane] == null) targets.push(lane);
    }
    // Branch fans use the outermost branch color for the whole horizontal run.
    const outer = targets.reduce(
      (best, target) => (best == null || Math.abs(target - row.lane) > Math.abs(best - row.lane) ? target : best),
      null,
    );
    const min = outer == null ? row.lane : Math.min(row.lane, ...targets);
    const max = outer == null ? row.lane : Math.max(row.lane, ...targets);
    const barColor = outer == null ? laneColor(row.lane) : laneColor(outer);
    const half = (COMMIT_ROW - 2) / 2;
    const elbow = 4;
    const children = [];
    for (let lane = 0; lane < width; lane++) {
      const isNode = lane === row.lane;
      const above = row.before[lane] != null || (isNode && connectTop);
      const below = row.after[lane] != null;
      const inSpan = lane >= min && lane <= max;
      const edge = inSpan && !isNode && (lane === min || lane === max);
      const fromLeft = lane > row.lane;
      // A lane added by this commit's extra parent always turns down; only a lane that ends
      // here (its history is above) turns up. Otherwise 4.2 would draw a stray up-arc.
      const fromMerge = row.merges.includes(lane);
      const turnDown = edge && (fromMerge || (below && !above));
      const turnUp = edge && !fromMerge && above && !below;
      let cell;
      if (isNode) {
        const pad = (COMMIT_ROW - AVATAR) / 2;
        cell = v_flex()
          .h(COMMIT_ROW)
          .items_center()
          .child(
            div()
              .h(pad)
              .flex_shrink(0)
              .flex()
              .items_start()
              .child(
                div()
                  .w(2)
                  .h(pad + 1)
                  .flex_shrink(0)
                  .when(above, (e) => e.bg(laneColor(lane))),
              ),
          )
          .child(
            div()
              .size(AVATAR)
              .rounded(AVATAR / 2)
              .border_1()
              .border_color(laneColor(lane))
              .overflow_hidden()
              .flex()
              .items_center()
              .justify_center()
              .bg(laneColor(lane))
              .when(this.avatars?.has(commit.email), (e) =>
                e.child(
                  image(this.avatars.get(commit.email))
                    .size(AVATAR - 2)
                    .rounded((AVATAR - 2) / 2)
                    .overflow_hidden(),
                ),
              )
              .when(!this.avatars?.has(commit.email), (e) =>
                e.child(div().text_size(8).text_color(t.background).child(initials(commit.author))),
              ),
          )
          .child(
            div()
              .h(pad)
              .flex_shrink(0)
              .flex()
              .items_end()
              .child(
                div()
                  .w(2)
                  .h(pad + 1)
                  .flex_shrink(0)
                  .when(below, (e) => e.bg(laneColor(lane))),
              ),
          );
      } else if (edge && (turnDown || turnUp)) {
        // One tall quarter-ring box: its side border is the lane line, so the two cannot drift.
        const disc = 8;
        // Radius smaller than the box: the joints keep a straight 3px stub, so the border
        // meets the bar with a real segment instead of starting inside the curve.
        const radius = 5;
        const boxHeight = turnDown ? COMMIT_ROW - half + 1 : half + 2;
        const box = div()
          .w(disc)
          .h(boxHeight)
          .flex_shrink(0)
          .border_color(barColor)
          .when(turnDown, (e) => e.border_t(2))
          .when(turnUp, (e) => e.border_b(2))
          .when(fromLeft, (e) => e.border_r(2))
          .when(!fromLeft, (e) => e.border_l(2))
          .when(fromLeft && turnDown, (e) => e.rounded_tr(radius))
          .when(!fromLeft && turnDown, (e) => e.rounded_tl(radius))
          .when(fromLeft && turnUp, (e) => e.rounded_br(radius))
          .when(!fromLeft && turnUp, (e) => e.rounded_bl(radius));
        const arcRow = h_flex()
          .w(LANE_PX)
          .flex_none()
          .when(fromLeft, (e) => e.justify_start())
          .when(!fromLeft, (e) => e.justify_end())
          .child(box);
        cell = v_flex()
          .h(COMMIT_ROW)
          .items_center()
          .when(turnDown, (e) =>
            e.child(
              div()
                .h(half)
                .flex_shrink(0)
                .flex()
                .items_start()
                .child(
                  div()
                    .w(2)
                    .h(half + 1)
                    .flex_shrink(0)
                    .when(above, (x) => x.bg(laneColor(lane))),
                ),
            ),
          )
          .child(arcRow)
          .when(turnUp, (e) => e.child(div().h(COMMIT_ROW - boxHeight).flex_shrink(0)));
      } else if (inSpan) {
        cell = v_flex()
          .h(COMMIT_ROW)
          .items_center()
          .child(
            div()
              .h(half)
              .flex_shrink(0)
              .flex()
              .items_start()
              .child(
                div()
                  .w(2)
                  .h(half + 1)
                  .flex_shrink(0)
                  .when(above, (e) => e.bg(laneColor(lane))),
              ),
          )
          .child(
            edge
              ? h_flex()
                  .w(LANE_PX)
                  .h(2)
                  .when(!fromLeft, (e) => e.justify_end())
                  .when(fromLeft, (e) => e.justify_start())
                  .child(div().w(LANE_PX / 2 + 1).h(2).flex_shrink(0).bg(barColor))
              : div().w(LANE_PX + 2).h(2).flex_shrink(0).bg(barColor),
          )
          .child(
            div()
              .h(half)
              .flex_shrink(0)
              .flex()
              .items_start()
              .child(
                div()
                  .w(2)
                  .h(half + 1)
                  .flex_shrink(0)
                  .when(below, (e) => e.bg(laneColor(lane))),
              ),
          );
      } else if (below) {
        cell = div().w(2).h(COMMIT_ROW + 1).flex_shrink(0).bg(laneColor(lane));
      } else {
        cell = div();
      }
      children.push(
        div().w(LANE_PX).h(COMMIT_ROW).flex_none().flex().items_center().justify_center().child(cell),
      );
      if (lane < width - 1) {
        const crossed = lane >= min && lane < max;
        // Same stack as lane cells, so every horizontal piece computes the same y.
        children.push(
          div().w(4).h(COMMIT_ROW).flex_none().when(crossed, (e) =>
            e.child(
              v_flex()
                .h(COMMIT_ROW)
                .items_center()
                .child(div().h(half).flex_shrink(0))
                .child(div().w(6).h(2).flex_shrink(0).bg(barColor))
                .child(div().h(half).flex_shrink(0)),
            ),
          ),
        );
      }
    }
    return h_flex().h(COMMIT_ROW).flex_none().items_center().children(children);
  }

  branchBadge(tips, lane, t) {
    const primary = tips[0];
    const others = tips.slice(1).map((entry) => entry.name);
    const color = t[LANE_COLORS[lane % LANE_COLORS.length]] ?? t.muted;
    return h_flex()
      .flex_none()
      .px(5)
      .py(1)
      .gap(3)
      .items_center()
      .rounded(3)
      .border_1()
      .border_color(color)
      .text_size(9)
      .text_color(color)
      .child(div().flex_none().child(branchLabel(primary.name, 32)))
      .when(others.length > 0, (e) => e.child(div().flex_none().text_size(9).text_color(t.dim).child(`+${others.length}`)));
  }
  worktreeRow(t, worktree, row, now, at, connect, dashLane = null) {
    const lane = row?.lane ?? 0;
    const width = Math.max(1, rowLaneWidth(row));
    const laneColor = (index) => t[LANE_COLORS[index % LANE_COLORS.length]] ?? t.muted;
    const dirty = (worktree.added ?? 0) + (worktree.modified ?? 0) + (worktree.deleted ?? 0) > 0;
    const cells = [];
    for (let index = 0; index < width; index++) {
      const cell = div().w(LANE_PX).h(COMMIT_ROW).flex_none().flex().items_center().justify_center();
      if (index === lane) {
        const node = div()
          .size(13)
          .rounded(6.5)
          .border_1()
          .border_dashed()
          .border_color(laneColor(lane))
          .bg(t.background)
          .flex()
          .items_center()
          .justify_center();
        // GitLens marks a dirty worktree with a solid dot inside the dashed ring.
        if (dirty) node.child(div().size(5).rounded(2.5).bg(laneColor(lane)));
        const dash = v_flex()
          .items_center()
          .child(div().h(1).flex_none())
          .child(div().w(2).h(2).flex_none().bg(laneColor(lane)));
        cell.child(v_flex().items_center().child(node).when(connect, (e) => e.child(dash)));
      } else if (index === dashLane) {
        // The active branch's dashed link runs through rows that belong to other branches.
        cell.child(
          v_flex()
            .h(COMMIT_ROW)
            .items_center()
            .children(
              Array.from({ length: 5 }, (_, step) =>
                v_flex()
                  .items_center()
                  .child(div().w(2).h(2).flex_none().bg(laneColor(index)))
                  .when(step < 4, (e) => e.child(div().w(2).h(2).flex_none())),
              ),
            ),
        );
      } else if (row?.before?.[index] != null) {
        // A lane passing through this row keeps its line, so the node never hides another branch.
        cell.child(div().w(2).h(COMMIT_ROW).flex_none().bg(laneColor(index)));
      }
      cells.push(cell);
      if (index < width - 1) cells.push(div().w(4).h(COMMIT_ROW).flex_none());
    }
    const label = worktree.current
      ? "Working tree changes"
      : `Workspace changes · ${worktree.branch ?? "detached"}`;
    const count = (value, color) =>
      div().flex_none().text_size(9.5).text_color(value ? color : t.dim).child(`${value}`);
    return h_flex()
      .h(COMMIT_ROW)
      .flex_none()
      .px(8)
      .gap(6)
      .items_center()
      .when(this.selectedWorktree === worktree.path, (e) => e.bg(t.selected))
      .child(h_flex().h(COMMIT_ROW).flex_none().pl(2).children(cells))
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .gap(5)
          .items_center()
          .child(div().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(label))
          .child(count(`+${worktree.added ?? 0}`, t.ansi2))
          .child(count(`~${worktree.modified ?? 0}`, t.ansi3))
          .child(count(`-${worktree.deleted ?? 0}`, t.ansi1)),
      )
      .child(div().flex_none().text_size(9).text_color(t.dim).child(relativeTime(at, now)))
      // Commits put the short hash after the date; the node reserves that cell so both dates line up.
      .child(div().w(42).flex_none());
  }

  commitRow(commit, now, t, lane, connectTop, svgPath, svgWidth) {
    const selected = this.selected === commit.sha;
    const tips = this.tips?.get(commit.sha);
    // Virtual-list items may not register handlers; the list reports clicks via on_item_click.
    return h_flex()
      .h(COMMIT_ROW)
      .flex_none()
      .px(8)
      .gap(6)
      .items_center()
      .rounded(6)
      .when(selected, (e) => e.bg(t.selected))
      .when(Boolean(svgPath), (e) =>
        e.child(image(svgPath).w(svgWidth ?? rowLaneWidth(lane)).h(COMMIT_ROW + 4).flex_none()),
      )
      .when(!svgPath, (e) => e.child(this.graphCell(commit, lane, t, connectTop)))
      .when(Boolean(tips?.length), (e) => e.child(this.branchBadge(tips ?? [], lane.lane, t)))
      .child(div().flex_1().min_w(0).truncate().text_size(11).child(commit.subject || "(no subject)"))
      .child(div().flex_none().text_size(9).text_color(t.dim).child(relativeTime(commit.at, now)))
      .child(
        div()
          .flex_none()
          .font_family(mono())
          .text_size(9)
          .text_color(t.dim)
          .child(commit.short),
      );
  }

  authorBlock(details, t) {
    const photo = details.email ? this.avatars?.get(details.email) : null;
    const lane = this.laneBySha?.get(details.sha) ?? 0;
    const laneColor = t[LANE_COLORS[lane % LANE_COLORS.length]] ?? t.muted;
    return v_flex()
      .px(12)
      .pt(10)
      .pb(6)
      .gap(4)
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(
            div()
              .size(24)
              .flex_none()
              .rounded(12)
              .overflow_hidden()
              .flex()
              .items_center()
              .justify_center()
              .bg(laneColor)
              .border_1()
              .border_color(laneColor)
              .when(Boolean(photo), (e) => e.child(image(photo).size(22).rounded(11)))
              .when(!photo, (e) =>
                e.child(div().text_size(10).text_color(t.background).child(initials(details.author))),
              ),
          )
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .child(div().text_size(12).font_medium().truncate().child(details.author ?? ""))
              .child(div().text_size(10).text_color(t.dim).truncate().child(details.email ?? "")),
          ),
      )
      .child(
        h_flex()
          .justify_between()
          .text_size(10)
          .text_color(t.dim)
          .child(div().child(formatDate(details.date)))
          .child(div().font_family(mono()).child(String(details.sha ?? "").slice(0, 7))),
      );
  }

  messageBlock(details, t) {
    return v_flex()
      .h(this.detailsHeight)
      .flex_none()
      .min_h(0)
      .overflow_y_scroll()
      .border_b(1)
      .border_color(t.border)
      .child(this.authorBlock(details, t))
      .child(
        div()
          .px(12)
          .pb(10)
          .child(
            TextView.markdown("gitgraph-message", String(details.message ?? "") || "(no message)")
              .selectable(true),
          ),
      )
      .when(Boolean(details.scopedEmpty), (e) =>
        e.child(
          div()
            .px(12)
            .pb(10)
            .text_size(11)
            .text_color(t.ansi3)
            .child(`${details.path} did not exist at this commit; showing the whole commit.`),
        ),
      );
  }

  fileCounts(file, t) {
    return [
      file.binary ? div().text_size(10).text_color(t.dim).child("bin") : null,
      !file.binary && file.add > 0 ? div().text_size(10).text_color(t.ansi2).child(`+${file.add}`) : null,
      !file.binary && file.del > 0 ? div().text_size(10).text_color(t.ansi1).child(`−${file.del}`) : null,
    ].filter(Boolean);
  }

  fileRow(file, label, depth, suffix, t, cx) {
    return h_flex()
      .h(20)
      .flex_none()
      .px(6)
      .gap(8)
      .items_center()
      .rounded(4)
      .cursor_pointer()
      .when(this.filePath === file.path, (row) => row.bg(t.selected))
      .hover((row) => row.bg(t.hover))
      .on_click((e, cx) => this.showDiff(file.path, cx, e.click_count === 2))
      .child(div().w(depth * 12).flex_none())
      .child(div().flex_none().child(label))
      .when(Boolean(suffix), (row) => row.child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child(suffix)))
      .when(!suffix, (row) => row.child(div().flex_1()))
      .children(this.fileCounts(file, t))
      .child(
        div()
          .id(`gitgraph-log-${file.path}`)
          .px(4)
          .text_size(10)
          .text_color(t.dim)
          .cursor_pointer()
          .hover((chip) => chip.bg(t.hover))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => this.openFile(file.path, cx))
          .child("log"),
      );
  }

  folderRow(name, depth, closed, path, t, cx) {
    return h_flex()
      .h(20)
      .flex_none()
      .px(6)
      .gap(6)
      .items_center()
      .rounded(4)
      .cursor_pointer()
      .hover((row) => row.bg(t.hover))
      .on_click((_e, cx) => {
        if (closed) this.closedDirs.delete(path);
        else this.closedDirs.add(path);
        cx.notify();
      })
      .child(div().w(depth * 12).flex_none())
      .child(div().text_size(10).text_color(t.dim).child(closed ? "▸" : "▾"))
      .child(div().truncate().child(`${name}/`));
  }

  groupFiles(files) {
    const root = { dirs: new Map(), files: [] };
    for (const file of files) {
      const parts = String(file.path).split("/");
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { dirs: new Map(), files: [] });
        node = node.dirs.get(parts[i]);
      }
      node.files.push(file);
    }
    return root;
  }

  treeRows(node, prefix, depth, t, cx, out) {
    for (const [name, child] of node.dirs) {
      // Chains with a single subfolder and no files collapse into one row: a/b/c/.
      let label = name;
      let path = prefix ? `${prefix}/${name}` : name;
      let cursor = child;
      while (cursor.files.length === 0 && cursor.dirs.size === 1) {
        const [nextName, next] = [...cursor.dirs.entries()][0];
        label = `${label}/${nextName}`;
        path = `${path}/${nextName}`;
        cursor = next;
      }
      const closed = this.closedDirs.has(path);
      out.push(this.folderRow(label, depth, closed, path, t, cx));
      if (!closed) this.treeRows(cursor, path, depth + 1, t, cx, out);
    }
    for (const file of node.files) {
      out.push(this.fileRow(file, String(file.path).split("/").pop(), depth, "", t, cx));
    }
    return out;
  }

  filesBlock(details, t, cx) {
    const files = details.files ?? [];
    const listRows = files.map((file) => {
      const parts = String(file.path).split("/");
      const name = parts.pop();
      return this.fileRow(file, name, 0, parts.length ? `${parts.join("/")}/` : "", t, cx);
    });
    const treeRows = this.fileView === "tree" ? this.treeRows(this.groupFiles(files), "", 0, t, cx, []) : [];
    const chip = (label, mode) =>
      div()
        .px(6)
        .py(1)
        .rounded(4)
        .border_1()
        .border_color(this.fileView === mode ? t.accent : t.border)
        .text_size(10)
        .text_color(this.fileView === mode ? t.accent : t.dim)
        .cursor_pointer()
        .hover((e) => e.bg(t.hover))
        .on_click((_e, cx) => {
          this.fileView = mode;
          localStorage.setItem("gitgraph.fileView", mode);
          cx.notify();
        })
        .child(label);
    return v_flex()
      .flex_1()
      .min_h(0)
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .h(26)
          .flex_none()
          .px(14)
          .gap(6)
          .items_center()
          .text_size(10.5)
          .text_color(t.dim)
          .child(`${files.length} ${files.length === 1 ? "file" : "files"}`)
          .child(div().flex_1())
          .child(chip("List", "list"))
          .child(chip("Tree", "tree")),
      )
      .when(files.length === 0, (e) => e.child(div().px(14).pb(8).text_size(11).text_color(t.dim).child("No changed files")))
      .when(files.length > 0, (e) =>
        e.child(
          div()
            .flex_1()
            .min_h(0)
            .overflow_y_scroll()
            .child(v_flex().px(8).pb(6).children(this.fileView === "tree" ? treeRows : listRows)),
        ),
      );
  }

  detailsColumn(t, cx) {
    const details = this.details;
    return v_flex()
      .flex_1()
      .h_full()
      .min_w(DETAILS_MIN)
      .min_h(0)
      .on_mouse_move((e, cx) => {
        if (!this.detailsDrag) return;
        const limit = Math.max(80, (this.height ?? 600) - DETAILS_MIN);
        const next = Math.max(80, Math.min(limit, this.detailsDrag.height + (e.position.y - this.detailsDrag.y)));
        if (next === this.detailsHeight) return;
        this.detailsHeight = next;
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => {
        if (!this.detailsDrag) return;
        localStorage.setItem("gitgraph.detailsHeight", String(this.detailsHeight));
        this.detailsDrag = null;
        cx.notify();
      })
      .on_mouse_down_out((_e) => {
        if (!this.detailsDrag) return;
        localStorage.setItem("gitgraph.detailsHeight", String(this.detailsHeight));
        this.detailsDrag = null;
      })
      .when(!details, (e) =>
        e.child(
          div()
            .px(14)
            .py(12)
            .text_size(12)
            .text_color(t.dim)
            .child(this.detailsLoading ? "Loading commit…" : "Select a commit"),
        ),
      )
      .when(Boolean(details?.error), (e) =>
        e.child(div().px(14).py(12).text_size(11.5).text_color(t.ansi1).child(details.error)),
      )
      .when(Boolean(details && !details.error), (e) =>
        e
          .child(details.kind === "worktree" ? this.worktreeBlock(details, t) : this.messageBlock(details, t))
          .child(
            div()
              .id("gitgraph-details-split")
              .h(5)
              .w_full()
              .flex_none()
              .cursor_row_resize()
              .bg(this.detailsDrag ? t.accent : t.background)
              .hover((e) => e.bg(t.border))
              .on_mouse_down("left", (e, cx) => {
                cx.stop_propagation();
                this.detailsDrag = { y: e.position.y, height: this.detailsHeight };
              })
              .on_mouse_up("left", (_e, cx) => {
                if (!this.detailsDrag) return;
                localStorage.setItem("gitgraph.detailsHeight", String(this.detailsHeight));
                this.detailsDrag = null;
                cx.notify();
              }),
          )
          .child(details.kind === "worktree" ? this.worktreeFiles(details, t) : this.filesBlock(details, t, cx)),
      );
  }

  placeholder(text, t) {
    return v_flex()
      .flex_1()
      .size_full()
      .items_center()
      .justify_center()
      .p(24)
      .text_size(12)
      .text_color(t.dim)
      .child(text);
  }

  render(cx) {
    this.publishTitle();
    if (this.target && screenKey(this.target()) !== this.context) this.refresh(cx);
    const t = theme();
    const now = Math.floor(Date.now() / 1000);
    const entries = this.entries ?? [];
    const narrow = this.width > 0 && this.width < COMPACT_WIDTH;
    const listWidth = narrow
      ? this.width
      : Math.min(this.listWidth, Math.max(LIST_MIN, (this.width || 900) - DETAILS_MIN - 5));
    const blocked = Boolean(this.error) || Boolean(this.empty) || this.commits.length === 0;
    return v_flex()
      .id("gitgraph")
      .size_full()
      .min_w(0)
      .min_h(0)
      .on_size_change((size, cx) => {
        const changed = Math.abs(size.width - this.width) > 0.5;
        this.width = size.width;
        this.height = size.height;
        if (changed) cx.notify();
      })
      .overflow_hidden()
      .bg(t.background)
      .text_color(t.foreground)
      .text_size(13)
      .child(
        h_flex()
          .h(38)
          .flex_none()
          .min_w(0)
          .px(14)
          .gap(8)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .flex_none()
              .child(
                div()
                  .max_w(220)
                  .min_w(0)
                  .flex_shrink(1)
                  .truncate()
                  .font_semibold()
                  .tooltip(this.fixedCwd ?? "")
                  .child(basename(this.fixedCwd)),
              )
              .child(div().text_color(t.dim).child(">")),
          )
          .when(Boolean(this.branch), (e) =>
            e.child(
              div()
                .px(6)
                .py(1)
                .rounded(4)
                .bg(t.raised)
                .text_size(10.5)
                .text_color(t.accent)
                .child(this.branch),
            ),
          )
          .when(!this.branch && Boolean(this.fixedCwd), (e) =>
            e.child(div().text_size(10.5).text_color(t.dim).child("detached")),
          )
          .when(Boolean(this.filePath), (e) =>
            e.child(
              h_flex()
                .gap(6)
                .items_center()
                .child(
                  div()
                    .id("gitgraph-back")
                    .px(6)
                    .py(1)
                    .rounded(4)
                    .border_1()
                    .border_color(t.border)
                    .text_size(10.5)
                    .text_color(t.muted)
                    .cursor_pointer()
                    .hover((chip) => chip.bg(t.hover))
                    .on_click((_e, cx) => this.closeFile(cx))
                    .child("← All"),
                )
                .child(div().max_w(260).truncate().text_size(11).text_color(t.muted).child(this.filePath)),
            ),
          )
          .when(this.loading, (e) => e.child(div().text_size(11).text_color(t.dim).child("Loading…")))
      )
      .when(Boolean(this.note), (e) =>
        e.child(div().flex_none().px(14).py(6).text_size(11).text_color(t.ansi3).child(this.note)),
      )
      .when(blocked, (e) => e.child(this.placeholder(this.error ? `git: ${this.error}` : this.empty || "Loading…", t)))
      .when(!blocked, (e) =>
        e.child(
          h_flex()
            .flex_1()
            .w_full()
            .h_full()
            .items_stretch()
            .min_w(0)
            .min_h(0)
            .on_mouse_move((e, cx) => {
              if (!this.dragStart) return;
              const room = (this.width || 900) - DETAILS_MIN - 5;
              const next = Math.max(LIST_MIN, Math.min(Math.max(LIST_MIN, Math.min(720, room)), this.dragStart.width + (e.position.x - this.dragStart.x)));
              if (next === this.listWidth) return;
              this.listWidth = next;
              cx.notify();
            })
            .on_mouse_up("left", (_e, cx) => this.endResize(cx))
            .on_mouse_down_out((_e, cx) => {
              if (this.dragStart) this.endResize(cx);
            })
            .child(
              v_flex()
                .w(listWidth)
                .h_full()
                .flex_shrink(1)
                .min_w(LIST_MIN)
                .min_h(0)
                .border_r(1)
                .border_color(t.border)
                .child(
                  div()
                    .flex_1()
                    .min_h(0)
                    .relative()
                    .child(
                      div()
                        .size_full()
                        .on_size_change((size) => {
                          this.viewportH = size.height;
                        })
                        .child(
                          v_virtual_list(
                            this.listId,
                            entries.length,
                            COMMIT_ROW,
                            (index) => {
                              const entry = entries[index];
                              if (!entry) return `x:${index}`;
                              return entry.kind === "worktree"
                                ? `${index}:worktree:`
                                : `${index}:${entry.kind}:${entry.sha}`;
                            },
                            (range) => {
                              this.lastVisibleEnd = range.end;
                              return entries.slice(range.start, range.end).map((entry, offset) => {
                                const rowIndex = range.start + offset;
                                try {
                                  if (entry.kind === "worktree") {
                                      return this.worktreeRow(
                                        t,
                                        entry.worktree,
                                        entry.row,
                                        now,
                                        entry.worktree?.current ? now : (entry.at ?? now),
                                        Boolean(entry.link),
                                        entry.dashLane ?? null,
                                      );
                                  }
                                  return this.commitRow(
                                    entry.commit,
                                    now,
                                    t,
                                    entry.row,
                                    Boolean(entry.connectTop),
                                    this.rowPaths?.get(entry.commit.sha),
                                    this.rowWidths?.get(entry.commit.sha),
                                  );
                                } catch (e) {
                                  return div().p(6).text_size(11).text_color(t.ansi1).child(`row error[${String(entry?.kind)}]: ${String(e?.message ?? e)}`);
                                }
                              });
                            },
                          )
                            .size_full()
                            .on_item_click((key, cx) => {
                              const parts = String(key).split(":");
                              if (parts[1] === "worktree") this.selectWorktree(Number(parts[0]), cx);
                              else if (parts.length === 3 && parts[1] === "commit") this.select(parts[2], cx);
                            }),
                        )
                        .child(Scrollbar.vertical(this.listId).viewport_from_layout().absolute().inset_0()),
                    ),
                )
                .when(this.loadingMore, (list) =>
                  list.child(
                    div()
                      .h(22)
                      .flex_none()
                      .flex()
                      .items_center()
                      .justify_center()
                      .text_size(10)
                      .text_color(t.dim)
                      .child("Loading…"),
                  ),
                ),
            )
            .when(!narrow, (e) =>
              e.child(
                div()
                .id("gitgraph-split")
                .w(5)
                .h_full()
                .flex_none()
                .cursor_col_resize()
                .bg(this.dragStart ? t.accent : t.border)
                .on_mouse_down("left", (e, cx) => {
                  cx.stop_propagation();
                  this.dragStart = { x: e.position.x, width: this.listWidth };
                  cx.notify();
                })
                .on_mouse_up("left", (_e, cx) => this.endResize(cx)),
              ),
            )
            .when(!narrow, (e) => e.child(this.detailsColumn(t, cx))),
        ),
      );
  }
}
