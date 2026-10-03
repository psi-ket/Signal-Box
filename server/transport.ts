/**
 * HTTP + WebSocket transport.
 *  /ws      browsers: authenticated by the login session cookie, origin-checked,
 *           64 KB frames, rate-limited, schema-validated.
 *  /runner  runners: authenticated by a runner token in the subprotocol, larger frames
 *           (drift patches), schema-validated.
 *  other    API routes (via `route`) and the static web client.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { ClientMessage, ErrorCode, MAX_MESSAGE_BYTES, WS_SUBPROTOCOL, type DirectEvent, type ServerMessage } from "../shared/protocol.ts";
import { MAX_RUNNER_MESSAGE_BYTES, RUNNER_SUBPROTOCOL, RunnerToHub, TOKEN_PREFIX, type HubToRunner } from "../shared/runnerProtocol.ts";
import type { Logger } from "./log.ts";

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface SiteUser {
  id: string;
  username: string;
  isAdmin: boolean;
}

export interface Connection {
  id: string;
  user: SiteUser;
  /** Same as user.id; kept for room code that predates accounts. */
  participantId: string;
  roomId: string | null;
  send(msg: ServerMessage): void;
  close(code: number, reason: string): void;
}

export interface RunnerSocket {
  id: string;
  tokenId: string;
  send(msg: HubToRunner): void;
  close(code: number, reason: string): void;
}

export interface TransportHandlers {
  onMessage(conn: Connection, msg: ClientMessage): void | Promise<void>;
  onOpen(conn: Connection): void;
  onClose(conn: Connection): void;
  onRunnerOpen(sock: RunnerSocket): void;
  onRunnerMessage(sock: RunnerSocket, msg: RunnerToHub): void | Promise<void>;
  onRunnerClose(sock: RunnerSocket): void;
}

export interface TransportOptions {
  authenticate: (req: http.IncomingMessage) => SiteUser | null;
  authenticateRunner: (token: string) => { tokenId: string } | null;
  allowedOrigins: () => string[];
  maxConnections: number;
  webDist: string;
  log: Logger;
  rate?: { burst: number; perSecond: number };
  /** API routes; return true if handled. */
  route?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

export const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'self'; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

export function originAllowed(origin: string | undefined, host: string | undefined, extra: string[]): boolean {
  if (!origin) return false;
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  if (host && o.host === host) return true;
  if (["localhost", "127.0.0.1", "[::1]"].includes(o.hostname) && host && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) return true;
  return extra.some((e) => e.replace(/\/$/, "") === `${o.protocol}//${o.host}`);
}

export function createTransport(opts: TransportOptions, handlers: TransportHandlers) {
  const { log } = opts;
  const rate = opts.rate ?? { burst: 40, perSecond: 20 };
  const conns = new Map<WebSocket, Connection & { tokens: number; last: number; strikes: number; alive: boolean }>();
  const runners = new Map<WebSocket, RunnerSocket & { alive: boolean }>();

  const server = http.createServer((req, res) => {
    try {
      if (opts.route?.(req, res)) return;
    } catch (e) {
      log.error("route failed", { error: (e as Error).message });
      if (!res.headersSent) res.writeHead(500).end();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json", ...SECURITY_HEADERS }).end('{"ok":true}');
      return;
    }
    const root = opts.webDist;
    if (!existsSync(path.join(root, "index.html"))) {
      res.writeHead(503, { "content-type": "text/plain", ...SECURITY_HEADERS }).end("Web client not built. Run `npm run build`.");
      return;
    }
    let file: string;
    try {
      file = path.resolve(root, "." + decodeURIComponent(url.pathname));
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (!file.startsWith(root + path.sep) && file !== root) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(root, "index.html");
    const type = CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream";
    const cache = file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache";
    res.writeHead(200, { "content-type": type, "cache-control": cache, ...SECURITY_HEADERS });
    if (req.method === "HEAD") res.end();
    else createReadStream(file).pipe(res);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, handleProtocols: (p) => (p.has(WS_SUBPROTOCOL) ? WS_SUBPROTOCOL : false) });
  const rss = new WebSocketServer({ noServer: true, maxPayload: MAX_RUNNER_MESSAGE_BYTES, handleProtocols: (p) => (p.has(RUNNER_SUBPROTOCOL) ? RUNNER_SUBPROTOCOL : false) });

  server.on("upgrade", (req, socket, head) => {
    const reject = (code: number, why: string) => {
      log.warn("ws rejected", { code, why, path: req.url?.slice(0, 40) });
      socket.write(`HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    const url = new URL(req.url ?? "/", "http://x");
    const protocols = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((s) => s.trim());
    if (url.pathname === "/ws") {
      if (!originAllowed(req.headers.origin, req.headers.host, opts.allowedOrigins())) return reject(403, "origin");
      if (!protocols.includes(WS_SUBPROTOCOL)) return reject(400, "protocol");
      const user = opts.authenticate(req);
      if (!user) return reject(401, "not logged in");
      if (conns.size >= opts.maxConnections) return reject(503, "capacity");
      wss.handleUpgrade(req, socket, head, (ws) => acceptBrowser(ws, user));
      return;
    }
    if (url.pathname === "/runner") {
      const token = protocols.find((p) => p.startsWith(TOKEN_PREFIX))?.slice(TOKEN_PREFIX.length) ?? "";
      if (!protocols.includes(RUNNER_SUBPROTOCOL)) return reject(400, "protocol");
      const r = token ? opts.authenticateRunner(token) : null;
      if (!r) return reject(401, "runner token");
      if (runners.size >= opts.maxConnections) return reject(503, "capacity");
      rss.handleUpgrade(req, socket, head, (ws) => acceptRunner(ws, r.tokenId));
      return;
    }
    reject(404, "path");
  });

  function acceptBrowser(ws: WebSocket, user: SiteUser) {
    const conn = {
      id: randomUUID(),
      user,
      participantId: user.id,
      roomId: null as string | null,
      tokens: rate.burst,
      last: Date.now(),
      strikes: 0,
      alive: true,
      send(msg: ServerMessage) {
        if (ws.readyState !== ws.OPEN) return;
        if (ws.bufferedAmount > 8 * 1024 * 1024) return void ws.terminate(); // slow consumer; it resyncs on reconnect
        ws.send(JSON.stringify(msg));
      },
      close(code: number, reason: string) {
        ws.close(code, reason);
      },
    };
    conns.set(ws, conn);
    ws.on("pong", () => (conn.alive = true));
    ws.on("message", (data, isBinary) => {
      const now = Date.now();
      conn.tokens = Math.min(rate.burst, conn.tokens + ((now - conn.last) / 1000) * rate.perSecond);
      conn.last = now;
      if (conn.tokens < 1) {
        conn.strikes++;
        direct(conn, "error", { code: ErrorCode.RateLimited, message: "slow down" });
        if (conn.strikes > 20) ws.close(1008, "rate limit");
        return;
      }
      conn.tokens -= 1;
      if (isBinary) return direct(conn, "error", { code: ErrorCode.BadMessage, message: "binary frames are not supported" });
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return direct(conn, "error", { code: ErrorCode.BadMessage, message: "invalid JSON" });
      }
      const r = ClientMessage.safeParse(parsed);
      if (!r.success) {
        const replyTo = (parsed as { eventId?: unknown })?.eventId;
        return direct(conn, "error", {
          code: ErrorCode.BadMessage,
          message: r.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
          ...(typeof replyTo === "string" ? { replyTo: replyTo.slice(0, 64) } : {}),
        });
      }
      Promise.resolve(handlers.onMessage(conn, r.data)).catch((e) => {
        log.error("handler failed", { type: r.data.type, error: (e as Error).message });
        direct(conn, "error", { code: ErrorCode.Internal, message: "internal error", replyTo: r.data.eventId });
      });
    });
    ws.on("close", () => {
      conns.delete(ws);
      handlers.onClose(conn);
    });
    ws.on("error", (e) => log.warn("ws error", { error: e.message }));
    handlers.onOpen(conn);
  }

  function acceptRunner(ws: WebSocket, tokenId: string) {
    const sock = {
      id: randomUUID(),
      tokenId,
      alive: true,
      send(msg: HubToRunner) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      },
      close(code: number, reason: string) {
        ws.close(code, reason);
      },
    };
    runners.set(ws, sock);
    ws.on("pong", () => (sock.alive = true));
    ws.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }
      const r = RunnerToHub.safeParse(parsed);
      if (!r.success) {
        log.warn("invalid runner message", { issue: r.error.issues[0]?.message, type: (parsed as { type?: string })?.type });
        sock.send({ type: "runner.error", message: `invalid message: ${r.error.issues[0]?.path.join(".")}: ${r.error.issues[0]?.message}` });
        return;
      }
      Promise.resolve(handlers.onRunnerMessage(sock, r.data)).catch((e) => log.error("runner handler failed", { type: r.data.type, error: (e as Error).message }));
    });
    ws.on("close", () => {
      runners.delete(ws);
      handlers.onRunnerClose(sock);
    });
    ws.on("error", (e) => log.warn("runner ws error", { error: e.message }));
    handlers.onRunnerOpen(sock);
  }

  const heartbeat = setInterval(() => {
    for (const map of [conns, runners] as Map<WebSocket, { alive: boolean }>[])
      for (const [ws, c] of map) {
        if (!c.alive) {
          ws.terminate();
          continue;
        }
        c.alive = false;
        ws.ping();
      }
  }, 20_000);
  heartbeat.unref();

  return {
    server,
    connections: () => [...conns.values()],
    runnerSockets: () => [...runners.values()],
    async close() {
      clearInterval(heartbeat);
      for (const ws of [...conns.keys(), ...runners.keys()]) ws.close(1001, "server shutting down");
      wss.close();
      rss.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

export function direct<T extends DirectEvent["type"]>(conn: Pick<Connection, "send">, type: T, payload: Extract<DirectEvent, { type: T }>["payload"]) {
  conn.send({ type, eventId: randomUUID(), timestamp: Date.now(), payload } as DirectEvent);
}
