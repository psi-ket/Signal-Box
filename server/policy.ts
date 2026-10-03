/**
 * Host permission policy for agent tool calls. Deny-by-default.
 *
 *  allow → run without a vote (routine reads/edits inside the worktree, allowlisted commands)
 *  ask   → a permission vote; a team "approve" can allow it, nothing else can
 *  deny  → refused outright; no vote can override it
 *
 * IMPORTANT: path checks confine the agent's *file tools*. A shell command is a separate
 * process with the host user's privileges; command classification here is best-effort
 * and is NOT an OS sandbox. Git worktrees are not a security boundary.
 */
import path from "node:path";

export type PolicyDecision = { decision: "allow" | "deny" | "ask"; reason: string };

const FILE_READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);
const FILE_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const ALWAYS_ALLOW = new Set(["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]);

/** Convert Git-Bash style paths (/c/Users/x) to native Windows paths on win32. */
export function toNativePath(p: string): string {
  if (process.platform === "win32") {
    const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
    if (m) return `${m[1]!.toUpperCase()}:${(m[2] ?? "/").replace(/\//g, "\\")}`;
  }
  return p;
}

/** Resolve `p` against `root` and return the repo-relative path, or null if it escapes root. */
export function resolveInside(root: string, p: string): string | null {
  if (typeof p !== "string" || p.includes("\0")) return null;
  const abs = path.resolve(root, toNativePath(p.trim() || "."));
  let rel = path.relative(root, abs);
  if (process.platform === "win32" && path.parse(abs).root.toLowerCase() !== path.parse(root).root.toLowerCase()) return null;
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  rel = rel.split(path.sep).join("/");
  return rel;
}

function touchesGitDir(rel: string) {
  return rel.split("/").some((seg) => seg.toLowerCase() === ".git");
}

// Matches at a command position: start of line or after a shell operator / xargs.
const AT_CMD = String.raw`(?:^|&&|\|\||[;|(]|\bxargs\s+)\s*`;
const cmdRe = (body: string) => new RegExp(AT_CMD + body, "i");

const DENY_PATTERNS: [RegExp, string][] = [
  [cmdRe(String.raw`(sudo|doas|runas)\b`), "privilege escalation"],
  [cmdRe(String.raw`rm\s+(-[a-z]*\s+)*-[a-z]*[rf]`), "recursive/forced delete"],
  [cmdRe(String.raw`(curl|wget|ssh|scp|sftp|nc|ncat|telnet|ftp|rsync|Invoke-WebRequest|iwr)\b`), "network access"],
  [cmdRe(String.raw`(chmod|chown|chgrp|mkfs|dd|shutdown|reboot|kill|pkill|killall|taskkill)\b`), "system modification"],
  [cmdRe(String.raw`git\s+(push|pull|fetch|clone|reset\s+--hard|clean|checkout\s+--|restore|worktree|remote|config|filter-branch|update-ref|gc|reflog)\b`), "git operation reserved for the host"],
  [cmdRe(String.raw`(printenv|env|set|export)(\s|$)`), "environment inspection"],
  [/\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)\w*/i, "secret expansion"],
  [cmdRe(String.raw`(powershell|pwsh|cmd(\.exe)?|bash|sh|zsh|eval|exec|source|\.)(\s|$)`), "nested shell"],
  [/`|\$\(/, "command substitution"],
  [/(^|\s)~(\/|\s|$)/, "home directory access"],
  [/\.\.[\\/]|(^|\s)\.\.(\s|$)/, "parent directory traversal"],
  [/\.env\b|id_rsa|\.ssh|\.aws|\.npmrc|credentials/i, "sensitive file"],
  // PowerShell (Codex and other CLIs use it on Windows)
  [/\$env:|\benv:\\?|\[Environment\]/i, "environment inspection"],
  [cmdRe(String.raw`(Invoke-Expression|iex|Invoke-Command|icm|Start-Process|saps|start|Invoke-RestMethod|irm|Start-BitsTransfer|Set-ExecutionPolicy|New-Service|Stop-Process|spps|Restart-Computer|Stop-Computer)\b`), "process, network or system control"],
  [cmdRe(String.raw`(Remove-Item|ri|del|rd|rmdir|erase)\b[^;|]*\s-(Recurse|r|Force)\b`), "recursive/forced delete"],
  [/\[(System\.)?Net\.|Net\.WebClient|System\.Diagnostics\.Process/i, ".NET network or process API"],
];

const ALLOWED_COMMANDS: Record<string, RegExp | true> = {
  ls: true,
  pwd: true,
  cat: true,
  head: true,
  tail: true,
  wc: true,
  grep: true,
  rg: true,
  echo: true,
  mkdir: true,
  touch: true,
  diff: true,
  sort: true,
  find: /^find\b(?!.*\s-(exec|execdir|delete|ok)\b)/,
  git: /^git\s+(status|diff|log|show|add|commit|branch|rev-parse|ls-files|blame|stash\s+list)\b/,
  node: /^node\s+(?!-e|--eval|-p|--print)/,
  npm: /^npm\s+(test|t|run\s+[\w:-]+)\b/,
  npx: /^npx\s+(tsc|vitest|jest|eslint|prettier)\b/,
  tsc: true,
  python: /^python3?\s+(-m\s+(pytest|unittest)\b|[\w./-]+\.py\b)/,
  python3: /^python3?\s+(-m\s+(pytest|unittest)\b|[\w./-]+\.py\b)/,
  pytest: true,
  cp: true,
  mv: true,
  // read-only PowerShell cmdlets and common aliases (lookup is case-insensitive)
  "get-content": true,
  gc: true,
  type: true,
  "get-childitem": true,
  gci: true,
  dir: true,
  "test-path": true,
  "select-string": true,
  sls: true,
  "get-location": true,
  "resolve-path": true,
  "get-item": true,
  "measure-object": true,
  "select-object": true,
  "sort-object": true,
  "format-table": true,
  "format-list": true,
  "out-string": true,
  "write-output": true,
  "write-host": true,
  "where-object": true,
  "foreach-object": /^foreach-object\s+\{[^}]*\}$/i,
  "new-item": /^new-item\b(?!.*-(ItemType\s+)?(SymbolicLink|Junction|HardLink))/i,
};

/** Normalizes the first word: lowercase, strip `.cmd`/`.exe` (npm.cmd → npm). */
function commandName(seg: string): string {
  return (seg.split(/\s+/)[0] ?? "").toLowerCase().replace(/\.(cmd|exe|bat|ps1)$/, "");
}

const ABS_PATH_TOKEN = /(?:^|[\s'"=])((?:[a-zA-Z]:[\\/]|\/)[^\s'"]*)/g;

/**
 * CLI agents wrap commands in a shell invocation, e.g. Codex on Windows sends
 * `"C:\...\pwsh.exe" -Command 'git status'`. Returns the inner command so the policy
 * judges what actually runs. Unrecognized shapes are returned unchanged.
 */
export function unwrapShellCommand(cmd: string): string {
  const m = /^\s*"?(?:[^"\s]*[\\/])?(pwsh|powershell|bash|sh|zsh|cmd)(?:\.exe)?"?\s+(?:-NoProfile\s+|-NoLogo\s+|-l\s+|-lc\s+)*(?:-Command|-c|\/c|-lc)\s+([\s\S]+)$/i.exec(cmd);
  if (!m) return cmd;
  let inner = m[2]!.trim();
  const q = inner[0];
  if ((q === "'" || q === '"') && inner.endsWith(q)) {
    inner = inner.slice(1, -1);
    if (q === "'") inner = inner.replaceAll("''", "'");
  }
  return inner;
}

export function classifyCommand(command: string, worktree: string): PolicyDecision {
  const cmd = command.trim();
  if (!cmd) return { decision: "deny", reason: "empty command" };
  if (cmd.length > 2000) return { decision: "deny", reason: "command too long" };
  for (const [re, why] of DENY_PATTERNS) if (re.test(cmd)) return { decision: "deny", reason: `blocked: ${why}` };

  for (const m of cmd.matchAll(ABS_PATH_TOKEN)) {
    const p = m[1]!;
    if (p === "/dev/null") continue;
    if (resolveInside(worktree, p) === null) return { decision: "deny", reason: `blocked: path outside worktree (${p})` };
  }

  // Auto-run only when every segment of a chain/pipeline is allowlisted and the only
  // redirects are harmless ones (2>&1, >/dev/null). Anything else needs team approval.
  const parsed = splitShell(cmd);
  if (parsed) {
    const allAllowed = parsed.every((seg) => {
      const name = commandName(seg);
      const rule = ALLOWED_COMMANDS[name];
      const normalized = seg.replace(/^\S+/, name);
      return rule === true || (rule instanceof RegExp && rule.test(normalized));
    });
    if (allAllowed) return { decision: "allow", reason: "allowlisted command" };
  }
  return { decision: "ask", reason: "command is not on the allowlist" };
}

const HARMLESS_REDIRECT = /^(?:[12&]?>\s*\/dev\/null|2>&1)/;

/**
 * Quote-aware split of a command into segments on unquoted &&, ||, ;, | and newlines.
 * Harmless redirects are removed. Returns null if the command has other redirects,
 * background `&`, or unbalanced quotes, so it can't auto-run.
 */
export function splitShell(cmd: string): string[] | null {
  const segs: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote) {
      if (c === "\\" && quote === '"') {
        cur += c + (cmd[++i] ?? "");
        continue;
      }
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "\\") {
      cur += c + (cmd[++i] ?? "");
      continue;
    }
    const rest = cmd.slice(i);
    const redirect = HARMLESS_REDIRECT.exec(rest);
    if ((c === ">" || /^[12&]>/.test(rest)) && redirect) {
      i += redirect[0].length - 1;
      continue;
    }
    if (c === ">" || c === "<") return null;
    if (rest.startsWith("&&") || rest.startsWith("||")) {
      segs.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (c === "&") return null; // background job
    if (c === ";" || c === "|" || c === "\n") {
      segs.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (quote) return null;
  segs.push(cur);
  const out = segs.map((s) => s.trim()).filter(Boolean);
  return out.length ? out : null;
}

export function evaluateTool(toolName: string, input: Record<string, unknown>, worktree: string): PolicyDecision {
  if (ALWAYS_ALLOW.has(toolName)) return { decision: "allow", reason: "bookkeeping tool" };

  if (FILE_READ_TOOLS.has(toolName) || FILE_WRITE_TOOLS.has(toolName)) {
    const raw = (input.file_path ?? input.notebook_path ?? input.path ?? ".") as unknown;
    if (typeof raw !== "string") return { decision: "deny", reason: "missing path" };
    const rel = resolveInside(worktree, raw);
    if (rel === null) return { decision: "deny", reason: `path outside the session worktree: ${raw}` };
    if (touchesGitDir(rel)) return { decision: "deny", reason: "the .git directory is reserved for the host" };
    if (/(^|\/)\.env(\.|$)/.test(rel) && !rel.endsWith(".env.example")) return { decision: "deny", reason: "env files may hold secrets" };
    return { decision: "allow", reason: FILE_WRITE_TOOLS.has(toolName) ? "edit inside worktree" : "read inside worktree" };
  }

  if (toolName === "Bash") {
    const command = input.command;
    if (typeof command !== "string") return { decision: "deny", reason: "missing command" };
    if (input.run_in_background === true) return { decision: "deny", reason: "background processes are not allowed" };
    return classifyCommand(command, worktree);
  }

  if (toolName.startsWith("mcp__")) return { decision: "deny", reason: "MCP tools are disabled" };
  return { decision: "deny", reason: `tool ${toolName} is not permitted in team sessions` };
}

/** One-line description of a tool call for the UI. Never includes host-absolute paths. */
export function summarizeTool(toolName: string, input: Record<string, unknown>, worktree: string): string {
  const rel = (p: unknown) => (typeof p === "string" ? resolveInside(worktree, p) ?? "<outside worktree>" : "");
  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      return rel(input.file_path);
    case "NotebookEdit":
      return rel(input.notebook_path);
    case "Glob":
    case "Grep":
      return `${String(input.pattern ?? "")}${input.path ? ` in ${rel(input.path)}` : ""}`;
    case "Bash":
      return String(input.command ?? "").replaceAll(worktree, ".").slice(0, 300);
    case "AskUserQuestion":
      return "asking the team";
    default:
      return "";
  }
}
