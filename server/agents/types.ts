/**
 * Provider-neutral agent adapter contract. SDK-specific code lives only in the adapters.
 */
import type { ProviderId, ProviderInfo } from "../../shared/protocol.ts";

export type AgentEvent =
  | { type: "text_start"; id: string }
  | { type: "text_delta"; id: string; text: string }
  | { type: "text_end"; id: string; text: string }
  | { type: "tool_call"; id: string; tool: string; input: Record<string, unknown> }
  | { type: "tool_result"; id: string; ok: boolean; output: string }
  | { type: "turn_end"; ok: boolean; costUsd?: number; error?: string }
  | { type: "log"; level: "info" | "warn" | "error"; message: string };

export interface TeamQuestion {
  header: string;
  question: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

/** Per question: the team's chosen label, or null when no decision was reached (fallback). */
export type TeamAnswer = { label: string | null; note: string };

export type ToolPermission = { allow: true } | { allow: false; message: string };

export interface AgentHooks {
  emit(ev: AgentEvent): void;
  /** Blocks until the team decides. Throws QuestionRejected for malformed questions. */
  askTeam(questions: TeamQuestion[], signal: AbortSignal): Promise<TeamAnswer[]>;
  /** Host policy + optional permission vote. Never resolves `allow` for a policy-denied call. */
  authorizeTool(toolName: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ToolPermission>;
}

export class QuestionRejected extends Error {}

export interface AgentStartOptions {
  sessionId: string;
  cwd: string;
  task: string;
  systemPrompt: string;
  /** Model id chosen for this session; undefined means the provider default. */
  model?: string;
  /** Loopback URL of this session's MCP endpoint (serves ask_team), for CLI agents. */
  mcpUrl?: string;
  /** A participant's own API key for this session (overrides the host's auth). */
  apiKey?: string;
  hooks: AgentHooks;
}

export interface AgentHandle {
  /** Queue a follow-up prompt from the owner. */
  send(text: string): void;
  /** Stop the agent; pending tool permissions are denied. */
  cancel(): Promise<void>;
  /** Resolves when the agent process has fully exited. */
  done: Promise<void>;
}

export interface AgentProvider {
  id: ProviderId;
  /** Current availability, auth mode and models (cached; see discover). */
  info(): ProviderInfo;
  /** Optional async discovery of availability and models at startup. Never throws. */
  discover?(): Promise<void>;
  start(opts: AgentStartOptions): AgentHandle;
}

/** Validates a requested model against the provider list; custom ids allowed when the list is empty. */
export function resolveModel(info: ProviderInfo, requested: string | undefined): string | undefined {
  if (!requested) return info.defaultModel ?? undefined;
  if (info.models.length === 0 || info.models.some((m) => m.id === requested)) return requested;
  throw new Error(`model ${requested} is not available for ${info.label}`);
}

export const TEAM_SYSTEM_PROMPT = `You are one of several coding agents working in parallel on the same repository. A team of humans supervises you live.

Team decisions:
- When you face a genuine decision that needs team input (architecture, technology or library choice, ambiguous requirements, trade-offs with no clear winner), you MUST ask with the {{ASK_TOOL}} tool. Offer 2-4 distinct options.
- Never ask questions in plain text, and never use {{ASK_TOOL}} for progress updates or routine choices you can make yourself.
- Follow the team's answer. If the answer says no decision was reached, choose the most reversible option and state that assumption in your final message.

Workspace rules:
- Work only inside the current directory, which is your own git worktree on your own branch. Never touch paths outside it.
- Do not use the network, do not inspect environment variables, and do not run background processes.
- Some tool calls are blocked by the host's security policy or need team approval. If a call is denied, adapt instead of retrying the same call.
- When a coherent step is complete, commit it with git on your current branch.
- Keep your messages short and concrete.`;
