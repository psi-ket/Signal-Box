import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Config } from "../server/config.ts";
import { git, gitOut } from "../server/git.ts";

/** Creates a throwaway repo on branch main with the given files committed. */
export async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "colab-test-"));
  await git(["init", "-q", "-b", "main"], { cwd: dir });
  await writeFiles(dir, files);
  await git(["add", "-A"], { cwd: dir });
  await git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

export async function writeFiles(dir: string, files: Record<string, string>) {
  for (const [p, c] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, p)), { recursive: true });
    await writeFile(path.join(dir, p), c);
  }
}

export async function porcelain(dir: string) {
  return gitOut(["status", "--porcelain=v2", "--branch", "--untracked-files=all"], dir);
}

export const lines = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n") + "\n";

export async function testConfig(over: Partial<Config> = {}): Promise<Config> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "colab-data-"));
  return {
    host: "127.0.0.1",
    port: 0,
    tunnel: false,
    allowedOrigins: [],
    voteMs: 3000,
    ownerWindowMs: 1500,
    conflictCheck: true,
    maxSessions: 8,
    maxConnections: 50,
    maxRooms: 20,
    webDist: path.join(tmpdir(), "colab-no-dist"),
    dataDir,
    dbFile: path.join(dataDir, "test.db"),
    allowLocalRepos: true,
    hostRunner: false,
    allowMock: true,
    registration: "open",
    adminUsernames: [],
    secureCookies: false,
    registerPerHour: 1000,
    trustProxy: false,
    ...over,
  };
}

/** Account helpers over the real HTTP API. Returns the session cookie. */
export async function register(port: number, username: string, password = "correct-horse-battery"): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/api/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({ username, password }),
  });
  if (res.status !== 201) throw new Error(`register ${username} failed: ${res.status} ${await res.text()}`);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

export async function apiCall(port: number, cookie: string | null, method: string, url: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), origin: `http://127.0.0.1:${port}`, ...(method !== "GET" ? { "content-type": "application/json" } : {}) },
    body: method !== "GET" ? JSON.stringify(body ?? {}) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any, headers: res.headers };
}
