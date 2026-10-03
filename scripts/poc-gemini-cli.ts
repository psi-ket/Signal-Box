/**
 * Live proof of concept for Gemini CLI in ACP mode (`gemini --acp`): streaming updates,
 * permission requests, and an `ask_team` tool served from an HTTP MCP endpoint.
 *   npx tsx scripts/poc-gemini-cli.ts
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

if (existsSync(".env")) process.loadEnvFile(".env");
const cwd = mkdtempSync(path.join(tmpdir(), "colab-gcli-poc-"));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
writeFileSync(path.join(cwd, "README.md"), "# Todo\n");

let asked = false;
// --- minimal streamable-HTTP MCP server exposing ask_team ---
const mcp = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (req.method !== "POST") return res.writeHead(405).end();
    const msg = JSON.parse(body || "{}");
    console.log("[mcp]", msg.method);
    const reply = (result: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    if (msg.id === undefined) return res.writeHead(202).end();
    if (msg.method === "initialize")
      return reply({ protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "colab", version: "0.1.0" } });
    if (msg.method === "tools/list")
      return reply({
        tools: [
          {
            name: "ask_team",
            description: "Ask the supervising team to vote on a decision. Blocks until they decide.",
            inputSchema: { type: "object", properties: { header: { type: "string" }, question: { type: "string" }, options: { type: "array", items: { type: "object", properties: { label: { type: "string" }, description: { type: "string" } }, required: ["label"] } } }, required: ["header", "question", "options"] },
          },
        ],
      });
    if (msg.method === "tools/call") {
      asked = true;
      console.log("[mcp] ask_team args:", JSON.stringify(msg.params.arguments).slice(0, 200));
      return setTimeout(() => reply({ content: [{ type: "text", text: "The team chose: SQLite" }], isError: false }), 1500);
    }
    if (msg.method === "ping") return reply({});
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } }));
  });
});
await new Promise<void>((r) => mcp.listen(0, "127.0.0.1", r));
const mcpUrl = `http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`;

const child = spawn("gemini", ["--acp", "--model", process.env.GEMINI_CLI_MODEL ?? "gemini-3.8-flash"], { cwd, shell: process.platform === "win32", stdio: ["pipe", "pipe", "pipe"], env: process.env });
child.stderr.on("data", (d) => process.stderr.write(`[stderr] ${String(d).slice(0, 300)}`));
let nextId = 1;
const pending = new Map<number, (m: any) => void>();
const send = (m: object) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const request = (method: string, params: unknown) => new Promise<any>((res) => { const id = nextId++; pending.set(id, res); send({ id, method, params }); });

const permissions: string[] = [];
let text = "";
createInterface({ input: child.stdout }).on("line", (line) => {
  let m: any;
  try { m = JSON.parse(line); } catch { return console.log("[non-json]", line.slice(0, 200)); }
  if (m.id !== undefined && !m.method) { pending.get(m.id)?.(m); pending.delete(m.id); return; }
  if (m.id !== undefined && m.method) {
    console.log("[agent request]", m.method, JSON.stringify(m.params).slice(0, 400));
    if (m.method === "session/request_permission") {
      permissions.push(m.params.toolCall?.title ?? "?");
      const allow = m.params.options.find((o: any) => o.kind === "allow_once") ?? m.params.options[0];
      send({ id: m.id, result: { outcome: { outcome: "selected", optionId: allow.optionId } } });
    } else send({ id: m.id, error: { code: -32601, message: "not supported" } });
    return;
  }
  if (m.method === "session/update") {
    const u = m.params.update;
    if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") text += u.content.text;
    else console.log("[update]", u.sessionUpdate, (u.title ?? u.status ?? "").toString().slice(0, 120));
  }
});

const init = await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
console.log("initialize:", JSON.stringify(init.result ?? init.error).slice(0, 500));
if (init.result?.authMethods?.length && process.env.GEMINI_API_KEY) {
  const m = init.result.authMethods.find((a: any) => /api.?key/i.test(a.id));
  if (m) console.log("authenticate:", JSON.stringify((await request("authenticate", { methodId: m.id })).result ?? "error").slice(0, 200));
}
const sess = await request("session/new", { cwd, mcpServers: [{ type: "http", name: "colab", url: mcpUrl, headers: [] }] });
console.log("session/new:", JSON.stringify(sess.result ?? sess.error).slice(0, 600));
const sessionId = sess.result?.sessionId;
const turn = await Promise.race([
  request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Use the ask_team tool to ask 'Which database should we use?' with options PostgreSQL and SQLite. Then create db.txt containing only the chosen database name and reply in one sentence." }] }),
  new Promise((r) => setTimeout(() => r({ error: "timeout" }), 240_000)),
]);
console.log("session/prompt:", JSON.stringify((turn as any).result ?? (turn as any).error).slice(0, 300));
const db = existsSync(path.join(cwd, "db.txt")) ? readFileSync(path.join(cwd, "db.txt"), "utf8").trim() : "(missing)";
console.log("\nfinal text:", text.slice(-300), "\npermissions:", permissions, "\ndb.txt:", db);
const ok = asked && /sqlite/i.test(db);
console.log(ok ? "GEMINI CLI POC PASS" : "GEMINI CLI POC FAIL");
child.kill();
mcp.close();
process.exit(ok ? 0 : 1);
