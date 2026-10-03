/**
 * Claude Agent SDK adapter (verified against @anthropic-ai/claude-agent-sdk 0.3.x).
 *
 * - Runs `query()` in streaming-input mode so the owner can send follow-up prompts.
 * - Every tool permission flows through `canUseTool`. AskUserQuestion is answered by
 *   returning `{ behavior: "allow", updatedInput: { ...input, answers } }`, where
 *   `answers` maps question text -> chosen label (verified by scripts/poc-ask.ts).
 * - Text is streamed from `stream_event` deltas (includePartialMessages).
 */
import { query, type CanUseTool, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import type { AgentHandle, AgentProvider, AgentStartOptions, TeamQuestion } from "./types.ts";
import { QuestionRejected, TEAM_SYSTEM_PROMPT } from "./types.ts";

const SECRET_ENV = /^(COLAB_|GEMINI_|GOOGLE_API)/;

/** Async queue that feeds user messages into the SDK's streaming input. */
class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;

  push(text: string) {
    if (this.closed) return;
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      origin: { kind: "human" },
    } as SDKUserMessage;
    const w = this.waiters.shift();
    if (w) w({ value: msg, done: false });
    else this.items.push(msg);
  }

  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const v = this.items.shift();
        if (v) return Promise.resolve({ value: v, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
    };
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : "")).join("\n");
  return "";
}

export const CLAUDE_MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
];

export function claudeProvider(opts: { model?: string; apiKey?: boolean } = {}): AgentProvider {
  return {
    id: "claude",
    info: () => ({
      id: "claude",
      label: "Claude (Agent SDK)",
      available: true,
      note: null,
      auth: opts.apiKey ? "API key (ANTHROPIC_API_KEY)" : "Claude Code login",
      models: CLAUDE_MODELS,
      defaultModel: opts.model ?? "claude-sonnet-5-5",
      byoVendor: "anthropic",
      byoReady: true,
    }),
    start(o: AgentStartOptions): AgentHandle {
      const model = o.model ?? opts.model;
      const { hooks } = o;
      const prompts = new PromptQueue();
      const abort = new AbortController();
      prompts.push(o.task);

      const canUseTool: CanUseTool = async (toolName, input, { signal }) => {
        if (toolName === "AskUserQuestion") {
          const questions = (input as { questions?: TeamQuestion[] }).questions;
          try {
            if (!Array.isArray(questions) || questions.length === 0) throw new QuestionRejected("questions must be a non-empty array");
            const answers = await hooks.askTeam(questions, signal);
            const map: Record<string, string> = {};
            questions.forEach((q, i) => (map[q.question] = answers[i]!.label ?? answers[i]!.note));
            return { behavior: "allow", updatedInput: { ...input, answers: map } };
          } catch (e) {
            if (e instanceof QuestionRejected)
              return { behavior: "deny", message: `Your question could not be put to a team vote: ${e.message}. Ask again with 2-4 distinct options.` };
            return { behavior: "deny", message: "The question was cancelled.", interrupt: true };
          }
        }
        const p = await hooks.authorizeTool(toolName, input, signal);
        return p.allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: p.message };
      };

      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !SECRET_ENV.test(k)) env[k] = v;
      if (o.apiKey) {
        // Participant's own key: bill it, never fall back to the host's login.
        env.ANTHROPIC_API_KEY = o.apiKey;
        delete env.CLAUDE_CODE_OAUTH_TOKEN;
      }

      const q = query({
        prompt: prompts,
        options: {
          cwd: o.cwd,
          abortController: abort,
          includePartialMessages: true,
          permissionMode: "default",
          settingSources: [],
          env,
          ...(model ? { model } : {}),
          disallowedTools: ["WebFetch", "WebSearch", "Agent", "Task"],
          systemPrompt: { type: "preset", preset: "claude_code", append: TEAM_SYSTEM_PROMPT.replaceAll("{{ASK_TOOL}}", "AskUserQuestion") },
          canUseTool,
          stderr: (data: string) => hooks.emit({ type: "log", level: "warn", message: data.slice(0, 500) }),
        },
      });

      const streamed = new Set<string>(); // text blocks already delivered via deltas
      const textIds = new Map<string, string>(); // "<msgId>:<index>" -> transcript id
      let currentMsgId = "";

      const handle = (msg: SDKMessage) => {
        switch (msg.type) {
          case "stream_event": {
            const ev = msg.event as { type: string; index?: number; message?: { id: string }; delta?: { type: string; text?: string }; content_block?: { type: string } };
            if (ev.type === "message_start" && ev.message) currentMsgId = ev.message.id;
            if (ev.type === "content_block_start" && ev.content_block?.type === "text") {
              const key = `${currentMsgId}:${ev.index}`;
              const id = randomUUID();
              textIds.set(key, id);
              streamed.add(key);
              hooks.emit({ type: "text_start", id });
            }
            if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
              const id = textIds.get(`${currentMsgId}:${ev.index}`);
              if (id) hooks.emit({ type: "text_delta", id, text: ev.delta.text });
            }
            break;
          }
          case "assistant": {
            if (msg.parent_tool_use_id) break; // sub-agent chatter
            const mid = msg.message.id;
            msg.message.content.forEach((b, i) => {
              const key = `${mid}:${i}`;
              if (b.type === "text") {
                const id = textIds.get(key);
                if (id) hooks.emit({ type: "text_end", id, text: b.text });
                else if (!streamed.has(key) && b.text.trim()) {
                  const nid = randomUUID();
                  hooks.emit({ type: "text_start", id: nid });
                  hooks.emit({ type: "text_end", id: nid, text: b.text });
                }
              } else if (b.type === "tool_use") {
                hooks.emit({ type: "tool_call", id: b.id, tool: b.name, input: (b.input ?? {}) as Record<string, unknown> });
              }
            });
            break;
          }
          case "user": {
            const c = msg.message.content;
            if (Array.isArray(c))
              for (const b of c)
                if (b && typeof b === "object" && b.type === "tool_result")
                  hooks.emit({ type: "tool_result", id: b.tool_use_id, ok: !b.is_error, output: toolResultText(b.content).slice(0, 2000) });
            break;
          }
          case "result":
            hooks.emit({
              type: "turn_end",
              ok: msg.subtype === "success" && !msg.is_error,
              costUsd: msg.total_cost_usd,
              ...(msg.subtype !== "success" ? { error: msg.subtype } : msg.is_error ? { error: String(msg.result).slice(0, 300) } : {}),
            });
            break;
        }
      };

      const done = (async () => {
        try {
          for await (const msg of q) handle(msg);
        } catch (e) {
          if (!abort.signal.aborted) throw e;
        } finally {
          prompts.close();
        }
      })();

      return {
        send: (text) => prompts.push(text),
        cancel: async () => {
          prompts.close();
          abort.abort();
          try {
            q.close();
          } catch {
            /* already closed */
          }
          await done.catch(() => {});
        },
        done,
      };
    },
  };
}
