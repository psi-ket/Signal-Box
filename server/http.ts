/**
 * Account API (JSON over HTTP). Login sessions use an HttpOnly, SameSite=Lax cookie.
 * State-changing requests must be JSON and come from an allowed Origin (CSRF protection).
 *
 *   POST   /api/register   {username, password}
 *   POST   /api/login      {username, password}
 *   POST   /api/logout
 *   GET    /api/me
 *   GET    /api/runners                 your runner tokens (never the token values)
 *   POST   /api/runners    {name}       create a runner token (returned once)
 *   DELETE /api/runners/:id             revoke
 */
import type http from "node:http";
import { z } from "zod";
import { USERNAME_RE, SESSION_TTL_MS, type Db, type UserRow } from "./db.ts";
import type { Logger } from "./log.ts";
import { originAllowed, SECURITY_HEADERS, type SiteUser } from "./transport.ts";

export const COOKIE = "sb_session";
const MAX_BODY = 16 * 1024;

const Credentials = z.object({
  username: z.string().trim().regex(USERNAME_RE, "username: 3-24 letters, digits, _ or -"),
  password: z.string().min(10, "password: at least 10 characters").max(200),
});

export interface ApiOptions {
  db: Db;
  log: Logger;
  allowedOrigins: () => string[];
  registration: "open" | "closed";
  adminUsernames: string[];
  /** Mark cookies Secure (set when served over https or behind a TLS proxy). */
  secureCookies: boolean;
  /** Successful sign-ups allowed per IP per hour. */
  registerPerHour: number;
  trustProxy?: boolean;
  onRunnerRevoked?: (tokenId: string) => void;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const toSiteUser = (u: UserRow): SiteUser => ({ id: u.id, username: u.username, isAdmin: u.is_admin === 1 });

/** Simple sliding-window limiter keyed by string. */
class Limiter {
  private hits = new Map<string, number[]>();
  constructor(
    private max: number,
    private windowMs: number,
  ) {}
  hit(key: string): boolean {
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 10_000) this.hits.clear();
    return list.length <= this.max;
  }
}

export function createApi(o: ApiOptions) {
  const loginByIp = new Limiter(20, 10 * 60_000);
  const loginByUser = new Limiter(8, 10 * 60_000);
  const registerByIp = new Limiter(o.registerPerHour, 60 * 60_000);

  const userFromReq = (req: http.IncomingMessage): UserRow | undefined => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    return token ? o.db.userForSession(token) : undefined;
  };

  const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...SECURITY_HEADERS, ...headers }).end(JSON.stringify(body));
  };

  const cookie = (token: string, maxAgeMs: number) =>
    `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${o.secureCookies ? "; Secure" : ""}`;

  const readJson = (req: http.IncomingMessage): Promise<unknown> =>
    new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (d: Buffer) => {
        body += d;
        if (body.length > MAX_BODY) {
          reject(new Error("too large"));
          req.destroy();
        }
      });
      req.on("end", () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch {
          reject(new Error("invalid JSON"));
        }
      });
      req.on("error", reject);
    });

  const ip = (req: http.IncomingMessage) => {
    const fwd = o.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0]!.trim() : "";
    return fwd || req.socket.remoteAddress || "?";
  };

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", "http://x");
    const method = req.method ?? "GET";
    const mutating = method !== "GET" && method !== "HEAD";
    if (mutating) {
      if (!originAllowed(req.headers.origin, req.headers.host, o.allowedOrigins())) return send(res, 403, { error: "cross-site request blocked" });
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return send(res, 415, { error: "send JSON" });
    }
    let body: unknown = {};
    if (mutating) {
      try {
        body = await readJson(req);
      } catch (e) {
        return send(res, 400, { error: (e as Error).message });
      }
    }

    if (url.pathname === "/api/me" && method === "GET") {
      const u = userFromReq(req);
      return u ? send(res, 200, { user: toSiteUser(u), registration: o.registration }) : send(res, 401, { error: "not logged in", registration: o.registration });
    }

    if (url.pathname === "/api/register" && method === "POST") {
      if (o.registration === "closed" && o.db.userCount() > 0) return send(res, 403, { error: "registration is closed on this server" });
      const p = Credentials.safeParse(body);
      if (!p.success) return send(res, 400, { error: p.error.issues[0]!.message });
      if (o.db.findUserByName(p.data.username)) return send(res, 409, { error: "that username is taken" });
      if (!registerByIp.hit(ip(req))) return send(res, 429, { error: "too many sign-ups from your network; try again later" });
      const first = o.db.userCount() === 0;
      const admin = first || o.adminUsernames.includes(p.data.username.toLowerCase());
      const user = o.db.createUser(p.data.username, p.data.password, admin);
      o.log.info("user registered", { userId: user.id, admin });
      const token = o.db.createAuthSession(user.id);
      return send(res, 201, { user: toSiteUser(user) }, { "set-cookie": cookie(token, SESSION_TTL_MS) });
    }

    if (url.pathname === "/api/login" && method === "POST") {
      const p = Credentials.safeParse(body);
      const name = typeof (body as { username?: unknown })?.username === "string" ? String((body as { username: string }).username).toLowerCase().slice(0, 30) : "";
      if (!loginByIp.hit(ip(req)) || !loginByUser.hit(name)) return send(res, 429, { error: "too many attempts; wait a few minutes" });
      const user = p.success ? o.db.checkLogin(p.data.username, p.data.password) : null;
      if (!user) return send(res, 401, { error: "wrong username or password" });
      if (o.adminUsernames.includes(user.username.toLowerCase()) && !user.is_admin) o.db.setAdmin(user.id, true);
      const token = o.db.createAuthSession(user.id);
      return send(res, 200, { user: toSiteUser(o.db.getUser(user.id)!) }, { "set-cookie": cookie(token, SESSION_TTL_MS) });
    }

    if (url.pathname === "/api/logout" && method === "POST") {
      const token = parseCookies(req.headers.cookie)[COOKIE];
      if (token) o.db.deleteAuthSession(token);
      return send(res, 200, { ok: true }, { "set-cookie": cookie("", 0) });
    }

    if (url.pathname.startsWith("/api/runners")) {
      const u = userFromReq(req);
      if (!u) return send(res, 401, { error: "not logged in" });
      if (url.pathname === "/api/runners" && method === "GET")
        return send(res, 200, { runners: o.db.runnerTokens(u.id).map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastSeen: r.last_seen })) });
      if (url.pathname === "/api/runners" && method === "POST") {
        const p = z.object({ name: z.string().trim().min(1).max(40) }).safeParse(body);
        if (!p.success) return send(res, 400, { error: "give the runner a name (max 40 characters)" });
        if (o.db.runnerTokens(u.id).length >= 10) return send(res, 409, { error: "you already have 10 runner tokens; revoke one first" });
        const { token, row } = o.db.createRunnerToken(u.id, p.data.name);
        return send(res, 201, { id: row.id, name: row.name, token });
      }
      const m = /^\/api\/runners\/([\w-]+)$/.exec(url.pathname);
      if (m && method === "DELETE") {
        if (!o.db.deleteRunnerToken(u.id, m[1]!)) return send(res, 404, { error: "no such runner" });
        o.onRunnerRevoked?.(m[1]!);
        return send(res, 200, { ok: true });
      }
    }

    return send(res, 404, { error: "not found" });
  }

  return {
    /** Route hook for the transport: handles /api/*. */
    route(req: http.IncomingMessage, res: http.ServerResponse): boolean {
      if (!new URL(req.url ?? "/", "http://x").pathname.startsWith("/api/")) return false;
      handle(req, res).catch((e) => {
        o.log.error("api error", { error: (e as Error).message });
        if (!res.headersSent) send(res, 500, { error: "internal error" });
      });
      return true;
    },
    authenticate(req: http.IncomingMessage): SiteUser | null {
      const u = userFromReq(req);
      return u ? toSiteUser(u) : null;
    },
  };
}
