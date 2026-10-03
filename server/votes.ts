/**
 * Vote engine: a transport-independent state machine for team decisions.
 *
 *   open ──deadline/all-voted──▶ resolved (strict majority)
 *     │                       └▶ awaiting_owner (tie or no votes, owner online)
 *     │                               ├─ owner picks ─▶ resolved (owner_tiebreak / owner_no_votes)
 *     │                               └─ window expires ─▶ resolved (fallback_owner_timeout, no option)
 *     ├─ tie/no votes, owner offline ─▶ resolved (fallback_owner_absent, no option)
 *     └─ session cancelled / agent aborted ─▶ cancelled
 *
 * Owner-audience decisions (routine permission requests) skip the team: only the session
 * owner may vote, the first owner ballot resolves it (owner_decision), and no answer by
 * the deadline, or an offline owner at open, falls back (deny).
 *
 * Every decision settles exactly once; the promise returned by open() resolves with it.
 * A fallback carries no option: callers must treat it as "no decision" (questions) or
 * "deny" (permissions). It never approves anything.
 */
import { randomUUID } from "node:crypto";
import type { VoteAudience, VoteOption, VoteResolutionReason, VoteView } from "../shared/protocol.ts";

export type VoteKind = "question" | "permission";

export interface VoteRequest {
  sessionId: string;
  ownerId: string;
  kind: VoteKind;
  /** Defaults to "team". */
  audience?: VoteAudience;
  header: string;
  question: string;
  detail?: string | null;
  options: { label: string; description?: string }[];
}

export type VoteOutcome =
  | { status: "resolved"; voteId: string; optionId: string; label: string; reason: VoteResolutionReason }
  | { status: "fallback"; voteId: string; reason: "fallback_owner_absent" | "fallback_owner_timeout" }
  | { status: "cancelled"; voteId: string; reason: "session_cancelled" };

export class VoteError extends Error {
  constructor(
    public code: "not_found" | "closed" | "duplicate" | "invalid_option" | "forbidden" | "wrong_phase" | "malformed",
    message: string,
  ) {
    super(message);
  }
}

export interface VoteClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: VoteClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export interface VoteEngineDeps {
  clock?: VoteClock;
  voteMs?: number;
  ownerWindowMs?: number;
  /** Resolve before the deadline once every online participant has voted. */
  earlyClose?: boolean;
  isOnline: (participantId: string) => boolean;
  onlineParticipants: () => string[];
  emit: (view: VoteView) => void;
}

interface VoteRecord {
  view: VoteView;
  ownerId: string;
  ballots: Map<string, string>; // participantId -> optionId (never broadcast)
  timer: unknown;
  settle: (o: VoteOutcome) => void;
}

const MAX_OPTIONS = 6;

export function normalizeOptions(raw: unknown): VoteOption[] {
  if (!Array.isArray(raw)) throw new VoteError("malformed", "options must be an array");
  if (raw.length < 2 || raw.length > MAX_OPTIONS)
    throw new VoteError("malformed", `a decision needs 2-${MAX_OPTIONS} options, got ${raw.length}`);
  const seen = new Set<string>();
  return raw.map((o, i) => {
    const label = typeof o?.label === "string" ? o.label.trim().slice(0, 80) : "";
    if (!label) throw new VoteError("malformed", `option ${i + 1} has no label`);
    const key = label.toLowerCase();
    if (seen.has(key)) throw new VoteError("malformed", `duplicate option "${label}"`);
    seen.add(key);
    const description = typeof o?.description === "string" ? o.description.trim().slice(0, 300) : "";
    return { id: `o${i + 1}`, label, description };
  });
}

export class VoteEngine {
  private votes = new Map<string, VoteRecord>();
  private clock: VoteClock;
  private voteMs: number;
  private ownerWindowMs: number;
  private earlyClose: boolean;

  constructor(private deps: VoteEngineDeps) {
    this.clock = deps.clock ?? realClock;
    this.voteMs = deps.voteMs ?? 30_000;
    this.ownerWindowMs = deps.ownerWindowMs ?? 30_000;
    this.earlyClose = deps.earlyClose ?? true;
  }

  /** Opens a decision. Throws VoteError("malformed") if the request cannot be voted on. */
  open(req: VoteRequest): { voteId: string; result: Promise<VoteOutcome> } {
    const question = req.question.trim().slice(0, 500);
    if (!question) throw new VoteError("malformed", "question text is empty");
    const options = normalizeOptions(req.options);
    const now = this.clock.now();
    const voteId = randomUUID();
    const view: VoteView = {
      id: voteId,
      sessionId: req.sessionId,
      kind: req.kind,
      audience: req.audience ?? "team",
      ownerId: req.ownerId,
      header: req.header.trim().slice(0, 40) || (req.kind === "permission" ? "Permission" : "Decision"),
      question,
      detail: req.detail?.slice(0, 2000) ?? null,
      options,
      counts: Object.fromEntries(options.map((o) => [o.id, 0])),
      voterCount: 0,
      phase: "open",
      openedAt: now,
      deadline: now + this.voteMs,
      ownerDeadline: null,
      resolvedOptionId: null,
      resolution: null,
      resolvedAt: null,
    };
    let settle!: (o: VoteOutcome) => void;
    const result = new Promise<VoteOutcome>((r) => (settle = r));
    const rec: VoteRecord = { view, ownerId: req.ownerId, ballots: new Map(), timer: null, settle };
    this.votes.set(voteId, rec);
    rec.timer = this.clock.setTimeout(() => this.closeVoting(voteId), this.voteMs);
    this.deps.emit(view);
    if (view.audience === "owner" && !this.deps.isOnline(req.ownerId))
      this.finish(rec, { status: "fallback", voteId, reason: "fallback_owner_absent" }, null, "fallback_owner_absent");
    return { voteId, result };
  }

  cast(voteId: string, participantId: string, optionId: string): void {
    const rec = this.require(voteId);
    if (rec.view.phase !== "open") throw new VoteError("closed", "voting has closed for this decision");
    if (rec.view.audience === "owner" && participantId !== rec.ownerId)
      throw new VoteError("forbidden", "only the session owner decides this request");
    const opt = rec.view.options.find((o) => o.id === optionId);
    if (!opt) throw new VoteError("invalid_option", "unknown option");
    if (rec.ballots.has(participantId)) throw new VoteError("duplicate", "you already voted on this decision");
    rec.ballots.set(participantId, optionId);
    if (rec.view.audience === "owner") {
      this.update(rec, { counts: { ...rec.view.counts, [optionId]: 1 }, voterCount: 1 });
      this.finish(rec, { status: "resolved", voteId, optionId, label: opt.label, reason: "owner_decision" }, optionId, "owner_decision");
      return;
    }
    this.update(rec, {
      counts: { ...rec.view.counts, [optionId]: (rec.view.counts[optionId] ?? 0) + 1 },
      voterCount: rec.ballots.size,
    });
    this.maybeCloseEarly(voteId);
  }

  /** Owner decision after a tie or no votes. */
  ownerResolve(voteId: string, participantId: string, optionId: string): void {
    const rec = this.require(voteId);
    if (rec.ownerId !== participantId) throw new VoteError("forbidden", "only the session owner can break a tie");
    if (rec.view.phase !== "awaiting_owner") throw new VoteError("wrong_phase", "this decision is not waiting for the owner");
    const opt = rec.view.options.find((o) => o.id === optionId);
    if (!opt) throw new VoteError("invalid_option", "unknown option");
    const reason: VoteResolutionReason = rec.ballots.size === 0 ? "owner_no_votes" : "owner_tiebreak";
    this.finish(rec, { status: "resolved", voteId, optionId, label: opt.label, reason }, optionId, reason);
  }

  cancel(voteId: string): void {
    const rec = this.votes.get(voteId);
    if (!rec || !this.isActive(rec)) return;
    this.finish(rec, { status: "cancelled", voteId, reason: "session_cancelled" }, null, "session_cancelled", "cancelled");
  }

  cancelSession(sessionId: string): void {
    for (const rec of this.votes.values()) if (rec.view.sessionId === sessionId) this.cancel(rec.view.id);
  }

  /** Call when presence changes: may allow early close. */
  participantsChanged(): void {
    for (const rec of this.votes.values()) if (rec.view.phase === "open") this.maybeCloseEarly(rec.view.id);
  }

  myVotes(participantId: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const rec of this.votes.values()) {
      const v = rec.ballots.get(participantId);
      if (v) out[rec.view.id] = v;
    }
    return out;
  }

  get(voteId: string): VoteView | undefined {
    return this.votes.get(voteId)?.view;
  }

  ballotsCast(): Map<string, number> {
    const out = new Map<string, number>();
    for (const rec of this.votes.values()) for (const p of rec.ballots.keys()) out.set(p, (out.get(p) ?? 0) + 1);
    return out;
  }

  dispose(): void {
    for (const rec of this.votes.values()) if (this.isActive(rec)) this.cancel(rec.view.id);
  }

  // ---- internals ----

  private require(voteId: string): VoteRecord {
    const rec = this.votes.get(voteId);
    if (!rec) throw new VoteError("not_found", "no such decision");
    return rec;
  }

  private isActive(rec: VoteRecord) {
    return rec.view.phase === "open" || rec.view.phase === "awaiting_owner";
  }

  private maybeCloseEarly(voteId: string) {
    if (!this.earlyClose) return;
    const rec = this.votes.get(voteId);
    if (!rec || rec.view.phase !== "open" || rec.ballots.size === 0 || rec.view.audience === "owner") return;
    const online = this.deps.onlineParticipants();
    if (online.length > 0 && online.every((p) => rec.ballots.has(p))) this.closeVoting(voteId);
  }

  private closeVoting(voteId: string) {
    const rec = this.votes.get(voteId);
    if (!rec || rec.view.phase !== "open") return;
    this.clock.clearTimeout(rec.timer);
    if (rec.view.audience === "owner") {
      this.finish(rec, { status: "fallback", voteId, reason: "fallback_owner_timeout" }, null, "fallback_owner_timeout");
      return;
    }
    const counts = rec.view.options.map((o) => ({ o, n: rec.view.counts[o.id] ?? 0 }));
    const max = Math.max(...counts.map((c) => c.n));
    const leaders = counts.filter((c) => c.n === max);
    if (max > 0 && leaders.length === 1) {
      const win = leaders[0]!.o;
      this.finish(rec, { status: "resolved", voteId, optionId: win.id, label: win.label, reason: "majority" }, win.id, "majority");
      return;
    }
    if (!this.deps.isOnline(rec.ownerId)) {
      this.finish(rec, { status: "fallback", voteId, reason: "fallback_owner_absent" }, null, "fallback_owner_absent");
      return;
    }
    const ownerDeadline = this.clock.now() + this.ownerWindowMs;
    this.update(rec, { phase: "awaiting_owner", ownerDeadline });
    rec.timer = this.clock.setTimeout(() => {
      if (rec.view.phase !== "awaiting_owner") return;
      this.finish(rec, { status: "fallback", voteId, reason: "fallback_owner_timeout" }, null, "fallback_owner_timeout");
    }, this.ownerWindowMs);
  }

  private finish(
    rec: VoteRecord,
    outcome: VoteOutcome,
    optionId: string | null,
    reason: VoteResolutionReason,
    phase: "resolved" | "cancelled" = "resolved",
  ) {
    if (!this.isActive(rec)) return; // exactly once
    this.clock.clearTimeout(rec.timer);
    this.update(rec, { phase, resolvedOptionId: optionId, resolution: reason, resolvedAt: this.clock.now() });
    rec.settle(outcome);
  }

  private update(rec: VoteRecord, patch: Partial<VoteView>) {
    rec.view = { ...rec.view, ...patch };
    this.deps.emit(rec.view);
  }
}
