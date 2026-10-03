/**
 * Git helpers. Every call uses execFile with an argument array; no user string ever
 * reaches a shell.
 */
import { execFile } from "node:child_process";
import path from "node:path";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  constructor(
    public args: string[],
    public result: GitResult,
  ) {
    super(`git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

// Fixed identity for host-created snapshot commits so they never depend on user config.
const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: "colab-drift",
  GIT_AUTHOR_EMAIL: "colab-drift@localhost",
  GIT_COMMITTER_NAME: "colab-drift",
  GIT_COMMITTER_EMAIL: "colab-drift@localhost",
};

export function git(args: string[], opts: { cwd: string; env?: Record<string, string>; okCodes?: number[] }): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: opts.cwd,
        env: { ...process.env, ...SNAPSHOT_IDENTITY, GIT_TERMINAL_PROMPT: "0", ...opts.env },
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : -1) : 0;
        const result = { code, stdout: String(stdout), stderr: String(stderr) };
        if (code === -1) return reject(new GitError(args, { ...result, stderr: result.stderr || String(err?.message) }));
        if (code !== 0 && !(opts.okCodes ?? []).includes(code)) return reject(new GitError(args, result));
        resolve(result);
      },
    );
  });
}

export async function gitOut(args: string[], cwd: string, env?: Record<string, string>): Promise<string> {
  return (await git(args, { cwd, env })).stdout.trim();
}

export interface RepoInfo {
  root: string;
  commonDir: string;
  name: string;
  baseRef: string;
}

export async function inspectRepo(repoPath: string, baseRefOverride?: string): Promise<RepoInfo> {
  const root = await gitOut(["rev-parse", "--path-format=absolute", "--show-toplevel"], repoPath);
  const commonDir = await gitOut(["rev-parse", "--path-format=absolute", "--git-common-dir"], root);
  let baseRef = baseRefOverride;
  if (!baseRef) {
    const head = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root, okCodes: [1] });
    baseRef = head.stdout.trim() || "main";
  }
  await assertRef(root, baseRef);
  return { root: path.resolve(root), commonDir: path.resolve(commonDir), name: path.basename(root), baseRef };
}

export async function assertRef(cwd: string, ref: string) {
  if (!/^[\w./-]{1,100}$/.test(ref) || ref.includes("..") || ref.startsWith("-")) throw new Error(`invalid ref name: ${ref}`);
  await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd });
}

export async function addWorktree(repoRoot: string, worktreePath: string, branch: string, baseRef: string) {
  await git(["check-ref-format", "--branch", branch], { cwd: repoRoot });
  await git(["worktree", "add", "-b", branch, worktreePath, baseRef], { cwd: repoRoot });
}

export async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
  const out = await gitOut(["status", "--porcelain", "--untracked-files=normal"], worktreePath);
  return out.length > 0;
}

export async function removeWorktree(repoRoot: string, worktreePath: string, force = false) {
  await git(["worktree", "remove", ...(force ? ["--force"] : []), worktreePath], { cwd: repoRoot });
}

export async function commitsAhead(repoRoot: string, baseRef: string, branch: string): Promise<number> {
  const out = await gitOut(["rev-list", "--count", `${baseRef}..${branch}`], repoRoot);
  return Number(out) || 0;
}
