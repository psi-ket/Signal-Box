import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { QuestionRejected, type TeamQuestion } from "../server/agents/types.ts";
import { McpRegistry } from "../server/mcp.ts";

describe("MCP ask_team endpoint", () => {
  let server: http.Server;
  let base = "";
  const asked: TeamQuestion[][] = [];
  const registry = new McpRegistry(() => base);
  let url = "";
  let dispose = () => {};

  const rpc = async (u: string, body: unknown, method = "POST") => {
    const res = await fetch(u, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? JSON.stringify(body) : undefined });
    return { status: res.status, json: res.status === 200 ? await res.json() : null };
  };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (!registry.handle(req, res)) res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    ({ url, dispose } = registry.register(async (qs) => {
      asked.push(qs);
      if (qs[0]!.options.length < 2) throw new QuestionRejected("needs at least 2 options");
      return [{ label: "SQLite", note: "" }];
    }));
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("speaks the MCP handshake and lists ask_team", async () => {
    const init = await rpc(url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(init.json.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} } });
    expect((await rpc(url, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const list = await rpc(url, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(list.json.result.tools.map((t: { name: string }) => t.name)).toEqual(["ask_team"]);
  });

  it("routes tools/call to the team and returns the decision", async () => {
    const r = await rpc(url, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ask_team", arguments: { header: "DB", question: "Which DB?", options: [{ label: "PostgreSQL" }, { label: "SQLite" }] } } });
    expect(r.json.result).toEqual({ content: [{ type: "text", text: "The team chose: SQLite" }], isError: false });
    expect(asked.at(-1)![0]).toMatchObject({ question: "Which DB?" });
    const bad = await rpc(url, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "ask_team", arguments: { question: "x", options: [] } } });
    expect(bad.json.result.isError).toBe(true);
    expect(bad.json.result.content[0].text).toMatch(/Question rejected/);
    const unknown = await rpc(url, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "rm_rf" } });
    expect(unknown.json.error.code).toBe(-32602);
  });

  it("rejects unknown tokens, GET, and disposed sessions", async () => {
    expect((await rpc(`${base}/mcp/not-a-token`, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(404);
    expect((await rpc(url, null, "GET")).status).toBe(405);
    dispose();
    expect((await rpc(url, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(404);
  });
});
