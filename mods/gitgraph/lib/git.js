// Host-facing git reads. The only module that imports the app's `herdr` host module.
import { exec } from "herdr";
import { LOG_FORMAT, parseBranches, parseLog, parseNumstat, parseShowMeta, parseWorktrees, META_FORMAT } from "./parse.js";

// Reading git must not write under .git: the folder watch would see it and refresh forever.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];

// A merge shows no diff against its parents by default; first-parent makes it deterministic.
const MERGE = ["-m", "--first-parent"];

export const COMMIT_LIMIT = 200;

function git(args, { cwd, on, timeout } = {}) {
  return exec("git", [...READ, ...args], { cwd, on, timeout });
}

export async function findRepo(cwd, on) {
  if (!cwd) return null;
  const result = await git(["rev-parse", "--show-toplevel"], { cwd, on, timeout: 15000 });
  return result.code === 0 ? result.stdout.trim() : null;
}

export async function countChanged(root, on) {
  const result = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: root,
    on,
    timeout: 15000,
  });
  if (result.code !== 0) return 0;
  return result.stdout.split("\0").filter(Boolean).length;
}

export async function headSha(root, on) {
  const result = await git(["rev-parse", "HEAD"], { cwd: root, on, timeout: 15000 });
  return result.code === 0 ? result.stdout.trim() : null;
}

export async function loadBranches(root, on) {
  const format = "%(objectname)\t%(refname:short)\t%(committerdate:unix)\t%(HEAD)";
  const result = await git(["for-each-ref", `--format=${format}`, "refs/heads", "refs/remotes"], {
    cwd: root,
    on,
    timeout: 15000,
  });
  return result.code === 0 ? parseBranches(result.stdout) : [];
}

export async function loadWorktrees(root, on) {
  const result = await git(["worktree", "list", "--porcelain", "-z"], { cwd: root, on, timeout: 15000 });
  if (result.code !== 0) return [];
  return parseWorktrees(result.stdout);
}

export async function currentBranch(root, on) {
  const result = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, on, timeout: 15000 });
  if (result.code !== 0) return null;
  const name = result.stdout.trim();
  return name || null;
}

async function remoteNames(root, on) {
  const result = await git(["remote"], { cwd: root, on, timeout: 10000 });
  const names = result.code === 0 ? result.stdout.split("\n").filter(Boolean) : [];
  return names.length ? names : ["origin"];
}

const NO_COMMITS = /does not have any commits yet|unknown revision|ambiguous argument 'HEAD'/i;

export async function loadCommits(root, on, limit = COMMIT_LIMIT, skip = 0) {
  const result = await git(
    ["log", `-n${limit}`, `--skip=${skip}`, "--all", "--topo-order", "--date=unix", `--pretty=format:${LOG_FORMAT}`],
    { cwd: root, on, timeout: 20000 },
  );
  if (result.code === 0) return parseLog(result.stdout, await remoteNames(root, on));
  if (NO_COMMITS.test(result.stderr + result.stdout)) return [];
  throw new Error((result.stderr || result.stdout).trim() || `git log failed (${result.code})`);
}

// `--follow` takes exactly one path and reports the commits that touched it across renames.
export async function loadFileCommits(root, path, on, limit = COMMIT_LIMIT, skip = 0) {
  const result = await git(
    ["log", `-n${limit}`, `--skip=${skip}`, "--follow", "--topo-order", "--date=unix", `--pretty=format:${LOG_FORMAT}`, "--", path],
    { cwd: root, on, timeout: 20000 },
  );
  if (result.code !== 0) {
    if (NO_COMMITS.test(result.stderr + result.stdout)) return [];
    throw new Error((result.stderr || result.stdout).trim() || `git log --follow failed (${result.code})`);
  }
  return parseLog(result.stdout, await remoteNames(root, on));
}

// `path` scopes numstat and diff to one file, so both agree with a file-history selection.
// A commit from before a rename has no diff for the new path: fall back to the whole commit and
// say so, instead of showing an empty change.
export async function loadCommit(root, sha, on, path = null) {
  const meta = await git(["show", "-s", "--no-color", `--format=${META_FORMAT}`, sha], { cwd: root, on });
  if (meta.code !== 0) {
    throw new Error((meta.stderr || meta.stdout).trim() || `git show failed (${meta.code})`);
  }
  const readChange = async (scope) => {
    const stat = await git(
      ["show", ...MERGE, "--numstat", "--format=", "--no-color", sha, ...scope],
      { cwd: root, on },
    );
    return { files: stat.code === 0 ? parseNumstat(stat.stdout) : [] };
  };

  let change = await readChange(path ? ["--", path] : []);
  let scopedEmpty = false;
  if (path && change.files.length === 0) {
    scopedEmpty = true;
    change = await readChange([]);
  }
  return { sha, path: path ?? null, ...parseShowMeta(meta.stdout), ...change, scopedEmpty };
}
