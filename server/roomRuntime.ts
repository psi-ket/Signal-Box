/**
 * One room: authoritative live state, votes, sessions (run on runners), drift, members,
 * roles, chat and password. Room definitions, memberships, roles, bans and chat history
 * are persisted in the database; agent transcripts and votes are live-only.
 *
 * Roles (rank order): viewer < voter < editor < admin
 *   viewer  watch + chat
 *   voter   + vote on team decisions
 *   editor  + start agents (on their own runner) and prompt/cancel/end them
 *   admin   + change roles, remove people, cancel/end any agent, end or close the room
 * Site admins are admin in every room and bypass max people.
 */
import { randomUUID } from "node:crypto";
import { ErrorCode, roleAtLeast, type ClientMessage, type Participant, type Role, type RoomSummary, type RunnerView, type VoteView } from "../shared/protocol.ts";
import type { RunnerToHub } from "../shared/runnerProtocol.ts";
import { verifySecret, type Db, type RoomRow } from "./db.ts";
import { repoNameFromUrl } from "./gitUrl.ts";
import { HubDrift } from "./hubDrift.ts";
import type { Logger } from "./log.ts";
import { buildRecap } from "./recap.ts";
import { Room } from "./room.ts";
import { RunnerRegistry, type RunnerLink } from "./runners.ts";
import { SessionError, SessionManager } from "./sessions.ts";
import { direct, type Connection, type SiteUser } from "./transport.ts";
import { VoteEngine, VoteError } from "./votes.ts";

export class RoomError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface RoomDeps {
  db: Db;
  log: Logger;
  runners: RunnerRegistry;
  dataDir: string;
  allowLocalRepos: boolean;
  voteMs: number;
  ownerWindowMs: number;
  conflictCheck: boolean;
  maxSessions: number;
  onSummaryChange: () => void;
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

/** Removes anything credential-like from a Git URL before showing it. */
export function displayGitUrl(url: string) {
  return url.replace(/\/\/[^/@]*@/, "//");
}

export class RoomRuntime {
  readonly room: Room;
  readonly votes: VoteEngine;
  readonly sessions: SessionManager;
  readonly drift: HubDrift;
  private connCount = new Map<string, number>();
  private conns = new Set<Connection>();
  private ending: Promise<void> | null = null;
  private driftTimer: NodeJS.Timeout | null = null;
  private driftQueued = false;
  closed = false;

  constructor(
    readonly row: RoomRow,
    private deps: RoomDeps,
  ) {
    const creator = deps.db.getUser(row.created_by);
    this.room = new Room({
      roomId: row.id,
      name: row.name,
      repoName: repoNameFromUrl(row.git_url),
      gitUrl: displayGitUrl(row.git_url),
      baseRef: row.base_ref,
      createdAt: row.created_at,
      createdBy: creator?.username ?? "unknown",
      settings: { maxPeople: row.max_people, defaultRole: row.default_role, hasPassword: !!row.password_hash },
      runners: {},
    });
    // Chat history survives restarts.
    this.room.state = { ...this.room.state, chat: deps.db.recentChat(row.id, 200) };
    const log = deps.log.child({ roomId: row.id });
    this.votes = new VoteEngine({
      voteMs: deps.voteMs,
      ownerWindowMs: deps.ownerWindowMs,
      isOnline: (pid) => this.room.state.participants[pid]?.online === true,
      onlineParticipants: () => this.onlineVoters(),
      emit: (view) => this.onVote(view),
    });
    this.sessions = new SessionManager({
      room: this.room,
      roomInfo: { id: row.id, gitUrl: row.git_url, baseRef: row.base_ref },
      votes: this.votes,
      log,
      maxSessions: deps.maxSessions,
      runnerFor: (uid) => deps.runners.forUser(uid),
      runner: (rid) => deps.runners.get(rid),
      hasKey: (rid, pid, provider) => deps.runners.hasKey(rid, pid, provider),
    });
    this.drift = new HubDrift(row.git_url, row.base_ref, deps.dataDir, row.id, deps.allowLocalRepos, deps.conflictCheck);
    void this.drift.init();
    this.room.subscribe((ev) => {
      for (const c of this.conns) c.send(ev);
      if (ev.type === "session.upsert" || ev.type === "room.ended") deps.onSummaryChange();
    });
    this.driftTimer = setInterval(() => this.queueDriftScan(), 10_000);
    this.driftTimer.unref();
  }

  // ---------- lobby-facing ----------

  summary(): RoomSummary {
    const s = this.room.state;
    return {
      id: this.row.id,
      name: s.name,
      repoName: s.repoName,
      createdBy: s.createdBy,
      createdAt: s.createdAt,
      hasPassword: s.settings.hasPassword,
      maxPeople: s.settings.maxPeople,
      online: Object.values(s.participants).filter((p) => p.online).length,
      activeSessions: Object.values(s.sessions).filter((x) => !TERMINAL.has(x.status)).length,
      openVotes: Object.values(s.votes).filter((v) => (v.phase === "open" || v.phase === "awaiting_owner") && v.audience === "team").length,
      ended: s.ended,
    };
  }

  /** Throws RoomError if this user may not enter now. Has no side effects. */
  check(user: SiteUser, password: string | undefined) {
    if (this.closed) throw new RoomError(ErrorCode.NotFound, "this room was closed");
    const member = this.deps.db.member(this.row.id, user.id);
    if (member?.banned && !user.isAdmin) throw new RoomError(ErrorCode.Forbidden, "you were removed from this room");
    const isCreator = this.row.created_by === user.id;
    if (!member && !isCreator && !user.isAdmin && this.row.password_hash && !(password && verifySecret(password, this.row.password_hash)))
      throw new RoomError(ErrorCode.BadPassword, password ? "wrong room password" : "this room needs a password");
    const online = Object.values(this.room.state.participants).filter((p) => p.online && p.id !== user.id).length;
    if (!user.isAdmin && online >= this.row.max_people) throw new RoomError(ErrorCode.RoomFull, `room is full (${this.row.max_people} people)`);
  }

  /** Adds a connection after password/ban/capacity checks. Throws RoomError. */
  attach(conn: Connection, user: SiteUser, password: string | undefined) {
    this.check(user, password);
    const member = this.deps.db.member(this.row.id, user.id);
    const isCreator = this.row.created_by === user.id;
    const role: Role = user.isAdmin || isCreator ? "admin" : (member?.role ?? this.row.default_role);
    if (!member || member.role !== role) this.deps.db.upsertMember(this.row.id, user.id, role);
    conn.roomId = this.row.id;
    this.conns.add(conn);
    const first = (this.connCount.get(user.id) ?? 0) === 0;
    this.connCount.set(user.id, (this.connCount.get(user.id) ?? 0) + 1);
    const prev = this.room.state.participants[user.id];
    this.upsert({ id: user.id, name: user.username, role, isHost: user.isAdmin, online: true, viewingSessionId: prev?.viewingSessionId ?? null, joinedAt: prev?.joinedAt ?? Date.now() });
    this.refreshRunners();
    if (first) this.system(`${user.username} joined as ${role}`);
    direct(conn, "welcome", { roomId: this.row.id, role, myVotes: this.votes.myVotes(user.id), state: this.room.state });
    this.votes.participantsChanged();
    this.deps.onSummaryChange();
  }

  detach(conn: Connection) {
    if (!this.conns.delete(conn)) return;
    conn.roomId = null;
    const pid = conn.user.id;
    const n = (this.connCount.get(pid) ?? 1) - 1;
    this.connCount.set(pid, n);
    const p = this.room.state.participants[pid];
    if (n <= 0 && p) {
      this.upsert({ ...p, online: false, viewingSessionId: null });
      this.system(`${p.name} left`);
      this.votes.participantsChanged();
      this.refreshRunners();
    }
    this.deps.onSummaryChange();
  }

  /** Recomputes which runners are visible here: online members' runners plus the shared one. */
  refreshRunners() {
    const members = new Set(Object.values(this.room.state.participants).filter((p) => p.online).map((p) => p.id));
    const runners: Record<string, RunnerView> = {};
    for (const l of this.deps.runners.all()) if (l.shared || (l.ownerId && members.has(l.ownerId))) runners[l.id] = RunnerRegistry.view(l);
    if (JSON.stringify(runners) === JSON.stringify(this.room.state.runners)) return;
    this.room.dispatch({ type: "runners.update", payload: { runners } });
  }

  runnerGone(link: RunnerLink) {
    this.sessions.runnerGone(link.id);
    this.refreshRunners();
  }

  onRunnerMessage(link: RunnerLink, msg: RunnerToHub): boolean {
    if (msg.type === "runner.drift" || msg.type === "runner.drift_error") {
      const rt = this.sessions.runtime(msg.sessionId);
      if (!rt || rt.runnerId !== link.id) return false;
      if (msg.type === "runner.drift") this.drift.update(msg.sessionId, { baseSha: msg.baseSha, files: msg.files, patch: msg.patch, commits: msg.commits });
      else this.drift.setError(msg.sessionId, msg.error);
      this.queueDriftScan();
      return true;
    }
    return this.sessions.onRunnerMessage(link, msg);
  }

  private queueDriftScan() {
    if (this.driftQueued || this.closed) return;
    this.driftQueued = true;
    setTimeout(() => {
      this.driftQueued = false;
      void this.scanDrift();
    }, 400).unref();
  }

  private scanChain: Promise<void> = Promise.resolve();

  /** Scans run one at a time, in order, so an older scan can never overwrite a newer result. */
  scanDrift(): Promise<void> {
    this.scanChain = this.scanChain.then(() => this.doScan()).catch(() => {});
    return this.scanChain;
  }

  private async doScan() {
    if (this.closed) return;
    const ids = this.room.state.sessionOrder.filter((id) => this.room.state.sessions[id]?.status !== "failed");
    if (!ids.length) return;
    try {
      this.room.dispatch({ type: "drift.report", payload: await this.drift.scan(ids) });
    } catch (e) {
      this.deps.log.warn("drift scan failed", { roomId: this.row.id, error: (e as Error).message });
    }
  }

  // ---------- room messages ----------

  async handle(conn: Connection, msg: ClientMessage, user: SiteUser): Promise<void> {
    const me = this.room.state.participants[user.id];
    if (!me) throw new RoomError(ErrorCode.NotInRoom, "join the room first");
    const role = me.role;
    const need = (min: Role, what: string) => {
      if (!roleAtLeast(role, min)) throw new RoomError(ErrorCode.Forbidden, `${what} needs the ${min} role (you are ${role})`);
    };
    try {
      switch (msg.type) {
        case "presence":
          if (msg.payload.viewingSessionId && !this.room.state.sessions[msg.payload.viewingSessionId]) return;
          this.upsert({ ...me, viewingSessionId: msg.payload.viewingSessionId });
          return;
        case "chat.send":
          this.chat({ id: randomUUID(), at: Date.now(), kind: "user", byId: user.id, byName: me.name, text: msg.payload.text });
          return;
        case "snapshot.request":
          direct(conn, "snapshot", { state: this.room.state, myVotes: this.votes.myVotes(user.id) });
          return;
        case "session.create": {
          need("editor", "starting an agent");
          if (this.room.state.ended) throw new RoomError(ErrorCode.Conflict, "the room has ended");
          const v = this.sessions.create({ id: user.id, name: me.name }, msg.payload);
          this.system(`${me.name} started ${v.provider}${v.model ? `/${v.model}` : ""} agent "${v.title}" on ${v.runnerName}${v.billing === "own" ? " (own API key)" : ""}`);
          return;
        }
        case "session.prompt":
          need("editor", "prompting an agent");
          this.sessions.prompt(msg.payload.sessionId, user.id, msg.payload.text);
          return;
        case "session.cancel":
        case "session.end": {
          const s = this.room.state.sessions[msg.payload.sessionId];
          if (s && s.ownerId === user.id) need("editor", "stopping an agent");
          this.sessions.stop(msg.payload.sessionId, user.id, role === "admin", msg.type === "session.cancel" ? "cancelled" : "completed");
          this.queueDriftScan();
          return;
        }
        case "vote.cast": {
          const v = this.votes.get(msg.payload.voteId);
          if (v?.audience !== "owner") need("voter", "voting");
          this.votes.cast(msg.payload.voteId, user.id, msg.payload.optionId);
          direct(conn, "vote.ack", { voteId: msg.payload.voteId, optionId: msg.payload.optionId });
          return;
        }
        case "vote.resolve":
          this.votes.ownerResolve(msg.payload.voteId, user.id, msg.payload.optionId);
          return;
        case "member.role": {
          need("admin", "changing roles");
          const target = this.room.state.participants[msg.payload.participantId];
          if (!target) throw new RoomError(ErrorCode.NotFound, "no such member");
          if (target.isHost) throw new RoomError(ErrorCode.Forbidden, "site admins are always admin");
          if (target.id === user.id && msg.payload.role !== "admin" && this.admins().length <= 1)
            throw new RoomError(ErrorCode.Conflict, "promote another admin before stepping down");
          this.deps.db.upsertMember(this.row.id, target.id, msg.payload.role);
          this.upsert({ ...target, role: msg.payload.role });
          this.system(`${me.name} made ${target.name} ${msg.payload.role}`);
          this.votes.participantsChanged();
          return;
        }
        case "member.kick": {
          need("admin", "removing people");
          const target = this.room.state.participants[msg.payload.participantId];
          if (!target) throw new RoomError(ErrorCode.NotFound, "no such member");
          if (target.isHost || target.id === user.id || target.id === this.row.created_by) throw new RoomError(ErrorCode.Forbidden, "can't remove that member");
          this.deps.db.banMember(this.row.id, target.id);
          for (const c of [...this.conns]) {
            if (c.user.id !== target.id) continue;
            this.detach(c);
            direct(c, "room.left", { roomId: this.row.id, reason: "kicked" });
          }
          this.room.dispatch({ type: "participant.remove", payload: { participantId: target.id } });
          this.system(`${me.name} removed ${target.name}`);
          return;
        }
        case "room.end":
          need("admin", "ending the room");
          await this.end();
          return;
        default:
          throw new RoomError(ErrorCode.BadMessage, `${msg.type} is not a room message`);
      }
    } catch (e) {
      if (e instanceof VoteError) throw new RoomError(e.code === "forbidden" ? ErrorCode.Forbidden : ErrorCode.Conflict, e.message);
      if (e instanceof SessionError)
        throw new RoomError(
          e.code === "forbidden" ? ErrorCode.Forbidden : e.code === "not_found" ? ErrorCode.NotFound : e.code === "limit" ? ErrorCode.Limit : ErrorCode.Conflict,
          e.message,
        );
      throw e;
    }
  }

  end(): Promise<void> {
    this.ending ??= (async () => {
      const stoppedAt = Date.now();
      this.sessions.stopAll();
      // Wait for each online runner to upload its final snapshot (bounded).
      const waiting = () =>
        this.sessions.sessionIds().filter((sid) => {
          const rt = this.sessions.runtime(sid)!;
          return this.deps.runners.get(rt.runnerId) && this.drift.reportedAt(sid) < stoppedAt;
        });
      for (const deadline = Date.now() + 6000; waiting().length && Date.now() < deadline; ) await new Promise((r) => setTimeout(r, 100));
      await this.scanDrift();
      const recap = await buildRecap(this.room.state, this.sessions, (sid) => this.drift.commits(sid), this.votes.ballotsCast());
      this.room.dispatch({ type: "recap", payload: recap });
      this.room.dispatch({ type: "room.ended", payload: {} });
      this.system("room ended; recap is ready");
    })();
    return this.ending;
  }

  /** Stops everything; members are sent back to the lobby. */
  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.driftTimer) clearInterval(this.driftTimer);
    for (const c of [...this.conns]) {
      this.detach(c);
      direct(c, "room.left", { roomId: this.row.id, reason: "closed" });
    }
    this.votes.dispose();
    this.sessions.stopAll();
    for (const l of this.deps.runners.all()) l.send({ type: "runner.room.closed", roomId: this.row.id });
  }

  async dispose(removeMirror: boolean) {
    await this.drift.dispose(removeMirror);
  }

  role(pid: string): Role | undefined {
    return this.room.state.participants[pid]?.role ?? this.deps.db.member(this.row.id, pid)?.role;
  }

  // ---------- internals ----------

  private admins() {
    return Object.values(this.room.state.participants).filter((p) => p.role === "admin");
  }

  private onlineVoters() {
    return Object.values(this.room.state.participants)
      .filter((p) => p.online && roleAtLeast(p.role, "voter"))
      .map((p) => p.id);
  }

  private upsert(p: Participant) {
    this.room.dispatch({ type: "participant.upsert", payload: p });
  }

  private chat(m: Parameters<Db["addChat"]>[1]) {
    this.deps.db.addChat(this.row.id, m);
    this.room.dispatch({ type: "chat.message", payload: m });
  }

  private system(text: string) {
    this.chat({ id: randomUUID(), at: Date.now(), kind: "system", byId: null, byName: "system", text });
  }

  private onVote(view: VoteView) {
    const prev = this.room.state.votes[view.id];
    this.room.dispatch({ type: "vote.upsert", sessionId: view.sessionId, payload: view });
    if (view.audience !== "team") return;
    if (!prev) this.system(`vote opened: ${view.question}`);
    else if (prev.phase !== view.phase && view.phase === "resolved") {
      const win = view.options.find((o) => o.id === view.resolvedOptionId);
      this.system(`vote closed: ${view.question} → ${win ? win.label : "no decision"} (${view.resolution?.replaceAll("_", " ")})`);
    }
    this.deps.onSummaryChange();
  }
}
