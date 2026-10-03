/**
 * Live proof of concept: start one real Claude agent, intercept its AskUserQuestion
 * call in canUseTool, pause, inject a simulated human decision, and verify the agent
 * resumes and acts on that decision. Exits non-zero if any step fails.
 *   npx tsx scripts/poc-ask.ts
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cwd = mkdtempSync(join(tmpdir(), "colab-poc-"));
let intercepted: Record<string, unknown> | null = null;
let finalText = "";

const q = query({
  prompt:
    "We need to pick a database for a tiny todo app. You MUST use the AskUserQuestion tool to ask the team " +
    "'Which database should we use?' with exactly two options: 'PostgreSQL' and 'SQLite'. " +
    "After you get the answer, reply with one sentence that names the chosen database. Do not use any other tools.",
  options: {
    cwd,
    permissionMode: "default",
    allowedTools: [],
    maxTurns: 4,
    settingSources: [],
    canUseTool: async (toolName, input, opts) => {
      console.log(`[canUseTool] ${toolName} toolUseID=${opts.toolUseID}`);
      if (toolName !== "AskUserQuestion") return { behavior: "deny", message: "Only AskUserQuestion is permitted in this PoC." };
      intercepted = input;
      const questions = (input as { questions: { question: string; options: { label: string }[] }[] }).questions;
      console.log("[paused] question:", JSON.stringify(questions));
      await new Promise((r) => setTimeout(r, 2000)); // simulated human deliberation
      const answers: Record<string, string> = {};
      for (const qn of questions) answers[qn.question] = qn.options.find((o) => /sqlite/i.test(o.label))?.label ?? qn.options[0]!.label;
      console.log("[decision]", answers);
      return { behavior: "allow", updatedInput: { ...input, answers } };
    },
  },
});

for await (const msg of q) {
  if (msg.type === "assistant") {
    for (const b of msg.message.content) {
      if (b.type === "text") { console.log("[assistant]", b.text); finalText += b.text; }
      if (b.type === "tool_use") console.log("[tool_use]", b.name);
    }
  } else if (msg.type === "user") {
    const c = msg.message.content;
    if (Array.isArray(c)) for (const b of c) if (b.type === "tool_result") console.log("[tool_result]", JSON.stringify(b.content).slice(0, 300));
  } else if (msg.type === "result") {
    console.log("[result]", msg.subtype, "is_error=", msg.is_error);
  }
}

const ok = intercepted !== null && /sqlite/i.test(finalText);
console.log(ok ? "POC PASS: question intercepted, decision injected, agent resumed with SQLite" : "POC FAIL");
process.exit(ok ? 0 : 1);
