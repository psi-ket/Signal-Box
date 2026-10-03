/**
 * Hub session manager. Agent sessions execute on runners (teammates' machines); the hub
 * tracks their state, turns runner events into room transcript events, and runs team votes
 * and owner decisions on the runners' behalf. No agent code runs on the hub.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { ProviderId, SessionView, TranscriptItem } from "../shared/protocol.ts";
import type { HubToRunner, RunnerToHub, WireAgentEvent } from "../shared/runnerProtocol.ts";
import { resolveModel, type TeamAnswer, type TeamQuestion } from "./agents/types.ts";
import { VENDOR_FOR_PROVIDER } from "./keys.ts";
import type { Logger } from "./log.ts";
import type { Room } from "./room.ts";
import type { RunnerLink } from "./runners.ts";
import { VoteError, type VoteEngine, type VoteOutcome } from "./votes.ts";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export class SessionError extends Error {
  constructor(
    public code: "forbidden" | "not_found" | "conflict" | "limit" | "unavailable",
    message: string,
  ) {
    super(message);
  }
}

interface Runtime {
  id: string;
  runnerId: string;
  pendingVotes: Set<string>;
  tools: Map<string, { isTest: boolean; item: TranscriptItem & { kind: "tool_call" } }>;
  testRuns: { passed: number; failed: number };
  decisions: number;
  errors: string[];
  stopping: boolean;
  abort: AbortController;
}

export interface SessionManagerDeps {
  room: Room;
  roomInfo: { id: string; gitUrl: string; baseRef: string };
  votes: VoteEngine;
  log: Logger;
  maxSessions: number;
  /** Resolves the runner that runs a person's agents (their own, else the shared host runner). */
  runnerFor: (userId: string) => RunnerLink | undefined;
  runner: (runnerId: string) => RunnerLink | undefined;
  /** Whether a runner holds this participant's key for the vendor. */
  hasKey: (runnerId: string, participantId: string, provider: ProviderId) => { models: { id: string; label: string }[] } | null;
}

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "session";

export class SessionManager {
  private runtimes = new Map<string, Runtime>();

  constructor(private deps: SessionManagerDeps) {}

  view(id: string): SessionView | undefined {
    return this.deps.room.state.sessions[id];
  }

  runtime(id: string) {
    return this.runtimes.get(id);
  }

  sessionIds() {
    return [...this.runtimes.keys()];
  }

  activeCount() {
    return Object.values(this.deps.room.state.sessions).filter((s) => !TERMINAL.has(s.status)).length;
  }

  private patch(id: string, patch: Partial<Omit<SessionView, "transcript">>) {
    const cur = this.view(id);
    if (!cur) return;
    const { transcript: _t, ...rest } = cur;
    this.deps.room.dispatch({ type: "session.upsert", sessionId: id, payload: { ...rest, ...patch } });
  }

  private append(sessionId: string, item: TranscriptItem) {
    this.deps.room.dispatch({ type: "transcript.append", sessionId, payload: { sessionId, item } });
  }

  private note(sessionId: string, kind: "system" | "error", text: string) {
    this.append(sessionId, kind === "error" ? { kind, id: randomUUID(), at: Date.now(), message: text } : { kind, id: randomUUID(), at: Date.now(), text });
  }

  create(owner: { id: string; name: string }, input: { title: string; task: string; provider: ProviderId; model?: string; ownKey?: boolean }): SessionView {
    const runner = this.deps.runnerFor(owner.id);
    if (!runner) throw new SessionError("unavailable", "connect a runner first: your agents run on your own machine (rooms page → your runners)");
    let info = runner.providers.find((p) => p.id === input.provider);
    if (!info) throw new SessionError("unavailable", `${runner.name} has no ${input.provider} agent`);
    if (input.ownKey) {
      const vendor = VENDOR_FOR_PROVIDER[input.provider];
      const k = vendor && info.byoReady ? this.deps.hasKey(runner.id, owner.id, input.provider) : null;
      if (!k) throw new SessionError("unavailable", `add and check your ${vendor ?? ""} API key first (keys tab)`);
      const def = info.defaultModel;
      info = { ...info, models: k.models, defaultModel: k.models.some((m) => m.id === def) ? def : (k.models[0]?.id ?? null) };
    } else if (!info.available) {
      throw new SessionError("unavailable", `${info.label} is not available on ${runner.name}: ${info.note ?? "unknown"}${info.byoReady ? " (you can use your own API key)" : ""}`);
    }
    let model: string | undefined;
    try {
      model = resolveModel(info, input.model);
    } catch (e) {
      throw new SessionError("unavailable", (e as Error).message);
    }
    if (this.activeCount() >= this.deps.maxSessions) throw new SessionError("limit", `at most ${this.deps.maxSessions} active agents per room`);

    const id = randomBytes(4).toString("hex");
    const branch = `colab/${slug(input.title)}-${id}`;
    const rt: Runtime = { id, runnerId: runner.id, pendingVotes: new Set(), tools: new Map(), testRuns: { passed: 0, failed: 0 }, decisions: 0, errors: [], stopping: false, abort: new AbortController() };
    this.runtimes.set(id, rt);
    const now = Date.now();
    this.deps.room.dispatch({
      type: "session.upsert",
      sessionId: id,
      payload: {
        id,
        title: input.title,
        task: input.task,
        ownerId: owner.id,
        ownerName: owner.name,
        provider: input.provider,
        model: model ?? null,
        runnerName: runner.name,
        billing: input.ownKey ? "own" : "host",
        branch,
        status: "starting",
        createdAt: now,
        startedAt: null,
        endedAt: null,
        error: null,
        turns: 0,
        costUsd: null,
        filesTouched: [],
      },
    });
    this.append(id, { kind: "prompt", id: randomUUID(), at: now, text: input.task, by: owner.name });
    runner.send({
      type: "runner.start",
      sessionId: id,
      roomId: this.deps.roomInfo.id,
      gitUrl: this.deps.roomInfo.gitUrl,
      baseRef: this.deps.roomInfo.baseRef,
      branch,
      title: input.title,
      task: input.task,
      provider: input.provider,
      ...(model ? { model } : {}),
      ...(input.ownKey ? { ownKeyFor: owner.id } : {}),
    });
    return this.view(id)!;
  }

  prompt(sessionId: string, participantId: string, text: string) {
    const s = this.requireOwned(sessionId, participantId, false);
    if (TERMINAL.has(s.status) || s.status === "starting") throw new SessionError("conflict", `session is ${s.status}`);
    const rt = this.runtimes.get(sessionId)!;
    const runner = this.deps.runner(rt.runnerId);
    if (!runner) throw new SessionError("conflict", "the runner for this agent is offline");
    const by = this.deps.room.state.participants[participantId]?.name ?? "owner";
    this.append(sessionId, { kind: "prompt", id: randomUUID(), at: Date.now(), text, by });
    runner.send({ type: "runner.prompt", sessionId, text });
    if (s.status === "idle") this.patch(sessionId, { status: "running" });
  }

  stop(sessionId: string, participantId: string | null, isAdmin: boolean, final: "cancelled" | "completed") {
    const s = participantId === null ? this.view(sessionId) : this.requireOwned(sessionId, participantId, isAdmin);
    if (!s) throw new SessionError("not_found", "no such session");
    if (TERMINAL.has(s.status)) return;
    const rt = this.runtimes.get(sessionId)!;
    rt.stopping = true;
    rt.abort.abort();
    this.deps.votes.cancelSession(sessionId);
    this.patch(sessionId, { status: final, endedAt: Date.now() });
    this.note(sessionId, "system", final === "cancelled" ? "Session cancelled." : "Session ended.");
    this.deps.runner(rt.runnerId)?.send({ type: "runner.stop", sessionId });
  }

  stopAll() {
    for (const s of Object.values(this.deps.room.state.sessions)) if (!TERMINAL.has(s.status)) this.stop(s.id, null, true, "completed");
  }

  /** A runner went away: its live sessions can't continue. */
  runnerGone(runnerId: string) {
    for (const rt of this.runtimes.values()) {
      if (rt.runnerId !== runnerId) continue;
      const s = this.view(rt.id);
      if (!s || TERMINAL.has(s.status)) continue;
      rt.abort.abort();
      this.deps.votes.cancelSession(rt.id);
      rt.errors.push("runner disconnected");
      this.note(rt.id, "error", `The runner ${s.runnerName} disconnected; this agent stopped. Its branch stays on that machine.`);
      this.patch(rt.id, { status: "failed", error: "runner disconnected", endedAt: Date.now() });
    }
  }

  private requireOwned(sessionId: string, participantId: string, allowAdmin: boolean): SessionView {
    const s = this.view(sessionId);
    if (!s) throw new SessionError("not_found", "no such session");
    if (s.ownerId !== participantId && !allowAdmin) throw new SessionError("forbidden", "only the session owner can do that");
    return s;
  }

  // ---------- runner messages ----------

  /** Handles a message from a runner. Returns false if the session isn't run by that runner. */
  onRunnerMessage(runner: RunnerLink, msg: RunnerToHub): boolean {
    if (!("sessionId" in msg)) return false;
    const rt = this.runtimes.get(msg.sessionId);
    if (!rt || rt.runnerId !== runner.id) return false;
    const s = this.view(rt.id)!;
    switch (msg.type) {
      case "runner.session":
        if (msg.status === "running") {
          if (s.status === "starting") this.patch(rt.id, { status: "running", startedAt: Date.now() });
        } else if (!rt.stopping && !TERMINAL.has(s.status)) {
          if (msg.status === "failed") {
            rt.errors.push(msg.error ?? "failed");
            this.note(rt.id, "error", `Agent stopped: ${msg.error ?? "unknown error"}`);
          }
          this.deps.votes.cancelSession(rt.id);
          this.patch(rt.id, { status: msg.status === "failed" ? "failed" : "completed", error: msg.status === "failed" ? (msg.error ?? null)?.slice(0, 300) ?? null : null, endedAt: Date.now() });
        }
        return true;
      case "runner.event":
        this.onAgentEvent(rt, msg.event);
        return true;
      case "runner.ask":
        void this.answerAsk(runner, rt, msg.requestId, msg.questions as TeamQuestion[]);
        return true;
      case "runner.authorize":
        void this.answerAuthorize(runner, rt, msg);
        return true;
      default:
        return true; // drift messages are handled by the room
    }
  }

  private reply(runner: RunnerLink, m: Extract<HubToRunner, { type: "runner.answer" }>) {
    runner.send(m);
  }

  private async runVote(
    rt: Runtime,
    req: { kind: "question" | "permission"; audience?: "team" | "owner"; header: string; question: string; detail?: string; options: { label: string; description?: string }[] },
  ): Promise<VoteOutcome> {
    const s = this.view(rt.id)!;
    const { voteId, result } = this.deps.votes.open({ sessionId: rt.id, ownerId: s.ownerId, ...req });
    rt.pendingVotes.add(voteId);
    rt.decisions++;
    this.patch(rt.id, { status: "waiting_vote" });
    const onAbort = () => this.deps.votes.cancel(voteId);
    rt.abort.signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await result;
    } finally {
      rt.abort.signal.removeEventListener("abort", onAbort);
      rt.pendingVotes.delete(voteId);
      const cur = this.view(rt.id);
      if (cur && cur.status === "waiting_vote" && rt.pendingVotes.size === 0) this.patch(rt.id, { status: "running" });
    }
  }

  private describe(o: VoteOutcome): string {
    if (o.status === "resolved") return `${o.label} (${o.reason.replaceAll("_", " ")})`;
    if (o.status === "fallback") return `no decision (${o.reason === "fallback_owner_absent" ? "tie or no votes, owner offline" : "owner did not decide in time"})`;
    return "cancelled";
  }

  private async answerAsk(runner: RunnerLink, rt: Runtime, requestId: string, questions: TeamQuestion[]) {
    for (const q of questions)
      if (!q.question?.trim() || !Array.isArray(q.options) || q.options.length < 2)
        return this.reply(runner, { type: "runner.answer", requestId, ok: false, reason: "rejected", message: `"${q.question ?? ""}" needs a question and at least 2 options` });
    try {
      const outcomes = await Promise.all(
        questions.map((q) =>
          this.runVote(rt, { kind: "question", header: String(q.header ?? ""), question: q.question, detail: q.multiSelect ? "The agent allowed multiple answers; the team picks one." : undefined, options: q.options }),
        ),
      );
      if (outcomes.some((o) => o.status === "cancelled")) return this.reply(runner, { type: "runner.answer", requestId, ok: false, reason: "cancelled", message: "decision cancelled" });
      const answers: TeamAnswer[] = outcomes.map((o, i) => {
        this.append(rt.id, { kind: "decision", id: randomUUID(), at: Date.now(), voteId: o.voteId, text: `${questions[i]!.question} → ${this.describe(o)}` });
        return o.status === "resolved"
          ? { label: o.label, note: "" }
          : { label: null, note: "No team decision was reached. Choose the most reversible option and state your assumption in your final message." };
      });
      this.reply(runner, { type: "runner.answer", requestId, ok: true, answers });
    } catch (e) {
      const malformed = e instanceof VoteError && e.code === "malformed";
      this.reply(runner, { type: "runner.answer", requestId, ok: false, reason: malformed ? "rejected" : "cancelled", message: (e as Error).message });
    }
  }

  private async answerAuthorize(runner: RunnerLink, rt: Runtime, msg: Extract<RunnerToHub, { type: "runner.authorize" }>) {
    try {
      const outcome = await this.runVote(rt, {
        kind: "permission",
        audience: "owner",
        header: `Run ${msg.tool}?`,
        question: `Allow the agent to run: ${msg.summary}`,
        detail: `Runner policy: ${msg.reason}. Only the session owner decides. Approval runs this one call only; the policy still blocks dangerous commands.`,
        options: [
          { label: "Approve", description: "Run this call once" },
          { label: "Deny", description: "Refuse; the agent must adapt" },
        ],
      });
      if (outcome.status === "cancelled") return this.reply(runner, { type: "runner.answer", requestId: msg.requestId, ok: false, reason: "cancelled", message: "cancelled" });
      this.append(rt.id, { kind: "decision", id: randomUUID(), at: Date.now(), voteId: outcome.voteId, text: `Permission for ${msg.tool}: ${this.describe(outcome)}` });
      const allow = outcome.status === "resolved" && outcome.label === "Approve";
      this.reply(runner, {
        type: "runner.answer",
        requestId: msg.requestId,
        ok: true,
        allow,
        message: allow ? undefined : outcome.status === "fallback" ? "Denied by default: the session owner did not answer." : "Denied by the session owner.",
      });
    } catch (e) {
      this.reply(runner, { type: "runner.answer", requestId: msg.requestId, ok: false, reason: "cancelled", message: (e as Error).message });
    }
  }

  private onAgentEvent(rt: Runtime, ev: WireAgentEvent) {
    const s = this.view(rt.id);
    if (!s) return;
    const now = Date.now();
    const sessionId = rt.id;
    switch (ev.type) {
      case "text_start":
        this.append(sessionId, { kind: "text", id: ev.id, at: now, text: "", streaming: true });
        break;
      case "text_delta":
        this.deps.room.dispatch({ type: "transcript.delta", sessionId, payload: { sessionId, itemId: ev.id, text: ev.text } });
        break;
      case "text_end":
        this.deps.room.dispatch({ type: "transcript.update", sessionId, payload: { sessionId, item: { kind: "text", id: ev.id, at: now, text: ev.text, streaming: false } } });
        break;
      case "tool_call": {
        const item = { kind: "tool_call" as const, id: ev.id, at: now, tool: ev.tool, summary: ev.summary, status: "pending" as const };
        rt.tools.set(ev.id, { isTest: ev.isTest, item });
        this.append(sessionId, item);
        if (ev.file) {
          this.append(sessionId, { kind: "file", id: randomUUID(), at: now, path: ev.file.path, action: ev.file.action });
          if (!s.filesTouched.includes(ev.file.path)) this.patch(sessionId, { filesTouched: [...s.filesTouched, ev.file.path].slice(-200) });
        }
        break;
      }
      case "tool_result": {
        const t = rt.tools.get(ev.id);
        if (!t) break;
        const denied = /^(Blocked by host policy|Denied by|Denied by default|Denied:|Session cancelled)/.test(ev.output);
        const status = denied ? "denied" : ev.ok ? "ok" : "error";
        if (t.isTest && status !== "denied") ev.ok ? rt.testRuns.passed++ : rt.testRuns.failed++;
        this.deps.room.dispatch({ type: "transcript.update", sessionId, payload: { sessionId, item: { ...t.item, status, result: ev.output.slice(0, 600) } } });
        rt.tools.delete(ev.id);
        break;
      }
      case "turn_end": {
        if (ev.error) {
          rt.errors.push(ev.error);
          this.note(sessionId, "error", `Turn ended with an error: ${ev.error}`);
        }
        const cur = this.view(sessionId)!;
        if (TERMINAL.has(cur.status)) break;
        this.patch(sessionId, {
          status: "idle",
          turns: cur.turns + 1,
          costUsd: ev.costUsd !== undefined ? (cur.costUsd ?? 0) + ev.costUsd : cur.costUsd,
          error: ev.error ?? null,
        });
        break;
      }
      case "log":
        this.deps.log[ev.level](`agent: ${ev.message}`, { sessionId });
        break;
    }
  }

  stats(sessionId: string) {
    const rt = this.runtimes.get(sessionId);
    return rt ? { testRuns: { ...rt.testRuns }, decisions: rt.decisions, errors: [...rt.errors] } : null;
  }
}
