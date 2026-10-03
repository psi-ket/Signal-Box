/**
 * Codex CLI adapter over the app-server protocol (`codex app-server`, JSON-RPC on stdio).
 * Verified against codex-cli 0.151 by scripts/poc-codex.ts.
 *
 * - Team questions: an experimental dynamic tool `ask_team` (thread/start dynamicTools),
 *   answered through `item/tool/call`; Codex's own `item/tool/requestUserInput` is also
 *   routed to the team.
 * - Permissions: approvalPolicy "untrusted" makes Codex ask before any command it does not
 *   consider safe and before file edits; each request goes through the host policy.
 *   Commands Codex treats as safe (read-only, e.g. `git status`) run inside Codex's own
 *   workspace-write sandbox without asking the host.
 * - Auth: whatever the Codex CLI is logged in with (ChatGPT account or `codex login --with-api-key`).
 */
import { spawnSync } from "node:child_process";
import { unwrapShellCommand } from "../policy.ts";
import { StdioRpc, spawnAgent, RpcError } from "./stdioRpc.ts";
import type { AgentHandle, AgentProvider, AgentStartOptions, TeamQuestion } from "./types.ts";
import { QuestionRejected, TEAM_SYSTEM_PROMPT } from "./types.ts";

const ASK_TEAM_SCHEMA = {
  type: "object",
  properties: {
    header: { type: "string", description: "Short label, max 12 chars" },
    question: { type: "string" },
    options: {
      type: "array",
      items: { type: "object", properties: { label: { type: "string" }, description: { type: "string" } }, required: ["label"] },
    },
  },
  required: ["header", "question", "options"],
};

const CLIENT_INFO = { name: "colab", title: "Signal Box", version: "0.2.0" };

/** Starts an app-server just long enough to read the account's model list. */
async function discoverModels(): Promise<{ id: string; label: string }[]> {
  const child = spawnAgent("codex", ["app-server"], process.cwd(), { keepEnv: ["OPENAI_API_KEY"] });
  const rpc = new StdioRpc(child, { jsonrpc: false, onNotification: () => {}, onRequest: async () => ({}) });
  try {
    await rpc.request("initialize", { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true } }, 20_000);
    rpc.notify("initialized");
    const res = await rpc.request<{ data: { id: string; displayName?: string; hidden?: boolean }[] }>("model/list", {}, 20_000);
    return res.data.filter((m) => !m.hidden).map((m) => ({ id: m.id, label: m.displayName ?? m.id }));
  } finally {
    rpc.kill();
  }
}

export function codexProvider(opts: { model?: string } = {}): AgentProvider {
  let available = false;
  let note: string | null = "checking Codex CLI…";
  let models: { id: string; label: string }[] = [];
  return {
    id: "codex",
    info: () => ({
      id: "codex",
      label: "Codex CLI",
      available,
      note,
      auth: "Codex CLI login",
      models,
      defaultModel: opts.model ?? models[0]?.id ?? null,
      byoVendor: null,
      byoReady: false,
    }),
    async discover() {
      const v = spawnSync(process.platform === "win32" ? "codex.cmd" : "codex", ["--version"], { encoding: "utf8", shell: process.platform === "win32", windowsHide: true });
      if (v.status !== 0) {
        available = false;
        note = "codex CLI not found (npm i -g @openai/codex)";
        return;
      }
      try {
        models = await discoverModels();
        available = true;
        note = v.stdout.trim();
      } catch (e) {
        available = false;
        note = `codex app-server failed: ${(e as Error).message}. Run \`codex login\`.`;
      }
    },
    start(o: AgentStartOptions): AgentHandle {
      const { hooks } = o;
      const model = o.model ?? opts.model;
      const child = spawnAgent("codex", ["app-server"], o.cwd, { keepEnv: ["OPENAI_API_KEY"] });
      const abort = new AbortController();
      const fileChanges = new Map<string, string[]>(); // itemId -> paths
      const textItems = new Set<string>();
      const queue: string[] = [o.task];
      let threadId = "";
      let turnId: string | null = null;
      let turnRunning = false;
      let stopped = false;

      const rpc = new StdioRpc(child, {
        jsonrpc: false,
        onStderr: (l) => {
          if (/\bERROR\b/.test(l) && !/models_manager/.test(l)) hooks.emit({ type: "log", level: "warn", message: l.replace(/\x1b\[[0-9;]*m/g, "").slice(0, 300) });
        },
        onNotification: (method, p) => {
          switch (method) {
            case "item/agentMessage/delta":
              if (!textItems.has(p.itemId)) {
                textItems.add(p.itemId);
                hooks.emit({ type: "text_start", id: p.itemId });
              }
              hooks.emit({ type: "text_delta", id: p.itemId, text: p.delta ?? "" });
              break;
            case "item/started": {
              const it = p.item;
              if (it.type === "commandExecution") hooks.emit({ type: "tool_call", id: it.id, tool: "Bash", input: { command: unwrapShellCommand(it.command ?? "") } });
              if (it.type === "fileChange") {
                const paths = (it.changes ?? []).map((c: { path: string }) => c.path);
                fileChanges.set(it.id, paths);
                paths.forEach((file_path: string, i: number) => hooks.emit({ type: "tool_call", id: `${it.id}:${i}`, tool: "Edit", input: { file_path } }));
              }
              if (it.type === "mcpToolCall") hooks.emit({ type: "tool_call", id: it.id, tool: `mcp:${it.tool}`, input: {} });
              break;
            }
            case "item/completed": {
              const it = p.item;
              if (it.type === "agentMessage") {
                if (!textItems.has(it.id)) hooks.emit({ type: "text_start", id: it.id });
                hooks.emit({ type: "text_end", id: it.id, text: it.text ?? "" });
                textItems.delete(it.id);
              }
              if (it.type === "commandExecution")
                hooks.emit({ type: "tool_result", id: it.id, ok: it.status === "completed" && (it.exitCode ?? 0) === 0, output: it.status === "declined" ? "Denied by host policy or owner." : String(it.aggregatedOutput ?? "").slice(-2000) });
              if (it.type === "fileChange")
                (fileChanges.get(it.id) ?? []).forEach((_, i) =>
                  hooks.emit({ type: "tool_result", id: `${it.id}:${i}`, ok: it.status === "completed", output: it.status === "declined" ? "Denied by host policy or owner." : String(it.status) }),
                );
              if (it.type === "mcpToolCall") hooks.emit({ type: "tool_result", id: it.id, ok: !it.error, output: JSON.stringify(it.result ?? it.error ?? "").slice(0, 500) });
              break;
            }
            case "turn/started":
              turnId = p.turn?.id ?? turnId;
              break;
            case "turn/completed": {
              const t = p.turn ?? {};
              turnRunning = false;
              turnId = null;
              hooks.emit({ type: "turn_end", ok: t.status === "completed", ...(t.status !== "completed" ? { error: t.error?.message ?? t.status } : {}) });
              pump();
              break;
            }
            case "error":
              hooks.emit({ type: "log", level: "warn", message: `codex error: ${JSON.stringify(p).slice(0, 300)}` });
              break;
          }
        },
        onRequest: async (method, p) => {
          const signal = abort.signal;
          switch (method) {
            case "item/tool/call": {
              if (p.tool !== "ask_team") return { success: false, contentItems: [{ type: "inputText", text: `unknown tool ${p.tool}` }] };
              const a = (p.arguments ?? {}) as { header?: string; question?: string; options?: { label: string; description?: string }[] };
              hooks.emit({ type: "tool_call", id: p.callId, tool: "ask_team", input: {} });
              try {
                const [ans] = await hooks.askTeam([{ header: a.header ?? "", question: a.question ?? "", options: a.options ?? [] }], signal);
                const text = ans!.label ? `The team chose: ${ans!.label}` : ans!.note;
                hooks.emit({ type: "tool_result", id: p.callId, ok: true, output: text });
                return { success: true, contentItems: [{ type: "inputText", text }] };
              } catch (e) {
                const text = e instanceof QuestionRejected ? `Question rejected: ${e.message}. Ask again with 2-4 distinct options.` : "The question was cancelled.";
                hooks.emit({ type: "tool_result", id: p.callId, ok: false, output: text });
                return { success: false, contentItems: [{ type: "inputText", text }] };
              }
            }
            case "item/tool/requestUserInput": {
              const qs = (p.questions ?? []) as { id: string; header: string; question: string; options: { label: string; description: string }[] | null }[];
              const votable = qs.filter((q) => (q.options?.length ?? 0) >= 2);
              const answers: Record<string, { answers: string[] }> = {};
              if (votable.length) {
                const res = await hooks.askTeam(votable.map((q): TeamQuestion => ({ header: q.header, question: q.question, options: q.options ?? [] })), signal).catch(() => null);
                votable.forEach((q, i) => (answers[q.id] = { answers: [res?.[i]?.label ?? res?.[i]?.note ?? "No team decision."] }));
              }
              for (const q of qs) answers[q.id] ??= { answers: ["The team cannot answer free-form questions here. Use your best judgment and state your assumption."] };
              return { answers };
            }
            case "item/commandExecution/requestApproval": {
              const command = unwrapShellCommand(String(p.command ?? ""));
              if (!command) return { decision: "decline" };
              const r = await hooks.authorizeTool("Bash", { command }, signal);
              return { decision: r.allow ? "accept" : "decline" };
            }
            case "item/fileChange/requestApproval": {
              const paths = fileChanges.get(p.itemId) ?? [];
              if (paths.length === 0) return { decision: "decline" };
              for (const file_path of paths) {
                const r = await hooks.authorizeTool("Edit", { file_path }, signal);
                if (!r.allow) return { decision: "decline" };
              }
              return { decision: "accept" };
            }
            case "execCommandApproval":
            case "applyPatchApproval":
              return { decision: "denied" };
            case "item/permissions/requestApproval":
            case "mcpServer/elicitation/request":
              throw new RpcError(-32601, "not permitted in team sessions");
            default:
              throw new RpcError(-32601, `unsupported request ${method}`);
          }
        },
      });

      const pump = () => {
        if (stopped || turnRunning || !threadId) return;
        const text = queue.shift();
        if (text === undefined) return;
        turnRunning = true;
        rpc.request("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }] }).then(
          (r: { turn?: { id: string } }) => (turnId = r.turn?.id ?? turnId),
          (e: Error) => {
            turnRunning = false;
            hooks.emit({ type: "turn_end", ok: false, error: e.message });
          },
        );
      };

      const done = (async () => {
        await rpc.request("initialize", { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true } }, 60_000);
        rpc.notify("initialized");
        const t = await rpc.request<{ thread: { id: string } }>("thread/start", {
          cwd: o.cwd,
          ...(model ? { model } : {}),
          approvalPolicy: "untrusted",
          sandbox: "workspace-write",
          ephemeral: true,
          developerInstructions: TEAM_SYSTEM_PROMPT.replaceAll("{{ASK_TOOL}}", "ask_team"),
          dynamicTools: [{ type: "function", name: "ask_team", description: "Ask the supervising team to vote on a genuine decision. Blocks until they decide. Offer 2-4 distinct options.", inputSchema: ASK_TEAM_SCHEMA }],
        });
        threadId = t.thread.id;
        pump();
        const code = await rpc.exited;
        if (!stopped) throw new Error(`codex exited unexpectedly (${code})`);
      })();

      return {
        send(text) {
          queue.push(text);
          pump();
        },
        async cancel() {
          stopped = true;
          abort.abort();
          if (threadId && turnId) await rpc.request("turn/interrupt", { threadId, turnId }, 3000).catch(() => {});
          rpc.kill();
          await done.catch(() => {});
        },
        done,
      };
    },
  };
}

