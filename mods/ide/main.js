// Fused file browser + editor for the Herdr app: a collapsible tree on the left, the editable
// file on the right. No save button: a red dot marks unsaved edits and `ctrl-s` saves
// (`mod:ide` in keys.json). `props.root` pins the tree, `props.file` opens a file.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, Editor, EditorState, TextView } from "gpui-base";
import {
  spaces, panes, focused, home, exec, readTextFile, writeTextFile, theme, settings, props,
  shared, setShared, watchFolder, nextCommand,
} from "herdr";
import { isMarkdownPath, parseListing, sortEntries } from "./lib/parse.js";
import { LISTING } from "./lib/listing.js";
import { splitDiff } from "./lib/diff.js";
import { openTab, pinTab, setDirty, removeTab } from "./lib/tabs.js";

const PER_FOLDER = 400;
const TOTAL = 4000;
const TREE_WIDTH = 240;
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html", md: "markdown" };

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
const basename = (path) => String(path ?? "").replace(/\/+$/, "").split("/").pop() || String(path ?? "");
const dirname = (path) => String(path ?? "").replace(/\/+$/, "").split("/").slice(0, -1).join("/");
const join = (dir, name) => `${String(dir).replace(/\/+$/, "")}/${name}`;

function languageOf(path) {
  const name = basename(path);
  if (/^makefile$/i.test(name)) return "make";
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "txt";
  return LANG[ext] ?? ext;
}

function hashText(text) {
  let hash = 5381;
  for (const ch of String(text ?? "")) hash = ((hash * 33) ^ ch.codePointAt(0)) >>> 0;
  return hash.toString(16);
}

export default class Ide extends View {
  init(_props, cx) {
    this.context = null;
    this.root = null;
    this.on = null;
    this.entries = new Map();
    this.open = new Set();
    this.treeError = null;
    this.treeLoading = false;
    this.watched = null;
    this.file = null;
    this.code = null;
    this.original = "";
    this.dirty = false;
    this.note = null;
    this.fileError = null;
    this.fileLoading = false;
    this.saving = false;
    this.pending = null;
    this.diffSpec = null;
    this.diffLines = [];
    this.diffError = null;
    this.diffKey = null;
    this.pendingDiff = null;
    this.diffSpecs = new Map();
    this.openFiles = [];
    this.drafts = new Map();
    this.closePrompt = null;
    this.hoverClose = null;
    this.handle = cx.focus_handle();
    this.diffMode = "unified";
    this.mdPreview = false;
    const initial = props();
    const where = location();
    // The tree keeps the folder the IDE was created with; focus changes never move it.
    this.fixedRoot = typeof initial?.root === "string" && initial.root ? initial.root : where.cwd ?? null;
    this.fixedOn = where.on ?? null;
    this.published = {};
    this.treeCollapsed = false;
    this.treeWidth = Math.max(160, Math.min(520, Number(localStorage.getItem("ide.treeWidth")) || TREE_WIDTH));
    this.treeDrag = null;
    if (typeof initial?.file === "string" && initial.file) this.openFile(initial.file, cx);
    if (initial?.diff && typeof initial.diff === "object") {
      cx.spawn(async (cx) => {
        await this.openDiff(initial.diff, cx, true);
      });
    }
    this.treeRefresh(cx);
    cx.timer.every(15000, (cx) => this.treeRefresh(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        let command;
        try {
          command = await nextCommand();
        } catch {
          return; // the copy is going away or the build was replaced
        }
        if (command === "focus" || command === "ide.focus") this.handle.focus();
        else if (command === "save" || command === "ide.save") this.save(cx);
        else if (command === "toggle" || command === "ide.toggle") this.toggleTree(cx);
        else if (command === "collapse" || command === "ide.collapse") {
          this.setCollapsed(true);
          cx.notify();
        } else if (command === "expand" || command === "ide.expand") {
          this.setCollapsed(false);
          cx.notify();
        }
        else if (command === "save-all" || command === "ide.save-all") this.saveAll(cx);
        else if (command === "pin" || command === "ide.pin") {
          if (this.file) this.openFiles = pinTab(this.openFiles, this.file);
          cx.notify();
        }
        else if (command === "split" || command === "ide.split") {
          this.diffMode = "split";
          cx.notify();
        } else if (command === "unified" || command === "ide.unified") {
          this.diffMode = "unified";
          cx.notify();
        }
      }
    });
  }

  target() {
    return { root: this.fixedRoot, on: this.fixedOn };
  }

  // The pane header (gitgraph-pane) shows this under title.<pane>; title.<mod> is the fallback.
  publishTitle() {
    const base = home();
    const folder = base && this.fixedRoot?.startsWith(base) ? `~${this.fixedRoot.slice(base.length)}` : this.fixedRoot;
    if (!folder) return;
    const entry = focused();
    const pane = entry?.pane ? panes().find((p) => p.pane === entry.pane && p.mod === "ide") : null;
    if (pane) this.paneId = pane.pane;
    for (const key of [this.paneId ? `title.${this.paneId}` : null, "title.ide"]) {
      if (!key || this.published[key] === folder) continue;
      this.published[key] = folder;
      setShared(key, folder);
    }
  }

  diffRequestKey() {
    return this.paneId ? `ide.diff.${this.paneId}` : null;
  }

  diffRequest() {
    const key = this.diffRequestKey();
    return key ? shared(key) : null;
  }

  diffRequestMatches(value) {
    return JSON.stringify(this.diffRequest()) === value;
  }

  clearDiffRequest() {
    const key = this.diffRequestKey();
    if (key && shared(key)) setShared(key, null);
  }

  // Per pane: one IDE collapsing its tree must not collapse the others.
  mdPreviewMode() {
    return Boolean(this.file) && !this.diffSpec && isMarkdownPath(this.file);
  }

  collapsed() {
    return this.treeCollapsed === true;
  }

  toggleTree(cx) {
    this.treeCollapsed = !this.collapsed();
    cx.notify();
  }

  setCollapsed(value) {
    this.treeCollapsed = value;
  }

  // ---- tree -----------------------------------------------------------------

  treeRefresh(cx) {
    const target = this.target();
    const context = JSON.stringify(target);
    if (context !== this.context) {
      this.context = context;
      this.root = target.root;
      this.on = target.on ?? null;
      this.entries = new Map();
      this.open = new Set();
      this.treeError = null;
      this.watched = null;
    }
    if (!this.root) {
      this.treeError = null;
      return;
    }
    const dirs = [this.root, ...this.open];
    this.treeLoading = true;
    cx.spawn(async (cx) => {
      try {
        for (const dir of dirs) await this.loadDir(dir, this.on);
        if (JSON.stringify(this.target()) === context) this.treeError = null;
        this.watchTree(cx);
      } catch (e) {
        if (JSON.stringify(this.target()) === context) this.treeError = String(e?.message ?? e);
      } finally {
        this.treeLoading = false;
        cx.notify();
      }
    });
  }

  watchTree(cx) {
    const root = this.root;
    if (!root || this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.treeRefresh(cx);
        }
      } catch {
        this.watched = null;
      }
    });
  }

  async loadDir(dir, on) {
    const result = await exec("sh", ["-c", LISTING, "browser", dir], { on, timeout: 20000 });
    if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim() || `listing failed (${result.code})`);
    this.entries.set(dir, sortEntries(parseListing(result.stdout)).slice(0, PER_FOLDER));
  }

  toggleDir(path, cx) {
    if (this.open.has(path)) {
      this.open.delete(path);
      cx.notify();
      return;
    }
    this.open.add(path);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.loadDir(path, this.on);
      } catch (e) {
        this.treeError = String(e?.message ?? e);
      } finally {
        cx.notify();
      }
    });
  }

  rows(dir, depth, out) {
    if (out.length >= TOTAL) return out;
    for (const entry of this.entries.get(dir) ?? []) {
      const path = join(dir, entry.name);
      out.push({ ...entry, path, depth });
      if (entry.dir && this.open.has(path)) this.rows(path, depth + 1, out);
      if (out.length >= TOTAL) break;
    }
    return out;
  }

  // ---- file -----------------------------------------------------------------

  openFile(path, cx, pinned = false) {
    this.diffSpecs.delete(path);
    if (this.diffSpec) {
      this.diffSpec = null;
      this.diffLines = [];
      this.diffError = null;
      this.diffKey = null;
      this.clearDiffRequest();
    }
    if (this.fileLoading && this.file === path) return;
    this.stash();
    const previous = this.openFiles;
    this.openFiles = openTab(this.openFiles, path, pinned);
    for (const tab of previous) {
      if (!this.openFiles.some((entry) => entry.path === tab.path)) this.drafts.delete(tab.path);
    }
    this.file = path;
    this.mdPreview = false;
    this.fileError = null;
    this.note = null;
    this.dirty = false;
    this.fileLoading = true;
    cx.spawn(async (cx) => {
      try {
        const draft = this.drafts.get(path);
        let text;
        let original;
        if (draft) {
          text = draft.text;
          original = draft.original;
        } else {
          const absolute = path.startsWith("/") ? path : `${this.root ?? ""}/${path}`;
          text = await readTextFile(absolute);
          original = text;
        }
        if (this.file !== path) return;
        if (text === null) {
          this.fileError = "This file is no longer available";
          this.code?.release();
          this.code = null;
          return;
        }
        if (text.includes("\0")) {
          this.fileError = "Binary file — no text editor";
          this.code?.release();
          this.code = null;
          return;
        }
        this.code?.release();
        // Set the loaded snapshot before the editor exists: a change event raised during
        // creation would otherwise compare against the previous file and pin a preview.
        this.original = original;
        this.dirty = text !== original;
        const t = theme();
        this.code = EditorState.new({
          language: languageOf(path),
          value: text,
          readonly: false,
          font_family: settings().font_family,
          font_size: 12,
          syntax: {
            keyword: t.ansi5,
            string: t.ansi2,
            comment: t.dim,
            function: t.ansi4,
            type: t.ansi3,
            number: t.ansi1,
            constant: t.ansi6,
          },
        });
        // Rebaseline on the editor's own value: a mount-time normalization is not an edit.
        this.original = this.code.value();
        this.dirty = false;
        this.code.on("change", (_event, cx) => {
          if (!this.code || this.fileLoading) return;
          const dirty = this.code.value() !== this.original;
          if (dirty) {
            this.openFiles = pinTab(this.openFiles, path);
            this.openFiles = setDirty(this.openFiles, path, true);
          } else {
            this.openFiles = setDirty(this.openFiles, path, false);
          }
          if (dirty !== this.dirty) {
            this.dirty = dirty;
            cx.notify();
          }
        });
      } catch (e) {
        if (this.file === path) {
          this.fileError = String(e?.message ?? e);
          this.code?.release();
          this.code = null;
        }
      } finally {
        this.fileLoading = false;
        cx.notify();
      }
    });
  }

  stash() {
    if (!this.file || !this.code) return;
    this.drafts.set(this.file, { text: this.code.value(), original: this.original });
  }

  switchFile(path, cx) {
    const spec = this.diffSpecs.get(path);
    if (spec) {
      if (this.diffSpec && this.diffSpec.path === path) return;
      this.diffSpec = null;
      this.code?.release();
      this.code = null;
      this.file = path;
      this.diffError = null;
      cx.notify();
      cx.spawn(async (cx) => {
        await this.openDiff(spec, cx, true);
      });
      return;
    }
    if (!this.diffSpec && this.file === path) return;
    this.openFile(path, cx);
  }

  async openDiff(spec, cx, force = false) {
    const key = JSON.stringify(spec);
    this.diffError = null;
    try {
      const result = await exec(
        "git",
        [
          "--no-optional-locks", "-c", "core.fsmonitor=false",
          "show", "-m", "--first-parent", "--format=", "--no-color", "--no-ext-diff", "--no-textconv",
          spec.sha, "--", spec.path,
        ],
        { cwd: spec.repo, timeout: 20000 },
      );
      if (!force && !this.diffRequestMatches(key)) return;
      if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim() || `git show failed (${result.code})`);
      const meta = /^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index|rename from|rename to|Binary files)/;
      const lines = (result.stdout || "")
        .replace(/\n$/, "")
        .split("\n")
        .filter((line) => !meta.test(line));
      this.diffLines = lines.slice(0, 1200).map((line) => (line.length > 4000 ? `${line.slice(0, 4000)}…` : line));
      this.diffSpec = spec;
      this.diffSpecs.set(spec.path, spec);
      this.diffKey = key;
      this.openFiles = openTab(this.openFiles, spec.path, spec.pinned === true);
    } catch (e) {
      if (force || this.diffRequestMatches(key)) {
        this.diffSpec = spec;
        this.diffSpecs.set(spec.path, spec);
        this.diffKey = key;
        this.diffLines = [];
        this.diffError = String(e?.message ?? e);
      }
    } finally {
      cx.notify();
    }
  }

  save(cx) {
    if (!this.file || !this.code || this.saving) return;
    const path = this.file;
    const value = this.code.value();
    const expected = this.original;
    this.saving = true;
    this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await writeTextFile(path, value, expected);
        if (this.file !== path) return;
        this.original = value;
        this.drafts.set(path, { text: value, original: value });
        this.openFiles = setDirty(this.openFiles, path, this.code.value() !== value);
        this.dirty = this.code.value() !== value;
        this.note = this.dirty ? "Saved, newer edits still unsaved" : "Saved";
        this.fileError = null;
      } catch (e) {
        if (this.file === path) this.note = `Save failed: ${String(e?.message ?? e)}`;
      } finally {
        this.saving = false;
        cx.notify();
      }
    });
  }

  // ---- views ----------------------------------------------------------------

  treeRow(item, t) {
    const selected = this.file === item.path;
    return h_flex()
      .id(`ide-${item.path}`)
      .h(24)
      .flex_none()
      .pr(8)
      .gap(6)
      .items_center()
      .rounded(4)
      .cursor_pointer()
      .when(selected, (row) => row.bg(t.selected))
      .hover((row) => row.bg(t.hover))
      .on_mouse_down("left", (e, cx) => {
        if (!item.dir) return;
        cx.stop_propagation();
        this.toggleDir(item.path, cx);
      })
      // Files open on click, where click_count reliably separates single and double.
      .on_click((e, cx) => {
        if (item.dir) return;
        this.openFile(item.path, cx, e.click_count === 2);
      })
      .child(div().flex_none().w(item.depth * 12))
      .child(
        item.dir
          ? svg(`mods/ide/chevron-${this.open.has(item.path) ? "down" : "right"}.svg`)
              .size(12)
              .flex_none()
              .text_color(t.dim)
          : div().w(12).flex_none(),
      )
      .child(div().flex_1().min_w(0).truncate().text_color(item.dir ? t.foreground : t.muted).child(item.name));
  }

  treeView(t) {
    const rows = this.root ? this.rows(this.root, 0, []) : [];
    return v_flex()
      .w(this.treeWidth)
      .h_full()
      .flex_none()
      .min_w(160)
      .min_h(0)
      .border_r(1)
      .border_color(t.border)
      .child(
        h_flex()
          .h(26)
          .flex_none()
          .px(8)
          .gap(6)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_size(11)
              .text_color(t.muted)
              .tooltip(this.fixedRoot ?? "")
              .child(basename(this.fixedRoot ?? "")),
          ),
      )
      .child(
        div()
          .flex_1()
          .min_h(0)
          .relative()
          .child(
            v_flex()
              .id("ide-tree")
              .absolute()
              .inset_0()
              .overflow_y_scroll()
              .p(6)
              .children(rows.map((item) => this.treeRow(item, t))),
          )
          .child(Scrollbar.vertical("ide-tree").viewport_from_layout().absolute().inset_0())
          .when(Boolean(this.treeError) || (!this.treeLoading && rows.length === 0), (e) =>
            e.child(
              div()
                .p(10)
                .text_size(12)
                .text_color(t.dim)
                .child(this.treeError || (this.root ? "No files" : "No folder for this pane")),
            ),
          )
          .when(rows.length >= TOTAL, (e) =>
            e.child(div().absolute().bottom(4).px(10).text_size(10).text_color(t.dim).child(`First ${TOTAL} entries`)),
          ),
      );
  }

  header(t, cx, collapsed) {
    const diff = this.diffSpec;
    return h_flex()
      .h(38)
      .flex_none()
      .px(8)
      .gap(6)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .child(
            div()
              .id("ide-toggle")
              .size(26)
              .flex_none()
              .flex()
              .items_center()
              .justify_center()
              .rounded(6)
              .cursor_pointer()
              .hover((button) => button.bg(t.hover))
              .on_click((_e, cx) => this.toggleTree(cx))
              .child(svg("mods/workspace-chrome/sidebar.svg").size(15).text_color(collapsed ? t.muted : t.foreground)),
          )
          .when(this.openFiles.length > 0, (e) =>
            e.child(h_flex().gap(3).flex_none().children(this.openFiles.map((tab) => this.fileTab(tab, t, cx)))),
          )
          .child(div().flex_1().min_w(0))
          .when(Boolean(this.note), (e) => e.child(div().text_size(10.5).text_color(t.muted).child(this.note)))
          .when(this.mdPreviewMode(), (e) =>
            e.child(
              div()
                .id("ide-md-mode")
                .px(6)
                .py(1)
                .rounded(4)
                .border_1()
                .border_color(t.border)
                .text_size(10.5)
                .text_color(t.muted)
                .cursor_pointer()
                .hover((chip) => chip.bg(t.hover))
                .on_click((_e, cx) => {
                  this.mdPreview = !this.mdPreview;
                  cx.notify();
                })
                .child(this.mdPreview ? "Source" : "Preview"),
            ),
          )
          .when(Boolean(diff), (e) =>
            e.child(
              div()
                .id("ide-diff-view")
                .px(6)
                .py(1)
                .rounded(4)
                .border_1()
                .border_color(t.border)
                .text_size(10.5)
                .text_color(t.muted)
                .cursor_pointer()
                .hover((chip) => chip.bg(t.hover))
                .on_click((_e, cx) => {
                  this.diffMode = this.diffMode === "unified" ? "split" : "unified";
                  cx.notify();
                })
                .child(this.diffMode === "unified" ? "Unified" : "Split"),
            ),
          );
  }

  fileTab(tab, t, cx) {
    const path = tab.path;
    const active = !this.diffSpec && this.file === path;
    const draft = this.drafts.get(path);
    const dirty = active ? this.dirty : Boolean(draft && draft.text !== draft.original);
    const showClose = !dirty || this.hoverClose === path;
    return h_flex()
      .id(`ide-tab-${path}`)
      .h(24)
      .flex_none()
      .px(6)
      .gap(5)
      .items_center()
      .rounded(5)
      .when(active, (entry) => entry.bg(t.selected))
      .hover((entry) => entry.bg(t.hover))
      .cursor_pointer()
      .on_click((_e, cx) => this.switchFile(path, cx))
      .child(
        div()
          .max_w(130)
          .min_w(0)
          .truncate()
          .text_size(11)
          // The UI font has no italic face; the editor font does, so labels use it for both states.
          .font_family(settings().font_family ?? "JetBrains Mono")
          .when(tab.pinned, (label) => label.not_italic())
          .when(!tab.pinned, (label) => label.italic().text_color(t.muted))
          .child(basename(path)),
      )
      .child(
        div()
          .id(`ide-tab-close-${path}`)
          .w(16)
          .flex_none()
          .text_center()
          .text_size(11)
          .text_color(dirty ? t.ansi1 : t.muted)
          .cursor_pointer()
          .on_hover((hovered, cx) => {
            const next = hovered ? path : null;
            if (next === this.hoverClose) return;
            this.hoverClose = next;
            cx.notify();
          })
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => {
            cx.stop_propagation();
            this.requestClose(path, cx);
          })
          .child(showClose ? "×" : "●"),
      );
  }

  isDirty(path) {
    if (this.file === path && this.code) return this.code.value() !== this.original;
    const draft = this.drafts.get(path);
    return Boolean(draft && draft.text !== draft.original);
  }

  closeTab(path, cx) {
    const wasActive = this.file === path;
    this.diffSpecs.delete(path);
    if (this.diffSpec?.path === path) {
      this.diffSpec = null;
      this.diffLines = [];
      this.diffError = null;
      this.diffKey = null;
      this.clearDiffRequest();
    }
    const index = this.openFiles.findIndex((tab) => tab.path === path);
    this.drafts.delete(path);
    this.openFiles = removeTab(this.openFiles, path);
    this.closePrompt = null;
    if (!wasActive) {
      cx.notify();
      return;
    }
    this.code?.release();
    this.code = null;
    this.file = null;
    this.dirty = false;
    const next = this.openFiles[Math.min(index, this.openFiles.length - 1)];
    if (next) {
      // The neighbour may be a diff tab; switchFile re-runs its git show instead of reading
      // the working tree.
      this.switchFile(next.path, cx);
      return;
    }
    this.diffSpec = null;
    this.diffKey = null;
    this.diffLines = [];
    this.clearDiffRequest();
    cx.notify();
  }

  requestClose(path, cx) {
    if (this.isDirty(path)) {
      this.closePrompt = { path };
      cx.notify();
    } else {
      this.closeTab(path, cx);
    }
  }

  saveThenClose(cx) {
    const path = this.closePrompt?.path;
    this.closePrompt = null;
    if (!path) return;
    const value = this.file === path && this.code ? this.code.value() : this.drafts.get(path)?.text ?? "";
    const expected = this.file === path ? this.original : this.drafts.get(path)?.original ?? "";
    cx.spawn(async (cx) => {
      try {
        await writeTextFile(path, value, expected);
        this.drafts.delete(path);
        this.closeTab(path, cx);
      } catch (e) {
        this.note = `Save failed: ${String(e?.message ?? e)}`;
        cx.notify();
      }
    });
  }

  saveAll(cx) {
    const targets = this.openFiles.filter((tab) => tab.pinned && this.isDirty(tab.path));
    if (!targets.length) {
      this.note = "Nothing to save";
      cx.notify();
      return;
    }
    cx.spawn(async (cx) => {
      let saved = 0;
      const failed = [];
      for (const tab of targets) {
        const path = tab.path;
        const value = this.file === path && this.code ? this.code.value() : this.drafts.get(path)?.text ?? "";
        const expected = this.file === path ? this.original : this.drafts.get(path)?.original ?? "";
        try {
          await writeTextFile(path, value, expected);
          this.drafts.set(path, { text: value, original: value });
          this.openFiles = setDirty(this.openFiles, path, false);
          if (this.file === path) {
            this.original = value;
            this.dirty = false;
          }
          saved++;
        } catch {
          failed.push(basename(path));
        }
      }
      this.note = failed.length ? `Saved ${saved}; failed ${failed.join(", ")}` : `Saved ${saved} file${saved === 1 ? "" : "s"}`;
      cx.notify();
    });
  }

  closeDialog(t, cx) {
    const name = basename(this.closePrompt?.path);
    const button = (id, label, primary) =>
      div()
        .id(id)
        .h(28)
        .px(12)
        .flex()
        .items_center()
        .rounded(6)
        .border_1()
        .border_color(primary ? t.accent : t.border)
        .text_size(11.5)
        .text_color(primary ? t.foreground : t.muted)
        .cursor_pointer()
        .hover((entry) => entry.bg(t.hover))
        .child(label);
    return div()
      .absolute()
      .inset_0()
      .flex()
      .items_center()
      .justify_center()
      .bg(`${t.canvas}cc`)
      .child(
        v_flex()
          .w(420)
          .p(16)
          .gap(12)
          .rounded(10)
          .bg(t.popover)
          .border_1()
          .border_color(t.border)
          .child(div().text_size(13).font_semibold().child(`Save changes to ${name}?`))
          .child(
            h_flex()
              .justify_end()
              .gap(8)
              .child(
                button("ide-cancel", "Cancel", false).on_click((_e, cx) => {
                  this.closePrompt = null;
                  cx.notify();
                }),
              )
              .child(
                button("ide-discard", "Don't save", false).on_click((_e, cx) => this.closeTab(this.closePrompt.path, cx)),
              )
              .child(button("ide-save-close", "Save", true).on_click((_e, cx) => this.saveThenClose(cx))),
          ),
      );
  }

  diffLine(line, index, t) {
    const color = line.startsWith("@@")
      ? t.dim
      : line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git") || line.startsWith("index ")
        ? t.muted
        : line.startsWith("+")
          ? t.ansi2
          : line.startsWith("-")
            ? t.ansi1
            : t.foreground;
    return h_flex()
      .h(18)
      .flex_none()
      .px(10)
      .gap(8)
      .child(div().w(36).flex_none().text_right().text_size(10).text_color(t.dim).child(String(index + 1)))
      .child(div().flex_1().min_w(0).truncate().font_family(mono()).text_size(11).text_color(color).child(line || " "));
  }

  diffSplitRow(row, t) {
    if (row.kind !== "ctx" && row.kind !== "add" && row.kind !== "del") {
      return div()
        .h(18)
        .flex_none()
        .px(10)
        .font_family(mono())
        .text_size(11)
        .text_color(row.kind === "hunk" ? t.dim : t.muted)
        .truncate()
        .child(row.text);
    }
    const cell = (side, color, background) =>
      h_flex()
        .h(18)
        .w_full()
        .min_w(0)
        .gap(6)
        .px(8)
        .items_center()
        .min_w(0)
        .when(Boolean(background), (line) => line.bg(background))
        .child(div().w(34).flex_none().text_right().text_size(10).text_color(t.dim).child(side ? String(side.no) : ""))
        .child(
          div()
            .flex_1()
            .min_w(0)
            .truncate()
            .font_family(mono())
            .text_size(11)
            .text_color(color)
            .child(side ? side.text || " " : ""),
        );
    const leftColor = row.kind === "del" ? t.ansi1 : t.foreground;
    const rightColor = row.kind === "add" ? t.ansi2 : t.foreground;
    return h_flex()
      .h(18)
      .flex_none()
      .w_full()
      .child(div().flex_1().min_w(0).child(cell(row.left, leftColor, row.kind === "del" ? `${t.ansi1}18` : null)))
      .child(
        div()
          .flex_1()
          .min_w(0)
          .border_l(1)
          .border_color(t.border)
          .child(cell(row.right, rightColor, row.kind === "add" ? `${t.ansi2}18` : null)),
      );
  }

  diffView(t) {
    const split = this.diffMode === "split";
    const rows = split ? splitDiff(this.diffLines) : [];
    const spec = this.diffSpec;
    return v_flex()
      .flex_1()
      .min_h(0)
      .when(Boolean(spec), (e) =>
        e.child(
          div()
            .flex_none()
            .px(10)
            .py(4)
            .border_b(1)
            .border_color(t.border)
            .truncate()
            .font_family(mono())
            .text_size(10)
            .text_color(t.dim)
            .child(`${spec.name} (${spec.base || "∅"}) ↔ ${spec.name} (${String(spec.sha ?? "").slice(0, 7)})`),
        ),
      )
      .when(Boolean(this.diffError), (e) =>
        e.child(div().p(12).text_size(12).text_color(t.ansi1).child(this.diffError)),
      )
      .when(!this.diffError && this.diffLines.length === 0, (e) =>
        e.child(div().p(12).text_size(12).text_color(t.dim).child("No text diff")),
      )
      .when(!this.diffError && this.diffLines.length > 0, (e) =>
        e.child(
          div()
            .size_full()
            .overflow_y_scroll()
            .child(
              v_flex().children(
                split
                  ? rows.map((row) => this.diffSplitRow(row, t))
                  : this.diffLines.map((line, i) => this.diffLine(line, i, t)),
              ),
            ),
        ),
      );
  }

  render(cx) {
    this.publishTitle();
    const mine = focused()?.pane;
    const ownPane = mine ? panes().find((pane) => pane.pane === mine && pane.mod === "ide") : null;
    if (ownPane) this.paneId = ownPane.pane;
    // Requests are per pane: another editor must not open this file.
    const requested = this.paneId ? shared(`ide.diff.${this.paneId}`) : null;
    const requestedKey = requested ? JSON.stringify(requested) : null;
    const isNewRequest = Boolean(requestedKey) && requestedKey !== this.consumedRequest;
    if (isNewRequest && requestedKey !== this.diffKey && requestedKey !== this.pendingDiff) {
      this.consumedRequest = requestedKey;
      this.pendingDiff = requestedKey;
      cx.spawn(async (cx) => {
        this.pendingDiff = null;
        await this.openDiff(requested, cx);
      });
    }
    const target = this.target();
    if (JSON.stringify(target) !== this.context) this.treeRefresh(cx);
    const t = theme();
    const collapsed = this.collapsed();
    return h_flex()
      .id("ide")
      .size_full()
      .relative()
      .track_focus(this.handle)
      .items_stretch()
      .min_h(0)
      .overflow_hidden()
      .bg(t.background)
      .text_color(t.foreground)
      .text_size(13)
      .on_mouse_move((e, cx) => {
        if (!this.treeDrag) return;
        this.treeWidth = Math.max(160, Math.min(520, this.treeDrag.width + e.position.x - this.treeDrag.x));
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => {
        if (!this.treeDrag) return;
        localStorage.setItem("ide.treeWidth", String(this.treeWidth));
        this.treeDrag = null;
        cx.notify();
      })
      .on_mouse_down_out((_e) => {
        if (!this.treeDrag) return;
        localStorage.setItem("ide.treeWidth", String(this.treeWidth));
        this.treeDrag = null;
      })
      .when(!collapsed, (e) => e.child(this.treeView(t)))
      .when(!collapsed, (e) =>
        e.child(
          div()
            .id("ide-split")
            .w(5)
            .h_full()
            .flex_none()
            .cursor_pointer()
            .hover((handle) => handle.bg(t.border))
            .on_mouse_down("left", (event, cx) => {
              cx.stop_propagation();
              this.treeDrag = { x: event.position.x, width: this.treeWidth };
              cx.notify();
            })
            .on_mouse_up("left", (_e, cx) => {
              if (!this.treeDrag) return;
              localStorage.setItem("ide.treeWidth", String(this.treeWidth));
              this.treeDrag = null;
              cx.notify();
            }),
        ),
      )
      .child(
        v_flex()
          .flex_1()
          .h_full()
          .min_w(0)
          .min_h(0)
          .child(this.header(t, cx, collapsed))
          .when(Boolean(this.diffSpec), (e) => e.child(this.diffView(t)))
          .when(!this.diffSpec && Boolean(this.fileError), (e) =>
            e.child(div().p(12).text_size(12).text_color(t.ansi1).child(this.fileError)),
          )
          .when(
            !this.diffSpec && !this.fileError && this.mdPreview && Boolean(this.code) && this.mdPreviewMode(),
            (e) =>
              e.child(
                div()
                  .flex_1()
                  .min_h(0)
                  .overflow_y_scroll()
                  .px(14)
                  .py(10)
                  .child(
                    TextView.markdown(`ide-md-${hashText(this.file + this.code.value())}`, this.code.value())
                      .selectable(true),
                  ),
              ),
          )
          .when(!this.diffSpec && !this.fileError && Boolean(this.code) && !(this.mdPreview && this.mdPreviewMode()), (e) =>
            e.child(Editor.new(this.code).flex_1().min_h(0)),
          )
          .when(!this.diffSpec && !this.fileError && !this.code, (e) =>
            e.child(
              div()
                .flex_1()
                .p(16)
                .text_size(12)
                .text_color(t.dim)
                .child(this.fileLoading ? "Loading file…" : "Select a file"),
            ),
          ),
      )
      .when(Boolean(this.closePrompt), (e) => e.child(this.closeDialog(t, cx)));
  }
}
