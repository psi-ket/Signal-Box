/**
 * Personal runners: pairing via the account API, ownership (a runner only runs its owner's
 * agents), revocation, keys held on the runner, own-key sessions, and Git URL safety.
 * Vendor HTTP calls are stubbed; agents are mock or a recording fake.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createApp, type App } from "../server/app.ts";
import { mockProvider } from "../server/agents/mock.ts";
import type { AgentProvider, AgentStartOptions } from "../server/agents/types.ts";
import { checkKey, maskKey } from "../server/keys.ts";
import { GitUrlError, validateGitUrl } from "../server/gitUrl.ts";
import { sha256 } from "../server/db.ts";
import { silentLogger } from "../server/log.ts";
import { RunnerCore } from "../runner/core.ts";
import { apiCall, makeRepo, register, testConfig } from "./helpers.ts";
import { TestClient } from "./wsClient.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const GOOD = "AIzaGOODgoodGOODgoodGOOD1234";
const realFetch = globalThis.fetch;
function stubVendors() {
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (!/googleapis|anthropic\.com|openai\.com/.test(u)) return realFetch(url, init);
    const h = new Headers(init?.headers);
    const key = h.get("x-goog-api-key") ?? h.get("x-api-key") ?? h.get("authorization")?.replace("Bearer ", "");
    if (key !== GOOD) return new Response(JSON.stringify({ error: { message: `API key not valid: ${key}` } }), { status: 401 });
    if (u.includes("googleapis"))
      return new Response(JSON.stringify({ models: [{ name: "models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash", supportedGenerationMethods: ["generateContent"] }, { name: "models/gemini-3.8-flash-tts", supportedGenerationMethods: ["generateContent"] }] }));
    if (u.includes("anthropic")) return new Response(JSON.stringify({ data: [{ id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" }] }));
    return new Response(JSON.stringify({ data: [{ id: "gpt-5" }, { id: "gpt-4o-audio-preview" }, { id: "text-embedding-3-small" }, { id: "o4-mini" }] }));
  });
}

describe("git URL safety", () => {
  it("accepts normal remotes and rejects dangerous or credential-bearing ones", () => {
    for (const ok of ["https://github.com/a/b.git", "git@github.com:a/b.git", "ssh://git@host.com/a/b", "git://host/a/b"]) expect(validateGitUrl(ok, { allowLocal: false })).toBe(ok);
    for (const bad of ["ext::sh -c id", "fd::3", "-uupload-pack=x", "http://github.com/a/b", "https://u:p@github.com/a/b", "https://token@github.com/a/b", "file:///etc", "C:\\Users\\x", "/etc", "a b"])
      expect(() => validateGitUrl(bad, { allowLocal: false }), bad).toThrow(GitUrlError);
    expect(validateGitUrl("file:///tmp/x", { allowLocal: true })).toBe("file:///tmp/x");
  });
});

describe("key checks", () => {
  beforeAll(stubVendors);
  afterAll(() => vi.unstubAllGlobals());
  it("lists usable models per vendor and never echoes a bad key", async () => {
    expect(await checkKey("gemini", GOOD)).toEqual([{ id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" }]);
    expect(await checkKey("anthropic", GOOD)).toEqual([{ id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" }]);
    expect((await checkKey("openai", GOOD)).map((m) => m.id)).toEqual(["o4-mini", "gpt-5"]);
    await expect(checkKey("openai", "sk-wrongwrongwrongwrong12")).rejects.toThrow(/HTTP 401/);
    await expect(checkKey("openai", "sk-wrongwrongwrongwrong12")).rejects.not.toThrow(/wrongwrong/);
    expect(maskKey("sk-abcdefghijklmnop")).toBe("sk-a…mnop");
  });
});

describe("personal runners", () => {
  let app: App;
  let port: number;
  let repo: string;
  const cookies: Record<string, string> = {};
  const runners: RunnerCore[] = [];
  const started: AgentStartOptions[] = [];
  // Recording Gemini API agent: not set up on the runner, but can run on a personal key.
  const fakeGemini: AgentProvider = {
    id: "gemini-api",
    info: () => ({ id: "gemini-api", label: "Gemini API", available: false, note: "no runner key", auth: "none", models: [{ id: "runner-model", label: "x" }], defaultModel: "runner-model", byoVendor: "gemini", byoReady: true }),
    start(o) {
      started.push(o);
      queueMicrotask(() => o.hooks.emit({ type: "turn_end", ok: true }));
      return { send: () => {}, cancel: async () => {}, done: new Promise(() => {}) };
    },
  };

  const startRunner = async (token: string, name: string) => {
    const r = new RunnerCore({
      hubUrl: `http://127.0.0.1:${port}`,
      token,
      name,
      dataDir: await mkdtemp(path.join(tmpdir(), "colab-runner-")),
      providers: { mock: mockProvider({ enabled: true }), "gemini-api": fakeGemini },
      allowLocalRepos: true,
      log: silentLogger,
    });
    runners.push(r);
    r.start();
    return r;
  };

  beforeAll(async () => {
    stubVendors();
    repo = await makeRepo({ "a.txt": "a\n" });
    app = await createApp({ config: await testConfig(), log: silentLogger, skipDiscovery: true });
    port = await app.listen();
    cookies.ana = await register(port, "ana");
    cookies.bob = await register(port, "bob");
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    for (const r of runners) await r.stop();
    await app.stop();
  });

  it("pairs a runner with an account token that is stored only as a hash", async () => {
    const created = await apiCall(port, cookies.ana!, "POST", "/api/runners", { name: "ana-laptop" });
    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^sbr_/);
    expect(JSON.stringify(app.db.db.prepare("select * from runner_tokens").all())).not.toContain(created.body.token);
    expect(app.db.db.prepare("select count(*) as n from runner_tokens where token_hash = ?").get(sha256(created.body.token))).toMatchObject({ n: 1 });
    expect((await apiCall(port, cookies.bob!, "GET", "/api/runners")).body.runners).toEqual([]); // tokens are per account

    const ana = await TestClient.connect(port, cookies.ana!);
    const online = ana.next((m) => m.type === "runners" && m.payload.runners.some((r) => r.name === "ana-laptop"));
    const runner = await startRunner(created.body.token, "ana-laptop");
    await online;
    expect(runner.owner?.name).toBe("ana");
    ana.close();
  });

  it("runs agents only on their owner's runner", async () => {
    const ana = await TestClient.connect(port, cookies.ana!);
    const bob = await TestClient.connect(port, cookies.bob!);
    const w = await ana.createRoom({ name: "r1", gitUrl: repo });
    expect((await bob.joinRoom(w.payload.roomId)).type).toBe("welcome");
    const st = await bob.until((s) => Object.values(s.runners).some((r) => r.name === "ana-laptop"));
    expect(Object.values(st.runners).map((r) => r.ownerName)).toEqual(["ana"]);

    const e = bob.send("session.create", { title: "bob's", task: "say hi", provider: "mock" });
    expect((await bob.errorFor(e)).payload.message).toMatch(/connect a runner first/);
    ana.send("session.create", { title: "ana's", task: "say hello from my laptop", provider: "mock" });
    const done = await bob.until((s) => Object.values(s.sessions).some((x) => x.title === "ana's" && x.status === "idle"), 15_000);
    const sess = Object.values(done.sessions).find((x) => x.title === "ana's")!;
    expect(sess.runnerName).toBe("ana-laptop");
    expect(sess.transcript.some((t) => t.kind === "text" && t.text === "hello from my laptop")).toBe(true);
    ana.close();
    bob.close();
  });

  it("keeps API keys on the owner's runner and runs own-key sessions with them", async () => {
    const ana = await TestClient.connect(port, cookies.ana!);
    const bob = await TestClient.connect(port, cookies.bob!);
    const noRunner = bob.send("key.set", { vendor: "gemini", apiKey: GOOD });
    expect((await bob.errorFor(noRunner)).payload.message).toMatch(/connect your runner first/);

    const bad = ana.next((m) => m.type === "keys" && !!m.payload.last);
    ana.send("key.set", { vendor: "gemini", apiKey: "AIzaBADbadBADbadBADbad99" });
    expect((await bad).payload).toMatchObject({ keys: [], last: { vendor: "gemini", ok: false } });
    const good = ana.next((m) => m.type === "keys" && m.payload.last?.ok === true);
    ana.send("key.set", { vendor: "gemini", apiKey: GOOD });
    const k = (await good).payload as { keys: { masked: string; models: unknown[] }[] };
    expect(k.keys).toEqual([expect.objectContaining({ vendor: "gemini", masked: "AIza…1234", models: [{ id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" }] })]);
    expect(JSON.stringify(ana.messages)).not.toContain(GOOD);
    expect(JSON.stringify(bob.messages)).not.toContain("AIza");

    const w = await ana.joinRoom(ana.rooms[0]!.id);
    if (w.type !== "welcome") throw new Error(JSON.stringify(w.payload));
    const e1 = ana.send("session.create", { title: "runner-billed", task: "x", provider: "gemini-api" });
    expect((await ana.errorFor(e1)).payload.message).toMatch(/not available on ana-laptop.*own API key/);
    ana.send("session.create", { title: "mine", task: "x", provider: "gemini-api", ownKey: true });
    const s = await ana.until((s) => Object.values(s.sessions).some((x) => x.title === "mine" && x.status === "idle"), 15_000);
    expect(Object.values(s.sessions).find((x) => x.title === "mine")).toMatchObject({ billing: "own", model: "gemini-3.8-flash" });
    expect(started.at(-1)).toMatchObject({ apiKey: GOOD, model: "gemini-3.8-flash" });
    ana.close();
    bob.close();
  });

  it("revoking a token disconnects the runner and fails its live agents", async () => {
    const ana = await TestClient.connect(port, cookies.ana!);
    await ana.joinRoom(ana.rooms[0]!.id);
    ana.send("session.create", { title: "long", task: "sleep 60000", provider: "mock" });
    await ana.until((s) => Object.values(s.sessions).some((x) => x.title === "long" && x.status === "running"), 15_000);
    const list = await apiCall(port, cookies.ana!, "GET", "/api/runners");
    const bobDel = await apiCall(port, cookies.bob!, "DELETE", `/api/runners/${list.body.runners[0].id}`);
    expect(bobDel.status).toBe(404); // can't revoke someone else's runner
    await apiCall(port, cookies.ana!, "DELETE", `/api/runners/${list.body.runners[0].id}`);
    const s = await ana.until((s) => Object.values(s.sessions).some((x) => x.title === "long" && x.status === "failed"), 10_000);
    expect(Object.values(s.sessions).find((x) => x.title === "long")!.error).toBe("runner disconnected");
    expect(Object.keys(s.runners)).toEqual([]);
    ana.close();
  });
});
