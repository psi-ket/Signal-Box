import { describe, it, expect, beforeEach } from "vitest";
import { VoteEngine, VoteError, type VoteOutcome, type VoteRequest } from "../server/votes.ts";
import type { VoteView } from "../shared/protocol.ts";
import { FakeClock } from "./fakeClock.ts";

const req = (over: Partial<VoteRequest> = {}): VoteRequest => ({
  sessionId: "s1",
  ownerId: "owner",
  kind: "question",
  header: "DB",
  question: "Which database?",
  options: [{ label: "PostgreSQL" }, { label: "SQLite" }],
  ...over,
});

/** Returns the outcome if the promise already settled, else undefined. */
async function peek(p: Promise<VoteOutcome>): Promise<VoteOutcome | undefined> {
  let v: VoteOutcome | undefined;
  void p.then((x) => (v = x));
  await new Promise((r) => setImmediate(r));
  return v;
}

describe("vote engine", () => {
  let clock: FakeClock;
  let online: Set<string>;
  let emitted: VoteView[];
  let engine: VoteEngine;

  beforeEach(() => {
    clock = new FakeClock();
    online = new Set(["owner", "p1", "p2", "p3"]);
    emitted = [];
    engine = new VoteEngine({
      clock,
      voteMs: 30_000,
      ownerWindowMs: 20_000,
      earlyClose: true,
      isOnline: (p) => online.has(p),
      onlineParticipants: () => [...online],
      emit: (v) => emitted.push(v),
    });
  });

  it("strict majority wins at the deadline", async () => {
    const { voteId, result } = engine.open(req());
    engine.cast(voteId, "p1", "o2");
    engine.cast(voteId, "p2", "o2");
    engine.cast(voteId, "p3", "o1");
    expect(await peek(result)).toBeUndefined();
    clock.advance(30_000);
    expect(await result).toEqual({ status: "resolved", voteId, optionId: "o2", label: "SQLite", reason: "majority" });
    expect(engine.get(voteId)!.phase).toBe("resolved");
  });

  it("closes early once every online participant voted", async () => {
    const { voteId, result } = engine.open(req());
    for (const p of ["owner", "p1", "p2"]) engine.cast(voteId, p, "o1");
    expect(await peek(result)).toBeUndefined();
    engine.cast(voteId, "p3", "o2");
    expect((await result).status).toBe("resolved");
  });

  it("a tie goes to the owner, who picks", async () => {
    const { voteId, result } = engine.open(req());
    engine.cast(voteId, "p1", "o1");
    engine.cast(voteId, "p2", "o2");
    clock.advance(30_000);
    expect(engine.get(voteId)!.phase).toBe("awaiting_owner");
    expect(() => engine.ownerResolve(voteId, "p1", "o1")).toThrow(VoteError);
    engine.ownerResolve(voteId, "owner", "o1");
    expect(await result).toMatchObject({ status: "resolved", optionId: "o1", reason: "owner_tiebreak" });
  });

  it("no votes goes to the owner", async () => {
    const { voteId, result } = engine.open(req());
    clock.advance(30_000);
    engine.ownerResolve(voteId, "owner", "o2");
    expect(await result).toMatchObject({ optionId: "o2", reason: "owner_no_votes" });
  });

  it("owner absent at a tie -> safe fallback with no option", async () => {
    online.delete("owner");
    const { voteId, result } = engine.open(req());
    clock.advance(30_000);
    expect(await result).toEqual({ status: "fallback", voteId, reason: "fallback_owner_absent" });
    expect(engine.get(voteId)!.resolvedOptionId).toBeNull();
  });

  it("owner who does not decide within the window -> fallback", async () => {
    const { result } = engine.open(req());
    clock.advance(30_000);
    clock.advance(19_999);
    expect(await peek(result)).toBeUndefined();
    clock.advance(1);
    expect(await result).toMatchObject({ status: "fallback", reason: "fallback_owner_timeout" });
  });

  it("owner disconnecting mid-window keeps the window open (reconnect grace), then falls back", async () => {
    const { voteId, result } = engine.open(req());
    clock.advance(30_000);
    online.delete("owner");
    engine.participantsChanged();
    expect(engine.get(voteId)!.phase).toBe("awaiting_owner");
    clock.advance(20_000);
    expect((await result).status).toBe("fallback");
  });

  it("rejects duplicate, invalid and late votes and resolves exactly once", async () => {
    const { voteId, result } = engine.open(req());
    engine.cast(voteId, "p1", "o1");
    expect(() => engine.cast(voteId, "p1", "o2")).toThrow(expect.objectContaining({ code: "duplicate" }));
    expect(() => engine.cast(voteId, "p2", "nope")).toThrow(expect.objectContaining({ code: "invalid_option" }));
    expect(() => engine.cast("missing", "p2", "o1")).toThrow(expect.objectContaining({ code: "not_found" }));
    clock.advance(30_000);
    await result;
    expect(() => engine.cast(voteId, "p2", "o1")).toThrow(expect.objectContaining({ code: "closed" }));
    expect(() => engine.ownerResolve(voteId, "owner", "o2")).toThrow(expect.objectContaining({ code: "wrong_phase" }));
    engine.cancel(voteId);
    expect(engine.get(voteId)!.phase).toBe("resolved");
    expect(emitted.filter((v) => v.id === voteId && v.phase === "resolved")).toHaveLength(1);
    expect(engine.get(voteId)!.counts).toEqual({ o1: 1, o2: 0 });
  });

  it("rejects malformed options", () => {
    expect(() => engine.open(req({ options: [{ label: "only" }] }))).toThrow(expect.objectContaining({ code: "malformed" }));
    expect(() => engine.open(req({ options: [{ label: "A" }, { label: "a " }] }))).toThrow(/duplicate/);
    expect(() => engine.open(req({ options: [{ label: "A" }, { label: "  " }] }))).toThrow(/no label/);
    expect(() => engine.open(req({ options: "x" as never }))).toThrow(VoteError);
    expect(() => engine.open(req({ question: "  " }))).toThrow(/empty/);
  });

  it("keeps concurrent decisions independent", async () => {
    const a = engine.open(req());
    const b = engine.open(req({ sessionId: "s2", question: "Which ORM?" }));
    engine.cast(a.voteId, "p1", "o1");
    engine.cast(b.voteId, "p1", "o2");
    clock.advance(30_000);
    expect(await a.result).toMatchObject({ optionId: "o1" });
    expect(await b.result).toMatchObject({ optionId: "o2" });
    expect(engine.myVotes("p1")).toEqual({ [a.voteId]: "o1", [b.voteId]: "o2" });
  });

  it("cancelling a session cancels only its own pending decisions", async () => {
    const a = engine.open(req());
    const b = engine.open(req({ sessionId: "s2" }));
    engine.cancelSession("s1");
    expect(await a.result).toMatchObject({ status: "cancelled" });
    expect(engine.get(b.voteId)!.phase).toBe("open");
    expect(() => engine.cast(a.voteId, "p1", "o1")).toThrow(expect.objectContaining({ code: "closed" }));
  });

  it("never broadcasts individual ballots", () => {
    const { voteId } = engine.open(req());
    engine.cast(voteId, "p1", "o1");
    expect(JSON.stringify(emitted)).not.toContain("p1");
  });

  describe("owner-only decisions", () => {
    const perm = () => req({ kind: "permission", audience: "owner", options: [{ label: "Approve" }, { label: "Deny" }] });

    it("only the owner may decide; the first owner answer resolves it", async () => {
      const { voteId, result } = engine.open(perm());
      expect(() => engine.cast(voteId, "p1", "o1")).toThrow(expect.objectContaining({ code: "forbidden" }));
      engine.cast(voteId, "owner", "o2");
      expect(await result).toMatchObject({ status: "resolved", label: "Deny", reason: "owner_decision" });
    });

    it("falls back (deny) when the owner does not answer in time", async () => {
      const { result } = engine.open(perm());
      clock.advance(30_000);
      expect(await result).toMatchObject({ status: "fallback", reason: "fallback_owner_timeout" });
    });

    it("falls back immediately when the owner is offline", async () => {
      online.delete("owner");
      const { result } = engine.open(perm());
      expect(await peek(result)).toMatchObject({ status: "fallback", reason: "fallback_owner_absent" });
    });

    it("other people voting never closes an owner decision", () => {
      const { voteId } = engine.open(perm());
      for (const p of ["p1", "p2", "p3"]) expect(() => engine.cast(voteId, p, "o1")).toThrow();
      expect(engine.get(voteId)!.phase).toBe("open");
    });
  });
});
