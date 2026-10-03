/**
 * Newline-delimited JSON-RPC over a child process's stdio, used by the Codex app-server
 * and Gemini CLI (ACP) adapters. Handles requests in both directions and notifications.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

export class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

export interface StdioRpcOptions {
  /** Include `"jsonrpc": "2.0"` on outgoing messages (ACP requires it; Codex omits it). */
  jsonrpc: boolean;
  onNotification(method: string, params: any): void;
  /** Answer a request from the agent. Throw RpcError to reply with an error. */
  onRequest(method: string, params: any): Promise<unknown>;
  onStderr?(line: string): void;
}

// Secrets never passed to agent processes unless the adapter keeps one explicitly.
const SECRET_ENV = /^(COLAB_.*|GEMINI_API_KEY|GOOGLE_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)$/;

/**
 * Spawns a CLI agent. On Windows the npm shims (codex.cmd, gemini.cmd) need a shell, so the
 * command line is built from a fixed program name and pre-validated arguments only.
 */
export function spawnAgent(program: string, args: string[], cwd: string, opts: { keepEnv?: string[]; env?: Record<string, string> } = {}): ChildProcess {
  for (const a of args) if (!/^[\w.:/=@-]+$/.test(a)) throw new Error(`unsafe argument for ${program}: ${a}`);
  const env: Record<string, string> = {};
  const keep = new Set(opts.keepEnv ?? []);
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && (keep.has(k) || !SECRET_ENV.test(k))) env[k] = v;
  Object.assign(env, opts.env);
  const so = { cwd, env, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"], windowsHide: true };
  return process.platform === "win32" ? spawn([program, ...args].join(" "), { ...so, shell: true }) : spawn(program, args, so);
}

/** Kills the whole process tree (shell + CLI + its children). */
export function killTree(child: ChildProcess) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  else child.kill("SIGTERM");
}

export class StdioRpc {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private closed = false;
  readonly exited: Promise<number | null>;

  constructor(
    private child: ChildProcess,
    private opts: StdioRpcOptions,
  ) {
    this.exited = new Promise((r) => child.on("exit", (code) => r(code)));
    void this.exited.then((code) => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error(`agent process exited (${code})`));
      this.pending.clear();
    });
    child.on("error", (e) => opts.onStderr?.(`spawn error: ${e.message}`));
    createInterface({ input: child.stdout! }).on("line", (line) => this.onLine(line));
    if (child.stderr) createInterface({ input: child.stderr }).on("line", (l) => opts.onStderr?.(l));
  }

  private write(msg: object) {
    if (this.closed || !this.child.stdin?.writable) return;
    this.child.stdin.write(JSON.stringify(this.opts.jsonrpc ? { jsonrpc: "2.0", ...msg } : msg) + "\n");
  }

  private onLine(line: string) {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      this.opts.onStderr?.(`non-JSON stdout: ${line.slice(0, 200)}`);
      return;
    }
    if (m.id !== undefined && m.method === undefined) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (!p) return;
      if (m.error) p.reject(new RpcError(m.error.code ?? -1, m.error.message ?? "error"));
      else p.resolve(m.result);
      return;
    }
    if (m.id !== undefined && m.method) {
      this.opts.onRequest(m.method, m.params).then(
        (result) => this.write({ id: m.id, result }),
        (e: Error) => this.write({ id: m.id, error: { code: e instanceof RpcError ? e.code : -32603, message: e.message } }),
      );
      return;
    }
    if (m.method) this.opts.onNotification(m.method, m.params);
  }

  request<T = any>(method: string, params: unknown, timeoutMs = 120_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error("agent process is not running"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(t), resolve(v)),
        reject: (e) => (clearTimeout(t), reject(e)),
      });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown) {
    this.write(params === undefined ? { method } : { method, params });
  }

  kill() {
    killTree(this.child);
  }
}
