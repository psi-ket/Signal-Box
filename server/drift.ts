/**
 * Drift tracker: detects file overlap (yellow) and verified merge conflicts (red)
 * between agent sessions, including uncommitted and untracked work.
 *
 * Snapshot strategy (agent worktrees are never modified):
 *   1. Copy the worktree's index to a temp file and point GIT_INDEX_FILE at it.
 *   2. `git add -A` into that temp index (respects .gitignore, picks up untracked files).
 *   3. `git write-tree` + `git commit-tree -p HEAD` gives a commit holding the full
 *      working-tree state, stored under the disposable ref refs/colab/snapshots/<id>.
 * The real index, working files, HEAD and branch are untouched. Snapshot commits are
 * unreachable from any user branch and their refs are deleted on cleanup.
 *
 * Comparison strategy:
 *   changed files  = git diff --name-status -M <merge-base(base, snapshot)> <snapshot>
 *                    (merge-base is recomputed every scan, so it follows main as it advances)
 *   overlap        = same repo-relative path changed by >= 2 sessions
 *   conflict       = `git merge-tree --write-tree` of two snapshots exits 1 (Git >= 2.38).
 *                    Only pairs that share a path are checked; directory/file conflicts
 *                    between disjoint paths are not detected.
 */
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriftLevel, DriftReport } from "../shared/protocol.ts";
import { git, gitOut } from "./git.ts";

export interface DriftTarget {
  sessionId: string;
  worktree: string;
}

export interface FileChange {
  path: string;
  status: string; // A, M, D, R, C, T
}

export const SNAPSHOT_REF_PREFIX = "refs/colab/snapshots/";

export async function supportsMergeTreeWriteTree(cwd: string): Promise<boolean> {
  const v = await gitOut(["--version"], cwd);
  const m = /(\d+)\.(\d+)/.exec(v);
  if (!m) return false;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj > 2 || (maj === 2 && min >= 38);
}

export class DriftAnalyzer {
  private lastTree = new Map<string, { tree: string; head: string; commit: string }>();
  private conflictCache = new Map<string, string[]>();
  private tmpRoot: string | null = null;

  constructor(
    private repoRoot: string,
    private baseRef: string,
  ) {}

  private async tmp(): Promise<string> {
    this.tmpRoot ??= await mkdtemp(path.join(tmpdir(), "colab-drift-"));
    return this.tmpRoot;
  }

  /** Commit capturing the worktree's current contents (tracked + untracked, not ignored). */
  async snapshot(t: DriftTarget): Promise<string> {
    const indexPath = await gitOut(["rev-parse", "--path-format=absolute", "--git-path", "index"], t.worktree);
    // Unique per call: concurrent snapshots of one worktree must never share an index file.
    const tmpIndex = path.join(await this.tmp(), `index-${t.sessionId}-${process.hrtime.bigint()}-${Math.random().toString(36).slice(2)}`);
    const env = { GIT_INDEX_FILE: tmpIndex, GIT_OPTIONAL_LOCKS: "0" };
    try {
      const head = await gitOut(["rev-parse", "HEAD"], t.worktree);
      const hasIndex = await stat(indexPath).then(() => true, () => false);
      if (hasIndex) await copyFile(indexPath, tmpIndex);
      else await git(["read-tree", "HEAD"], { cwd: t.worktree, env });
      await git(["add", "-A", "--", "."], { cwd: t.worktree, env });
      const tree = await gitOut(["write-tree"], t.worktree, env);
      const prev = this.lastTree.get(t.sessionId);
      if (prev && prev.tree === tree && prev.head === head) return prev.commit;
      const headTree = await gitOut(["rev-parse", "HEAD^{tree}"], t.worktree);
      const commit =
        tree === headTree ? head : await gitOut(["commit-tree", tree, "-p", head, "-m", `colab drift snapshot ${t.sessionId}`], t.worktree);
      await git(["update-ref", `${SNAPSHOT_REF_PREFIX}${t.sessionId}`, commit], { cwd: this.repoRoot });
      this.lastTree.set(t.sessionId, { tree, head, commit });
      return commit;
    } finally {
      await rm(tmpIndex, { force: true });
    }
  }

  async changedFiles(baseSha: string, snapshot: string): Promise<FileChange[]> {
    const mb = await gitOut(["merge-base", baseSha, snapshot], this.repoRoot);
    const out = (await git(["diff", "--name-status", "-M", "-z", "--no-ext-diff", mb, snapshot], { cwd: this.repoRoot })).stdout;
    const parts = out.split("\0").filter((p) => p.length > 0);
    const files: FileChange[] = [];
    for (let i = 0; i < parts.length; ) {
      const status = parts[i++]!;
      const code = status[0]!;
      if (code === "R" || code === "C") {
        const from = parts[i++]!;
        const to = parts[i++]!;
        files.push({ path: from, status: code === "R" ? "R-from" : "C-from" }, { path: to, status: code });
      } else {
        files.push({ path: parts[i++]!, status: code });
      }
    }
    return files;
  }

  /** Paths that conflict when merging the two snapshots, or [] if they merge cleanly. */
  async conflicts(a: string, b: string): Promise<string[]> {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    const cached = this.conflictCache.get(key);
    if (cached) return cached;
    const r = await git(["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", a, b], {
      cwd: this.repoRoot,
      okCodes: [1],
    });
    // Output: <tree-oid>\0<conflicted path>\0... ; exit 1 means conflicts.
    const paths = r.code === 1 ? [...new Set(r.stdout.split("\0").slice(1).filter(Boolean))] : [];
    this.conflictCache.set(key, paths);
    return paths;
  }

  async scan(targets: DriftTarget[], opts: { conflictCheck: boolean }): Promise<DriftReport> {
    const started = Date.now();
    const baseSha = await gitOut(["rev-parse", `${this.baseRef}^{commit}`], this.repoRoot);
    const sessions: DriftReport["sessions"] = {};
    const snaps = new Map<string, string>();

    await Promise.all(
      targets.map(async (t) => {
        try {
          const snap = await this.snapshot(t);
          const files = await this.changedFiles(baseSha, snap);
          snaps.set(t.sessionId, snap);
          sessions[t.sessionId] = { ok: true, error: null, level: "clear", files };
        } catch (e) {
          sessions[t.sessionId] = { ok: false, error: (e as Error).message.slice(0, 300), level: "unknown", files: [] };
        }
      }),
    );

    const byPath = new Map<string, string[]>();
    for (const [sid, s] of Object.entries(sessions))
      for (const f of s.files) {
        const list = byPath.get(f.path) ?? [];
        if (!list.includes(sid)) list.push(sid);
        byPath.set(f.path, list);
      }
    const overlaps = [...byPath.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([p, sessionIds]) => ({ path: p, sessionIds: sessionIds.sort() }))
      .sort((x, y) => x.path.localeCompare(y.path));

    const conflicts: DriftReport["conflicts"] = [];
    if (opts.conflictCheck) {
      const pairs = new Set<string>();
      for (const o of overlaps)
        for (let i = 0; i < o.sessionIds.length; i++)
          for (let j = i + 1; j < o.sessionIds.length; j++) pairs.add(`${o.sessionIds[i]}|${o.sessionIds[j]}`);
      for (const pair of pairs) {
        const [a, b] = pair.split("|") as [string, string];
        try {
          const paths = await this.conflicts(snaps.get(a)!, snaps.get(b)!);
          if (paths.length) conflicts.push({ sessionIds: [a, b], paths });
        } catch (e) {
          for (const sid of [a, b]) {
            const s = sessions[sid]!;
            s.ok = false;
            s.error = `conflict check failed: ${(e as Error).message.slice(0, 200)}`;
          }
        }
      }
    }

    for (const [sid, s] of Object.entries(sessions)) {
      if (!s.ok) {
        s.level = "unknown";
        continue;
      }
      let level: DriftLevel = "clear";
      if (overlaps.some((o) => o.sessionIds.includes(sid))) level = "overlap";
      if (conflicts.some((c) => c.sessionIds.includes(sid))) level = "conflict";
      s.level = level;
    }

    return {
      scannedAt: Date.now(),
      durationMs: Date.now() - started,
      baseRef: this.baseRef,
      baseSha,
      conflictCheck: opts.conflictCheck ? "enabled" : "disabled",
      note: null,
      sessions,
      overlaps,
      conflicts,
    };
  }

  async forget(sessionId: string) {
    this.lastTree.delete(sessionId);
    await git(["update-ref", "-d", `${SNAPSHOT_REF_PREFIX}${sessionId}`], { cwd: this.repoRoot, okCodes: [1] }).catch(() => {});
  }

  async dispose() {
    if (this.tmpRoot) await rm(this.tmpRoot, { recursive: true, force: true });
  }
}

/** Polls the analyzer on an interval; never runs two scans at once. */
export class DriftTracker {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private followUp: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private analyzer: DriftAnalyzer,
    private opts: {
      intervalMs: number;
      conflictCheck: boolean;
      targets: () => DriftTarget[];
      onReport: (r: DriftReport) => void;
      onError: (e: Error) => void;
    },
  ) {}

  start() {
    this.timer = setInterval(() => void this.scanNow(), this.opts.intervalMs);
    this.timer.unref();
  }

  /** Runs a scan. If one is in flight, a fresh scan is queued after it so callers never get a stale result. */
  scanNow(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) {
      this.followUp ??= this.running.then(() => {
        this.followUp = null;
        return this.scanNow();
      });
      return this.followUp;
    }
    this.running = (async () => {
      try {
        this.opts.onReport(await this.analyzer.scan(this.opts.targets(), { conflictCheck: this.opts.conflictCheck }));
      } catch (e) {
        this.opts.onError(e as Error);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /** Stops polling; after this no scan runs again (worktrees may be removed next). */
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.followUp;
    await this.running;
  }
}
