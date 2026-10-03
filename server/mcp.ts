/**
 * Minimal MCP server (streamable HTTP transport, JSON responses) that gives CLI agents
 * the `ask_team` tool. Each agent session gets its own unguessable URL
 * (/mcp/<token>), and requests are accepted from loopback addresses only.
 */
import { randomBytes } from "node:crypto";
import type http from "node:http";
import type { TeamAnswer, TeamQuestion } from "./agents/types.ts";
import { QuestionRejected } from "./agents/types.ts";

const MAX_BODY = 64 * 1024;

export const ASK_TEAM_TOOL = {
  name: "ask_team",
  description:
    "Ask the supervising team to vote on a genuine decision (architecture, library choice, ambiguous requirement). Blocks until they decide. Offer 2-4 distinct options. Never use it for progress updates.",
  inputSchema: {
    type: "object",
    properties: {
      header: { type: "string", description: "Short label, max 12 chars, e.g. 'Database'" },
      question: { type: "string" },
      options: {
        type: "array",
        items: { type: "object", properties: { label: { type: "string" }, description: { type: "string" } }, required: ["label"] },
      },
    },
    required: ["header", "question", "options"],
  },
};

type AskFn = (questions: TeamQuestion[], signal: AbortSignal) => Promise<TeamAnswer[]>;

export class McpRegistry {
  private sessions = new Map<string, { ask: AskFn; abort: AbortController }>();

  constructor(private baseUrl: () => string) {}

  /** Registers a session and returns its MCP URL and an unregister function. */
  register(ask: AskFn): { url: string; dispose: () => void } {
    const token = randomBytes(24).toString("base64url");
    const abort = new AbortController();
    this.sessions.set(token, { ask, abort });
    return {
      url: `${this.baseUrl()}/mcp/${token}`,
      dispose: () => {
        abort.abort();
        this.sessions.delete(token);
      },
    };
  }

  /** Returns true if the request was an MCP request (handled), false otherwise. */
  handle(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const m = /^\/mcp\/([\w-]+)$/.exec(new URL(req.url ?? "/", "http://x").pathname);
    if (!m) return false;
    const remote = req.socket.remoteAddress ?? "";
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) {
      res.writeHead(403).end();
      return true;
    }
    const session = this.sessions.get(m[1]!);
    if (!session) {
      res.writeHead(404).end();
      return true;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end();
      return true;
    }
    let body = "";
    let tooBig = false;
    req.on("data", (d: Buffer) => {
      body += d;
      if (body.length > MAX_BODY) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on("end", () => {
      if (tooBig) return;
      let msg: { id?: string | number; method?: string; params?: any };
      try {
        msg = JSON.parse(body);
      } catch {
        return json(res, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      }
      if (msg.id === undefined) {
        res.writeHead(202).end(); // notification
        return;
      }
      const reply = (result: unknown) => json(res, { jsonrpc: "2.0", id: msg.id, result });
      const fail = (code: number, message: string) => json(res, { jsonrpc: "2.0", id: msg.id, error: { code, message } });
      switch (msg.method) {
        case "initialize":
          return reply({ protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "colab", version: "0.2.0" } });
        case "ping":
          return reply({});
        case "tools/list":
          return reply({ tools: [ASK_TEAM_TOOL] });
        case "tools/call": {
          if (msg.params?.name !== "ask_team") return fail(-32602, `unknown tool ${msg.params?.name}`);
          const a = (msg.params.arguments ?? {}) as { header?: string; question?: string; options?: { label: string; description?: string }[] };
          const ac = new AbortController();
          res.on("close", () => {
            if (!res.writableEnded) ac.abort(); // agent hung up
          });
          session.abort.signal.addEventListener("abort", () => ac.abort(), { once: true });
          session.ask([{ header: a.header ?? "", question: a.question ?? "", options: Array.isArray(a.options) ? a.options : [] }], ac.signal).then(
            ([ans]) => reply({ content: [{ type: "text", text: ans!.label ? `The team chose: ${ans!.label}` : ans!.note }], isError: false }),
            (e: Error) =>
              reply({
                content: [{ type: "text", text: e instanceof QuestionRejected ? `Question rejected: ${e.message}. Ask again with 2-4 distinct options.` : "The question was cancelled." }],
                isError: true,
              }),
          );
          return;
        }
        default:
          return fail(-32601, "method not found");
      }
    });
    return true;
  }
}

function json(res: http.ServerResponse, body: unknown) {
  if (res.writableEnded) return;
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
}
