/**
 * LIVE end-to-end check with real agents (uses your logins / API quota), in the real
 * topology: a hub, three accounts, and one personal runner per account. Each runner clones
 * the fixture repo, runs its owner's agent locally, and streams to the hub.
 *   npm run live:e2e [-- --provider claude|codex|gemini-cli|gemini-api|openai-api] [--model id] [--own-key]
 * --own-key: each participant registers the vendor key from .env as their own key on their
 * runner, and the runner's env copy of that key is removed.
 * Exits non-zero if any acceptance check fails.
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../server/app.ts";
import { loadConfig } from "../server/config.ts";
import { createLogger } from "../server/log.ts";
import { RunnerCore } from "../runner/core.ts";
import { buildProviders, discoverAll, providerEnvFromProcess } from "../runner/providers.ts";
import { DEMO_TASKS } from "../shared/demoTasks.ts";
import type { ProviderId, VoteView } from "../shared/protocol.ts";
import { apiCall, register } from "../test/helpers.ts";
import { TestClient } from "../test/wsClient.ts";
import { createFixture } from "./setup-demo.ts";

const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const PROVIDER = (arg("--provider") ?? "claude") as ProviderId;
const MODEL = arg("--model");
const OWN_KEY = process.argv.includes("--own-key");
const TIMEOUT = 8 * 60_000;
const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${m}`);
const checks: [string, boolean][] = [];
const check = (name: string, ok: boolean) => {
  checks.push([name, ok]);
  log(`${ok ? "PASS" : "FAIL"} ${name}`);
};

const VENDOR_ENV: Record<string, string> = { claude: "ANTHROPIC_API_KEY", "gemini-api": "GEMINI_API_KEY", "gemini-cli": "GEMINI_API_KEY", "openai-api": "OPENAI_API_KEY" };
const VENDOR: Record<string, "anthropic" | "gemini" | "openai"> = { claude: "anthropic", "gemini-api": "gemini", "gemini-cli": "gemini", "openai-api": "openai" };

async function main() {
  const quiet = createLogger({}, (l) => void (process.env.LIVE_DEBUG && process.stderr.write(l + "\n")));
  const repo = path.join(await mkdtemp(path.join(tmpdir(), "colab-live-")), "todo-app");
  await createFixture(repo);
  const base = loadConfig(["--port", "0"]);
  const dataDir = await mkdtemp(path.join(tmpdir(), "colab-live-data-"));
  const app = await createApp({ config: { ...base, dataDir, dbFile: path.join(dataDir, "db.sqlite"), allowLocalRepos: true, hostRunner: false, voteMs: 30_000 }, log: quiet });
  const port = await app.listen();
  log(`hub on :${port}, fixture ${repo}`);

  let ownKey = "";
  if (OWN_KEY) {
    ownKey = process.env[VENDOR_ENV[PROVIDER] ?? ""] ?? "";
    if (!ownKey) throw new Error(`--own-key needs ${VENDOR_ENV[PROVIDER]} in .env to play the participant key`);
    delete process.env[VENDOR_ENV[PROVIDER]!];
    if (VENDOR[PROVIDER] === "gemini") delete process.env.GOOGLE_API_KEY;
    log(`own-key mode: runners have no ${VENDOR_ENV[PROVIDER]}; participants bring it`);
  }

  // One provider set (discovery once); each runner gets its own clone directory.
  const providers = buildProviders(providerEnvFromProcess(false));
  await discoverAll(providers);
  const info = providers[PROVIDER].info();
  log(`agent ${info.label}: ${info.available ? `${info.auth}, default model ${info.defaultModel}` : `not set up on the runner (${info.note})`}`);
  if (!info.available && !(OWN_KEY && info.byoReady)) process.exit(2);

  const names = ["ana", "bob", "cara"];
  const people: TestClient[] = [];
  const runners: RunnerCore[] = [];
  for (const n of names) {
    const cookie = await register(port, n);
    const tok = await apiCall(port, cookie, "POST", "/api/runners", { name: `${n}-machine` });
    const r = new RunnerCore({ hubUrl: `http://127.0.0.1:${port}`, token: tok.body.token, name: `${n}-machine`, dataDir: await mkdtemp(path.join(tmpdir(), `colab-live-${n}-`)), providers, allowLocalRepos: true, log: quiet });
    r.start();
    runners.push(r);
    const c = await TestClient.connect(port, cookie);
    await c.waitFor((m) => m.type === "runners" && m.payload.runners.some((x) => x.name === `${n}-machine`));
    people.push(c);
  }
  const [ana, bob, cara] = people as [TestClient, TestClient, TestClient];
  log("3 accounts, each with a personal runner online");

  const room = await ana.createRoom({ name: "live", gitUrl: repo, password: "pw", maxPeople: 8, defaultRole: "editor" });
  const roomId = room.payload.roomId;
  for (const p of [bob, cara]) if ((await p.joinRoom(roomId, "pw")).type !== "welcome") throw new Error("join failed");

  if (OWN_KEY) {
    for (const p of people) {
      const ok = p.next((m) => m.type === "keys" && !!m.payload.last);
      p.send("key.set", { vendor: VENDOR[PROVIDER]!, apiKey: ownKey });
      const r = await ok;
      if (r.type !== "keys" || !r.payload.last?.ok) throw new Error(`key check failed: ${JSON.stringify(r.payload)}`);
    }
    log("all three participants verified their own key on their runner");
  }

  DEMO_TASKS.forEach((d, i) => people[i]!.send("session.create", { title: d.title, task: d.prompt, provider: PROVIDER, ...(MODEL ? { model: MODEL } : {}), ...(OWN_KEY ? { ownKey: true } : {}) }));
  await ana.until((s) => Object.keys(s.sessions).length === 3, 30_000);
  const byTitle = (t: string) => Object.values(ana.state!.sessions).find((s) => s.title === t)!;
  log(`3 ${PROVIDER} sessions started`);

  const voted = new Set<string>();
  const voter = setInterval(() => {
    for (const v of Object.values(ana.state?.votes ?? {}) as VoteView[]) {
      if (v.phase !== "open" || voted.has(v.id)) continue;
      voted.add(v.id);
      if (v.kind === "permission") {
        const deny = v.options.find((o) => o.label === "Deny")!;
        log(`owner decision "${v.question}" -> Deny`);
        people.find((p) => p.userId === v.ownerId)?.send("vote.cast", { voteId: v.id, optionId: deny.id });
        continue;
      }
      const opt = v.options.find((o) => /sqlite/i.test(o.label)) ?? v.options[0]!;
      log(`team vote "${v.question}" -> everyone votes ${opt.label}`);
      for (const p of people) p.send("vote.cast", { voteId: v.id, optionId: opt.id });
    }
  }, 200);

  await ana.until((s) => Object.values(s.sessions).every((x) => ["idle", "completed", "failed", "cancelled"].includes(x.status)) && Object.values(s.sessions).every((x) => x.turns > 0 || x.status === "failed"), TIMEOUT);
  clearInterval(voter);
  log("all agents finished their turn");
  for (const s of Object.values(ana.state!.sessions)) if (s.error) log(`  ${s.title}: ${s.error}`);

  const storage = byTitle("Storage");
  const dbVote = (Object.values(ana.state!.votes) as VoteView[]).find((v) => v.sessionId === storage.id && v.kind === "question");
  check("structured question became a team vote", !!dbVote);
  check("every client saw the same vote", !!dbVote && [bob, cara].every((c) => JSON.stringify(c.state!.votes[dbVote.id]) === JSON.stringify(ana.state!.votes[dbVote.id])));
  check("vote resolved by majority to SQLite", dbVote?.resolution === "majority" && dbVote.options.find((o) => o.id === dbVote.resolvedOptionId)?.label === "SQLite");
  const storageWt = runners[0]!.sessionWorktree(storage.id);
  const readme = storageWt ? await readFile(path.join(storageWt, "README.md"), "utf8").catch(() => "") : "";
  check("agent resumed and acted on the decision (README on ana's runner mentions SQLite)", /sqlite/i.test(readme));
  check("each agent ran on its owner's runner", names.every((n, i) => byTitle(DEMO_TASKS[i]!.title).runnerName === `${n}-machine`));
  if (OWN_KEY) check("every session ran on its owner's own key", Object.values(ana.state!.sessions).every((s) => s.billing === "own"));

  const drift = (await ana.until((s) => !!s.drift && s.drift.conflicts.length > 0 && s.drift.overlaps.some((o) => o.path === "README.md"), 60_000).catch(() => ana.state!)).drift;
  const tf = byTitle("Rebrand: TaskForge").id;
  const tp = byTitle("Rebrand: TodoPro").id;
  log(`drift overlaps: ${JSON.stringify(drift?.overlaps)} conflicts: ${JSON.stringify(drift?.conflicts)} note: ${drift?.note}`);
  check("amber: README.md overlap between Storage and TaskForge", !!drift?.overlaps.some((o) => o.path === "README.md" && o.sessionIds.includes(storage.id) && o.sessionIds.includes(tf)));
  check("README.md overlap is not reported as a conflict", !drift?.conflicts.some((c) => c.paths.includes("README.md")));
  check("red: verified src/config.js conflict from runner patches", !!drift?.conflicts.some((c) => c.paths.includes("src/config.js") && c.sessionIds.includes(tf) && c.sessionIds.includes(tp)));

  ana.send("room.end", {});
  const recap = (await ana.until((s) => !!s.recap, 60_000)).recap!;
  for (const s of recap.sessions) log(`recap: ${s.title}: ${s.status}, files ${s.filesChanged.join(", ") || "none"}, commits ${s.commitsCreated}, tests ${s.testRuns.passed}/${s.testRuns.passed + s.testRuns.failed} passed`);
  check("recap generated with all three sessions", recap.sessions.length === 3);
  log(`reported agent cost: $${Object.values(ana.state!.sessions).reduce((a, s) => a + (s.costUsd ?? 0), 0).toFixed(3)}`);

  for (const p of people) p.close();
  for (const r of runners) {
    await r.stop();
    await r.cleanup();
  }
  await app.stop();
  const failed = checks.filter(([, ok]) => !ok);
  console.log(failed.length ? `\nLIVE E2E FAILED (${failed.length}/${checks.length})` : `\nLIVE E2E PASSED (${checks.length} checks)`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("LIVE E2E ERROR:", e);
  process.exit(1);
});
