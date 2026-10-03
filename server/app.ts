/**
 * Hub composition root: accounts (HTTP API + session cookies), the database, the lobby,
 * rooms, and runner connections. The hub never runs agent code itself; with --host-runner
 * it additionally starts a runner in-process that runs agents on this machine for anyone
 * (LAN/demo use only).
 */
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { ErrorCode, type ClientMessage, type ProviderId, type RoomSummary } from "../shared/protocol.ts";
import type { RunnerToHub } from "../shared/runnerProtocol.ts";
import { RunnerCore } from "../runner/core.ts";
import { buildProviders, discoverAll, providerEnvFromProcess } from "../runner/providers.ts";
import type { AgentProvider } from "./agents/types.ts";
import type { Config } from "./config.ts";
import { Db } from "./db.ts";
import { GitUrlError, validateGitUrl } from "./gitUrl.ts";
import { createApi } from "./http.ts";
import { createLogger, type Logger } from "./log.ts";
import { RoomError, RoomRuntime } from "./roomRuntime.ts";
import { RunnerRegistry, type RunnerLink } from "./runners.ts";
import { createTransport, direct, type Connection, type RunnerSocket, type SiteUser } from "./transport.ts";

export interface AppOptions {
  config: Config;
  log?: Logger;
  /** Agent overrides for the in-process host runner (tests). */
  providers?: Partial<Record<ProviderId, AgentProvider>>;
  /** Skip slow agent discovery for the host runner (tests). */
  skipDiscovery?: boolean;
}

const BASE_REF_RE = /^[\w.\/-]{1,100}$/;

export async function createApp(opts: AppOptions) {
  const { config } = opts;
  const log = opts.log ?? createLogger();
  const db = new Db(config.dbFile);
  db.purgeExpired();
  const extraOrigins = [...config.allowedOrigins];
  const rooms = new Map<string, RoomRuntime>();
  let port = 0;

  const conns = () => transport.connections();
  const runnerViewsFor = (userId: string) => registry.all().filter((l) => l.shared || l.ownerId === userId).map(RunnerRegistry.view);

  const registry: RunnerRegistry = new RunnerRegistry(db, log, {
    changed(ownerId, link, online) {
      for (const r of rooms.values()) {
        if (!online) r.runnerGone(link);
        else r.refreshRunners();
      }
      for (const c of conns()) if (link.shared || c.user.id === ownerId) direct(c, "runners", { runners: runnerViewsFor(c.user.id) });
      // A runner that just came online reports the keys it holds for its owner.
      if (online && ownerId) link.send({ type: "runner.keys.request", forParticipant: ownerId });
    },
  });

  const api = createApi({
    db,
    log,
    allowedOrigins: () => extraOrigins,
    registration: config.registration,
    adminUsernames: config.adminUsernames,
    secureCookies: config.secureCookies,
    registerPerHour: config.registerPerHour,
    trustProxy: config.trustProxy,
    onRunnerRevoked: (tokenId) => registry.revokeToken(tokenId),
  });

  const summaries = (): RoomSummary[] => [...rooms.values()].filter((r) => !r.closed).map((r) => r.summary()).sort((a, b) => b.createdAt - a.createdAt);
  let lobbyTimer: NodeJS.Timeout | null = null;
  const lobbyChanged = () => {
    if (lobbyTimer) return;
    lobbyTimer = setTimeout(() => {
      lobbyTimer = null;
      const list = summaries();
      for (const c of conns()) if (!c.roomId) direct(c, "lobby.rooms", { rooms: list });
    }, 250);
  };

  const roomDeps = {
    db,
    log,
    runners: registry,
    dataDir: config.dataDir,
    allowLocalRepos: config.allowLocalRepos,
    voteMs: config.voteMs,
    ownerWindowMs: config.ownerWindowMs,
    conflictCheck: config.conflictCheck,
    maxSessions: config.maxSessions,
    onSummaryChange: lobbyChanged,
  };
  for (const row of db.openRooms()) rooms.set(row.id, new RoomRuntime(row, roomDeps));

  const transport = createTransport(
    {
      authenticate: (req) => api.authenticate(req),
      authenticateRunner: (token) => {
        const row = db.runnerForToken(token);
        return row ? { tokenId: row.id } : null;
      },
      allowedOrigins: () => extraOrigins,
      maxConnections: config.maxConnections,
      webDist: config.webDist,
      log,
      route: (req, res) => api.route(req, res),
    },
    {
      onOpen: (c) => {
        direct(c, "lobby", { user: c.user, rooms: summaries(), runners: runnerViewsFor(c.user.id), allowLocalRepos: config.allowLocalRepos, protocolVersion: 3 });
        registry.forUser(c.user.id)?.send({ type: "runner.keys.request", forParticipant: c.user.id });
      },
      onMessage: (c, m) => handle(c, m),
      onClose: (c) => leaveRoom(c),
      onRunnerOpen: (s) => registry.socketOpened(s),
      onRunnerMessage: (s, m) => onRunnerMessage(s, m),
      onRunnerClose: (s) => registry.remove(s.id),
    },
  );

  function fail(conn: Connection, msg: ClientMessage, code: string, message: string) {
    direct(conn, "error", { code, message, replyTo: msg.eventId });
  }

  async function handle(conn: Connection, msg: ClientMessage) {
    const user = conn.user;
    try {
      switch (msg.type) {
        case "room.create": {
          if ([...rooms.values()].filter((r) => !r.closed).length >= config.maxRooms) return fail(conn, msg, ErrorCode.Limit, `at most ${config.maxRooms} open rooms`);
          let gitUrl: string;
          try {
            gitUrl = validateGitUrl(msg.payload.gitUrl, { allowLocal: config.allowLocalRepos });
          } catch (e) {
            if (e instanceof GitUrlError) return fail(conn, msg, ErrorCode.Invalid, e.message);
            throw e;
          }
          const baseRef = msg.payload.baseRef?.trim() || "main";
          if (!BASE_REF_RE.test(baseRef) || baseRef.includes("..")) return fail(conn, msg, ErrorCode.Invalid, "invalid base branch name");
          const row = db.createRoom({
            id: randomBytes(5).toString("hex"),
            name: msg.payload.name,
            git_url: gitUrl,
            base_ref: baseRef,
            password: msg.payload.password || undefined,
            max_people: msg.payload.maxPeople,
            default_role: msg.payload.defaultRole,
            created_by: user.id,
            created_at: Date.now(),
          });
          db.upsertMember(row.id, user.id, "admin");
          const rt = new RoomRuntime(row, roomDeps);
          rooms.set(row.id, rt);
          log.info("room created", { roomId: row.id, by: user.username });
          if (conn.roomId) leaveRoom(conn);
          rt.attach(conn, user, undefined);
          lobbyChanged();
          return;
        }
        case "room.join": {
          const rt = rooms.get(msg.payload.roomId);
          if (!rt || rt.closed) return fail(conn, msg, ErrorCode.NotFound, "no such room");
          if (conn.roomId === rt.row.id) return fail(conn, msg, ErrorCode.Conflict, "already in this room");
          rt.check(user, msg.payload.password); // a failed join leaves you where you were
          if (conn.roomId) leaveRoom(conn);
          rt.attach(conn, user, msg.payload.password);
          return;
        }
        case "room.leave":
          leaveRoom(conn);
          direct(conn, "lobby.rooms", { rooms: summaries() });
          return;
        case "room.close": {
          const rt = conn.roomId ? rooms.get(conn.roomId) : undefined;
          if (!rt) return fail(conn, msg, ErrorCode.NotInRoom, "not in a room");
          if (rt.role(user.id) !== "admin") return fail(conn, msg, ErrorCode.Forbidden, "only room admins can close the room");
          await rt.close();
          db.closeRoom(rt.row.id);
          rooms.delete(rt.row.id);
          await rt.dispose(true);
          lobbyChanged();
          return;
        }
        case "key.set":
        case "key.clear": {
          const runner = registry.forUser(user.id);
          if (!runner) return fail(conn, msg, ErrorCode.Conflict, "connect your runner first; keys are stored on your runner, not on the hub");
          runner.send(msg.type === "key.set" ? { type: "runner.key.set", forParticipant: user.id, vendor: msg.payload.vendor, apiKey: msg.payload.apiKey } : { type: "runner.key.clear", forParticipant: user.id, vendor: msg.payload.vendor });
          return;
        }
        default: {
          const rt = conn.roomId ? rooms.get(conn.roomId) : undefined;
          if (!rt) return fail(conn, msg, ErrorCode.NotInRoom, "join a room first");
          await rt.handle(conn, msg, user);
        }
      }
    } catch (e) {
      if (e instanceof RoomError) return fail(conn, msg, e.code, e.message);
      throw e;
    }
  }

  function onRunnerMessage(sock: RunnerSocket, msg: RunnerToHub) {
    if (msg.type === "runner.hello") {
      registry.hello(sock, msg);
      return;
    }
    const link = registry.bySocket(sock.id);
    if (!link) return; // must say hello first
    switch (msg.type) {
      case "runner.providers":
        registry.updateProviders(link, msg.providers);
        return;
      case "runner.keys": {
        // A personal runner may only report keys for its owner.
        if (!link.shared && msg.forParticipant !== link.ownerId) return;
        link.keys.set(msg.forParticipant, msg.keys);
        for (const c of conns()) if (c.user.id === msg.forParticipant && registry.forUser(c.user.id)?.id === link.id) direct(c, "keys", { keys: msg.keys, last: msg.last });
        return;
      }
      default:
        for (const r of rooms.values()) if (r.onRunnerMessage(link, msg)) return;
    }
  }

  function leaveRoom(conn: Connection) {
    const rt = conn.roomId ? rooms.get(conn.roomId) : undefined;
    rt?.detach(conn);
    conn.roomId = null;
  }

  // ---------- optional in-process host runner ----------

  let hostRunner: RunnerCore | null = null;
  async function startHostRunner() {
    db.db.prepare("delete from runner_tokens where user_id is null").run();
    const { token } = db.createRunnerToken(null, "host");
    const providers = buildProviders(providerEnvFromProcess(config.allowMock), opts.providers ?? {});
    if (!opts.skipDiscovery) await discoverAll(providers, (id, e) => log.warn("agent discovery failed", { provider: id, error: e.message }));
    hostRunner = new RunnerCore({
      hubUrl: `http://127.0.0.1:${port}`,
      token,
      name: "host",
      dataDir: path.join(config.dataDir, "host-runner"),
      providers,
      allowLocalRepos: config.allowLocalRepos,
      log: log.child({ svc: "host-runner" }),
    });
    hostRunner.start();
    // wait until it has registered so the first room can use it
    for (let i = 0; i < 100 && !registry.shared(); i++) await new Promise((r) => setTimeout(r, 50));
  }

  let stopped = false;
  return {
    db,
    rooms,
    registry,
    transport,
    get hostRunner() {
      return hostRunner;
    },
    addAllowedOrigin: (o: string) => extraOrigins.push(o),
    async listen(): Promise<number> {
      await new Promise<void>((r) => transport.server.listen(config.port, config.host, () => r()));
      port = (transport.server.address() as AddressInfo).port;
      if (config.hostRunner) await startHostRunner();
      return port;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (lobbyTimer) clearTimeout(lobbyTimer);
      for (const rt of rooms.values()) await rt.close().catch(() => {});
      if (hostRunner) {
        await hostRunner.stop();
        await hostRunner.cleanup();
      }
      await transport.close();
      db.close();
    },
  };
}

export type App = Awaited<ReturnType<typeof createApp>>;
export type { RunnerLink, SiteUser };
