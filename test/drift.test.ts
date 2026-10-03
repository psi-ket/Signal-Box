import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DriftAnalyzer, supportsMergeTreeWriteTree, SNAPSHOT_REF_PREFIX } from "../server/drift.ts";
import { addWorktree, git, gitOut } from "../server/git.ts";
import { makeRepo, writeFiles, porcelain, lines } from "./helpers.ts";

describe("drift analyzer", () => {
  let repo: string;
  const wt: Record<string, string> = {};

  beforeAll(async () => {
    repo = await makeRepo({ "src/utils.ts": lines(40), "src/config.ts": 'export const APP_NAME = "Todo";\n', "README.md": "hi\n" });
    for (const id of ["a", "b", "c", "d"]) {
      wt[id] = path.join(repo, ".git", "colab", "worktrees", id);
      await addWorktree(repo, wt[id]!, `colab/${id}`, "main");
    }
  });

  it("git supports merge-tree --write-tree", async () => {
    expect(await supportsMergeTreeWriteTree(repo)).toBe(true);
  });

  it("reports clear when nothing changed", async () => {
    const r = await new DriftAnalyzer(repo, "main").scan([{ sessionId: "a", worktree: wt.a! }], { conflictCheck: true });
    expect(r.sessions.a).toMatchObject({ ok: true, level: "clear", files: [] });
  });

  it("detects untracked files, overlap without false conflict, and a real conflict; worktrees untouched", async () => {
    const original = lines(40).split("\n");
    // a: edit top of utils (uncommitted) + new untracked file + conflicting config change
    await writeFiles(wt.a!, {
      "src/utils.ts": ["TOP EDIT", ...original.slice(1)].join("\n"),
      "src/new-a.ts": "export const a = 1;\n",
      "src/config.ts": 'export const APP_NAME = "TaskForge";\n',
    });
    // b: edit bottom of utils, committed on its branch -> overlaps a, merges cleanly
    const bottom = original.slice(); bottom[38] = "BOTTOM EDIT";
    await writeFiles(wt.b!, { "src/utils.ts": bottom.join("\n") });
    await git(["add", "-A"], { cwd: wt.b! });
    await git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "b"], { cwd: wt.b! });
    // c: conflicting config change, uncommitted
    await writeFiles(wt.c!, { "src/config.ts": 'export const APP_NAME = "TodoPro";\n' });
    // d: untouched

    const before = { a: await porcelain(wt.a!), b: await porcelain(wt.b!), c: await porcelain(wt.c!) };
    const headsBefore = await gitOut(["for-each-ref", "refs/heads"], repo);

    const an = new DriftAnalyzer(repo, "main");
    const r = await an.scan(
      ["a", "b", "c", "d"].map((id) => ({ sessionId: id, worktree: wt[id]! })),
      { conflictCheck: true },
    );

    expect(r.sessions.a!.files.map((f) => f.path).sort()).toEqual(["src/config.ts", "src/new-a.ts", "src/utils.ts"]);
    expect(r.sessions.a!.files.find((f) => f.path === "src/new-a.ts")!.status).toBe("A");
    expect(r.overlaps).toEqual([
      { path: "src/config.ts", sessionIds: ["a", "c"] },
      { path: "src/utils.ts", sessionIds: ["a", "b"] },
    ]);
    // a/b overlap on utils.ts but merge cleanly: must NOT be reported as conflict
    expect(r.conflicts).toEqual([{ sessionIds: ["a", "c"], paths: ["src/config.ts"] }]);
    expect(r.sessions.a!.level).toBe("conflict");
    expect(r.sessions.b!.level).toBe("overlap");
    expect(r.sessions.c!.level).toBe("conflict");
    expect(r.sessions.d!.level).toBe("clear");

    // agent worktrees, indexes and branches unchanged by analysis
    expect(await porcelain(wt.a!)).toBe(before.a);
    expect(await porcelain(wt.b!)).toBe(before.b);
    expect(await porcelain(wt.c!)).toBe(before.c);
    expect(await gitOut(["for-each-ref", "refs/heads"], repo)).toBe(headsBefore);
    expect(await readFile(path.join(wt.a!, "src/config.ts"), "utf8")).toContain("TaskForge");

    // snapshot refs live only under refs/colab and are removable
    expect(await gitOut(["for-each-ref", "--format=%(refname)", SNAPSHOT_REF_PREFIX], repo)).toContain("a");
    for (const id of ["a", "b", "c", "d"]) await an.forget(id);
    expect(await gitOut(["for-each-ref", SNAPSHOT_REF_PREFIX], repo)).toBe("");
    await an.dispose();
  });

  it("tracks deletes and renames, and follows main when it advances", async () => {
    const r0 = await makeRepo({ "a.txt": lines(20, "a"), "b.txt": "b\n" });
    const w = path.join(r0, ".git", "colab", "worktrees", "x");
    await addWorktree(r0, w, "colab/x", "main");
    await git(["rm", "-q", "b.txt"], { cwd: w });
    await git(["mv", "a.txt", "renamed.txt"], { cwd: w });
    const an = new DriftAnalyzer(r0, "main");
    const r = await an.scan([{ sessionId: "x", worktree: w }], { conflictCheck: false });
    expect(r.sessions.x!.files).toEqual(expect.arrayContaining([
      { path: "b.txt", status: "D" }, { path: "a.txt", status: "R-from" }, { path: "renamed.txt", status: "R" },
    ]));
    expect(r.conflictCheck).toBe("disabled");
    // advance main; baseSha follows
    await writeFiles(r0, { "c.txt": "c\n" });
    await git(["add", "-A"], { cwd: r0 });
    await git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "main moves"], { cwd: r0 });
    const r2 = await an.scan([{ sessionId: "x", worktree: w }], { conflictCheck: false });
    expect(r2.baseSha).not.toBe(r.baseSha);
    expect(r2.sessions.x!.files.map((f) => f.path)).not.toContain("c.txt");
  });

  it("surfaces scan errors per session instead of failing the report", async () => {
    const an = new DriftAnalyzer(repo, "main");
    const r = await an.scan([{ sessionId: "gone", worktree: path.join(repo, "does-not-exist") }], { conflictCheck: true });
    expect(r.sessions.gone).toMatchObject({ ok: false, level: "unknown" });
    expect(r.sessions.gone!.error).toBeTruthy();
  });
});
