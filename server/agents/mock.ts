/**
 * MOCK provider: a deterministic scripted agent with no AI behind it. It exists for
 * automated tests and as a labelled offline fallback for demos. It goes through the
 * same vote engine, policy, worktree and drift paths as real agents.
 *
 * Script lines (one directive per line, in task or follow-up prompts):
 *   say <text>                     stream text
 *   ask <question> | <opt> | <opt>  team vote (2+ options)
 *   write <path> :: <content>      write file ("\n" escapes allowed)
 *   append <path> :: <content>     append to file
 *   run <command>                  shell command (policy-gated)
 *   sleep <ms>                     pause
 *   fail <message>                 end the turn with an error
 * Lines that are not directives are echoed as text.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveInside } from "../policy.ts";
import { LocalTools } from "./localTools.ts";
import type { AgentHandle, AgentHooks, AgentProvider, AgentStartOptions } from "./types.ts";
import { QuestionRejected } from "./types.ts";

const unescape = (s: string) => s.replace(/\\n/g, "\n");

export function mockProvider(opts: { enabled: boolean; stepDelayMs?: number }): AgentProvider {
  const delay = opts.stepDelayMs ?? 150;
  return {
    id: "mock",
    info: () => ({
      id: "mock",
      label: "Mock (scripted, no AI)",
      available: opts.enabled,
      note: opts.enabled ? "deterministic script; not a real agent" : "start with --allow-mock",
      auth: "none",
      models: [{ id: "script", label: "Script" }],
      defaultModel: "script",
      byoVendor: null,
      byoReady: false,
    }),
    start(o: AgentStartOptions): AgentHandle {
      const abort = new AbortController();
      const tools = new LocalTools(o.cwd, o.hooks);
      const queue: string[] = [o.task];
      let wake: (() => void) | null = null;
      let stopped = false;
      const sleep = (ms: number) =>
        new Promise<void>((r, j) => {
          const t = setTimeout(r, ms);
          abort.signal.addEventListener("abort", () => (clearTimeout(t), j(new Error("aborted"))), { once: true });
        });

      const say = async (hooks: AgentHooks, text: string) => {
        const id = randomUUID();
        hooks.emit({ type: "text_start", id });
        for (const word of text.split(/(?<= )/)) {
          hooks.emit({ type: "text_delta", id, text: word });
          await sleep(Math.min(delay, 20));
        }
        hooks.emit({ type: "text_end", id, text });
      };

      const tool = async (name: string, input: Record<string, unknown>, fn: () => Promise<{ ok: boolean; output: string }>) => {
        const id = randomUUID();
        o.hooks.emit({ type: "tool_call", id, tool: name, input });
        const r = await fn();
        o.hooks.emit({ type: "tool_result", id, ok: r.ok, output: r.output });
        return r;
      };

      const runScript = async (script: string) => {
        for (const raw of script.split(/\r?\n/)) {
          const line = raw.trim();
          if (!line) continue;
          const [cmd, ...rest] = line.split(" ");
          const arg = rest.join(" ");
          await sleep(delay);
          switch (cmd) {
            case "say":
              await say(o.hooks, arg);
              break;
            case "ask": {
              const [question, ...options] = arg.split("|").map((s) => s.trim());
              await tool("AskUserQuestion", { question }, async () => {
                try {
                  const [a] = await o.hooks.askTeam([{ header: "Decision", question: question ?? "", options: options.map((label) => ({ label })) }], abort.signal);
                  return { ok: true, output: a!.label ? `team chose: ${a!.label}` : a!.note };
                } catch (e) {
                  if (e instanceof QuestionRejected) return { ok: false, output: e.message };
                  throw e;
                }
              });
              break;
            }
            case "write":
            case "append": {
              const [p, ...c] = arg.split(" :: ");
              const file = (p ?? "").trim();
              let content = unescape(c.join(" :: "));
              if (cmd === "append") {
                const rel = resolveInside(o.cwd, file);
                const prev = rel === null ? "" : await readFile(path.join(o.cwd, rel), "utf8").catch(() => "");
                content = prev + content;
              }
              await tool(cmd === "write" ? "Write" : "Edit", { file_path: file }, () => tools.writeFile(file, content, abort.signal));
              break;
            }
            case "run":
              await tool("Bash", { command: arg }, () => tools.runCommand(arg, abort.signal));
              break;
            case "sleep":
              await sleep(Number(arg) || 0);
              break;
            case "fail":
              throw new Error(arg || "scripted failure");
            default:
              await say(o.hooks, line);
          }
        }
      };

      const done = (async () => {
        while (!stopped) {
          const script = queue.shift();
          if (script === undefined) {
            await new Promise<void>((r) => (wake = r));
            continue;
          }
          try {
            await runScript(script);
            o.hooks.emit({ type: "turn_end", ok: true, costUsd: 0 });
          } catch (e) {
            if (abort.signal.aborted) break;
            o.hooks.emit({ type: "turn_end", ok: false, error: (e as Error).message });
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
