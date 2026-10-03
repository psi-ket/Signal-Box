/**
 * OpenAI API adapter: a host-run function-calling loop over Chat Completions
 * (POST /v1/chat/completions with `tools`). Like the Gemini API adapter, the host provides
 * policy-gated file/shell tools (LocalTools) and `ask_team`, which maps to the team vote.
 * Runs with the host's OPENAI_API_KEY or a participant's own key.
 */
import { randomUUID } from "node:crypto";
import { LocalTools, type ToolResult } from "./localTools.ts";
import type { AgentHandle, AgentProvider, AgentStartOptions } from "./types.ts";
import { QuestionRejected, TEAM_SYSTEM_PROMPT } from "./types.ts";

const API = "https://api.openai.com/v1";
const MAX_STEPS_PER_TURN = 40;

const str = { type: "string" } as const;
const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[]) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
});
export const OPENAI_TOOLS = [
  fn("list_files", "List files under a directory of the worktree (recursive).", { path: { ...str, description: "Directory relative to the worktree root; '.' for root." } }, ["path"]),
  fn("read_file", "Read a UTF-8 text file in the worktree.", { path: str }, ["path"]),
  fn("write_file", "Create or overwrite a file in the worktree.", { path: str, content: str }, ["path", "content"]),
  fn("edit_file", "Replace exactly one occurrence of old_string with new_string in a file.", { path: str, old_string: str, new_string: str }, ["path", "old_string", "new_string"]),
  fn("run_command", "Run a shell command in the worktree root. Subject to the host security policy; some commands need the owner's approval or are blocked.", { command: str }, ["command"]),
  fn(
    "ask_team",
    "Ask the supervising team to vote on a genuine decision. Blocks until they decide. Offer 2-4 distinct options.",
    {
      header: { ...str, description: "Short label, max 12 chars, e.g. 'Database'." },
      question: str,
      options: { type: "array", items: { type: "object", properties: { label: str, description: str }, required: ["label", "description"], additionalProperties: false } },
    },
    ["header", "question", "options"],
  ),
];

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export function openaiProvider(opts: { apiKey?: string; model: string }): AgentProvider {
  let models: { id: string; label: string }[] = [{ id: opts.model, label: opts.model }];
  let note: string | null = opts.apiKey ? null : "add your own OpenAI key, or set OPENAI_API_KEY on the host";
  return {
    id: "openai-api",
    async discover() {
      if (!opts.apiKey) return;
      try {
        const { checkKey } = await import("../keys.ts");
        const list = await checkKey("openai", opts.apiKey);
        if (list.length) models = list;
      } catch (e) {
        note = `host key check failed: ${(e as Error).message}`;
      }
    },
    info: () => ({
      id: "openai-api",
      label: "OpenAI API (host tool loop)",
      available: !!opts.apiKey,
      note,
      auth: opts.apiKey ? "API key (OPENAI_API_KEY)" : "none",
      models,
      defaultModel: models.some((m) => m.id === opts.model) ? opts.model : (models[0]?.id ?? opts.model),
      byoVendor: "openai",
      byoReady: true,
    }),
    start(o: AgentStartOptions): AgentHandle {
      const apiKey = o.apiKey ?? opts.apiKey;
      if (!apiKey) throw new Error("no OpenAI API key");
      const model = o.model ?? opts.model;
      const { hooks } = o;
      const abort = new AbortController();
      const tools = new LocalTools(o.cwd, hooks);
      const messages: Message[] = [{ role: "system", content: TEAM_SYSTEM_PROMPT.replaceAll("{{ASK_TOOL}}", "ask_team") }];
      const queue: string[] = [o.task];
      let wake: (() => void) | null = null;
      let stopped = false;

      const callModel = async () => {
        const res = await fetch(`${API}/chat/completions`, {
          method: "POST",
          signal: abort.signal,
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, messages, tools: OPENAI_TOOLS }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          choices?: { message?: { content: string | null; tool_calls?: ToolCall[] }; finish_reason?: string }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
          error?: { message?: string };
        };
        if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${body.error?.message ?? res.statusText}`.replaceAll(apiKey, "***"));
        const msg = body.choices?.[0]?.message;
        if (!msg) throw new Error(`OpenAI returned no message (finish_reason: ${body.choices?.[0]?.finish_reason ?? "unknown"})`);
        return msg;
      };

      const runTool = async (name: string, rawArgs: string): Promise<ToolResult> => {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(rawArgs || "{}");
        } catch {
          return { ok: false, output: "arguments were not valid JSON" };
        }
        const s = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "");
        const signal = abort.signal;
        switch (name) {
          case "list_files":
            return tools.listFiles(s("path"), signal);
          case "read_file":
            return tools.readFile(s("path"), signal);
          case "write_file":
            return tools.writeFile(s("path"), s("content"), signal);
          case "edit_file":
            return tools.editFile(s("path"), s("old_string"), s("new_string"), signal);
          case "run_command":
            return tools.runCommand(s("command"), signal);
          case "ask_team":
            try {
              const [a] = await hooks.askTeam([{ header: s("header"), question: s("question"), options: (args.options as { label: string; description?: string }[]) ?? [] }], signal);
              return { ok: true, output: a!.label ? `The team chose: ${a!.label}` : a!.note };
            } catch (e) {
              if (e instanceof QuestionRejected) return { ok: false, output: `Question rejected: ${e.message}. Ask again with 2-4 distinct options.` };
              throw e;
            }
          default:
            return { ok: false, output: `unknown tool ${name}` };
        }
      };

      const runTurn = async (prompt: string) => {
        messages.push({ role: "user", content: prompt });
        for (let step = 0; step < MAX_STEPS_PER_TURN; step++) {
          const msg = await callModel();
          messages.push({ role: "assistant", content: msg.content ?? null, ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
          if (msg.content?.trim()) {
            const id = randomUUID();
            hooks.emit({ type: "text_start", id });
            hooks.emit({ type: "text_end", id, text: msg.content });
          }
          if (!msg.tool_calls?.length) return;
          for (const call of msg.tool_calls) {
            let input: Record<string, unknown> = {};
            try {
              input = JSON.parse(call.function.arguments || "{}");
            } catch {
              /* reported by runTool */
            }
            hooks.emit({ type: "tool_call", id: call.id, tool: call.function.name, input });
            const r = await runTool(call.function.name, call.function.arguments);
            hooks.emit({ type: "tool_result", id: call.id, ok: r.ok, output: r.output.slice(0, 2000) });
            messages.push({ role: "tool", tool_call_id: call.id, content: (r.ok ? r.output : `ERROR: ${r.output}`).slice(0, 20_000) });
          }
        }
        throw new Error(`stopped after ${MAX_STEPS_PER_TURN} steps in one turn`);
      };

      const done = (async () => {
        while (!stopped) {
          const prompt = queue.shift();
          if (prompt === undefined) {
            await new Promise<void>((r) => (wake = r));
            continue;
          }
          try {
            await runTurn(prompt);
            hooks.emit({ type: "turn_end", ok: true });
          } catch (e) {
            if (abort.signal.aborted) break;
            hooks.emit({ type: "turn_end", ok: false, error: (e as Error).message.slice(0, 300) });
          }
        }
      })();

      return {
        send(text) {
          queue.push(text);
          wake?.();
          wake = null;
        },
        async cancel() {
          stopped = true;
          abort.abort();
          wake?.();
          await done.catch(() => {});
        },
        done,
      };
    },
  };
}
