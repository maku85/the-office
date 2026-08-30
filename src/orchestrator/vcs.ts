import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import type { Bus } from "./bus.ts";

interface GitResult {
  ok: boolean;
  out: string;
  err: string;
}

function git(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: 30_000, maxBuffer: 4_000_000 },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          out: (stdout ?? "").trim(),
          err: (stderr ?? "").trim(),
        });
      },
    );
  });
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "goal"
  );
}

/**
 * Version control for the agents' workspace — a git repo that lives entirely
 * inside `workspace/` and has nothing to do with this project's own repo.
 *
 * Each goal gets an isolated worktree on its own `goal/<slug>` branch. Tasks
 * commit as they finish; when the goal passes review the branch is merged into
 * `main` and the worktree removed. Everything degrades to a no-op if git is
 * unavailable or disabled.
 */
export class Vcs {
  enabled = false;
  private readonly root: string;
  private readonly treesDir: string;
  private readonly bus: Bus;
  private readonly active = new Map<string, { tree: string; branch: string }>();

  private constructor(root: string, bus: Bus) {
    this.root = root;
    this.treesDir = path.join(root, ".office", "worktrees");
    this.bus = bus;
  }

  static async create(root: string, bus: Bus, mode: "auto" | "off"): Promise<Vcs> {
    const vcs = new Vcs(root, bus);
    if (mode === "off") return vcs;

    const version = await git(["--version"], root);
    if (!version.ok) {
      bus.emit({
        type: "log",
        level: "warn",
        text: "git not found — the office will run without version control",
      });
      return vcs;
    }

    await vcs.ensureRepo();
    await git(["worktree", "prune"], root);
    vcs.enabled = true;
    return vcs;
  }

  private async ensureRepo(): Promise<void> {
    // Check for `workspace/.git` directly. `git rev-parse` would walk UP the
    // tree and could find an ancestor repo (e.g. this project's own), which we
    // must never touch.
    const ownRepo = await fs
      .stat(path.join(this.root, ".git"))
      .then(() => true)
      .catch(() => false);
    if (!ownRepo) {
      await git(["init", "-q"], this.root);
      await git(["config", "user.email", "office@localhost"], this.root);
      await git(["config", "user.name", "The Office"], this.root);
      await git(["config", "commit.gpgsign", "false"], this.root);
      this.bus.emit({ type: "log", level: "info", text: "vcs: initialised workspace repo" });
    }

    const gitignore = path.join(this.root, ".gitignore");
    let current = "";
    try {
      current = await fs.readFile(gitignore, "utf8");
    } catch {
      /* no .gitignore yet */
    }
    const lines = current.split(/\r?\n/);
    const missing = [".office/", ".DS_Store"].filter((p) => !lines.includes(p));
    if (missing.length) {
      const prefix = current && !current.endsWith("\n") ? `${current}\n` : current;
      await fs.writeFile(gitignore, `${prefix}${missing.join("\n")}\n`);
    }

    const head = await git(["rev-parse", "--verify", "-q", "HEAD"], this.root);
    if (!head.ok) {
      await git(["add", "-A"], this.root);
      await git(["commit", "-q", "-m", "office: initial state", "--allow-empty"], this.root);
    }
  }

  private branchFor(goalId: string, slug: string): string {
    return `goal/${slug}-${goalId.slice(0, 8)}`;
  }

  /** Open an isolated worktree for a goal. Returns the dir agents should use. */
  async startGoal(goalId: string, slug: string): Promise<string> {
    if (!this.enabled) return this.root;
    const tree = path.join(this.treesDir, goalId);
    const branch = this.branchFor(goalId, slug);
    await fs.mkdir(this.treesDir, { recursive: true });

    const r = await git(["worktree", "add", "-b", branch, tree, "HEAD"], this.root);
    if (!r.ok) {
      this.bus.emit({
        type: "log",
        level: "warn",
        text: `vcs: could not create worktree (${r.err}); working on main directly`,
      });
      return this.root;
    }
    this.active.set(goalId, { tree, branch });
    this.bus.emit({ type: "log", level: "info", text: `vcs: branch ${branch}` });
    return tree;
  }

  /** `git diff --stat` for a goal's worktree since its last commit — "" if none
   *  (or git is off). Used to show a reviewer exactly what changed. */
  async diffStat(goalId: string): Promise<string> {
    const g = this.active.get(goalId);
    if (!g) return "";
    const r = await git(["diff", "--stat", "HEAD"], g.tree);
    return r.ok ? r.out : "";
  }

  /** Commit whatever a task changed, if anything. The body is `git diff --stat`,
   *  built deterministically — no fixed string, no LLM turn. */
  async commitTask(goalId: string, agent: string, title: string): Promise<void> {
    const g = this.active.get(goalId);
    if (!g) return;
    await git(["add", "-A"], g.tree);
    const stat = await git(["diff", "--cached", "--stat"], g.tree);
    const body = stat.ok && stat.out ? stat.out.split("\n").slice(-1)[0].trim() : "";
    const msg = `${agent}: ${title}`.slice(0, 200) + (body ? `\n\n${body}` : "");
    const r = await git(["commit", "-q", "-m", msg], g.tree);
    if (r.ok) {
      this.bus.emit({
        type: "log",
        agent,
        level: "info",
        text: `vcs: committed "${title}"${body ? ` — ${body}` : ""}`,
      });
    }
  }

  /** Merge the goal branch into main. Returns the short merge commit on success. */
  async finishGoal(
    goalId: string,
    goalText: string,
  ): Promise<{ merged: boolean; commit?: string }> {
    const g = this.active.get(goalId);
    if (!g) return { merged: false };
    this.active.delete(goalId);

    const merge = await git(
      ["merge", "--no-ff", "-m", `goal: ${goalText}`.slice(0, 200), g.branch],
      this.root,
    );
    if (!merge.ok) {
      await git(["merge", "--abort"], this.root);
      await git(["worktree", "remove", "--force", g.tree], this.root);
      this.bus.emit({
        type: "log",
        level: "warn",
        text: `vcs: merge conflict on ${g.branch}; branch kept for review`,
      });
      return { merged: false };
    }

    const head = await git(["rev-parse", "--short", "HEAD"], this.root);
    await git(["worktree", "remove", "--force", g.tree], this.root);
    await git(["branch", "-d", g.branch], this.root);
    this.bus.emit({ type: "log", level: "info", text: `vcs: merged ${g.branch} → ${head.out}` });
    return { merged: true, commit: head.out };
  }

  /** Tear down a goal's worktree without merging (goal failed or empty). */
  async abandonGoal(goalId: string, keepBranch: boolean): Promise<void> {
    const g = this.active.get(goalId);
    if (!g) return;
    this.active.delete(goalId);
    await git(["worktree", "remove", "--force", g.tree], this.root);
    if (!keepBranch) await git(["branch", "-D", g.branch], this.root);
    this.bus.emit({
      type: "log",
      level: "info",
      text: `vcs: abandoned ${g.branch}${keepBranch ? " (branch kept)" : ""}`,
    });
  }

  /**
   * Revert a previously merged goal. Goal commits are always `--no-ff` merges,
   * so `-m 1` tells git the pre-merge `main` is the mainline to restore.
   */
  async revert(commit: string): Promise<boolean> {
    if (!this.enabled) return false;
    const r = await git(["revert", "--no-edit", "-m", "1", commit], this.root);
    if (!r.ok) {
      await git(["revert", "--abort"], this.root);
      this.bus.emit({
        type: "log",
        level: "warn",
        text: `vcs: revert of ${commit} failed: ${r.err.split("\n")[0]}`,
      });
      return false;
    }
    return true;
  }
}
