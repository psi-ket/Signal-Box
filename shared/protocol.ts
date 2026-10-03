/**
 * Shared WebSocket protocol. Both server and client validate every message with these
 * schemas. Room events are applied to room state by the shared reducer (reducer.ts),
 * so the server's snapshot and every client's view come from one event model.
 *
 * Connection flow: log in over HTTP (session cookie) → open /ws (the cookie authenticates
 *   it) → `lobby` (room list) → `room.create` or `room.join` → `welcome` (room snapshot)
 *   → room messages → `room.leave` → back to the lobby.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 3;
export const WS_SUBPROTOCOL = "colab.v3";
export const TOKEN_PROTOCOL_PREFIX = "token.";
export const MAX_MESSAGE_BYTES = 64 * 1024;
export const MAX_CHAT_MESSAGES = 200;

// ---------- shared value types ----------

export const ProviderId = z.enum(["claude", "codex", "gemini-cli", "gemini-api", "openai-api", "mock"]);
export type ProviderId = z.infer<typeof ProviderId>;

/** Vendors whose API keys participants can bring themselves. */
export const KeyVendor = z.enum(["anthropic", "openai", "gemini"]);
export type KeyVendor = z.infer<typeof KeyVendor>;

export const Role = z.enum(["admin", "editor", "voter", "viewer"]);
export type Role = z.infer<typeof Role>;
const ROLE_RANK: Record<Role, number> = { viewer: 0, voter: 1, editor: 2, admin: 3 };
export const roleAtLeast = (role: Role, min: Role) => ROLE_RANK[role] >= ROLE_RANK[min];

export const SessionStatus = z.enum([
  "starting", // worktree being created / agent booting
  "running", // agent is working on a turn
  "waiting_vote", // agent paused on a decision
  "idle", // turn finished, waiting for an owner prompt
  "completed", // ended normally by owner/admin
  "failed", // agent or setup error
  "cancelled", // cancelled by owner/admin
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const Participant = z.object({
  id: z.string(),
  name: z.string(),
  role: Role,
  isHost: z.boolean(),
  online: z.boolean(),
  viewingSessionId: z.string().nullable(),
  joinedAt: z.number(),
});
export type Participant = z.infer<typeof Participant>;

export const ModelOption = z.object({ id: z.string(), label: z.string() });
export const ProviderInfo = z.object({
  id: ProviderId,
  label: z.string(),
  available: z.boolean(),
  note: z.string().nullable(),
  auth: z.string(),
  models: z.array(ModelOption),
  defaultModel: z.string().nullable(),
  /** Vendor whose personal API key can run this agent, if any. */
  byoVendor: KeyVendor.nullable(),
  /** True when this agent can run on a participant's own key (e.g. the CLI is installed). */
  byoReady: z.boolean(),
});
export type ProviderInfo = z.infer<typeof ProviderInfo>;

/** A runner as shown in a room: a teammate's machine (or the shared host runner). */
export const RunnerView = z.object({
  id: z.string(),
  name: z.string(),
  ownerId: z.string().nullable(), // null for the shared host runner
  ownerName: z.string().nullable(),
  shared: z.boolean(),
  platform: z.string(),
  providers: z.array(ProviderInfo),
});
export type RunnerView = z.infer<typeof RunnerView>;

export const TranscriptItem = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), id: z.string(), at: z.number(), text: z.string(), streaming: z.boolean() }),
  z.object({ kind: z.literal("prompt"), id: z.string(), at: z.number(), text: z.string(), by: z.string() }),
  z.object({
    kind: z.literal("tool_call"),
    id: z.string(),
    at: z.number(),
    tool: z.string(),
    summary: z.string(),
    status: z.enum(["pending", "ok", "error", "denied"]),
    result: z.string().optional(),
  }),
  z.object({ kind: z.literal("file"), id: z.string(), at: z.number(), path: z.string(), action: z.enum(["edit", "write", "delete"]) }),
  z.object({ kind: z.literal("decision"), id: z.string(), at: z.number(), voteId: z.string(), text: z.string() }),
  z.object({ kind: z.literal("error"), id: z.string(), at: z.number(), message: z.string() }),
  z.object({ kind: z.literal("system"), id: z.string(), at: z.number(), text: z.string() }),
]);
export type TranscriptItem = z.infer<typeof TranscriptItem>;

export const SessionView = z.object({
  id: z.string(),
  title: z.string(),
  task: z.string(),
  ownerId: z.string(),
  ownerName: z.string(),
  provider: ProviderId,
  model: z.string().nullable(),
  runnerName: z.string(),
  /** host: the host's login or key pays; own: the owner's personal API key pays. */
  billing: z.enum(["host", "own"]),
  branch: z.string(),
  status: SessionStatus,
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  error: z.string().nullable(),
  turns: z.number(),
  costUsd: z.number().nullable(),
  filesTouched: z.array(z.string()),
  transcript: z.array(TranscriptItem),
});
export type SessionView = z.infer<typeof SessionView>;

export const VoteKind = z.enum(["question", "permission"]);
/** team: every voter+ participant votes. owner: only the session owner decides. */
export const VoteAudience = z.enum(["team", "owner"]);
export type VoteAudience = z.infer<typeof VoteAudience>;
export const VotePhase = z.enum(["open", "awaiting_owner", "resolved", "cancelled"]);
export const VoteResolutionReason = z.enum([
  "majority",
  "owner_decision",
  "owner_tiebreak",
  "owner_no_votes",
  "fallback_owner_absent",
  "fallback_owner_timeout",
  "policy_denied",
  "session_cancelled",
]);
export type VoteResolutionReason = z.infer<typeof VoteResolutionReason>;

export const VoteOption = z.object({ id: z.string(), label: z.string(), description: z.string() });
export type VoteOption = z.infer<typeof VoteOption>;

export const VoteView = z.object({
  id: z.string(),
  sessionId: z.string(),
  kind: VoteKind,
  audience: VoteAudience,
  ownerId: z.string(),
  header: z.string(),
  question: z.string(),
  detail: z.string().nullable(),
  options: z.array(VoteOption),
  counts: z.record(z.string(), z.number()),
  voterCount: z.number(),
  phase: VotePhase,
  openedAt: z.number(),
  deadline: z.number(),
  ownerDeadline: z.number().nullable(),
  resolvedOptionId: z.string().nullable(),
  resolution: VoteResolutionReason.nullable(),
  resolvedAt: z.number().nullable(),
});
export type VoteView = z.infer<typeof VoteView>;

export const DriftLevel = z.enum(["clear", "overlap", "conflict", "unknown"]);
export type DriftLevel = z.infer<typeof DriftLevel>;

export const DriftReport = z.object({
  scannedAt: z.number(),
  durationMs: z.number(),
  baseRef: z.string(),
  baseSha: z.string(),
  conflictCheck: z.enum(["enabled", "disabled"]),
  /** Why conflict checking is limited, if it is (e.g. the hub can't read a private repo). */
  note: z.string().nullable(),
  sessions: z.record(
    z.string(),
    z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      level: DriftLevel,
      files: z.array(z.object({ path: z.string(), status: z.string() })),
    }),
  ),
  overlaps: z.array(z.object({ path: z.string(), sessionIds: z.array(z.string()) })),
  conflicts: z.array(z.object({ sessionIds: z.tuple([z.string(), z.string()]), paths: z.array(z.string()) })),
});
export type DriftReport = z.infer<typeof DriftReport>;

export const Recap = z.object({
  generatedAt: z.number(),
  sessions: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      ownerName: z.string(),
      provider: ProviderId,
      model: z.string().nullable(),
      status: SessionStatus,
      durationMs: z.number(),
      filesChanged: z.array(z.string()),
      commitsCreated: z.number(),
      testRuns: z.object({ passed: z.number(), failed: z.number() }),
      decisions: z.number(),
      errors: z.array(z.string()),
    }),
  ),
  decisions: z.object({ raised: z.number(), resolved: z.number(), byReason: z.record(z.string(), z.number()) }),
  participation: z.array(z.object({ name: z.string(), votesCast: z.number() })),
  unresolvedConflicts: z.array(z.object({ sessionIds: z.tuple([z.string(), z.string()]), paths: z.array(z.string()) })),
  driftVerifiedAt: z.number().nullable(),
});
export type Recap = z.infer<typeof Recap>;

export const ChatMessage = z.object({
  id: z.string(),
  at: z.number(),
  kind: z.enum(["user", "system"]),
  byId: z.string().nullable(),
  byName: z.string(),
  text: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const RoomSettings = z.object({
  maxPeople: z.number().int().min(1).max(64),
  defaultRole: Role,
  hasPassword: z.boolean(),
});
export type RoomSettings = z.infer<typeof RoomSettings>;

export const RoomState = z.object({
  roomId: z.string(),
  name: z.string(),
  seq: z.number(),
  repoName: z.string(),
  gitUrl: z.string(),
  baseRef: z.string(),
  createdAt: z.number(),
  createdBy: z.string(),
  settings: RoomSettings,
  /** Online runners usable in this room, keyed by runner id. */
  runners: z.record(z.string(), RunnerView),
  participants: z.record(z.string(), Participant),
  sessions: z.record(z.string(), SessionView),
  sessionOrder: z.array(z.string()),
  votes: z.record(z.string(), VoteView),
  chat: z.array(ChatMessage),
  drift: DriftReport.nullable(),
  recap: Recap.nullable(),
  ended: z.boolean(),
});
export type RoomState = z.infer<typeof RoomState>;

export const RoomSummary = z.object({
  id: z.string(),
  name: z.string(),
  repoName: z.string(),
  createdBy: z.string(),
  createdAt: z.number(),
  hasPassword: z.boolean(),
  maxPeople: z.number(),
  online: z.number(),
  activeSessions: z.number(),
  openVotes: z.number(),
  ended: z.boolean(),
});
export type RoomSummary = z.infer<typeof RoomSummary>;

// ---------- envelope ----------

const envelope = <T extends string, P extends z.ZodTypeAny>(type: T, payload: P) =>
  z.object({
    type: z.literal(type),
    eventId: z.string().min(1).max(64),
    timestamp: z.number(),
    roomId: z.string().max(64).optional(),
    sessionId: z.string().max(64).optional(),
    payload,
  });

const shortText = (max: number) => z.string().trim().min(1).max(max);
const id = z.string().min(1).max(64);
export const ModelId = z.string().regex(/^[\w.:/-]{1,80}$/, "invalid model id");

// ---------- client -> server ----------

export const ClientMessage = z.discriminatedUnion("type", [
  // lobby
  envelope(
    "room.create",
    z.object({
      name: shortText(48),
      gitUrl: shortText(400),
      baseRef: z.string().trim().max(100).optional(),
      password: z.string().max(128).optional(),
      maxPeople: z.number().int().min(1).max(64),
      defaultRole: Role,
    }),
  ),
  envelope("room.join", z.object({ roomId: id, password: z.string().max(128).optional() })),
  envelope("room.leave", z.object({})),
  // room
  envelope("presence", z.object({ viewingSessionId: id.nullable() })),
  envelope("chat.send", z.object({ text: shortText(1000) })),
  envelope("session.create", z.object({ title: shortText(60), task: shortText(4000), provider: ProviderId, model: ModelId.optional(), ownKey: z.boolean().optional() })),
  envelope("key.set", z.object({ vendor: KeyVendor, apiKey: z.string().trim().min(10).max(300) })),
  envelope("key.clear", z.object({ vendor: KeyVendor })),
  envelope("session.prompt", z.object({ sessionId: id, text: shortText(4000) })),
  envelope("session.cancel", z.object({ sessionId: id })),
  envelope("session.end", z.object({ sessionId: id })),
  envelope("vote.cast", z.object({ voteId: id, optionId: id })),
  envelope("vote.resolve", z.object({ voteId: id, optionId: id })),
  envelope("member.role", z.object({ participantId: id, role: Role })),
  envelope("member.kick", z.object({ participantId: id })),
  envelope("snapshot.request", z.object({})),
  envelope("room.end", z.object({})),
  envelope("room.close", z.object({})),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;
export type ClientMessageType = ClientMessage["type"];
export type ClientPayload<T extends ClientMessageType> = Extract<ClientMessage, { type: T }>["payload"];

// ---------- server -> client ----------

/** Events that mutate room state. Applied by the shared reducer on server and client. */
export const StateEvent = z.discriminatedUnion("type", [
  envelope("participant.upsert", Participant),
  envelope("participant.remove", z.object({ participantId: z.string() })),
  envelope("session.upsert", SessionView.omit({ transcript: true })),
  envelope("transcript.append", z.object({ sessionId: id, item: TranscriptItem })),
  envelope("transcript.delta", z.object({ sessionId: id, itemId: id, text: z.string() })),
  envelope("transcript.update", z.object({ sessionId: id, item: TranscriptItem })),
  envelope("vote.upsert", VoteView),
  envelope("chat.message", ChatMessage),
  envelope("runners.update", z.object({ runners: z.record(z.string(), RunnerView) })),
  envelope("drift.report", DriftReport),
  envelope("recap", Recap),
  envelope("room.ended", z.object({})),
]);
export type StateEvent = z.infer<typeof StateEvent> & { seq: number };

/** Events addressed to one connection; they do not change shared room state. */
export const DirectEvent = z.discriminatedUnion("type", [
  envelope(
    "lobby",
    z.object({
      user: z.object({ id: z.string(), username: z.string(), isAdmin: z.boolean() }),
      rooms: z.array(RoomSummary),
      runners: z.array(RunnerView),
      allowLocalRepos: z.boolean(),
      protocolVersion: z.number(),
    }),
  ),
  /** The current user's own runners (and the shared runner), whenever they change. */
  envelope("runners", z.object({ runners: z.array(RunnerView) })),
  envelope("lobby.rooms", z.object({ rooms: z.array(RoomSummary) })),
  envelope(
    "keys",
    z.object({
      keys: z.array(z.object({ vendor: KeyVendor, masked: z.string(), models: z.array(ModelOption), checkedAt: z.number() })),
      /** Result of the last key.set, for showing errors next to the field. */
      last: z.object({ vendor: KeyVendor, ok: z.boolean(), error: z.string().nullable() }).nullable(),
    }),
  ),
  envelope("welcome", z.object({ roomId: z.string(), role: Role, myVotes: z.record(z.string(), z.string()), state: RoomState })),
  envelope("snapshot", z.object({ state: RoomState, myVotes: z.record(z.string(), z.string()) })),
  envelope("room.left", z.object({ roomId: z.string(), reason: z.enum(["left", "kicked", "closed"]) })),
  envelope("vote.ack", z.object({ voteId: z.string(), optionId: z.string() })),
  envelope("error", z.object({ code: z.string(), message: z.string(), replyTo: z.string().optional() })),
]);
export type DirectEvent = z.infer<typeof DirectEvent>;

export const ServerMessage = z.union([StateEvent.and(z.object({ seq: z.number() })), DirectEvent]);
export type ServerMessage = StateEvent | DirectEvent;

export const STATE_EVENT_TYPES = new Set<string>(StateEvent.options.map((o) => o.shape.type.value));
export function isStateEvent(m: ServerMessage): m is StateEvent {
  return STATE_EVENT_TYPES.has(m.type);
}

export const ErrorCode = {
  BadMessage: "bad_message",
  NotJoined: "not_joined",
  NotInRoom: "not_in_room",
  Forbidden: "forbidden",
  NotFound: "not_found",
  BadPassword: "bad_password",
  RoomFull: "room_full",
  RateLimited: "rate_limited",
  Conflict: "conflict",
  Limit: "limit",
  Invalid: "invalid",
  Internal: "internal",
} as const;
