/**
 * Live proof of concept for the Codex CLI app-server protocol (codex-cli 0.15x):
 * dynamic `ask_team` tool, command/file approval interception, streaming, model list.
 *   npx tsx scripts/poc-codex.ts
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { execFileSync } from "node:child_process";

const cwd = mkdtempSync(path.join(tmpdir(), "colab-codex-poc-"));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
writeFileSync(path.join(cwd, "README.md"), "# Todo\n");
execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd });
execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd });

const child = spawn("codex", ["app-server"], { cwd, shell: process.platform === "win32", stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (d) => process.stderr.write(`[stderr] ${String(d).slice(0, 300)}`));
let nextId = 1;
const pending = new Map<number, (r: { result?: unknown; error?: unknown }) => void>();
const send = (m: object) => child.stdin.write(JSON.stringify(m) + "\n");
const request = (method: string, params: unknown) =>
  new Promise<{ result?: any; error?: any }>((res) => {
    const id = nextId++;
    pending.set(id, res);
    send({ id, method, params });
  });

let asked = false;
let approvals: string[] = [];
let text = "";
let turnDone: (() => void) | null = null;

createInterface({ input: child.stdout }).on("line", (line) => {
  let m: any;
  try {
    m = JSON.parse(line);
  } catch {
    return console.log("[non-json]", line.slice(0, 200));
  }
  if (m.id !== undefined && m.method === undefined) {
    pending.get(m.id)?.(m);
    pending.delete(m.id);
    return;
  }
  if (m.id !== undefined && m.method) {
    // server -> client request
    console.log("[server request]", m.method, JSON.stringify(m.params).slice(0, 300));
    if (m.method === "item/tool/call") {
      asked = true;
      const args = m.params.arguments;
      const pick = (args.options ?? []).find((o: any) => /sqlite/i.test(o.label ?? o))?.label ?? "SQLite";
      setTimeout(() => send({ id: m.id, result: { success: true, contentItems: [{ type: "inputText", text: `The team chose: ${pick}` }] } }), 1500);
    } else if (m.method === "item/commandExecution/requestApproval" || m.method === "item/fileChange/requestApproval") {
      approvals.push(`${m.method}: ${m.params.command ?? m.params.reason ?? ""}`);
      send({ id: m.id, result: { decision: "accept" } });
    } else if (m.method === "item/tool/requestUserInput") {
      send({ id: m.id, result: { answers: {} } });
    } else {
      send({ id: m.id, error: { code: -32601, message: "not supported" } });
    }
    return;
  }
  // notifications
  if (m.method === "item/agentMessage/delta") text += m.params.delta ?? "";
  if (m.method === "item/started" || m.method === "item/completed") console.log(`[${m.method}]`, m.params.item?.type, (m.params.item?.command ?? m.params.item?.tool ?? "").toString().slice(0, 120));
  if (m.method === "turn/completed") {
    console.log("[turn/completed]", JSON.stringify(m.params.turn?.status ?? m.params).slice(0, 200));
    turnDone?.();
  }
  if (m.method === "error") console.log("[error]", JSON.stringify(m.params).slice(0, 300));
});

const init = await request("initialize", { clientInfo: { name: "colab", title: "Signal Box", version: "0.1.0" }, capabilities: { experimentalApi: true } });
console.log("initialize:", JSON.stringify(init.result ?? init.error).slice(0, 200));
send({ method: "initialized" });
const models = await request("model/list", {});
console.log("models:", JSON.stringify(models.result ?? models.error).slice(0, 600));

const thread = await request("thread/start", {
  cwd,
  approvalPolicy: "untrusted",
  sandbox: "workspace-write",
  ephemeral: true,
  developerInstructions: "When the team must decide something, call the ask_team tool. Never ask in plain text.",
  dynamicTools: [
    {
      type: "function",
      name: "ask_team",
      description: "Ask the supervising team to vote on a decision. Blocks until they decide.",
      inputSchema: {
        type: "object",
        properties: {
          header: { type: "string" },
          question: { type: "string" },
          options: { type: "array", items: { type: "object", properties: { label: { type: "string" }, description: { type: "string" } }, required: ["label"] } },
        },
        required: ["header", "question", "options"],
      },
    },
  ],
});
console.log("thread/start:", JSON.stringify(thread.result ?? thread.error).slice(0, 300));
const threadId = thread.result?.thread?.id;
const done = new Promise<void>((r) => (turnDone = r));
const turn = await request("turn/start", {
  threadId,
  input: [{ type: "text", text: "Use the ask_team tool to ask 'Which database should we use?' with options PostgreSQL and SQLite. Then create db.txt containing only the chosen database name, run `git status`, and reply in one sentence.", text_elements: [] }],
});
console.log("turn/start:", JSON.stringify(turn.result ?? turn.error).slice(0, 200));
await Promise.race([done, new Promise((r) => setTimeout(r, 240_000))]);
const db = existsSync(path.join(cwd, "db.txt")) ? readFileSync(path.join(cwd, "db.txt"), "utf8").trim() : "(missing)";
console.log("\nfinal text:", text.slice(-300));
console.log("approvals:", approvals);
console.log("db.txt:", db);
const ok = asked && /sqlite/i.test(db);
console.log(ok ? "CODEX POC PASS" : "CODEX POC FAIL");
child.kill();
process.exit(ok ? 0 : 1);
