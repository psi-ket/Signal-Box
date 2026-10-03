/**
 * Hub-side drift tracking for one room. Runners upload, per agent session, the changed
 * file list and a binary patch against a base commit. The hub:
 *   - computes overlaps from the file lists (always available);
 *   - keeps a bare mirror of the room's Git URL and rebuilds each session's tree by applying
 *     its patch to the base commit in a temporary index (`git apply --cached`), then runs
 *     `git merge-tree --write-tree` on pairs that share a path to verify real conflicts.
 * If the hub can't read the repo (e.g. private without hub credentials), conflict checks are
 * reported as limited instead of guessed.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { DriftLevel, DriftReport } from "../shared/protocol.ts";
import { git, gitOut } from "./git.ts";
import { gitNetEnv } from "./gitUrl.ts";

export interface SessionDrift {
  baseSha: string;
  files: { path: string; status: string }[];
  patch: string | null; // base64
  commits: number;
  error: string | null;
  at: number;
}

function applyCached(cwd: string, env: Record<string, string>, patch: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["apply", "--cached", "--binary", "--whitespace=nowarn", "-"], { cwd, env: { ...process.env, ...env }, windowsHide: true });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`git apply failed: ${err.trim().slice(0, 300)}`))));
    child.stdin.end(patch);
  });
}

export class HubDrift {
  private mirror: string;
  private ready: Promise<void> | null = null;
  private unavailable: string | null = null;
  private sessions = new Map<string, SessionDrift>();
  private snapCache = new Map<string, string>(); // hash(base+patch) -> commit
  private conflictCache = new Map<string, string[]>();
  private lastFetch = 0;

  constructor(
    private gitUrl: string,
    private baseRef: string,
    dataDir: string,
    roomId: string,
    private allowLocal: boolean,
    private conflictCheck: boolean,
  ) {
    this.mirror = path.join(dataDir, "mirrors", `${roomId}.git`);
  }

  /** Clones the bare mirror in the background. Never throws. */
  init(): Promise<void> {
    this.ready ??= (async () => {
      if (!this.conflictCheck) return;
      try {
        const env = gitNetEnv(this.allowLocal);
        if (!existsSync(this.mirror)) {
          await mkdir(path.dirname(this.mirror), { recursive: true });
          await git(["-c", "protocol.ext.allow=never", "clone", "--bare", "--quiet", "--single-branch", "--branch", this.baseRef, "--", this.gitUrl, this.mirror], { cwd: path.dirname(this.mirror), env });
        }
        this.lastFetch = Date.now();
      } catch (e) {
        this.unavailable = `the hub can't read this repo, so merge conflicts aren't verified (shared files are still shown): ${(e as Error).message.split("\n")[0]!.slice(0, 160)}`;
      }
    })();
    return this.ready;
  }

  update(sessionId: string, d: Omit<SessionDrift, "error" | "at">) {
    this.sessions.set(sessionId, { ...d, error: null, at: Date.now() });
  }

  setError(sessionId: string, error: string) {
    const prev = this.sessions.get(sessionId);
    this.sessions.set(sessionId, { baseSha: prev?.baseSha ?? "", files: prev?.files ?? [], patch: prev?.patch ?? null, commits: prev?.commits ?? 0, error, at: Date.now() });
  }

  forget(sessionId: string) {
    this.sessions.delete(sessionId);
  }

  commits(sessionId: string) {
    return this.sessions.get(sessionId)?.commits ?? 0;
  }

  private async ensureCommit(sha: string): Promise<boolean> {
    const has = async () => (await git(["cat-file", "-e", `${sha}^{commit}`], { cwd: this.mirror, okCodes: [1, 128] })).code === 0;
    if (await has()) return true;
    if (Date.now() - this.lastFetch < 5000) return false;
    this.lastFetch = Date.now();
    await git(["-c", "protocol.ext.allow=never", "fetch", "--quiet", "origin", `+refs/heads/${this.baseRef}:refs/heads/${this.baseRef}`], { cwd: this.mirror, env: gitNetEnv(this.allowLocal), okCodes: [1, 128] }).catch(() => {});
    return has();
  }

  private async snapshot(d: SessionDrift): Promise<string> {
    const key = createHash("sha256").update(d.baseSha).update(d.patch ?? "").digest("hex");
    const hit = this.snapCache.get(key);
    if (hit) return hit;
    const dir = await mkdtemp(path.join(tmpdir(), "colab-hub-"));
    const env = { GIT_INDEX_FILE: path.join(dir, "index"), GIT_AUTHOR_NAME: "colab-drift", GIT_AUTHOR_EMAIL: "colab-drift@localhost", GIT_COMMITTER_NAME: "colab-drift", GIT_COMMITTER_EMAIL: "colab-drift@localhost" };
    try {
      await git(["read-tree", d.baseSha], { cwd: this.mirror, env });
      const patch = Buffer.from(d.patch ?? "", "base64");
      if (patch.length) await applyCached(this.mirror, env, patch);
      const tree = await gitOut(["write-tree"], this.mirror, env);
      const commit = await gitOut(["commit-tree", tree, "-p", d.baseSha, "-m", "colab hub snapshot"], this.mirror, env);
      this.snapCache.set(key, commit);
      if (this.snapCache.size > 500) this.snapCache.clear();
      return commit;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async conflicts(a: string, b: string): Promise<string[]> {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    const hit = this.conflictCache.get(key);
    if (hit) return hit;
    const r = await git(["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", a, b], { cwd: this.mirror, okCodes: [1] });
    const paths = r.code === 1 ? [...new Set(r.stdout.split("\0").slice(1).filter(Boolean))] : [];
    this.conflictCache.set(key, paths);
    if (this.conflictCache.size > 2000) this.conflictCache.clear();
    return paths;
  }

  async scan(sessionIds: string[]): Promise<DriftReport> {
    const started = Date.now();
    await this.init();
    const sessions: DriftReport["sessions"] = {};
    for (const sid of sessionIds) {
      const d = this.sessions.get(sid);
      if (!d) continue; // not reported yet: shown as "not scanned yet"
      sessions[sid] = d.error ? { ok: false, error: d.error, level: "unknown", files: d.files } : { ok: true, error: null, level: "clear", files: d.files };
    }
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
    const notes = new Set<string>();
    if (this.unavailable) notes.add(this.unavailable);
    if (this.conflictCheck && !this.unavailable) {
      const pairs = new Set<string>();
      for (const o of overlaps)
        for (let i = 0; i < o.sessionIds.length; i++) for (let j = i + 1; j < o.sessionIds.length; j++) pairs.add(`${o.sessionIds[i]}|${o.sessionIds[j]}`);
      const snaps = new Map<string, string | null>();
      const snapFor = async (sid: string) => {
        if (snaps.has(sid)) return snaps.get(sid)!;
        const d = this.sessions.get(sid)!;
        let commit: string | null = null;
        if (d.patch === null) notes.add("a session's changes are too large to upload, so its conflicts aren't verified");
        else if (!(await this.ensureCommit(d.baseSha))) notes.add("a session is based on a commit the hub can't fetch yet");
        else
          try {
            commit = await this.snapshot(d);
          } catch (e) {
            notes.add(`couldn't rebuild a session's changes: ${(e as Error).message.slice(0, 120)}`);
          }
        snaps.set(sid, commit);
        return commit;
      };
      for (const pair of pairs) {
        const [a, b] = pair.split("|") as [string, string];
        const [sa, sb] = [await snapFor(a), await snapFor(b)];
        if (!sa || !sb) continue;
        const paths = await this.conflicts(sa, sb);
        if (paths.length) conflicts.push({ sessionIds: [a, b], paths });
      }
    }

    for (const [sid, s] of Object.entries(sessions)) {
      if (!s.ok) continue;
      let level: DriftLevel = "clear";
      if (overlaps.some((o) => o.sessionIds.includes(sid))) level = "overlap";
      if (conflicts.some((c) => c.sessionIds.includes(sid))) level = "conflict";
      s.level = level;
    }
    const baseSha = existsSync(this.mirror) ? await gitOut(["rev-parse", `refs/heads/${this.baseRef}`], this.mirror).catch(() => "") : "";
    return {
      scannedAt: Date.now(),
      durationMs: Date.now() - started,
      baseRef: this.baseRef,
      baseSha: baseSha || ([...this.sessions.values()][0]?.baseSha ?? ""),
      conflictCheck: this.conflictCheck ? "enabled" : "disabled",
      note: notes.size ? [...notes].join("; ") : null,
      sessions,
      overlaps,
      conflicts,
    };
  }

  async dispose(removeMirror: boolean) {
    if (removeMirror) await rm(this.mirror, { recursive: true, force: true }).catch(() => {});
  }
}
