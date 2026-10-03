/**
 * Integration tests: real hub (HTTP + WebSocket + SQLite), real in-process host runner
 * (clone, worktrees, policy, drift patches), real vote engine. Agents are the MOCK provider
 * (scripted, no AI); live agents are verified by scripts/live-e2e.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import WebSocket from "ws";
import { createApp, type App } from "../server/app.ts";
import { silentLogger } from "../server/log.ts";
import { WS_SUBPROTOCOL, type RoomState, type SessionView, type VoteView } from "../shared/protocol.ts";
import { lines, makeRepo, register, testConfig } from "./helpers.ts";
import { TestClient } from "./wsClient.ts";

const byTitle = (s: RoomState, title: string) => Object.values(s.sessions).find((x) => x.title === title);
const openVote = (s: { votes: Record<string, VoteView> }, sessionId: string, kind?: "question" | "permission") =>
  Object.values(s.votes).find((v) => v.sessionId === sessionId && v.phase === "open" && (!kind || v.kind === kind));

describe("hub + host runner integration (mock agents)", () => {
  let repo: string;
  let app: App;
  let port: number;
  let ana: TestClient; // first account: site admin, room creator
  let bob: TestClient;
  let cara: TestClient;
  const cookies: Record<string, string> = {};
  let roomId: string;
  let config: Awaited<ReturnType<typeof testConfig>>;

  const connect = async (name: string) => TestClient.connect(port, cookies[name]!);

  beforeAll(async () => {
    repo = await makeRepo({ "src/config.ts": 'export const APP_NAME = "Todo";\n', "src/utils.ts": lines(40), "README.md": "demo\n" });
    config = await testConfig({ hostRunner: true });
    app = await createApp({ config, log: silentLogger, skipDiscovery: true });
    port = await app.listen();
    for (const n of ["ana", "bob", "cara", "dana", "dee"]) cookies[n] = await register(port, n);
    ana = await connect("ana");
    bob = await connect("bob");
    cara = await connect("cara");
  });

  afterAll(async () => {
    for (const c of [ana, bob, cara]) c?.close();
    await app?.stop();
  });

  it("requires a login for the WebSocket and rejects foreign origins", async () => {
    await expect(TestClient.connect(port, null)).rejects.toThrow(/401/);
    await expect(TestClient.connect(port, "sb_session=forged")).rejects.toThrow(/401/);
    await expect(TestClient.connect(port, cookies.ana!, { origin: "https://evil.example" })).rejects.toThrow(/403/);
    const noProto = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}`, headers: { cookie: cookies.ana! } });
    await expect(new Promise((res, rej) => (noProto.on("open", res), noProto.on("unexpected-response", (_q, r) => rej(new Error(String(r.statusCode))))))).rejects.toThrow(/400/);
  });

  it("identifies users from their session and shows the shared host runner", () => {
    expect(ana.username).toBe("ana");
    expect(ana.runners.some((r) => r.shared && r.name === "host")).toBe(true);
  });

  it("validates messages", async () => {
    const id = ana.send("chat.send", { text: "hi" });
    expect((await ana.errorFor(id)).payload.code).toBe("not_in_room");
    ana.ws.send(JSON.stringify({ type: "vote.cast", eventId: "e1", timestamp: 1, payload: { voteId: "" } }));
    expect((await ana.errorFor("e1")).payload.code).toBe("bad_message");
  });

  it("rejects unsafe or invalid Git URLs", async () => {
    for (const gitUrl of ["ext::sh -c touch% /tmp/pwned", "http://example.com/repo.git", "https://user:pass@example.com/r.git", "-u", "ftp://x/y"]) {
      const id = bob.send("room.create", { name: "bad", gitUrl, maxPeople: 4, defaultRole: "editor" });
      expect((await bob.errorFor(id)).payload.code, gitUrl).toBe("invalid");
    }
  });

  it("creates a password-protected room listed without its secrets", async () => {
    const w = await ana.createRoom({ name: "main", gitUrl: repo, password: "s3cret", maxPeople: 5, defaultRole: "editor" });
    roomId = w.payload.roomId;
    expect(w.payload.role).toBe("admin");
    await bob.waitFor((m) => m.type === "lobby.rooms" && m.payload.rooms.some((r) => r.id === roomId));
    expect(bob.rooms.find((r) => r.id === roomId)).toMatchObject({ name: "main", hasPassword: true, maxPeople: 5, createdBy: "ana" });
    expect(JSON.stringify(bob.rooms)).not.toContain("s3cret");
  });

  it("enforces the room password, then remembers members", async () => {
    expect((await bob.joinRoom(roomId)).payload).toMatchObject({ code: "bad_password" });
    expect((await bob.joinRoom(roomId, "nope")).payload).toMatchObject({ code: "bad_password" });
    expect((await bob.joinRoom(roomId, "s3cret")).type).toBe("welcome");
    expect((await cara.joinRoom(roomId, "s3cret")).type).toBe("welcome");
    const s = await ana.until((s) => Object.values(s.participants).filter((p) => p.online).length === 3);
    expect(Object.values(s.participants).map((p) => `${p.name}:${p.role}:${p.isHost}`).sort()).toEqual(["ana:admin:true", "bob:editor:false", "cara:editor:false"]);
    // Bob comes back on a new connection: no password needed as a member
    bob.close();
    bob = await connect("bob");
    expect((await bob.joinRoom(roomId)).type).toBe("welcome");
  });

  let s1: SessionView;
  it("runs agents on the runner, in separate worktrees and branches, streaming to everyone", async () => {
    ana.send("session.create", { title: "Database", task: "say Planning the storage layer\nask Which database should we use? | PostgreSQL | SQLite\nsay Done", provider: "mock" });
    bob.send("session.create", { title: "Rename A", task: 'write src/config.ts :: export const APP_NAME = "TaskForge";\\n', provider: "mock" });
    cara.send("session.create", { title: "Rename B", task: 'write src/config.ts :: export const APP_NAME = "TodoPro";\\n', provider: "mock", model: "script" });
    const st = await cara.until((s) => Object.keys(s.sessions).length === 3 && Object.values(s.sessions).every((x) => x.status !== "starting"), 20_000);
    s1 = byTitle(st, "Database")!;
    expect(Object.values(st.sessions).every((x) => x.runnerName === "host")).toBe(true);
    expect(new Set(Object.values(st.sessions).map((s) => s.branch)).size).toBe(3);
    const wts = Object.keys(st.sessions).map((id) => app.hostRunner!.sessionWorktree(id)!);
    expect(new Set(wts).size).toBe(3);
    for (const w of wts) expect(existsSync(w)).toBe(true);
    await cara.until((s) => s.sessions[s1.id]!.transcript.some((t) => t.kind === "text" && t.text.includes("Planning the storage layer")));
    expect(JSON.stringify(cara.state)).not.toContain(wts[0]!); // runner paths never reach clients
  });

  it("puts a structured question to a team vote and resumes the agent with the result", async () => {
    await ana.until((s) => !!openVote(s, s1.id), 15_000);
    const vote = openVote(ana.state!, s1.id)!;
    const sqlite = vote.options.find((o) => o.label === "SQLite")!.id;
    const pg = vote.options.find((o) => o.label === "PostgreSQL")!.id;
    bob.send("vote.cast", { voteId: vote.id, optionId: sqlite });
    await bob.waitFor((m) => m.type === "vote.ack");
    const dup = bob.send("vote.cast", { voteId: vote.id, optionId: pg });
    expect((await bob.errorFor(dup)).payload.message).toMatch(/already voted/);
    cara.send("vote.cast", { voteId: vote.id, optionId: sqlite });
    ana.send("vote.cast", { voteId: vote.id, optionId: pg });
    const resolved = await ana.until((s) => s.votes[vote.id]!.phase === "resolved", 8000);
    expect(resolved.votes[vote.id]).toMatchObject({ resolvedOptionId: sqlite, resolution: "majority" });
    const after = await ana.until((s) => s.sessions[s1.id]!.status === "idle", 10_000);
    expect(after.sessions[s1.id]!.transcript.some((i) => i.kind === "tool_call" && i.result?.includes("team chose: SQLite"))).toBe(true);
    expect(after.chat.some((m) => m.kind === "system" && /vote closed: .* → SQLite/.test(m.text))).toBe(true);
  });

  it("sends routine permission requests to the agent's owner only; the runner blocks dangerous ones", async () => {
    ana.send("session.prompt", { sessionId: s1.id, text: "run rm -rf src\nrun npm install left-pad" });
    const st = await ana.until((s) => !!openVote(s, s1.id, "permission"), 10_000);
    const pv = openVote(st, s1.id, "permission")!;
    expect(pv).toMatchObject({ audience: "owner", ownerId: ana.userId });
    expect(st.sessions[s1.id]!.transcript.find((i) => i.kind === "tool_call" && i.summary === "rm -rf src")).toMatchObject({ status: "denied" });
    const id = bob.send("vote.cast", { voteId: pv.id, optionId: pv.options.find((o) => o.label === "Approve")!.id });
    expect((await bob.errorFor(id)).payload.code).toBe("forbidden");
    ana.send("vote.cast", { voteId: pv.id, optionId: pv.options.find((o) => o.label === "Deny")!.id });
    const done = await ana.until((s) => s.sessions[s1.id]!.status === "idle", 10_000);
    expect(done.sessions[s1.id]!.transcript.find((i) => i.kind === "tool_call" && i.summary === "npm install left-pad")).toMatchObject({ status: "denied" });
  });

  it("enforces ownership and roles", async () => {
    const id = cara.send("session.prompt", { sessionId: s1.id, text: "say hijack" });
    expect((await cara.errorFor(id)).payload.code).toBe("forbidden");
    ana.send("member.role", { participantId: cara.userId, role: "viewer" });
    await cara.until((s) => s.participants[cara.userId]!.role === "viewer");
    const c1 = cara.send("session.create", { title: "nope", task: "say x", provider: "mock" });
    expect((await cara.errorFor(c1)).payload.message).toMatch(/needs the editor role/);
    ana.send("member.role", { participantId: cara.userId, role: "editor" });
    await cara.until((s) => s.participants[cara.userId]!.role === "editor");
  });

  it("shows amber overlap and verifies the real conflict from runner patches", async () => {
    await ana.until((s) => byTitle(s, "Rename A")?.status === "idle" && byTitle(s, "Rename B")?.status === "idle", 10_000);
    const s = await ana.until((s) => !!s.drift && s.drift.conflicts.length > 0, 20_000);
    const a = byTitle(s, "Rename A")!.id;
    const b = byTitle(s, "Rename B")!.id;
    expect(s.drift!.conflicts).toEqual([{ sessionIds: [a, b].sort(), paths: ["src/config.ts"] }]);
    expect(s.drift!.sessions[a]!.files).toEqual([{ path: "src/config.ts", status: "M" }]);
    expect(s.drift!.note).toBeNull();
  });

  it("kicks are persistent; max people applies (site admins exempt)", async () => {
    const dee = await connect("dee");
    expect((await dee.joinRoom(roomId, "s3cret")).type).toBe("welcome");
    const left = dee.next((m) => m.type === "room.left");
    ana.send("member.kick", { participantId: dee.userId });
    expect((await left).payload).toMatchObject({ reason: "kicked" });
    expect((await dee.joinRoom(roomId, "s3cret")).payload).toMatchObject({ code: "forbidden" });
    dee.close();

    const tiny = await bob.createRoom({ name: "tiny", gitUrl: repo, maxPeople: 1, defaultRole: "voter" });
    expect((await cara.joinRoom(tiny.payload.roomId)).payload).toMatchObject({ code: "room_full" });
    expect((await ana.joinRoom(tiny.payload.roomId)).type).toBe("welcome"); // site admin
    for (const c of [ana, bob]) expect((await c.joinRoom(roomId)).type).toBe("welcome");
  });

  it("denies a permission request immediately when its owner is offline", async () => {
    const dana = await connect("dana");
    await dana.joinRoom(roomId, "s3cret");
    dana.send("session.create", { title: "Offline owner", task: "sleep 1500\nrun npm install foo\nsay after", provider: "mock" });
    await ana.until((s) => byTitle(s, "Offline owner")?.status === "running", 15_000);
    dana.close();
    const sid = byTitle(ana.state!, "Offline owner")!.id;
    const done = await ana.until((s) => s.sessions[sid]!.status === "idle", 15_000);
    expect(Object.values(done.votes).find((x) => x.sessionId === sid)).toMatchObject({ audience: "owner", resolution: "fallback_owner_absent" });
  });

  it("only admins end the room; the recap uses runner-reported commits and files", async () => {
    const id = bob.send("room.end", {});
    expect((await bob.errorFor(id)).payload.code).toBe("forbidden");
    ana.send("room.end", {});
    const s = await ana.until((s) => s.ended && !!s.recap, 20_000);
    const rename = s.recap!.sessions.find((x) => x.title === "Rename A")!;
    expect(rename.filesChanged).toEqual(["M src/config.ts"]);
    expect(s.recap!.unresolvedConflicts).toHaveLength(1);
  });

  it("persists rooms, roles, bans and chat across a hub restart", async () => {
    cara.send("chat.send", { text: "see you after the restart" });
    await ana.until((s) => s.chat.some((m) => m.text === "see you after the restart"));
    // A second hub instance on the same database file (as after a restart).
    const app2 = await createApp({ config: { ...config, hostRunner: false, port: 0 }, log: silentLogger, skipDiscovery: true });
    const port2 = await app2.listen();
    try {
      const again = await TestClient.connect(port2, cookies.cara!); // session cookie survives too
      expect(again.rooms.some((r) => r.id === roomId)).toBe(true);
      const w = await again.joinRoom(roomId);
      if (w.type !== "welcome") throw new Error(JSON.stringify(w.payload));
      expect(w.payload.role).toBe("editor");
      expect(w.payload.state.chat.some((m) => m.text === "see you after the restart")).toBe(true);
      again.close();
    } finally {
      await app2.stop();
    }
  });

  it("closing a room returns members to the lobby", async () => {
    const left = bob.next((m) => m.type === "room.left");
    const id = bob.send("room.close", {});
    expect((await bob.errorFor(id)).payload.code).toBe("forbidden");
    ana.send("room.close", {});
    expect((await left).payload).toMatchObject({ reason: "closed" });
    await bob.waitFor((m) => m.type === "lobby.rooms" && !m.payload.rooms.some((r) => r.id === roomId));
  });
});
