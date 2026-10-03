/**
 * Gemini adapter contract test with a stubbed HTTP API (no network, no key).
 * Verifies OUR side of the function-calling loop: request shape, tool execution through
 * the host policy, ask_team → team vote mapping, and history echoing. It does NOT prove
 * the live Gemini API behaves this way; that needs a real GEMINI_API_KEY.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { geminiProvider } from "../server/agents/gemini.ts";
import type { AgentEvent, AgentHooks } from "../server/agents/types.ts";
import { evaluateTool } from "../server/policy.ts";
import { makeRepo } from "./helpers.ts";

afterEach(() => vi.unstubAllGlobals());

describe("gemini adapter (stubbed API)", () => {
  it("runs the tool loop, routes ask_team to the team, and enforces policy", async () => {
    const repo = await makeRepo({ "a.txt": "hello\n" });
    const replies = [
      { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "ask_team", args: { header: "DB", question: "Which DB?", options: [{ label: "PostgreSQL" }, { label: "SQLite" }] } }, thoughtSignature: "sig1" }] } }] },
      { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "write_file", args: { path: "db.txt", content: "sqlite" } } }, { functionCall: { name: "read_file", args: { path: "../outside.txt" } } }] } }] },
      { candidates: [{ content: { role: "model", parts: [{ text: "Chose SQLite." }] } }] },
    ];
    const bodies: { contents: { role: string; parts: Record<string, unknown>[] }[]; tools: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toContain("models/test-model:generateContent");
      expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("k");
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(replies.shift()), { status: 200 });
    }));

    const events: AgentEvent[] = [];
    const asked: string[] = [];
    const hooks: AgentHooks = {
      emit: (e) => events.push(e),
      askTeam: async (qs) => (asked.push(qs[0]!.question), [{ label: "SQLite", note: "" }]),
      authorizeTool: async (tool, input) => {
        const v = evaluateTool(tool, input, repo);
        return v.decision === "allow" ? { allow: true } : { allow: false, message: `Blocked by host policy: ${v.reason}.` };
      },
    };
    const h = geminiProvider({ apiKey: "k", model: "test-model" }).start({ sessionId: "s", cwd: repo, task: "do it", systemPrompt: "", hooks });
    await vi.waitFor(() => expect(events.some((e) => e.type === "turn_end")).toBe(true), { timeout: 5000 });
    await h.cancel();

    expect(asked).toEqual(["Which DB?"]);
    expect(await readFile(path.join(repo, "db.txt"), "utf8")).toBe("sqlite");
    const results = events.filter((e) => e.type === "tool_result") as Extract<AgentEvent, { type: "tool_result" }>[];
    expect(results.map((r) => r.ok)).toEqual([true, true, false]);
    expect(results[2]!.output).toMatch(/outside the session worktree/);
    expect(events.find((e) => e.type === "turn_end")).toMatchObject({ ok: true });
    expect(events.some((e) => e.type === "text_end" && e.text === "Chose SQLite.")).toBe(true);
    // the model turn (with its thought signature) is echoed back, then function responses
    expect(bodies[1]!.contents[1]).toMatchObject({ role: "model", parts: [{ thoughtSignature: "sig1" }] });
    expect(bodies[1]!.contents[2]!.parts[0]).toMatchObject({ functionResponse: { name: "ask_team", response: { output: "The team chose: SQLite" } } });
  });

  it("reports API errors without leaking the key and is unavailable without one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "bad key k-secret" } }), { status: 400 })));
    const events: AgentEvent[] = [];
    const repo = await makeRepo({ "a.txt": "x" });
    const hooks: AgentHooks = { emit: (e) => events.push(e), askTeam: async () => [], authorizeTool: async () => ({ allow: true }) };
    const h = geminiProvider({ apiKey: "k-secret", model: "m" }).start({ sessionId: "s", cwd: repo, task: "x", systemPrompt: "", hooks });
    await vi.waitFor(() => expect(events.some((e) => e.type === "turn_end")).toBe(true));
    await h.cancel();
    const end = events.find((e) => e.type === "turn_end") as Extract<AgentEvent, { type: "turn_end" }>;
    expect(end.ok).toBe(false);
    expect(end.error).toContain("400");
    expect(end.error).not.toContain("k-secret");
    expect(geminiProvider({ model: "m" }).info()).toMatchObject({ id: "gemini-api", available: false });
  });
});

describe("openai adapter (stubbed API)", () => {
  it("runs the chat-completions tool loop, routes ask_team, enforces policy, uses the session key", async () => {
    const { openaiProvider } = await import("../server/agents/openai.ts");
    const repo = await makeRepo({ "a.txt": "hello\n" });
    const call = (id: string, name: string, args: unknown) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
    const replies = [
      { choices: [{ message: { content: null, tool_calls: [call("c1", "ask_team", { header: "DB", question: "Which DB?", options: [{ label: "PostgreSQL", description: "" }, { label: "SQLite", description: "" }] })] } }] },
      { choices: [{ message: { content: null, tool_calls: [call("c2", "write_file", { path: "db.txt", content: "sqlite" }), call("c3", "run_command", { command: "curl http://x" })] } }] },
      { choices: [{ message: { content: "**Chose SQLite.**", tool_calls: [] } }] },
    ];
    const bodies: { model: string; messages: { role: string; tool_call_id?: string; content: string | null }[] }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.openai.com/v1/chat/completions");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-own-key");
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(replies.shift()), { status: 200 });
    }));
    const events: AgentEvent[] = [];
    const hooks: AgentHooks = {
      emit: (e) => events.push(e),
      askTeam: async () => [{ label: "SQLite", note: "" }],
      authorizeTool: async (tool, input) => {
        const v = evaluateTool(tool, input, repo);
        return v.decision === "allow" ? { allow: true } : { allow: false, message: `Blocked by host policy: ${v.reason}.` };
      },
    };
    const h = openaiProvider({ model: "gpt-5" }).start({ sessionId: "s", cwd: repo, task: "do it", systemPrompt: "", hooks, apiKey: "sk-own-key", model: "o4-mini" });
    await vi.waitFor(() => expect(events.some((e) => e.type === "turn_end")).toBe(true), { timeout: 5000 });
    await h.cancel();
    expect(bodies[0]!.model).toBe("o4-mini");
    expect(await readFile(path.join(repo, "db.txt"), "utf8")).toBe("sqlite");
    const results = events.filter((e) => e.type === "tool_result") as Extract<AgentEvent, { type: "tool_result" }>[];
    expect(results.map((r) => r.ok)).toEqual([true, true, false]);
    expect(results[2]!.output).toMatch(/network access/);
    expect(bodies[1]!.messages.find((m) => m.tool_call_id === "c1")!.content).toBe("The team chose: SQLite");
    expect(events.find((e) => e.type === "turn_end")).toMatchObject({ ok: true });
    expect(openaiProvider({ model: "gpt-5" }).info()).toMatchObject({ available: false, byoVendor: "openai", byoReady: true });
  });
});
