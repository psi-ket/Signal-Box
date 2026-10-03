/**
 * Gemini adapter: a host-run function-calling loop over the Gemini REST API
 * (v1beta generateContent). Gemini has no built-in coding tools or permission
 * callback, so the host provides file/shell tools (LocalTools, policy-gated) and an
 * `ask_team` tool that maps to the same team vote as Claude's AskUserQuestion.
 *
 * The model's content (including any thought signatures) is echoed back verbatim in
 * the history, as the API requires for multi-step function calling.
 * Text is delivered per model response, not token-streamed.
 */
import { randomUUID } from "node:crypto";
import { LocalTools, type ToolResult } from "./localTools.ts";
import type { AgentHandle, AgentProvider, AgentStartOptions } from "./types.ts";
import { QuestionRejected, TEAM_SYSTEM_PROMPT } from "./types.ts";

const API = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_STEPS_PER_TURN = 40;

type Part = { text?: string; thought?: boolean; functionCall?: { name: string; args?: Record<string, unknown>; id?: string }; [k: string]: unknown };
type Content = { role: "user" | "model"; parts: Part[] };

const str = { type: "STRING" } as const;
const FUNCTIONS = [
  { name: "list_files", description: "List files under a directory of the worktree (recursive).", parameters: { type: "OBJECT", properties: { path: { ...str, description: "Directory relative to the worktree root; '.' for root." } }, required: ["path"] } },
  { name: "read_file", description: "Read a UTF-8 text file in the worktree.", parameters: { type: "OBJECT", properties: { path: str }, required: ["path"] } },
  { name: "write_file", description: "Create or overwrite a file in the worktree.", parameters: { type: "OBJECT", properties: { path: str, content: str }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exactly one occurrence of old_string with new_string in a file.", parameters: { type: "OBJECT", properties: { path: str, old_string: str, new_string: str }, required: ["path", "old_string", "new_string"] } },
  { name: "run_command", description: "Run a shell command in the worktree root. Subject to the host security policy; some commands need team approval or are blocked.", parameters: { type: "OBJECT", properties: { command: str }, required: ["command"] } },
  {
    name: "ask_team",
    description: "Ask the supervising team to vote on a genuine decision. Blocks until they decide. Offer 2-4 distinct options.",
    parameters: {
      type: "OBJECT",
      properties: {
        header: { ...str, description: "Short label, max 12 chars, e.g. 'Database'." },
        question: str,
        options: { type: "ARRAY", items: { type: "OBJECT", properties: { label: str, description: str }, required: ["label"] } },
      },
      required: ["header", "question", "options"],
    },
  },
];

/** Lists generateContent-capable text models for the key. */
export async function listGeminiModels(apiKey: string): Promise<{ id: string; label: string }[]> {
  const res = await fetch(`${API}?pageSize=200`, { headers: { "x-goog-api-key": apiKey }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`model list failed: HTTP ${res.status}`);
  const body = (await res.json()) as { models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[] };
  return (body.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => ({ id: m.name.replace(/^models\//, ""), label: m.displayName ?? m.name }))
    .filter((m) => /^gemini-/.test(m.id) && !/(tts|image|audio|live|embedding)/.test(m.id));
}

export function geminiProvider(opts: { apiKey?: string; model: string }): AgentProvider {
  let models: { id: string; label: string }[] = [{ id: opts.model, label: opts.model }];
  let note: string | null = opts.apiKey ? null : "set GEMINI_API_KEY in .env to enable";
  return {
    id: "gemini-api",
    info: () => ({
      id: "gemini-api",
      label: "Gemini API (host tool loop)",
      available: !!opts.apiKey,
      note,
      auth: opts.apiKey ? "API key (GEMINI_API_KEY)" : "none",
      models,
      defaultModel: opts.model,
      byoVendor: "gemini",
      byoReady: true,
    }),
    async discover() {
      if (!opts.apiKey) return;
      try {
        const list = await listGeminiModels(opts.apiKey);
        if (list.length) models = list.some((m) => m.id === opts.model) ? list : [{ id: opts.model, label: opts.model }, ...list];
      } catch (e) {
        note = `model list unavailable: ${(e as Error).message}`;
      }
    },
    start(o: AgentStartOptions): AgentHandle {
      const apiKey = o.apiKey ?? opts.apiKey;
      if (!apiKey) throw new Error("no Gemini API key");
      const model = o.model ?? opts.model;
      const { hooks } = o;
      const abort = new AbortController();
      const tools = new LocalTools(o.cwd, hooks);
      const history: Content[] = [];
      const queue: string[] = [o.task];
      let wake: (() => void) | null = null;
      let stopped = false;
      const systemInstruction = { parts: [{ text: TEAM_SYSTEM_PROMPT.replaceAll("{{ASK_TOOL}}", "ask_team") }] };

      const callModel = async (): Promise<Content> => {
        const res = await fetch(`${API}/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          signal: abort.signal,
          headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({ systemInstruction, contents: history, tools: [{ functionDeclarations: FUNCTIONS }] }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          candidates?: { content?: Content; finishReason?: string }[];
          error?: { message?: string };
        };
        if (!res.ok) throw new Error(`Gemini API ${res.status}: ${body.error?.message ?? res.statusText}`.replaceAll(apiKey, "***"));
        const content = body.candidates?.[0]?.content;
        if (!content?.parts) throw new Error(`Gemini returned no content (finishReason: ${body.candidates?.[0]?.finishReason ?? "unknown"})`);
        return { role: "model", parts: content.parts };
      };

      const runTool = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
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
          case "ask_team": {
            try {
              const [a] = await hooks.askTeam(
                [{ header: s("header"), question: s("question"), options: (args.options as { label: string; description?: string }[]) ?? [] }],
                signal,
              );
              return { ok: true, output: a!.label ? `The team chose: ${a!.label}` : a!.note };
            } catch (e) {
              if (e instanceof QuestionRejected) return { ok: false, output: `Question rejected: ${e.message}. Ask again with 2-4 distinct options.` };
              throw e;
            }
          }
          default:
            return { ok: false, output: `unknown tool ${name}` };
        }
      };

      const runTurn = async (prompt: string) => {
        history.push({ role: "user", parts: [{ text: prompt }] });
        for (let step = 0; step < MAX_STEPS_PER_TURN; step++) {
          const content = await callModel();
          history.push(content);
          const text = content.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("");
          if (text.trim()) {
            const id = randomUUID();
            hooks.emit({ type: "text_start", id });
            hooks.emit({ type: "text_end", id, text });
          }
          const calls = content.parts.filter((p) => p.functionCall).map((p) => p.functionCall!);
          if (calls.length === 0) return;
          const responses: Part[] = [];
          for (const call of calls) {
            const id = call.id ?? randomUUID();
            const args = call.args ?? {};
            hooks.emit({ type: "tool_call", id, tool: call.name, input: args });
            const r = await runTool(call.name, args);
            hooks.emit({ type: "tool_result", id, ok: r.ok, output: r.output.slice(0, 2000) });
            responses.push({ functionResponse: { name: call.name, ...(call.id ? { id: call.id } : {}), response: r.ok ? { output: r.output } : { error: r.output } } });
          }
          history.push({ role: "user", parts: responses });
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
