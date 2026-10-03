/**
 * Host-executed file and shell tools for providers without a built-in tool runtime
 * (Gemini, mock). Every call is authorized through the same host policy as Claude's
 * tools, using Claude-equivalent tool names (Read/Write/Edit/Glob/Bash).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveInside } from "../policy.ts";
import type { AgentHooks } from "./types.ts";

const MAX_READ = 100_000;
const MAX_OUTPUT = 8_000;
const COMMAND_TIMEOUT_MS = 120_000;
const SECRET_ENV = /^(COLAB_|GEMINI_|GOOGLE_API|ANTHROPIC_|CLAUDE_CODE_OAUTH)/;

export interface ToolResult {
  ok: boolean;
  output: string;
}

function findShell(): { file: string; args: (cmd: string) => string[] } {
  if (process.env.COLAB_SHELL) return { file: process.env.COLAB_SHELL, args: (c) => ["-c", c] };
  if (process.platform !== "win32") return { file: "/bin/sh", args: (c) => ["-c", c] };
  for (const p of ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"])
    if (existsSync(p)) return { file: p, args: (c) => ["-c", c] };
  return { file: "cmd.exe", args: (c) => ["/d", "/s", "/c", c] };
}

export class LocalTools {
  constructor(
    private root: string,
    private hooks: AgentHooks,
  ) {}

  private abs(rel: string): string | null {
    const r = resolveInside(this.root, rel);
    return r === null ? null : path.join(this.root, r);
  }

  private async authorize(tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<string | null> {
    const p = await this.hooks.authorizeTool(tool, input, signal);
    return p.allow ? null : p.message;
  }

  async listFiles(dir: string, signal: AbortSignal): Promise<ToolResult> {
    const denied = await this.authorize("Glob", { path: dir || "." }, signal);
    if (denied) return { ok: false, output: denied };
    const base = this.abs(dir || ".");
    if (!base) return { ok: false, output: "path outside worktree" };
    const out: string[] = [];
    const walk = async (d: string, depth: number) => {
      if (out.length > 500 || depth > 6) return;
      for (const e of await readdir(d, { withFileTypes: true })) {
        if (e.name === ".git" || e.name === "node_modules") continue;
        const full = path.join(d, e.name);
        const rel = path.relative(this.root, full).split(path.sep).join("/");
        if (e.isDirectory()) await walk(full, depth + 1);
        else out.push(rel);
      }
    };
    await walk(base, 0);
    return { ok: true, output: out.join("\n") || "(empty)" };
  }

  async readFile(rel: string, signal: AbortSignal): Promise<ToolResult> {
    const denied = await this.authorize("Read", { file_path: rel }, signal);
    if (denied) return { ok: false, output: denied };
    const file = this.abs(rel)!;
    try {
      return { ok: true, output: (await readFile(file, "utf8")).slice(0, MAX_READ) };
    } catch (e) {
      return { ok: false, output: (e as Error).message.replaceAll(this.root, ".") };
    }
  }

  async writeFile(rel: string, content: string, signal: AbortSignal): Promise<ToolResult> {
    const denied = await this.authorize("Write", { file_path: rel, content }, signal);
    if (denied) return { ok: false, output: denied };
    const file = this.abs(rel)!;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
    return { ok: true, output: `wrote ${rel} (${content.length} chars)` };
  }

  async editFile(rel: string, oldString: string, newString: string, signal: AbortSignal): Promise<ToolResult> {
    const denied = await this.authorize("Edit", { file_path: rel, old_string: oldString, new_string: newString }, signal);
    if (denied) return { ok: false, output: denied };
    const file = this.abs(rel)!;
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (e) {
      return { ok: false, output: (e as Error).message.replaceAll(this.root, ".") };
    }
    const count = text.split(oldString).length - 1;
    if (count !== 1) return { ok: false, output: `old_string must match exactly once (matched ${count} times)` };
    await writeFile(file, text.replace(oldString, () => newString));
    return { ok: true, output: `edited ${rel}` };
  }

  async runCommand(command: string, signal: AbortSignal): Promise<ToolResult> {
    const denied = await this.authorize("Bash", { command }, signal);
    if (denied) return { ok: false, output: denied };
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !SECRET_ENV.test(k)) env[k] = v;
    const shell = findShell();
    return new Promise((resolve) => {
      const child = spawn(shell.file, shell.args(command), { cwd: this.root, env, windowsHide: true, signal, timeout: COMMAND_TIMEOUT_MS });
      let out = "";
      const add = (d: Buffer) => {
        if (out.length < MAX_OUTPUT * 2) out += d.toString();
      };
      child.stdout.on("data", add);
      child.stderr.on("data", add);
      child.on("error", (e) => resolve({ ok: false, output: e.message }));
      child.on("close", (code) => {
        const text = out.replaceAll(this.root, ".").slice(-MAX_OUTPUT);
        resolve({ ok: code === 0, output: `${text}\n[exit ${code}]`.trim() });
      });
    });
  }
}
