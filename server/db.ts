/**
 * Persistence (SQLite via node:sqlite): users, login sessions, rooms, memberships,
 * runner tokens and room chat. Live agent state (transcripts, votes, drift) stays in memory.
 * Secrets are stored only as hashes: passwords and room passwords with scrypt, session and
 * runner tokens with SHA-256.
 */
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChatMessage, Role } from "../shared/protocol.ts";

export interface UserRow {
  id: string;
  username: string;
  is_admin: number;
  created_at: number;
}

export interface RoomRow {
  id: string;
  name: string;
  git_url: string;
  base_ref: string;
  password_hash: string | null;
  max_people: number;
  default_role: Role;
  created_by: string;
  created_at: number;
  closed_at: number | null;
}

export interface RunnerTokenRow {
  id: string;
  user_id: string | null;
  name: string;
  created_at: number;
  last_seen: number | null;
}

const SCHEMA = `
create table if not exists users (
  id text primary key,
  username text not null unique collate nocase,
  password_hash text not null,
  is_admin integer not null default 0,
  created_at integer not null
);
create table if not exists auth_sessions (
  token_hash text primary key,
  user_id text not null references users(id) on delete cascade,
  created_at integer not null,
  expires_at integer not null
);
create table if not exists rooms (
  id text primary key,
  name text not null,
  git_url text not null,
  base_ref text not null,
  password_hash text,
  max_people integer not null,
  default_role text not null,
  created_by text not null references users(id),
  created_at integer not null,
  closed_at integer
);
create table if not exists room_members (
  room_id text not null references rooms(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  role text not null,
  banned integer not null default 0,
  joined_at integer not null,
  primary key (room_id, user_id)
);
create table if not exists runner_tokens (
  id text primary key,
  token_hash text not null unique,
  user_id text references users(id) on delete cascade,
  name text not null,
  created_at integer not null,
  last_seen integer
);
create table if not exists chat_messages (
  id text primary key,
  room_id text not null references rooms(id) on delete cascade,
  at integer not null,
  kind text not null,
  by_id text,
  by_name text not null,
  text text not null
);
create index if not exists chat_by_room on chat_messages(room_id, at);
`;

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function hashSecret(secret: string): string {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${scryptSync(secret, salt, 32).toString("hex")}`;
}

export function verifySecret(secret: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const got = scryptSync(secret, salt, 32);
  const want = Buffer.from(hash, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

// A fixed dummy hash so failed logins for unknown users cost the same as real ones.
const DUMMY_HASH = hashSecret(randomBytes(12).toString("hex"));

export const USERNAME_RE = /^[a-zA-Z0-9_-]{3,24}$/;
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export class Db {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("pragma journal_mode = wal; pragma foreign_keys = on;");
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  // ---------- users & auth ----------

  createUser(username: string, password: string, isAdmin: boolean): UserRow {
    const row: UserRow = { id: randomUUID(), username, is_admin: isAdmin ? 1 : 0, created_at: Date.now() };
    this.db.prepare("insert into users (id, username, password_hash, is_admin, created_at) values (?, ?, ?, ?, ?)").run(row.id, username, hashSecret(password), row.is_admin, row.created_at);
    return row;
  }

  userCount(): number {
    return (this.db.prepare("select count(*) as n from users").get() as { n: number }).n;
  }

  findUserByName(username: string): UserRow | undefined {
    return this.db.prepare("select id, username, is_admin, created_at from users where username = ?").get(username) as UserRow | undefined;
  }

  getUser(id: string): UserRow | undefined {
    return this.db.prepare("select id, username, is_admin, created_at from users where id = ?").get(id) as UserRow | undefined;
  }

  /** Returns the user if the password matches. Constant-ish time for unknown users. */
  checkLogin(username: string, password: string): UserRow | null {
    const row = this.db.prepare("select id, username, is_admin, created_at, password_hash from users where username = ?").get(username) as (UserRow & { password_hash: string }) | undefined;
    const ok = verifySecret(password, row?.password_hash ?? DUMMY_HASH);
    if (!row || !ok) return null;
    const { password_hash: _h, ...user } = row;
    return user;
  }

  setAdmin(userId: string, admin: boolean) {
    this.db.prepare("update users set is_admin = ? where id = ?").run(admin ? 1 : 0, userId);
  }

  createAuthSession(userId: string): string {
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.db.prepare("insert into auth_sessions (token_hash, user_id, created_at, expires_at) values (?, ?, ?, ?)").run(sha256(token), userId, now, now + SESSION_TTL_MS);
    return token;
  }

  userForSession(token: string): UserRow | undefined {
    const row = this.db
      .prepare("select u.id, u.username, u.is_admin, u.created_at, s.expires_at from auth_sessions s join users u on u.id = s.user_id where s.token_hash = ?")
      .get(sha256(token)) as (UserRow & { expires_at: number }) | undefined;
    if (!row || row.expires_at < Date.now()) return undefined;
    const { expires_at: _e, ...user } = row;
    return user;
  }

  deleteAuthSession(token: string) {
    this.db.prepare("delete from auth_sessions where token_hash = ?").run(sha256(token));
  }

  purgeExpired() {
    this.db.prepare("delete from auth_sessions where expires_at < ?").run(Date.now());
  }

  // ---------- rooms ----------

  createRoom(r: Omit<RoomRow, "closed_at" | "password_hash"> & { password?: string }): RoomRow {
    const row: RoomRow = { ...r, password_hash: r.password ? hashSecret(r.password) : null, closed_at: null };
    this.db
      .prepare("insert into rooms (id, name, git_url, base_ref, password_hash, max_people, default_role, created_by, created_at, closed_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, null)")
      .run(row.id, row.name, row.git_url, row.base_ref, row.password_hash, row.max_people, row.default_role, row.created_by, row.created_at);
    return row;
  }

  openRooms(): RoomRow[] {
    return this.db.prepare("select * from rooms where closed_at is null order by created_at desc").all() as unknown as RoomRow[];
  }

  closeRoom(id: string) {
    this.db.prepare("update rooms set closed_at = ? where id = ?").run(Date.now(), id);
  }

  member(roomId: string, userId: string): { role: Role; banned: number } | undefined {
    return this.db.prepare("select role, banned from room_members where room_id = ? and user_id = ?").get(roomId, userId) as { role: Role; banned: number } | undefined;
  }

  upsertMember(roomId: string, userId: string, role: Role) {
    this.db
      .prepare("insert into room_members (room_id, user_id, role, banned, joined_at) values (?, ?, ?, 0, ?) on conflict(room_id, user_id) do update set role = excluded.role")
      .run(roomId, userId, role, Date.now());
  }

  banMember(roomId: string, userId: string) {
    this.db
      .prepare("insert into room_members (room_id, user_id, role, banned, joined_at) values (?, ?, 'viewer', 1, ?) on conflict(room_id, user_id) do update set banned = 1")
      .run(roomId, userId, Date.now());
  }

  // ---------- chat ----------

  addChat(roomId: string, m: ChatMessage) {
    this.db.prepare("insert into chat_messages (id, room_id, at, kind, by_id, by_name, text) values (?, ?, ?, ?, ?, ?, ?)").run(m.id, roomId, m.at, m.kind, m.byId, m.byName, m.text);
  }

  recentChat(roomId: string, limit: number): ChatMessage[] {
    const rows = this.db.prepare("select id, at, kind, by_id, by_name, text from chat_messages where room_id = ? order by at desc limit ?").all(roomId, limit) as {
      id: string;
      at: number;
      kind: "user" | "system";
      by_id: string | null;
      by_name: string;
      text: string;
    }[];
    return rows.reverse().map((r) => ({ id: r.id, at: r.at, kind: r.kind, byId: r.by_id, byName: r.by_name, text: r.text }));
  }

  // ---------- runner tokens ----------

  createRunnerToken(userId: string | null, name: string): { token: string; row: RunnerTokenRow } {
    const token = `sbr_${randomBytes(32).toString("base64url")}`;
    const row: RunnerTokenRow = { id: randomUUID(), user_id: userId, name, created_at: Date.now(), last_seen: null };
    this.db.prepare("insert into runner_tokens (id, token_hash, user_id, name, created_at, last_seen) values (?, ?, ?, ?, ?, null)").run(row.id, sha256(token), userId, name, row.created_at);
    return { token, row };
  }

  runnerForToken(token: string): RunnerTokenRow | undefined {
    return this.db.prepare("select id, user_id, name, created_at, last_seen from runner_tokens where token_hash = ?").get(sha256(token)) as RunnerTokenRow | undefined;
  }

  getRunnerToken(id: string): RunnerTokenRow | undefined {
    return this.db.prepare("select id, user_id, name, created_at, last_seen from runner_tokens where id = ?").get(id) as RunnerTokenRow | undefined;
  }

  runnerTokens(userId: string): RunnerTokenRow[] {
    return this.db.prepare("select id, user_id, name, created_at, last_seen from runner_tokens where user_id = ? order by created_at desc").all(userId) as unknown as RunnerTokenRow[];
  }

  touchRunner(id: string) {
    this.db.prepare("update runner_tokens set last_seen = ? where id = ?").run(Date.now(), id);
  }

  deleteRunnerToken(userId: string, id: string): boolean {
    return Number(this.db.prepare("delete from runner_tokens where id = ? and user_id = ?").run(id, userId).changes) > 0;
  }
}
