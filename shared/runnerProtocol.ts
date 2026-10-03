/**
 * Hub <-> runner protocol. A runner is a process on a teammate's machine that clones the
 * room's Git URL, runs that teammate's agents locally, and streams everything to the hub.
 * The hub never executes agent code. Runners connect to /runner with subprotocols
 * ["colab.runner.v1", "token.<runnerToken>"].
 */
import { z } from "zod";
import { KeyVendor, ModelId, ProviderId, ProviderInfo } from "./protocol.ts";

export const RUNNER_SUBPROTOCOL = "colab.runner.v1";
export const TOKEN_PREFIX = "token.";
export const MAX_RUNNER_MESSAGE_BYTES = 4 * 1024 * 1024;
export const MAX_PATCH_BYTES = 2 * 1024 * 1024;

const id = z.string().min(1).max(64);

export const AgentEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text_start"), id }),
  z.object({ type: z.literal("text_delta"), id, text: z.string().max(100_000) }),
  z.object({ type: z.literal("text_end"), id, text: z.string().max(200_000) }),
  z.object({
    type: z.literal("tool_call"),
    id: z.string().min(1).max(200),
    tool: z.string().max(100),
    /** One-line description computed on the runner (no host paths). */
    summary: z.string().max(500),
    /** Repo-relative file the call edits, if any. */
    file: z.object({ path: z.string().max(1000), action: z.enum(["edit", "write", "delete"]) }).nullable(),
    isTest: z.boolean(),
  }),
  z.object({ type: z.literal("tool_result"), id: z.string().min(1).max(200), ok: z.boolean(), output: z.string().max(20_000) }),
  z.object({ type: z.literal("turn_end"), ok: z.boolean(), costUsd: z.number().optional(), error: z.string().max(2000).optional() }),
  z.object({ type: z.literal("log"), level: z.enum(["info", "warn", "error"]), message: z.string().max(2000) }),
]);

const TeamQuestionSchema = z.object({
  header: z.string().max(200),
  question: z.string().max(2000),
  options: z.array(z.object({ label: z.string().max(200), description: z.string().max(1000).optional() })).max(10),
  multiSelect: z.boolean().optional(),
});

export const FileChangeSchema = z.object({ path: z.string().max(1000), status: z.string().max(10) });

// ---------- runner -> hub ----------

export const RunnerToHub = z.discriminatedUnion("type", [
  z.object({ type: z.literal("runner.hello"), name: z.string().trim().min(1).max(60), version: z.string().max(30), platform: z.string().max(30), providers: z.array(ProviderInfo) }),
  z.object({ type: z.literal("runner.providers"), providers: z.array(ProviderInfo) }),
  z.object({ type: z.literal("runner.event"), sessionId: id, event: AgentEventSchema }),
  z.object({ type: z.literal("runner.session"), sessionId: id, status: z.enum(["running", "failed", "exited"]), error: z.string().max(2000).optional() }),
  z.object({ type: z.literal("runner.ask"), requestId: id, sessionId: id, questions: z.array(TeamQuestionSchema).min(1).max(4) }),
  z.object({ type: z.literal("runner.authorize"), requestId: id, sessionId: id, tool: z.string().max(100), summary: z.string().max(500), reason: z.string().max(300) }),
  z.object({
    type: z.literal("runner.drift"),
    sessionId: id,
    baseSha: z.string().regex(/^[0-9a-f]{40,64}$/),
    files: z.array(FileChangeSchema).max(5000),
    /** base64 of `git diff --binary <baseSha> <snapshot>`; null if too large. */
    patch: z.string().nullable(),
    commits: z.number().int().min(0),
  }),
  z.object({ type: z.literal("runner.drift_error"), sessionId: id, error: z.string().max(500) }),
  z.object({
    type: z.literal("runner.keys"),
    forParticipant: id,
    keys: z.array(z.object({ vendor: KeyVendor, masked: z.string().max(20), models: z.array(z.object({ id: z.string(), label: z.string() })).max(500), checkedAt: z.number() })),
    last: z.object({ vendor: KeyVendor, ok: z.boolean(), error: z.string().max(300).nullable() }).nullable(),
  }),
]);
export type RunnerToHub = z.infer<typeof RunnerToHub>;

// ---------- hub -> runner ----------

export type HubToRunner =
  | { type: "runner.welcome"; runnerId: string; owner: { id: string; name: string } | null; shared: boolean }
  | {
      type: "runner.start";
      sessionId: string;
      roomId: string;
      gitUrl: string;
      baseRef: string;
      branch: string;
      title: string;
      task: string;
      provider: ProviderId;
      model?: string;
      ownKeyFor?: string; // participant whose stored key to use
    }
  | { type: "runner.prompt"; sessionId: string; text: string }
  | { type: "runner.stop"; sessionId: string }
  | { type: "runner.answer"; requestId: string; ok: true; answers?: { label: string | null; note: string }[]; allow?: boolean; message?: string }
  | { type: "runner.answer"; requestId: string; ok: false; reason: "rejected" | "cancelled"; message: string }
  | { type: "runner.key.set"; forParticipant: string; vendor: KeyVendor; apiKey: string }
  | { type: "runner.key.clear"; forParticipant: string; vendor: KeyVendor }
  | { type: "runner.keys.request"; forParticipant: string }
  | { type: "runner.room.closed"; roomId: string }
  | { type: "runner.error"; message: string };

export type WireAgentEvent = z.infer<typeof AgentEventSchema>;
export const ModelIdSchema = ModelId;
