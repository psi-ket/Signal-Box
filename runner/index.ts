/**
 * Signal Box runner CLI. Run it on your own machine to execute your agents:
 *   npm run runner -- --hub https://signalbox.example.com --token sbr_…
 * Create the token in the web app (rooms page → your runners). The runner uses your own
 * Git credentials and your own Claude / Codex / Gemini logins or API keys.
 */
import { existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { createLogger } from "../server/log.ts";
import { RunnerCore } from "./core.ts";
import { buildProviders, discoverAll, providerEnvFromProcess } from "./providers.ts";

async function main() {
  const { values } = parseArgs({
    options: {
      hub: { type: "string" },
      token: { type: "string" },
      name: { type: "string" },
      "data-dir": { type: "string" },
      "allow-mock": { type: "boolean" },
      "allow-local-repos": { type: "boolean" },
    },
    strict: true,
  });
  if (existsSync(".env")) process.loadEnvFile(".env");
  const hub = values.hub ?? process.env.SIGNALBOX_HUB;
  const token = values.token ?? process.env.SIGNALBOX_RUNNER_TOKEN;
  if (!hub || !token) {
    process.stderr.write("usage: npm run runner -- --hub https://your-hub --token sbr_…\n(create a token on the hub: rooms page → your runners)\n");
    process.exit(2);
  }
  if (!/^https?:\/\//.test(hub)) throw new Error("--hub must be an http(s) URL");
  if (hub.startsWith("http://") && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/.test(hub))
    process.stderr.write("  warning: connecting over plain http; use https for a hub on the internet.\n");

  const log = createLogger({ svc: "runner" }, (l) => {
    if (/"level":"(warn|error)"/.test(l)) process.stderr.write(l + "\n");
  });
  const providers = buildProviders(providerEnvFromProcess(!!values["allow-mock"]));
  process.stdout.write("  Checking agents on this machine…\n");
  await discoverAll(providers);
  for (const p of Object.values(providers).map((x) => x.info()))
    process.stdout.write(`    ${p.available ? "[ok]  " : p.byoReady ? "[key] " : "[off] "}${p.label.padEnd(28)} ${p.available ? `${p.auth}; ${p.models.length} models` : p.byoReady ? "runs with your own API key" : p.note}\n`);

  const runner = new RunnerCore({
    hubUrl: hub,
    token,
    name: values.name ?? hostname(),
    dataDir: path.resolve(values["data-dir"] ?? path.join(homedir(), ".signalbox")),
    providers,
    allowLocalRepos: !!values["allow-local-repos"],
    log,
  });
  runner.onStatus = (s) => process.stdout.write(`  runner: ${s}\n`);
  runner.start();
  process.stdout.write(`  Connecting to ${hub} …  (Ctrl+C to stop; clean worktrees are removed on exit)\n`);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const t = setTimeout(() => process.exit(1), 15_000);
    t.unref();
    await runner.stop();
    await runner.cleanup();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((e) => {
  process.stderr.write(`  ${(e as Error).message}\n`);
  process.exit(1);
});
