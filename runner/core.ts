/**
 * Runner core: runs on a teammate's machine. Clones a room's Git URL with the person's own
 * Git credentials, creates one worktree per agent, runs agents with the person's logins or
 * keys, enforces the permission policy locally, and streams events and drift snapshots to
 * the hub. Nothing the hub sends is executed as a shell command; the hub only chooses which
 * agent to start with which task, and answers questions and approvals.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import WebSocket from "ws";
import type { KeyVendor, ProviderId } from "../shared/protocol.ts";
import { RUNNER_SUBPROTOCOL, TOKEN_PREFIX, type HubToRunner, type RunnerToHub, MAX_PATCH_BYTES } from "../shared/runnerProtocol.ts";
import type { AgentEvent, AgentHandle, AgentHooks, AgentProvider, TeamAnswer, TeamQuestion, ToolPermission } from "../server/agents/types.ts";
import { QuestionRejected, resolveModel } from "../server/agents/types.ts";
import { DriftAnalyzer } from "../server/drift.ts";
import { git, gitOut } from "../server/git.ts";
import { gitNetEnv, validateGitUrl } from "../server/gitUrl.ts";
import { checkKey, maskKey, VENDOR_FOR_PROVIDER } from "../server/keys.ts";
import type { Logger } from "../server/log.ts";
import { McpRegistry } from "../server/mcp.ts";
import { evaluateTool, resolveInside, summarizeTool } from "../server/policy.ts";

const FILE_TOOLS: Record<string, "edit" | "write"> = { Write: "write", Edit: "edit", MultiEdit: "edit", NotebookEdit: "edit", write_file: "write", edit_file: "edit" };
const TEST_COMMAND = /\b(npm(\.cmd)?\s+(run\s+)?test|npx\s+(vitest|jest)|vitest|jest|pytest|python3?\s+-m\s+(pytest|unittest)|go\s+test|cargo\s+test)\b/;
const DRIFT_EVERY_MS = 10_000;

export interface RunnerOptions {
  hubUrl: string; // http(s)://host[:port]
  token: string;
  name: string;
  dataDir: string;
  providers: Record<string, AgentProvider>;
  allowLocalRepos: boolean;
  log: Logger;
  version?: string;
}

interface LocalSession {
  id: string;
  worktree: string;
  repoRoot: string;
  baseRef: string; // origin/<base>
  handle: AgentHandle | null;
  analyzer: DriftAnalyzer;
  lastDriftKey: string;
  stopped: boolean;
  disposeMcp: (() => void) | null;
  driftChain: Promise<void>;
}

type Pending = { resolve: (m: Extract<HubToRunner, { type: "runner.answer" }>) => void };

export class RunnerCore {
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private sessions = new Map<string, LocalSession>();
  private pending = new Map<string, Pending>();
  private keys = new Map<string, Map<KeyVendor, { key: string; models: { id: string; label: string }[]; checkedAt: number }>>();
  private cloneLocks = new Map<string, Promise<string>>();
  private driftTimer: NodeJS.Timeout | null = null;
  // Loopback MCP endpoint that gives CLI agents (Gemini CLI) the ask_team tool.
  private mcpPort = 0;
  private mcp = new McpRegistry(() => `http://127.0.0.1:${this.mcpPort}`);
  private mcpServer: http.Server | null = null;
  owner: { id: string; name: string } | null = null;
  shared = false;
  connected = false;
  onStatus?: (s: string) => void;

  constructor(private o: RunnerOptions) {}

  start() {
    this.connect();
    this.driftTimer = setInterval(() => void this.reportAllDrift(), DRIFT_EVERY_MS);
    this.driftTimer.unref();
  }

  private async mcpUrlFor(askTeam: AgentHooks["askTeam"]): Promise<{ url: string; dispose: () => void }> {
    if (!this.mcpServer) {
      this.mcpServer = http.createServer((req, res) => {
        if (!this.mcp.handle(req, res)) res.writeHead(404).end();
      });
      await new Promise<void>((r) => this.mcpServer!.listen(0, "127.0.0.1", r));
      this.mcpPort = (this.mcpServer.address() as AddressInfo).port;
    }
    return this.mcp.register(askTeam);
  }

  async stop() {
    this.stopped = true;
    if (this.driftTimer) clearInterval(this.driftTimer);
    for (const s of this.sessions.values()) await this.stopSession(s);
    this.mcpServer?.close();
    this.ws?.close(1000, "runner stopping");
  }

  private providerInfos() {
    return Object.values(this.o.providers).map((p) => p.info());
  }

  private connect() {
    const url = this.o.hubUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/runner";
    const ws = new WebSocket(url, [RUNNER_SUBPROTOCOL, TOKEN_PREFIX + this.o.token], { maxPayload: 1024 * 1024 });
    this.ws = ws;
    ws.on("open", () => {
      this.attempt = 0;
      this.connected = true;
      this.send({ type: "runner.hello", name: this.o.name, version: this.o.version ?? "0.3.0", platform: process.platform, providers: this.providerInfos() });
      this.onStatus?.("connected");
    });
    ws.on("message", (d) => {
      let m: HubToRunner;
      try {
        m = JSON.parse(d.toString());
      } catch {
        return;
      }
      void this.handle(m).catch((e) => this.o.log.error("runner handler failed", { type: m.type, error: (e as Error).message }));
    });
    ws.on("unexpected-response", (_req, res) => {
      this.o.log.error("hub rejected the runner", { status: res.statusCode });
      if (res.statusCode === 401) {
        this.onStatus?.("rejected: the runner token is invalid or was revoked");
        this.stopped = true;
      }
    });
    ws.on("error", (e) => this.o.log.warn("hub connection error", { error: e.message }));
    ws.on("close", () => {
      this.connected = false;
      // Questions and approvals in flight can't be answered; agents get "cancelled".
      for (const [id, p] of this.pending) p.resolve({ type: "runner.answer", requestId: id, ok: false, reason: "cancelled", message: "lost connection to the hub" });
      this.pending.clear();
      if (this.stopped) return;
      this.onStatus?.("reconnecting");
      const delay = Math.min(15_000, 500 * 2 ** this.attempt++);
      setTimeout(() => this.connect(), delay).unref();
    });
  }

  private send(m: RunnerToHub) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private request(m: RunnerToHub & { requestId: string }, signal: AbortSignal) {
    return new Promise<Extract<HubToRunner, { type: "runner.answer" }>>((resolve) => {
      if (!this.connected) return resolve({ type: "runner.answer", requestId: m.requestId, ok: false, reason: "cancelled", message: "not connected to the hub" });
      this.pending.set(m.requestId, { resolve });
      signal.addEventListener("abort", () => {
        this.pending.delete(m.requestId);
        resolve({ type: "runner.answer", requestId: m.requestId, ok: false, reason: "cancelled", message: "cancelled" });
      }, { once: true });
      this.send(m);
    });
  }

  private async handle(m: HubToRunner) {
    switch (m.type) {
      case "runner.welcome":
        this.owner = m.owner;
        this.shared = m.shared;
        this.onStatus?.(`paired as ${m.shared ? "the shared host runner" : `${m.owner?.name}'s runner`}`);
        return;
      case "runner.start":
        return this.startSession(m);
      case "runner.prompt":
        this.sessions.get(m.sessionId)?.handle?.send(m.text);
        return;
      case "runner.stop": {
        const s = this.sessions.get(m.sessionId);
        if (s) await this.stopSession(s);
        return;
      }
      case "runner.answer":
        this.pending.get(m.requestId)?.resolve(m);
        this.pending.delete(m.requestId);
        return;
      case "runner.key.set":
        return this.setKey(m.forParticipant, m.vendor, m.apiKey);
      case "runner.key.clear":
        this.keys.get(m.forParticipant)?.delete(m.vendor);
        this.sendKeys(m.forParticipant, null);
        return;
      case "runner.keys.request":
        this.sendKeys(m.forParticipant, null);
        return;
      case "runner.room.closed":
        return;
      case "runner.error":
        this.o.log.warn("hub error", { message: m.message });
        return;
    }
  }

  // ---------- keys (stay on this machine) ----------

  private async setKey(pid: string, vendor: KeyVendor, apiKey: string) {
    if (!this.shared && this.owner && pid !== this.owner.id) return; // a personal runner holds only its owner's keys
    try {
      const models = await checkKey(vendor, apiKey);
      if (!models.length) throw new Error("the key works but has access to no usable models");
      let m = this.keys.get(pid);
      if (!m) this.keys.set(pid, (m = new Map()));
      m.set(vendor, { key: apiKey, models, checkedAt: Date.now() });
      this.sendKeys(pid, { vendor, ok: true, error: null });
    } catch (e) {
      this.sendKeys(pid, { vendor, ok: false, error: (e as Error).message.replaceAll(apiKey, "***").slice(0, 280) });
    }
  }

  private sendKeys(pid: string, last: { vendor: KeyVendor; ok: boolean; error: string | null } | null) {
    const keys = [...(this.keys.get(pid)?.entries() ?? [])].map(([vendor, k]) => ({ vendor, masked: maskKey(k.key), models: k.models, checkedAt: k.checkedAt }));
    this.send({ type: "runner.keys", forParticipant: pid, keys, last });
  }

  // ---------- repos and sessions ----------

  /** Clones (once) or fetches the room's repo; returns the local clone path. */
  private ensureClone(gitUrl: string, baseRef: string): Promise<string> {
    const url = validateGitUrl(gitUrl, { allowLocal: this.o.allowLocalRepos });
    const dir = path.join(this.o.dataDir, "repos", createHash("sha256").update(url).digest("hex").slice(0, 16));
    const prev = this.cloneLocks.get(dir) ?? Promise.resolve(dir);
    const next = prev.catch(() => dir).then(async () => {
      const env = gitNetEnv(this.o.allowLocalRepos);
      if (!existsSync(path.join(dir, ".git"))) {
        await mkdir(path.dirname(dir), { recursive: true });
        await git(["-c", "protocol.ext.allow=never", "clone", "--quiet", "--", url, dir], { cwd: path.dirname(dir), env });
      }
      await git(["-c", "protocol.ext.allow=never", "fetch", "--quiet", "origin", baseRef], { cwd: dir, env });
      return dir;
    });
    this.cloneLocks.set(dir, next);
    return next;
  }

  private async startSession(m: Extract<HubToRunner, { type: "runner.start" }>) {
    const fail = (error: string) => this.send({ type: "runner.session", sessionId: m.sessionId, status: "failed", error: error.slice(0, 1500) });
    if (!/^[\w.\/-]{1,100}$/.test(m.baseRef) || m.baseRef.includes("..")) return fail("invalid base branch");
    if (!/^colab\/[\w.-]{1,80}$/.test(m.branch)) return fail("invalid branch name");
    const provider = this.o.providers[m.provider as ProviderId];
    if (!provider) return fail(`this runner has no ${m.provider} agent`);
    let info = provider.info();
    let apiKey: string | undefined;
    if (m.ownKeyFor) {
      const vendor = VENDOR_FOR_PROVIDER[m.provider];
      const stored = vendor ? this.keys.get(m.ownKeyFor)?.get(vendor) : undefined;
      if (!stored || !info.byoReady) return fail("your API key is not set on this runner");
      apiKey = stored.key;
      info = { ...info, models: stored.models };
    } else if (!info.available) return fail(`${info.label} is not available on this runner: ${info.note ?? ""}`);
    let model: string | undefined;
    try {
      model = resolveModel(info, m.model);
    } catch (e) {
      return fail((e as Error).message);
    }

    let repoRoot: string;
    try {
      repoRoot = await this.ensureClone(m.gitUrl, m.baseRef);
    } catch (e) {
      return fail(`could not clone or fetch the repo (check your Git access): ${(e as Error).message}`);
    }
    const worktree = path.join(repoRoot, ".git", "colab", "worktrees", m.sessionId.replace(/[^\w-]/g, ""));
    const baseRef = `origin/${m.baseRef}`;
    try {
      await git(["worktree", "add", "-b", m.branch, worktree, baseRef], { cwd: repoRoot });
    } catch (e) {
      return fail(`could not create a worktree: ${(e as Error).message}`);
    }
    const s: LocalSession = { id: m.sessionId, worktree, repoRoot, baseRef, handle: null, analyzer: new DriftAnalyzer(repoRoot, baseRef), lastDriftKey: "", stopped: false, disposeMcp: null, driftChain: Promise.resolve() };
    this.sessions.set(s.id, s);
    try {
      const hooks = this.hooksFor(s);
      let mcpUrl: string | undefined;
      if (m.provider === "gemini-cli") {
        const reg = await this.mcpUrlFor((qs, signal) => hooks.askTeam(qs, signal));
        s.disposeMcp = reg.dispose;
        mcpUrl = reg.url;
      }
      s.handle = provider.start({ sessionId: s.id, cwd: worktree, task: m.task, systemPrompt: "", model, apiKey, mcpUrl, hooks });
    } catch (e) {
      return fail(`agent failed to start: ${(e as Error).message}`);
    }
    this.send({ type: "runner.session", sessionId: s.id, status: "running" });
    s.handle.done.then(
      () => !s.stopped && this.send({ type: "runner.session", sessionId: s.id, status: "exited" }),
      (e: Error) => !s.stopped && this.send({ type: "runner.session", sessionId: s.id, status: "failed", error: e.message.slice(0, 1500) }),
    );
  }

  private async stopSession(s: LocalSession) {
    if (s.stopped) return;
    s.stopped = true;
    await s.handle?.cancel().catch(() => {});
    s.disposeMcp?.();
    s.lastDriftKey = ""; // always send a final snapshot so the hub can close the recap promptly
    await this.reportDrift(s).catch(() => {});
  }

  private hooksFor(s: LocalSession): AgentHooks {
    const emit = (ev: AgentEvent) => {
      if (ev.type === "tool_call") {
        const raw = ev.input.file_path ?? ev.input.notebook_path ?? ev.input.path;
        const rel = typeof raw === "string" ? resolveInside(s.worktree, raw) : null;
        const action = FILE_TOOLS[ev.tool];
        const command = typeof ev.input.command === "string" ? ev.input.command : "";
        this.send({
          type: "runner.event",
          sessionId: s.id,
          event: {
            type: "tool_call",
            id: ev.id,
            tool: ev.tool,
            summary: summarizeTool(ev.tool, ev.input, s.worktree).slice(0, 500),
            file: action && rel ? { path: rel, action } : null,
            isTest: (ev.tool === "Bash" || ev.tool === "run_command") && TEST_COMMAND.test(command),
          },
        });
        return;
      }
      if (ev.type === "tool_result") {
        this.send({ type: "runner.event", sessionId: s.id, event: { ...ev, output: ev.output.replaceAll(s.worktree, ".").slice(0, 20_000) } });
        return;
      }
      if (ev.type === "turn_end") void this.reportDrift(s).catch(() => {});
      this.send({ type: "runner.event", sessionId: s.id, event: ev });
    };

    const askTeam = async (questions: TeamQuestion[], signal: AbortSignal): Promise<TeamAnswer[]> => {
      const r = await this.request({ type: "runner.ask", requestId: randomUUID(), sessionId: s.id, questions: questions.slice(0, 4) as never }, signal);
      if (!r.ok) {
        if (r.reason === "rejected") throw new QuestionRejected(r.message);
        throw new Error(r.message);
      }
      return r.answers ?? [];
    };

    const authorizeTool = async (tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ToolPermission> => {
      const verdict = evaluateTool(tool, input, s.worktree);
      if (verdict.decision === "allow") return { allow: true };
      if (verdict.decision === "deny") return { allow: false, message: `Blocked by host policy: ${verdict.reason}.` };
      const r = await this.request(
        { type: "runner.authorize", requestId: randomUUID(), sessionId: s.id, tool, summary: summarizeTool(tool, input, s.worktree).slice(0, 500) || tool, reason: verdict.reason },
        signal,
      );
      if (r.ok && r.allow) return { allow: true };
      return { allow: false, message: r.ok ? (r.message ?? "Denied by the session owner.") : "Denied: the decision was cancelled." };
    };

    return { emit, askTeam, authorizeTool };
  }

  // ---------- drift ----------

  private async reportAllDrift() {
    for (const s of this.sessions.values()) if (!s.stopped) await this.reportDrift(s).catch(() => {});
  }

  /** Snapshots the worktree (without touching it) and uploads changed files + a binary patch. Serialized per session. */
  reportDrift(s: LocalSession): Promise<void> {
    s.driftChain = s.driftChain.then(() => this.doReportDrift(s)).catch(() => {});
    return s.driftChain;
  }

  private async doReportDrift(s: LocalSession) {
    try {
      const snap = await s.analyzer.snapshot({ sessionId: s.id, worktree: s.worktree });
      const baseSha = await gitOut(["merge-base", s.baseRef, snap], s.repoRoot);
      const key = `${baseSha}:${snap}`;
      if (key === s.lastDriftKey) return;
      const files = await s.analyzer.changedFiles(baseSha, snap);
      const diff = (await git(["diff", "--binary", "--no-ext-diff", "--no-color", baseSha, snap], { cwd: s.repoRoot })).stdout;
      const patch = Buffer.byteLength(diff) <= MAX_PATCH_BYTES ? Buffer.from(diff).toString("base64") : null;
      const commits = Number(await gitOut(["rev-list", "--count", `${baseSha}..HEAD`], s.worktree)) || 0;
      this.send({ type: "runner.drift", sessionId: s.id, baseSha, files, patch, commits });
      s.lastDriftKey = key;
    } catch (e) {
      this.send({ type: "runner.drift_error", sessionId: s.id, error: (e as Error).message.slice(0, 400) });
    }
  }

  /** Removes worktrees without uncommitted work. */
  async cleanup() {
    for (const s of this.sessions.values()) {
      try {
        const dirty = (await gitOut(["status", "--porcelain"], s.worktree)).length > 0;
        if (!dirty) await git(["worktree", "remove", s.worktree], { cwd: s.repoRoot });
        await s.analyzer.forget(s.id);
      } catch {
        /* keep it */
      }
    }
  }

  sessionWorktree(id: string) {
    return this.sessions.get(id)?.worktree;
  }
}
