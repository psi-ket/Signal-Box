/** Accounts: registration, login, sessions, CSRF protection, rate limits, persistence of secrets as hashes. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createApp, type App } from "../server/app.ts";
import { sha256 } from "../server/db.ts";
import { silentLogger } from "../server/log.ts";
import { apiCall, register, testConfig } from "./helpers.ts";
import { TestClient } from "./wsClient.ts";

describe("accounts", () => {
  let app: App;
  let port: number;

  beforeAll(async () => {
    app = await createApp({ config: await testConfig({ adminUsernames: ["boss"] }), log: silentLogger, skipDiscovery: true });
    port = await app.listen();
  });
  afterAll(() => app.stop());

  it("registers the first user as site admin and sets a hardened session cookie", async () => {
    const r = await apiCall(port, null, "POST", "/api/register", { username: "first", password: "long-enough-pw" });
    expect(r.status).toBe(201);
    expect(r.body.user).toMatchObject({ username: "first", isAdmin: true });
    const cookie = r.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^sb_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\//);
    const second = await apiCall(port, null, "POST", "/api/register", { username: "second", password: "long-enough-pw" });
    expect(second.body.user.isAdmin).toBe(false);
  });

  it("validates usernames and passwords and rejects duplicates (case-insensitive)", async () => {
    expect((await apiCall(port, null, "POST", "/api/register", { username: "a", password: "long-enough-pw" })).status).toBe(400);
    expect((await apiCall(port, null, "POST", "/api/register", { username: "valid_name", password: "short" })).body.error).toMatch(/at least 10/);
    expect((await apiCall(port, null, "POST", "/api/register", { username: "bad name!", password: "long-enough-pw" })).status).toBe(400);
    expect((await apiCall(port, null, "POST", "/api/register", { username: "FIRST", password: "long-enough-pw" })).status).toBe(409);
  });

  it("logs in, identifies the user, and logs out", async () => {
    const bad = await apiCall(port, null, "POST", "/api/login", { username: "second", password: "wrong-password" });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toBe("wrong username or password");
    const unknown = await apiCall(port, null, "POST", "/api/login", { username: "nobody-here", password: "wrong-password" });
    expect(unknown.body.error).toBe("wrong username or password"); // no user enumeration
    const ok = await apiCall(port, null, "POST", "/api/login", { username: "Second", password: "long-enough-pw" });
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get("set-cookie")!.split(";")[0]!;
    expect((await apiCall(port, cookie, "GET", "/api/me")).body.user.username).toBe("second");
    const ws = await TestClient.connect(port, cookie);
    expect(ws.username).toBe("second");
    ws.close();
    await apiCall(port, cookie, "POST", "/api/logout");
    expect((await apiCall(port, cookie, "GET", "/api/me")).status).toBe(401);
    await expect(TestClient.connect(port, cookie)).rejects.toThrow(/401/);
  });

  it("promotes configured admins", async () => {
    const r = await apiCall(port, null, "POST", "/api/register", { username: "boss", password: "long-enough-pw" });
    expect(r.body.user.isAdmin).toBe(true);
  });

  it("blocks cross-site and non-JSON requests", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/login`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" });
    expect(res.status).toBe(403);
    const noOrigin = await fetch(`http://127.0.0.1:${port}/api/logout`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(noOrigin.status).toBe(403);
    const form = await fetch(`http://127.0.0.1:${port}/api/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: `http://127.0.0.1:${port}` }, body: "a=b" });
    expect(form.status).toBe(415);
  });

  it("rate-limits repeated failed logins for an account", async () => {
    let last = 0;
    for (let i = 0; i < 10; i++) last = (await apiCall(port, null, "POST", "/api/login", { username: "boss", password: "wrong-password" + i })).status;
    expect(last).toBe(429);
  });

  it("stores only hashes of passwords and tokens", async () => {
    const cookie = await register(port, "hashcheck", "my-secret-password");
    const token = decodeURIComponent(cookie.split("=")[1]!);
    const user = app.db.db.prepare("select password_hash from users where username = 'hashcheck'").get() as { password_hash: string };
    expect(user.password_hash).toMatch(/^scrypt\$/);
    expect(user.password_hash).not.toContain("my-secret-password");
    expect(app.db.db.prepare("select count(*) as n from auth_sessions where token_hash = ?").get(sha256(token))).toMatchObject({ n: 1 });
    expect(JSON.stringify(app.db.db.prepare("select * from auth_sessions").all())).not.toContain(token);
  });

  it("can close registration", async () => {
    const closed = await createApp({ config: await testConfig({ registration: "closed" }), log: silentLogger, skipDiscovery: true });
    const p = await closed.listen();
    try {
      expect((await apiCall(p, null, "POST", "/api/register", { username: "owner", password: "long-enough-pw" })).status).toBe(201); // first user can always bootstrap
      expect((await apiCall(p, null, "POST", "/api/register", { username: "other", password: "long-enough-pw" })).status).toBe(403);
    } finally {
      await closed.stop();
    }
  });
});

describe("sign-up rate limit", () => {
  it("limits successful sign-ups per network", async () => {
    const app = await createApp({ config: await testConfig({ registerPerHour: 2 }), log: silentLogger, skipDiscovery: true });
    const p = await app.listen();
    try {
      const codes = [];
      for (const n of ["one1", "two2", "three3"]) codes.push((await apiCall(p, null, "POST", "/api/register", { username: n, password: "long-enough-pw" })).status);
      expect(codes).toEqual([201, 201, 429]);
    } finally {
      await app.stop();
    }
  });
});
