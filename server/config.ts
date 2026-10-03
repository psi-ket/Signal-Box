/** Hub configuration from CLI flags, environment and an optional .env file. */
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

export interface Config {
  host: string;
  port: number;
  tunnel: boolean;
  allowedOrigins: string[];
  voteMs: number;
  ownerWindowMs: number;
  conflictCheck: boolean;
  maxSessions: number;
  maxConnections: number;
  maxRooms: number;
  webDist: string;
  dataDir: string;
  dbFile: string;
  /** Allow rooms on local folders / file:// URLs (single-machine demos only). */
  allowLocalRepos: boolean;
  /** Start an in-process runner that runs anyone's agents on this machine (LAN/demo only). */
  hostRunner: boolean;
  allowMock: boolean;
  registration: "open" | "closed";
  adminUsernames: string[];
  secureCookies: boolean;
  registerPerHour: number;
  /** Behind a reverse proxy: take the client IP from X-Forwarded-For for rate limits. */
  trustProxy: boolean;
}

const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
const flag = (v: string | undefined) => v === "1" || v === "true";

export function loadConfig(argv = process.argv.slice(2), projectRoot = process.cwd()): Config {
  const envFile = path.join(projectRoot, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const { values } = parseArgs({
    args: argv,
    options: {
      host: { type: "string" },
      port: { type: "string" },
      lan: { type: "boolean" },
      tunnel: { type: "boolean" },
      "data-dir": { type: "string" },
      "host-runner": { type: "boolean" },
      "allow-local-repos": { type: "boolean" },
      "allow-mock": { type: "boolean" },
    },
    strict: true,
  });
  const e = process.env;
  const lan = values.lan ?? flag(e.COLAB_LAN);
  const dataDir = path.resolve(values["data-dir"] || e.COLAB_DATA_DIR || path.join(projectRoot, ".data"));
  const publicUrl = e.COLAB_PUBLIC_URL || "";
  return {
    // --lan listens on every interface so teammates on the same network can connect.
    host: values.host || e.COLAB_HOST || (lan ? "0.0.0.0" : "127.0.0.1"),
    // PORT is what most hosts (Railway, Render, Fly.io) assign.
    port: num(values.port ?? (e.COLAB_PORT || e.PORT), 3003),
    tunnel: values.tunnel ?? flag(e.COLAB_TUNNEL),
    allowedOrigins: [...(e.COLAB_ALLOWED_ORIGINS ?? "").split(","), publicUrl].map((s) => s.trim().replace(/\/$/, "")).filter(Boolean),
    voteMs: num(e.COLAB_VOTE_SECONDS, 30) * 1000,
    ownerWindowMs: num(e.COLAB_OWNER_WINDOW_SECONDS, 30) * 1000,
    conflictCheck: e.COLAB_CONFLICT_CHECK !== "0",
    maxSessions: num(e.COLAB_MAX_SESSIONS, 8),
    maxConnections: num(e.COLAB_MAX_CONNECTIONS, 200),
    maxRooms: num(e.COLAB_MAX_ROOMS, 100),
    webDist: path.join(projectRoot, "web", "dist"),
    dataDir,
    dbFile: e.COLAB_DB_FILE || path.join(dataDir, "signalbox.db"),
    allowLocalRepos: values["allow-local-repos"] ?? flag(e.COLAB_ALLOW_LOCAL_REPOS),
    hostRunner: values["host-runner"] ?? flag(e.COLAB_HOST_RUNNER),
    allowMock: values["allow-mock"] ?? flag(e.COLAB_ALLOW_MOCK),
    registration: e.COLAB_REGISTRATION === "closed" ? "closed" : "open",
    adminUsernames: (e.COLAB_ADMINS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    secureCookies: flag(e.COLAB_SECURE_COOKIES) || publicUrl.startsWith("https://"),
    registerPerHour: num(e.COLAB_REGISTER_PER_HOUR, 10),
    trustProxy: flag(e.COLAB_TRUST_PROXY),
  };
}
