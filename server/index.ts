/**
 * Hub entry: `npm start [-- --lan] [--tunnel] [--host-runner] [--allow-local-repos] [--allow-mock]`
 */
import { spawn, type ChildProcess } from "node:child_process";
import { networkInterfaces } from "node:os";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createLogger } from "./log.ts";

const log = createLogger({ svc: "hub" });

function startTunnel(port: number, onUrl: (url: string) => void): ChildProcess | null {
  const child = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { windowsHide: true });
  child.on("error", (e) => {
    log.warn("cloudflared not available; remote access disabled", { error: e.message });
    process.stdout.write("\n  cloudflared not found. Install it (winget install Cloudflare.cloudflared) or share over your LAN/VPN.\n\n");
  });
  let found = false;
  const scan = (d: Buffer) => {
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(d.toString());
    if (m && !found) {
      found = true;
      onUrl(m[0]);
    }
  };
  child.stdout?.on("data", scan);
  child.stderr?.on("data", scan);
  return child;
}

const VIRTUAL_ADAPTER = /vEthernet|VMware|VirtualBox|Hyper-V|WSL|Docker|Loopback|Local Area Connection\*/i;

/** Reachable IPv4 addresses on real adapters (Wi-Fi, Ethernet, Tailscale); virtual adapters only if nothing else exists. */
function lanAddresses(): { address: string; name: string }[] {
  const real: { address: string; name: string }[] = [];
  const virtual: { address: string; name: string }[] = [];
  for (const [name, list] of Object.entries(networkInterfaces()))
    for (const a of list ?? [])
      if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254."))
        (VIRTUAL_ADAPTER.test(name) ? virtual : real).push({ address: a.address, name });
  return real.length ? real : virtual.map((v) => ({ ...v, name: `${v.name}, virtual` }));
}

async function main() {
  const config = loadConfig();
  const app = await createApp({ config, log });
  if (config.hostRunner) process.stdout.write("\n  Starting the host runner and checking agents on this machine…\n");
  const port = await app.listen();
  const wildcard = config.host === "0.0.0.0" || config.host === "::";
  const loopbackOnly = ["127.0.0.1", "localhost", "::1"].includes(config.host);
  const local = `http://${wildcard ? "localhost" : config.host}:${port}`;

  const lines: string[] = ["", "  Signal Box hub is running", "", `  Open:  ${local}`];
  if (loopbackOnly) lines.push("  Only this machine can reach it. Use --lan (same network) or put it behind HTTPS on the internet.");
  else {
    const addrs = wildcard ? lanAddresses() : [{ address: config.host, name: "configured host" }];
    for (const a of addrs) lines.push(`  Teammates (${a.name}): http://${a.address}:${port}`);
  }
  lines.push("", `  Accounts: registration is ${config.registration}. The first account created becomes the site admin.`);
  if (config.hostRunner) {
    lines.push("", "  Host runner: ON. Anyone's agents can run on THIS machine. Use only on a trusted LAN or for demos.");
    for (const p of app.registry.shared()?.providers ?? [])
      lines.push(`    ${p.available ? "[ok]  " : p.byoReady ? "[key] " : "[off] "}${p.label.padEnd(28)} ${p.available ? `${p.auth}; ${p.models.length} models` : p.byoReady ? "with a personal API key" : p.note}`);
  } else lines.push("", "  Agents run on teammates' own runners (rooms page → your runners). This hub never runs agent code.");
  if (config.allowLocalRepos) lines.push("  Local repo paths are allowed (--allow-local-repos). Don't enable this on a public hub.");
  lines.push("");
  process.stdout.write(lines.join("\n") + "\n");

  let tunnel: ChildProcess | null = null;
  if (config.tunnel)
    tunnel = startTunnel(port, (url) => {
      app.addAllowedOrigin(url);
      process.stdout.write(`\n  Teammates (tunnel): ${url}\n\n`);
    });

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal: sig });
    tunnel?.kill();
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    try {
      await app.stop();
    } catch (e) {
      log.error("shutdown error", { error: (e as Error).message });
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  log.error("fatal", { error: (e as Error).message });
  process.stderr.write(`\n  ${(e as Error).message}\n\n`);
  process.exit(1);
});
