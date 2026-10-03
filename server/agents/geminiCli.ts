/**
 * Gemini CLI adapter over the Agent Client Protocol (`gemini --acp`, JSON-RPC 2.0 on stdio).
 * Verified against gemini-cli 0.51 by scripts/poc-gemini-cli.ts.
 *
 * - Team questions: `ask_team` served by the host's loopback MCP endpoint (session/new mcpServers).
 * - Permissions: every `session/request_permission` goes through the host policy. The CLI's
 *   own read-only tools inside the workspace run without asking.
 * - Auth: GEMINI_API_KEY if set (ACP `authenticate` with gemini-api-key), otherwise the
 *   CLI's Google login (oauth-personal).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { StdioRpc, spawnAgent, RpcError } from "./stdioRpc.ts";
import type { AgentHandle, AgentProvider, AgentStartOptions } from "./types.ts";
import { TEAM_SYSTEM_PROMPT } from "./types.ts";

const KEEP_ENV = ["GEMINI_API_KEY", "GOOGLE_API_KEY"];

interface AcpToolCall {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  locations?: { path: string }[];
  content?: { type: string; path?: string; content?: { type: string; text?: string } }[];
  rawInput?: Record<string, unknown>;
}

/** The toolCallId of Gemini CLI tools is `<tool_name>__<call id>`, or contains the MCP tool name. */
export function acpToolName(tc: AcpToolCall): string {
  return tc.toolCallId.split("__")[0] ?? "";
}

export function isAskTeamCall(tc: AcpToolCall): boolean {
  return /ask_team/.test(tc.toolCallId) || /^ask_team\b/.test(tc.title ?? "");
}

/** Maps an ACP permission request onto host-policy tool calls (Claude tool names). */
export function permissionChecks(tc: AcpToolCall): { tool: string; input: Record<string, unknown> }[] {
  const name = acpToolName(tc);
  const paths = [
    ...(tc.locations ?? []).map((l) => l.path),
    ...(tc.content ?? []).filter((c) => c.type === "diff" && c.path).map((c) => c.path!),
    ...(typeof tc.rawInput?.file_path === "string" ? [tc.rawInput.file_path] : []),
  ];
  const kind = tc.kind ?? "";
  if (kind === "execute" || name === "run_shell_command" || name === "shell") {
    const command = typeof tc.rawInput?.command === "string" ? tc.rawInput.command : (tc.title ?? "").replace(/\s*\[current working directory.*$/s, "");
    return [{ tool: "Bash", input: { command } }];
  }
  if (["edit", "delete", "move"].includes(kind) || /write_file|replace|edit/.test(name)) {
    const unique = [...new Set(paths)];
    return unique.length ? unique.map((file_path) => ({ tool: "Edit", input: { file_path } })) : [{ tool: "Edit", input: {} }];
  }
  if (["read", "search"].includes(kind)) {
    const unique = [...new Set(paths)];
    return unique.length ? unique.map((file_path) => ({ tool: "Read", input: { file_path } })) : [{ tool: "Read", input: { file_path: "." } }];
  }
  // fetch, web search, unknown tools: not permitted
  return [{ tool: `gemini:${name || kind || "unknown"}`, input: {} }];
}

function authMethod(ownKey?: string): { id: string; keep: boolean } | null {
  if (ownKey) return { id: "gemini-api-key", keep: false };
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return { id: "gemini-api-key", keep: true };
  if (existsSync(path.join(homedir(), ".gemini", "oauth_creds.json"))) return { id: "oauth-personal", keep: false };
  return null;
}

async function openAcp(
  cwd: string,
  args: string[],
  handlers: Partial<{ onNotification: (m: string, p: any) => void; onRequest: (m: string, p: any) => Promise<unknown>; onStderr: (l: string) => void }> = {},
  ownKey?: string,
) {
  // With a participant's own key, the host's Gemini credentials are not passed at all.
  const child = spawnAgent("gemini", ["--acp", ...args], cwd, ownKey ? { env: { GEMINI_API_KEY: ownKey } } : { keepEnv: KEEP_ENV });
  const rpc = new StdioRpc(child, {
    jsonrpc: true,
    onNotification: handlers.onNotification ?? (() => {}),
    onRequest: handlers.onRequest ?? (async () => { throw new RpcError(-32601, "unsupported"); }),
    onStderr: handlers.onStderr,
  });
  await rpc.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, 60_000);
  const auth = authMethod(ownKey);
  if (!auth) throw new Error("Gemini CLI is not authenticated: set GEMINI_API_KEY or run `gemini` once to log in");
  await rpc.request("authenticate", { methodId: auth.id }, 60_000);
  return rpc;
}

export function geminiCliProvider(opts: { model?: string } = {}): AgentProvider {
  let available = false;
  let note: string | null = "checking Gemini CLI…";
  let models: { id: string; label: string }[] = [];
  let defaultModel: string | null = opts.model ?? null;
  let installed = false;
  return {
    id: "gemini-cli",
    info: () => ({
      id: "gemini-cli",
      label: "Gemini CLI",
      available,
      note,
      auth: authMethod()?.id === "gemini-api-key" ? "API key (GEMINI_API_KEY)" : "Gemini CLI Google login",
      models,
      defaultModel,
      byoVendor: "gemini",
      byoReady: installed,
    }),
    async discover() {
      installed = spawnSync(process.platform === "win32" ? "gemini.cmd" : "gemini", ["--version"], { encoding: "utf8", shell: process.platform === "win32", windowsHide: true }).status === 0;
      if (!installed) {
        available = false;
        note = "gemini CLI not found (npm i -g @google/gemini-cli)";
        return;
      }
      const dir = mkdtempSync(path.join(tmpdir(), "colab-gcli-"));
      let rpc: StdioRpc | null = null;
      try {
        rpc = await openAcp(dir, []);
        const s = await rpc.request<{ models?: { availableModels?: { modelId: string; name?: string }[]; currentModelId?: string } }>("session/new", { cwd: dir, mcpServers: [] }, 60_000);
        models = (s.models?.availableModels ?? []).map((m) => ({ id: m.modelId, label: m.name ?? m.modelId }));
        defaultModel = opts.model ?? s.models?.currentModelId ?? models[0]?.id ?? null;
        available = true;
        note = null;
      } catch (e) {
        available = false;
        note = (e as Error).message.slice(0, 200);
      } finally {
        rpc?.kill();
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      }
    },
    start(o: AgentStartOptions): AgentHandle {
      const { hooks } = o;
      const model = o.model ?? opts.model;
      const abort = new AbortController();
      const queue: string[] = [o.task];
      let first = true;
      let sessionId = "";
      let stopped = false;
      let busy = false;
      let text: { id: string; buf: string } | null = null;
      let seq = 0;
      const toolStarted = new Set<string>();

      const closeText = () => {
        if (text) hooks.emit({ type: "text_end", id: text.id, text: text.buf });
        text = null;
      };

      const onNotification = (method: string, p: any) => {
        if (method !== "session/update") return;
        const u = p.update ?? {};
        switch (u.sessionUpdate) {
          case "agent_message_chunk":
            if (u.content?.type !== "text") break;
            if (!text) {
              text = { id: `${o.sessionId}-t${++seq}`, buf: "" };
              hooks.emit({ type: "text_start", id: text.id });
            }
            text.buf += u.content.text;
            hooks.emit({ type: "text_delta", id: text.id, text: u.content.text });
            break;
          case "tool_call": {
            closeText();
            const tc = u as AcpToolCall;
            if (isAskTeamCall(tc) || /^update_topic|^Update topic/i.test(`${acpToolName(tc)} ${tc.title}`)) break;
            toolStarted.add(tc.toolCallId);
            const checks = permissionChecks(tc);
            hooks.emit({ type: "tool_call", id: tc.toolCallId, tool: checks[0]!.tool, input: checks[0]!.input });
            break;
          }
          case "tool_call_update": {
            const tc = u as AcpToolCall;
            if (!toolStarted.has(tc.toolCallId) || !["completed", "failed"].includes(tc.status ?? "")) break;
            toolStarted.delete(tc.toolCallId);
            const out = (tc.content ?? []).map((c) => c.content?.text ?? "").join("\n");
            hooks.emit({ type: "tool_result", id: tc.toolCallId, ok: tc.status === "completed", output: out.slice(0, 2000) || String(tc.status) });
            break;
          }
        }
      };

      const onRequest = async (method: string, p: any) => {
        if (method !== "session/request_permission") throw new RpcError(-32601, `unsupported request ${method}`);
        const tc = p.toolCall as AcpToolCall;
        const options = p.options as { optionId: string; kind: string }[];
        const allow = options.find((x) => x.kind === "allow_once") ?? options.find((x) => x.kind.startsWith("allow"));
        const reject = options.find((x) => x.kind === "reject_once") ?? options.find((x) => x.kind.startsWith("reject"));
        const pick = (opt: { optionId: string } | undefined) => (opt ? { outcome: { outcome: "selected", optionId: opt.optionId } } : { outcome: { outcome: "cancelled" } });
        if (isAskTeamCall(tc)) return pick(allow); // our own MCP tool
        if (/^update_topic/.test(acpToolName(tc))) return pick(allow); // CLI bookkeeping, no side effects
        for (const c of permissionChecks(tc)) {
          const r = await hooks.authorizeTool(c.tool, c.input, abort.signal);
          if (!r.allow) {
            if (toolStarted.has(tc.toolCallId)) {
              toolStarted.delete(tc.toolCallId);
              hooks.emit({ type: "tool_result", id: tc.toolCallId, ok: false, output: r.message });
            }
            return pick(reject);
          }
        }
        return pick(allow);
      };

      const rpcPromise = openAcp(
        o.cwd,
        model ? ["--model", model] : [],
        {
        onNotification,
        onRequest,
          onStderr: (l) => {
            if (/error/i.test(l)) hooks.emit({ type: "log", level: "warn", message: l.slice(0, 300) });
          },
        },
        o.apiKey,
      );

      const pump = async (rpc: StdioRpc) => {
        if (busy || stopped || !sessionId) return;
        const prompt = queue.shift();
        if (prompt === undefined) return;
        busy = true;
        const body = first ? `${TEAM_SYSTEM_PROMPT.replaceAll("{{ASK_TOOL}}", "ask_team")}\n\n---\n\nTask:\n${prompt}` : prompt;
        first = false;
        try {
          const r = await rpc.request<{ stopReason: string }>("session/prompt", { sessionId, prompt: [{ type: "text", text: body }] }, 60 * 60_000);
          closeText();
          hooks.emit({ type: "turn_end", ok: r.stopReason === "end_turn", ...(r.stopReason !== "end_turn" ? { error: `stopped: ${r.stopReason}` } : {}) });
        } catch (e) {
          closeText();
          if (!stopped) hooks.emit({ type: "turn_end", ok: false, error: (e as Error).message.slice(0, 300) });
        } finally {
          busy = false;
        }
        void pump(rpc);
      };

      const done = (async () => {
        const rpc = await rpcPromise;
        const mcpServers = o.mcpUrl ? [{ type: "http", name: "colab", url: o.mcpUrl, headers: [] }] : [];
        const s = await rpc.request<{ sessionId: string }>("session/new", { cwd: o.cwd, mcpServers }, 120_000);
        sessionId = s.sessionId;
        void pump(rpc);
        const code = await rpc.exited;
        if (!stopped) throw new Error(`gemini exited unexpectedly (${code})`);
      })();

      return {
        send(t) {
          queue.push(t);
          void rpcPromise.then((rpc) => pump(rpc)).catch(() => {});
        },
        async cancel() {
          stopped = true;
          abort.abort();
          const rpc = await rpcPromise.catch(() => null);
          if (rpc) {
            if (sessionId) rpc.notify("session/cancel", { sessionId });
            rpc.kill();
          }
          await done.catch(() => {});
        },
        done,
      };
    },
  };
}

