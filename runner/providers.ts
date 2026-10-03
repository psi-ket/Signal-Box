/** Builds and discovers every agent type available on this machine. */
import type { ProviderId } from "../shared/protocol.ts";
import { claudeProvider } from "../server/agents/claude.ts";
import { codexProvider } from "../server/agents/codex.ts";
import { geminiProvider } from "../server/agents/gemini.ts";
import { geminiCliProvider } from "../server/agents/geminiCli.ts";
import { mockProvider } from "../server/agents/mock.ts";
import { openaiProvider } from "../server/agents/openai.ts";
import type { AgentProvider } from "../server/agents/types.ts";

export interface ProviderEnv {
  allowMock: boolean;
  claudeModel?: string;
  codexModel?: string;
  geminiCliModel?: string;
  geminiApiKey?: string;
  geminiModel: string;
  openaiApiKey?: string;
  openaiModel: string;
}

export function providerEnvFromProcess(allowMock: boolean): ProviderEnv {
  const e = process.env;
  return {
    allowMock,
    claudeModel: e.CLAUDE_MODEL || undefined,
    codexModel: e.CODEX_MODEL || undefined,
    geminiCliModel: e.GEMINI_CLI_MODEL || undefined,
    geminiApiKey: e.GEMINI_API_KEY || undefined,
    geminiModel: e.GEMINI_MODEL || "gemini-3.8-flash",
    openaiApiKey: e.OPENAI_API_KEY || undefined,
    openaiModel: e.OPENAI_MODEL || "gpt-5",
  };
}

export function buildProviders(env: ProviderEnv, overrides: Partial<Record<ProviderId, AgentProvider>> = {}): Record<ProviderId, AgentProvider> {
  return {
    claude: overrides.claude ?? claudeProvider({ model: env.claudeModel, apiKey: !!process.env.ANTHROPIC_API_KEY }),
    codex: overrides.codex ?? codexProvider({ model: env.codexModel }),
    "gemini-cli": overrides["gemini-cli"] ?? geminiCliProvider({ model: env.geminiCliModel }),
    "gemini-api": overrides["gemini-api"] ?? geminiProvider({ apiKey: env.geminiApiKey, model: env.geminiModel }),
    "openai-api": overrides["openai-api"] ?? openaiProvider({ apiKey: env.openaiApiKey, model: env.openaiModel }),
    mock: overrides.mock ?? mockProvider({ enabled: env.allowMock }),
  };
}

export async function discoverAll(providers: Record<string, AgentProvider>, onError?: (id: string, e: Error) => void) {
  await Promise.all(Object.values(providers).map((p) => p.discover?.().catch((e: Error) => onError?.(p.id, e))));
}
